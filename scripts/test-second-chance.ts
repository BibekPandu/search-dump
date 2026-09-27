import {
  runWebsiteDiscoveryGate,
  buildSecondChanceQuery,
  isEducationCandidate,
  EDUCATION_RUN_CATEGORIES,
  type DiscoveryLookupResult,
} from '@/services/discovery/website-discovery-gate.service';
import { detectBusinessCategory } from '@/services/resolution/entity-resolution.service';
import {
  selectFirstPartyWebsiteUrl,
  requiredNameOverlap,
  MIN_FIRST_PARTY_SCORE,
} from '@/services/discovery/website-search-ranker.service';
import { isUsableOfficialWebsite } from '@/services/resolution/entity-resolution.service';
import type { SerperPlaceResult } from '@/services/external/serper-places.service';

// ============================================================================
// Phase 7a Task 5 — Bounded Second-Chance Query Generator (OFFLINE, ZERO API)
// ============================================================================
// Acceptance criteria verified here:
//   [ ] Templates are deterministic: education -> '"{name}" "{location}" site:.edu.np',
//       everything else -> '"{name}" "{location}" official'
//   [ ] At most ONE refined query per candidate (hard bound: <= 2 searches total)
//   [ ] Second chance fires ONLY when Pass 1 yields no first-party URL
//   [ ] Phone-only lookups (Maps website present) never consume a second chance
//   [ ] Run-level lookup budget (Task 2) still bounds everything
//   [ ] All queries recorded in provenance
//   [ ] Recovery test: Pass 1 directories only -> Pass 2 first-party site selected
//   [ ] Negative test: both passes directories -> exhausted/third-party, no phone
//   [ ] Carry-forwards: MIN_FIRST_PARTY_SCORE floor, substring boundary,
//       strict-majority threshold table

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

function makePlace(id: string, overrides: Partial<SerperPlaceResult> = {}): SerperPlaceResult {
  return {
    position: 1,
    title: `Business ${id}`,
    address: 'Satungal, Kathmandu',
    rating: 4.5,
    ratingCount: 100,
    category: 'School',
    phoneNumber: undefined,
    placeId: id,
    ...overrides,
  };
}

function result(url: string, title: string, description: string) {
  return { url, title, description };
}

/** The workflow's exact composition (ranker + usability gate). */
function rankerSelector(
  place: SerperPlaceResult,
  results: Array<{ url: string; title?: string; description?: string; extraSnippets?: string[] }>
): { url?: string; reason?: string } | undefined {
  const selection = selectFirstPartyWebsiteUrl({
    results,
    businessName: place.title,
    location: place.address,
    isUsable: (c) =>
      isUsableOfficialWebsite(c.url, place.title, place.category || place.type, c.title),
  });
  return { url: selection.url, reason: selection.reason };
}

