import { classifyNepalPhone } from '../src/services/business-extractor.service';
import { normalizePhoneDigits } from '../src/services/entity-resolution.service';
import {
  normalizeListingPhones,
  type BusinessListing,
} from '../src/mastra/workflows/research-workflow';

console.log('================================================================');
console.log('RUNNING TASK 4 PHONE DEDUP INVARIANT TESTS (17 CASES)');
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

function assertTrue(testName: string, condition: boolean) {
  if (condition) {
    console.log(`✅ PASSED: ${testName}`);
    passed++;
  } else {
    console.error(`❌ FAILED: ${testName} (Condition was false)`);
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
    metadata: partial.metadata ?? { source: 'web', extractedAt: '', confidence: 0.8 },
    process: partial.process ?? 'Verified via Google + Web search',
    links: partial.links ?? [],
    gpsCoordinates: partial.gpsCoordinates,
    rating: partial.rating,
    ratingCount: partial.ratingCount,
    businessType: partial.businessType,
    placeId: partial.placeId,
  };
}

// ============================================================================
// 1. CLASSIFICATION REGRESSION TESTS (verify classifyNepalPhone behavior)
// ============================================================================

// Test 1: +9851201603 -> mobile, digits=9851201603
const c1 = classifyNepalPhone('+9851201603');
assertEqual('Test 1: +9851201603 type is mobile', c1.type, 'mobile');
assertEqual('Test 1: +9851201603 canonical digits', c1.digits, '9851201603');

// Test 2: +977-985-1201603 -> mobile, digits=9851201603
const c2 = classifyNepalPhone('+977-985-1201603');
assertEqual('Test 2: +977-985-1201603 type is mobile', c2.type, 'mobile');
assertEqual('Test 2: +977-985-1201603 canonical digits', c2.digits, '9851201603');

// Test 3: 985-1201603 -> mobile, digits=9851201603
const c3 = classifyNepalPhone('985-1201603');
assertEqual('Test 3: 985-1201603 type is mobile', c3.type, 'mobile');
assertEqual('Test 3: 985-1201603 canonical digits', c3.digits, '9851201603');

// Test 4: All three formats collapse to the exact same canonical key
assertEqual('Test 4: same canonical key (c1 === c2)', c1.digits, c2.digits);
assertEqual('Test 4: same canonical key (c2 === c3)', c2.digits, c3.digits);

// Test 5: Landline classification and distinct digits
const c5 = classifyNepalPhone('01-5320746');
assertEqual('Test 5: 01-5320746 is landline', c5.type, 'landline');
assertTrue('Test 5: landline digits !== mobile digits', c5.digits !== c1.digits);

// Test 6: International negative test - US +1 number with 10 digits starting with 98
// must NOT be classified as Nepal mobile
const c6 = classifyNepalPhone('+1-980-123-4567');
assertTrue('Test 6: +1-980-123-4567 is NOT classified as mobile', c6.type !== 'mobile');
assertEqual('Test 6: +1-980-123-4567 classified as international', c6.type, 'international');

// ============================================================================
// 2. INVARIANT TESTS — phones ∩ mobiles = ∅
// ============================================================================

// Test 7: Misplaced mobile in phones array along with same mobile in mobiles
const listing7 = makeListing({
  phones: ['+9851201603', '01-5320746'], // First is mobile wrongly in phones
  mobiles: ['+977-985-1201603'],
});
normalizeListingPhones(listing7);
assertEqual('Test 7: landline preserved in phones', listing7.phones.length, 1);
assertEqual('Test 7: landline format', listing7.phones[0], '+977-01-5320746');
assertEqual('Test 7: mobile correctly moved/deduped in mobiles', listing7.mobiles.length, 1);
assertEqual('Test 7: mobile format', listing7.mobiles[0], '+977-985-1201603');

// Test 8: Cross-array dedup - duplicate numbers in both arrays
const listing8 = makeListing({
  phones: ['980-1234567'],
  mobiles: ['+977-980-1234567'],
});
normalizeListingPhones(listing8);
const allDigits8 = [...listing8.phones, ...listing8.mobiles].map((p) => normalizePhoneDigits(p));
const uniqueDigits8 = new Set(allDigits8);
assertTrue('Test 8: all canonical digits unique across arrays', allDigits8.length === uniqueDigits8.size);
assertEqual('Test 8: phones empty', listing8.phones.length, 0);
assertEqual('Test 8: mobiles has 1', listing8.mobiles.length, 1);

