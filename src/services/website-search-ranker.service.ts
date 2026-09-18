import { domainFromUrlOrHost } from './entity-resolution.service';
import {
  AGGREGATOR_DOMAINS,
  DIRECTORY_DOMAINS as CLASSIFIER_DIRECTORY_DOMAINS,
  SOCIAL_DOMAINS,
  CONTENT_TRAVEL_DOMAINS,
} from './candidate-classifier.service';
import {
  DIRECTORY_DOMAINS as RELATIONSHIP_DIRECTORY_DOMAINS,
  SERVICE_PLATFORM_DOMAINS,
  THIRD_PARTY_PLATFORMS,
  extractBusinessNameTokens,
} from './website-relationship.service';

// ============================================================================
// Website Search Result Ranker — Zero-HTTP deterministic URL scoring (Task 4)
// ============================================================================
// Purpose (Phase 7a Task 4):
//   Replaces the legacy first-pick behaviour `results.find(isUsableOfficialWebsite)`
//   — which accepted whichever usable URL Google returned FIRST — with a
//   deterministic string-token ranking of ALL results.
//
// Contract:
//   - NO network access of any kind. Pure string/token scoring only. Synchronous.
//   - No LLM. Every decision is explained via `reasons` + component scores.
//   - A hard usability gate (injected, e.g. isUsableOfficialWebsite) runs BEFORE
//     scoring, so ranking can never resurrect a rejected URL.
//   - Directory/platform detection is a PENALTY strictly larger in magnitude than
//     the maximum TLD bonus, so a directory on a strong TLD can never outrank a
//     first-party site (Phase 7a risk mitigation #3 — a school-directory site on .edu.np).
//
// Token-eligibility rule (Phase 7a Residual 2, refined — see below):
//   - >= 2 distinctive tokens -> a STRICT MAJORITY must match, minimum 2
//     (2 tokens -> both; 3 -> 2; 4 -> 3; 5 -> 3; ...)
//   - exactly 1 distinctive token -> that token must appear AND, when a location
//     is available, the location must match too
//   - 0 distinctive tokens -> no name requirement (location/usability decide)
//
// Why "strict majority" instead of the originally-planned ">= 2 tokens":
//   The planned >= 2 rule does NOT reject the ambiguity case it was written for.
//   "High New Vision School" (tokens: high, new, vision, school) matches
//   "ever-vision.edu.np" on {vision, school} = 2 tokens, which satisfies ">= 2" and
//   would attach the WRONG school's website. A strict majority (3 of 4) rejects
//   it while still accepting the real Ever Vision case (3 of 3). This deviation
//   from plan v3 is deliberate, fixture-proven, and asserted in the test suite.

/**
 * Distinctive tokens for ranking = the codebase's canonical business-name tokens
 * (website-relationship.service.ts:167-231) minus region/scale noise, mirroring
 * the "specific tokens" convention already used at website-relationship.service.ts:340.
 */
const REGION_NOISE_TOKENS = new Set([
  'nepal',
  'kathmandu',
  'pokhara',
  'lalitpur',
  'himalayan',
  'national',
  'global',
]);

/** Component weights — exported so tests and the walkthrough can cite exact values. */
export const RANK_WEIGHTS = {
  nameTokenMatch: 12,
  allTokensInDomainBonus: 10,
  locationTokenMatch: 10,
  locationInDomainBonus: 4,
  tldBest: 12,
  tldGood: 8,
  tldGeneric: 4,
  tldOther: 2,
  rootOrShortPath: 6,
  contactOrAboutPath: 4,
  deepPathPenalty: -6,
  /** Strictly larger in magnitude than tldBest, satisfying risk mitigation #3. */
  thirdPartyPenalty: -50,
  unrelatedPenalty: -40,
} as const;

/** Minimum score for a candidate to be attached as a first-party website. */
export const MIN_FIRST_PARTY_SCORE = 15;

const TLD_BEST = ['.edu.np', '.gov.np', '.ac.np', '.edu'];
const TLD_GOOD = ['.com.np', '.org.np', '.net.np', '.mil.np'];
const TLD_GENERIC = ['.com', '.org', '.net', '.io', '.co'];

const THIRD_PARTY_DOMAINS = new Set<string>([
  ...AGGREGATOR_DOMAINS,
  ...CLASSIFIER_DIRECTORY_DOMAINS,
  ...SOCIAL_DOMAINS,
  ...CONTENT_TRAVEL_DOMAINS,
  ...RELATIONSHIP_DIRECTORY_DOMAINS,
  ...SERVICE_PLATFORM_DOMAINS,
  ...THIRD_PARTY_PLATFORMS,
]);

