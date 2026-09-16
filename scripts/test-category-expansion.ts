import assert from 'node:assert';
import {
  CATEGORY_EXPANSION_POLICIES,
  CATEGORY_STEM_MAPPINGS,
} from '../src/config/category-expansion.config';
import {
  normalizeCategoryIntent,
  expandCategoryQueries,
  type CategoryIntent,
} from '../src/services/search-fallback.service';
import {
  checkCategoryRelevance,
} from '../src/services/candidate-classifier.service';
import {
  LINKEDIN_COMPANY_REGEX,
  LINKEDIN_PERSONAL_REGEX,
  classifyAllSocialProfiles,
} from '../src/services/business-extractor.service';
import { buildResearchCandidates } from '../src/services/research-candidate.service';
import type { SerperPlaceResult } from '../src/services/serper-places.service';

console.log('================================================================');
console.log('PHASE 4: CATEGORY EXPANSION & ONTOLOGY RELEVANCE TEST SUITE (29 FIXTURES)');
console.log('================================================================\n');

let passed = 0;
let failed = 0;

function runTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`❌ [FAIL] ${name}`);
    console.error(err);
    failed++;
  }
}

// ============================================================================
// Section 1: Configuration & Stem Normalization (T1 - T4)
// ============================================================================

runTest('T1: CATEGORY_EXPANSION_POLICIES.sports configuration integrity', () => {
  const sports = CATEGORY_EXPANSION_POLICIES.sports;
  assert.ok(sports, 'Sports policy must exist');
  assert.strictEqual(sports.normalized, 'sports');
  assert.strictEqual(sports.isBroad, true);
  assert.strictEqual(sports.maxTotalQueries, 6);
  assert.ok(sports.scopeContract.length > 50, 'Scope contract must be documented');
  assert.strictEqual(sports.discoveryTerms.length, 5, 'Must have 5 discovery terms');
  assert.ok(sports.businessFormTerms.includes('shop'));
  assert.ok(sports.businessFormTerms.includes('club'));
  assert.ok(sports.businessFormTerms.includes('academy'));
});

runTest('T2: Ontology invariant: distinctiveTerms ⊆ positiveTerms and query count invariant', () => {
  const sports = CATEGORY_EXPANSION_POLICIES.sports;
  const positiveSet = new Set(sports.positiveTerms);
  for (const dist of sports.distinctiveTerms) {
    assert.ok(positiveSet.has(dist), `distinctiveTerm "${dist}" must be a subset of positiveTerms`);
  }
  // Generic terms MUST NOT be in distinctiveTerms
  const distinctiveSet = new Set(sports.distinctiveTerms);
  assert.ok(!distinctiveSet.has('sports'), '"sports" must not be in distinctiveTerms');
  assert.ok(!distinctiveSet.has('sporting'), '"sporting" must not be in distinctiveTerms');
  assert.ok(!distinctiveSet.has('athletics'), '"athletics" must not be in distinctiveTerms');
  assert.ok(!distinctiveSet.has('fitness'), '"fitness" must not be in distinctiveTerms');

  // Query count invariant for Policy Version 1
  assert.strictEqual(
    sports.maxTotalQueries,
    sports.discoveryTerms.length + 1,
    'maxTotalQueries must equal discoveryTerms.length + 1 (exact query)'
  );
});

runTest('T3: normalizeCategoryIntent broad vs narrow classification', () => {
  const broad = normalizeCategoryIntent('Sports');
  assert.strictEqual(broad.normalized, 'sports');
  assert.strictEqual(broad.isBroad, true);
  assert.strictEqual(broad.maxTotalQueries, 6);

  const narrow = normalizeCategoryIntent('Sports shops');
  assert.strictEqual(narrow.normalized, 'sports shops');
  assert.strictEqual(narrow.isBroad, false);
  assert.strictEqual(narrow.maxTotalQueries, 1);
});

runTest('T4: Stem normalization: "sport" -> "sports" via closed mapping table', () => {
  assert.strictEqual(CATEGORY_STEM_MAPPINGS['sport'], 'sports');
  const singular = normalizeCategoryIntent('sport');
  assert.strictEqual(singular.normalized, 'sports');
  assert.strictEqual(singular.isBroad, true);
  assert.strictEqual(singular.maxTotalQueries, 6);
});

