/**
 * Step 3 — deep extraction: website discovery, Tavily extraction,
 * evidence building and address re-validation.
 */

import { createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { tavilyExtract } from '@/services/external/tavily-extract.service';
import { fetchRawPageHtml } from '@/services/extraction/raw-html.service';
import { filterCandidateUrls } from '@/services/discovery/url-filter.service';
import { saveStageOutput } from '@/services/storage/output-storage.service';
import { geocodeLocality } from '@/services/resolution/geocoding.service';
import { revalidateExtractedCandidateAddress } from '@/services/resolution/candidate-validation.service';
import { incrementTelemetry } from '@/services/telemetry.service';
import {
  getCurrentRunId,
  logRunStep,
  startTimer
} from '@/services/observability/run-log.service';
import {
  researchReportSchema,
  researchCandidateSchema
} from '@/mastra/agents/research-agent/schema';
import { isUsableOfficialWebsite } from '@/services/resolution/entity-resolution.service';
import {
  extractEmails,
  extractPhones,
  extractSocialLinks,
  extractAllFromPages
} from '@/services/business-extractor.service';
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
  type WebsitePageEvidence
} from '@/mastra/agents/research-agent/verification.schema';

import {
  candidateSchema,
  extractionSchema,
  cachePassthroughSchema,
  takeCachePassthrough,
} from '@/mastra/workflows/workflow-contracts';

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
          let website = candidate.website;
          // 1) Homepage first (1 Tavily call, 1 URL) — basic depth (cost-controlled).
          let homepageResponse = await tavilyExtract([website], {
            extractDepth: 'basic',
            retryWithAdvancedOnFailure: false,
          });
          let homepageExtraction = homepageResponse.extractions[0];

          // Fix 3c: Root Domain Recovery for Deep Paths
          // If website has a subpath (e.g. klc.edu.np/our-team) and fails, attempt root domain (klc.edu.np/)
          if ((!homepageExtraction || !homepageExtraction.success) && website) {
            try {
              const urlObj = new URL(website);
              if (urlObj.pathname && urlObj.pathname !== '/' && urlObj.pathname !== '') {
                const rootUrl = `${urlObj.protocol}//${urlObj.host}/`;
                console.log(`[Workflow:Step2] Subpath failed for ${website}. Retrying root domain: ${rootUrl}`);
                const rootResponse = await tavilyExtract([rootUrl], {
                  extractDepth: 'basic',
                  retryWithAdvancedOnFailure: false,
                });
                if (rootResponse.extractions[0]?.success) {
                  website = rootUrl;
                  homepageExtraction = rootResponse.extractions[0];
                }
              }
            } catch (e) {
              // Ignore invalid URL
            }
          }

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