const DIRECTORY_PATH_PATTERNS: RegExp[] = [
  /\/(schools?|colleges?|institutes?|listings?|directory|places?|businesses?|eatery|eateries|restaurants?|menu\/restaurant|restaurant-review|services?)\//i,
  /\/(search|results|category|categories|browse|tag)\b/i,
  /[?&](q|query|search|s)=/i,
  /\/(c|biz|company|profile)\/\d+/i,
];

const ARTICLE_PATH_PATTERNS: RegExp[] = [
  /\/(news|articles?|blog|posts?|story|stories|reviews?)\b/i,
  /\/\d{4}\/\d{1,2}\//,
];

const CONTACT_OR_ABOUT_PATTERN = /\/(contact|about|enquiry|reach-us|get-in-touch)\b/i;

export interface RankedUrl {
  url: string;
  title?: string;
  description?: string;
  extraSnippets?: string[];
}

export interface RankWebsiteSearchResultsParams {
  results: RankedUrl[];
  businessName: string;
  location?: string;
  /** Hard gate applied BEFORE scoring (default: accept any http(s) URL). */
  isUsable?: (candidate: RankedUrl) => boolean;
}

export interface ScoredUrlCandidate {
  url: string;
  domain: string;
  /** Final score (components + penalties). Sorted descending. */
  score: number;
  /** True when the name/location eligibility rule AND the hard gate both passed. */
  eligible: boolean;
  /** True when the domain or path looks like a directory/aggregator/platform. */
  thirdParty: boolean;
  nameOverlapCount: number;
  distinctiveTokens: string[];
  matchedTokens: string[];
  locationMatch: boolean;
  tldTier: 'best' | 'good' | 'generic' | 'other';
  originalIndex: number;
  /** Explanation trail (feeds Task 8 telemetry and workflow logs). */
  reasons: string[];
}

export interface SelectFirstPartyWebsiteResult {
  url?: string;
  ranked: ScoredUrlCandidate[];
  reason: string;
}

/** Distinctive tokens of a business name (canonical extractor + region-noise filter). */
export function distinctiveNameTokens(businessName: string): string[] {
  return extractBusinessNameTokens(businessName).filter((t) => !REGION_NOISE_TOKENS.has(t));
}

/** Location tokens (length >= 3), excluding generic country noise. */
export function locationTokens(location?: string): string[] {
  if (!location) return [];
  return location
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t !== 'nepal');
}

const GENERIC_CATEGORY_WORDS = new Set([
  'school',
  'schools',
  'college',
  'colleges',
  'institute',
  'institutes',
  'academy',
  'hotel',
  'hotels',
  'restaurant',
  'restaurants',
  'restro',
  'cafe',
  'kitchen',
  'hub',
  'hospital',
  'clinic',
  'dental',
  'store',
  'shop',
  'services',
  'service',
  'directory',
  'listing',
  'portal',
]);

