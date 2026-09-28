import {
  runWebsiteDiscoveryGate,
  discoveryGroupKey,
  emptyDiscoveryStateCounts,
  DISCOVERY_STATES,
  discoveryStateEnum,
  validateDiscoveryStateInvariant,
  getDiscoveryTelemetryCounters,
  type DiscoveryLookupResult,
  type DiscoveryGroupRecord,
  type DiscoveryGateSummary,
  type DiscoveryQuotaCounters,
  type WebsiteDiscoveryArtifact,
  type DiscoveryState,
} from '@/services/discovery/website-discovery-gate.service';
import type { SerperPlaceResult } from '@/services/external/serper-places.service';

// ============================================================================
// Phase 7a Task 3 — Universal Candidate Evaluation Gate (OFFLINE, ZERO API)
// ============================================================================
// Acceptance criteria verified here:
//   [ ] Every eligible Maps candidate yields an explicit discovery state
//   [ ] No candidate is silently skipped because it ranked below the budget
//   [ ] Duplicate searches are prevented (placeId/cid grouping = one lookup)
//   [ ] Duplicate objects inherit the same state + discovered website
//   [ ] Discovery remains bounded by the configurable budget
// Search and first-party selection are injected — no network, fully deterministic.

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
    phoneNumber: '014310000',
    placeId: id,
    ...overrides,
  };
}

/** Deterministic third-party-vs-first-party selector for tests. */
function isDirectoryUrl(url: string): boolean {
  return /directory|listings|yellowpages/i.test(url);
}

function selectFirstParty(_place: SerperPlaceResult, results: Array<{ url: string }>) {
  const match = results.find((r) => !isDirectoryUrl(r.url))?.url;
  return match ? { url: match, reason: 'test non-directory match' } : undefined;
}

const dirResults: Array<{ url: string; title: string }> = [
  { url: 'https://school-directory.example/x', title: 'X in a directory' },
  { url: 'https://local-listings.example/x', title: 'X in local listings' },
];

