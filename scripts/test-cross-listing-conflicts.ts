import {
  isIdentifyingEmail,
  detectConflictBetweenListings,
  detectCrossListingConflicts,
  type ConflictCheckListing,
} from '../src/services/entity-resolution.service';

console.log('================================================================');
console.log('RUNNING TASK 3 CROSS-LISTING CONFLICT TESTS (17 CASES)');
console.log('================================================================\n');

let passed = 0;
let failed = 0;

function assertEqual(testName: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`✅ PASSED: ${testName}`);
    passed++;
  } else {
    console.error(`❌ FAILED: ${testName}`);
    console.error(`   Actual:   ${JSON.stringify(actual)}`);
    console.error(`   Expected: ${JSON.stringify(expected)}`);
    failed++;
  }
}

// ── 1-6: isIdentifyingEmail Tests ───────────────────────────────────────────
assertEqual(
  'Test 1: isIdentifyingEmail with personal Gmail',
  isIdentifyingEmail('ram.shrestha@gmail.com'),
  true
);

assertEqual(
  'Test 2: isIdentifyingEmail with named employee email on custom domain',
  isIdentifyingEmail('john.doe@company.com'),
  true
);

assertEqual(
  'Test 3: isIdentifyingEmail with info@ role email',
  isIdentifyingEmail('info@hotelkathmandu.com'),
  false
);

assertEqual(
  'Test 4: isIdentifyingEmail with contact@ role email',
  isIdentifyingEmail('contact@agency.com'),
  false
);

assertEqual(
  'Test 5: isIdentifyingEmail with support@ role email',
  isIdentifyingEmail('support@trekking.com'),
  false
);

assertEqual(
  'Test 6: isIdentifyingEmail with admin@ role email',
  isIdentifyingEmail('admin@nepalexpeditions.org'),
  false
);

// ── 7-15: detectConflictBetweenListings Tests ────────────────────────────────

// Test 7: Shared identifying email across different listing names -> POSSIBLY_SAME_ENTITY
// Strong contact-identity overlap across different listing identities
const listing7A: ConflictCheckListing = {
  name: 'Alpine Treks & Expedition',
  emails: ['owner@adventuregroup.com'],
  phones: ['+977-1-4411111'],
  websites: ['https://alpinetreks.com'],
};
const listing7B: ConflictCheckListing = {
  name: 'Himalayan Summit Tours',
  emails: ['owner@adventuregroup.com'],
  phones: ['+977-1-4422222'],
  websites: ['https://himalayansummits.com'],
};
const res7 = detectConflictBetweenListings(listing7A, listing7B, 0, 1);
assertEqual('Test 7: Shared identifying email -> POSSIBLY_SAME_ENTITY', res7?.conflictType, 'POSSIBLY_SAME_ENTITY');

// Test 8: Shared canonical phone number across different listing names -> POSSIBLY_SAME_ENTITY
// Strong contact-identity overlap across different listing identities
const listing8A: ConflictCheckListing = {
  name: 'Kathmandu Guest House Annex',
  phones: ['+977-1-4700000'],
  websites: ['https://kghannex.com'],
};
const listing8B: ConflictCheckListing = {
  name: 'Thamel Boutique Stay',
  phones: ['01-4700000'],
  websites: ['https://thamelstay.com'],
};
const res8 = detectConflictBetweenListings(listing8A, listing8B, 0, 1);
assertEqual('Test 8: Shared canonical phone -> POSSIBLY_SAME_ENTITY', res8?.conflictType, 'POSSIBLY_SAME_ENTITY');

// Test 9: Shared website and shared phone -> POSSIBLY_SAME_ENTITY
const listing9A: ConflictCheckListing = {
  name: 'Nepal Trekking Adventures Pvt Ltd',
  phones: ['+977 9851012345'],
  websites: ['https://kathmandutrek.com'],
};
const listing9B: ConflictCheckListing = {
  name: 'Kathmandu Trek & Tours',
  phones: ['9851012345'],
  websites: ['https://kathmandutrek.com/about'],
};
const res9 = detectConflictBetweenListings(listing9A, listing9B, 0, 1);
assertEqual('Test 9: Shared website & phone without GPS -> POSSIBLY_SAME_ENTITY', res9?.conflictType, 'POSSIBLY_SAME_ENTITY');

