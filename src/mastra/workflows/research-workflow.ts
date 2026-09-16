import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  searchWithFallback,
  unifiedSearchResultSchema,
  normalizeUrl,
  extractDomain,
  withTimeout,
  normalizeCategoryIntent,
  expandCategoryQueries,
  type UnifiedSearchResult,
  type CategoryIntent,
  type ExpandedQuery,
} from '../../services/search-fallback.service';
import { type SerperPlaceResult } from '../../services/serper-places.service';
import { tavilyExtract } from '../../services/tavily-extract.service';
import { filterCandidateUrls } from '../../services/url-filter.service';
import {
  saveStageOutput,
  saveSummaryReport,
  startRunSession,
  endRunSession,
  getActiveRunSession,
  getRunSessionId,
} from '../../services/output-storage.service';
import {
  filterSearchResults,
  checkCategoryRelevance,
} from '../../services/candidate-classifier.service';
import {
  researchReportSchema,
  researchCandidateSchema,
  type ResearchReport,
  type ResearchCandidate,
  type ResearchDecision,
  type ExcludedSummaryItem,
  type StoppedReason,
  type DiscoveryMetrics,
} from '../agents/research-agent/schema';
import {
  rankWebsiteLookupTargets,
  isUsableOfficialWebsite,
  normalizePhoneDigits,
  normalizeNameKey,
  domainFromUrlOrHost,
  detectCrossListingConflicts,
} from '../../services/entity-resolution.service';
import {
  extractEmails,
  extractPhones,
  extractMobiles,
  extractSocialLinks,
  extractAllFromPages,
  sanitizeEmailString,
  classifyNepalPhone,
  isRealSocialProfile,
  classifyEmailRole,
  classifyPhoneRole,
  classifyAllSocialProfiles,
} from '../../services/business-extractor.service';
import {
  branchRecordSchema,
  classifiedContactSchema,
  type BranchRecord,
  type ClassifiedContact,
} from '../agents/research-agent/contact.schema';
import {
  buildResearchCandidates,
  toUnifiedCandidates,
} from '../../services/research-candidate.service';
import { paginateMapsDiscovery } from '../../services/maps-discovery.service';
import {
  discoverWebsitePages,
  type DiscoveredWebsitePage,
} from '../../services/website-discovery.service';
import {
  buildVerifiedEvidence,
  keyOfCandidate,
} from '../../services/verification.service';
import {
  verifiedBusinessEvidenceSchema,
  confidenceBreakdownSchema,
  type VerifiedBusinessEvidence,
  type WebsitePageEvidence,
} from '../agents/research-agent/verification.schema';
import {
  computeConfidenceBreakdown,
  validateConfidenceIntegrity,
  type ConfidenceInputs,
} from '../../services/confidence.service';
import { generateWithUnoTribunal } from '../../services/unorouter.service';

const candidateSchema = unifiedSearchResultSchema;

