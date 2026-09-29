/**
 * Entity pair matching, dedupe and website-lookup ranking.
 *
 * Owns the entity-identity types and every decision that depends only on a
 * pair of candidates: are these the same business, which is worth a website
 * lookup, and is a website usable as an official site.
 */

import {
  AGGREGATOR_DOMAINS,
  DIRECTORY_DOMAINS,
  SOCIAL_DOMAINS,
  CONTENT_TRAVEL_DOMAINS,
} from '@/services/resolution/candidate-classifier.service';
import { isSocialOrDirectory, isGoogleMapsUrl } from '@/services/discovery/url-filter.service';
import type { SerperPlaceResult } from '@/services/external/serper-places.service';
import { 
  GENERIC_DOMAIN_TOKENS
 } from '@/config/token-vocabulary.config';
import { 
  normalizePhoneDigits,
  normalizeNameKey,
  normalizeNameKeyLenient,
  domainFromUrlOrHost,
  normalizeAddressKey,
  tokenJaccard
 } from '@/services/resolution/entity-normalizers';


// ============================================================================
// Types
// ============================================================================

export interface EntityEvidence {
  name?: string;
  phone?: string;
  website?: string;
  domain?: string;
  address?: string;
}


export type EntityMatchMethod = 'phone' | 'domain' | 'name_address' | 'none';


export interface EntityMatch {
  matched: boolean;
  confidence: number;
  method: EntityMatchMethod;
  reason?: string;
}


// ============================================================================
// Deterministic Entity Matching Cascade (0-Token)
// ============================================================================

/**
 * Resolves whether two entity evidence records refer to the same real-world entity.
 * Cascade order:
 *  1. Equal phone digits (>= 7 digits) -> match (1.0)
 *  2. Equal official domain -> match (1.0)
 *  [VETO]: If conflicting phone or conflicting official domain exists, veto name/address soft match.
 *  3. Name + Address Jaccard similarity -> match (0.85 - 0.9)
 *  Otherwise: insufficient deterministic evidence to merge.
 */
export function resolveEntityPair(a: EntityEvidence, b: EntityEvidence): EntityMatch {
  const phoneA = normalizePhoneDigits(a.phone || '');
  const phoneB = normalizePhoneDigits(b.phone || '');

  // Rule 1: Phone digits equal (>= 7 digits)
  if (phoneA.length >= 7 && phoneB.length >= 7 && phoneA === phoneB) {
    return {
      matched: true,
      confidence: 1.0,
      method: 'phone',
      reason: `Matching phone digits (${phoneA})`,
    };
  }

  const domA = domainFromUrlOrHost(a.website || a.domain || '');
  const domB = domainFromUrlOrHost(b.website || b.domain || '');

  const isUsableDomain = (dom: string) =>
    Boolean(dom) &&
    !SOCIAL_DOMAINS.has(dom) &&
    !dom.includes('google.com') &&
    !dom.includes('maps.google');

  // Rule 2: Usable official domain equal
  if (isUsableDomain(domA) && isUsableDomain(domB) && domA === domB) {
    return {
      matched: true,
      confidence: 1.0,
      method: 'domain',
      reason: `Matching official domain (${domA})`,
    };
  }

  // Safeguard 3: Negative signal veto on soft match
  // If both possess phone numbers and they conflict, or both possess official domains and they conflict,
  // do NOT allow a soft name/address match to falsely merge different businesses.
  const hasConflictingPhone = phoneA.length >= 7 && phoneB.length >= 7 && phoneA !== phoneB;
  const hasConflictingDomain = isUsableDomain(domA) && isUsableDomain(domB) && domA !== domB;

  if (hasConflictingPhone || hasConflictingDomain) {
    // "Not matched" means "insufficient deterministic evidence to merge" —
    // it does NOT assert these are confirmed different businesses. This
    // distinction must be preserved for a future LLM-adjudication phase and
    // must not be silently lost.
    return {
      matched: false,
      confidence: 0,
      method: 'none',
      reason: hasConflictingPhone ? 'Conflicting phone numbers' : 'Conflicting official domains',
    };
  }

  // Rule 3: Name + Address token Jaccard similarity
  const nameA = normalizeNameKey(a.name || '');
  const nameB = normalizeNameKey(b.name || '');
  const nameSim = tokenJaccard(nameA, nameB);

  const addrA = normalizeAddressKey(a.address || '');
  const addrB = normalizeAddressKey(b.address || '');
  const addrSim = tokenJaccard(addrA, addrB);

  if (nameSim >= 0.85 && addrSim >= 0.5) {
    return {
      matched: true,
      confidence: 0.85,
      method: 'name_address',
      reason: `Name Jaccard (${nameSim.toFixed(2)}) + Address Jaccard (${addrSim.toFixed(2)})`,
    };
  }

  if (nameSim >= 0.95) {
    return {
      matched: true,
      confidence: 0.9,
      method: 'name_address',
      reason: `High Name Jaccard (${nameSim.toFixed(2)})`,
    };
  }

  // "Not matched" means "insufficient deterministic evidence to merge" —
  // it does NOT assert these are confirmed different businesses. This
  // distinction must be preserved for a future LLM-adjudication phase and
  // must not be silently lost.
  return {
    matched: false,
    confidence: 0,
    method: 'none',
    reason: 'Insufficient deterministic evidence to merge',
  };
}


