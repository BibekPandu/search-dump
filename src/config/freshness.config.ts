/**
 * Cache Freshness Policy — M1
 * Last reviewed: 2026-09-25
 * Source: M1 MongoDB storage + cache lookup plan (v3, corrections C3/C4/C10)
 *
 * Scope contract:
 *   This policy governs ONLY how old a cached `runs` snapshot may be before the
 *   Step 1 cache-first guard (research-workflow.ts) refuses to serve it and the
 *   full pipeline runs instead. It does NOT govern search caching
 *   (cache.service.ts, Tavily-only, 7d) and it does NOT decide whether a
 *   candidate is evaluated.
 *
 * Provenance note:
 *   Category values are deliberately conservative (shorter windows for
 *   price/competition-volatile verticals such as restaurants). The policy table
 *   is READ by the lookup today, so it is not decoration: changing a value
 *   changes lookup behaviour immediately.
 */

/** Default freshness window applied when no category policy and no env override match. */
export const DEFAULT_MAX_AGE_DAYS = 30;

/** Explicit operator override (env). Wins over category policy. */
export const CACHE_MAX_AGE_OVERRIDE_ENV = 'CACHE_MAX_AGE_DAYS';

/** Per-category freshness windows, keyed by normalized query text. */
export const MAX_AGE_DAYS_BY_CATEGORY: Record<string, number> = {
  restaurant: 14,
  restaurants: 14,
  cafe: 14,
  cafes: 14,
  barber: 30,
  salon: 30,
  parlor: 30,
  parlour: 30,
  gym: 30,
  fitness: 30,
  pharmacy: 30,
  hotel: 30,
  'spa sauna': 30,
  'banquet hall': 90,
  consultancy: 90,
  consultant: 90,
  lawyer: 90,
  lawyers: 90,
  hospital: 90,
  clinic: 90,
  'home cleaning': 90,
  plumber: 90,
  electrician: 90,
  school: 180,
  schools: 180,
  college: 180,
  colleges: 180,
};

/**
 * Canonical normalization for cache key parts (query AND location).
 *
 * Derived from real observed stored values, not theory:
 *   - `"\nSatungal, Kathmandu\n"`  → `"satungal, kathmandu"`  (history/…-parlor)
 *   - `"Banquet Hall\n"`           → `"banquet hall"`         (history/…-banquet-hall)
 *   - `"SPA & Sauna"`              → `"spa & sauna"`          (history/…-spa-sauna)
 *
 * Case folding + whitespace collapsing only. Punctuation is intentionally
 * preserved so `"SPA & Sauna"` round-trips to the same key on a re-query.
 * Documented limitation: `"Barber"` and `"Barbers"` are different keys.
 */
export function normalizeQueryKeyPart(value?: string | null): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface FreshnessResolution {
  /** Resolved window in days (always finite, >= 0). */
  days: number;
  /** Where the value came from: 'env:CACHE_MAX_AGE_DAYS' | 'policy:<key>' | 'default'. */
  source: string;
  /** The policy key that matched, when the value came from MAX_AGE_DAYS_BY_CATEGORY. */
  matchedKey?: string;
}

/**
 * Resolves the freshness window for a query deterministically.
 * Precedence: env override > exact category key > first-word key >
 * longest substring category key > DEFAULT_MAX_AGE_DAYS.
 * Never throws: invalid input degrades to the default.
 */
export function describeLookupMaxAgeDays(
  query: string,
  env: Record<string, string | undefined> = process.env
): FreshnessResolution {
  const override = env[CACHE_MAX_AGE_OVERRIDE_ENV];
  if (override !== undefined && override.trim() !== '') {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return { days: Math.floor(parsed), source: `env:${CACHE_MAX_AGE_OVERRIDE_ENV}` };
    }
  }

  const queryKey = normalizeQueryKeyPart(query);
  if (!queryKey) return { days: DEFAULT_MAX_AGE_DAYS, source: 'default' };

  const exact = MAX_AGE_DAYS_BY_CATEGORY[queryKey];
  if (exact !== undefined) {
    return { days: exact, source: `policy:${queryKey}`, matchedKey: queryKey };
  }

  const firstWord = queryKey.split(' ')[0];
  const byWord = MAX_AGE_DAYS_BY_CATEGORY[firstWord];
  if (byWord !== undefined) {
    return { days: byWord, source: `policy:${firstWord}`, matchedKey: firstWord };
  }

  // Longest-policy-key-first substring match: "lawyers in satungal, kathmandu" → 'lawyers'.
  const policyKeys = Object.keys(MAX_AGE_DAYS_BY_CATEGORY).sort((a, b) => b.length - a.length);
  for (const key of policyKeys) {
    if (queryKey.includes(key)) {
      return { days: MAX_AGE_DAYS_BY_CATEGORY[key], source: `policy:${key}`, matchedKey: key };
    }
  }

  return { days: DEFAULT_MAX_AGE_DAYS, source: 'default' };
}

/** Convenience accessor used by the Step 1 cache guard. */
export function lookupMaxAgeDays(
  query: string,
  env: Record<string, string | undefined> = process.env
): number {
  return describeLookupMaxAgeDays(query, env).days;
}