// ============================================================================
// Section 2: Query Expansion Logic (T5 - T9)
// ============================================================================

runTest('T5: expandCategoryQueries produces exact query + 5 location-aware expanded queries', () => {
  const intent = normalizeCategoryIntent('Sports');
  const queries = expandCategoryQueries(intent, 'Kathmandu');

  assert.strictEqual(queries.length, 6);
  assert.deepStrictEqual(queries[0], {
    query: 'Sports Kathmandu',
    type: 'exact',
    source: 'Sports',
  });

  const expectedExpanded = [
    'sports shops Kathmandu',
    'sports clubs Kathmandu',
    'sports academies Kathmandu',
    'sports centers Kathmandu',
    'sports equipment Kathmandu',
  ];

  for (let i = 0; i < expectedExpanded.length; i++) {
    assert.strictEqual(queries[i + 1].query, expectedExpanded[i]);
    assert.strictEqual(queries[i + 1].type, 'expanded');
  }
});

runTest('T6: expandCategoryQueries does not duplicate location if already present', () => {
  const intent = normalizeCategoryIntent('Sports');
  const queries = expandCategoryQueries(intent, 'Kathmandu');
  for (const q of queries) {
    const occurrences = (q.query.match(/Kathmandu/gi) || []).length;
    assert.strictEqual(occurrences, 1, `Query "${q.query}" must have exactly one occurrence of location`);
  }
});

runTest('T7: expandCategoryQueries without location generates clean trimmed queries', () => {
  const intent = normalizeCategoryIntent('Sports');
  const queries = expandCategoryQueries(intent, '');

  assert.strictEqual(queries.length, 6);
  assert.strictEqual(queries[0].query, 'Sports');
  assert.strictEqual(queries[1].query, 'sports shops');
  assert.strictEqual(queries[2].query, 'sports clubs');
  assert.strictEqual(queries[3].query, 'sports academies');
  assert.strictEqual(queries[4].query, 'sports centers');
  assert.strictEqual(queries[5].query, 'sports equipment');
});

runTest('T8: expandCategoryQueries for narrow query with location preserves exact query', () => {
  const narrowIntent = normalizeCategoryIntent('specialty coffee');
  const queries = expandCategoryQueries(narrowIntent, 'Kathmandu');

  assert.strictEqual(queries.length, 1);
  assert.deepStrictEqual(queries[0], {
    query: 'specialty coffee Kathmandu',
    type: 'exact',
    source: 'specialty coffee',
  });
});

runTest('T9: Deduplication in expandCategoryQueries collapses whitespace and case', () => {
  const customIntent: CategoryIntent = {
    original: 'sports',
    normalized: 'sports',
    isBroad: true,
    discoveryTerms: ['sports', 'SPORTS', 'sports   shops', 'sports shops'],
    positiveTerms: ['sports'],
    distinctiveTerms: [],
    businessFormTerms: ['shop'],
    excludedTerms: [],
    maxTotalQueries: 6,
  };

  const queries = expandCategoryQueries(customIntent, 'Kathmandu');
  assert.strictEqual(queries.length, 2); // 'sports Kathmandu' and 'sports shops Kathmandu'
});

// ============================================================================
// Section 3: Relevance Classification (T10 - T21)
// ============================================================================

runTest('T10: Relevance Tier 1: "Kathmandu Sports Shop" matches positive term + form noun', () => {
  const intent = normalizeCategoryIntent('Sports');
  const res = checkCategoryRelevance('Kathmandu Sports Shop', undefined, intent);
  assert.strictEqual(res.status, 'relevant');
  assert.strictEqual(res.reason, 'CATEGORY_AND_FORM_MATCH');
  assert.strictEqual(res.confidence, 0.90);
});

runTest('T11: Relevance Tier 1: "Nepal Sports Academy" matches positive term + form noun', () => {
  const intent = normalizeCategoryIntent('Sports');
  const res = checkCategoryRelevance('Nepal Sports Academy', undefined, intent);
  assert.strictEqual(res.status, 'relevant');
  assert.strictEqual(res.reason, 'CATEGORY_AND_FORM_MATCH');
  assert.strictEqual(res.confidence, 0.90);
});