// Test 10: Strict duplicate gate (GPS < 50m + shared phone + shared domain) -> DUPLICATE_MAPS_LISTING
const listing10A: ConflictCheckListing = {
  name: 'Hotel Yak & Yeti',
  phones: ['+977-1-4248999'],
  websites: ['https://yakandyeti.com'],
  latitude: 27.7123,
  longitude: 85.3188,
};
const listing10B: ConflictCheckListing = {
  name: 'Hotel Yak and Yeti Kathmandu',
  phones: ['01-4248999'],
  websites: ['https://www.yakandyeti.com/contact'],
  latitude: 27.71232,
  longitude: 85.31881,
};
const res10 = detectConflictBetweenListings(listing10A, listing10B, 0, 1);
assertEqual('Test 10: Strict duplicate gate (GPS <50m + phone + domain) -> DUPLICATE_MAPS_LISTING', res10?.conflictType, 'DUPLICATE_MAPS_LISTING');

// Test 11: Shared domain + shared social but DIFFERENT phones and NO emails -> RELATED_BRAND
// Note: This test works because there is no email/phone overlap, avoiding POSSIBLY_SAME_ENTITY.
const listing11A: ConflictCheckListing = {
  name: 'Wilderness Nepal Trekking',
  phones: ['+977-1-4433333'],
  websites: ['https://wildernessnepal.com'],
  socialLinks: {
    facebook: 'https://facebook.com/wildernessnepal',
  },
};
const listing11B: ConflictCheckListing = {
  name: 'Wilderness Nepal Expeditions',
  phones: ['+977-1-4455555'],
  websites: ['https://wildernessnepal.com/expeditions'],
  socialLinks: {
    facebook: 'https://facebook.com/wildernessnepal',
  },
};
const res11 = detectConflictBetweenListings(listing11A, listing11B, 0, 1);
assertEqual('Test 11: Shared domain & social with different phones -> RELATED_BRAND', res11?.conflictType, 'RELATED_BRAND');

// Test 12: Shared generic email only (info@) with different phones, domains, names -> SHARED_OFFICE
const listing12A: ConflictCheckListing = {
  name: 'Himalayan Eco Cleaners',
  emails: ['info@nepaltourismhub.org'],
  phones: ['+977-1-4111111'],
  websites: ['https://ecocleanersnepal.com'],
};
const listing12B: ConflictCheckListing = {
  name: 'Shrestha Bookkeeping Services',
  emails: ['info@nepaltourismhub.org'],
  phones: ['+977-1-4222222'],
  websites: ['https://shresthabooks.com'],
};
const res12 = detectConflictBetweenListings(listing12A, listing12B, 0, 1);
assertEqual('Test 12: Shared generic role email only -> SHARED_OFFICE', res12?.conflictType, 'SHARED_OFFICE');

// Test 13: Co-located (GPS 120m) with different contacts, domains, and names -> SHARED_OFFICE
const listing13A: ConflictCheckListing = {
  name: 'Annapurna Coffee Roasters',
  phones: ['+977-1-4711111'],
  websites: ['https://annapurnacoffee.com'],
  latitude: 27.715,
  longitude: 85.312,
};
const listing13B: ConflictCheckListing = {
  name: 'Kathmandu Handicraft Emporium',
  phones: ['+977-1-4722222'],
  websites: ['https://ktmhandicrafts.com'],
  latitude: 27.7158,
  longitude: 85.3126,
};
const res13 = detectConflictBetweenListings(listing13A, listing13B, 0, 1);
assertEqual('Test 13: Close proximity co-located (<500m) with distinct contacts -> SHARED_OFFICE', res13?.conflictType, 'SHARED_OFFICE');

// Test 14: Totally independent businesses with no overlapping contact points -> NO_CONFLICT (null)
const listing14A: ConflictCheckListing = {
  name: 'Everest Momo Corner',
  phones: ['+977-1-4333333'],
  websites: ['https://everestmomo.com'],
  latitude: 27.701,
  longitude: 85.31,
};
const listing14B: ConflictCheckListing = {
  name: 'Pokhara Paragliding Hub',
  phones: ['+977-61-522222'],
  websites: ['https://pokharapara.com'],
  latitude: 28.209,
  longitude: 83.985,
};
const res14 = detectConflictBetweenListings(listing14A, listing14B, 0, 1);
assertEqual('Test 14: Completely distinct businesses -> null (NO_CONFLICT)', res14, null);

