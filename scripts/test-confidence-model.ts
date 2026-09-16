import {
  computeMapsConfidence,
  computeWebsiteEvidenceConfidence,
  computeContactConfidence,
  computeConflictPenalty,
  computeConfidenceBreakdown,
  validateConfidenceIntegrity,
} from '../src/services/confidence.service';

console.log('================================================================');
console.log('RUNNING TASK 5 CONFIDENCE MODEL TESTS (33 CASES)');
console.log('================================================================\n');

let passed = 0;
let failed = 0;

function assertGte(name: string, actual: number, expected: number) {
  if (actual < expected) {
    console.error(`❌ FAIL: ${name} — expected >= ${expected}, got ${actual}`);
    failed++;
  } else {
    console.log(`✓ ${name} (actual: ${actual})`);
    passed++;
  }
}

function assertLte(name: string, actual: number, expected: number) {
  if (actual > expected) {
    console.error(`❌ FAIL: ${name} — expected <= ${expected}, got ${actual}`);
    failed++;
  } else {
    console.log(`✓ ${name} (actual: ${actual})`);
    passed++;
  }
}

function assertEq(name: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    console.error(`❌ FAIL: ${name} — expected ${expected}, got ${actual}`);
    failed++;
  } else {
    console.log(`✓ ${name}`);
    passed++;
  }
}

function assertBool(name: string, value: boolean) {
  if (!value) {
    console.error(`❌ FAIL: ${name}`);
    failed++;
  } else {
    console.log(`✓ ${name}`);
    passed++;
  }
}

function assertIn(name: string, actual: number, min: number, max: number) {
  if (actual < min || actual > max) {
    console.error(`❌ FAIL: ${name} — expected in [${min}, ${max}], got ${actual}`);
    failed++;
  } else {
    console.log(`✓ ${name} (${actual} in [${min}, ${max}])`);
    passed++;
  }
}

// ============================================================================
// GROUP 1: Maps Identity Confidence (6 tests)
// ============================================================================

// Test 1: No Maps candidate → 0
assertEq('T1: non-Maps candidate', computeMapsConfidence({ isMapsCandidate: false, hasWebsiteEvidence: false }), 0);

// Test 2: Bare Maps candidate → ≥ 0.80
assertGte('T2: bare Maps candidate', computeMapsConfidence({ isMapsCandidate: true, hasWebsiteEvidence: false }), 0.8);

// Test 3: 500 reviews + placeId + GPS + address → 1.00 (capped)
const highReviews = computeMapsConfidence({
  isMapsCandidate: true,
  hasWebsiteEvidence: false,
  ratingCount: 500,
  placeId: 'ChIJ-abc123',
  gpsCoordinates: { lat: 27.7172, lng: 85.324 },
  address: 'Thamel, Kathmandu',
});
assertGte('T3: 500 reviews + extras → capped at 1.0', highReviews, 1.0);

// Test 4: 5 reviews, no extras → 0.80 (base only)
const fiveReviewsNoExtras = computeMapsConfidence({
  isMapsCandidate: true,
  hasWebsiteEvidence: false,
  ratingCount: 5,
});
assertEq('T4: 5 reviews, no extras → 0.80', fiveReviewsNoExtras, 0.8);

// Test 5: 5 reviews + placeId + GPS + address → 0.95
const fiveReviewsFull = computeMapsConfidence({
  isMapsCandidate: true,
  hasWebsiteEvidence: false,
  ratingCount: 5,
  placeId: 'ChIJ-abc123',
  gpsCoordinates: { lat: 27.7172, lng: 85.324 },
  address: 'Thamel, Kathmandu',
});
assertEq('T5: 5 reviews + identity metadata → 0.95', fiveReviewsFull, 0.95);

// Test 6 (R2): Relative test — 500 reviews > 5 reviews
assertBool('T6: 500-review maps > 5-review maps', highReviews > fiveReviewsNoExtras);