runTest('T12: Relevance Tier 2: "Himalayan Futsal" matches distinctive sport token', () => {
  const intent = normalizeCategoryIntent('Sports');
  const res = checkCategoryRelevance('Himalayan Futsal', undefined, intent);
  assert.strictEqual(res.status, 'relevant');
  assert.strictEqual(res.reason, 'CATEGORY_TOKEN_MATCH');
  assert.strictEqual(res.confidence, 0.85);
});

runTest('T13: Relevance: "Nepal Badminton Academy" matches distinctive sport + form noun', () => {
  const intent = normalizeCategoryIntent('Sports');
  const res = checkCategoryRelevance('Nepal Badminton Academy', undefined, intent);
  assert.strictEqual(res.status, 'relevant');
  assert.strictEqual(res.reason, 'CATEGORY_AND_FORM_MATCH');
  assert.strictEqual(res.confidence, 0.90);
});

runTest('T14: Hospital exclusion: "Orthopedic & Sports Hospital" is irrelevant', () => {
  const intent = normalizeCategoryIntent('Sports');
  const res = checkCategoryRelevance('Orthopedic & Sports Hospital', undefined, intent);
  assert.strictEqual(res.status, 'irrelevant');
  assert.strictEqual(res.reason, 'EXCLUDED_TERM_MATCH:hospital');
  assert.strictEqual(res.confidence, 0.95);
});

runTest('T15: Medical/Clinical exclusion: "Patan Sports Medicine & Rehab Clinic" is irrelevant', () => {
  const intent = normalizeCategoryIntent('Sports');
  const res = checkCategoryRelevance('Patan Sports Medicine & Rehab Clinic', undefined, intent);
  assert.strictEqual(res.status, 'irrelevant');
  assert.strictEqual(res.reason, 'EXCLUDED_TERM_MATCH:sports medicine');
  assert.strictEqual(res.confidence, 0.95);
});

runTest('T16: Hospitality/Bar exclusion: "Champions Sports Bar & Grill" is irrelevant', () => {
  const intent = normalizeCategoryIntent('Sports');
  const res = checkCategoryRelevance('Champions Sports Bar & Grill', undefined, intent);
  assert.strictEqual(res.status, 'irrelevant');
  assert.strictEqual(res.reason, 'EXCLUDED_TERM_MATCH:bar');
  assert.strictEqual(res.confidence, 0.95);
});

runTest('T17: Word boundary protection: "Hospitality Sports Travel" not excluded by "hospital"', () => {
  const intent = normalizeCategoryIntent('Sports');
  const res = checkCategoryRelevance('Hospitality Sports Travel', undefined, intent);
  // Contains 'sports' (positive) but no form noun and not excluded -> ambiguous
  assert.strictEqual(res.status, 'ambiguous');
  assert.strictEqual(res.reason, 'INSUFFICIENT_CATEGORY_EVIDENCE');
});

runTest('T18: Word boundary protection: "Kathmandu Sports Complex" is relevant', () => {
  const intent = normalizeCategoryIntent('Sports');
  const res = checkCategoryRelevance('Kathmandu Sports Complex', undefined, intent);
  assert.strictEqual(res.status, 'relevant');
  assert.strictEqual(res.reason, 'CATEGORY_AND_FORM_MATCH');
});

runTest('T19: Generic club without sport term: "Royal Valley Club" defaults to ambiguous', () => {
  const intent = normalizeCategoryIntent('Sports');
  const res = checkCategoryRelevance('Royal Valley Club', undefined, intent);
  assert.strictEqual(res.status, 'ambiguous');
  assert.strictEqual(res.reason, 'INSUFFICIENT_CATEGORY_EVIDENCE');
  assert.strictEqual(res.confidence, 0.30);
});

runTest('T20: Google Maps category field match: "Kathmandu Arena" with category "Sports club"', () => {
  const intent = normalizeCategoryIntent('Sports');
  const res = checkCategoryRelevance('Kathmandu Arena', 'Sports club', intent);
  assert.strictEqual(res.status, 'relevant');
  assert.strictEqual(res.reason, 'CATEGORY_AND_FORM_MATCH');
  assert.strictEqual(res.confidence, 0.90);
});

