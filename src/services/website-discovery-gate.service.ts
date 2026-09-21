import type { SerperPlaceResult } from './serper-places.service';
import {
  domainFromUrlOrHost,
  detectBusinessCategory,
  isUsableOfficialWebsite,
} from './entity-resolution.service';
import { extractPhones, extractMobiles, classifySocialProfile } from './business-extractor.service';

// ============================================================================
// Website Discovery Gate — Universal Candidate Evaluation (Phase 7a Task 3)
// ============================================================================
// Problem closed (Task 1 forensic trace — Ever Vision School, Satungal):
//   Candidates that lost the lookup budget race were dropped with NO record.
//   "not searched" was indistinguishable from "searched and not found".
//
// This module makes evaluation UNIVERSAL and the budget a pure LOOKUP decision:
//   - Every Maps candidate that needs enrichment is EVALUATED and receives an
//     explicit discovery state.
//   - The budget decides only which candidates receive an actual lookup.
//   - Duplicate appearances of the same business (same placeId/cid across
//     expanded queries and Maps pages) collapse into ONE lookup and inherit the
//     same outcome — no duplicate searches, no contradictory states.
//
// Purity contract: imports are type-only or pure functions (no I/O, no network,
// no module side effects). Search, first-party selection and phone attribution
// are injected/parameterised by the caller, so this unit is fully offline-testable
// and cannot introduce an import cycle.
// Task 10 (Phase 7b) formalizes `DiscoveryState` as a Zod enum with a
// sum-invariant test.

export {
  DISCOVERY_STATES,
  discoveryStateEnum,
  discoveryProvenanceSchema,
  type DiscoveryState,
  type DiscoveryProvenance,
} from './discovery-state.service';
import {
  DISCOVERY_STATES,
  type DiscoveryState,
} from './discovery-state.service';
import type { WebsiteDiscoveryMode } from '../config/website-discovery.config';

/** Fresh zeroed counter map (never a shared mutable singleton). */
export function emptyDiscoveryStateCounts(): Record<DiscoveryState, number> {
  return {
    MAPS_HAS_WEBSITE: 0,
    DISCOVERY_FOUND_FIRST_PARTY: 0,
    DISCOVERY_FOUND_ONLY_THIRD_PARTY: 0,
    DISCOVERY_EXHAUSTED_NO_FIRST_PARTY: 0,
    DISCOVERY_NOT_ATTEMPTED_BUDGET: 0,
  };
}

/**
 * Phase 7b Task 10 — Exhaustive State Machine Invariant Validator.
 * Enforces: sum(statesApplied[state] for all 5 states) === totalEvaluated.
 * Pure function: returns validity, calculated sum, and discrepancy delta.
 */
export function validateDiscoveryStateInvariant(
  statesApplied: Record<DiscoveryState, number>,
  totalEvaluated: number
): { valid: boolean; sum: number; delta: number } {
  const sum = DISCOVERY_STATES.reduce((acc, state) => acc + (statesApplied[state] || 0), 0);
  return {
    valid: sum === totalEvaluated,
    sum,
    delta: sum - totalEvaluated,
  };
}

export interface DiscoverySearchResult {
  url: string;
  title?: string;
  description?: string;
  extraSnippets?: string[];
}

export interface DiscoveryLookupResult {
  /** Every query actually executed for this candidate (Task 5 appends a 2nd). */
  queries: string[];
  results: DiscoverySearchResult[];
}

export interface SelectFirstPartyUrlResult {
  url?: string;
  reason?: string;
}

/** Per-candidate provenance record. Feeds Task 8 telemetry and Task 10 states. */
export interface DiscoveryGroupRecord {
  /** Stable group key (placeId -> cid -> normalized title|address). */
  key: string;
  title: string;
  state: DiscoveryState;
  /** True only when a search was actually executed for this candidate. */
  searchAttempted: boolean;
  queries: string[];
  resultsReviewed: number;
  /** Phase 7b Task 8: URLs reviewed from SERP results (capped at top 20 per candidate). */
  candidateUrlsReviewed: string[];
  selectedUrl?: string;
  /** Phase 7b Task 8: deterministic selection reason from zero-HTTP ranker. */
  selectionReason?: string;
  /** Number of duplicate place objects folded into this group (>0 = deduped). */
  duplicatesMerged: number;
  /** Populated when the injected lookup threw. */
  error?: string;
  /** Task 4.5: snippet phone attributed to this candidate, if any. */
  phone?: string;
  /** Task 4.5: the business domain the attributed phone originated from. */
  phoneSourceDomain?: string;
  /** Task 5: true when a bounded second-chance query was executed. */
  secondChanceAttempted?: boolean;
  /** Discovered social media profiles from candidateUrlsReviewed (FB, IG, TikTok, LinkedIn) */
  discoveredSocials?: {
    facebook?: string;
    instagram?: string;
    tiktok?: string;
    linkedin?: string;
    other?: Record<string, string>;
  };
}