// ============================================================================
// GROUP 2: Website Evidence Confidence (5 tests)
// ============================================================================

// Test 7: No website evidence → 0
assertEq(
  'T7: no website evidence → 0',
  computeWebsiteEvidenceConfidence({
    isMapsCandidate: true,
    hasWebsiteEvidence: false,
  }),
  0
);

// Test 8: first_party × 1.0
const firstParty = computeWebsiteEvidenceConfidence({
  isMapsCandidate: true,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.9,
  websiteRelationship: 'first_party',
});
assertGte('T8: first_party × 1.0 ≥ 0.90', firstParty, 0.9);
assertLte('T8: capped at 1.0', firstParty, 1.0);

// Test 9: directory × 0.30
const directory = computeWebsiteEvidenceConfidence({
  isMapsCandidate: true,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.9,
  websiteRelationship: 'directory',
});
assertEq('T9: directory × 0.30', directory, 0.27);

// Test 10: Property — first_party > directory
assertBool('T10: first_party > directory', firstParty > directory);

// Test 11 (R14): Website exists but verification failed → websiteEvidenceConfidence = 0
const failedWebsite = computeWebsiteEvidenceConfidence({
  isMapsCandidate: true,
  hasWebsiteEvidence: true,
  verificationConfidence: 0,
  websiteRelationship: 'first_party',
});
assertEq('T11: website exists but verification = 0 → webEvidence = 0', failedWebsite, 0);

// ============================================================================
// GROUP 3: Contact Confidence (5 tests)
// ============================================================================

// Test 12: No checks → 0
assertEq('T12: no checks → 0', computeContactConfidence({ isMapsCandidate: false, hasWebsiteEvidence: false }), 0);

// Test 13: phoneMatchesMaps only → 0.40
assertEq(
  'T13: phone only → 0.40',
  computeContactConfidence({
    isMapsCandidate: false,
    hasWebsiteEvidence: true,
    verificationChecks: {
      phoneMatchesMaps: true,
      emailFoundOnWebsite: false,
      addressOrLocationFoundOnWebsite: false,
    },
  }),
  0.4
);

// Test 14: phone + email + address + 2 phones → 1.00 (capped)
const fullContact = computeContactConfidence({
  isMapsCandidate: false,
  hasWebsiteEvidence: true,
  verificationChecks: {
    phoneMatchesMaps: true,
    emailFoundOnWebsite: true,
    addressOrLocationFoundOnWebsite: true,
  },
  phonesCount: 1,
  mobilesCount: 1,
});
assertGte('T14: full contact ≥ 0.90', fullContact, 0.9);
assertLte('T14: capped at 1.0', fullContact, 1.0);

// Test 15: Email only → 0.30
assertEq(
  'T15: email only → 0.30',
  computeContactConfidence({
    isMapsCandidate: false,
    hasWebsiteEvidence: true,
    verificationChecks: {
      phoneMatchesMaps: false,
      emailFoundOnWebsite: true,
      addressOrLocationFoundOnWebsite: false,
    },
  }),
  0.3
);

// Test 16: phone + 2+ phones → bonus (Task 4 invariant)
const multiPhone = computeContactConfidence({
  isMapsCandidate: false,
  hasWebsiteEvidence: true,
  verificationChecks: {
    phoneMatchesMaps: true,
    emailFoundOnWebsite: false,
    addressOrLocationFoundOnWebsite: false,
  },
  phonesCount: 2,
  mobilesCount: 0,
});
assertGte('T16: phone + 2+ phones ≥ 0.50', multiPhone, 0.5);

// ============================================================================
// GROUP 4: Conflict Penalties (6 tests)
// ============================================================================