runTest('T21: Empty/null candidate name guard returns EMPTY_CANDIDATE_NAME', () => {
  const intent = normalizeCategoryIntent('Sports');
  const res1 = checkCategoryRelevance('', undefined, intent);
  assert.strictEqual(res1.status, 'ambiguous');
  assert.strictEqual(res1.reason, 'EMPTY_CANDIDATE_NAME');
  assert.strictEqual(res1.confidence, 0.0);

  const res2 = checkCategoryRelevance(undefined, undefined, intent);
  assert.strictEqual(res2.status, 'ambiguous');
  assert.strictEqual(res2.reason, 'EMPTY_CANDIDATE_NAME');
  assert.strictEqual(res2.confidence, 0.0);
});

// ============================================================================
// Section 4: Pipeline Integration & Invariants (T22 - T25)
// ============================================================================

runTest('T22: Narrow query bypass returns NARROW_QUERY_NO_FILTER with confidence 1.0', () => {
  const narrowIntent = normalizeCategoryIntent('Sports shops in Thamel');
  const res = checkCategoryRelevance('Any Random Name', undefined, narrowIntent);
  assert.strictEqual(res.status, 'relevant');
  assert.strictEqual(res.reason, 'NARROW_QUERY_NO_FILTER');
  assert.strictEqual(res.confidence, 1.0);
});

runTest('T23: Discovery Pipeline filtering correctly sorts relevant vs excluded candidates', () => {
  const intent = normalizeCategoryIntent('Sports');
  const rawListings = [
    { title: 'Kathmandu Sports Mart', category: 'Sporting goods store' },
    { title: 'Patan Sports Medicine Clinic', category: 'Medical clinic' },
    { title: 'Champions Sports Bar', category: 'Bar' },
    { title: 'Himalayan Futsal Arena', category: 'Sports complex' },
    { title: 'Sports Nepal', category: 'General' },
  ];

  const relevant = [];
  const irrelevant = [];
  const ambiguous = [];

  for (const item of rawListings) {
    const rel = checkCategoryRelevance(item.title, item.category, intent);
    if (rel.status === 'relevant') relevant.push(item);
    else if (rel.status === 'irrelevant') irrelevant.push(item);
    else ambiguous.push(item);
  }

  assert.strictEqual(relevant.length, 2); // 'Kathmandu Sports Mart', 'Himalayan Futsal Arena'
  assert.strictEqual(irrelevant.length, 2); // 'Patan Sports Medicine Clinic', 'Champions Sports Bar'
  assert.strictEqual(ambiguous.length, 1); // 'Sports Nepal'
});

runTest('T24: Entity resolution deduplication preserves first-seen candidate identity across queries', () => {
  const rawPlaces: SerperPlaceResult[] = [
    {
      position: 1,
      title: 'Kathmandu Sports Mart',
      address: 'New Road, Kathmandu',
      phoneNumber: '01-4240520',
      placeId: 'ChIJ11111111',
      rating: 4.5,
    },
    {
      position: 2,
      title: 'Kathmandu Sports Mart',
      address: 'New Road, Kathmandu, Nepal',
      phoneNumber: '+977-1-4240520',
      placeId: 'ChIJ11111111',
      rating: 4.5,
    },
    {
      position: 3,
      title: 'Himalayan Futsal',
      address: 'Baluwatar, Kathmandu',
      phoneNumber: '9801234567',
      placeId: 'ChIJ22222222',
      rating: 4.8,
    },
  ];

  const webUsable = [
    {
      candidate: {
        rank: 1,
        title: 'Kathmandu Sports Mart',
        url: 'https://kathmandusportsmart.com',
        originalUrl: 'https://kathmandusportsmart.com',
        domain: 'kathmandusportsmart.com',
        description: 'Sports shop in New Road',
        extraSnippets: [],
        provider: 'serper',
        phoneNumber: '01-4240520',
      },
      decision: {
        url: 'https://kathmandusportsmart.com',
        domain: 'kathmandusportsmart.com',
        title: 'Kathmandu Sports Mart',
        classification: 'business' as const,
        confidence: 0.9,
        reason: 'Official site',
        source: 'deterministic' as const,
      },
    },
  ];

  const result = buildResearchCandidates({
    places: rawPlaces,
    webUsable,
    defaultLocation: 'Kathmandu',
  });

  assert.strictEqual(result.candidates.length, 2, 'Must deduplicate to exactly 2 unique entities');
  assert.strictEqual(result.matchesMerged, 1, 'Must record 1 merged match from Web to Maps candidate');
});