export interface DiscoveryGateSummary {
  statesApplied: Record<DiscoveryState, number>;
  groupsEvaluated: number;
  groupsLookedUp: number;
  groupsNotAttempted: number;
  duplicatesMerged: number;
  /** Phone-only lookups skipped because the budget ran out (website already known). */
  notAttemptedPhoneOnly: number;
  records: DiscoveryGroupRecord[];
}

export interface DiscoveryQuotaCounters {
  lookupsAttempted: number;
  searchesSent: number;
  firstPartyFound: number;
  thirdPartyOnly: number;
  exhaustedNoFirstParty: number;
  notAttemptedBudget: number;
  phoneOnlyLookups: number;
}

export interface DiscoveryGateConfig {
  mode: WebsiteDiscoveryMode;
  maxLookups: number;
  currentLookupCount: number;
  resolvedAtRuntime: boolean;
}

export interface WebsiteDiscoveryArtifact {
  runId: string;
  generatedAt: string;
  counters: DiscoveryQuotaCounters;
  statesApplied: Record<DiscoveryState, number>;
  records: DiscoveryGroupRecord[];
  gateConfig?: DiscoveryGateConfig;
  /**
   * Note: statesApplied reflects PROVISIONAL discovery outcomes from Stage 0.
   * Downstream verification (Step 3) may reconcile individual listings —
   * see listing.otherDetails.reconciliationReason for divergences.
   */
  _provisional?: true;
}

/**
 * Phase 7b Task 13: Extracts telemetry counters from the Discovery Gate summary.
 * Tracks total candidates looked up, queries actually sent, and final state distribution.
 */
export function getDiscoveryTelemetryCounters(
  summary: DiscoveryGateSummary
): DiscoveryQuotaCounters {
  const searchesSent = summary.records.reduce(
    (acc, r) => acc + (r.queries ? r.queries.length : 0),
    0
  );
  return {
    lookupsAttempted: summary.groupsLookedUp,
    searchesSent,
    firstPartyFound: summary.statesApplied.DISCOVERY_FOUND_FIRST_PARTY,
    thirdPartyOnly: summary.statesApplied.DISCOVERY_FOUND_ONLY_THIRD_PARTY,
    exhaustedNoFirstParty: summary.statesApplied.DISCOVERY_EXHAUSTED_NO_FIRST_PARTY,
    notAttemptedBudget: summary.statesApplied.DISCOVERY_NOT_ATTEMPTED_BUDGET,
    phoneOnlyLookups: summary.notAttemptedPhoneOnly,
  };
}

export interface RunWebsiteDiscoveryGateParams {
  /** Every Maps candidate needing enrichment (website and/or phone missing). */
  places: SerperPlaceResult[];
  /** Per-run lookup budget from resolveWebsiteDiscoveryBudget (Task 2). */
  lookupBudget: number;
  /** Executes the search for one candidate. Injected => offline-testable. */
  lookup: (place: SerperPlaceResult) => Promise<DiscoveryLookupResult>;
  /** Selects the first-party website from the results, or undefined (Task 4/Task 8). */
  selectFirstPartyUrl?: (
    place: SerperPlaceResult,
    results: DiscoverySearchResult[]
  ) => SelectFirstPartyUrlResult | undefined;
  /**
   * Task 4.5 — Snippet Phone Attribution Guard. Called AFTER the first-party
   * selection is final, with the domain the phone must originate from (the
   * selected site, or the Maps website when no discovery was needed). Returning
   * undefined attributes nothing: directory/platform snippets can never
   * contribute a phone.
   * Fail-safe default: omitting selectPhone disables snippet-phone attribution
   * ENTIRELY — no code path restores the pre-4.5 any-snippet behavior.
   */
  selectPhone?: (params: {
    place: SerperPlaceResult;
    results: DiscoverySearchResult[];
    businessDomain: string | undefined;
  }) => string | undefined;
  /**
   * Task 5 — bounded second-chance query builder. Called ONCE per candidate and
   * ONLY when Pass 1 produced no first-party URL. Returns the deterministic
   * refined query, or undefined to skip. Requires refinedLookup to execute it.
   */
  secondChanceQuery?: (place: SerperPlaceResult) => string | undefined;
  /**
   * Task 5 — executes a refined query. Second chances never run without it.
   */
  refinedLookup?: (
    place: SerperPlaceResult,
    query: string
  ) => Promise<DiscoveryLookupResult>;
  /** Evidence ranking applied before budget allocation (default: input order). */
  rank?: (places: SerperPlaceResult[]) => SerperPlaceResult[];
  /** Called once per group after its state is final (logging/telemetry hook). */
  onGroupEvaluated?: (record: DiscoveryGroupRecord, members: SerperPlaceResult[]) => void;
}

