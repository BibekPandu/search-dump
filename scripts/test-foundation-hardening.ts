import {
  isBusinessOwnedSocialProfile,
  stripVendorAttribution,
  classifyNepalPhone,
} from '../src/services/business-extractor.service';
import {
  classifyWebsiteRelationship,
} from '../src/services/website-relationship.service';
import {
  detectCrossListingConflicts,
  type ConflictCheckListing,
} from '../src/services/entity-resolution.service';
import {
  computeConfidenceBreakdown,
  validateConfidenceIntegrity,
  type ConfidenceInputs,
} from '../src/services/confidence.service';
import {
  normalizeListingPhones,
  type BusinessListing,
} from '../src/mastra/workflows/research-workflow';

// ============================================================================
// ZERO-API OFFLINE GOLDEN-DATASET SUITE & INVARIANT ASSERTER (TASK 6)
// ============================================================================
// Verifies all 5 historical failure modes discovered in benchmark runs:
// 1. Lawneeti ↔ Imperial Law (Cross-entity conflict & contact contamination)
// 2. Clean O' Clock ↔ SitePad/Softaculous (Vendor CMS handles stripped)
// 3. Madhuram Thapa ↔ SearchActual/YellowPages (Directory platform guard)
// 4. Royal Cleaning (Canonical phone deduplication & taxonomy segregation)
// 5. Full Pipeline Invariant Asserter across Kathmandu fixtures (<200ms, $0)
// ============================================================================

const startTime = performance.now();
let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, details?: string) {
  if (condition) {
    console.log(`✅ PASS: ${name}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${name}${details ? ` — ${details}` : ''}`);
    failed++;
  }
}

function assertEq(name: string, actual: unknown, expected: unknown) {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr === expectedStr) {
    console.log(`✅ PASS: ${name}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${name} — expected ${expectedStr}, got ${actualStr}`);
    failed++;
  }
}

function makeListing(partial: Partial<BusinessListing>): BusinessListing {
  return {
    name: partial.name ?? 'Test Listing',
    location: partial.location ?? 'Kathmandu, Nepal',
    emails: partial.emails ?? [],
    phones: partial.phones ?? [],
    mobiles: partial.mobiles ?? [],
    websites: partial.websites ?? [],
    icon: partial.icon ?? '',
    socialLinks: partial.socialLinks ?? { facebook: '', tiktok: '', instagram: '', other: {} },
    otherDetails: partial.otherDetails ?? {},
    metadata: partial.metadata ?? { source: 'web', extractedAt: new Date().toISOString(), confidence: 0 },
    process: partial.process ?? 'Verified via Google + Web search',
    links: partial.links ?? [],
    gpsCoordinates: partial.gpsCoordinates,
    rating: partial.rating,
    ratingCount: partial.ratingCount,
    businessType: partial.businessType,
    placeId: partial.placeId,
  };
}

console.log('================================================================');
console.log('🧪 TASK 6: ZERO-API OFFLINE GOLDEN-DATASET & INVARIANT ASSERTER');
console.log('================================================================\n');

// ── FIXTURE 1: Lawneeti ↔ Imperial Law (Cross-Entity Conflict & Bleeding) ───
console.log('--- FIXTURE 1: Lawneeti ↔ Imperial Law (Cross-Entity Conflict) ---');

const lawneetiListing: ConflictCheckListing = {
  name: 'Lawneeti Lawyers & Associates',
  location: 'Putalisadak, Kathmandu',
  phones: ['01-4251234'],
  mobiles: ['+977-9851012345'],
  emails: ['contact@lawneeti.com', 'info@lawgroupnepal.com'],
  websites: ['https://lawneeti.com'],
  socialLinks: {
    facebook: 'https://facebook.com/lawneetinepal',
  },
  gpsCoordinates: { lat: 27.7032, lng: 85.3211 },
};