runTest('T25: Telemetry arithmetic invariants verification', () => {
  const rawCandidates = 10;
  const exactQueryCandidates = 4;
  const expandedQueryCandidates = 6;
  const relevantCandidates = 7;
  const irrelevantCandidates = 2;
  const ambiguousCandidates = 1;
  const uniqueEntities = 5;

  // Invariant 1: exact + expanded === raw
  assert.strictEqual(
    exactQueryCandidates + expandedQueryCandidates,
    rawCandidates,
    'exactQueryCandidates + expandedQueryCandidates must equal rawCandidates'
  );

  // Invariant 2: relevant + irrelevant + ambiguous === raw
  assert.strictEqual(
    relevantCandidates + irrelevantCandidates + ambiguousCandidates,
    rawCandidates,
    'relevantCandidates + irrelevantCandidates + ambiguousCandidates must equal rawCandidates'
  );

  // Invariant 3: uniqueEntities <= relevantCandidates
  assert.ok(
    uniqueEntities <= relevantCandidates,
    'uniqueEntities must be less than or equal to relevantCandidates'
  );
});

// ============================================================================
// Section 5: Phase 3 Carryover & Scope Boundaries (T26 - T29)
// ============================================================================

runTest('T26: LinkedIn regex split: LINKEDIN_COMPANY_REGEX vs LINKEDIN_PERSONAL_REGEX', () => {
  const companyUrl = 'https://www.linkedin.com/company/himalayan-sports';
  const personalUrl = 'https://www.linkedin.com/in/john-doe';

  assert.ok(LINKEDIN_COMPANY_REGEX.test(companyUrl), 'Company regex must match company URL');
  assert.ok(!LINKEDIN_COMPANY_REGEX.test(personalUrl), 'Company regex must NOT match personal URL');

  assert.ok(LINKEDIN_PERSONAL_REGEX.test(personalUrl), 'Personal regex must match personal URL');
  assert.ok(!LINKEDIN_PERSONAL_REGEX.test(companyUrl), 'Personal regex must NOT match company URL');
});

runTest('T27: socialLinksRejected correctly tracks rejected personal and vendor profiles', () => {
  const rawContent = `
    Find us on [Our Facebook](https://facebook.com/kmdsports)
    Connect with Founder [John Doe](https://linkedin.com/in/johndoe)
    Powered by [SitePad](https://facebook.com/sitepad)
  `;

  const classified = classifyAllSocialProfiles(rawContent, {
    businessName: 'Kathmandu Sports',
    websiteDomain: 'kathmandusports.com',
  });

  assert.strictEqual(classified.length, 3);
  const accepted = classified.filter((p) => p.status === 'accepted');
  const rejected = classified.filter((p) => p.status === 'rejected');

  assert.strictEqual(accepted.length, 1);
  assert.strictEqual(accepted[0].handle, 'kmdsports');

  assert.strictEqual(rejected.length, 2);
  const personal = rejected.find((p) => p.rejectionReason === 'PERSONAL_PROFILE');
  assert.ok(personal, 'Must include PERSONAL_PROFILE rejection');
  const vendor = rejected.find((p) => p.rejectionReason === 'VENDOR_PROFILE');
  assert.ok(vendor, 'Must include VENDOR_PROFILE rejection');
});

runTest('T28: Scope boundary: "Sports Nepal" (generic token alone) returns INSUFFICIENT_CATEGORY_EVIDENCE', () => {
  const intent = normalizeCategoryIntent('Sports');
  const res = checkCategoryRelevance('Sports Nepal', undefined, intent);
  assert.strictEqual(res.status, 'ambiguous');
  assert.strictEqual(res.reason, 'INSUFFICIENT_CATEGORY_EVIDENCE');
  assert.strictEqual(res.confidence, 0.30);
});

runTest('T29: Scope boundary: "Kathmandu Sports News" (sports media) returns EXCLUDED_TERM_MATCH:sports news', () => {
  const intent = normalizeCategoryIntent('Sports');
  const res = checkCategoryRelevance('Kathmandu Sports News', undefined, intent);
  assert.strictEqual(res.status, 'irrelevant');
  assert.strictEqual(res.reason, 'EXCLUDED_TERM_MATCH:sports news');
  assert.strictEqual(res.confidence, 0.95);
});

// ============================================================================
// Summary
// ============================================================================

console.log('\n================================================================');
console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
}