// Test 9: Empty arrays do not throw
const listing9 = makeListing({ phones: [], mobiles: [] });
normalizeListingPhones(listing9);
assertEqual('Test 9: empty phones length', listing9.phones.length, 0);
assertEqual('Test 9: empty mobiles length', listing9.mobiles.length, 0);

// Test 10: Purge invalid phone entries
const listing10 = makeListing({
  phones: ['not-a-phone', ''],
  mobiles: ['abc', '123'],
});
normalizeListingPhones(listing10);
assertEqual('Test 10: invalid phones cleared', listing10.phones.length, 0);
assertEqual('Test 10: invalid mobiles cleared', listing10.mobiles.length, 0);

// Test 11: Valid landlines stay in phones, valid mobiles stay in mobiles
const listing11 = makeListing({
  phones: ['01-4240520', '01-5363501'],
  mobiles: ['980-1234567', '970-9876543'],
});
normalizeListingPhones(listing11);
assertEqual('Test 11: 2 landlines in phones', listing11.phones.length, 2);
assertEqual('Test 11: 2 mobiles in mobiles', listing11.mobiles.length, 2);

// Test 12: Multiple display variants of same number collapse to one
const listing12 = makeListing({
  phones: [],
  mobiles: ['+9851201603', '985-1201603', '+977-985-1201603'],
});
normalizeListingPhones(listing12);
assertEqual('Test 12: 3 variants collapse to 1 mobile', listing12.mobiles.length, 1);

// Test 13: Mixed valid and invalid entries
const listing13 = makeListing({
  phones: ['01-4240520', 'invalid', ''],
  mobiles: ['980-1234567', 'not-a-phone'],
});
normalizeListingPhones(listing13);
assertEqual('Test 13: 1 valid landline kept', listing13.phones.length, 1);
assertEqual('Test 13: 1 valid mobile kept', listing13.mobiles.length, 1);

// Test 14: International number routes to phones
const listing14 = makeListing({
  phones: ['+1-402-650-3670'],
  mobiles: [],
});
normalizeListingPhones(listing14);
assertEqual('Test 14: international stays in phones', listing14.phones.length, 1);
assertEqual('Test 14: no mobiles', listing14.mobiles.length, 0);

// ============================================================================
// 3. PIPELINE BUG SIMULATION TESTS
// ============================================================================

// Test 15: Simulate GAP 1 - Maps mobile phone pushed to phones, then normalized
const listing15 = makeListing({
  phones: ['985-1201603'], // Maps phone wrongly placed in phones
  mobiles: ['+977-985-1201603'], // Sanitizer classified it
});
normalizeListingPhones(listing15);
assertEqual('Test 15: GAP 1 fixed - 0 phones after normalization', listing15.phones.length, 0);
assertEqual('Test 15: GAP 1 fixed - 1 mobile after normalization', listing15.mobiles.length, 1);

// Test 16: Simulate GAP 2 - Tradesman mobile placed in phones
const listing16 = makeListing({
  phones: ['970-8765432'], // Mobile in phones (GAP 2 bug)
  mobiles: [],
});
normalizeListingPhones(listing16);
assertEqual('Test 16: GAP 2 fixed - 0 landlines in phones', listing16.phones.length, 0);
assertEqual('Test 16: GAP 2 fixed - 1 mobile in mobiles', listing16.mobiles.length, 1);

// ============================================================================
// 4. WORKFLOW-STYLE INTEGRATION TEST
// ============================================================================

// Test 17: Full workflow integration - Maps + LLM + Website sources combined
const listing17 = makeListing({
  phones: ['01-5320746'], // Landline from LLM synthesis
  mobiles: ['+977-9851201603'], // Mobile from website evidence
});
// Add a second mobile via simulated Maps re-injection
listing17.mobiles.push('+9851201603'); // Same canonical, different raw display
normalizeListingPhones(listing17);

assertEqual('Test 17: 1 landline preserved', listing17.phones.length, 1);
assertEqual('Test 17: 1 mobile preserved (deduped)', listing17.mobiles.length, 1);
assertEqual('Test 17: landline format', listing17.phones[0], '+977-01-5320746');
assertEqual('Test 17: mobile format', listing17.mobiles[0], '+977-985-1201603');

const all17 = [...listing17.phones, ...listing17.mobiles];
const digits17 = all17.map((p) => normalizePhoneDigits(p));
assertEqual('Test 17: all canonical digits strictly unique', digits17.length, new Set(digits17).size);

console.log('\n================================================================');
console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
}