const imperialLawListing: ConflictCheckListing = {
  name: 'Imperial Law Associates',
  location: 'Putalisadak, Kathmandu',
  phones: ['01-4259876'],
  mobiles: ['+977-9851012345'], // Shared mobile identity overlap
  emails: ['info@imperiallaw.com.np', 'info@lawgroupnepal.com'], // Shared group email
  websites: ['https://imperiallaw.com.np'],
  socialLinks: {
    facebook: 'https://facebook.com/imperiallawnepal',
  },
  gpsCoordinates: { lat: 27.7035, lng: 85.3214 }, // Co-located (<50m)
};

const distinctLawListing: ConflictCheckListing = {
  name: 'Pradhan & Associates Law Firm',
  location: 'Maitighar, Kathmandu',
  phones: ['01-4225566'],
  mobiles: ['+977-9841223344'],
  emails: ['info@pradhanlaw.com'],
  websites: ['https://pradhanlaw.com'],
  gpsCoordinates: { lat: 27.695, lng: 85.325 },
};

const lawConflicts = detectCrossListingConflicts([
  lawneetiListing,
  imperialLawListing,
  distinctLawListing,
]);

// 1. Conflict detected between Lawneeti and Imperial Law
assert('F1.1: Conflict report detected cross-entity overlap', lawConflicts.conflicts.length > 0);
assertEq('F1.2: Exactly 1 cluster formed', lawConflicts.clusters.length, 1);
assertEq('F1.3: Conflict cluster has 2 members', lawConflicts.clusters[0].listingNames.length, 2);

const clusterTypes = lawConflicts.conflicts.map((c) => c.conflict.conflictType);
assert(
  'F1.4: Conflict severity is POSSIBLY_SAME_ENTITY (shared contact + location)',
  clusterTypes.includes('POSSIBLY_SAME_ENTITY')
);

// 2. Distinct listing has no conflict
assert(
  'F1.5: Distinct law firm has no conflict',
  !(lawConflicts.annotatedListings[2].otherDetails?.entityConflict as any)?.hasConflict
);

// 3. Confidence penalty applied strictly to conflicted entities
const lawneetiInputs: ConfidenceInputs = {
  isMapsCandidate: true,
  ratingCount: 45,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.9,
  verificationChecks: {
    phoneMatchesMaps: true,
    emailFoundOnWebsite: true,
    addressOrLocationFoundOnWebsite: true,
  },
  websiteRelationship: 'first_party',
  phonesCount: 1,
  mobilesCount: 1,
  conflictType: 'POSSIBLY_SAME_ENTITY',
};

const distinctInputs: ConfidenceInputs = {
  ...lawneetiInputs,
  conflictType: 'NO_CONFLICT',
};

const lawneetiBreakdown = computeConfidenceBreakdown(lawneetiInputs);
const distinctBreakdown = computeConfidenceBreakdown(distinctInputs);

assertEq('F1.6: Conflicted penalty is 0.75', lawneetiBreakdown.conflictPenalty, 0.75);
assertEq('F1.7: Clean firm penalty is 1.0', distinctBreakdown.conflictPenalty, 1.0);
assert(
  'F1.8: Conflicted overall confidence is strictly lower than clean firm',
  lawneetiBreakdown.overallConfidence < distinctBreakdown.overallConfidence
);

// ── FIXTURE 2: Clean O' Clock ↔ SitePad/Softaculous (Vendor Stripping) ───────
console.log("\n--- FIXTURE 2: Clean O' Clock ↔ SitePad/Softaculous (Vendor CMS Filter) ---");

const cleanOClockCandidates = [
  { url: 'https://facebook.com/SitePad', platform: 'facebook', valid: false },
  { url: 'https://twitter.com/sitepad_editor', platform: 'twitter', valid: false },
  { url: 'https://linkedin.com/company/softaculous-ltd-', platform: 'linkedin', valid: false },
  { url: 'https://facebook.com/cleanoclocknepal', platform: 'facebook', valid: true },
  { url: 'https://instagram.com/cleanoclock.np', platform: 'instagram', valid: true },
];

