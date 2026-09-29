import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  unifiedSearchResultSchema,
  extractDomain,
} from '@/services/discovery/search-fallback.service';
import { tavilyExtract } from '@/services/external/tavily-extract.service';
import { fetchRawPageHtml } from '@/services/extraction/raw-html.service';
import { filterCandidateUrls } from '@/services/discovery/url-filter.service';
import {
  saveStageOutput,
  saveSummaryReport,
  endRunSession,
  getActiveRunSession,
  getRunSessionId,
} from '@/services/storage/output-storage.service';
import { geocodeLocality } from '@/services/resolution/geocoding.service';
import { revalidateExtractedCandidateAddress } from '@/services/resolution/candidate-validation.service';
import { getLlmMultiBusinessCallCount } from '@/services/business-extractor.service';
import { getTelemetry, incrementTelemetry } from '@/services/telemetry.service';
import {
  beginRun,
  getCurrentRunId,
  logRunStep,
  startTimer,
  getApiCallCounters,
} from '@/services/observability/run-log.service';
import { mergeDuplicateEntities } from '@/services/resolution/entity-resolution.service';
import { completeSocials } from '@/services/resolution/social-completion.service';
import {
  researchReportSchema,
  researchCandidateSchema,
  type ResearchReport,
} from '@/mastra/agents/research-agent/schema';
import {
  isUsableOfficialWebsite,
  normalizePhoneDigits,
  normalizeNameKey,
  domainFromUrlOrHost,
  detectCrossListingConflicts,
} from '@/services/resolution/entity-resolution.service';
import {
  extractEmails,
  extractPhones,
  extractSocialLinks,
  extractAllFromPages,
  classifyNepalPhone,
} from '@/services/business-extractor.service';
import {
  buildCacheKeys,
  canonicalKeyFor,
  getLastMongoState,
  getMongoHealth,
  lookupFreshRun,
  saveRunRecord,
  upsertBusinesses,
  type RunInputConfig,
} from '@/services/storage/mongo.service';
import { describeLookupMaxAgeDays } from '@/config/freshness.config';
import {
  discoverWebsitePages,
  type DiscoveredWebsitePage,
} from '@/services/discovery/website-discovery.service';
import {
  buildVerifiedEvidence,
  keyOfCandidate,
} from '@/services/resolution/verification.service';
import {
  verifiedBusinessEvidenceSchema,
  type VerifiedBusinessEvidence,
  type WebsitePageEvidence,
} from '@/mastra/agents/research-agent/verification.schema';
import {
  computeConfidenceBreakdown,
  validateConfidenceIntegrity,
  type ConfidenceInputs,
} from '@/services/resolution/confidence.service';

// Phase 1 (R5 shim): canonical domain contracts imported from the type layer.
// Consumers may use the `@/types` barrel; the type modules themselves import
// sibling contracts directly (never through the barrel).
import {
  businessListingSchema,
  ledgerStatusEnum,
  type BusinessListing,
  type LedgerStatus,
  type RunResearchDiscoveryInput,
} from '@/types/index.js';

// Phase 1 (R5 shim): re-exported for backward compatibility until Phase 9.
export {
  businessListingSchema,
  ledgerStatusEnum,
  type BusinessListing,
  type LedgerStatus,
  type RunResearchDiscoveryInput,
};

const candidateSchema = unifiedSearchResultSchema;