assertEq('T17: NO_CONFLICT = 1.0', computeConflictPenalty('NO_CONFLICT'), 1.0);
assertEq('T18: SHARED_OFFICE = 0.90', computeConflictPenalty('SHARED_OFFICE'), 0.9);
assertEq('T19: RELATED_BRAND = 0.85', computeConflictPenalty('RELATED_BRAND'), 0.85);
assertEq('T20: POSSIBLY_SAME_ENTITY = 0.75', computeConflictPenalty('POSSIBLY_SAME_ENTITY'), 0.75);
assertEq('T21: DUPLICATE_MAPS_LISTING = 0.65', computeConflictPenalty('DUPLICATE_MAPS_LISTING'), 0.65);
assertEq('T22: unknown type → 1.0 (safe default)', computeConflictPenalty('UNKNOWN_TYPE'), 1.0);

// ============================================================================
// GROUP 5: Overall Confidence — Full Breakdown (8 tests)
// ============================================================================

// Test 23: Fully verified business (30/35/35 weights + no penalty)
const fullVerified = computeConfidenceBreakdown({
  isMapsCandidate: true,
  ratingCount: 300,
  placeId: 'ChIJ-abc',
  gpsCoordinates: { lat: 27.71, lng: 85.32 },
  address: 'New Road, Kathmandu',
  hasWebsiteEvidence: true,
  verificationConfidence: 0.85,
  verificationChecks: {
    phoneMatchesMaps: true,
    emailFoundOnWebsite: true,
    addressOrLocationFoundOnWebsite: true,
  },
  websiteRelationship: 'first_party',
  finalEmails: ['contact@example.com'],
  finalWebsites: ['https://example.com'],
  phonesCount: 1,
  mobilesCount: 1,
  conflictType: 'NO_CONFLICT',
});

assertGte('T23: full verified overall ≥ 0.80', fullVerified.overallConfidence, 0.8);
assertEq('T23: maps verified flag = true', fullVerified.evidenceSummary.mapsVerified, true);
assertEq('T23: website verified flag = true', fullVerified.evidenceSummary.websiteVerified, true);
assertEq('T23: phone verified flag = true', fullVerified.evidenceSummary.phoneVerified, true);
assertEq('T23: email verified flag = true', fullVerified.evidenceSummary.emailVerified, true);

// Test 24: Maps-only listing (review item R1 formula)
const mapsOnly = computeConfidenceBreakdown({
  isMapsCandidate: true,
  ratingCount: 25,
  address: 'Putalisadak, Kathmandu',
  hasWebsiteEvidence: false,
  conflictType: 'NO_CONFLICT',
});
// maps = 0.80 + 0.05 (address) = 0.85
// overall = 0.85 × 0.65 + 0.35 × 0.5 = 0.5525 + 0.175 = 0.7275
assertGte('T24: maps-only overall ≥ 0.70', mapsOnly.overallConfidence, 0.7);
assertLte('T24: maps-only overall ≤ 0.80', mapsOnly.overallConfidence, 0.8);
assertEq('T24: maps-only webEvidence = 0', mapsOnly.websiteEvidenceConfidence, 0);

// Test 25 (R14): Website exists but verification failed — NOT Maps-only
const failedWebFull = computeConfidenceBreakdown({
  isMapsCandidate: true,
  hasWebsiteEvidence: true,
  verificationConfidence: 0,
  websiteRelationship: 'first_party',
  conflictType: 'NO_CONFLICT',
});
assertEq('T25: failed web → websiteEvidenceConfidence = 0', failedWebFull.websiteEvidenceConfidence, 0);
assertBool('T25: failed web > zero-signal', failedWebFull.overallConfidence > 0);

// Test 26: Conflict penalizes
const cleanInput = {
  isMapsCandidate: true,
  ratingCount: 100,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.85,
  verificationChecks: {
    phoneMatchesMaps: true,
    emailFoundOnWebsite: false,
    addressOrLocationFoundOnWebsite: false,
  },
  websiteRelationship: 'first_party',
  conflictType: 'NO_CONFLICT',
};
const clean = computeConfidenceBreakdown(cleanInput);