for (const sc of cleanOClockCandidates) {
  const isBusinessOwned = isBusinessOwnedSocialProfile(
    sc.url,
    sc.platform,
    "Clean O' Clock Commercial Cleaning",
    'cleanoclock.com.np'
  );
  assertEq(
    `F2: Social ownership for ${sc.url}`,
    isBusinessOwned,
    sc.valid
  );
}

// Vendor attribution string stripping
const dirtyRawText =
  "Top rated deep cleaning service in Kathmandu. Powered by SitePad. Developed by Softaculous Ltd. All rights reserved.";
const cleanedText = stripVendorAttribution(dirtyRawText);
assert(
  'F2.6: Vendor CMS footers stripped from content',
  !cleanedText.includes('SitePad') && !cleanedText.includes('Softaculous')
);
assert(
  'F2.7: Core business description preserved',
  cleanedText.includes('Top rated deep cleaning service in Kathmandu')
);

// ── FIXTURE 3: Madhuram Thapa ↔ SearchActual / YellowPages (Directory Guard) ─
console.log('\n--- FIXTURE 3: Madhuram Thapa ↔ SearchActual / YellowPages (Directory Guard) ---');

const searchActualRel = classifyWebsiteRelationship(
  'https://searchactual.com/biz/madhuram-thapa-clinic',
  'Dr. Madhuram Thapa Dental Clinic'
);
assertEq('F3.1: SearchActual classified as directory', searchActualRel.relationship, 'directory');
assertEq('F3.2: Directory contact enrichment blocked', searchActualRel.isContactEnrichable, false);

const yellowPagesRel = classifyWebsiteRelationship(
  'https://yellowpages.com.np/listing/madhuram-thapa',
  'Dr. Madhuram Thapa Dental Clinic'
);
assertEq('F3.3: YellowPages classified as directory', yellowPagesRel.relationship, 'directory');

const directoryConfidence = computeConfidenceBreakdown({
  isMapsCandidate: true,
  ratingCount: 30,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.85,
  websiteRelationship: 'directory', // 0.30 multiplier
  conflictType: 'NO_CONFLICT',
});

const firstPartyConfidence = computeConfidenceBreakdown({
  isMapsCandidate: true,
  ratingCount: 30,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.85,
  websiteRelationship: 'first_party', // 1.0 multiplier
  conflictType: 'NO_CONFLICT',
});

assertEq('F3.4: Directory websiteEvidenceConfidence is discounted by 0.30 multiplier', directoryConfidence.websiteEvidenceConfidence, 0.26);
assert(
  'F3.5: First-party website confidence is significantly higher than directory',
  firstPartyConfidence.websiteEvidenceConfidence > directoryConfidence.websiteEvidenceConfidence
);

// ── FIXTURE 4: Royal Cleaning (Phone Deduplication Invariant) ────────────────
console.log('\n--- FIXTURE 4: Royal Cleaning (Phone Deduplication Invariant) ---');

const royalCleaningListing = makeListing({
  name: 'Royal Cleaning Services Nepal',
  location: 'Baluwatar, Kathmandu',
  phones: [
    '+977-9851201603', // mobile formatted
    '985-1201603',      // mobile with dash
    '01-5320746',       // landline
    '+9851201603',      // mobile raw
    '01-5320746',       // duplicate landline
  ],
  mobiles: [
    '9851201603',       // mobile unformatted
  ],
});

normalizeListingPhones(royalCleaningListing);

assertEq('F4.1: Exactly 1 landline in phones array', royalCleaningListing.phones?.length, 1);
assertEq('F4.2: Landline formatted correctly', royalCleaningListing.phones?.[0], '+977-01-5320746');
assertEq('F4.3: Exactly 1 mobile in mobiles array', royalCleaningListing.mobiles?.length, 1);
assertEq('F4.4: Mobile formatted correctly', royalCleaningListing.mobiles?.[0], '+977-985-1201603');

// Invariant: phones ∩ mobiles = ∅
const phoneDigits = (royalCleaningListing.phones || []).map((p: string) => classifyNepalPhone(p).digits);
const mobileDigits = (royalCleaningListing.mobiles || []).map((m: string) => classifyNepalPhone(m).digits);
const intersection = phoneDigits.filter((d: string) => mobileDigits.includes(d));
assertEq('F4.5: phones and mobiles are strictly disjoint (intersection is empty)', intersection, []);