/** Deterministic group key: placeId > cid > normalized title|address. */
export function discoveryGroupKey(place: SerperPlaceResult): string {
  if (place.placeId && place.placeId.trim().length > 0) return `placeId:${place.placeId.trim()}`;
  if (place.cid && place.cid.trim().length > 0) return `cid:${place.cid.trim()}`;
  const title = (place.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const address = (place.address || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `title:${title}|${address}`;
}

export function hasMapsWebsite(
  place: SerperPlaceResult,
  isUsable: (url: string, name?: string) => boolean = isUsableOfficialWebsite
): boolean {
  return Boolean(
    place.website &&
      place.website.trim().length > 0 &&
      isUsable(place.website, place.title)
  );
}

export function needsPhone(place: SerperPlaceResult): boolean {
  return !place.phoneNumber || place.phoneNumber.trim().length === 0;
}

/**
 * Task 4.5 — Snippet Phone Attribution Guard (domain-scoping policy).
 * Returns the first phone found in snippets that originate ONLY from the
 * business's own domain. `undefined` when the domain is unknown or none of the
 * results belong to it — which is exactly what prevents directory snippets from
 * contaminating the listing's phone fields.
 *
 * Phase 7a policy decision (stated, not accidental): when the own-domain
 * snippets contain BOTH landline and mobile numbers, the LANDLINE is attributed
 * (extractPhones runs before extractMobiles). Revisit if mobile-first
 * categories surface issues.
 */
export function selectPhoneFromOwnDomain(
  results: DiscoverySearchResult[],
  businessDomain: string | undefined
): string | undefined {
  if (!businessDomain) return undefined;
  const ownDomainResults = results.filter(
    (r) => domainFromUrlOrHost(r.url) === businessDomain
  );
  if (ownDomainResults.length === 0) return undefined;

  const snippetText = ownDomainResults
    .map((r) => `${r.title || ''} ${r.description || ''} ${(r.extraSnippets || []).join(' ')}`)
    .join('\n');
  const attributedPhones = [...extractPhones(snippetText), ...extractMobiles(snippetText)];
  return attributedPhones.length > 0 ? attributedPhones[0] : undefined;
}

// ============================================================================
// Task 5 — Bounded Second-Chance Query Generation (deterministic, Option B)
// ============================================================================
// Fires only when Pass 1 yields no first-party URL (the gate enforces this).
// Templates (exactly ONE refined query per candidate):
//   education candidate  -> "{name} {location} site:.edu.np"
//   everything else      -> "{name} {location} official"
// Education is detected two ways (either suffices):
//   (a) per-candidate: detectBusinessCategory(name, mapsCategory) === 'education'
//   (b) run-level: the run's category intent is an education category — this is
//       what rescues names like "Ever Vision" that carry no education token.

/** Closed mapping of run-level categories that imply education (Task 5, Option B). */
export const EDUCATION_RUN_CATEGORIES = new Set([
  'schools',
  'school',
  'colleges',
  'college',
  'universities',
  'university',
  'education',
  'educational',
  'institutes',
  'institute',
]);

/** True when the candidate OR the run's category is education (either suffices). */
export function isEducationCandidate(
  place: SerperPlaceResult,
  runCategory?: string
): boolean {
  if (runCategory && EDUCATION_RUN_CATEGORIES.has(runCategory.toLowerCase().trim())) {
    return true;
  }
  return detectBusinessCategory(place.title, place.category || place.type) === 'education';
}

/**
 * Builds the deterministic refined query for a candidate (max 1 per candidate).
 * Pure: no network, no randomness — identical input always yields the same query.
 */
export function buildSecondChanceQuery(
  place: SerperPlaceResult,
  options: { runCategory?: string; location?: string } = {}
): string | undefined {
  const name = (place.title || '').trim();
  if (!name) return undefined;
  const loc = (options.location || '').trim();
  const base = loc ? `${name} ${loc}` : name;
  return isEducationCandidate(place, options.runCategory)
    ? `${base} site:.edu.np`
    : `${base} official`;
}

interface DiscoveryGroup {
  key: string;
  title: string;
  members: SerperPlaceResult[];
  representative: SerperPlaceResult;
  hasWebsite: boolean;
}

/**
 * Evaluates EVERY candidate and applies an explicit discovery state to each.
 *
 * Budget semantics (Phase 7a): the budget caps LOOKUPS, never evaluation.
 * A candidate that does not receive a lookup is still recorded — as
 * DISCOVERY_NOT_ATTEMPTED_BUDGET (or MAPS_HAS_WEBSITE when only a phone lookup
 * was skipped, tracked separately as `notAttemptedPhoneOnly`).
 *
 * Never throws: a failing lookup is captured on the record as `error` and the
 * candidate degrades to DISCOVERY_EXHAUSTED_NO_FIRST_PARTY, with evaluation
 * continuing for the remaining candidates.
 */
export async function runWebsiteDiscoveryGate(
  params: RunWebsiteDiscoveryGateParams
): Promise<DiscoveryGateSummary> {
  const {
    places,
    lookupBudget,
    lookup,
    selectFirstPartyUrl,
    selectPhone,
    secondChanceQuery,
    refinedLookup,
    rank,
    onGroupEvaluated,
  } = params;

  const statesApplied = emptyDiscoveryStateCounts();
  const records: DiscoveryGroupRecord[] = [];

  // 1. Group duplicate appearances so one business = one lookup.
  const groupsByKey = new Map<string, DiscoveryGroup>();
  for (const place of places) {
    const key = discoveryGroupKey(place);
    const existing = groupsByKey.get(key);
    if (existing) {
      existing.members.push(place);
      if (!existing.hasWebsite && hasMapsWebsite(place)) existing.hasWebsite = true;
      continue;
    }
    groupsByKey.set(key, {
      key,
      title: place.title,
      members: [place],
      representative: place,
      hasWebsite: hasMapsWebsite(place),
    });
  }

  // 2. Rank representatives deterministically, then map ranking back to groups.
  const allGroups = [...groupsByKey.values()];
  const orderedRepresentatives = rank
    ? rank(allGroups.map((group) => group.representative))
    : allGroups.map((group) => group.representative);

  const orderedGroups: DiscoveryGroup[] = [];
  const seenKeys = new Set<string>();
  for (const representative of orderedRepresentatives) {
    const group = groupsByKey.get(discoveryGroupKey(representative));
    if (!group || seenKeys.has(group.key)) continue;
    seenKeys.add(group.key);
    orderedGroups.push(group);
  }
  // Defensive: a group dropped by the injected ranker is re-appended, never lost.
  for (const group of allGroups) {
    if (!seenKeys.has(group.key)) orderedGroups.push(group);
  }

  const budget = Number.isFinite(lookupBudget) ? Math.max(0, Math.floor(lookupBudget)) : 0;
  let groupsLookedUp = 0;
  let groupsNotAttempted = 0;
  let duplicatesMerged = 0;
  let notAttemptedPhoneOnly = 0;

  // 3. Evaluate every group; the budget decides only who gets a lookup.
  for (const group of orderedGroups) {
    const representative = group.representative;
    const duplicates = group.members.length - 1;
    duplicatesMerged += duplicates;

    const record: DiscoveryGroupRecord = {
      key: group.key,
      title: group.title,
      state: 'DISCOVERY_NOT_ATTEMPTED_BUDGET',
      searchAttempted: false,
      queries: [],
      resultsReviewed: 0,
      candidateUrlsReviewed: [],
      duplicatesMerged: duplicates,
    };

    if (groupsLookedUp >= budget) {
      groupsNotAttempted++;
      if (group.hasWebsite) {
        // The website is already known from Maps; only a phone lookup was skipped.
        record.state = 'MAPS_HAS_WEBSITE';
        record.selectionReason = 'candidate already has an official website on Google Maps';
        notAttemptedPhoneOnly++;
      } else {
        record.state = 'DISCOVERY_NOT_ATTEMPTED_BUDGET';
        record.selectionReason = 'discovery lookup skipped due to per-run budget cap';
      }
    } else {
      groupsLookedUp++;
      record.searchAttempted = true;
      let lookupResult = await safeLookup(lookup, representative, record);

      if (group.hasWebsite) {
        // Budget spent on phone enrichment; the Maps website stays authoritative.
        // Task 5: phone-only lookups never consume a second-chance query.
        record.state = 'MAPS_HAS_WEBSITE';
        record.selectionReason = 'candidate already has an official website on Google Maps';
        if (lookupResult) {
          record.queries = lookupResult.queries;
          record.resultsReviewed = lookupResult.results.length;
          record.candidateUrlsReviewed = lookupResult.results.map((r) => r.url).slice(0, 20);
        }
      } else if (!lookupResult) {
        record.state = 'DISCOVERY_EXHAUSTED_NO_FIRST_PARTY';
        record.selectionReason = record.error ?? 'search lookup failed with zero results';
      } else {
        record.queries = [...lookupResult.queries];
        record.resultsReviewed = lookupResult.results.length;

        const runSelection = (results: DiscoverySearchResult[]): void => {
          record.candidateUrlsReviewed = results.map((r) => r.url).slice(0, 20);
          const selection = selectFirstPartyUrl
            ? selectFirstPartyUrl(representative, results)
            : results[0]?.url
            ? { url: results[0].url, reason: 'first result fallback' }
            : undefined;

          if (selection?.url) {
            record.state = 'DISCOVERY_FOUND_FIRST_PARTY';
            record.selectedUrl = selection.url;
            record.selectionReason = selection.reason ?? 'first-party website selected by ranking policy';
          } else if (results.length > 0) {
            record.state = 'DISCOVERY_FOUND_ONLY_THIRD_PARTY';
            record.selectedUrl = undefined;
            record.selectionReason =
              selection?.reason ?? `${results.length} third-party results reviewed, no first-party website`;
          } else {
            record.state = 'DISCOVERY_EXHAUSTED_NO_FIRST_PARTY';
            record.selectedUrl = undefined;
            record.selectionReason = selection?.reason ?? 'zero search results returned';
          }
        };

        runSelection(lookupResult.results);

        // Task 5 — bounded second chance: fires ONLY when Pass 1 produced no
        // first-party URL, runs at most ONE refined query (hard bound: <= 2
        // searches per candidate), and is fully recorded in provenance.
        if (!record.selectedUrl && secondChanceQuery && refinedLookup) {
          const refinedQuery = secondChanceQuery(representative);
          if (
            refinedQuery &&
            !record.queries.includes(refinedQuery) &&
            record.queries.length < 2
          ) {
            const secondResult = await safeRefinedLookup(
              refinedLookup,
              representative,
              refinedQuery,
              record
            );
            if (secondResult) {
              record.secondChanceAttempted = true;
              record.queries = [...record.queries, ...secondResult.queries];
              record.resultsReviewed += secondResult.results.length;
              lookupResult = {
                queries: [...lookupResult.queries, ...secondResult.queries],
                results: [...lookupResult.results, ...secondResult.results],
              };
              // Re-run selection over the COMBINED evidence: Pass 1 candidates
              // that were ineligible stay ineligible, so only Pass 2 can win.
              runSelection(lookupResult.results);
            }
          }
        }
      }

      // Task 4.5: attribute a snippet phone ONLY from the business's own domain
      // (the ranked first-party selection, or the Maps website when no discovery
      // was needed). Directory/platform snippets can never contribute a phone.
      if (lookupResult && selectPhone) {
        const businessDomain =
          domainFromUrlOrHost(record.selectedUrl ?? (representative.website || '')) || undefined;
        const attributedPhone = selectPhone({
          place: representative,
          results: lookupResult.results,
          businessDomain,
        });
        if (attributedPhone) {
          record.phone = attributedPhone;
          record.phoneSourceDomain = businessDomain;
          for (const member of group.members) {
            if (!member.phoneNumber || member.phoneNumber.trim().length === 0) {
              member.phoneNumber = attributedPhone;
            }
          }
        }
      }
    }

    // Extract & classify SERP-discovered social media profiles
    if (record.candidateUrlsReviewed.length > 0) {
      const discoveredSocials: {
        facebook?: string;
        instagram?: string;
        tiktok?: string;
        linkedin?: string;
        other?: Record<string, string>;
      } = {};
      for (const u of record.candidateUrlsReviewed) {
        const categoryCtx = [representative.category, representative.type].filter(Boolean) as string[];
        const classified = classifySocialProfile(u, undefined, representative.title, undefined, categoryCtx, 'serp');
        const canonical = classified.canonicalUrl || u;
        if (classified.status === 'accepted' && classified.profileType === 'business_page') {
          if (classified.platform === 'facebook' && !discoveredSocials.facebook) {
            discoveredSocials.facebook = canonical;
          } else if (classified.platform === 'instagram' && !discoveredSocials.instagram) {
            discoveredSocials.instagram = canonical;
          } else if (classified.platform === 'tiktok' && !discoveredSocials.tiktok) {
            discoveredSocials.tiktok = canonical;
          } else if (classified.platform === 'linkedin' && !discoveredSocials.linkedin) {
            discoveredSocials.linkedin = canonical;
          } else if (classified.platform === 'youtube') {
            discoveredSocials.other = discoveredSocials.other || {};
            if (!discoveredSocials.other.youtube) {
              discoveredSocials.other.youtube = canonical;
            }
          }
        }
      }
      if (Object.keys(discoveredSocials).length > 0) {
        record.discoveredSocials = discoveredSocials;
        for (const member of group.members) {
          (member as any).discoveredSocials = discoveredSocials;
        }
      }
    }

    // 4. Apply the outcome to every duplicate object (no contradictory states).
    for (const member of group.members) {
      member.discoveryState = record.state;
      member.discoveryProvenance = {
        queries: [...record.queries],
        candidateUrlsReviewed: [...record.candidateUrlsReviewed],
        selectedUrl: record.selectedUrl,
        selectionReason: record.selectionReason,
        secondChanceAttempted: Boolean(record.secondChanceAttempted),
        phoneSourceDomain: record.phoneSourceDomain,
        discoveredSocials: record.discoveredSocials,
      };
      if (record.selectedUrl && !hasMapsWebsite(member)) member.website = record.selectedUrl;
    }

    statesApplied[record.state]++;
    records.push(record);
    if (onGroupEvaluated) onGroupEvaluated(record, group.members);
  }

  const invariant = validateDiscoveryStateInvariant(statesApplied, orderedGroups.length);
  if (!invariant.valid) {
    const msg = `[DiscoveryGate] State machine invariant violated: sum(${invariant.sum}) !== total(${orderedGroups.length}), delta=${invariant.delta}`;
    if (process.env.DISCOVERY_MODE === 'benchmark') {
      throw new Error(msg);
    }
    console.error(msg);
  }

  return {
    statesApplied,
    groupsEvaluated: orderedGroups.length,
    groupsLookedUp,
    groupsNotAttempted,
    duplicatesMerged,
    notAttemptedPhoneOnly,
    records,
  };
}

async function safeLookup(
  lookup: (place: SerperPlaceResult) => Promise<DiscoveryLookupResult>,
  place: SerperPlaceResult,
  record: DiscoveryGroupRecord
): Promise<DiscoveryLookupResult | undefined> {
  try {
    return await lookup(place);
  } catch (err) {
    record.error = err instanceof Error ? err.message : String(err);
    return undefined;
  }
}

async function safeRefinedLookup(
  refinedLookup: (place: SerperPlaceResult, query: string) => Promise<DiscoveryLookupResult>,
  place: SerperPlaceResult,
  query: string,
  record: DiscoveryGroupRecord
): Promise<DiscoveryLookupResult | undefined> {
  try {
    return await refinedLookup(place, query);
  } catch (err) {
    // A failed refined query degrades to the Pass 1 outcome; never aborts.
    record.error = record.error ?? (err instanceof Error ? err.message : String(err));
    return undefined;
  }
}