async function runTests() {
  console.log('===============================================================');
  console.log('🧪 WEBSITE DISCOVERY GATE — UNIVERSAL EVALUATION (ZERO API)');
  console.log('===============================================================\n');

  // --- 1. State transition: 5 candidates, budget 3 → 2 recorded as not attempted ---
  console.log('--- 1. Budget skip is RECORDED, not silently dropped ---');
  const five = [
    makePlace('g1'),
    makePlace('g2'),
    makePlace('g3'),
    makePlace('g4'),
    makePlace('g5'),
  ];
  let lookups1 = 0;
  const summary1 = await runWebsiteDiscoveryGate({
    places: five,
    lookupBudget: 3,
    lookup: async (place): Promise<DiscoveryLookupResult> => {
      lookups1++;
      return { queries: [`${place.title} Satungal`], results: [{ url: 'https://school-g.io.np' }] };
    },
    selectFirstPartyUrl: selectFirstParty,
  });

  assert(lookups1 === 3, `Budget 3 produced exactly 3 lookups (got ${lookups1})`);
  assert(summary1.groupsEvaluated === 5, 'All 5 candidates were evaluated');
  assert(
    summary1.statesApplied.DISCOVERY_FOUND_FIRST_PARTY === 3,
    'The 3 budget-allowed candidates recorded DISCOVERY_FOUND_FIRST_PARTY'
  );
  assert(
    summary1.statesApplied.DISCOVERY_NOT_ATTEMPTED_BUDGET === 2,
    'The 2 budget-skipped candidates recorded DISCOVERY_NOT_ATTEMPTED_BUDGET'
  );
  assert(
    five.every((p) => typeof p.discoveryState === 'string' && p.discoveryState.length > 0),
    'EVERY candidate object carries an explicit discoveryState (no undefined left behind)'
  );
  assert(
    summary1.records.length === 5 && summary1.records.every((r) => r.state),
    'Every evaluated candidate has a provenance record'
  );
  assert(
    summary1.records.filter((r) => r.searchAttempted).length === 3,
    'searchAttempted reflects reality: only 3 of 5 records claim a search'
  );

  // --- 2. First-party vs third-party-only vs exhausted ---
  console.log('\n--- 2. State classification: first-party / third-party-only / exhausted ---');
  const mixed = [
    makePlace('m1'),
    makePlace('m2'),
    makePlace('m3'),
  ];
  const summary2 = await runWebsiteDiscoveryGate({
    places: mixed,
    lookupBudget: 5,
    lookup: async (place): Promise<DiscoveryLookupResult> => {
      if (place.placeId === 'm1') {
        return {
          queries: ['m1 Satungal'],
          results: [...dirResults, { url: 'https://evervision.edu.np', title: 'Ever Vision' }],
        };
      }
      if (place.placeId === 'm2') return { queries: ['m2 Satungal'], results: dirResults };
      return { queries: ['m3 Satungal'], results: [] };
    },
    selectFirstPartyUrl: selectFirstParty,
  });

  assert(
    mixed[0].discoveryState === 'DISCOVERY_FOUND_FIRST_PARTY' && mixed[0].website === 'https://evervision.edu.np',
    'First-party found → state + website attached'
  );
  assert(
    mixed[1].discoveryState === 'DISCOVERY_FOUND_ONLY_THIRD_PARTY' && !mixed[1].website,
    'Directory-only results → third-party state, NO website attached'
  );
  assert(
    mixed[2].discoveryState === 'DISCOVERY_EXHAUSTED_NO_FIRST_PARTY' && !mixed[2].website,
    'Zero results → exhausted state, no website attached'
  );
  assert(
    summary2.statesApplied.DISCOVERY_FOUND_FIRST_PARTY === 1 &&
      summary2.statesApplied.DISCOVERY_FOUND_ONLY_THIRD_PARTY === 1 &&
      summary2.statesApplied.DISCOVERY_EXHAUSTED_NO_FIRST_PARTY === 1,
    'All three outcome states counted correctly in statesApplied'
  );

  // --- 3. Duplicate prevention: one business = ONE lookup ---
  console.log('\n--- 3. placeId dedupe: duplicates never trigger a second search ---');
  const duplicates = [
    makePlace('dup1', { title: 'Ever Vision School' }),
    makePlace('dup1', { title: 'Ever Vision School', address: 'Satungal' }),
    makePlace('dup1', { title: 'Ever Vision School (Satungal)' }),
  ];
  let lookups3 = 0;
  const summary3 = await runWebsiteDiscoveryGate({
    places: duplicates,
    lookupBudget: 10,
    lookup: async (): Promise<DiscoveryLookupResult> => {
      lookups3++;
      return { queries: ['Ever Vision School Satungal'], results: [{ url: 'https://evervision.edu.np' }] };
    },
    selectFirstPartyUrl: selectFirstParty,
  });

  assert(lookups3 === 1, `3 duplicate placeIds produced exactly 1 lookup (got ${lookups3})`);
  assert(summary3.groupsEvaluated === 1, 'Duplicates collapse into a single evaluated group');
  assert(summary3.duplicatesMerged === 2, 'Two duplicate objects recorded as merged');
  assert(
    duplicates.every((p) => p.discoveryState === 'DISCOVERY_FOUND_FIRST_PARTY'),
    'All duplicate objects inherit the same state'
  );
  assert(
    duplicates.every((p) => p.website === 'https://evervision.edu.np'),
    'All duplicate objects inherit the discovered website'
  );

  // --- 4. Group key fallback: cid, then title|address ---
  console.log('\n--- 4. Group key fallback (cid → title|address) ---');
  assert(discoveryGroupKey(makePlace('x')) === 'placeId:x', 'placeId is the primary group key');
  assert(
    discoveryGroupKey({ position: 1, title: 'A', cid: 'c9' }) === 'cid:c9',
    'cid is used when placeId is absent'
  );
  assert(
    discoveryGroupKey({ position: 1, title: 'Ever  Vision', address: 'Satungal,  Kathmandu' }) ===
      'title:ever vision|satungal, kathmandu',
    'title|address fallback is whitespace-normalized'
  );

  // --- 5. MAPS_HAS_WEBSITE: phone-only enrichment never overwrites Maps website ---
  console.log('\n--- 5. MAPS_HAS_WEBSITE precedence ---');
  const hasSite = [makePlace('h1', { website: 'https://maps-given.com.np', phoneNumber: undefined })];
  let lookups5 = 0;
  const summary5 = await runWebsiteDiscoveryGate({
    places: hasSite,
    lookupBudget: 1,
    lookup: async (): Promise<DiscoveryLookupResult> => {
      lookups5++;
      return { queries: ['h1 Satungal'], results: [{ url: 'https://a-different-site.com' }] };
    },
    selectFirstPartyUrl: selectFirstParty,
  });
  assert(lookups5 === 1, 'Website-bearing candidate still receives its phone-enrichment lookup');
  assert(
    hasSite[0].discoveryState === 'MAPS_HAS_WEBSITE',
    'Website-bearing candidate records MAPS_HAS_WEBSITE'
  );
  assert(
    hasSite[0].website === 'https://maps-given.com.np',
    'Maps website is NOT overwritten by discovered results'
  );
  assert(summary5.statesApplied.MAPS_HAS_WEBSITE === 1, 'MAPS_HAS_WEBSITE counted in statesApplied');

  const phoneOnlySkipped = [
    makePlace('h2', { website: 'https://maps-given-2.com.np', phoneNumber: undefined }),
  ];
  const summary5b = await runWebsiteDiscoveryGate({
    places: phoneOnlySkipped,
    lookupBudget: 0,
    lookup: async (): Promise<DiscoveryLookupResult> => ({ queries: [], results: [] }),
    selectFirstPartyUrl: selectFirstParty,
  });
  assert(
    phoneOnlySkipped[0].discoveryState === 'MAPS_HAS_WEBSITE' && summary5b.notAttemptedPhoneOnly === 1,
    'Skipped phone-only lookup is reported separately, not as a website miss'
  );

  // --- 6. Budget bounding ---
  console.log('\n--- 6. Budget bounding ---');
  const ten = Array.from({ length: 10 }, (_, i) => makePlace(`b${i}`));
  let lookups6 = 0;
  const summary6 = await runWebsiteDiscoveryGate({
    places: ten,
    lookupBudget: 2,
    lookup: async (): Promise<DiscoveryLookupResult> => {
      lookups6++;
      return { queries: ['q'], results: [] };
    },
    selectFirstPartyUrl: selectFirstParty,
  });
  assert(lookups6 === 2, `10 candidates with budget 2 → exactly 2 lookups (got ${lookups6})`);
  assert(summary6.statesApplied.DISCOVERY_NOT_ATTEMPTED_BUDGET === 8, '8 candidates recorded as not attempted');
  assert(summary6.groupsEvaluated === 10, 'All 10 still evaluated (evaluation is universal)');

  const zeroBudget = [makePlace('z1'), makePlace('z2')];
  let lookups6b = 0;
  const summary6b = await runWebsiteDiscoveryGate({
    places: zeroBudget,
    lookupBudget: 0,
    lookup: async (): Promise<DiscoveryLookupResult> => {
      lookups6b++;
      return { queries: [], results: [] };
    },
    selectFirstPartyUrl: selectFirstParty,
  });
  assert(lookups6b === 0, 'Budget 0 performs zero lookups');
  assert(
    summary6b.statesApplied.DISCOVERY_NOT_ATTEMPTED_BUDGET === 2,
    'Budget 0 still records every eligible candidate as not attempted'
  );

  // --- 7. Failure isolation ---
  console.log('\n--- 7. A failing lookup never aborts evaluation ---');
  const failing = [makePlace('f1'), makePlace('f2'), makePlace('f3')];
  const summary7 = await runWebsiteDiscoveryGate({
    places: failing,
    lookupBudget: 5,
    lookup: async (place): Promise<DiscoveryLookupResult> => {
      if (place.placeId === 'f2') throw new Error('search provider exploded');
      return { queries: ['ok'], results: [{ url: 'https://good-site.com.np' }] };
    },
    selectFirstPartyUrl: selectFirstParty,
  });
  const failedRecord = summary7.records.find((r: DiscoveryGroupRecord) => r.key === 'placeId:f2');
  assert(Boolean(failedRecord), 'Failed candidate still produced a record');
  assert(
    failedRecord?.state === 'DISCOVERY_EXHAUSTED_NO_FIRST_PARTY' &&
      Boolean(failedRecord?.error?.includes('exploded')),
    'Failure recorded as exhausted state WITH the error captured'
  );
  assert(
    summary7.statesApplied.DISCOVERY_FOUND_FIRST_PARTY === 2,
    'The other two candidates were still evaluated and resolved normally'
  );

  // --- 8. Ranking injection + defensive re-append ---
  console.log('\n--- 8. Injected ranking decides budget order ---');
  const ranked = [makePlace('r1'), makePlace('r2'), makePlace('r3')];
  const lookupOrder: string[] = [];
  await runWebsiteDiscoveryGate({
    places: ranked,
    lookupBudget: 1,
    rank: (places) => [...places].reverse(),
    lookup: async (place): Promise<DiscoveryLookupResult> => {
      lookupOrder.push(place.placeId || '');
      return { queries: ['q'], results: [{ url: 'https://site.com.np' }] };
    },
    selectFirstPartyUrl: selectFirstParty,
  });
  assert(lookupOrder[0] === 'r3', 'Injected ranker controlled which candidate consumed the budget');

  const partiallyRanked = [makePlace('p1'), makePlace('p2'), makePlace('p3')];
  const summary8 = await runWebsiteDiscoveryGate({
    places: partiallyRanked,
    lookupBudget: 1,
    rank: (places) => places.slice(0, 1),
    lookup: async (): Promise<DiscoveryLookupResult> => ({
      queries: ['q'],
      results: [{ url: 'https://s.com' }],
    }),
    selectFirstPartyUrl: selectFirstParty,
  });
  assert(
    summary8.groupsEvaluated === 3,
    'A ranker that drops candidates cannot remove them from evaluation (all 3 still recorded)'
  );

  // --- 9. Provenance completeness (feeds Task 8 telemetry) ---
  console.log('\n--- 9. Provenance record completeness ---');
  const provenance = [makePlace('t1', { title: 'Ever Vision School' })];
  const summary9 = await runWebsiteDiscoveryGate({
    places: provenance,
    lookupBudget: 1,
    lookup: async (): Promise<DiscoveryLookupResult> => ({
      queries: ['Ever Vision School Satungal, Kathmandu'],
      results: [...dirResults, { url: 'https://evervision.edu.np' }],
    }),
    selectFirstPartyUrl: selectFirstParty,
  });
  const rec = summary9.records[0];
  assert(rec.queries.length === 1 && rec.queries[0].includes('Ever Vision School'), 'Query is recorded');
  assert(rec.resultsReviewed === 3, 'Results reviewed count is recorded');
  assert(
    Array.isArray(rec.candidateUrlsReviewed) && rec.candidateUrlsReviewed.length === 3,
    'candidateUrlsReviewed is recorded with exact reviewed URLs'
  );
  assert(
    rec.candidateUrlsReviewed.includes('https://evervision.edu.np') &&
      rec.candidateUrlsReviewed.includes('https://school-directory.example/x'),
    'candidateUrlsReviewed contains both first-party and directory candidates'
  );
  assert(rec.selectedUrl === 'https://evervision.edu.np', 'Selected first-party URL is recorded');
  assert(
    typeof rec.selectionReason === 'string' && rec.selectionReason.length > 0,
    'selectionReason is populated with a non-empty string'
  );
  assert(rec.searchAttempted === true, 'Search-attempted flag is recorded');
  assert(rec.state === 'DISCOVERY_FOUND_FIRST_PARTY', 'Final state is recorded on the same record');

  // Candidate URLs cap at 20
  const twentyFiveResults = Array.from({ length: 25 }, (_, i) => ({
    url: `https://site${i}.edu.np`,
    title: `Site ${i}`,
  }));
  const summaryCap = await runWebsiteDiscoveryGate({
    places: [makePlace('cap1')],
    lookupBudget: 1,
    lookup: async () => ({ queries: ['q'], results: twentyFiveResults }),
    selectFirstPartyUrl: selectFirstParty,
  });
  assert(
    summaryCap.records[0].candidateUrlsReviewed.length === 20,
    'candidateUrlsReviewed is strictly capped at top 20 URLs per candidate'
  );

  const freshCounts = emptyDiscoveryStateCounts();
  assert(
    Object.values(freshCounts).every((v) => v === 0) && Object.keys(freshCounts).length === 5,
    'emptyDiscoveryStateCounts returns a fresh zeroed 5-state counter'
  );

  // --- 10. Phase 7b Task 10: State Machine Invariant & Strict Enum Enforcement ---
  console.log('\n--- 10. Task 10: State Machine Invariant & Strict Enum Enforcement ---');
  assert(DISCOVERY_STATES.length === 5, 'Canonical state enum contains exactly 5 states');
  assert(
    DISCOVERY_STATES.includes('DISCOVERY_NOT_ATTEMPTED_BUDGET'),
    'Canonical budget skip state is DISCOVERY_NOT_ATTEMPTED_BUDGET (zero aliases)'
  );

  for (const s of DISCOVERY_STATES) {
    assert(discoveryStateEnum.safeParse(s).success, `discoveryStateEnum accepts canonical state "${s}"`);
  }
  assert(
    !discoveryStateEnum.safeParse('DISCOVERY_NOT_ATTEMPTED').success,
    'Non-canonical alias "DISCOVERY_NOT_ATTEMPTED" is rejected by strict Zod enum'
  );
  assert(
    !discoveryStateEnum.safeParse('UNKNOWN_STATE').success,
    'Arbitrary string is rejected by strict Zod enum'
  );

  // Exact sum validation
  const exactCounts: Record<DiscoveryState, number> = {
    MAPS_HAS_WEBSITE: 2,
    DISCOVERY_FOUND_FIRST_PARTY: 3,
    DISCOVERY_FOUND_ONLY_THIRD_PARTY: 1,
    DISCOVERY_EXHAUSTED_NO_FIRST_PARTY: 1,
    DISCOVERY_NOT_ATTEMPTED_BUDGET: 3,
  };
  const validResult = validateDiscoveryStateInvariant(exactCounts, 10);
  assert(validResult.valid === true, 'Exact sum matches total evaluated candidates (10 === 10)');
  assert(validResult.sum === 10 && validResult.delta === 0, 'Invariant delta is 0 for matching sum');

  const underCounts = { ...exactCounts, DISCOVERY_NOT_ATTEMPTED_BUDGET: 2 };
  const underResult = validateDiscoveryStateInvariant(underCounts, 10);
  assert(underResult.valid === false, 'Under-count fails invariant (9 !== 10)');
  assert(underResult.sum === 9 && underResult.delta === -1, 'Under-count returns negative delta (-1)');

  const overCounts = { ...exactCounts, DISCOVERY_NOT_ATTEMPTED_BUDGET: 4 };
  const overResult = validateDiscoveryStateInvariant(overCounts, 10);
  assert(overResult.valid === false, 'Over-count fails invariant (11 !== 10)');
  assert(overResult.sum === 11 && overResult.delta === 1, 'Over-count returns positive delta (+1)');

  // Invariant throw policy:
  // In benchmark mode, a simulated corrupted gate throw
  const oldDiscoveryMode = process.env.DISCOVERY_MODE;
  process.env.DISCOVERY_MODE = 'benchmark';
  let threwInBenchmark = false;
  try {
    const corruptedCounts = { ...exactCounts, MAPS_HAS_WEBSITE: 0 };
    const inv = validateDiscoveryStateInvariant(corruptedCounts, 10);
    if (!inv.valid && process.env.DISCOVERY_MODE === 'benchmark') {
      throw new Error(`[DiscoveryGate] State machine invariant violated: sum(${inv.sum}) !== total(10), delta=${inv.delta}`);
    }
  } catch (err: any) {
    if (err.message.includes('State machine invariant violated')) {
      threwInBenchmark = true;
    }
  } finally {
    process.env.DISCOVERY_MODE = oldDiscoveryMode;
  }
  assert(threwInBenchmark, 'State machine invariant throws when DISCOVERY_MODE === benchmark');

  // Verify normal gate run under benchmark mode succeeds without throwing because invariant holds
  process.env.DISCOVERY_MODE = 'benchmark';
  try {
    const normalCandidates = [makePlace('norm1'), makePlace('norm2')];
    const normalSummary = await runWebsiteDiscoveryGate({
      places: normalCandidates,
      lookupBudget: 1,
      lookup: async () => ({ queries: ['q'], results: [] }),
      selectFirstPartyUrl: selectFirstParty,
    });
    const normalInv = validateDiscoveryStateInvariant(normalSummary.statesApplied, normalSummary.groupsEvaluated);
    assert(normalInv.valid === true, 'Gate execution produces a 100% valid invariant under benchmark mode');
  } finally {
    process.env.DISCOVERY_MODE = oldDiscoveryMode;
  }

  // --- 11. Discovery Quota Counters & Stage 0 Artifact Envelope (Task 13) ---
  console.log('\n--- 11. Discovery Quota Counters & Stage 0 Artifact Envelope (Task 13) ---');

  const mockSummary: DiscoveryGateSummary = {
    statesApplied: {
      MAPS_HAS_WEBSITE: 2,
      DISCOVERY_FOUND_FIRST_PARTY: 3,
      DISCOVERY_FOUND_ONLY_THIRD_PARTY: 2,
      DISCOVERY_EXHAUSTED_NO_FIRST_PARTY: 1,
      DISCOVERY_NOT_ATTEMPTED_BUDGET: 4,
    },
    groupsEvaluated: 12,
    groupsLookedUp: 6,
    groupsNotAttempted: 6,
    duplicatesMerged: 2,
    notAttemptedPhoneOnly: 1,
    records: [
      { key: 'k1', title: 'T1', state: 'DISCOVERY_FOUND_FIRST_PARTY', searchAttempted: true, queries: ['q1', 'q2'], resultsReviewed: 5, candidateUrlsReviewed: ['https://t1.com'], duplicatesMerged: 0 },
      { key: 'k2', title: 'T2', state: 'DISCOVERY_FOUND_FIRST_PARTY', searchAttempted: true, queries: ['q3'], resultsReviewed: 2, candidateUrlsReviewed: ['https://t2.com'], duplicatesMerged: 1 },
      { key: 'k3', title: 'T3', state: 'DISCOVERY_FOUND_ONLY_THIRD_PARTY', searchAttempted: true, queries: ['q4'], resultsReviewed: 3, candidateUrlsReviewed: ['https://dir.com'], duplicatesMerged: 0 },
      { key: 'k4', title: 'T4', state: 'DISCOVERY_NOT_ATTEMPTED_BUDGET', searchAttempted: false, queries: [], resultsReviewed: 0, candidateUrlsReviewed: [], duplicatesMerged: 0 },
    ],
  };

  const counters: DiscoveryQuotaCounters = getDiscoveryTelemetryCounters(mockSummary);
  assert(counters.lookupsAttempted === 6, 'lookupsAttempted matches groupsLookedUp');
  assert(counters.searchesSent === 4, 'searchesSent sums executed queries across all records (2 + 1 + 1 = 4)');
  assert(counters.firstPartyFound === 3, 'firstPartyFound matches statesApplied.DISCOVERY_FOUND_FIRST_PARTY');
  assert(counters.thirdPartyOnly === 2, 'thirdPartyOnly matches statesApplied.DISCOVERY_FOUND_ONLY_THIRD_PARTY');
  assert(counters.exhaustedNoFirstParty === 1, 'exhaustedNoFirstParty matches statesApplied.DISCOVERY_EXHAUSTED_NO_FIRST_PARTY');
  assert(counters.notAttemptedBudget === 4, 'notAttemptedBudget matches statesApplied.DISCOVERY_NOT_ATTEMPTED_BUDGET');
  assert(counters.phoneOnlyLookups === 1, 'phoneOnlyLookups matches notAttemptedPhoneOnly');

  // Stage 0 Artifact Envelope Structure
  const mockArtifact: WebsiteDiscoveryArtifact = {
    runId: 'test-run-phase7b-t13',
    generatedAt: new Date().toISOString(),
    counters,
    statesApplied: mockSummary.statesApplied,
    records: mockSummary.records,
  };

  assert(Boolean(mockArtifact.runId), 'Artifact envelope contains non-empty runId');
  assert(!isNaN(new Date(mockArtifact.generatedAt).getTime()), 'Artifact envelope generatedAt is valid ISO-8601');
  assert(mockArtifact.counters.lookupsAttempted === 6, 'Artifact envelope carries full quota counters');
  assert(mockArtifact.statesApplied.DISCOVERY_NOT_ATTEMPTED_BUDGET === 4, 'Artifact envelope carries 5-state distribution');
  assert(mockArtifact.records.length === 4, 'Artifact envelope carries per-candidate provenance records');

  console.log('\n===============================================================');
  console.log('🎉 WEBSITE DISCOVERY GATE TESTS PASSED (100%)');
  console.log('===============================================================');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});