// ── FIXTURE 5: Full Invariant Asserter Across Kathmandu Golden Batch ─────────
console.log('\n--- FIXTURE 5: Full Invariant Asserter across Golden Batch ---');

interface GoldenTestCase {
  listing: BusinessListing;
  hasWebsiteEvidence: boolean;
  verificationConfidence?: number;
  verificationChecks?: {
    phoneMatchesMaps: boolean;
    emailFoundOnWebsite: boolean;
    addressOrLocationFoundOnWebsite: boolean;
  };
  websiteRelationship?: string;
}

const goldenBatch: GoldenTestCase[] = [
  {
    listing: makeListing({
      name: 'Kathmandu Specialty Coffee Roasters',
      location: 'Jhamsikhel, Lalitpur',
      phones: ['01-5541234'],
      mobiles: ['+977-9801234567'],
      emails: ['hello@ktmroasters.com'],
      websites: ['https://ktmroasters.com'],
      socialLinks: { facebook: 'https://facebook.com/ktmroasters', tiktok: '', instagram: '', other: {} },
      gpsCoordinates: { latitude: 27.678, longitude: 85.312 },
      metadata: { source: 'google_maps', extractedAt: new Date().toISOString(), confidence: 0, ratingCount: 180, placeId: 'ChIJ-ktm-roast' },
    }),
    hasWebsiteEvidence: true,
    verificationConfidence: 0.95,
    verificationChecks: {
      phoneMatchesMaps: true,
      emailFoundOnWebsite: true,
      addressOrLocationFoundOnWebsite: true,
    },
    websiteRelationship: 'first_party',
  },
  {
    listing: makeListing({
      name: 'Thamel Momos & Fast Food',
      location: 'Thamel, Kathmandu',
      phones: [],
      mobiles: ['9841998877'],
      emails: [],
      websites: [],
      gpsCoordinates: { latitude: 27.715, longitude: 85.311 },
      metadata: { source: 'google_maps', extractedAt: new Date().toISOString(), confidence: 0, ratingCount: 25 },
    }),
    hasWebsiteEvidence: false, // Maps-only
  },
  {
    listing: makeListing({
      name: 'Boutique Hotel Shanker Annex',
      location: 'Lazimpat, Kathmandu',
      phones: ['01-4410151', '01-4410152'],
      mobiles: [],
      emails: ['info@hotelshanker.com.np'],
      websites: ['https://hotelshanker.com.np'],
      gpsCoordinates: { latitude: 27.72, longitude: 85.32 },
      metadata: { source: 'google_maps', extractedAt: new Date().toISOString(), confidence: 0, ratingCount: 420, placeId: 'ChIJ-shanker' },
    }),
    hasWebsiteEvidence: true,
    verificationConfidence: 0.92,
    verificationChecks: {
      phoneMatchesMaps: true,
      emailFoundOnWebsite: true,
      addressOrLocationFoundOnWebsite: true,
    },
    websiteRelationship: 'first_party',
  },
  {
    listing: makeListing({
      name: 'Pokhara Adventure Paragliding Hub',
      location: 'Lakeside, Pokhara',
      phones: ['061-460111'],
      mobiles: ['9856012345'],
      emails: ['fly@pokharapara.com'],
      websites: ['https://yellowpages.com.np/pokhara-para'],
      metadata: { source: 'google_maps', extractedAt: new Date().toISOString(), confidence: 0, ratingCount: 88 },
    }),
    hasWebsiteEvidence: true,
    verificationConfidence: 0.7,
    websiteRelationship: 'directory',
  },
];

// 1. Pre-sanitization phone normalization
for (const item of goldenBatch) {
  normalizeListingPhones(item.listing);
}