async function runTests() {
  console.log('===============================================================');
  console.log('🧪 BOUNDED SECOND-CHANCE QUERY GENERATOR TESTS (ZERO API)');
  console.log('===============================================================\n');

  // --- 1. Deterministic templates ---
  console.log('--- 1. Deterministic query templates ---');
  const school = makePlace('q1', { title: 'Ever Vision School' });
  const educationQuery = buildSecondChanceQuery(school, {
    runCategory: 'schools',
    location: 'Satungal, Kathmandu',
  });
  assert(
    educationQuery === '"Ever Vision School" "Satungal, Kathmandu" site:.edu.np',
    `Education template: '"{name}" "{location}" site:.edu.np' (got "${educationQuery}")`
  );

  const cafe = makePlace('q2', { title: 'Himalayan Cafe', category: 'Cafe' });
  const cafeQuery = buildSecondChanceQuery(cafe, {
    runCategory: 'cafes',
    location: 'Kathmandu',
  });
  assert(
    cafeQuery === '"Himalayan Cafe" "Kathmandu" official',
    `Non-education template: '"{name}" "{location}" official' (got "${cafeQuery}")`
  );

  const noLocation = buildSecondChanceQuery(school, { runCategory: 'schools' });
  assert(
    noLocation === '"Ever Vision School" site:.edu.np',
    `Missing location degrades gracefully (got "${noLocation}")`
  );

  const repeat = buildSecondChanceQuery(school, {
    runCategory: 'schools',
    location: 'Satungal, Kathmandu',
  });
  assert(repeat === educationQuery, 'Identical input → identical query (deterministic)');

  // --- 2. Education gating (Option B: run category OR candidate category) ---
  console.log('\n--- 2. Education gating (run category rescues token-less names) ---');
  const noEducationSignal = makePlace('q3', { title: 'Ever Vision', category: 'Local Business' });
  assert(
    isEducationCandidate(noEducationSignal, 'schools') === true,
    'Run category "schools" fires for a name with no education token (Residual 3, Option B)'
  );
  assert(
    isEducationCandidate(noEducationSignal, 'restaurants') === false &&
      buildSecondChanceQuery(noEducationSignal, { runCategory: 'restaurants', location: 'Satungal' }) ===
        '"Ever Vision" "Satungal" official',
    'Non-education run + non-education candidate uses the official template'
  );
  assert(
    isEducationCandidate(makePlace('q4', { title: 'ABC Academy' }), 'cafes') === true,
    'Per-candidate detection (academy) fires even for a non-education run'
  );
  assert(
    detectBusinessCategory('Ever Vision School', 'Educational institution') === 'education',
    "'educational' keyword addition detects Maps category 'Educational institution'"
  );
  assert(EDUCATION_RUN_CATEGORIES.has('schools'), 'Closed run-category mapping contains schools');

  // --- 3. Recovery: Pass 1 directories only, Pass 2 finds the first-party site ---
  console.log('\n--- 3. Second-chance recovery ---');
  const recover = makePlace('r1', { title: 'Ever Vision School' });
  let pass1Calls = 0;
  let pass2Calls = 0;
  const summary3 = await runWebsiteDiscoveryGate({
    places: [recover],
    lookupBudget: 5,
    selectFirstPartyUrl: rankerSelector,
    selectPhone: (p) => {
      if (!p.businessDomain) return undefined;
      return undefined; // phone policy exercised in Task 4.5 suite; not the focus here
    },
    secondChanceQuery: (place) =>
      buildSecondChanceQuery(place, { runCategory: 'schools', location: 'Satungal, Kathmandu' }),
    lookup: async (): Promise<DiscoveryLookupResult> => {
      pass1Calls++;
      return {
        queries: ['Ever Vision School Satungal, Kathmandu'],
        results: [
          result(
            'https://school-directory.example/school/ever-vision-school',
            'Ever Vision School directory page',
            'Directory hotline: 01-1111111'
          ),
        ],
      };
    },
    refinedLookup: async (_place, query): Promise<DiscoveryLookupResult> => {
      pass2Calls++;
      return {
        queries: [query],
        results: [
          result(
            'https://ever-vision.edu.np',
            'Ever Vision School | Satungal, Kathmandu',
            'Official website. Office: 01-4470777'
          ),
        ],
      };
    },
  });

  assert(pass1Calls === 1 && pass2Calls === 1, 'Exactly one Pass 1 and one Pass 2 search');
  assert(
    recover.website === 'https://ever-vision.edu.np',
    `The second chance recovered the first-party website (got ${recover.website})`
  );
  assert(
    recover.discoveryState === 'DISCOVERY_FOUND_FIRST_PARTY',
    'State upgraded to first-party after the refined query'
  );
  const record3 = summary3.records[0];
  assert(
    record3.queries.length === 2 &&
      record3.queries[1] === '"Ever Vision School" "Satungal, Kathmandu" site:.edu.np',
    'Both queries recorded in provenance, refined query last'
  );
  assert(
    record3.resultsReviewed === 2,
    `Results reviewed accumulate across passes (got ${record3.resultsReviewed})`
  );
  assert(record3.secondChanceAttempted === true, 'Second-chance attempt recorded');

  // --- 4. Negative: both passes directories-only ---
  console.log('\n--- 4. Negative: refined query also yields no first-party ---');
  const negative = makePlace('n1', { title: 'Ever Vision School' });
  const summary4 = await runWebsiteDiscoveryGate({
    places: [negative],
    lookupBudget: 5,
    selectFirstPartyUrl: rankerSelector,
    secondChanceQuery: (place) =>
      buildSecondChanceQuery(place, { runCategory: 'schools', location: 'Satungal, Kathmandu' }),
    lookup: async (): Promise<DiscoveryLookupResult> => ({
      queries: ['Ever Vision School Satungal, Kathmandu'],
      results: [
        result(
          'https://school-directory.example/school/ever-vision-school',
          'Ever Vision School directory page',
          'Hotline 01-1111111'
        ),
      ],
    }),
    refinedLookup: async (_place, query): Promise<DiscoveryLookupResult> => ({
      queries: [query],
      results: [
        result(
          'https://listings-network.example/listings/ever-vision-school',
          'Ever Vision School listing',
          'Hotline 01-2222222'
        ),
      ],
    }),
  });
  assert(
    negative.discoveryState === 'DISCOVERY_FOUND_ONLY_THIRD_PARTY' && !negative.website,
    'No first-party site attached after both passes'
  );
  assert(
    summary4.records[0].queries.length === 2 && summary4.records[0].secondChanceAttempted === true,
    'The attempted (but unsuccessful) second chance is recorded'
  );

  // --- 5. Bounding: max 2 searches per candidate; no second chance for phone-only ---
  console.log('\n--- 5. Hard bounds ---');
  const boundCandidates = [
    makePlace('b1', { title: 'Ever Vision School' }),
    makePlace('b2', { title: 'Ever Vision School' }),
    makePlace('b3', { title: 'Ever Vision School' }),
  ];
  let lookups5 = 0;
  let refined5 = 0;
  await runWebsiteDiscoveryGate({
    places: boundCandidates,
    lookupBudget: 2,
    selectFirstPartyUrl: rankerSelector,
    secondChanceQuery: (place) =>
      buildSecondChanceQuery(place, { runCategory: 'schools', location: 'Satungal' }),
    lookup: async (): Promise<DiscoveryLookupResult> => {
      lookups5++;
      return { queries: ['Ever Vision School Satungal'], results: [] };
    },
    refinedLookup: async (_place, query): Promise<DiscoveryLookupResult> => {
      refined5++;
      return { queries: [query], results: [] };
    },
  });
  assert(lookups5 === 2, `Run budget 2 → exactly 2 Pass 1 lookups (got ${lookups5})`);
  assert(refined5 === 2, `At most one refined query per looked-up candidate (got ${refined5})`);

  const phoneOnly = makePlace('po1', {
    title: 'Ever Vision School',
    website: 'https://ever-vision.edu.np',
  });
  let refinedPhoneOnly = 0;
  await runWebsiteDiscoveryGate({
    places: [phoneOnly],
    lookupBudget: 5,
    secondChanceQuery: (place) =>
      buildSecondChanceQuery(place, { runCategory: 'schools', location: 'Satungal' }),
    lookup: async (): Promise<DiscoveryLookupResult> => ({
      queries: ['Ever Vision School Satungal'],
      results: [],
    }),
    refinedLookup: async (_place, query): Promise<DiscoveryLookupResult> => {
      refinedPhoneOnly++;
      return { queries: [query], results: [] };
    },
  });
  assert(
    refinedPhoneOnly === 0,
    'Phone-only lookups (Maps website present) never consume a second chance'
  );

  // --- 6. Back-compat: second chance requires BOTH callbacks ---
  console.log('\n--- 6. Back-compat gating ---');
  const noRefined = makePlace('nr1', { title: 'Ever Vision School' });
  const summary6 = await runWebsiteDiscoveryGate({
    places: [noRefined],
    lookupBudget: 5,
    selectFirstPartyUrl: rankerSelector,
    secondChanceQuery: (place) =>
      buildSecondChanceQuery(place, { runCategory: 'schools', location: 'Satungal' }),
    lookup: async (): Promise<DiscoveryLookupResult> => ({
      queries: ['Ever Vision School Satungal'],
      results: [
        result(
          'https://school-directory.example/school/ever-vision-school',
          'Ever Vision School directory page',
          'Hotline 01-1111111'
        ),
      ],
    }),
  });
  assert(
    summary6.records[0].queries.length === 1 && !noRefined.website,
    'secondChanceQuery without refinedLookup → no second search'
  );

  const noBuilder = makePlace('nb1', { title: 'Ever Vision School' });
  const summary7 = await runWebsiteDiscoveryGate({
    places: [noBuilder],
    lookupBudget: 5,
    selectFirstPartyUrl: rankerSelector,
    lookup: async (): Promise<DiscoveryLookupResult> => ({
      queries: ['Ever Vision School Satungal'],
      results: [
        result(
          'https://school-directory.example/school/ever-vision-school',
          'Ever Vision School directory page',
          'Hotline 01-1111111'
        ),
      ],
    }),
    refinedLookup: async (_place, query): Promise<DiscoveryLookupResult> => ({
      queries: [query],
      results: [],
    }),
  });
  assert(
    summary7.records[0].queries.length === 1,
    'refinedLookup without secondChanceQuery → no second search'
  );

  // --- 7. Carry-forward: strict-majority threshold table ---
  console.log('\n--- 7. Strict-majority threshold table (walkthrough artifact) ---');
  assert(requiredNameOverlap(1) === 1, '1 token → 1 (location-fallback rule)');
  assert(requiredNameOverlap(2) === 2, '2 tokens → both required');
  assert(requiredNameOverlap(3) === 2, '3 tokens → 2 (strict majority)');
  assert(requiredNameOverlap(4) === 3, '4 tokens → 3 (High New Vision fixture)');
  assert(requiredNameOverlap(5) === 3, '5 tokens → 3');
  assert(requiredNameOverlap(6) === 4, '6 tokens → 4');

  // --- 8. Carry-forward: substring false-positive boundary ---
  console.log('\n--- 8. Substring boundary: "Ever" vs forever.com ---');
  const forever = selectFirstPartyWebsiteUrl({
    results: [candidate('https://forever.com', 'Forever')],
    businessName: 'Ever',
    location: 'Kathmandu',
  });
  assert(
    forever.url === undefined,
    'Substring match inside "forever" cannot satisfy the single-token rule (location mismatch)'
  );
  const genuine = selectFirstPartyWebsiteUrl({
    results: [candidate('https://ever.com.np', 'Ever, Kathmandu')],
    businessName: 'Ever',
    location: 'Kathmandu',
  });
  assert(
    genuine.url === 'https://ever.com.np',
    'A genuine single-token candidate with a location match is still selected'
  );

  // --- 9. Carry-forward: MIN_FIRST_PARTY_SCORE floor semantics ---
  console.log('\n--- 9. MIN_FIRST_PARTY_SCORE floor ---');
  assert(
    MIN_FIRST_PARTY_SCORE === 40,
    `Floor constant pinned at 40 (Satungal Class A; got ${MIN_FIRST_PARTY_SCORE})`
  );
  // Host-only identity + floor: both distinctive tokens must appear in the host
  // (2-token name 'Alpha Optics' on alphaoptics.xyz), root path, 'other' TLD:
  // name tokens +24, all-in-domain +10, tld other +2, root +6 → score 42.
  const minimalSelection = selectFirstPartyWebsiteUrl({
    results: [candidate('https://alphaoptics.xyz', 'Alpha Optics Kathmandu spare parts')],
    businessName: 'Alpha Optics',
  });
  assert(
    minimalSelection.url === 'https://alphaoptics.xyz',
    `The minimal eligible host-matched candidate (score >= 40) is accepted (got ${minimalSelection.url ?? 'none'})`
  );
  assert(
    MIN_FIRST_PARTY_SCORE <= 42,
    'Floor sits at or below the provable minimum eligible host-matched score'
  );
  // Text-only path match (defect band 16-32) must never clear the floor.
  const textOnlyFloor = selectFirstPartyWebsiteUrl({
    results: [candidate('https://optics-xyz.xyz/a/b/c', 'Alpha Optics Kathmandu spare parts')],
    businessName: 'Alpha Optics',
  });
  assert(
    textOnlyFloor.url === undefined,
    'Text-only / path-only brand match stays below the floor'
  );

  // --- 10. Duplicate-query refund safety & 'educational' category conflict ---
  console.log('\n--- 10. Duplicate-query skip & educational category conflict ---');
  let duplicateLookups = 0;
  const duplicateQueryCandidate = makePlace('dup-query-1', { title: 'Identical Query School', address: 'Kathmandu' });
  const duplicateQueryStr = `${duplicateQueryCandidate.title} ${duplicateQueryCandidate.address}`.trim();

  const dupSummary = await runWebsiteDiscoveryGate({
    places: [duplicateQueryCandidate],
    lookupBudget: 5,
    lookup: async (place) => {
      duplicateLookups++;
      return { queries: [duplicateQueryStr], results: [candidate('https://directory.com/x', 'Dir')] };
    },
    selectFirstPartyUrl: rankerSelector,
    secondChanceQuery: () => duplicateQueryStr, // Intentionally returns identical query string as Pass 1
    refinedLookup: async () => {
      duplicateLookups++;
      return { queries: [duplicateQueryStr], results: [] };
    },
  });

  assert(duplicateLookups === 1, 'Duplicate query string matching Pass 1 query is NOT re-sent (lookup count === 1)');
  assert(dupSummary.records[0].queries.length === 1, 'Record carries only the single non-duplicate query');
  assert(dupSummary.records[0].secondChanceAttempted !== true, 'secondChanceAttempted remains false when query is duplicate');

  // 'educational' keyword conflict check (Phase 7a review check)
  const eduPass = isUsableOfficialWebsite('https://evervision.edu.np', 'Ever Vision', 'Educational institution');
  assert(eduPass === true, "Educational institution Maps category allows legitimate educational site (no conflict)");
  const eduConflict = isUsableOfficialWebsite('https://hotelannapurna.com', 'Ever Vision', 'Educational institution');
  assert(eduConflict === false, "Educational institution Maps category strictly rejects conflicting hotel site");

  console.log('\n===============================================================');
  console.log('🎉 BOUNDED SECOND-CHANCE QUERY GENERATOR TESTS PASSED (100%)');
  console.log('===============================================================');
}

function candidate(url: string, title: string, description = '') {
  return { url, title, description };
}

try {
  runTests();
} catch (err) {
  console.error('Test failed:', err);
  process.exit(1);
}
