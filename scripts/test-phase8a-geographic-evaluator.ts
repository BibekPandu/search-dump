import assert from 'node:assert';
import {
  evaluateGeographicLocality,
  calculateHaversineDistanceKm,
} from '@/services/resolution/geographic-evaluator.service';
import { findRegisteredLocalityCluster } from '@/config/geo-localities.config.js';

async function runPhase8aTests() {
  console.log('=== Running Phase 8a Geographic Precision Tests ===\n');

  // Test 1: Haversine distance calculations
  console.log('Test 1: Haversine distance accuracy');
  // Satungal (27.6912, 85.2445) to Bullbulley (27.7162, 85.3419) ~ 10.0km
  const distBullbulley = calculateHaversineDistanceKm(27.6912, 85.2445, 27.7162, 85.3419);
  console.log(`  Satungal -> Bullbulley: ${distBullbulley} km`);
  assert(distBullbulley > 9.0 && distBullbulley < 11.0, 'Bullbulley distance should be ~10km');

  // Satungal to Kirtipur (27.6780, 85.2770) ~ 3.5km
  const distKirtipur = calculateHaversineDistanceKm(27.6912, 85.2445, 27.6780, 85.2770);
  console.log(`  Satungal -> Kirtipur: ${distKirtipur} km`);
  assert(distKirtipur > 3.0 && distKirtipur < 4.5, 'Kirtipur distance should be ~3.5km');
  console.log('  ✅ Haversine distance verified\n');

  // Test 2: Registered locality cluster lookup
  console.log('Test 2: Cluster lookup & normalization');
  const satCluster = findRegisteredLocalityCluster('Satungal, Kathmandu');
  assert(satCluster !== null && satCluster.canonicalName === 'satungal', 'Should find satungal cluster');
  assert(satCluster.aliases.includes('chandragiri-11'), 'Should include ward 11 alias');
  assert(!satCluster.aliases.includes('chandragiri-12'), 'Ward 12 alias belongs to balambu, not satungal');

  const sinCluster = findRegisteredLocalityCluster('Sinamangal Rd, Kathmandu');
  assert(sinCluster !== null && sinCluster.canonicalName === 'sinamangal', 'Should find sinamangal cluster');
  console.log('  ✅ Locality clusters verified\n');

  // Test 3: Satungal Cases
  console.log('Test 3: Satungal Geographic Decisions');
  const queryLoc = 'Satungal, Kathmandu';

  // Case 3a: Exact locality name match in address
  const c1 = evaluateGeographicLocality(
    { title: 'Local Bakery', address: 'Satungal Chowk, Kathmandu 44600' },
    queryLoc
  );
  assert.strictEqual(c1.status, 'inside');
  assert.strictEqual(c1.matchedRequestedLocality, true);
  assert.strictEqual(c1.matchedCanonicalLocality, 'satungal');
  console.log('  ✅ Case 3a: Exact Satungal address -> inside');

  // Case 3b: Ward-level alias match (Chandragiri-11 = Satungal ward)
  const c2 = evaluateGeographicLocality(
    { title: 'Auto Repairs', address: 'Chandragiri-11, Kathmandu 44600' },
    queryLoc
  );
  assert.strictEqual(c2.status, 'inside');
  assert.strictEqual(c2.matchedAlias, 'chandragiri-11');
  assert.strictEqual(c2.matchedCanonicalLocality, 'satungal');
  console.log('  ✅ Case 3b: Chandragiri-11 -> inside (matched alias)');

  // Case 3b2: Ward 12 moved to balambu cluster -> outside for Satungal query
  const c2b = evaluateGeographicLocality(
    { title: 'Auto Repairs', address: 'Chandragiri-12, Kathmandu 44600' },
    queryLoc
  );
  assert.strictEqual(c2b.status, 'outside');
  console.log('  ✅ Case 3b2: Chandragiri-12 (balambu) -> outside for Satungal query');

  // Case 3c: Non-Satungal ward match (Chandragiri-8) -> OUTSIDE
  const c3 = evaluateGeographicLocality(
    { title: 'Resort', address: 'Chandragiri-8, Matatirtha' },
    queryLoc
  );
  assert.strictEqual(c3.status, 'outside');
  assert(c3.reason.includes('Ward 8'), 'Reason should cite Ward 8 exclusion');
  console.log('  ✅ Case 3c: Chandragiri-8 -> outside (non-Satungal ward)');

  // Case 3d: Conflicting locality text (Sinamangal Rd) -> OUTSIDE
  const c4 = evaluateGeographicLocality(
    { title: 'Nepal Cleaning Solution', address: 'Sinamangal Rd, Kathmandu 44600' },
    queryLoc
  );
  assert.strictEqual(c4.status, 'outside');
  assert.strictEqual(c4.matchedCanonicalLocality, 'satungal');
  console.log('  ✅ Case 3d: Sinamangal address -> outside');

  // Case 3e: GPS Coordinates within boundary (2.1 km from Satungal center) -> INSIDE
  const c5 = evaluateGeographicLocality(
    { title: 'Cleaners', address: 'Kathmandu', latitude: 27.695, longitude: 85.25 },
    queryLoc
  );
  assert.strictEqual(c5.status, 'inside');
  assert(typeof c5.distanceKm === 'number' && c5.distanceKm <= 3.5);
  console.log(`  ✅ Case 3e: GPS within 3.5km (${c5.distanceKm}km) -> inside`);

  // Case 3f: GPS Coordinates outside boundary (Bullbulley, 10.0km away) -> OUTSIDE
  const c6 = evaluateGeographicLocality(
    {
      title: 'Royal Cleaning Services',
      address: 'Bullbulley, Kathmandu 44600',
      latitude: 27.716219,
      longitude: 85.341965,
    },
    queryLoc
  );
  assert.strictEqual(c6.status, 'outside');
  assert(typeof c6.distanceKm === 'number' && c6.distanceKm > 3.5);
  console.log(`  ✅ Case 3f: GPS outside boundary (${c6.distanceKm}km) -> outside`);

  // Case 3g: Generic city without GPS or tole -> AMBIGUOUS
  const c7 = evaluateGeographicLocality(
    { title: 'Hitech Cleaning Services', address: 'Kathmandu 44600' },
    queryLoc
  );
  assert.strictEqual(c7.status, 'ambiguous');
  console.log('  ✅ Case 3g: Generic Kathmandu 44600 without GPS -> ambiguous');

  // Test 4: Unregistered Locality Fallback (Permissive)
  console.log('\nTest 4: Unregistered Locality Fallback');
  const c8 = evaluateGeographicLocality(
    { title: 'Hotel Royal', address: 'Main Road, Hetauda' },
    'Hetauda'
  );
  assert.strictEqual(c8.status, 'inside');
  assert.strictEqual(c8.matchedRequestedLocality, true);
  console.log('  ✅ Unregistered locality with matching token -> inside');

  const c9 = evaluateGeographicLocality(
    { title: 'Generic Hotel', address: 'Nepal' },
    'Hetauda'
  );
  assert.strictEqual(c9.status, 'ambiguous');
  console.log('  ✅ Unregistered locality without matching token -> ambiguous');

  console.log('\n=== All Phase 8a Tests PASSED successfully! ===');
}

runPhase8aTests().catch((err) => {
  console.error('Phase 8a Test Failure:', err);
  process.exit(1);
});