export function isThirdPartyDomain(domain: string): boolean {
  if (!domain) return false;
  const lower = domain.toLowerCase();
  if (
    lower.includes('directory') ||
    lower.includes('yellowpages') ||
    lower.includes('tripadvisor') ||
    lower.includes('restaurantguru')
  ) {
    return true;
  }
  for (const blocked of THIRD_PARTY_DOMAINS) {
    if (domain === blocked || domain.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

export function looksThirdPartyUrl(url: string): boolean {
  return DIRECTORY_PATH_PATTERNS.some((p) => p.test(url));
}

export function tldTierOf(domain: string): ScoredUrlCandidate['tldTier'] {
  const lower = (domain || '').toLowerCase();
  if (TLD_BEST.some((t) => lower.endsWith(t))) return 'best';
  if (TLD_GOOD.some((t) => lower.endsWith(t))) return 'good';
  if (TLD_GENERIC.some((t) => lower.endsWith(t))) return 'generic';
  return 'other';
}

function isHttpUrl(url: string): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

/** Number of path segments after the host (used for shallow/deep page signals). */
function pathSegments(url: string): number {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split('/').filter((s) => s.length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Task 5 — deterministic name-eligibility threshold (single source of truth).
 * Strict majority of distinctive tokens, minimum 2 (1-token names use the
 * location-fallback rule). Table: 1->1, 2->2, 3->2, 4->3, 5->3, 6->4, ...
 */
export function requiredNameOverlap(distinctiveTokenCount: number): number {
  if (distinctiveTokenCount <= 0) return 0;
  if (distinctiveTokenCount === 1) return 1;
  return Math.max(2, Math.floor(distinctiveTokenCount / 2) + 1);
}

function tldScore(tier: ScoredUrlCandidate['tldTier']): number {
  if (tier === 'best') return RANK_WEIGHTS.tldBest;
  if (tier === 'good') return RANK_WEIGHTS.tldGood;
  if (tier === 'generic') return RANK_WEIGHTS.tldGeneric;
  return RANK_WEIGHTS.tldOther;
}

/** Word-boundary match for natural-language fields (title/description/snippets). */
function textContainsToken(text: string, token: string): boolean {
  if (!text || !token) return false;
  return new RegExp(`(^|[^a-z0-9])${token}`, 'i').test(text);
}

/**
 * Scores ONE candidate. Pure and synchronous: no I/O, no time, no randomness.
 *
 * Name-token matching is intentionally two-mode, mirroring existing conventions:
 *   - natural-language fields (title/description/snippets) use word boundaries;
 *   - the DOMAIN uses substring matching, because real Nepali brands are glued
 *     ("ever-vision.edu.np", "high-new-vision.edu.np").
 * Known limitation (disclosed, not hidden): substring domain matching can match a
 * token inside a longer word ("ever" inside "forever"). The strict-majority rule makes
 * an accidental double match unlikely, and identity verification (Phase 7 Task 7)
 * plus the isUsableOfficialWebsite category gate remain the downstream guards.
 */
export function scoreCandidate(
  candidate: RankedUrl,
  index: number,
  distinctiveTokens: string[],
  locTokens: string[]
): ScoredUrlCandidate {
  const url = (candidate.url || '').trim();
  const domain = domainFromUrlOrHost(url);
  const domainLower = domain.toLowerCase();
  const textFields = `${url} ${candidate.title || ''} ${candidate.description || ''} ${(
    candidate.extraSnippets || []
  ).join(' ')}`;

  const reasons: string[] = [];
  let score = 0;

  const matchedTokens = distinctiveTokens.filter(
    (token) => domainLower.includes(token) || textContainsToken(textFields, token)
  );
  const nameOverlapCount = matchedTokens.length;
  if (nameOverlapCount > 0) {
    const bonus = nameOverlapCount * RANK_WEIGHTS.nameTokenMatch;
    score += bonus;
    reasons.push(`name tokens matched: [${matchedTokens.join(', ')}] (+${bonus})`);
  }

  const allTokensInDomain =
    distinctiveTokens.length > 0 && distinctiveTokens.every((t) => domainLower.includes(t));
  if (allTokensInDomain) {
    score += RANK_WEIGHTS.allTokensInDomainBonus;
    reasons.push(`all name tokens in domain (+${RANK_WEIGHTS.allTokensInDomainBonus})`);
  }

  const locationMatch =
    locTokens.length > 0 && locTokens.some((t) => textContainsToken(textFields, t));
  if (locationMatch) {
    score += RANK_WEIGHTS.locationTokenMatch;
    reasons.push(`location matched (+${RANK_WEIGHTS.locationTokenMatch})`);
    if (locTokens.some((t) => domainLower.includes(t))) {
      score += RANK_WEIGHTS.locationInDomainBonus;
      reasons.push(`location in domain (+${RANK_WEIGHTS.locationInDomainBonus})`);
    }
  }

  const tldTier = tldTierOf(domain);
  const tldBonus = tldScore(tldTier);
  score += tldBonus;
  reasons.push(`tld tier '${tldTier}' (+${tldBonus})`);

  const segments = pathSegments(url);
  if (segments <= 1) {
    score += RANK_WEIGHTS.rootOrShortPath;
    reasons.push(`root/short path (+${RANK_WEIGHTS.rootOrShortPath})`);
  } else if (CONTACT_OR_ABOUT_PATTERN.test(url)) {
    score += RANK_WEIGHTS.contactOrAboutPath;
    reasons.push(`contact/about page (+${RANK_WEIGHTS.contactOrAboutPath})`);
  }
  if (segments >= 3 || ARTICLE_PATH_PATTERNS.some((p) => p.test(url))) {
    score += RANK_WEIGHTS.deepPathPenalty;
    reasons.push(`deep/article path (${RANK_WEIGHTS.deepPathPenalty})`);
  }

  const brandDistinctiveTokens = distinctiveTokens.filter(
    (t) => !GENERIC_CATEGORY_WORDS.has(t.toLowerCase())
  );
  const hasDistinctiveInDomain =
    brandDistinctiveTokens.length > 0 &&
    brandDistinctiveTokens.some((t) => domainLower.includes(t));

  const looksDir = looksThirdPartyUrl(url);
  const thirdParty = isThirdPartyDomain(domain) || (looksDir && !hasDistinctiveInDomain);
  if (thirdParty) {
    score += RANK_WEIGHTS.thirdPartyPenalty;
    reasons.push(`third-party/directory signal (${RANK_WEIGHTS.thirdPartyPenalty})`);
  }

  if (distinctiveTokens.length > 0 && nameOverlapCount === 0 && !locationMatch) {
    score += RANK_WEIGHTS.unrelatedPenalty;
    reasons.push(`no name or location evidence (${RANK_WEIGHTS.unrelatedPenalty})`);
  }

  // Name-eligibility rule (Phase 7a Residual 2, refined: strict majority, min 2).
  let eligible = true;
  if (distinctiveTokens.length >= 2) {
    const requiredOverlap = requiredNameOverlap(distinctiveTokens.length);
    if (nameOverlapCount < requiredOverlap) {
      eligible = false;
      reasons.push(
        `ineligible: ${nameOverlapCount}/${distinctiveTokens.length} distinctive tokens (strict majority, min ${requiredOverlap} required)`
      );
    }
  } else if (distinctiveTokens.length === 1) {
    if (nameOverlapCount < 1) {
      eligible = false;
      reasons.push('ineligible: the single distinctive token is absent');
    } else if (locTokens.length > 0 && !locationMatch) {
      eligible = false;
      reasons.push('ineligible: single-token name requires a location match');
    }
  }

  return {
    url,
    domain,
    score,
    eligible,
    thirdParty,
    nameOverlapCount,
    distinctiveTokens,
    matchedTokens,
    locationMatch,
    tldTier,
    originalIndex: index,
    reasons,
  };
}

/**
 * Ranks all results deterministically (score desc, then original position).
 * Pure + synchronous — this function must never perform network I/O.
 */
export function rankWebsiteSearchResults(
  params: RankWebsiteSearchResultsParams
): ScoredUrlCandidate[] {
  const { results, businessName, location, isUsable } = params;
  const distinctiveTokens = distinctiveNameTokens(businessName);
  const locTokens = locationTokens(location);
  const gateFn = isUsable ?? (() => true);

  const scored = (results || [])
    .filter((candidate) => isHttpUrl(candidate.url))
    .map((candidate, index) => {
      const scoredCandidate = scoreCandidate(candidate, index, distinctiveTokens, locTokens);
      if (!gateFn(candidate)) {
        scoredCandidate.eligible = false;
        scoredCandidate.reasons.push('ineligible: rejected by the injected usability gate');
      }
      return scoredCandidate;
    });

  return scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });
}

/**
 * Selects the best first-party website, or nothing at all.
 * Returning `undefined` is a first-class outcome: it is what produces
 * DISCOVERY_FOUND_ONLY_THIRD_PARTY / DISCOVERY_EXHAUSTED_NO_FIRST_PARTY in Task 3.
 */
export function selectFirstPartyWebsiteUrl(
  params: RankWebsiteSearchResultsParams
): SelectFirstPartyWebsiteResult {
  const ranked = rankWebsiteSearchResults(params);
  const eligible = ranked.filter((c) => c.eligible && !c.thirdParty);

  if (eligible.length === 0) {
    const thirdPartyOnly = ranked.filter((c) => c.thirdParty).length;
    return {
      ranked,
      reason:
        ranked.length === 0
          ? 'no results reviewed'
          : thirdPartyOnly > 0
          ? `${thirdPartyOnly} third-party/directory candidate(s) reviewed, no first-party website`
          : 'no candidate satisfied the name/location eligibility rule',
    };
  }

  const best = eligible[0];
  if (best.score < MIN_FIRST_PARTY_SCORE) {
    return {
      ranked,
      reason: `best eligible score ${best.score} is below the ${MIN_FIRST_PARTY_SCORE} threshold`,
    };
  }

  return {
    url: best.url,
    ranked,
    reason: `selected ${best.domain} (score ${best.score}; tokens [${best.matchedTokens.join(', ')}])`,
  };
}