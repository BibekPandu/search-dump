/**
 * Research discovery orchestration service.
 * Manages hybrid Google Maps + Web fallback search, category intent expansion,
 * geographic evaluation, candidate classification, and website discovery gate.
 */
import {
  type SerperPlaceResult,
  backfillMissingMapsPhones,
} from '@/services/external/serper-places.service';
import { selectFirstPartyWebsiteUrl } from '@/services/discovery/website-search-ranker.service';
import {
  searchWithFallback,
  normalizeUrl,
  extractDomain,
  withTimeout,
  normalizeCategoryIntent,
  expandCategoryQueries,
  type UnifiedSearchResult,
  type CategoryIntent,
  type ExpandedQuery,
} from '@/services/discovery/search-fallback.service';
import {
  resolveWebsiteDiscoveryBudget,
  formatWebsiteDiscoveryBudgetLog,
  type WebsiteDiscoveryBudget,
} from '@/config/website-discovery.config';
import {
  runWebsiteDiscoveryGate,
  selectPhoneFromOwnDomain,
  buildSecondChanceQuery,
  getDiscoveryTelemetryCounters,
  type DiscoveryLookupResult,
  type WebsiteDiscoveryArtifact,
} from '@/services/discovery/website-discovery-gate.service';
import {
  saveStageOutput,
  startRunSession,
  getActiveRunSession,
  getRunSessionId,
} from '@/services/storage/output-storage.service';
import {
  filterSearchResults,
  checkCategoryRelevance,
} from '@/services/resolution/candidate-classifier.service';
import { evaluateGeographicLocality } from '@/services/resolution/geographic-evaluator.service';
import { geocodeLocality } from '@/services/resolution/geocoding.service';
import { validateCandidate } from '@/services/resolution/candidate-validation.service';
import { resetLlmMultiBusinessCallCount } from '@/services/business-extractor.service';
import {
  rankWebsiteLookupTargets,
  isUsableOfficialWebsite,
} from '@/services/resolution/entity-resolution.service';
import {
  buildResearchCandidates,
  toUnifiedCandidates,
} from '@/services/resolution/research-candidate.service';
import { paginateMapsDiscovery } from '@/services/discovery/maps-discovery.service';
import type {
  ResearchReport,
  ResearchCandidate,
  ResearchDecision,
  ExcludedSummaryItem,
  StoppedReason,
  DiscoveryMetrics,
} from '@/types/research-candidate';
import type { RunResearchDiscoveryInput } from '@/types/research-input';

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
    targetCandidates: inputTargetCandidates,
    maxPages = 5,
    maxMapsPages = 5,
    websiteDiscoveryMode,
    maxWebsiteDiscoveryLookups,
  } = inputData;

  const explicitTarget = inputTargetCandidates;
  const targetCandidates = explicitTarget !== undefined ? explicitTarget : 10;
  const overfetchCap =
    explicitTarget !== undefined
      ? Math.max(Math.ceil(explicitTarget * 2.0), explicitTarget + 5)
      : undefined;

  console.log(
    `[Workflow:Step1] Research Agent initiating hybrid discovery for "${query}" (target: ${explicitTarget ?? 'unbounded (default 10)'}, overfetchCap: ${overfetchCap ?? 'none'}, maxMapsPages: ${maxMapsPages}, maxPages: ${maxPages})`
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
  let geographyOutsideCandidates = 0;
  let geographyAmbiguousCandidates = 0;

  resetLlmMultiBusinessCallCount();
  const dynamicCluster = location ? await geocodeLocality(location) : null;

  // ========================================================================
  // Phase 0: Google Maps First (Multi-Page Bounded Discovery with Safeguards)
  // ========================================================================
  console.log(
    `[Workflow:Step1] Phase 0: Initiating Maps-first bounded discovery for "${query}" (${expandedQueries.length} query variations, target: ${explicitTarget ?? 10}, overfetchCap: ${overfetchCap ?? 'none'}, maxMapsPages: ${maxMapsPages})...`
  );
  try {
    for (const eq of expandedQueries) {
      if (overfetchCap !== undefined && rawPlaces.length >= overfetchCap) break;
      if (overfetchCap === undefined && currentResearchCandidates.length >= targetCandidates) break;

      const paginationRemaining =
        overfetchCap !== undefined
          ? Math.max(overfetchCap - rawPlaces.length, 1)
          : Math.max(targetCandidates - currentResearchCandidates.length, 1);

      const mapsDiscovery = await paginateMapsDiscovery({
        query: eq.query,
        location,
        targetCandidates: paginationRemaining,
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
          // Phase 8a Task 8a.3 & Phase 8h: Layered Geographic Precision with Dynamic Geocoding
          const geoDecision = location
            ? evaluateGeographicLocality(
                {
                  title: place.title,
                  address: place.address,
                  latitude: place.latitude,
                  longitude: place.longitude,
                },
                location,
                dynamicCluster
              )
            : { status: 'inside' as const, reason: 'No location filter provided', matchedRequestedLocality: true, evidence: { requestedLocation: '' } };

          if (geoDecision.status === 'outside') {
            geographyOutsideCandidates++;
            excludedCount++;
            excludedSummary.push({
              title: place.title,
              url: place.website || (place.placeId ? `https://maps.google.com/?cid=${place.placeId}` : `google_maps:${encodeURIComponent(place.title)}`),
              domain: place.website ? extractDomain(place.website) : 'maps.google.com',
              classification: 'irrelevant',
              reason: `Geographic Exclusion: ${geoDecision.reason}`,
            });
            allDecisions.push({
              url: place.website || (place.placeId ? `https://maps.google.com/?cid=${place.placeId}` : `google_maps:${encodeURIComponent(place.title)}`),
              domain: place.website ? extractDomain(place.website) : 'maps.google.com',
              title: place.title,
              classification: 'irrelevant',
              confidence: 1.0,
              reason: `Geographic Exclusion: ${geoDecision.reason}`,
              source: 'deterministic',
            });
          } else {
            if (geoDecision.status === 'ambiguous') {
              geographyAmbiguousCandidates++;
            }
            relevantCandidates++;
            rawPlaces.push(place);
          }
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

    // Phase 8h (W2-08): Bounded pre-enrichment places buffer
    if (overfetchCap !== undefined && rawPlaces.length > overfetchCap) {
      console.log(
        `[Workflow:Step1] Enforcing W2-08 overfetch buffer: bounding ${rawPlaces.length} geo-filtered places to ${overfetchCap} (target: ${explicitTarget}, buffer: 2x)`
      );
      rawPlaces = rawPlaces.slice(0, overfetchCap);
      const boundedBuild = buildResearchCandidates({
        places: rawPlaces,
        webUsable: [],
        defaultLocation: location,
      });
      currentResearchCandidates = boundedBuild.candidates;
      usableCount = currentResearchCandidates.length;
    }

    // Phase 8e: Bounded Maps phone backfill for places lacking phone numbers
    const phonesRecovered = await backfillMissingMapsPhones(rawPlaces, location, 20);
    if (phonesRecovered > 0) {
      const updatedBuild = buildResearchCandidates({
        places: rawPlaces,
        webUsable: [],
        defaultLocation: location,
      });
      currentResearchCandidates = updatedBuild.candidates;
      usableCount = currentResearchCandidates.length;
    }

    // Targeted Website & Phone Lookups for evidence-ranked places lacking websites or phones
    // Phase 7a Task 2: the lookup budget is an explicit, mode-driven, PER-RUN policy
    // (previously derived from targetCandidates as Math.max(targetCandidates, 10)).
    // Phase 7a Task 3: EVERY eligible candidate is evaluated and receives an explicit
    // discovery state — the budget decides only who gets a lookup. This closes the
    // Task 1 finding that budget-skipped candidates vanished without any signal.
    const placesNeedingEnrichment = rawPlaces.filter(
      (p) =>
        !p.website ||
        p.website.trim().length === 0 ||
        !isUsableOfficialWebsite(p.website, p.title) ||
        !p.phoneNumber ||
        p.phoneNumber.trim().length === 0
    );
    const websiteDiscoveryBudget: WebsiteDiscoveryBudget = resolveWebsiteDiscoveryBudget({
      eligibleCount: placesNeedingEnrichment.length,
      explicitCap: maxWebsiteDiscoveryLookups,
      mode: websiteDiscoveryMode,
    });
    console.log(
      `[Workflow:Step1] ${formatWebsiteDiscoveryBudgetLog(websiteDiscoveryBudget, placesNeedingEnrichment.length)}`
    );

    // Shared search+projection for Pass 1 and Task 5 refined queries. Phone
    // attribution (Task 4.5) happens AFTER selection in selectPhone — search
    // itself is a pure projection.
    const searchAndProject = async (
      place: SerperPlaceResult,
      query: string
    ): Promise<DiscoveryLookupResult> => {
      const lookupRes = await searchWithFallback(query, undefined, 5, 1);
      if (!lookupRes.results || lookupRes.results.length === 0) {
        return { queries: [query], results: [] };
      }
      return {
        queries: [query],
        results: lookupRes.results.map((r) => ({
          url: r.url,
          title: r.title,
          description: r.description,
          extraSnippets: r.extraSnippets,
        })),
      };
    };

    const discoveryGate = await runWebsiteDiscoveryGate({
      places: placesNeedingEnrichment,
      lookupBudget: websiteDiscoveryBudget.lookupBudget,
      rank: (rankTargets) => rankWebsiteLookupTargets(rankTargets),
      // Phase 7a Task 4: deterministic zero-HTTP ranking replaces the legacy
      // first-pick (`results.find(...)`). isUsableOfficialWebsite is injected as the
      // hard gate, so ranking can never resurrect a URL the safeguards reject.
      selectFirstPartyUrl: (place, results) => {
        const selection = selectFirstPartyWebsiteUrl({
          results,
          businessName: place.title,
          location: location || place.address,
          categoryContext: [query, place.category, place.type, place.types].flat().filter(Boolean) as string[],
          isUsable: (candidate) =>
            isUsableOfficialWebsite(
              candidate.url,
              place.title,
              place.category || place.type,
              candidate.title
            ),
        });
        if (selection.ranked.length > 0) {
          console.log(`[Workflow:Step1] Phase 0 ranker: ${place.title} → ${selection.reason}`);
        }
        return { url: selection.url, reason: selection.reason };
      },
      // Phase 7a Task 4.5 — Snippet Phone Attribution Guard: a snippet may
      // contribute a phone ONLY from the business's own domain (the ranked
      // first-party selection, or the Maps website when no discovery was needed).
      // The attribution target must itself be an acceptable official domain, so a
      // Maps-provided social/directory URL can never become a phone source.
      selectPhone: ({ place, results, businessDomain }) => {
        if (!businessDomain) return undefined;
        if (
          !isUsableOfficialWebsite(
            `https://${businessDomain}`,
            place.title,
            place.category || place.type
          )
        ) {
          return undefined;
        }
        const attributedPhone = selectPhoneFromOwnDomain(results, businessDomain);
        if (attributedPhone) {
          console.log(
            `[Workflow:Step1] Phase 0: Attributed phone for "${place.title}" from its own domain (${businessDomain}): ${attributedPhone}`
          );
        }
        return attributedPhone;
      },
      lookup: (place) =>
        searchAndProject(place, `${place.title} ${location || place.address || ''}`.trim()),
      // Task 5: bounded second chance — at most ONE refined query per candidate,
      // fired by the gate ONLY when Pass 1 yields no first-party URL.
      refinedLookup: (place, query) => searchAndProject(place, query),
      secondChanceQuery: (candidate) =>
        buildSecondChanceQuery(candidate, {
          runCategory: categoryIntent.normalized,
          location: location || candidate.address,
        }),
      onGroupEvaluated: (record) => {
        if (record.state === 'DISCOVERY_FOUND_FIRST_PARTY') {
          console.log(
            `[Workflow:Step1] Phase 0: Discovered verified official website for "${record.title}": ${record.selectedUrl}`
          );
        } else if (record.state === 'DISCOVERY_FOUND_ONLY_THIRD_PARTY') {
          console.log(
            `[Workflow:Step1] Phase 0: "${record.title}" — ${record.resultsReviewed} results reviewed, all third-party; no first-party website attached.`
          );
        } else if (record.error) {
          console.warn(
            `[Workflow:Step1] Phase 0: Targeted lookup failed for "${record.title}": ${record.error}`
          );
        }
      },
    });

    console.log(
      `[Workflow:Step1] Phase 0 discovery states: ${discoveryGate.groupsEvaluated} evaluated, ` +
        `${discoveryGate.groupsLookedUp} looked up, ${discoveryGate.groupsNotAttempted} not attempted ` +
        `(${discoveryGate.notAttemptedPhoneOnly} phone-only skipped, ${discoveryGate.duplicatesMerged} duplicates merged) — ` +
        `first-party: ${discoveryGate.statesApplied.DISCOVERY_FOUND_FIRST_PARTY}, ` +
        `third-party-only: ${discoveryGate.statesApplied.DISCOVERY_FOUND_ONLY_THIRD_PARTY}, ` +
        `exhausted: ${discoveryGate.statesApplied.DISCOVERY_EXHAUSTED_NO_FIRST_PARTY}, ` +
        `not-attempted: ${discoveryGate.statesApplied.DISCOVERY_NOT_ATTEMPTED_BUDGET}`
    );

    // Phase 7b Task 13: Stage 0 Website Discovery Audit Envelope
    const counters = getDiscoveryTelemetryCounters(discoveryGate);
    const discoveryArtifact: WebsiteDiscoveryArtifact = {
      runId: getActiveRunSession()?.runId ?? getRunSessionId(query, location),
      generatedAt: new Date().toISOString(),
      counters,
      statesApplied: discoveryGate.statesApplied,
      records: discoveryGate.records,
      gateConfig: {
        mode: websiteDiscoveryBudget.mode,
        maxLookups: websiteDiscoveryBudget.lookupBudget,
        currentLookupCount: discoveryGate.groupsLookedUp,
        resolvedAtRuntime: true,
      },
      _provisional: true,
    };
    saveStageOutput('website-discovery', '0-website-discovery.json', discoveryArtifact, query);

    // Rebuild with newly-discovered official websites & phones. This now always runs:
    // every candidate carries an explicit discovery state, including budget skips.
    const rebuilt = buildResearchCandidates({
      places: rawPlaces,
      webUsable: [],
      defaultLocation: location,
    });
    currentResearchCandidates = rebuilt.candidates;
    usableCount = currentResearchCandidates.length;

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
  const searchWorker = mastra?.getAgentById?.('search-worker-agent');

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
            const validation = validateCandidate(
              {
                name: r.title,
                location: r.address || r.description || '',
                website: r.url,
                url: r.url,
                title: r.title,
              } as any,
              {
                targetQuery: query,
                targetLocation: location,
                categoryIntent,
                dynamicCluster,
              }
            );

            if (validation.status === 'excluded') {
              geographyOutsideCandidates++;
              excludedCount++;
              excludedSummary.push({
                title: r.title,
                url: r.url,
                domain: r.domain,
                classification: 'irrelevant',
                reason: validation.reason,
              });
              allDecisions.push({
                url: r.url,
                domain: r.domain,
                title: r.title,
                classification: 'irrelevant',
                confidence: 1.0,
                reason: validation.reason,
                source: 'deterministic',
              });
              continue;
            }

            if (validation.status === 'ambiguous') {
              geographyAmbiguousCandidates++;
            }

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
    geographyOutsideCandidates,
    geographyAmbiguousCandidates,
    uniqueEntities: currentResearchCandidates.length,
  };

  const researchReport: ResearchReport = {
    query,
    location,
    pagesSearched,
    targetCandidates: explicitTarget,
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