/**
 * Stable greedy entity deduplication. First occurrence wins.
 */
export function dedupeByEntity<T extends EntityEvidence>(
  items: T[],
  keyOf: (t: T) => EntityEvidence = (t) => t
): T[] {
  const unique: T[] = [];

  for (const item of items) {
    const evidence = keyOf(item);
    const existingIndex = unique.findIndex((u) => resolveEntityPair(evidence, keyOf(u)).matched);
    if (existingIndex === -1) {
      unique.push(item);
    }
  }

  return unique;
}


// ============================================================================
// Website Validation & Ranking
// ============================================================================

const ARTICLE_PATH_PATTERNS = [
  /\/news(-and-articles)?\//i,
  /\/articles?\//i,
  /\/blog\//i,
  /\/posts?\//i,
  /\/reviews?\//i,
  /\/story\//i,
  /\/guides?\//i,
];


// ============================================================================
// Business / Website Category Detection (conflict-based website verification)
// ============================================================================
// Categories are EVIDENCE SIGNALS, not law: a candidate website is rejected
// ONLY when the business's detected category and the website's detected
// category are EXPLICITLY conflicting (e.g. travel agency -> hotel site) and
// each side has a single, unambiguous detected category. Unknown or mixed
// signals never conflict — absence of evidence is not evidence against.

const BUSINESS_CATEGORY_KEYWORDS: Record<string, { primary: string[]; conflicts: string[] }> = {
  travel: {
    primary: ['tours', 'travel', 'trekking', 'expedition', 'adventure', 'holiday', 'vacation', 'trip', 'journey'],
    conflicts: ['hotel'],
  },
  hotel: {
    primary: ['hotel', 'lodge', 'resort', 'accommodation', 'hostel', 'motel', 'inn', 'stay', 'lodging'],
    conflicts: ['travel', 'restaurant'],
  },
  restaurant: {
    primary: ['restaurant', 'cafe', 'coffee', 'food', 'dining', 'kitchen', 'bakery', 'bar'],
    conflicts: ['hotel'],
  },
  retail: {
    primary: ['shop', 'store', 'mart', 'market', 'retail', 'emporium', 'trading'],
    conflicts: ['hotel', 'restaurant'],
  },
  healthcare: {
    primary: ['hospital', 'clinic', 'medical', 'health', 'pharmacy', 'dental', 'doctor'],
    conflicts: ['hotel', 'restaurant', 'travel'],
  },
  education: {
    primary: ['school', 'college', 'university', 'academy', 'institute', 'education', 'educational'],
    conflicts: ['hotel', 'restaurant', 'travel'],
  },
};