const extractionSchema = z.object({
  url: z.string(),
  content: z.string(),
  favicon: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

/**
 * M1 cache passthrough fragment.
 *
 * Zod objects strip undeclared fields between workflow steps, so every field that
 * must survive from Step 1 (cache decision) to Step 4 (artifacts + run record) is
 * declared in EACH intermediate step's input AND output schema by spreading this
 * fragment. No chain restructuring, no branching API.
 */
const cachePassthroughSchema = {
  /** True when Step 1 served a stored snapshot instead of running discovery. */
  fromCache: z.boolean().optional(),
  /** Frozen snapshot payload carried to Step 4 on a cache hit. */
  cachedListings: z.array(businessListingSchema).optional(),
  /** Diagnostic: 'hit' | 'miss' | 'skipped_mongo_down' (never conflated). */
  cacheLookupStatus: z.enum(['hit', 'miss', 'skipped_mongo_down']).optional(),
  /** Freshness window in force for this run (days). */
  cachePolicyDays: z.number().optional(),
  /** Run id whose snapshot was served (cache hits only). */
  cacheSourceRunId: z.string().optional(),
  /** True when the caller explicitly bypassed the cache with refresh: true. */
  refreshRequested: z.boolean().optional(),
  /**
   * Run configuration carried through for the runs-history record
   * (reproducibility: which knobs produced / requested this snapshot).
   */
  runConfig: z
    .object({
      maxMapsPages: z.number().optional(),
      maxPages: z.number().optional(),
      websiteDiscoveryMode: z.string().optional(),
      maxWebsiteDiscoveryLookups: z.number().optional(),
      targetCandidates: z.number().optional(),
    })
    .optional(),
};

type CachePassthroughFields = {
  fromCache?: boolean;
  cachedListings?: BusinessListing[];
  cacheLookupStatus?: 'hit' | 'miss' | 'skipped_mongo_down';
  cachePolicyDays?: number;
  cacheSourceRunId?: string;
  refreshRequested?: boolean;
  runConfig?: RunInputConfig;
};

/** Copies the cache-passthrough fields from one step's input to its output. */
function takeCachePassthrough(input: unknown): CachePassthroughFields {
  const source = (input ?? {}) as CachePassthroughFields;
  return {
    fromCache: source.fromCache,
    cachedListings: source.cachedListings,
    cacheLookupStatus: source.cacheLookupStatus,
    cachePolicyDays: source.cachePolicyDays,
    cacheSourceRunId: source.cacheSourceRunId,
    refreshRequested: source.refreshRequested,
    runConfig: source.runConfig,
  };
}

import { runResearchDiscovery } from '@/services/discovery/research-discovery.service';
export { runResearchDiscovery };

export const researchAgentStep = createStep({
  id: 'research-agent-step',
  inputSchema: z.object({
    query: z.string(),
    /**
     * Run locality. REQUIRED in practice: the canonical identity is
     * `name:<nameKey>|<locationKey>`, and an empty location yields the
     * `unknown-location` suffix, which creates duplicate identities instead
     * of overwriting existing records. Non-empty after trim.
     */
    location: z.string().min(1, 'location must be a non-empty locality').trim(),
    autoApprove: z.boolean().default(true),
    agentId: z.string().optional(),
    targetCandidates: z.number().optional(),
    maxMapsPages: z.number().optional(),
    maxPages: z.number().optional(),
    websiteDiscoveryMode: z.enum(['production', 'benchmark']).optional(),
    maxWebsiteDiscoveryLookups: z.number().optional(),
    // Phase 2 passthrough: Tavily deep-verification cap (consumed by Step 2).
    maxDeepVerifyCandidates: z.number().optional(),
    // M1 cache control (declared here or Zod strips them at the step boundary).
    refresh: z.boolean().optional(),
    maxCacheAgeDays: z.number().optional(),
  }),
  outputSchema: z.object({
    candidates: z.array(candidateSchema),
    researchCandidates: z.array(researchCandidateSchema),
    query: z.string(),
    location: z.string().optional(),
    autoApprove: z.boolean().default(true),
    agentId: z.string().optional(),
    researchReport: researchReportSchema.optional(),
    maxDeepVerifyCandidates: z.number().optional(),
    ...cachePassthroughSchema,
  }),
  execute: async ({ inputData, mastra }) => {
    const runId = beginRun();
    const elapsed = startTimer();
    // ------------------------------------------------------------------
    // M1 cache-first guard (Step 1).
    // Same (query, location) inside the freshness window → serve the stored
    // snapshot and skip ALL three cost centres: Maps/web discovery, Tavily
    // extraction, and supervisor synthesis.
    // ------------------------------------------------------------------
    const refreshRequested = Boolean(inputData.refresh);
    const policy = describeLookupMaxAgeDays(inputData.query);
    const maxCacheAgeDays =
      typeof inputData.maxCacheAgeDays === 'number' && inputData.maxCacheAgeDays >= 0
        ? inputData.maxCacheAgeDays
        : policy.days;

    if (refreshRequested) {
      console.log('[cache] bypass — refresh: true (full pipeline re-run requested)');
    } else if (inputData.query) {
      const keys = buildCacheKeys(inputData.query, inputData.location);
      console.log(
        `[cache] lookup — {${keys.queryKey} | ${keys.locationKey || '-'}} within ${maxCacheAgeDays}d (${policy.source})`
      );
      const hit = await lookupFreshRun(inputData.query, inputData.location, maxCacheAgeDays);
      if (hit) {
        logRunStep(runId, 1, 'ok', elapsed(), {
          cache: 'hit',
          candidates: 0,
          listings: hit.listings.length,
          sourceRunId: hit.runId,
        });
        return {
          candidates: [],
          researchCandidates: [],
          query: inputData.query,
          location: inputData.location,
          autoApprove: inputData.autoApprove,
          agentId: inputData.agentId,
          researchReport: undefined,
          maxDeepVerifyCandidates: inputData.maxDeepVerifyCandidates,
          fromCache: true as const,
          cachedListings: hit.listings,
          cacheLookupStatus: 'hit' as const,
          cachePolicyDays: maxCacheAgeDays,
          cacheSourceRunId: hit.runId,
          refreshRequested: false,
          runConfig: {
            maxMapsPages: inputData.maxMapsPages,
            maxPages: inputData.maxPages,
            websiteDiscoveryMode: inputData.websiteDiscoveryMode,
            maxWebsiteDiscoveryLookups: inputData.maxWebsiteDiscoveryLookups,
            targetCandidates: inputData.targetCandidates,
            maxCacheAgeDays,
          },
        };
      }
    }

    const result = await runResearchDiscovery(inputData, mastra);
    const cacheStatus =
      refreshRequested || getLastMongoState() === 'connected'
        ? ('miss' as const)
        : ('skipped_mongo_down' as const);
    logRunStep(runId, 1, 'ok', elapsed(), {
      cache: cacheStatus,
      candidates: result.candidates?.length ?? 0,
      researchCandidates: result.researchCandidates?.length ?? 0,
      mongo: getLastMongoState(),
    });
    return {
      ...result,
      maxDeepVerifyCandidates: inputData.maxDeepVerifyCandidates,
      fromCache: false,
      // FIX-3: a miss because the store was unreachable is NOT the same as a
      // miss because nothing fresh was stored — never conflate them.
      cacheLookupStatus: cacheStatus,
      cachePolicyDays: maxCacheAgeDays,
      refreshRequested,
      runConfig: {
        maxMapsPages: inputData.maxMapsPages,
        maxPages: inputData.maxPages,
        websiteDiscoveryMode: inputData.websiteDiscoveryMode,
        maxWebsiteDiscoveryLookups: inputData.maxWebsiteDiscoveryLookups,
        targetCandidates: inputData.targetCandidates,
        maxCacheAgeDays,
      },
    };
  },
});

// Backward compatibility export
export const broadDiscoveryStep = researchAgentStep;

export const humanReviewStep = createStep({
  id: 'human-review-step',
  inputSchema: z.object({
    candidates: z.array(candidateSchema),
    researchCandidates: z.array(researchCandidateSchema).optional(),
    query: z.string(),
    location: z.string().optional(),
    autoApprove: z.boolean().default(true),
    agentId: z.string().optional(),
    researchReport: researchReportSchema.optional(),
    maxDeepVerifyCandidates: z.number().optional(),
    ...cachePassthroughSchema,
  }),
  outputSchema: z.object({
    candidates: z.array(candidateSchema),
    researchCandidates: z.array(researchCandidateSchema).optional(),
    query: z.string(),
    location: z.string().optional(),
    autoApprove: z.boolean().default(true),
    agentId: z.string().optional(),
    researchReport: researchReportSchema.optional(),
    maxDeepVerifyCandidates: z.number().optional(),
    ...cachePassthroughSchema,
  }),
  execute: async ({ inputData, suspend, resumeData }) => {
    const runId = getCurrentRunId();
    const elapsed = startTimer();
    // M1: a cache hit carries no candidates to review — never suspend for one.
    if (inputData.fromCache) {
      console.log('[Workflow:HITL] Cache hit — skipping human review step (no discovery happened)');
      logRunStep(runId, 2, 'skipped', elapsed(), { reason: 'cache_hit', candidates: 0 });
      return {
        candidates: inputData.candidates,
        researchCandidates: inputData.researchCandidates,
        query: inputData.query,
        location: inputData.location,
        autoApprove: inputData.autoApprove,
        agentId: inputData.agentId,
        researchReport: inputData.researchReport,
        maxDeepVerifyCandidates: inputData.maxDeepVerifyCandidates,
        ...takeCachePassthrough(inputData),
      };
    }

    if (inputData.autoApprove) {
      console.log(`[Workflow:HITL] Auto-approved ${inputData.candidates.length} candidates (headless mode)`);
      logRunStep(runId, 2, 'ok', elapsed(), {
        mode: 'auto_approved',
        candidates: inputData.candidates.length,
      });
      return {
        candidates: inputData.candidates,
        researchCandidates: inputData.researchCandidates,
        query: inputData.query,
        location: inputData.location,
        autoApprove: inputData.autoApprove,
        agentId: inputData.agentId,
        researchReport: inputData.researchReport,
        maxDeepVerifyCandidates: inputData.maxDeepVerifyCandidates,
        ...takeCachePassthrough(inputData),
      };
    }

    if (!resumeData) {
      console.log(`[Workflow:HITL] Pausing for human review of ${inputData.candidates.length} candidates`);
      return (await suspend({
        message: 'Please review and approve the discovered URLs before scraping.',
        foundCount: inputData.candidates.length,
        candidates: inputData.candidates.slice(0, 5).map((c) => ({
          title: c.title,
          url: c.url,
        })),
      })) as any;
    }

    const data = resumeData as { approved?: boolean; filteredUrls?: string[] };
    if (data.approved === false) {
      throw new Error('Pipeline was halted by user review.');
    }

    let approvedCandidates = inputData.candidates;
    if (Array.isArray(data.filteredUrls) && data.filteredUrls.length > 0) {
      approvedCandidates = inputData.candidates.filter((c) =>
        data.filteredUrls!.includes(c.url)
      );
    }

    console.log(`[Workflow:HITL] Resumed with ${approvedCandidates.length} approved candidates`);
    logRunStep(runId, 2, 'ok', elapsed(), {
      mode: 'resumed',
      candidates: approvedCandidates.length,
      filtered: inputData.candidates.length - approvedCandidates.length,
    });

    return {
      candidates: approvedCandidates,
      researchCandidates: inputData.researchCandidates,
      query: inputData.query,
      location: inputData.location,
      autoApprove: inputData.autoApprove,
      agentId: inputData.agentId,
      researchReport: inputData.researchReport,
      maxDeepVerifyCandidates: inputData.maxDeepVerifyCandidates,
      ...takeCachePassthrough(inputData),
    };
  },
});

export const deepExtractionStep = createStep({
  id: 'deep-extraction',
  inputSchema: z.object({
    candidates: z.array(candidateSchema),
    researchCandidates: z.array(researchCandidateSchema).optional(),
    query: z.string(),
    location: z.string().optional(),
    autoApprove: z.boolean().default(true),
    agentId: z.string().optional(),
    researchReport: researchReportSchema.optional(),
    // Phase 2: Tavily cost guard — how many candidates get deep-verified (default 3).
    maxDeepVerifyCandidates: z.number().optional(),
    ...cachePassthroughSchema,
  }),
  outputSchema: z.object({
    candidates: z.array(candidateSchema),
    researchCandidates: z.array(researchCandidateSchema).optional(),
    extractions: z.array(extractionSchema),
    // Phase 2: additive verified evidence (Tier 2.5).
    verifiedEvidence: z.array(verifiedBusinessEvidenceSchema).optional(),
    query: z.string(),
    location: z.string().optional(),
    autoApprove: z.boolean().default(true),
    agentId: z.string().optional(),
    researchReport: researchReportSchema.optional(),
    ...cachePassthroughSchema,
  }),
  execute: async ({ inputData }) => {
    const runId = getCurrentRunId();
    const elapsed = startTimer();
    // M1: a cache hit must not call Tavily at all. `extractions` is REQUIRED by the
    // next step's input schema (z.array(extractionSchema) carries no default), so it
    // must be supplied explicitly as [] — omitting it would fail Zod validation.
    if (inputData.fromCache) {
      console.log('[Workflow:Step2] Cache hit — skipping deep extraction (0 Tavily calls)');
      logRunStep(runId, 3, 'skipped', elapsed(), { reason: 'cache_hit', extractions: 0 });
      return {
        candidates: inputData.candidates,
        researchCandidates: inputData.researchCandidates,
        extractions: [],
        verifiedEvidence: undefined,
        query: inputData.query,
        location: inputData.location,
        autoApprove: inputData.autoApprove,
        agentId: inputData.agentId,
        researchReport: inputData.researchReport,
        ...takeCachePassthrough(inputData),
      };
    }

    const { candidates, researchCandidates, query, location, autoApprove, agentId, researchReport } = inputData;

    // ------------------------------------------------------------------
    // Phase 2 verified path: per-candidate discovery + extraction +
    // deterministic verification, driven by researchCandidates.
    // Falls back to the legacy flat-extraction path when researchCandidates
    // are absent (backward compatibility, Correction-4/E4).
    // ------------------------------------------------------------------
    if (researchCandidates && researchCandidates.length > 0) {
      const maxVerify =
        inputData.maxDeepVerifyCandidates ??
        (inputData.researchReport?.targetCandidates
          ? Math.max(inputData.researchReport.targetCandidates, 10)
          : 10);
      const withWebsite = researchCandidates.filter(
        (c) => c.website && isUsableOfficialWebsite(c.website)
      );
      const selected = withWebsite.slice(0, maxVerify);
      const skippedByCap = withWebsite.length - selected.length;
      const noWebsite = researchCandidates.length - withWebsite.length;

      console.log(
        `[Workflow:Step2] Verified extraction: deep-verifying ${selected.length}/${withWebsite.length} candidates with official websites (cap ${maxVerify}; ${skippedByCap} cap-skipped, ${noWebsite} without usable website)`
      );

      const extractionsByCandidate = new Map<string, WebsitePageEvidence[]>();
      const retriedHashes = new Set<string>();
      const flattenedExtractions: Array<{
        url: string;
        content: string;
        favicon: string;
        success: boolean;
        error?: string;
      }> = [];

      for (const candidate of selected) {
        const website = candidate.website;
        if (!website || !website.trim() || !/^https?:\/\//i.test(website)) {
          continue;
        }
        try {
          // 1) Homepage first (1 Tavily call, 1 URL) — basic depth (cost-controlled).
          const homepageResponse = await tavilyExtract([website], {
            extractDepth: 'basic',
            retryWithAdvancedOnFailure: false,
          });
          const homepageExtraction = homepageResponse.extractions[0];
          if (homepageExtraction) flattenedExtractions.push(homepageExtraction);

          // 2) Discover the best same-domain internal pages using the homepage
          //    markdown content (0 extra cost), with fetch + fallback guessing
          //    handled inside the discovery service.
          const discovered = await discoverWebsitePages(website, {
            maxPages: 5,
            tavilyHomepageContent: homepageExtraction?.content || '',
          });
          const remainingPages: DiscoveredWebsitePage[] = discovered
            .filter((p) => p.url !== website)
            .slice(0, 4);

          // 3) Build page evidences (homepage + up to 4 internal pages).
          const pageEvidences: WebsitePageEvidence[] = [
            {
              url: website,
              content: homepageExtraction?.content || '',
              favicon: homepageExtraction?.favicon || '',
              success: homepageExtraction?.success ?? false,
              error: homepageExtraction?.error,
              discoverySource: 'homepage',
              pageType: 'home',
            },
          ];

          // 4) Extract remaining pages in one batched Tavily call (≤ 4 URLs) — basic depth.
          if (remainingPages.length > 0) {
            const remainingResponse = await tavilyExtract(
              remainingPages.map((p) => p.url),
              { extractDepth: 'basic', retryWithAdvancedOnFailure: false }
            );
            for (const extraction of remainingResponse.extractions) {
              flattenedExtractions.push(extraction);
              const discoveredPage = remainingPages.find((p) => p.url === extraction.url);
              pageEvidences.push({
                url: extraction.url,
                content: extraction.content || '',
                favicon: extraction.favicon || '',
                success: extraction.success,
                error: extraction.error,
                discoverySource: discoveredPage?.discoverySource || 'fallback_guess',
                pageType: discoveredPage?.pageType || 'other',
              });
            }
          }

          // 5) Hybrid Raw HTML Augmentation (Crawler Fidelity v1.2 / v1.3)
          // Evaluate contact signals across candidate's extracted markdown.
          const preliminaryEmails = pageEvidences.flatMap((p) => extractEmails(p.content));
          const preliminaryPhones = pageEvidences.flatMap((p) => extractPhones(p.content));
          const preliminarySocials = pageEvidences.flatMap((p) => {
            const socials = extractSocialLinks(p.content);
            return [
              socials.facebook,
              socials.instagram,
              socials.tiktok,
              ...Object.values(socials.other),
            ].filter(Boolean);
          });
          const candidateHasZeroContacts =
            preliminaryEmails.length === 0 && preliminaryPhones.length === 0;
          const candidateHasZeroSocials = preliminarySocials.length === 0;

          // Smart trigger rule (v1.3 — Universal Homepage Raw HTML Safety Net):
          //   - pageType === 'home'  → ALWAYS. The homepage <header>/<footer>
          //     hosts global navigation, icon-only social anchors and secondary
          //     contact channels that Tavily's readability parser strips
          //     (Gorkha failure: footer with contact@ / +1 301 322 1427 / 3
          //     social profiles was lost because raw fetch was gated off).
          //     Native fetch() costs 0 API credits (~80-120ms).
          //   - pageType === 'contact' → highest-value page, always worth raw.
          //   - candidate has zero contact OR social signals anywhere → rescue.
          for (const page of pageEvidences) {
            const shouldRawFetch =
              page.pageType === 'home' ||
              page.pageType === 'contact' ||
              candidateHasZeroContacts ||
              candidateHasZeroSocials;

            if (shouldRawFetch) {
              const rawHtml = await fetchRawPageHtml(page.url, 8000, 1);
              if (rawHtml) {
                page.rawHtml = rawHtml;
                if (!page.success && rawHtml.length > 200) {
                  page.success = true;
                }
              }
            }
          }

          // 5b) Componentized / AJAX Footer Recovery (v1.4)
          // Sites with componentized templates (e.g. Nebuti) load footers dynamically
          // into an empty <div id="footer"></div> via AJAX or template include.
          const hasFooterPlaceholder = pageEvidences.some(
            (p) => p.rawHtml && /<div\b[^>]*id=["']footer["']/i.test(p.rawHtml)
          );
          const currentSocials = extractAllFromPages(pageEvidences).extractedSocialLinks;
          const hasNoSocials =
            !currentSocials.facebook &&
            !currentSocials.instagram &&
            !currentSocials.tiktok &&
            Object.keys(currentSocials.other).length === 0;

          if (hasFooterPlaceholder || hasNoSocials) {
            try {
              const footerUrl = new URL('footer.html', website).href;
              const footerHtml = await fetchRawPageHtml(footerUrl, 4000, 0);
              if (
                footerHtml &&
                footerHtml.length > 100 &&
                (footerHtml.includes('<footer') || /social|contact|phone|email/i.test(footerHtml))
              ) {
                console.log(
                  `[Workflow:Step2] Componentized footer discovered for "${website}": ${footerUrl} (${footerHtml.length} bytes)`
                );
                pageEvidences.push({
                  url: footerUrl,
                  content: '',
                  favicon: '',
                  success: true,
                  discoverySource: 'internal_link',
                  pageType: 'contact',
                  rawHtml: footerHtml,
                });
              }
            } catch {}
          }

          // 6) Secondary Recovery: Tavily Advanced Retry (cost-guarded & framework-fingerprint / SPA recovery)
          const postRawEvidence = extractAllFromPages(pageEvidences);
          const hasContacts =
            postRawEvidence.extractedEmails.length > 0 ||
            postRawEvidence.extractedPhones.length > 0 ||
            postRawEvidence.extractedMobiles.length > 0;
          const hasSocials = Boolean(
            postRawEvidence.extractedSocialLinks.facebook ||
            postRawEvidence.extractedSocialLinks.instagram ||
            postRawEvidence.extractedSocialLinks.tiktok ||
            Object.keys(postRawEvidence.extractedSocialLinks.other || {}).length > 0 ||
            (postRawEvidence.extractedSchemaSameAs && postRawEvidence.extractedSchemaSameAs.length > 0)
          );

          const shouldEscalateToJs = (p: (typeof pageEvidences)[0]): boolean => {
            if (hasSocials && hasContacts) return false;
            if (!p.success || p.content.length < 100) return true;
            const rawHtml = p.rawHtml || '';
            if (rawHtml.length < 2000) return true; // tiny empty SPA shell

            // Framework fingerprints:
            const hasFrameworkFingerprint =
              /__NEXT_DATA__|window\.__NUXT__|data-reactroot|data-svelte|window\.__remixContext/i.test(rawHtml);

            // Social network names mentioned in text without social URLs:
            const mentionsSocialNamesWithoutUrls =
              /\b(facebook|instagram|tiktok|linkedin|youtube)\b/i.test(rawHtml) &&
              !/https?:\/\/(www\.)?(facebook|instagram|tiktok|linkedin|youtube)\.com/i.test(rawHtml);

            return !hasSocials && (hasFrameworkFingerprint || mentionsSocialNamesWithoutUrls);
          };

          const escalatePages = pageEvidences.filter(
            (p) =>
              (p.pageType === 'contact' || p.pageType === 'home') &&
              shouldEscalateToJs(p)
          );

          if (escalatePages.length > 0) {
            const retryPage = escalatePages[0];
            const retryUrl = retryPage.url;
            const contentHash = (retryPage.rawHtml || retryPage.content || retryUrl).slice(0, 32);
            if (!retriedHashes.has(contentHash)) {
              retriedHashes.add(contentHash);
              console.log(
                `[Workflow:Step2] Secondary recovery: escalating "${retryUrl}" to Tavily advanced depth (framework/SPA fingerprint or sparse content)...`
              );
              try {
                const advRes = await tavilyExtract([retryUrl], {
                  extractDepth: 'advanced',
                  retryWithAdvancedOnFailure: false,
                });
                if (advRes.extractions[0]?.success && advRes.extractions[0].content) {
                  const targetPage = pageEvidences.find((p) => p.url === retryUrl);
                  if (targetPage) {
                    targetPage.content = advRes.extractions[0].content;
                    targetPage.success = true;
                  }
                }
              } catch (advErr) {
                console.warn(`[Workflow:Step2] Advanced retry failed for "${retryUrl}":`, (advErr as Error).message);
              }
            }
          }

          extractionsByCandidate.set(keyOfCandidate(candidate), pageEvidences);
          const okCount = pageEvidences.filter((p) => p.success).length;
          console.log(`[Workflow:Step2] "${candidate.name}": extracted ${okCount}/${pageEvidences.length} pages`);
        } catch (err) {
          console.error(`[Workflow:Step2] Deep verification failed for "${candidate.name}":`, err);
          flattenedExtractions.push({
            url: website,
            content: '',
            favicon: '',
            success: false,
            error: (err as Error).message,
          });
        }
      }

      const dynamicCluster = location ? await geocodeLocality(location) : null;
      const verifiedEvidence = buildVerifiedEvidence(researchCandidates, extractionsByCandidate);

      // Phase 8h (W2-03) & Phase 8i (GEO-02): Step 2 extracted address revalidation against dynamic geocoder
      if (location) {
        for (const ev of verifiedEvidence) {
          const c = ev.candidate;
          let candidateAddress = c.location || (c as any).address || '';
          let discoveredCoords: { lat: number; lng: number } | undefined =
            c.coordinates?.lat !== undefined && c.coordinates?.lng !== undefined
              ? { lat: c.coordinates.lat, lng: c.coordinates.lng }
              : undefined;

          if (ev.websiteEvidence?.pages) {
            for (const page of ev.websiteEvidence.pages) {
              const fullHtml = page.rawHtml || '';
              const fullContent = page.content || '';
              const combinedText = fullContent + '\n' + fullHtml;

              // 1. Meta geo position / ICBM coordinates
              if (!discoveredCoords) {
                const geoMeta = fullHtml.match(/<meta\s+name=["'](?:geo\.position|ICBM)["']\s+content=["']([0-9.]+)[;, ]+([0-9.]+)["']/i);
                if (geoMeta) {
                  const lat = parseFloat(geoMeta[1]);
                  const lng = parseFloat(geoMeta[2]);
                  if (!isNaN(lat) && !isNaN(lng) && lat > 20 && lat < 32 && lng > 79 && lng < 89) {
                    discoveredCoords = { lat, lng };
                    c.coordinates = { lat, lng };
                  }
                }
              }

              if (!candidateAddress) {
                // 2. JSON-LD schema address
                const schemaMatch = combinedText.match(/["'](?:streetAddress|addressLocality)["']\s*:\s*["']([^"']+)["']/i);
                if (schemaMatch && schemaMatch[1].trim().length > 3) {
                  candidateAddress = schemaMatch[1].trim();
                  break;
                }

                // 3. HTML address or contact container
                const contactHtmlMatch = fullHtml.match(/(?:class|id)=["'][^"']*(?:sidebar__contact|contact-text|footer-address|contact-info|address-text|location-text)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|p|span|address|li)>/i);
                if (contactHtmlMatch) {
                  const cleanText = contactHtmlMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                  if (cleanText.length > 5 && (/[0-9]/.test(cleanText) || /kathmandu|lalitpur|bhaktapur|ward|galli|marg|road|chowk|tole|anamnagar|satungal|chandragiri/i.test(cleanText))) {
                    candidateAddress = cleanText;
                    break;
                  }
                }

                // 4. Content text based in / office / address
                const textLocMatch = fullContent.match(/(?:based in|office(?: located)? at|located (?:at|in)|address\s*:?|head office\s*:?)\s*([A-Za-z0-9\s,-]{5,80})/i);
                if (textLocMatch) {
                  candidateAddress = textLocMatch[1].trim();
                  break;
                }

                // 5. Locality mentions with city
                const cityMentionMatch = combinedText.match(/(?:Anamnagar|Putalisadak|Thamel|New Road|Baneshwor|Koteshwor|Kalanki|Satungal|Balkhu|Kirtipur|Chabahil|Maharajgunj|Lazimpat|Jhamsikhel|Kupondole|Sanepa)[^,\n.<>]*,\s*(?:Chandragiri Galli,\s*)?(?:Kathmandu|Lalitpur|Bhaktapur|Nepal)[A-Za-z0-9\s,-]*/i);
                if (cityMentionMatch) {
                  candidateAddress = cityMentionMatch[0].trim();
                  break;
                }
              }
            }
          }

          if (candidateAddress || discoveredCoords) {
            const recheck = await revalidateExtractedCandidateAddress(
              c,
              candidateAddress || `${c.name} Location`,
              location,
              dynamicCluster
            );
            if (!recheck.isValid) {
              console.log(
                `[Workflow:Step2] W2-03/GEO-02 Address Re-check Exclusion: Candidate "${c.name}" address "${candidateAddress}" is outside target "${location}": ${recheck.reason}`
              );
              ev.verification.checks.addressOrLocationFoundOnWebsite = false;
              ev.verification.status = 'failed';
              ev.websiteRelationship = 'unverified';
              (c as any).isGeographicallyExcluded = true;
              (c as any).geographicExclusionReason = recheck.reason;
              (ev as any).isGeographicallyExcluded = true;
              (ev as any).geographicExclusionReason = recheck.reason;
              incrementTelemetry('conflictingLocalityExclusions');
            }
          }
        }
      }

      saveStageOutput('deep-extract', '2-deep-extractions.json', flattenedExtractions, query);
      saveStageOutput(
        'deep-extract',
        '2b-verified-evidence.json',
        { query, maxDeepVerifyCandidates: maxVerify, verifiedEvidence },
        query
      );

      const statusCounts = verifiedEvidence
        .map((v) => v.verification.status)
        .reduce<Record<string, number>>((acc, s) => {
          acc[s] = (acc[s] || 0) + 1;
          return acc;
        }, {});
      console.log(
        `[Workflow:Step2] Verified evidence complete: ${verifiedEvidence.length} records, statuses: ${JSON.stringify(statusCounts)}`
      );

      logRunStep(runId, 3, 'ok', elapsed(), {
        extractions: flattenedExtractions.length,
        evidence: verifiedEvidence.length,
        statuses: JSON.stringify(statusCounts),
      });

      return {
        candidates,
        researchCandidates,
        extractions: flattenedExtractions,
        verifiedEvidence,
        query,
        location,
        autoApprove,
        agentId,
        researchReport,
        ...takeCachePassthrough(inputData),
      };
    }

    const filtered = filterCandidateUrls(candidates, 5);
    console.log(
      `[Workflow:Step2] Deep extraction for ${filtered.length} official URLs (${candidates.length - filtered.length} social/maps/directory skipped)`
    );

    let extractions;
    try {
      const topUrls = filtered.map((c) => c.url);
      const response = await tavilyExtract(topUrls);
      extractions = response.extractions;
    } catch (err) {
      console.error('[Workflow:Step2] Tavily Extract failed:', err);
      extractions = filtered.map((c) => ({
        url: c.url,
        content: '',
        favicon: '',
        success: false,
        error: (err as Error).message,
      }));
    }

    console.log(`[Workflow:Step2] Extracted ${extractions.filter((e: { success: boolean }) => e.success).length} pages`);

    saveStageOutput('deep-extract', '2-deep-extractions.json', extractions, query);

    return {
      candidates,
      researchCandidates,
      extractions,
      verifiedEvidence: undefined,
      query,
      location,
      autoApprove,
      agentId,
      researchReport,
      ...takeCachePassthrough(inputData),
    };
  },
});

/**
 * M1 cache-hit finalization.
 *
 * Writes this run's artifacts from the frozen snapshot and appends a 'cache-hit'
 * run record so "this query was served from cache N times" stays answerable.
 *
 * Deliberately does NOT call upsertBusinesses: nothing was re-verified on a cache
 * hit, so lastVerifiedAt must never claim verification that never happened.
 */
async function finalizeCacheHit(params: {
  listings: BusinessListing[];
  query: string;
  location?: string;
  runId: string;
  sourceRunId?: string;
  cachePolicyDays?: number;
  runConfig?: RunInputConfig;
  researchReport?: ResearchReport;
  verifiedEvidence?: VerifiedBusinessEvidence[];
}): Promise<{
  listings: BusinessListing[];
  researchReport?: ResearchReport;
  verifiedEvidence?: VerifiedBusinessEvidence[];
}> {
  const { listings, query, location, runId, sourceRunId } = params;
  const completedAt = new Date();

  console.log(
    `[Workflow:Step3] Cache hit — serving ${listings.length} listing(s) from run ${sourceRunId ?? 'unknown'} (0 LLM calls, 0 search calls)`
  );

  saveStageOutput('final-listings', '3-final-listings.json', listings, query);
  saveStageOutput('results', 'results.json', listings, query);

  saveSummaryReport({
    query,
    location,
    totalBusinesses: listings.length,
    conflictsDetected: 0,
    sources: { googleMaps: 0, webSearch: 0, officialWebsitesCrawled: 0 },
    contactsFound: {
      withPhone: listings.filter(
        (l) => (l.phones?.length ?? 0) > 0 || (l.mobiles?.length ?? 0) > 0
      ).length,
      withEmail: listings.filter((l) => (l.emails?.length ?? 0) > 0).length,
      withWebsite: listings.filter((l) => (l.websites?.length ?? 0) > 0).length,
      withSocialLinks: listings.filter((l) => {
        const s = l.socialLinks;
        return Boolean(
          s && (s.facebook || s.tiktok || s.instagram || (s.other && Object.keys(s.other).length > 0))
        );
      }).length,
    },
    status: listings.length > 0 ? 'success' : 'empty',
    synthesisMethod: 'Cache hit — served from stored runs snapshot (no synthesis executed)',
    cacheLookupStatus: 'hit',
    telemetry: {
      /** Cache-hit runs must show zero outbound spend — this is the proof. */
      apiCallCounters: getApiCallCounters(),
      mongoHealth: getMongoHealth(),
    },
    notes: [
      sourceRunId ? `Served from run ${sourceRunId}` : 'Served from stored snapshot',
      `Freshness window: ${params.cachePolicyDays ?? 'default'}d`,
      'No API calls made: discovery, extraction and synthesis were all skipped',
    ],
  });

  await saveRunRecord({
    runId,
    query,
    location,
    status: 'cache-hit',
    listings,
    servedFromCache: true,
    refreshRequested: false,
    inputConfig: { ...(params.runConfig ?? {}), maxCacheAgeDays: params.cachePolicyDays },
    completedAt,
  });

  endRunSession();

  console.log(`\n================ CACHED LISTINGS (${listings.length}) ================`);
  console.log(JSON.stringify(listings, null, 2));
  console.log('=========================================================\n');

  return {
    listings,
    researchReport: params.researchReport,
    verifiedEvidence: params.verifiedEvidence,
  };
}

export const supervisorSynthesisStep = createStep({
  id: 'supervisor-synthesis',
  inputSchema: z.object({
    candidates: z.array(candidateSchema),
    researchCandidates: z.array(researchCandidateSchema).optional(),
    extractions: z.array(extractionSchema),
    verifiedEvidence: z.array(verifiedBusinessEvidenceSchema).optional(),
    query: z.string(),
    location: z.string().optional(),
    autoApprove: z.boolean().default(true),
    agentId: z.string().optional(),
    researchReport: researchReportSchema.optional(),
    ...cachePassthroughSchema,
  }),
  outputSchema: z.object({
    listings: z.array(businessListingSchema),
    researchReport: researchReportSchema.optional(),
    verifiedEvidence: z.array(verifiedBusinessEvidenceSchema).optional(),
  }),
  execute: async ({ inputData, mastra }) => {
    // NOTE: the pre-existing `runId` in this step is the run SESSION id used for
    // output/history paths. `logRunId` is the observability run id and must not
    // shadow it.
    const logRunId = getCurrentRunId();
    const elapsed = startTimer();
    const { candidates, extractions, verifiedEvidence, query, location, agentId, researchReport } = inputData;
    const runStartedAt = new Date().toISOString();

    // ------------------------------------------------------------------
    // M1 cache-hit branch: serve the frozen snapshot and finalize.
    // Placed BEFORE any synthesis work so the LLM is never called, and returns
    // through `finalizeCacheHit` (which owns the artifact + run-record writes for
    // this path). `businesses` is never touched here: nothing was re-verified.
    // ------------------------------------------------------------------
    if (inputData.fromCache) {
      const finalized = await finalizeCacheHit({
        listings: inputData.cachedListings ?? [],
        query,
        location,
        runId: getRunSessionId(query, location),
        sourceRunId: inputData.cacheSourceRunId,
        cachePolicyDays: inputData.cachePolicyDays,
        runConfig: inputData.runConfig,
        researchReport,
        verifiedEvidence,
      });
      logRunStep(logRunId, 4, 'skipped', elapsed(), {
        reason: 'cache_hit',
        listings: finalized.listings?.length ?? 0,
        sourceRunId: inputData.cacheSourceRunId,
      });
      return finalized;
    }

    console.log(
      `[Workflow:Step3] Supervisor synthesizing ${candidates.length} candidates + ${extractions.length} extractions` +
        (verifiedEvidence ? ` + ${verifiedEvidence.length} verified evidence records` : '')
    );

    const prompt = buildSupervisorPrompt(query, location, candidates, extractions, verifiedEvidence);
    let rawListings: any[] = [];

    const parseListingsFromJson = (text: string): any[] => {
      let cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
      cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
      cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');

      try {
        const parsedJson = JSON.parse(cleaned);
        if (Array.isArray(parsedJson)) return parsedJson;
        if (parsedJson && Array.isArray(parsedJson.listings)) return parsedJson.listings;
        if (parsedJson && typeof parsedJson === 'object') return [parsedJson];
      } catch {
        // Fallback for LLM responses with conversational text around JSON
        const jsonMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (jsonMatch) {
          try {
            let innerClean = jsonMatch[0].replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
            innerClean = innerClean.replace(/,\s*([\]}])/g, '$1');
            const innerParsed = JSON.parse(innerClean);
            if (Array.isArray(innerParsed)) return innerParsed;
          } catch {
            // pass
          }
        }
      }
      return [];
    };

    // --- SYNTHESIS ARCHITECTURE ---
    // Note: Layer 1 (UnoRouter Tribunal with free-tier models) has been removed to eliminate
    // rate-limit timeout cascades and latency overhead. Paid consensus evaluation (e.g. NVIDIA Nemotron)
    // is formally deferred to Phase 8i.
    // Synthesis executes Layer 2 (Supervisor Agent) directly, falling back to Layer 3 (Deterministic Fallback).

    // --- LAYER 2: OpenRouter Supervisor Agent ---
    if (rawListings.length === 0) {
      const preferredAgentId = agentId || 'gemma-supervisor-agent';
      let agent: any = null;
      try {
        agent = mastra?.getAgentById?.(preferredAgentId);
      } catch {
        agent = null;
      }

      if (agent) {
        try {
          console.log(`[Workflow:Step3] Invoking Layer 2: ${preferredAgentId}...`);
          const agentPromise = agent.generate(prompt);
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Agent ${preferredAgentId} timed out after 20s`)), 20000)
          );
          const response = (await Promise.race([agentPromise, timeoutPromise])) as any;
          const parsed = parseListingsFromJson(response.text);
          if (parsed.length > 0) {
            console.log(`[Workflow:Step3] Synthesis succeeded via ${preferredAgentId} (${parsed.length} listings)`);
            rawListings = parsed;
          } else {
            console.warn(`[Workflow:Step3] ${preferredAgentId} produced unparseable listings. Cascading to Layer 3...`);
          }
        } catch (err) {
          console.warn(`[Workflow:Step3] Agent generation failed: ${(err as Error).message}. Cascading to Layer 3...`);
        }
      }
    }

    // --- LAYER 3: Zero-Token Deterministic Fallback ---
    if (rawListings.length === 0) {
      console.log('[Workflow:Step3] Invoking Layer 3: Zero-token Deterministic Fallback Extraction...');
      rawListings = candidates.map((c) => buildFallbackListing(c, extractions, verifiedEvidence, location, runStartedAt));
    }

    let listings = (Array.isArray(rawListings) ? rawListings : [])
      .map((item) => {
        const parsed = businessListingSchema.safeParse(item);
        if (parsed.success) return parsed.data;
        console.warn('[Workflow:Step3] Listing failed schema validation, applying defaults');
        return businessListingSchema.parse({
          name: item?.name || 'Unknown Name',
          metadata: {
            source: 'web',
            extractedAt: new Date().toISOString(),
            runStartedAt,
            confidence: 0,
          },
        });
      })
      .filter((item) => item.name !== 'Unknown Name');

    const excludedInGeoRevalidation = new Map<string, string>();
    const autoMergedCandidates = new Map<string, string>();
    const zeroActionableFiltered = new Set<string>();
    const cappedOutListings = new Set<string>();

    // Filter out any listings whose candidate evidence was excluded during Step 2 address revalidation
    if (verifiedEvidence && verifiedEvidence.length > 0) {
      listings = listings.filter((l) => {
        const ev = matchListingToEvidence(l, verifiedEvidence);
        if (ev && ((ev.candidate as any).isGeographicallyExcluded || (ev as any).isGeographicallyExcluded)) {
          const reason =
            (ev.candidate as any).geographicExclusionReason ||
            (ev as any).geographicExclusionReason ||
            'Excluded during Step 2 address revalidation';
          console.log(
            `[Workflow:Step3] Dropping geographically excluded listing: "${l.name}" (${reason})`
          );
          if (ev.candidate.website) excludedInGeoRevalidation.set(ev.candidate.website, reason);
          if (ev.candidate.phone) excludedInGeoRevalidation.set(normalizePhoneDigits(ev.candidate.phone), reason);
          excludedInGeoRevalidation.set(normalizeNameKey(l.name), reason);
          return false;
        }
        return true;
      });
    }

    // ========================================================================
    // Post-Synthesis: Deterministic GPS & Phone Re-injection + Tradesmen Preservation
    // ========================================================================
    const preservableCandidates = candidates;
    const matchedCandidateUrls = new Set<string>();

    for (const listing of listings) {
      const match = preservableCandidates.find((m) => {
        if (matchedCandidateUrls.has(m.url)) return false;

        // 1. Domain match
        if (listing.websites && listing.websites.length > 0 && m.domain && !m.domain.includes('google.com')) {
          if (listing.websites.some((w) => extractDomain(w) === m.domain)) return true;
        }

        // 2. Phone match
        if (m.phoneNumber) {
          const cleanMapPhone = m.phoneNumber.replace(/\D/g, '');
          if (cleanMapPhone.length >= 7) {
            const hasPhone = [...listing.phones, ...listing.mobiles].some((p) =>
              p.replace(/\D/g, '').includes(cleanMapPhone) || cleanMapPhone.includes(p.replace(/\D/g, ''))
            );
            if (hasPhone) return true;
          }
        }

        // 3. Name similarity match
        const listName = listing.name.toLowerCase().trim();
        const mapName = m.title.toLowerCase().trim();
        if (listName && mapName && (listName.includes(mapName) || mapName.includes(listName))) {
          return true;
        }

        return false;
      });

      if (match) {
        matchedCandidateUrls.add(match.url);

        // Deterministically re-inject exact GPS coordinates
        if (match.latitude !== undefined && match.longitude !== undefined) {
          listing.gpsCoordinates = {
            latitude: match.latitude,
            longitude: match.longitude,
          };
        }

        // Deterministically re-inject rating, count, placeId, type, and address
        if (match.rating !== undefined) listing.rating = match.rating;
        if (match.ratingCount !== undefined) listing.ratingCount = match.ratingCount;
        if (match.placeId) listing.placeId = match.placeId;
        if (match.businessType && !listing.businessType) listing.businessType = match.businessType;
        if (match.address && (!listing.location || listing.location.length < 5)) {
          listing.location = match.address;
        }

        // Prepend verified Maps phone if not present
        if (match.phoneNumber) {
          const classified = classifyNepalPhone(match.phoneNumber);
          if (classified.type !== 'invalid') {
            const allCurrent = [...listing.phones, ...listing.mobiles];
            const alreadyHas = allCurrent.some(
              (p) => normalizePhoneDigits(p) === classified.digits
            );
            if (!alreadyHas) {
              const display = classified.normalized || match.phoneNumber.trim();
              if (classified.type === 'mobile') {
                listing.mobiles.unshift(display);
              } else {
                listing.phones.unshift(display);
              }
            }
          }
        }
      }
    }

    // Adjustment 3: Preserve any accepted candidate that the supervisor omitted.
    for (const m of preservableCandidates) {
      if (!matchedCandidateUrls.has(m.url)) {
        if (m.source !== 'google_maps') {
          console.log(`[Workflow:Step3] Preserving unlisted web candidate: "${m.title}"`);
          listings.push(buildFallbackListing(m, extractions, verifiedEvidence, location, runStartedAt));
          continue;
        }

        console.log(`[Workflow:Step3] Preserving unlisted Google Maps business: "${m.title}"`);
        const hasSite = m.domain && !m.domain.includes('google.com');
        const fallbackPlaceLocation = m.address || location || 'Kathmandu, Nepal';

        // ── GAP 2 FIX: Classify tradesman Maps phone into correct array ──
        const rawTradesmanPhone = m.phoneNumber?.trim();
        const classifiedTradesmanPhone = rawTradesmanPhone
          ? classifyNepalPhone(rawTradesmanPhone)
          : null;

        let tradesmanPhones: string[] = [];
        let tradesmanMobiles: string[] = [];
        if (classifiedTradesmanPhone && classifiedTradesmanPhone.type !== 'invalid') {
          const display = classifiedTradesmanPhone.normalized || rawTradesmanPhone || '';
          if (classifiedTradesmanPhone.type === 'mobile') {
            tradesmanMobiles = [display];
          } else {
            tradesmanPhones = [display];
          }
        }

        const preservedListing: z.infer<typeof businessListingSchema> = {
          name: m.title,
          location: fallbackPlaceLocation,
          emails: [],
          phones: tradesmanPhones,
          mobiles: tradesmanMobiles,
          websites: hasSite ? [m.url] : [],
          icon: '',
          socialLinks: { facebook: '', tiktok: '', instagram: '', other: {} },
          otherDetails: {
            address: fallbackPlaceLocation,
            rating: m.rating,
            ratingCount: m.ratingCount,
            businessType: m.businessType,
            source: 'google_maps',
            discoveryState: m.discoveryState,
            discoveryProvenance: m.discoveryProvenance,
          },
          gpsCoordinates:
            m.latitude !== undefined && m.longitude !== undefined
              ? { latitude: m.latitude, longitude: m.longitude }
              : undefined,
          rating: m.rating,
          ratingCount: m.ratingCount,
          businessType: m.businessType,
          placeId: m.placeId,
          metadata: {
            source: 'google_maps',
            extractedAt: new Date().toISOString(),
            runStartedAt,
            confidence: 0,
          },
          process: 'Verified via Google Maps Places (Direct)',
          links: m.url ? [m.url] : [],
        };
        listings.push(preservedListing);
      }
    }

    console.log(`[Workflow:Step3] Supervisor produced ${listings.length} structured listings`);

    // ====================================================================
    // Phase 2: Post-synthesis evidence sanitizer (Correction 3).
    // Contact fields in matched listings are overwritten with deterministic
    // evidence-backed values. Maps identity fields were already re-injected
    // above and are left untouched by the sanitizer.
    // ====================================================================
    if (verifiedEvidence && verifiedEvidence.length > 0) {
      let sanitizedCount = 0;
      for (const listing of listings) {
        const ev = matchListingToEvidence(listing, verifiedEvidence);
        if (!ev) continue;
        const sanitized = sanitizeListingWithEvidence(listing, ev);
        Object.assign(listing, sanitized);

        const completed = completeSocials({
          name: listing.name,
          websiteDomain: listing.websites?.[0] ? domainFromUrlOrHost(listing.websites[0]) : undefined,
          existingSocials: listing.socialLinks,
          bookingLinks: (listing.otherDetails as any)?.bookingLinks || (ev.candidate as any)?.bookingLinks,
          schemaSameAs: ev.websiteEvidence?.extractedSchemaSameAs,
          websiteRelationship: ev.websiteRelationship,
          existingClassifiedProfiles: (listing.otherDetails as any)?.classifiedSocialProfiles,
        });
        listing.socialLinks = completed.socialLinks;
        if ((listing.otherDetails as any)) {
          (listing.otherDetails as any).classifiedSocialProfiles = completed.classifiedProfiles;
        }

        sanitizedCount++;
        console.log(
          `[Workflow:Step3] Evidence-sanitized "${listing.name}" (status: ${ev.verification.status}, confidence: ${ev.verification.overallConfidence})`
        );
      }
      console.log(`[Workflow:Step3] Sanitized ${sanitizedCount}/${verifiedEvidence.length} evidence records onto listings`);
    }

    // Auto-merge duplicate entities (shared domain, phone, or social + entity alignment)
    const { mergedListings, autoMergedCount } = mergeDuplicateEntities(listings);
    if (autoMergedCount > 0) {
      console.log(
        `[Workflow:Step3] Auto-merged ${autoMergedCount} duplicate listings using 4-tier deterministic resolution`
      );
      for (const m of mergedListings) {
        const aliases = (m.otherDetails as any)?.mergedAliases || [];
        for (const alias of aliases) {
          const aliasName = typeof alias === 'string' ? alias : alias?.name || '';
          if (aliasName) {
            autoMergedCandidates.set(normalizeNameKey(aliasName), m.name);
          }
        }
      }
      listings = mergedListings;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 2.5: Phone Taxonomy Enforcement (Task 4 — GAP 3 Safety Net)
    //
    // Even when the sanitizer skips a listing (no evidence match), enforce
    // the strict phone taxonomy. Every number is re-classified and routed.
    // This guarantees phones ∩ mobiles = ∅ before downstream processing.
    // ═══════════════════════════════════════════════════════════════════════
    for (const listing of listings) {
      normalizeListingPhones(listing);
    }

    // Programmatic verification of phone taxonomy invariant across all final listings
    for (const listing of listings) {
      const canonicalPhones = (listing.phones || []).map((p) => normalizePhoneDigits(p));
      const canonicalMobiles = (listing.mobiles || []).map((p) => normalizePhoneDigits(p));
      const allCanonical = [...canonicalPhones, ...canonicalMobiles];
      const uniqueCanonical = new Set(allCanonical);
      if (allCanonical.length !== uniqueCanonical.size) {
        throw new Error(
          `[Workflow:Step3] Fatal Phone Invariant Violation on listing "${listing.name}": duplicate canonical phones found across phones and mobiles.`
        );
      }
    }

    // ====================================================================
    // Post-Sanitization Cross-Listing Conflict & Cluster Detection (Task 3 / Task 9)
    // ====================================================================
    const conflictReport = detectCrossListingConflicts(listings);

    // Log conflict summary
    if (conflictReport.conflicts.length > 0) {
      console.log(
        `[Workflow:Step3] Cross-listing conflict detector identified ${conflictReport.conflicts.length} conflict(s) across ${conflictReport.clusters.length} cluster(s)`
      );
    } else {
      console.log('[Workflow:Step3] Cross-listing conflict detector: No conflicts found across listings');
    }

    // Task 9: ALWAYS write conflict artifact envelope (even when conflicts = 0)
    const session = getActiveRunSession();
    const currentRunId = session?.runId || getRunSessionId(query, location);
    const conflictArtifact = {
      runId: currentRunId,
      generatedAt: new Date().toISOString(),
      conflicts: conflictReport.conflicts,
      clusters: conflictReport.clusters,
      conflictCount: conflictReport.conflicts.length,
    };
    saveStageOutput('conflicts', 'entity-conflicts.json', conflictArtifact, query);

    // Reapply conflict annotations back to listings (Task 5 fix).
    // Per the detectCrossListingConflicts() contract, annotatedListings
    // preserves order: annotatedListings[i] corresponds to listings[i].
    // Safety: only apply if lengths match (no pre-filtering).
    if (conflictReport.annotatedListings.length === listings.length) {
      for (let i = 0; i < listings.length; i++) {
        const ann = conflictReport.annotatedListings[i] as {
          otherDetails?: Record<string, unknown>;
        };
        const conflict = ann.otherDetails?.entityConflict as {
          hasConflict?: boolean;
          conflictType?: string;
        } | undefined;
        if (conflict?.hasConflict && !listings[i].otherDetails?.entityConflict) {
          if (!listings[i].otherDetails) listings[i].otherDetails = {};
          listings[i].otherDetails.entityConflict = ann.otherDetails?.entityConflict;
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Phase 4: Multi-Dimensional Confidence Computation (Task 5)
    // ═══════════════════════════════════════════════════════════════════
    for (const listing of listings) {
      const ev = verifiedEvidence ? matchListingToEvidence(listing, verifiedEvidence) : undefined;
      const conflict = listing.otherDetails?.entityConflict as {
        conflictType?: string;
      } | undefined;

      const inputs: ConfidenceInputs = {
        // Maps signals
        isMapsCandidate: listing.metadata?.source === 'google_maps' || Boolean(listing.placeId) || Boolean(listing.ratingCount),
        mapsPhone: (listing.otherDetails as any)?.mapsPhone || (listing as any).mapsPhone || ev?.candidate?.phone || (ev?.candidate?.sources?.googleMaps as any)?.phone,
        rating: listing.rating ?? (listing.metadata as any)?.rating,
        ratingCount: listing.ratingCount ?? (listing.metadata as any)?.ratingCount,
        placeId: listing.placeId ?? (listing.metadata as any)?.placeId,
        gpsCoordinates: listing.gpsCoordinates ?? (listing.metadata as any)?.gpsCoordinates,
        address: listing.location,

        // Website evidence (explicit — avoids fragile inference)
        hasWebsiteEvidence: Boolean(
          (listing.websites && listing.websites.length > 0) ||
          (ev && ev.websiteEvidence)
        ),

        // Verification signals
        verificationConfidence: ev?.verification?.overallConfidence,
        verificationChecks: ev?.verification?.checks
          ? {
              phoneMatchesMaps: ev.verification.checks.phoneMatchesMaps ?? false,
              emailFoundOnWebsite: ev.verification.checks.emailFoundOnWebsite ?? false,
              addressOrLocationFoundOnWebsite: ev.verification.checks.addressOrLocationFoundOnWebsite ?? false,
            }
          : undefined,

        // Relationship
        websiteRelationship: listing.otherDetails?.websiteRelationship,

        // Final listing contents — authoritative projection of accepted evidence
        finalEmails: listing.emails,
        finalWebsites: listing.websites,
        finalPhones: listing.phones,
        finalMobiles: listing.mobiles,

        // Contact (Task 4 guarantees unique identity across phones + mobiles)
        phonesCount: listing.phones?.length ?? 0,
        mobilesCount: listing.mobiles?.length ?? 0,

        // Conflict
        conflictType: conflict?.conflictType,
      };

      const breakdown = computeConfidenceBreakdown(inputs);

      // Assign confidence BEFORE validation (so the invariant can be checked)
      if (!listing.metadata) {
        listing.metadata = {
          source: 'web',
          extractedAt: new Date().toISOString(),
          runStartedAt,
          confidence: breakdown.overallConfidence,
        };
      } else {
        listing.metadata.confidence = breakdown.overallConfidence;
      }
      (listing.metadata as any).confidenceBreakdown = breakdown;

      // Validate integrity — both dimensions in [0,1] and equality
      const validation = validateConfidenceIntegrity(
        breakdown,
        listing.metadata.confidence
      );
      if (!validation.valid) {
        console.warn(
          `[Workflow:Step3] Confidence integrity FAILED for "${listing.name}":`,
          validation.errors
        );
      }
    }

    console.log(
      `[Workflow:Step3] Phase 4 computed confidence for ${listings.length} listings`
    );

    // Phase 8h (W2-05): Zero-actionable candidate filter
    // Drops any listing where all contact channels (phones, mobiles, emails, websites) are completely empty
    const actionableListings = listings.filter((l) => {
      const hasPhone = (l.phones && l.phones.length > 0) || (l.mobiles && l.mobiles.length > 0);
      const hasEmail = l.emails && l.emails.length > 0;
      const hasWebsite = l.websites && l.websites.length > 0;
      const isActionable = hasPhone || hasEmail || hasWebsite;
      if (!isActionable) {
        console.log(
          `[Workflow:Step3] W2-05 Filter: Dropping zero-actionable listing "${l.name}" (0 phones, 0 mobiles, 0 emails, 0 websites)`
        );
        zeroActionableFiltered.add(normalizeNameKey(l.name));
      }
      return isActionable;
    });
    listings = actionableListings;

    // Phase 8h (W2-08): Quality-sorted final output cap
    const explicitTarget = researchReport?.targetCandidates;
    if (explicitTarget !== undefined && listings.length > explicitTarget) {
      console.log(
        `[Workflow:Step3] Enforcing W2-08 output cap: sorting ${listings.length} listings by quality and capping to target ${explicitTarget}`
      );
      const beforeCap = listings;
      listings = applyTargetCandidatesCap(listings, explicitTarget);
      for (const item of beforeCap) {
        if (!listings.includes(item)) {
          cappedOutListings.add(normalizeNameKey(item.name));
        }
      }
    }

    const totalCascadeSocials = listings.reduce(
      (acc, l) => acc + (Number((l.otherDetails as any)?.socialsCascadeRejected) || 0),
      0
    );
    const totalCascadeContacts = listings.reduce(
      (acc, l) => acc + (Number((l.otherDetails as any)?.contactsCascadeRejected) || 0),
      0
    );
    if (totalCascadeSocials > 0 || totalCascadeContacts > 0) {
      console.log(
        `[Workflow:Step3] Cascade rejection summary: dropped ${totalCascadeSocials} unverified social profile(s) and ${totalCascadeContacts} contact(s) from non-first-party domains`
      );
    }

    // Save final artifacts AFTER post-synthesis sanitization and location backfill
    saveStageOutput('final-listings', '3-final-listings.json', listings, query);
    saveStageOutput('results', 'results.json', listings, query);

    // ------------------------------------------------------------------
    // M1: identity merge + run history (NORMAL path only).
    // A cache hit returned above and never reaches this block, so
    // lastVerifiedAt can only move when work was actually performed.
    // ------------------------------------------------------------------
    const runId = getRunSessionId(query, location);
    const completedAt = new Date();
    const upsertResult = await upsertBusinesses(listings, {
      query,
      location,
      runId,
      completedAt,
      markVerified: true,
    });
    const runRecordSaved = await saveRunRecord({
      runId,
      query,
      location,
      status: listings.length > 0 ? 'success' : 'empty',
      listings,
      servedFromCache: false,
      refreshRequested: Boolean(inputData.refreshRequested),
      inputConfig: { ...(inputData.runConfig ?? {}), maxCacheAgeDays: inputData.cachePolicyDays },
      completedAt,
      startedAt: new Date(runStartedAt),
    });

    const candidateLedger = candidates.map((candidate) => {
      const candidateId = buildCandidateLedgerId(candidate);
      const finalListing = listings.find((listing) => candidateMatchesListing(candidate, listing));
      const normName = normalizeNameKey(candidate.title || '');
      const normPhone = normalizePhoneDigits(candidate.phoneNumber || '');
      const normDomain = candidate.domain ? domainFromUrlOrHost(candidate.domain) : '';

      let status: LedgerStatus;
      let reason: string | undefined;

      if (finalListing) {
        const locationKey = buildCacheKeys(query, location).locationKey;
        const candidateKey = canonicalKeyFor(finalListing, locationKey);
        const perStatus = candidateKey ? upsertResult.perCandidateStatus?.get(candidateKey) : undefined;
        
        if (perStatus === 'persisted' || (!perStatus && upsertResult.skipped === 0 && runRecordSaved)) {
          status = 'persisted';
          reason = undefined;
        } else if (perStatus === 'upsert_failed') {
          status = 'upsert_failed' as LedgerStatus;
          reason = `MongoDB write error for candidate "${candidate.title}"`;
        } else {
          status = 'verification_failed';
          reason = upsertResult.reason || 'Mongo persistence did not confirm this listing';
        }
      } else if (
        excludedInGeoRevalidation.has(candidate.url) ||
        (normDomain && excludedInGeoRevalidation.has(normDomain)) ||
        (normPhone && excludedInGeoRevalidation.has(normPhone)) ||
        (normName && excludedInGeoRevalidation.has(normName))
      ) {
        status = 'geography_rejected';
        reason =
          excludedInGeoRevalidation.get(candidate.url) ||
          excludedInGeoRevalidation.get(normDomain) ||
          excludedInGeoRevalidation.get(normPhone) ||
          excludedInGeoRevalidation.get(normName) ||
          'Excluded during Step 2 address revalidation';
      } else if (zeroActionableFiltered.has(normName)) {
        status = 'zero_actionable_fields';
        reason = 'Filtered out: 0 phones, 0 mobiles, 0 emails, 0 websites';
      } else if (cappedOutListings.has(normName)) {
        status = 'synthesis_omission';
        reason = `Omitted due to targetCandidates cap (${explicitTarget})`;
      } else if (autoMergedCandidates.has(normName)) {
        status = 'deduplicated';
        reason = `Merged into listing "${autoMergedCandidates.get(normName)}" during entity resolution`;
      } else {
        status = 'synthesis_omission';
        reason = 'Omitted during supervisor synthesis or final deduplication';
      }

      return {
        candidateId,
        name: candidate.title,
        source: candidate.source,
        status,
        finalListingName: finalListing?.name,
        reason,
      };
    });

    const reasonCounts: Record<LedgerStatus, number> = {
      persisted: 0,
      synthesis_omission: 0,
      verification_failed: 0,
      zero_actionable_fields: 0,
      geography_rejected: 0,
      provider_exhausted: 0,
      deduplicated: 0,
      category_rejected: 0,
      budget_skipped: 0,
      upsert_failed: 0,
    };
    for (const c of candidateLedger) {
      reasonCounts[c.status]++;
    }

    const discoveredCount = researchReport?.uniqueBusinessesFound || candidates.length;
    const acceptedCount = candidates.length;
    const persistedCount = reasonCounts.persisted;
    const requestedTarget = researchReport?.targetCandidates;
    const shortfall = requestedTarget ? Math.max(0, requestedTarget - persistedCount) : 0;

    // Save high-level summary report for latest consumer and history archive
    saveSummaryReport({
      query,
      location,
      totalBusinesses: listings.length,
      requestedTarget,
      discovered: discoveredCount,
      accepted: acceptedCount,
      finalized: listings.length,
      persisted: persistedCount,
      shortfall,
      reasonCounts,
      conflictsDetected: conflictReport.conflicts.length,
      sources: {
        googleMaps: (researchReport?.researchCandidates || []).filter((c) => c.sources?.googleMaps?.found).length,
        webSearch: (researchReport?.researchCandidates || []).filter((c) => c.sources?.webSearch && c.sources.webSearch.length > 0).length,
        officialWebsitesCrawled: verifiedEvidence ? verifiedEvidence.filter((e) => e.websiteEvidence).length : 0,
      },
      contactsFound: {
        withPhone: listings.filter(
          (l) => (l.phones && l.phones.length > 0) || (l.mobiles && l.mobiles.length > 0)
        ).length,
        withEmail: listings.filter((l) => l.emails && l.emails.length > 0).length,
        withWebsite: listings.filter((l) => l.websites && l.websites.length > 0).length,
        withSocialLinks: listings.filter((l) => {
          const s = l.socialLinks;
          return Boolean(s && (s.facebook || s.tiktok || s.instagram || (s.other && Object.keys(s.other).length > 0)));
        }).length,
      },
      telemetry: {
        llmMultiBusinessCallsUsed: getLlmMultiBusinessCallCount(),
        socialsCascadeRejected: totalCascadeSocials,
        contactsCascadeRejected: totalCascadeContacts,
        streetNameCollisionsCaught: getTelemetry().streetNameCollisionsCaught,
        conflictingLocalityExclusions: getTelemetry().conflictingLocalityExclusions,
        tieredCorroborationRejections: getTelemetry().tieredCorroborationRejections,
        directorySubdomainPenalties: getTelemetry().directorySubdomainPenalties,
        templateFingerprintMatches: getTelemetry().templateFingerprintMatches,
        socialUrlsCanonicalized: getTelemetry().socialUrlsCanonicalized,
        /** Outbound dependency spend: calls made vs. served from cache. */
        apiCallCounters: getApiCallCounters(),
        /** WHY storage was skipped when it was — never conflated with cacheLookupStatus. */
        mongoHealth: getMongoHealth(),
      },
      status: listings.length > 0 ? 'success' : 'empty',
      synthesisMethod: 'OpenRouter Supervisor Agent / Deterministic Fallback',
      cacheLookupStatus: inputData.cacheLookupStatus ?? 'miss',
    });

    saveStageOutput(
      'candidate-ledger',
      'candidate-ledger.json',
      {
        query,
        location,
        requestedTarget,
        discovered: discoveredCount,
        accepted: acceptedCount,
        finalized: listings.length,
        persisted: persistedCount,
        shortfall,
        reasonCounts,
        upsertResult,
        runRecordSaved,
        candidates: candidateLedger,
      },
      query
    );

    endRunSession();

    logRunStep(logRunId, 4, 'ok', elapsed(), {
      listings: listings.length,
      requested: inputData.runConfig?.targetCandidates,
      evidence: verifiedEvidence?.length ?? 0,
    });

    console.log('\n================ FINAL VERIFIED LISTINGS ================');
    console.log(JSON.stringify(listings, null, 2));
    console.log('=========================================================\n');

    return { listings, researchReport, verifiedEvidence };
  },
});

import { buildSupervisorPrompt } from './research-prompts';
export { buildSupervisorPrompt };

import {
  buildCandidateLedgerId,
  candidateMatchesListing,
} from '@/services/storage/candidate-ledger.service';
export { buildCandidateLedgerId, candidateMatchesListing };

import { buildFallbackListing } from '@/services/resolution/fallback-listing.service';
export { buildFallbackListing };

import {
  applyTargetCandidatesCap,
  normalizeListingPhones,
} from '@/services/resolution/cascade-policy.service';
export { applyTargetCandidatesCap, normalizeListingPhones };

import {
  matchListingToEvidence,
  sanitizeListingWithEvidence,
} from '@/services/resolution/listing-sanitizer.service';
export { matchListingToEvidence, sanitizeListingWithEvidence };

export const researchWorkflow = createWorkflow({
  id: 'research-workflow',
  inputSchema: z.object({
    query: z.string().describe('The search query (e.g. "hotels in Kathmandu")'),
    location: z
      .string()
      .min(1, 'location must be a non-empty locality')
      .trim()
      .describe('Run locality. Required: an empty value writes unknown-location identity keys.'),
    autoApprove: z.boolean().default(true).describe('Skip human review step for headless execution'),
    agentId: z.string().optional().default('gemma-supervisor-agent').describe('Agent to use for synthesis'),
    targetCandidates: z.number().optional().describe('Target number of usable candidates'),
    maxMapsPages: z.number().optional().describe('Maximum Google Maps pages to query (default 5)'),
    maxPages: z.number().optional().describe('Maximum search pages to query'),
    websiteDiscoveryMode: z
      .enum(['production', 'benchmark'])
      .optional()
      .describe('Website discovery budget mode: benchmark = all eligible (hard-capped per run), production = 10 per run (default)'),
    maxWebsiteDiscoveryLookups: z
      .number()
      .optional()
      .describe('Explicit per-run website discovery lookup budget (clamped by the hard ceiling; independent of targetCandidates)'),
    maxDeepVerifyCandidates: z
      .number()
      .optional()
      .describe('Maximum candidates to deep-verify with Tavily (defaults to max(targetCandidates, 10) or 10)'),
    refresh: z
      .boolean()
      .optional()
      .describe('M1: bypass the cache for this run (force a full pipeline re-run, then replace the stored snapshot)'),
    maxCacheAgeDays: z
      .number()
      .optional()
      .describe('M1: freshness window in days for the cache-first guard (input > env CACHE_MAX_AGE_DAYS > category policy > 30)'),
  }),
  outputSchema: z.object({
    listings: z.array(businessListingSchema),
    researchReport: researchReportSchema.optional(),
    verifiedEvidence: z.array(verifiedBusinessEvidenceSchema).optional(),
  }),
})
  .then(researchAgentStep)
  .then(humanReviewStep)
  .then(deepExtractionStep)
  .then(supervisorSynthesisStep)
  .commit();
