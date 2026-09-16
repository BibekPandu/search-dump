/**
 * Category Policy Version: 1
 * Last reviewed: 2026-09-16
 * Source: Phase 4 benchmark (SPORTS-01)
 * Scope contract: See per-policy ontology declarations below.
 */

export interface CategoryExpansionPolicy {
  normalized: string;
  isBroad: boolean;
  scopeContract: string;
  discoveryTerms: string[];     // Search queries to generate for discovery
  positiveTerms: string[];      // Semantic category vocabulary for relevance matching (Tier 1)
  distinctiveTerms: string[];   // Specific sport tokens for Tier 2 match (must be subset of positiveTerms)
  businessFormTerms: string[];  // Business form nouns (shop, club, academy, center, store, hub)
  excludedTerms: string[];      // Negative context phrases in declaration order
  maxTotalQueries: number;      // Total queries including exact query (default: 6)
}

/**
 * Category expansion policies.
 * Key = normalized category (lowercase, trimmed).
 */
export const CATEGORY_EXPANSION_POLICIES: Record<string, CategoryExpansionPolicy> = {
  sports: {
    normalized: 'sports',
    isBroad: true,
    scopeContract:
      'All sports-related business entities that primarily serve participants, players, athletes, or enthusiasts — sports retailers/equipment shops, sports clubs, training academies, and fitness/sports centers. EXCLUDES medical/clinical providers (sports medicine, physiotherapy, injury clinics), sports media/broadcasters/news, and sports bars/restaurants.',
    discoveryTerms: [
      'sports shops',
      'sports clubs',
      'sports academies',
      'sports centers',
      'sports equipment',
    ],
    positiveTerms: [
      'sports',
      'sporting',
      'athletics',
      'football',
      'futsal',
      'cricket',
      'badminton',
      'tennis',
      'swimming',
      'fitness',
      'gym',
      'martial arts',
      'taekwondo',
      'karate',
      'basketball',
      'volleyball',
    ],
    // Distinctive specific sports: excludes generic 'sports', 'sporting', 'athletics', 'fitness'
    distinctiveTerms: [
      'football',
      'futsal',
      'cricket',
      'badminton',
      'tennis',
      'swimming',
      'gym',
      'martial arts',
      'taekwondo',
      'karate',
      'basketball',
      'volleyball',
    ],
    businessFormTerms: [
      'shop',
      'shops',
      'store',
      'stores',
      'club',
      'clubs',
      'academy',
      'academies',
      'center',
      'centers',
      'centre',
      'centres',
      'hub',
      'complex',
      'ground',
      'arena',
      'house',
      'supplier',
      'suppliers',
      'mart',
    ],
    excludedTerms: [
      // 1. Compound clinical phrases
      'sports medicine',
      'sports injury',
      'sports rehab',
      // 2. Broad clinical terms
      'hospital',
      'physiotherapy',
      'orthopedic',
      'clinic',
      'rehabilitation',
      // 3. Sports media & broadcasting terms
      'sports news',
      'sports media',
      'sports broadcast',
      'sports broadcasting',
      'sports radio',
      'news',
      'media',
      'broadcast',
      'broadcaster',
      'television',
      'radio',
      // 4. Hospitality/nightlife terms
      'bar',
      'lounge',
      'pub',
    ],
    maxTotalQueries: 6,
  },
};

/**
 * Broad queries recognized by the expansion engine.
 * Only queries with active policies are listed here to prevent unpolicied silent downgrades.
 */
export const BROAD_QUERY_PATTERNS = ['sports'];

/**
 * Closed mapping table for controlled singular -> plural stem normalization.
 * No generic linguistic stemming is applied.
 */
export const CATEGORY_STEM_MAPPINGS: Record<string, string> = {
  sport: 'sports',
};
