import { paginateMapsDiscovery } from '../src/services/maps-discovery.service';
import type { SerperPlaceResult } from '../src/services/serper-places.service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

function makeMockPlace(id: string, title: string, phone: string): SerperPlaceResult {
  return {
    position: 1,
    title,
    phoneNumber: phone,
    address: 'Kathmandu, Nepal',
    latitude: 27.7172,
    longitude: 85.324,
    rating: 4.8,
    ratingCount: 100,
    category: 'Cafe',
    placeId: id,
  };
}

async function runTests() {
  console.log('===============================================================');
  console.log('🧪 MAPS PAGINATION DISCOVERY UNIT TESTS (ZERO API)');
  console.log('===============================================================\n');

  // --- 1. Target Satisfied on Page 1 ---
  console.log('--- 1. Target Satisfied on Page 1 ---');
  const mockBatch10: SerperPlaceResult[] = Array.from({ length: 10 }, (_, i) =>
    makeMockPlace(`p1_${i}`, `Coffee Shop P1_${i}`, `01424052${i}`)
  );

  const res1 = await paginateMapsDiscovery({
    query: 'specialty coffee',
    location: 'Kathmandu',
    targetCandidates: 10,
    maxMapsPages: 5,
    fetchPlaces: async (_q, { page }) => (page === 1 ? mockBatch10 : []),
  });

  assert(res1.mapsPagesQueried === 1, 'Target satisfied on page 1 stops at mapsPagesQueried: 1');
  assert(res1.candidates.length === 10, 'Found 10 unique candidates');
  assert(res1.stoppedReason === 'target_reached', 'Stopped reason is target_reached');

  // --- 2. Multi-Page Pagination Reaches Target (Target 20) ---
  console.log('\n--- 2. Multi-Page Pagination Reaches Target (Target 20) ---');
  const mockBatchPage2: SerperPlaceResult[] = Array.from({ length: 10 }, (_, i) =>
    makeMockPlace(`p2_${i}`, `Roastery P2_${i}`, `01444052${i}`)
  );

  const res2 = await paginateMapsDiscovery({
    query: 'specialty coffee',
    location: 'Kathmandu',
    targetCandidates: 20,
    maxMapsPages: 5,
    fetchPlaces: async (_q, { page }) => {
      if (page === 1) return mockBatch10;
      if (page === 2) return mockBatchPage2;
      return [];
    },
  });

  assert(res2.mapsPagesQueried === 2, 'Paginates to page 2 when target is 20');
  assert(res2.candidates.length === 20, 'Found all 20 unique candidates from Maps');
  assert(res2.stoppedReason === 'target_reached', 'Stopped reason is target_reached');

  // --- 3. Early Maps Exhaustion (16 -> Deficit for Web Fallback) ---
  console.log('\n--- 3. Early Maps Exhaustion (16 -> Deficit for Web Fallback) ---');
  const mockBatchPage2Six: SerperPlaceResult[] = Array.from({ length: 6 }, (_, i) =>
    makeMockPlace(`p2_${i}`, `Roastery P2_${i}`, `01444052${i}`)
  );

  const res3 = await paginateMapsDiscovery({
    query: 'specialty coffee',
    location: 'Kathmandu',
    targetCandidates: 20,
    maxMapsPages: 5,
    fetchPlaces: async (_q, { page }) => {
      if (page === 1) return mockBatch10; // 10
      if (page === 2) return mockBatchPage2Six; // 6 -> 16 total
      return []; // Page 3 empty -> maps exhausted
    },
  });

  assert(res3.mapsPagesQueried === 3, 'Queried up to page 3 where empty array returned');
  assert(res3.candidates.length === 16, 'Captured 16 unique candidates from Maps');
  assert(res3.stoppedReason === 'maps_exhausted', 'Stopped reason is maps_exhausted');

  // --- 4. Consecutive Stale Pages Termination ---
  console.log('\n--- 4. Consecutive Stale Pages Termination ---');
  const res4 = await paginateMapsDiscovery({
    query: 'specialty coffee',
    location: 'Kathmandu',
    targetCandidates: 20,
    maxMapsPages: 5,
    fetchPlaces: async (_q, { page }) => {
      if (page === 1) return mockBatch10;
      // Page 2 & 3 return exact duplicates of Page 1 (same phone & title)
      return mockBatch10;
    },
  });

  assert(res4.mapsPagesQueried === 3, 'Terminates at page 3 (stale count = 2)');
  assert(res4.consecutiveStaleMapsPages === 2, 'Stale counter reached 2');
  assert(res4.stoppedReason === 'stale_limit_reached', 'Stopped reason is stale_limit_reached');
  assert(res4.candidates.length === 10, 'Preserves 10 unique candidates without duplicate inflation');

  // --- 5. Max Pages Limit Cap ---
  console.log('\n--- 5. Max Pages Limit Cap ---');
  const res5 = await paginateMapsDiscovery({
    query: 'specialty coffee',
    location: 'Kathmandu',
    targetCandidates: 100,
    maxMapsPages: 2,
    fetchPlaces: async (_q, { page }) => {
      return [
        makeMockPlace(`p${page}_1`, `Cafe P${page}_1`, `0149999${page}1`),
        makeMockPlace(`p${page}_2`, `Cafe P${page}_2`, `0149999${page}2`),
      ];
    },
  });

  assert(res5.mapsPagesQueried === 2, 'Stops at maxMapsPages (2)');
  assert(res5.stoppedReason === 'max_pages_reached', 'Stopped reason is max_pages_reached');
  assert(res5.candidates.length === 4, 'Found 4 unique candidates across 2 pages');

  console.log('\n===============================================================');
  console.log('🎉 MAPS PAGINATION DISCOVERY UNIT TESTS PASSED (100%)');
  console.log('===============================================================');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