// Test 15: Same building (GPS 10m) + SAME DOMAIN + DIFFERENT PHONES -> RELATED_BRAND
// Reason: Shared domain is the reason for RELATED_BRAND, NOT GPS proximity.
// No email or phone overlap exists, so it correctly resolves to RELATED_BRAND rather than POSSIBLY_SAME_ENTITY.
const listing15A: ConflictCheckListing = {
  name: 'Heritage Plaza Suite A',
  phones: ['+977-1-4991111'],
  websites: ['https://heritageplazanepal.com/suite-a'],
  latitude: 27.714,
  longitude: 85.315,
};
const listing15B: ConflictCheckListing = {
  name: 'Heritage Plaza Suite B',
  phones: ['+977-1-4992222'],
  websites: ['https://heritageplazanepal.com/suite-b'],
  latitude: 27.71405,
  longitude: 85.31504,
};
const res15 = detectConflictBetweenListings(listing15A, listing15B, 0, 1);
assertEqual('Test 15: Shared domain + close GPS with distinct phones -> RELATED_BRAND', res15?.conflictType, 'RELATED_BRAND');

// ── 16-17: detectCrossListingConflicts Batch & Cluster Tests ─────────────────

// Test 16: Batch with 4 listings (A+B conflict, C+D independent)
const batch16: ConflictCheckListing[] = [
  {
    name: 'Trek Leader A',
    phones: ['+977-1-4881111'],
    websites: ['https://trekleaders.com'],
  },
  {
    name: 'Trek Leader B',
    phones: ['+977-1-4881111'],
    websites: ['https://otherwebsite.com'],
  },
  {
    name: 'Independent Bakery',
    phones: ['+977-1-4882222'],
    websites: ['https://bakerynepal.com'],
  },
  {
    name: 'Independent Laundry',
    phones: ['+977-1-4883333'],
    websites: ['https://laundrynepal.com'],
  },
];
const res16 = detectCrossListingConflicts(batch16);
assertEqual('Test 16: Batch conflicts count', res16.conflicts.length, 1);
assertEqual('Test 16: Batch clusters count', res16.clusters.length, 1);
assertEqual('Test 16: Listing 0 conflict flag', (res16.annotatedListings[0].otherDetails?.entityConflict as any)?.hasConflict, true);
assertEqual('Test 16: Listing 1 conflict flag', (res16.annotatedListings[1].otherDetails?.entityConflict as any)?.hasConflict, true);
assertEqual('Test 16: Listing 2 conflict flag', (res16.annotatedListings[2].otherDetails?.entityConflict as any)?.hasConflict, false);
assertEqual('Test 16: Listing 3 conflict flag', (res16.annotatedListings[3].otherDetails?.entityConflict as any)?.hasConflict, false);

// Test 17: 3-way cluster chaining (A shares phone with B, B shares identifying email with C)
// All 3 form a single connected cluster
const batch17: ConflictCheckListing[] = [
  {
    name: 'Nepal Guide Services',
    phones: ['+977-1-4990001'],
    websites: ['https://nepalguide.com'],
  },
  {
    name: 'Nepal Porter Network',
    phones: ['+977-1-4990001'],
    emails: ['director@nepaladventures.org'],
    websites: ['https://nepalporter.com'],
  },
  {
    name: 'Nepal Adventure Logistics',
    emails: ['director@nepaladventures.org'],
    phones: ['+977-1-4990003'],
    websites: ['https://nepallogistics.com'],
  },
];
const res17 = detectCrossListingConflicts(batch17);
assertEqual('Test 17: 3-way cluster total conflicts detected', res17.conflicts.length, 2);
assertEqual('Test 17: 3-way cluster single cluster formed', res17.clusters.length, 1);
assertEqual('Test 17: 3-way cluster size', res17.clusters[0]?.listingIndices.length, 3);
assertEqual('Test 17: 3-way cluster conflictType', res17.clusters[0]?.conflictType, 'POSSIBLY_SAME_ENTITY');

console.log('\n================================================================');
console.log(`TOTAL TASK 3 TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
console.log('================================================================');

if (failed > 0) {
  process.exit(1);
}