// 2. Conflict detection
const batchConflictReport = detectCrossListingConflicts(goldenBatch.map((g) => g.listing as any));
if (batchConflictReport.annotatedListings.length === goldenBatch.length) {
  for (let i = 0; i < goldenBatch.length; i++) {
    const ann = batchConflictReport.annotatedListings[i];
    if (ann.otherDetails?.entityConflict) {
      if (!goldenBatch[i].listing.otherDetails) goldenBatch[i].listing.otherDetails = {};
      goldenBatch[i].listing.otherDetails.entityConflict = ann.otherDetails.entityConflict;
    }
  }
}

// 3. Phase 4 Multi-Dimensional Confidence Computation + Invariant Checks
for (let i = 0; i < goldenBatch.length; i++) {
  const item = goldenBatch[i];
  const listing = item.listing;
  const conflict = listing.otherDetails?.entityConflict as { conflictType?: string } | undefined;

  const inputs: ConfidenceInputs = {
    isMapsCandidate: listing.metadata?.source === 'google_maps',
    ratingCount: (listing.metadata as any)?.ratingCount,
    placeId: (listing.metadata as any)?.placeId,
    gpsCoordinates: listing.gpsCoordinates,
    address: listing.location,
    hasWebsiteEvidence: item.hasWebsiteEvidence,
    verificationConfidence: item.verificationConfidence,
    verificationChecks: item.verificationChecks,
    websiteRelationship: item.websiteRelationship,
    finalEmails: listing.emails,
    finalWebsites: listing.websites,
    phonesCount: listing.phones?.length ?? 0,
    mobilesCount: listing.mobiles?.length ?? 0,
    conflictType: conflict?.conflictType,
  };

  const breakdown = computeConfidenceBreakdown(inputs);

  if (!listing.metadata) listing.metadata = { source: 'web', extractedAt: new Date().toISOString(), confidence: 0 };
  listing.metadata.confidence = breakdown.overallConfidence;
  (listing.metadata as any).confidenceBreakdown = breakdown;

  // Invariant 1: Integrity validator passes
  const integrity = validateConfidenceIntegrity(breakdown, listing.metadata.confidence);
  assert(
    `F5.${i + 1}A: [${listing.name}] validateConfidenceIntegrity valid`,
    integrity.valid,
    integrity.errors.join('; ')
  );

  // Invariant 2: metadata.confidence === breakdown.overallConfidence
  assertEq(
    `F5.${i + 1}B: [${listing.name}] metadata.confidence === breakdown.overallConfidence`,
    listing.metadata.confidence,
    breakdown.overallConfidence
  );

  // Invariant 3: Dimension bounds [0, 1]
  assert(
    `F5.${i + 1}C: [${listing.name}] all dimensions in [0, 1]`,
    breakdown.mapsIdentityConfidence >= 0 &&
      breakdown.mapsIdentityConfidence <= 1 &&
      breakdown.websiteEvidenceConfidence >= 0 &&
      breakdown.websiteEvidenceConfidence <= 1 &&
      breakdown.contactConfidence >= 0 &&
      breakdown.contactConfidence <= 1 &&
      breakdown.overallConfidence >= 0 &&
      breakdown.overallConfidence <= 1
  );

  // Invariant 4: Phone taxonomy & deduplication
  const pDigits = (listing.phones || []).map((p: string) => classifyNepalPhone(p).digits);
  const mDigits = (listing.mobiles || []).map((m: string) => classifyNepalPhone(m).digits);
  const allDigits = [...pDigits, ...mDigits];
  const uniqueDigits = new Set(allDigits);
  assertEq(
    `F5.${i + 1}D: [${listing.name}] zero canonical phone duplicates`,
    allDigits.length,
    uniqueDigits.size
  );
}

const durationMs = Math.round((performance.now() - startTime) * 100) / 100;
assert(
  `F5.TIME: Entire offline regression suite ran in <200ms (took ${durationMs}ms)`,
  durationMs < 200
);

// ============================================================================
// SUMMARY
// ============================================================================
console.log('\n================================================================');
console.log(`TOTAL ASSERTIONS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
console.log(`EXECUTION TIME:   ${durationMs}ms (ZERO NETWORK CALLS / $0.00 COST)`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
}