const extractionSchema = z.object({
  url: z.string(),
  content: z.string(),
  favicon: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

export const businessListingSchema = z.object({
  name: z.string().default('Unknown Name'),
  location: z.string().default(''),
  emails: z.array(z.string()).default([]),
  phones: z.array(z.string()).default([]),
  mobiles: z.array(z.string()).default([]),
  websites: z.array(z.string()).default([]),
  icon: z.string().default(''),
  socialLinks: z
    .object({
      facebook: z.string().default(''),
      tiktok: z.string().default(''),
      instagram: z.string().default(''),
      other: z.record(z.string(), z.string()).default({}),
    })
    .default({
      facebook: '',
      tiktok: '',
      instagram: '',
      other: {},
    }),
  otherDetails: z
    .object({
      branches: z.array(branchRecordSchema).optional(),
      classifiedContacts: z.array(classifiedContactSchema).optional(),
      websiteRelationship: z.string().optional(),
    })
    .passthrough()
    .default({}),
  metadata: z
    .object({
      source: z.string().default('web'),
      extractedAt: z.string().default(() => new Date().toISOString()),
      runStartedAt: z.string().optional(),
      confidence: z.number().default(0),
      confidenceBreakdown: confidenceBreakdownSchema.optional(),
    })
    .passthrough(),
  process: z.string().default('Verified via Google + Web search'),
  links: z.array(z.string()).default([]),
  gpsCoordinates: z
    .object({
      latitude: z.number().optional(),
      longitude: z.number().optional(),
    })
    .optional(),
  rating: z.number().optional(),
  ratingCount: z.number().optional(),
  businessType: z.string().optional(),
  placeId: z.string().optional(),
});

export type BusinessListing = z.infer<typeof businessListingSchema>;

export interface RunResearchDiscoveryInput {
  query: string;
  location?: string;
  autoApprove?: boolean;
  agentId?: string;
  targetCandidates?: number;
  maxPages?: number;
  maxMapsPages?: number;
}

export async function runResearchDiscovery(
  inputData: RunResearchDiscoveryInput,
  mastra?: any
): Promise<{
  candidates: UnifiedSearchResult[];
  researchCandidates: ResearchCandidate[];
  query: string;
  location?: string;
  autoApprove: boolean;
  agentId?: string;
  researchReport: ResearchReport;
}> {
  const {
    query,
    location,
    autoApprove = true,
    agentId,
    targetCandidates = 10,
    maxPages = 5,
    maxMapsPages = 5,
  } = inputData;

  console.log(
    `[Workflow:Step1] Research Agent initiating hybrid discovery for "${query}" (target: ${targetCandidates}, maxMapsPages: ${maxMapsPages}, maxPages: ${maxPages})`
  );

  // Initialize unified run session context for co-located history archiving
  startRunSession(query, location);

  const seenUrls = new Set<string>();
  const allDecisions: ResearchDecision[] = [];
  const excludedSummary: ExcludedSummaryItem[] = [];

  let usableCount = 0;
  let excludedCount = 0;
  let ambiguousCount = 0;
  let pagesSearched = 0;
  let stoppedReason: StoppedReason = 'no_usable_results';
  let firstSearchResponse: any = null;
  let rawPlaces: SerperPlaceResult[] = [];
  const accumulatedWebUsable: Array<{ candidate: UnifiedSearchResult; decision: ResearchDecision }> = [];
  let currentResearchCandidates: ResearchCandidate[] = [];

  const categoryIntent: CategoryIntent = normalizeCategoryIntent(query);
  const expandedQueries: ExpandedQuery[] = expandCategoryQueries(categoryIntent, location || '');

  let rawCandidates = 0;
  let exactQueryCandidates = 0;
  let expandedQueryCandidates = 0;
  let relevantCandidates = 0;
  let irrelevantCandidates = 0;
  let ambiguousCandidates = 0;

  // ========================================================================
  // Phase 0: Google Maps First (Multi-Page Bounded Discovery with Safeguards)
  // ========================================================================
  console.log(
    `[Workflow:Step1] Phase 0: Initiating Maps-first bounded discovery for "${query}" (${expandedQueries.length} query variations, target: ${targetCandidates}, maxMapsPages: ${maxMapsPages})...`
  );
  try {
    for (const eq of expandedQueries) {
      if (currentResearchCandidates.length >= targetCandidates) break;

      const mapsDiscovery = await paginateMapsDiscovery({
        query: eq.query,
        location: undefined,
        targetCandidates: targetCandidates - currentResearchCandidates.length,
        maxMapsPages,
      });

      for (const place of mapsDiscovery.rawPlaces) {
        rawCandidates++;
        if (eq.type === 'exact') {
          exactQueryCandidates++;
        } else {
          expandedQueryCandidates++;
        }

        const relevance = checkCategoryRelevance(
          place.title,
          place.category || place.type,
          categoryIntent
        );

        if (relevance.status === 'relevant') {
          relevantCandidates++;
          rawPlaces.push(place);
        } else if (relevance.status === 'irrelevant') {
          irrelevantCandidates++;
          excludedCount++;
          excludedSummary.push({
            title: place.title,
            url: place.website || (place.placeId ? `https://maps.google.com/?cid=${place.placeId}` : `google_maps:${encodeURIComponent(place.title)}`),
            domain: place.website ? extractDomain(place.website) : 'maps.google.com',
            classification: 'irrelevant',
            reason: relevance.reason,
          });
          allDecisions.push({
            url: place.website || (place.placeId ? `https://maps.google.com/?cid=${place.placeId}` : `google_maps:${encodeURIComponent(place.title)}`),
            domain: place.website ? extractDomain(place.website) : 'maps.google.com',
            title: place.title,
            classification: 'irrelevant',
            confidence: relevance.confidence,
            reason: relevance.reason,
            source: 'deterministic',
          });
        } else {
          // ambiguous — excluded from candidate pool
          ambiguousCandidates++;
          excludedCount++;
          excludedSummary.push({
            title: place.title,
            url: place.website || (place.placeId ? `https://maps.google.com/?cid=${place.placeId}` : `google_maps:${encodeURIComponent(place.title)}`),
            domain: place.website ? extractDomain(place.website) : 'maps.google.com',
            classification: 'irrelevant',
            reason: relevance.reason,
          });
          allDecisions.push({
            url: place.website || (place.placeId ? `https://maps.google.com/?cid=${place.placeId}` : `google_maps:${encodeURIComponent(place.title)}`),
            domain: place.website ? extractDomain(place.website) : 'maps.google.com',
            title: place.title,
            classification: 'irrelevant',
            confidence: relevance.confidence,
            reason: relevance.reason,
            source: 'deterministic',
          });
        }
      }

      // Rebuild intermediate candidates with accumulated relevant places
      const intermediateBuild = buildResearchCandidates({
        places: rawPlaces,
        webUsable: [],
        defaultLocation: location,
      });
      currentResearchCandidates = intermediateBuild.candidates;
      usableCount = currentResearchCandidates.length;
    }

    console.log(
      `[Workflow:Step1] Phase 0 Maps discovery complete across ${expandedQueries.length} queries: ${rawPlaces.length} relevant raw places, ${currentResearchCandidates.length} unique candidates`
    );

    // Targeted Website & Phone Lookups for evidence-ranked places lacking websites or phones
    const placesNeedingEnrichment = rawPlaces.filter(
      (p) => !p.website || p.website.trim().length === 0 || !p.phoneNumber || p.phoneNumber.trim().length === 0
    );
    const lookupLimit = Math.min(
      placesNeedingEnrichment.length,
      targetCandidates ? Math.max(targetCandidates, 10) : 10
    );
    const targetedLookups = rankWebsiteLookupTargets(placesNeedingEnrichment, lookupLimit);
    if (targetedLookups.length > 0) {
      console.log(
        `[Workflow:Step1] Phase 0: Running targeted web lookup for ${targetedLookups.length} evidence-ranked places needing enrichment...`
      );
      for (const place of targetedLookups) {
        try {
          const lookupQuery = `${place.title} ${location || place.address || ''}`.trim();
          const lookupRes = await searchWithFallback(lookupQuery, undefined, 5, 1);
          if (lookupRes.results && lookupRes.results.length > 0) {
            // 1. Discover Official Website
            if (!place.website || place.website.trim().length === 0) {
              const candidateSite = lookupRes.results.find((r) =>
                isUsableOfficialWebsite(r.url, place.title, place.category || place.type, r.title)
              );
              if (candidateSite && candidateSite.url) {
                console.log(
                  `[Workflow:Step1] Phase 0: Discovered verified official website for "${place.title}": ${candidateSite.url}`
                );
                place.website = candidateSite.url;
              }
            }

            // 2. Extract Phone Number from SERP Snippets
            if (!place.phoneNumber || place.phoneNumber.trim().length === 0) {
              const snippetText = lookupRes.results
                .map((r) => `${r.title || ''} ${r.description || ''} ${(r.extraSnippets || []).join(' ')}`)
                .join('\n');
              const phones = extractPhones(snippetText);
              const mobiles = extractMobiles(snippetText);
              const allSnippetPhones = [...phones, ...mobiles];
              if (allSnippetPhones.length > 0) {
                place.phoneNumber = allSnippetPhones[0];
                console.log(
                  `[Workflow:Step1] Phase 0: Discovered phone for "${place.title}" from search snippet: ${place.phoneNumber}`
                );
              }
            }
          }
        } catch (lookupErr) {
          console.warn(`[Workflow:Step1] Phase 0: Targeted lookup failed for "${place.title}":`, lookupErr);
        }
      }

      // Rebuild with newly-discovered official websites & phones
      const rebuilt = buildResearchCandidates({
        places: rawPlaces,
        webUsable: [],
        defaultLocation: location,
      });
      currentResearchCandidates = rebuilt.candidates;
      usableCount = currentResearchCandidates.length;
    }

    for (const candidate of currentResearchCandidates) {
      const url =
        candidate.website ||
        (candidate.sources.googleMaps?.placeId
          ? `https://maps.google.com/?cid=${candidate.sources.googleMaps.placeId}`
          : `google_maps:${encodeURIComponent(candidate.name)}`);
      allDecisions.push({
        url,
        domain: candidate.website ? extractDomain(candidate.website) : 'maps.google.com',
        title: candidate.name,
        classification: 'business',
        confidence: 1.0,
        reason: 'Verified Google Maps business listing',
        source: 'deterministic',
      });
    }
  } catch (mapsErr) {
    console.warn('[Workflow:Step1] Phase 0 Google Maps search encountered error, continuing with web search:', mapsErr);
  }

  // Resolve search-worker agent for ambiguous classification
  let searchWorker = mastra?.getAgentById?.('search-worker-agent');
  if (!searchWorker) {
    try {
      const { mastra: appMastra } = await import('../index');
      searchWorker = appMastra?.getAgentById('search-worker-agent');
    } catch {}
  }

  // ========================================================================
  // Phase 1: Web Fallback Pagination Loop
  // ========================================================================
  if (currentResearchCandidates.length >= targetCandidates) {
    console.log(
      `[Workflow:Step1] Target reached via Google Maps (${currentResearchCandidates.length} >= ${targetCandidates} unique businesses). Skipping web pagination.`
    );
    stoppedReason = 'target_reached';
  } else {
    console.log(
      `[Workflow:Step1] Maps discovery yielded ${currentResearchCandidates.length}/${targetCandidates} unique businesses. Transitioning to Web fallback to find remaining...`
    );

    let consecutiveStalePages = 0;

    for (const eq of expandedQueries) {
      if (currentResearchCandidates.length >= targetCandidates) {
        stoppedReason = 'target_reached';
        break;
      }

      for (let page = 1; page <= maxPages; page++) {
        pagesSearched = page;
        console.log(`[Workflow:Step1] Fetching search page ${page}/${maxPages} for "${eq.query}"...`);

        const response = await searchWithFallback(eq.query, undefined, 10, page);
        if (!firstSearchResponse) {
          firstSearchResponse = response;
          saveStageOutput('broad-search', '1-broad-search.json', response, query);
        }

        if (!response.results || response.results.length === 0) {
          console.log(`[Workflow:Step1] No results returned on page ${page} for "${eq.query}".`);
          if (currentResearchCandidates.length === 0) stoppedReason = 'no_usable_results';
          else if (!stoppedReason || stoppedReason === 'no_usable_results') stoppedReason = 'no_more_pages';
          break;
        }

        // Apply category relevance filtering before web classification
        const relevantWebResults: UnifiedSearchResult[] = [];
        for (const r of response.results) {
          rawCandidates++;
          if (eq.type === 'exact') {
            exactQueryCandidates++;
          } else {
            expandedQueryCandidates++;
          }

          const relevance = checkCategoryRelevance(r.title, r.description, categoryIntent);
          if (relevance.status === 'relevant') {
            relevantCandidates++;
            relevantWebResults.push(r);
          } else if (relevance.status === 'irrelevant') {
            irrelevantCandidates++;
            excludedCount++;
            excludedSummary.push({
              title: r.title,
              url: r.url,
              domain: r.domain,
              classification: 'irrelevant',
              reason: relevance.reason,
            });
            allDecisions.push({
              url: r.url,
              domain: r.domain,
              title: r.title,
              classification: 'irrelevant',
              confidence: relevance.confidence,
              reason: relevance.reason,
              source: 'deterministic',
            });
          } else {
            // ambiguous — excluded from candidate pool
            ambiguousCandidates++;
            excludedCount++;
            excludedSummary.push({
              title: r.title,
              url: r.url,
              domain: r.domain,
              classification: 'irrelevant',
              reason: relevance.reason,
            });
            allDecisions.push({
              url: r.url,
              domain: r.domain,
              title: r.title,
              classification: 'irrelevant',
              confidence: relevance.confidence,
              reason: relevance.reason,
              source: 'deterministic',
            });
          }
        }

        // Cheap URL-dedup pre-filter
        const newResults = relevantWebResults.filter((r) => {
          const normUrl = normalizeUrl(r.url);
          if (!normUrl || seenUrls.has(normUrl)) return false;
          seenUrls.add(normUrl);
          return true;
        });

        const previousUniqueCount = currentResearchCandidates.length;

        // 1. Deterministic classification
        const { usable, excluded, ambiguous } = filterSearchResults(newResults);

        for (const exc of excluded) {
          excludedCount++;
          excludedSummary.push({
            title: exc.candidate.title,
            url: exc.candidate.url,
            domain: exc.candidate.domain,
            classification: exc.decision.classification,
            reason: exc.decision.reason,
          });
          allDecisions.push(exc.decision);
        }

        for (const use of usable) {
          usableCount++;
          accumulatedWebUsable.push({ candidate: use.candidate, decision: use.decision });
          allDecisions.push(use.decision);
        }

        // 2. Ambiguous candidates via LLM
        if (ambiguous.length > 0) {
          ambiguousCount += ambiguous.length;
          if (searchWorker) {
            try {
              const prompt = `Classify the following ${ambiguous.length} search candidates for query "${query}" into:
- business: Direct, single-entity commercial business offering goods/services
- aggregator: Multi-vendor marketplace or directory (e.g. Booking, Agoda)
- directory: Local business directory or yellow pages
- article: Blog post, travel guide, or informational article
- social: Social media profile or group
- irrelevant: Unrelated topic or non-commercial entity

Candidates:
${ambiguous.map((a, i) => `[${i + 1}] Title: ${a.candidate.title}\nURL: ${a.candidate.url}\nDomain: ${a.candidate.domain}\nSnippet: ${a.candidate.description}`).join('\n\n')}

Respond with a JSON array of classifications matching this exact schema:
[
  {
    "index": 1,
    "classification": "business" | "aggregator" | "directory" | "article" | "social" | "irrelevant",
    "confidence": 0.0 - 1.0,
    "reason": "Brief explanation"
  }
]`;

              const llmResponse = await withTimeout(
                searchWorker.generate(prompt),
                30000,
                'Search worker classification timed out'
              );

              let rawText = (llmResponse as any)?.text || '';
              if (rawText.includes('```json')) {
                rawText = rawText.replace(/```json\s*/gi, '').replace(/```\s*$/gi, '').trim();
              } else if (rawText.includes('```')) {
                rawText = rawText.replace(/```\s*/gi, '').replace(/```\s*$/gi, '').trim();
              }

              const parsed = JSON.parse(rawText);
              if (Array.isArray(parsed)) {
                for (const item of parsed) {
                  const original = ambiguous[item.index - 1];
                  if (!original) continue;

                  const decision: ResearchDecision = {
                    url: original.candidate.url,
                    domain: original.candidate.domain,
                    title: original.candidate.title,
                    classification: item.classification || 'irrelevant',
                    confidence: typeof item.confidence === 'number' ? item.confidence : 0.7,
                    reason: item.reason || 'Classified by search-worker agent',
                    source: 'llm',
                  };
                  allDecisions.push(decision);

                  if (item.classification === 'business') {
                    usableCount++;
                    accumulatedWebUsable.push({ candidate: original.candidate, decision });
                  } else {
                    excludedCount++;
                    excludedSummary.push({
                      title: original.candidate.title,
                      url: original.candidate.url,
                      domain: original.candidate.domain,
                      classification: item.classification || 'irrelevant',
                      reason: item.reason || 'Classified by search-worker agent',
                    });
                  }
                }
              }
            } catch (err) {
              console.warn('[Workflow:Step1] LLM classification of ambiguous results failed:', err);
              for (const amb of ambiguous) {
                excludedCount++;
                const decision: ResearchDecision = {
                  url: amb.candidate.url,
                  domain: amb.candidate.domain,
                  title: amb.candidate.title,
                  classification: 'irrelevant',
                  confidence: 0.3,
                  reason: 'LLM classification failed — safely excluded',
                  source: 'llm',
                };
                allDecisions.push(decision);
                excludedSummary.push({
                  title: amb.candidate.title,
                  url: amb.candidate.url,
                  domain: amb.candidate.domain,
                  classification: 'irrelevant',
                  reason: 'LLM classification failed — safely excluded',
                });
              }
            }
          } else {
            for (const amb of ambiguous) {
              excludedCount++;
              const decision: ResearchDecision = {
                url: amb.candidate.url,
                domain: amb.candidate.domain,
                title: amb.candidate.title,
                classification: 'irrelevant',
                confidence: 0.2,
                reason: 'No agent available to evaluate ambiguous candidate — safely excluded',
                source: 'deterministic',
              };
              allDecisions.push(decision);
              excludedSummary.push({
                title: amb.candidate.title,
                url: amb.candidate.url,
                domain: amb.candidate.domain,
                classification: 'irrelevant',
                reason: 'No agent available to evaluate ambiguous candidate — safely excluded',
              });
            }
          }
        }

        // Rebuild research candidates with accumulated web usable evidence
        const rebuild = buildResearchCandidates({
          places: rawPlaces,
          webUsable: accumulatedWebUsable,
          defaultLocation: location,
        });
        currentResearchCandidates = rebuild.candidates;

        const uniqueCount = currentResearchCandidates.length;
        console.log(
          `[Workflow:Step1] Page ${page} complete for "${eq.query}". Unique business candidates so far: ${uniqueCount}/${targetCandidates} (matches merged: ${rebuild.matchesMerged})`
        );

        // 3. Stopping checks based on UNIQUE entities
        if (uniqueCount >= targetCandidates) {
          console.log(`[Workflow:Step1] Target reached (${uniqueCount} >= ${targetCandidates} unique businesses).`);
          stoppedReason = 'target_reached';
          break;
        }

        if (!response.pagination.hasNextPage) {
          console.log(`[Workflow:Step1] No further pages available from search provider for "${eq.query}".`);
          stoppedReason = uniqueCount > 0 ? 'no_more_pages' : 'no_usable_results';
          break;
        }

        if (page >= maxPages) {
          console.log(`[Workflow:Step1] Maximum pages reached (${maxPages}) for "${eq.query}".`);
          stoppedReason = uniqueCount > 0 ? 'max_pages_reached' : 'no_usable_results';
          break;
        }

        if (uniqueCount === previousUniqueCount && newResults.length > 0) {
          consecutiveStalePages++;
          console.log(
            `[Workflow:Step1] Page ${page} yielded no new unique business entities (stale pages: ${consecutiveStalePages}).`
          );
          if (consecutiveStalePages >= 2) {
            stoppedReason = uniqueCount > 0 ? 'no_new_results' : 'no_usable_results';
            break;
          }
        } else {
          consecutiveStalePages = 0;
        }
      }
    }
  }

  // Final rebuild to guarantee canonical state
  const finalBuild = buildResearchCandidates({
    places: rawPlaces,
    webUsable: accumulatedWebUsable,
    defaultLocation: location,
  });
  currentResearchCandidates = finalBuild.candidates;

  if (currentResearchCandidates.length === 0 && stoppedReason !== 'no_usable_results') {
    stoppedReason = 'no_usable_results';
  }

  // Derived compatibility view (pure projection)
  const rankedCandidates = toUnifiedCandidates(currentResearchCandidates, rawPlaces);

  // Metric semantics (documented, not refactored):
  // - usableCount: raw/legacy processing metric — counts every usable web row pushed
  //   during the loop; a web row that merges into an existing Maps entity is counted
  //   even though it does not add a business. Kept for backward compatibility.
  // - uniqueBusinessesFound: AUTHORITATIVE business metric — the number of unique
  //   entities in researchCandidates after entity resolution. This is what the
  //   Research Agent uses for stopping (targetCandidates).
  const discoveryMetrics: DiscoveryMetrics = {
    categoryIntent: categoryIntent.normalized,
    isBroadQuery: categoryIntent.isBroad,
    queriesGenerated: expandedQueries.length,
    expandedQueriesGenerated: expandedQueries.filter((q) => q.type === 'expanded').length,
    rawCandidates,
    exactQueryCandidates,
    expandedQueryCandidates,
    relevantCandidates,
    irrelevantCandidates,
    ambiguousCandidates,
    uniqueEntities: currentResearchCandidates.length,
  };

  const researchReport: ResearchReport = {
    query,
    location,
    pagesSearched,
    targetCandidates,
    candidatesFound: rankedCandidates.length,
    usableCount,
    excludedCount,
    ambiguousCount,
    stoppedReason,
    candidates: rankedCandidates,
    excludedSummary,
    decisions: allDecisions,
    uniqueBusinessesFound: currentResearchCandidates.length,
    matchesMerged: finalBuild.matchesMerged,
    researchCandidates: currentResearchCandidates,
    discoveryMetrics,
  };

  // Full research report artifact
  saveStageOutput('research-agent', '0-research-candidates.json', researchReport, query);

  // Task 7: Lean research-tier output artifact
  saveStageOutput('research-agent', '0b-research-candidates-lean.json', {
    query,
    location,
    stoppedReason,
    uniqueBusinessesFound: currentResearchCandidates.length,
    candidates: currentResearchCandidates,
  }, query);

  console.log(
    `[Workflow:Step1] Research Agent complete: ${currentResearchCandidates.length} unique businesses selected (${rankedCandidates.length} flattened candidates, stopped: ${stoppedReason})`
  );

  return {
    candidates: rankedCandidates,
    researchCandidates: currentResearchCandidates,
    query,
    location,
    autoApprove,
    agentId,
    researchReport,
  };
}

export const researchAgentStep = createStep({
  id: 'research-agent-step',
  inputSchema: z.object({
    query: z.string(),
    location: z.string().optional(),
    autoApprove: z.boolean().default(true),
    agentId: z.string().optional(),
    targetCandidates: z.number().optional(),
    maxMapsPages: z.number().optional(),
    maxPages: z.number().optional(),
    // Phase 2 passthrough: Tavily deep-verification cap (consumed by Step 2).
    maxDeepVerifyCandidates: z.number().optional(),
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
  }),
  execute: async ({ inputData, mastra }) => {
    const result = await runResearchDiscovery(inputData, mastra);
    return {
      ...result,
      maxDeepVerifyCandidates: inputData.maxDeepVerifyCandidates,
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
  }),
  execute: async ({ inputData, suspend, resumeData }) => {
    if (inputData.autoApprove) {
      console.log(`[Workflow:HITL] Auto-approved ${inputData.candidates.length} candidates (headless mode)`);
      return {
        candidates: inputData.candidates,
        researchCandidates: inputData.researchCandidates,
        query: inputData.query,
        location: inputData.location,
        autoApprove: inputData.autoApprove,
        agentId: inputData.agentId,
        researchReport: inputData.researchReport,
        maxDeepVerifyCandidates: inputData.maxDeepVerifyCandidates,
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

    return {
      candidates: approvedCandidates,
      researchCandidates: inputData.researchCandidates,
      query: inputData.query,
      location: inputData.location,
      autoApprove: inputData.autoApprove,
      agentId: inputData.agentId,
      researchReport: inputData.researchReport,
      maxDeepVerifyCandidates: inputData.maxDeepVerifyCandidates,
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
  }),
  execute: async ({ inputData }) => {
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
      const flattenedExtractions: Array<{
        url: string;
        content: string;
        favicon: string;
        success: boolean;
        error?: string;
      }> = [];

const DEFAULT_CRAWL_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function fetchRawPageHtml(url: string, timeoutMs = 8000, maxRetries = 1): Promise<string | undefined> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await withTimeout(
        fetch(url, {
          headers: {
            'User-Agent': DEFAULT_CRAWL_USER_AGENT,
            Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          },
          redirect: 'follow',
        }),
        timeoutMs,
        `raw-html-fetch`
      );
      if (!res.ok) {
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          continue;
        }
        return undefined;
      }
      const html = await withTimeout(res.text(), timeoutMs, `raw-html-text`);
      console.log(`[Workflow:Step2] Raw HTML fetched for ${url}: ${html.length} bytes`);
      return html;
    } catch {
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      console.warn(`[Workflow:Step2] Raw HTML fetch failed for ${url} (0 bytes)`);
      return undefined;
    }
  }
  return undefined;
}

      for (const candidate of selected) {
        const website = candidate.website;
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

          // 6) Secondary Recovery: Tavily Advanced Retry (v1.3 cost guard)
          // Trigger ONLY if candidate STILL has zero contact signals across both markdown & raw HTML,
          // and a key contact page or homepage was sparse or failed in Tavily basic.
          const postRawEvidence = extractAllFromPages(pageEvidences);
          const stillNeedsRecovery =
            postRawEvidence.extractedEmails.length === 0 &&
            postRawEvidence.extractedPhones.length === 0 &&
            postRawEvidence.extractedMobiles.length === 0;

          if (stillNeedsRecovery) {
            const failedCandidatePages = pageEvidences.filter(
              (p) => (!p.success || p.content.length < 100) && (p.pageType === 'contact' || p.pageType === 'home')
            );
            if (failedCandidatePages.length > 0) {
              const retryUrl = failedCandidatePages[0].url;
              console.log(
                `[Workflow:Step2] Secondary recovery: retrying "${retryUrl}" with Tavily advanced depth...`
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

      const verifiedEvidence = buildVerifiedEvidence(researchCandidates, extractionsByCandidate);

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
    };
  },
});

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
  }),
  outputSchema: z.object({
    listings: z.array(businessListingSchema),
    researchReport: researchReportSchema.optional(),
    verifiedEvidence: z.array(verifiedBusinessEvidenceSchema).optional(),
  }),
  execute: async ({ inputData, mastra }) => {
    const { candidates, extractions, verifiedEvidence, query, location, agentId, researchReport } = inputData;
    const runStartedAt = new Date().toISOString();
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

    // --- LAYER 1: UnoRouter AI Consensus Tribunal ---
    if (process.env.UNOROUTER_API_KEY) {
      try {
        console.log('[Workflow:Step3] Invoking Layer 1: UnoRouter AI Consensus Tribunal...');
        const tribunalRes = await generateWithUnoTribunal(prompt);
        const parsed = parseListingsFromJson(tribunalRes.text);
        if (parsed.length > 0) {
          console.log(
            `[Workflow:Step3] Synthesis succeeded via UnoRouter Tribunal (${tribunalRes.modelUsed}, consensus: ${tribunalRes.consensus}, ${parsed.length} listings)`
          );
          rawListings = parsed;
        } else {
          console.warn('[Workflow:Step3] UnoRouter Tribunal produced unparseable listings. Cascading to Layer 2...');
        }
      } catch (unoErr) {
        console.warn(`[Workflow:Step3] UnoRouter Tribunal failed: ${(unoErr as Error).message}. Cascading to Layer 2...`);
      }
    }

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
          const response = await agent.generate(prompt);
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

    // ========================================================================
    // Post-Synthesis: Deterministic GPS & Phone Re-injection + Tradesmen Preservation
    // ========================================================================
    const mapsCandidates = candidates.filter((c) => c.source === 'google_maps');
    const matchedMapUrls = new Set<string>();

    for (const listing of listings) {
      const match = mapsCandidates.find((m) => {
        if (matchedMapUrls.has(m.url)) return false;

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
        matchedMapUrls.add(match.url);

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

    // Adjustment 3: Preserve any Google Maps businesses that the LLM omitted (e.g. tradesmen without websites)
    for (const m of mapsCandidates) {
      if (!matchedMapUrls.has(m.url)) {
        console.log(`[Workflow:Step3] Preserving unlisted Google Maps tradesman/business: "${m.title}"`);
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
        sanitizedCount++;
        console.log(
          `[Workflow:Step3] Evidence-sanitized "${listing.name}" (status: ${ev.verification.status}, confidence: ${ev.verification.overallConfidence})`
        );
      }
      console.log(`[Workflow:Step3] Sanitized ${sanitizedCount}/${verifiedEvidence.length} evidence records onto listings`);
    }

    // Ensure location is never empty if a default location exists
    for (const listing of listings) {
      if (!listing.location || listing.location.trim().length === 0) {
        listing.location = location || 'Kathmandu, Nepal';
      }
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

    // Save final artifacts AFTER post-synthesis sanitization and location backfill
    saveStageOutput('final-listings', '3-final-listings.json', listings, query);
    saveStageOutput('results', 'results.json', listings, query);

    // Save high-level summary report for latest consumer and history archive
    saveSummaryReport({
      query,
      location,
      totalBusinesses: listings.length,
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
      status: listings.length > 0 ? 'success' : 'failed',
      synthesisMethod: 'UnoRouter AI Consensus Tribunal / Fallback',
    });

    endRunSession();

    console.log('\n================ FINAL VERIFIED LISTINGS ================');
    console.log(JSON.stringify(listings, null, 2));
    console.log('=========================================================\n');

    return { listings, researchReport, verifiedEvidence };
  },
});

// ============================================================================
// Phase 2: Post-Synthesis Evidence Sanitizer (Correction 3)
// ============================================================================
// The Supervisor may organize/summarize/label, but structured contact fields
// MUST be evidence-backed. After LLM synthesis, listings matched to
// VerifiedBusinessEvidence are overwritten with deterministic values:
//   emails/phones/mobiles/socials/websites/icon ← VerifiedBusinessEvidence
//   GPS/rating/ratingCount/placeId/businessType ← Maps (re-injected earlier)
// LLM-invented contact data is discarded — never merged in.

export function matchListingToEvidence(
  listing: z.infer<typeof businessListingSchema>,
  evidenceList: VerifiedBusinessEvidence[]
): VerifiedBusinessEvidence | undefined {
  const listName = normalizeNameKey(listing.name || '');

  // 1. Phone match (candidate authoritative phone ↔ listing phone/mobile)
  for (const ev of evidenceList) {
    const candidate = ev.candidate;
    if (candidate.phone) {
      const candidateDigits = normalizePhoneDigits(candidate.phone);
      if (candidateDigits.length >= 7) {
        const hasPhone = [...(listing.phones || []), ...(listing.mobiles || [])].some((p) => {
          const d = normalizePhoneDigits(p);
          if (!d || d.length < 7) return false;
          return d === candidateDigits || d.includes(candidateDigits) || candidateDigits.includes(d);
        });
        if (hasPhone) return ev;
      }
    }
  }

  // 2. Candidate Name Containment match (authoritative candidate identity)
  for (const ev of evidenceList) {
    const candidateName = normalizeNameKey(ev.candidate.name || '');
    if (listName && candidateName && (listName.includes(candidateName) || candidateName.includes(listName))) {
      return ev;
    }
  }

  // 3. Domain match (supporting signal ONLY if name key aligns or is unspecified)
  for (const ev of evidenceList) {
    const candidateDomain = ev.candidate.website ? domainFromUrlOrHost(ev.candidate.website) : '';
    if (candidateDomain && (listing.websites || []).some((w) => extractDomain(w) === candidateDomain)) {
      const candidateName = normalizeNameKey(ev.candidate.name || '');
      if (!listName || !candidateName || listName.includes(candidateName) || candidateName.includes(listName)) {
        return ev;
      }
    }
  }

  return undefined;
}

export function sanitizeListingWithEvidence(
  listing: z.infer<typeof businessListingSchema>,
  evidence: VerifiedBusinessEvidence
): z.infer<typeof businessListingSchema> {
  const candidate = evidence.candidate;
  const web = evidence.websiteEvidence;

  // ═══════════════════════════════════════════════════════════════════════════
  // ENRICHMENT GATE: Require trusted relationship + candidate name alignment
  // ═══════════════════════════════════════════════════════════════════════════
  const relationship = evidence.websiteRelationship || 'unverified';
  const candidateNameKey = normalizeNameKey(candidate.name || '');
  const listingNameKey = normalizeNameKey(listing.name || '');
  const namesAlign = Boolean(
    candidateNameKey &&
      listingNameKey &&
      (listingNameKey.includes(candidateNameKey) || candidateNameKey.includes(listingNameKey))
  );

  const isFirstParty = relationship === 'first_party' && namesAlign;
  const isCorporateParent = relationship === 'corporate_parent' && namesAlign;
  const isContactEnrichable = isFirstParty || isCorporateParent;

  const candidatePhoneDigits = normalizePhoneDigits(candidate.phone || '');
  const websiteUrl = candidate.website || web?.url || (listing.websites && listing.websites[0]) || '';
  const websiteDomain = websiteUrl ? domainFromUrlOrHost(websiteUrl) : undefined;

  // --- Contact fields: evidence-backed ONLY with Semantic Role & Ownership (Task 3) ---
  const mergedPhones: string[] = [];
  const mergedMobiles: string[] = [];
  const seenDigits = new Set<string>();
  const branchesMap = new Map<string, BranchRecord>();
  const allClassifiedContacts: ClassifiedContact[] = [...(web?.extractedClassifiedContacts || [])];

  // Process candidate.phone into allClassifiedContacts if not already present
  if (candidate.phone) {
    const candidateClassified = classifyNepalPhone(candidate.phone);
    if (candidateClassified.type !== 'invalid') {
      const candidateRole = classifyPhoneRole(candidate.phone, candidate.name, candidate.name, candidateClassified);
      const isAlreadyClassified = allClassifiedContacts.some((c) => c.canonicalDigits === candidateClassified.digits);
      if (!isAlreadyClassified) {
        allClassifiedContacts.push({
          value: candidate.phone,
          canonicalDigits: candidateClassified.digits,
          type: 'phone',
          phoneType: candidateClassified.type,
          role: candidateRole.role,
          owner: candidateRole.owner,
          channels: candidateRole.channels,
          context: candidate.name,
        });
      }
    }
  }

  // Branch separation and aggregation
  for (const c of allClassifiedContacts) {
    if (c.role === 'branch_contact') {
      let branchName = 'Branch';
      const locMatch = c.context?.match(/\b(chabahil|naikap|bardibas|banasthali|chapagaun|jawalakhel|koteshwor|kumaripati|pokhara|biratnagar|birgunj|dharan|hetauda|nepalgunj|butwal)\b/i);
      if (locMatch) {
        const cap = locMatch[1].charAt(0).toUpperCase() + locMatch[1].slice(1).toLowerCase();
        branchName = `${cap} Branch`;
      } else if (c.context) {
        branchName = c.context.slice(0, 30).trim();
      }
      const existing = branchesMap.get(branchName) || {
        name: branchName,
        phones: [],
        mobiles: [],
        emails: [],
        sourceUrl: c.pageUrl,
      };
      if (c.type === 'phone') {
        if (c.phoneType === 'mobile') {
          if (!existing.mobiles.includes(c.value)) existing.mobiles.push(c.value);
        } else {
          if (!existing.phones.includes(c.value)) existing.phones.push(c.value);
        }
      } else if (c.type === 'email') {
        if (!existing.emails.includes(c.value)) existing.emails.push(c.value);
      }
      branchesMap.set(branchName, existing);
    }
  }
  const branches = [...branchesMap.values()];

  const routePhone = (p?: string) => {
    if (!p) return;
    const classified = classifyNepalPhone(p);
    if (classified.type === 'invalid') return;
    if (seenDigits.has(classified.digits)) return;

    // Check if this number is a branch contact -> do not promote to primary top-level
    const isBranch = allClassifiedContacts.some(
      (c) => c.canonicalDigits === classified.digits && c.role === 'branch_contact'
    );
    if (isBranch) return;

    seenDigits.add(classified.digits);

    const display = classified.normalized || p.trim();
    if (classified.type === 'mobile') {
      mergedMobiles.push(display);
    } else {
      mergedPhones.push(display);
    }
  };

  // 1. Authority 1: Maps/SERP phone (identity authority, E3)
  routePhone(candidate.phone);

  // 2. Authority 2: Website verified evidence
  if (isFirstParty) {
    for (const m of web?.extractedMobiles || []) routePhone(m);
    for (const p of web?.extractedPhones || []) routePhone(p);
  } else if (isCorporateParent && candidatePhoneDigits) {
    // Corporate parent: ACCEPT phone ONLY if exact canonical identity match with Maps phone
    for (const m of web?.extractedMobiles || []) {
      if (normalizePhoneDigits(m) === candidatePhoneDigits) routePhone(m);
    }
    for (const p of web?.extractedPhones || []) {
      if (normalizePhoneDigits(p) === candidatePhoneDigits) routePhone(p);
    }
  }

  // 3. Fallback: only if both are empty (no phones found anywhere in evidence)
  if (mergedPhones.length === 0 && mergedMobiles.length === 0) {
    for (const m of listing.mobiles || []) routePhone(m);
    for (const p of listing.phones || []) routePhone(p);
  }

  // Websites: ONLY the candidate's official website.
  const websites: string[] = [];
  if (candidate.website) websites.push(candidate.website);
  else if (isContactEnrichable && web?.url && isUsableOfficialWebsite(web.url, candidate.name)) {
    websites.push(web.url);
  } else if (listing.websites && listing.websites.length > 0) {
    for (const w of listing.websites) {
      if (isUsableOfficialWebsite(w, candidate.name) && !websites.includes(w)) {
        websites.push(w);
      }
    }
  }

  // Emails: first_party ONLY + strict primary_business policy
  const rawEmails: string[] = [];
  if (isFirstParty) {
    for (const c of allClassifiedContacts) {
      if (c.type === 'email' && c.owner === 'business' && c.role === 'primary_business') {
        rawEmails.push(c.value);
      }
    }
    // If no classified emails found, classify from extractedEmails
    if (rawEmails.length === 0 && (web?.extractedEmails || []).length > 0) {
      for (const e of web?.extractedEmails || []) {
        const classified = classifyEmailRole(e, '', candidate.name, websiteDomain);
        allClassifiedContacts.push({
          value: e,
          type: 'email',
          role: classified.role,
          owner: classified.owner,
          channels: [],
        });
        if (classified.owner === 'business' && classified.role === 'primary_business') {
          rawEmails.push(e);
        }
      }
    }
  }

  if (rawEmails.length === 0 && listing.emails && listing.emails.length > 0) {
    for (const e of listing.emails) {
      const classified = classifyEmailRole(e, '', candidate.name, websiteDomain);
      if (classified.owner === 'business' && classified.role === 'primary_business') {
        rawEmails.push(e);
      }
    }
  }
  const emails = [...new Set(rawEmails.map(sanitizeEmailString).filter((e) => /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(e)))];

  // Social Links: first_party ONLY (corporate_parent socials BLOCKED)
  const rawFb = (isFirstParty ? web?.extractedSocialLinks.facebook : '') || listing.socialLinks?.facebook || '';
  const rawTt = (isFirstParty ? web?.extractedSocialLinks.tiktok : '') || listing.socialLinks?.tiktok || '';
  const rawIg = (isFirstParty ? web?.extractedSocialLinks.instagram : '') || listing.socialLinks?.instagram || '';

  const otherSources = {
    ...(listing.socialLinks?.other || {}),
    ...(isFirstParty ? web?.extractedSocialLinks.other || {} : {}),
  };
  const validatedOther: Record<string, string> = {};
  for (const [k, v] of Object.entries(otherSources)) {
    if (v && isRealSocialProfile(v, k)) {
      validatedOther[k] = v;
    }
  }

  const socialLinks = {
    facebook: isRealSocialProfile(rawFb, 'facebook') ? rawFb : '',
    tiktok: isRealSocialProfile(rawTt, 'tiktok') ? rawTt : '',
    instagram: isRealSocialProfile(rawIg, 'instagram') ? rawIg : '',
    other: validatedOther,
  };

  const classifiedSocialProfiles = (web as any)?.extractedSocialProfiles || listing.otherDetails?.classifiedSocialProfiles;
  const socialLinksRejected = classifiedSocialProfiles
    ? classifiedSocialProfiles.filter((p: any) => p.status === 'rejected' || p.status === 'unknown')
    : listing.otherDetails?.socialLinksRejected;

  const otherDetails = {
    ...listing.otherDetails,
    websiteRelationship: relationship,
    branches: branches.length > 0 ? branches : listing.otherDetails?.branches,
    classifiedContacts: allClassifiedContacts.length > 0 ? allClassifiedContacts : listing.otherDetails?.classifiedContacts,
    classifiedSocialProfiles: classifiedSocialProfiles && classifiedSocialProfiles.length > 0 ? classifiedSocialProfiles : undefined,
    socialLinksRejected: socialLinksRejected && socialLinksRejected.length > 0 ? socialLinksRejected : undefined,
  };

  return {
    ...listing,
    emails,
    phones: mergedPhones,
    mobiles: mergedMobiles,
    websites,
    icon: isFirstParty ? web?.favicon || listing.icon : listing.icon,
    socialLinks,
    otherDetails,
    metadata: {
      ...listing.metadata,
      // Task 5: metadata.confidence is computed in Phase 4 (grounded score).
      confidence: listing.metadata?.confidence ?? evidence.verification.overallConfidence,
    },
    // Only rewrite `process` when real website evidence backs the claim and enrichable.
    process: web && isContactEnrichable
      ? `Evidence-verified via ${relationship} website (status: ${evidence.verification.status}, confidence: ${evidence.verification.overallConfidence})`
      : listing.process,
  };
}

/**
 * Re-classifies ALL phone/mobile numbers in a listing through classifyNepalPhone,
 * enforcing the strict phone taxonomy invariant:
 *
 *   canonicalDigits(all phones + mobiles) must be unique
 *   phones ∩ mobiles = ∅
 *
 * This is the FINAL safety net. Even if an earlier stage mis-routes a number,
 * this pass normalizes everything before downstream processing (Task 3 conflicts, save).
 *
 * Display policy: canonical digits determine identity; the first valid raw occurrence
 * for each canonical identity is preserved as the display string.
 */
export function normalizeListingPhones(listing: z.infer<typeof businessListingSchema>): void {
  const allRawPhones = [...(listing.phones || []), ...(listing.mobiles || [])];
  const normalizedPhones: string[] = [];
  const normalizedMobiles: string[] = [];
  const seenDigits = new Set<string>();

  for (const raw of allRawPhones) {
    const classified = classifyNepalPhone(raw);
    if (classified.type === 'invalid') continue; // Drop invalid
    if (seenDigits.has(classified.digits)) continue; // Cross-array dedup by canonical identity
    seenDigits.add(classified.digits);

    const display = classified.normalized || raw.trim();
    if (classified.type === 'mobile') {
      normalizedMobiles.push(display);
    } else {
      // landline | international
      normalizedPhones.push(display);
    }
  }

  listing.phones = normalizedPhones;
  listing.mobiles = normalizedMobiles;
}

function buildSupervisorPrompt(
  query: string,
  location: string | undefined,
  candidates: Array<UnifiedSearchResult>,
  extractions: Array<{ url: string; content: string; favicon: string; success: boolean }>,
  verifiedEvidence?: Array<VerifiedBusinessEvidence>
): string {
  const candidateList = candidates
    .map((c, i) => {
      if (c.source === 'google_maps') {
        const hasSite = c.domain && !c.domain.includes('google.com');
        return `${c.rank ?? i + 1}. ${c.title} [Google Maps Verified Business]
   Address: ${c.address || location || 'N/A'}
   Phone: ${c.phoneNumber || 'N/A'}
   Rating: ${c.rating ? `${c.rating} (${c.ratingCount || 0} reviews)` : 'N/A'}
   Category: ${c.businessType || 'Business'}
   Website: ${hasSite ? c.url : 'None (Local Tradesman / Storefront)'}
   GPS: ${c.latitude && c.longitude ? `${c.latitude}, ${c.longitude}` : 'N/A'}`;
      }
      return `${c.rank ?? i + 1}. ${c.title}${c.domain ? ` [${c.domain}]` : ''}\n   URL: ${c.url}\n   Snippet: ${c.description}`;
    })
    .join('\n\n');

  const deepVerified = verifiedEvidence && verifiedEvidence.length > 0;

  // Evidence-first mode: authoritative verified blocks replace raw page dumps.
  // The supervisor gets structured contact fields to use EXACTLY, plus a small
  // page-context summary (≤5k per candidate) for description/summary purposes.
  let evidenceBlocks = '';
  let extractionBlocks = extractions
    .filter((e) => e.success && e.content)
    .map(
      (e) =>
        `--- EXTRACTION from ${e.url} ---\nFavicon: ${e.favicon}\n\n${e.content.slice(0, 30000)}\n--- END ---`
    )
    .join('\n\n');

  if (deepVerified && verifiedEvidence) {
    evidenceBlocks = verifiedEvidence
      .map((ev, i) => {
        const c = ev.candidate;
        const w = ev.websiteEvidence;
        const lines = [
          `--- VERIFIED EVIDENCE ${i + 1}: ${c.name} ---`,
          `Identity (Google Maps authority — never overwrite): address=${c.location || 'N/A'}; phone=${c.phone || 'N/A'}; gps=${c.coordinates ? `${c.coordinates.lat}, ${c.coordinates.lng}` : 'N/A'}; rating=${c.rating ?? 'N/A'} (${c.ratingCount ?? 0} reviews); placeId=${c.sources.googleMaps?.placeId || 'N/A'}; category=${c.category || 'N/A'}`,
          `Official website: ${c.website || 'NONE'}`,
          `Verification: status=${ev.verification.status}; confidence=${ev.verification.overallConfidence}`,
        ];
        if (w) {
          lines.push(
            `EVIDENCE-BACKED CONTACT FIELDS (use these EXACTLY — do not invent or merge other values):
  emails: ${JSON.stringify(w.extractedEmails)}
  phones: ${JSON.stringify(w.extractedPhones)}
  mobiles: ${JSON.stringify(w.extractedMobiles)}
  socialLinks: ${JSON.stringify(w.extractedSocialLinks)}
  services: ${JSON.stringify(w.extractedServices)}
  hours: ${w.extractedHours || 'N/A'}
  favicon: ${w.favicon || 'N/A'}`
          );
          if (w.rawContentSummary) {
            lines.push(`PAGE CONTEXT (for otherDetails summary ONLY):\n${w.rawContentSummary}`);
          }
        } else {
          lines.push(
            `NO WEBSITE EVIDENCE — leave emails and socialLinks empty; the ONLY supported phone is the Maps phone above.`
          );
        }
        lines.push(`--- END EVIDENCE ${i + 1} ---`);
        return lines.join('\n');
      })
      .join('\n\n');

    // Raw content is context-only in evidence mode: much smaller slices.
    extractionBlocks = extractions
      .filter((e) => e.success && e.content)
      .map((e) => `--- RAW CONTEXT from ${e.url} (for summary ONLY — not a contact source) ---\n${e.content.slice(0, 5000)}\n--- END ---`)
      .join('\n\n');
  }

  return `You are an expert business data research supervisor. Your job is to cross-examine Google Maps verified places and extracted website content to produce accurate, structured business listings.

USER QUERY: "${query}"${location ? ` in ${location}` : ''}

SEARCH RESULTS & VERIFIED PLACES:

${candidateList}

${evidenceBlocks ? `\nVERIFIED EVIDENCE (authoritative — deterministic extraction):\n\n${evidenceBlocks}\n` : ''}

EXTRACTED WEBSITE CONTENT (from Tavily):

${extractionBlocks || 'No extracted content available.'}

CRITICAL EVIDENCE RULES (structured contact fields):
${deepVerified ? `- The VERIFIED EVIDENCE blocks above are AUTHORITATIVE for emails, phones, mobiles, socialLinks, and websites. Use those EXACT values. NEVER invent, guess, or merge contact values from raw page context.\n- Raw page context is for otherDetails summary ONLY — never a contact source.` : `- Only include emails/phones/mobiles/socialLinks that are explicitly present in the content above. If none are present, leave them empty.`}
- Leave every field empty when no supported value exists. An empty field is always correct; an invented value is always wrong.
- Never modify Google Maps identity fields (address, Maps phone, GPS, rating, ratingCount, placeId).

YOUR TASK:
1. Synthesize all verified businesses. Note that local tradesmen or storefronts from Google Maps may NOT have websites — ALWAYS include them with verified phone numbers, address, and ratings!
2. For each business, extract/populate the following fields:
   - name: Official business name
   - location: Street address, area, city (e.g. "Durbar Marg, Kathmandu")
   - emails: Array of email addresses found on the website (or empty)
   - phones: Array of landline numbers (e.g. "+977-1-4240520")
   - mobiles: Array of mobile numbers (e.g. "+977-9801234567" or "982-9469962")
   - websites: Array of official website URLs (empty array if no website)
   - icon: Favicon URL from extracted content (or empty)
   - socialLinks: { facebook, tiktok, instagram, other: {} }
   - otherDetails: { address, rating, ratingCount, category, description, ... }
   - gpsCoordinates: { latitude, longitude } if available from Google Maps
   - rating: numeric rating (e.g. 4.8)
   - ratingCount: review count
   - businessType: category or trade (e.g. "Plumber", "Hotel")
   - placeId: place identifier if provided
   - metadata: { source: "google_maps" or URL, extractedAt: current ISO timestamp, confidence: 0.0-1.0 }
   - process: How you verified this listing (e.g. "Verified via Google Maps Places" or "Verified via official website")
   - links: All relevant URLs discovered

3. Deduplicate: If the same business appears in both Google Maps and Web search, merge the data.
4. Filter: Remove results that are clearly aggregators, blogs, or directory portals (e.g. booking.com, tripadvisor, yellowpages).
5. Confidence scoring:
   - 0.9-1.0: Verified Google Maps business or official website
   - 0.7-0.8: Found in search results with some extracted data
   - 0.5-0.6: Found in search results only, limited data
   - Below 0.5: Uncertain or incomplete data

6. Return the listings as a JSON object matching the output schema exactly. No markdown, no explanation — just valid JSON.`;
}

function buildFallbackListing(
  candidate: UnifiedSearchResult,
  extractions: Array<{ url: string; content: string; favicon: string; success: boolean }>,
  verifiedEvidence?: VerifiedBusinessEvidence[],
  fallbackLocation?: string,
  runStartedAt?: string
): z.infer<typeof businessListingSchema> {
  const isMap = candidate.source === 'google_maps';
  const hasSite = candidate.domain && !candidate.domain.includes('google.com');

  // Match pre-extracted verified evidence for this candidate
  let matchingEvidence: VerifiedBusinessEvidence | undefined;
  if (verifiedEvidence && verifiedEvidence.length > 0) {
    const candidateDomain =
      candidate.domain && !candidate.domain.includes('google.com')
        ? domainFromUrlOrHost(candidate.url)
        : '';
    const candidatePhone = candidate.phoneNumber ? normalizePhoneDigits(candidate.phoneNumber) : '';
    const candidateNormName = normalizeNameKey(candidate.title || '');

    matchingEvidence = verifiedEvidence.find((ev) => {
      const c = ev.candidate;
      if (candidateDomain && c.website && domainFromUrlOrHost(c.website) === candidateDomain) return true;
      if (candidatePhone && c.phone && normalizePhoneDigits(c.phone) === candidatePhone) return true;
      const evNormName = normalizeNameKey(c.name || '');
      if (candidateNormName && evNormName && (candidateNormName.includes(evNormName) || evNormName.includes(candidateNormName))) {
        return true;
      }
      return false;
    });
  }

  const relationship = matchingEvidence?.websiteRelationship || 'unverified';
  const candidateNameKey = matchingEvidence ? normalizeNameKey(matchingEvidence.candidate.name || '') : '';
  const fallbackTitleKey = normalizeNameKey(candidate.title || '');
  const namesAlign = Boolean(
    !matchingEvidence ||
      (candidateNameKey &&
        fallbackTitleKey &&
        (fallbackTitleKey.includes(candidateNameKey) || candidateNameKey.includes(fallbackTitleKey)))
  );

  const isFirstParty = relationship === 'first_party' && namesAlign;
  const isCorporateParent = relationship === 'corporate_parent' && namesAlign;

  const mapsPhoneDigits = normalizePhoneDigits(candidate.phoneNumber || matchingEvidence?.candidate.phone || '');

  const webEvidence = isFirstParty ? matchingEvidence?.websiteEvidence : undefined;
  const extraction = extractions.find((e) => e.url === candidate.url && e.success);
  const content = extraction?.content || '';

  // Emails: first_party ONLY (corporate_parent emails BLOCKED)
  const emailCandidates = isFirstParty && webEvidence?.extractedEmails?.length
    ? webEvidence.extractedEmails
    : isFirstParty
    ? extractEmails(content)
    : [];
  const emails = [...new Set(emailCandidates.map(sanitizeEmailString).filter((e) => /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(e)))];

  // Phones & Mobiles: strict separation (phones = landlines + non-mobile intl; mobiles = 97/98)
  const mergedPhones: string[] = [];
  const mergedMobiles: string[] = [];
  const seenDigits = new Set<string>();

  const routePhone = (p?: string) => {
    if (!p) return;
    const classified = classifyNepalPhone(p);
    if (classified.type === 'invalid') return;
    if (seenDigits.has(classified.digits)) return;
    seenDigits.add(classified.digits);

    const display = classified.normalized || p.trim();
    if (classified.type === 'mobile') {
      mergedMobiles.push(display);
    } else {
      mergedPhones.push(display);
    }
  };

  if (candidate.phoneNumber) routePhone(candidate.phoneNumber);
  if (matchingEvidence?.candidate.phone) routePhone(matchingEvidence.candidate.phone);
  if (isFirstParty) {
    for (const m of webEvidence?.extractedMobiles || []) routePhone(m);
    for (const p of webEvidence?.extractedPhones || []) routePhone(p);
  } else if (isCorporateParent && mapsPhoneDigits && matchingEvidence?.websiteEvidence) {
    for (const m of matchingEvidence.websiteEvidence.extractedMobiles || []) {
      if (normalizePhoneDigits(m) === mapsPhoneDigits) routePhone(m);
    }
    for (const p of matchingEvidence.websiteEvidence.extractedPhones || []) {
      if (normalizePhoneDigits(p) === mapsPhoneDigits) routePhone(p);
    }
  }
  if (mergedPhones.length === 0 && mergedMobiles.length === 0 && isFirstParty) {
    for (const m of extractMobiles(content)) routePhone(m);
    for (const p of extractPhones(content)) routePhone(p);
  }

  // Social Links: first_party ONLY
  const fallbackSocials = isFirstParty
    ? extractSocialLinks(content, { businessName: candidate.title, websiteDomain: candidate.url })
    : { facebook: '', instagram: '', tiktok: '', other: {} };
  const rawFb = (isFirstParty ? webEvidence?.extractedSocialLinks?.facebook : '') || fallbackSocials.facebook || '';
  const rawTt = (isFirstParty ? webEvidence?.extractedSocialLinks?.tiktok : '') || fallbackSocials.tiktok || '';
  const rawIg = (isFirstParty ? webEvidence?.extractedSocialLinks?.instagram : '') || fallbackSocials.instagram || '';

  const otherSources = { ...(fallbackSocials.other || {}), ...(isFirstParty ? webEvidence?.extractedSocialLinks?.other || {} : {}) };
  const validatedOther: Record<string, string> = {};
  for (const [k, v] of Object.entries(otherSources)) {
    if (v && isRealSocialProfile(v, k)) {
      validatedOther[k] = v;
    }
  }

  const socialLinks = {
    facebook: isRealSocialProfile(rawFb, 'facebook') ? rawFb : '',
    tiktok: isRealSocialProfile(rawTt, 'tiktok') ? rawTt : '',
    instagram: isRealSocialProfile(rawIg, 'instagram') ? rawIg : '',
    other: validatedOther,
  };

  const finalLocation =
    candidate.address ||
    matchingEvidence?.candidate.location ||
    fallbackLocation ||
    'Kathmandu, Nepal';

  const websites: string[] = [];
  if (candidate.url && hasSite) websites.push(candidate.url);
  else if (matchingEvidence?.candidate.website) websites.push(matchingEvidence.candidate.website);
  else if (webEvidence?.url) websites.push(webEvidence.url);

  const fallbackSocialProfiles = (webEvidence as any)?.extractedSocialProfiles ||
    (isFirstParty ? classifyAllSocialProfiles(content, { businessName: candidate.title, websiteDomain: candidate.url }) : []);
  const fallbackSocialsRejected = fallbackSocialProfiles.filter(
    (p: any) => p.status === 'rejected' || p.status === 'unknown'
  );

  return {
    name: candidate.title,
    location: finalLocation,
    emails,
    phones: mergedPhones,
    mobiles: mergedMobiles,
    websites,
    icon: webEvidence?.favicon || extraction?.favicon || '',
    socialLinks,
    otherDetails: {
      snippet: candidate.description,
      address: finalLocation,
      rating: candidate.rating,
      ratingCount: candidate.ratingCount,
      businessType: candidate.businessType,
      placeId: candidate.placeId || matchingEvidence?.candidate.sources.googleMaps?.placeId,
      services: webEvidence?.extractedServices || [],
      hours: webEvidence?.extractedHours || '',
      classifiedSocialProfiles: fallbackSocialProfiles.length > 0 ? fallbackSocialProfiles : undefined,
      socialLinksRejected: fallbackSocialsRejected.length > 0 ? fallbackSocialsRejected : undefined,
    },
    gpsCoordinates:
      candidate.latitude !== undefined && candidate.longitude !== undefined
        ? { latitude: candidate.latitude, longitude: candidate.longitude }
        : matchingEvidence?.candidate.coordinates
        ? {
            latitude: matchingEvidence.candidate.coordinates.lat,
            longitude: matchingEvidence.candidate.coordinates.lng,
          }
        : undefined,
    rating: candidate.rating,
    ratingCount: candidate.ratingCount,
    businessType: candidate.businessType,
    placeId: candidate.placeId || matchingEvidence?.candidate.sources.googleMaps?.placeId,
    metadata: {
      source: isMap ? 'google_maps' : candidate.url,
      extractedAt: new Date().toISOString(),
      runStartedAt: runStartedAt ?? new Date().toISOString(),
      confidence: 0, // Will be grounded by Phase 4 computeConfidenceBreakdown
    },
    process: webEvidence
      ? 'Verified via Google Maps Places & Website extraction'
      : isMap
      ? 'Verified via Google Maps Places (Direct fallback)'
      : extraction
      ? 'Auto-extracted from website content (fallback mode — agent unavailable)'
      : 'From search snippet only (fallback mode — agent unavailable)',
    links: websites,
  };
}

export const researchWorkflow = createWorkflow({
  id: 'research-workflow',
  inputSchema: z.object({
    query: z.string().describe('The search query (e.g. "hotels in Kathmandu")'),
    location: z.string().optional().describe('Optional location constraint'),
    autoApprove: z.boolean().default(true).describe('Skip human review step for headless execution'),
    agentId: z.string().optional().default('gemma-supervisor-agent').describe('Agent to use for synthesis'),
    targetCandidates: z.number().optional().describe('Target number of usable candidates'),
    maxMapsPages: z.number().optional().describe('Maximum Google Maps pages to query (default 5)'),
    maxPages: z.number().optional().describe('Maximum search pages to query'),
    maxDeepVerifyCandidates: z
      .number()
      .optional()
      .describe('Maximum candidates to deep-verify with Tavily (default 3 — demo-safe cost guard)'),
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