/**
 * Collects the set of categories whose primary keywords appear in `text`.
 * `substring` enables glued-token matching for domain names (bihanihotel.com);
 * business names and page titles use padded-word matching (word boundaries),
 * so "Nepal Tourism Board" can never resolve to the 'travel' category via the
 * word "tour" buried inside "tourism".
 */
function categoryHits(text: string, substring: boolean): Set<string> {
  const hits = new Set<string>();
  const padded = ` ${(text || '').toLowerCase()} `;
  for (const [category, def] of Object.entries(BUSINESS_CATEGORY_KEYWORDS)) {
    for (const keyword of def.primary) {
      const found = substring ? padded.includes(keyword) : padded.includes(` ${keyword} `);
      if (found) {
        hits.add(category);
        break;
      }
    }
  }
  return hits;
}


function detectCategoryFromText(text: string, substring: boolean): string | null {
  const hits = categoryHits(text, substring);
  // Exactly one category = confident. Zero (unknown) or multiple (mixed, e.g.
  // "Hotel & Tours") = undetectable, which never produces a conflict.
  return hits.size === 1 ? [...hits][0] : null;
}


/** Detects the business category from its name + optional Maps category. */
export function detectBusinessCategory(businessName: string, mapsCategory?: string): string | null {
  const combined = `${businessName || ''} ${mapsCategory || ''}`.trim();
  if (!combined) return null;
  return detectCategoryFromText(combined, false);
}


/** Detects the website category from domain (glued tokens) + optional page title. */
export function detectWebsiteCategory(domain: string, pageTitle?: string): string | null {
  const combined = `${domain || ''} ${pageTitle || ''}`.trim();
  if (!combined) return null;
  return detectCategoryFromText(combined, true);
}


/**
 * True only when both sides detected a single category AND one of the two
 * categories is in the other's explicit conflict list. Symmetric by design.
 */
export function hasCategoryConflict(businessCategory: string | null, websiteCategory: string | null): boolean {
  if (!businessCategory || !websiteCategory) return false;
  if (businessCategory === websiteCategory) return false;

  const businessConflicts = BUSINESS_CATEGORY_KEYWORDS[businessCategory]?.conflicts || [];
  const websiteConflicts = BUSINESS_CATEGORY_KEYWORDS[websiteCategory]?.conflicts || [];
  return businessConflicts.includes(websiteCategory) || websiteConflicts.includes(businessCategory);
}


/**
 * Checks if a URL is an acceptable official website candidate.
 * Rejects social networks, directories, aggregators, blogs, articles, and map links.
 */