const conflicted = computeConfidenceBreakdown({
  ...cleanInput,
  conflictType: 'POSSIBLY_SAME_ENTITY',
});

assertBool('T26: conflicted < clean', conflicted.overallConfidence < clean.overallConfidence);
assertEq('T26: penalty = 0.75', conflicted.conflictPenalty, 0.75);
assertEq('T26: type = POSSIBLY_SAME_ENTITY', conflicted.conflictType, 'POSSIBLY_SAME_ENTITY');

// Test 27: Maps-only > extraction-only
const extraction = computeConfidenceBreakdown({
  isMapsCandidate: false,
  hasWebsiteEvidence: false,
  conflictType: 'NO_CONFLICT',
});
assertGte('T27: maps-only > extraction-only', mapsOnly.overallConfidence, extraction.overallConfidence);

// Test 28: DUPLICATE_MAPS_LISTING penalty
const dupConflict = computeConfidenceBreakdown({
  isMapsCandidate: true,
  ratingCount: 200,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.9,
  verificationChecks: {
    phoneMatchesMaps: true,
    emailFoundOnWebsite: false,
    addressOrLocationFoundOnWebsite: false,
  },
  websiteRelationship: 'first_party',
  conflictType: 'DUPLICATE_MAPS_LISTING',
});
assertEq('T28: penalty = 0.65', dupConflict.conflictPenalty, 0.65);
assertBool('T28: dup conflict heavily penalized', dupConflict.overallConfidence < clean.overallConfidence);

// ============================================================================
// GROUP 6: Edge Cases + Integrity (5 tests)
// ============================================================================

// Test 29: All values in [0, 1]
assertIn('T29: mapsIdentity ∈ [0,1]', fullVerified.mapsIdentityConfidence, 0, 1);
assertIn('T29: websiteEvidence ∈ [0,1]', fullVerified.websiteEvidenceConfidence, 0, 1);
assertIn('T29: contact ∈ [0,1]', fullVerified.contactConfidence, 0, 1);
assertIn('T29: overall ∈ [0,1]', fullVerified.overallConfidence, 0, 1);
assertIn('T29: penalty ∈ [0,1]', fullVerified.conflictPenalty, 0, 1);

// Test 30: Integrity validation passes
const integrity = validateConfidenceIntegrity(fullVerified);
assertBool('T30: integrity valid', integrity.valid);

// Test 31: Integrity validation catches out-of-range
const badBreakdown = {
  mapsIdentityConfidence: 1.5,
  websiteEvidenceConfidence: 0.5,
  contactConfidence: 0.5,
  overallConfidence: 0.5,
  conflictPenalty: 1.0,
  evidenceSummary: {
    mapsVerified: true,
    websiteVerified: false,
    phoneVerified: false,
    emailVerified: false,
  },
};
const badIntegrity = validateConfidenceIntegrity(badBreakdown as any);
assertBool('T31: integrity catches 1.5', !badIntegrity.valid);

// Test 32: Integrity validation catches metadata.confidence mismatch (R12)
const goodBreakdown = {
  mapsIdentityConfidence: 0.8,
  websiteEvidenceConfidence: 0.7,
  contactConfidence: 0.6,
  overallConfidence: 0.75,
  conflictPenalty: 1.0,
  evidenceSummary: {
    mapsVerified: true,
    websiteVerified: false,
    phoneVerified: false,
    emailVerified: false,
  },
};
const mismatch = validateConfidenceIntegrity(goodBreakdown as any, 0.99);
assertBool('T32: integrity catches confidence mismatch', !mismatch.valid);

// Test 33: Confidence equality invariant — metadata.confidence === overallConfidence (R15)
const equality = validateConfidenceIntegrity(goodBreakdown as any, 0.75);
assertBool('T33: confidence equality invariant holds', equality.valid);

// ============================================================================
// SUMMARY
// ============================================================================
console.log('\n================================================================');
console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
}