export function isUsableOfficialWebsite(
  url: string,
  businessName?: string,
  mapsCategory?: string,
  pageTitle?: string
): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return false;

  if (isSocialOrDirectory(trimmed) || isGoogleMapsUrl(trimmed)) return false;

  if (ARTICLE_PATH_PATTERNS.some((p) => p.test(trimmed))) return false;

  const domain = domainFromUrlOrHost(trimmed);
  if (!domain) return false;

  if (
    AGGREGATOR_DOMAINS.has(domain) ||
    DIRECTORY_DOMAINS.has(domain) ||
    SOCIAL_DOMAINS.has(domain) ||
    CONTENT_TRAVEL_DOMAINS.has(domain)
  ) {
    return false;
  }

  if (businessName) {
    const nameTokens = normalizeNameKey(businessName)
      .split(' ')
      .filter(
        (t) =>
          t.length >= 3 &&
          !['coffee', 'cafe', 'restaurant', 'hotel', 'house', 'bar', 'shop', 'centre', 'center'].includes(t)
      );
    if (nameTokens.length > 0) {
      const domainLower = domain.toLowerCase();
      const hasTokenInDomain = nameTokens.some((t) => domainLower.includes(t));
      if (
        !hasTokenInDomain &&
        (domainLower.endsWith('.info') ||
          domainLower.endsWith('.org') ||
          domainLower.includes('pulse') ||
          domainLower.includes('news'))
      ) {
        return false;
      }
    }

    // Category-conflict rejection (v1.2): a travel agency must never be matched
    // to a hotel site, a restaurant to a hotel site, etc. This is a CONFLICT
    // signal, not exact-category enforcement — unknown/mixed categories pass.
    // Distinctive overlap bypasses category rejection when domain matches business name's own distinctive tokens.
    const businessCategory = detectBusinessCategory(businessName, mapsCategory);
    const websiteCategory = detectWebsiteCategory(domain, pageTitle);
    if (hasCategoryConflict(businessCategory, websiteCategory)) {
      const domainTokens = domain
        .toLowerCase()
        .replace(/^www\./, '')
        .split(/[-._\d]+/)
        .filter((t) => t.length >= 3);
      const nameTokensAll = normalizeNameKeyLenient(businessName)
        .split(' ')
        .filter((t) => t.length >= 3);
      const overlappingTokens = domainTokens.filter((t) => nameTokensAll.includes(t));
      const distinctiveOverlap = overlappingTokens.filter((t) => !GENERIC_DOMAIN_TOKENS.has(t));

      // Check if page title/content aligns with business category or is generic
      const pageCategory = pageTitle ? detectCategoryFromText(pageTitle, false) : null;
      const pageMatchesOrGeneric = !pageCategory || pageCategory === businessCategory;

      // Check if business name itself contains the keyword triggering the websiteCategory (self-collision)
      const businessNameContainsCollidingKeyword =
        Boolean(websiteCategory &&
        BUSINESS_CATEGORY_KEYWORDS[websiteCategory]?.primary.some((kw) => nameTokensAll.includes(kw)));

      const allowBypass =
        distinctiveOverlap.length >= 2 ||
        (distinctiveOverlap.length >= 1 && (pageMatchesOrGeneric || businessNameContainsCollidingKeyword));

      if (allowBypass) {
        console.log(
          `[EntityResolution] Category mismatch bypassed via distinctive token overlap [${distinctiveOverlap.join(', ')}] for "${businessName}" (${businessCategory}) vs ${domain} (${websiteCategory})`
        );
      } else {
        console.log(
          `[EntityResolution] Category mismatch rejected: ${trimmed} (${websiteCategory}) for "${businessName}" (${businessCategory})`
        );
        return false;
      }
    }
  }

  return true;
}


/**
 * Deterministically ranks Google Maps places lacking a website to prioritize targeted web lookups.
 * Higher evidence weight (phone + address + rating + review count) gets lookup first.
 *
 * Phase 7a Task 2 (de-trap): `limit` previously defaulted to 3, a latent silent
 * truncation for any caller that omitted it. The Task 1 forensic trace proved the
 * default was never exercised in production (the workflow always passed an
 * explicit limit), but it remained a trap for future callers. Omitting `limit`
 * now returns ALL ranked places; the budget is decided by the caller via
 * `resolveWebsiteDiscoveryBudget` (src/config/website-discovery.config.ts).
 */
export function rankWebsiteLookupTargets(
  places: SerperPlaceResult[],
  limit?: number
): SerperPlaceResult[] {
  const scored = places.map((place, originalIndex) => {
    const phoneScore = place.phoneNumber ? 1 : 0;
    const addressScore = place.address ? 1 : 0;
    const ratingScore = (place.rating || 0) / 5;
    const countScore = Math.min(place.ratingCount || 0, 500) / 500;
    const totalScore = phoneScore + addressScore + ratingScore + countScore;
    return { place, originalIndex, totalScore };
  });

  scored.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return a.originalIndex - b.originalIndex;
  });

  const effectiveLimit =
    limit === undefined || !Number.isFinite(limit) ? places.length : Math.max(0, Math.floor(limit));

  return scored.slice(0, effectiveLimit).map((s) => s.place);
}
