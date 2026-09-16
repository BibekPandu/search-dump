import {
  isRealSocialProfile,
  isBusinessOwnedSocialProfile,
  stripVendorAttribution,
} from '../src/services/business-extractor.service';
import {
  classifyWebsiteRelationship,
  detectVendorFromContent,
} from '../src/services/website-relationship.service';
import { normalizePhoneDigits } from '../src/services/entity-resolution.service';

console.log('================================================================');
console.log('RUNNING TASK 2 REGRESSION TESTS (27 CASES)');
console.log('================================================================\n');

let passed = 0;
let failed = 0;

function assertEqual(testName: string, actual: any, expected: any) {
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

// ── 1-4: Social Reserved Paths ────────────────────────────────────────────────
assertEqual(
  'Test 1: FB /people reserved path',
  isRealSocialProfile('https://facebook.com/people', 'facebook'),
  false
);

assertEqual(
  'Test 2: FB /marketplace reserved path',
  isRealSocialProfile('https://facebook.com/marketplace', 'facebook'),
  false
);

assertEqual(
  'Test 3: Twitter /notifications reserved path',
  isRealSocialProfile('https://twitter.com/notifications', 'twitter'),
  false
);

assertEqual(
  'Test 4: Real FB business profile',
  isRealSocialProfile('https://facebook.com/HotelYakAndYeti', 'facebook'),
  true
);

// ── 5-10: Social Ownership / Vendor-Profile Filter ───────────────────────────
assertEqual(
  'Test 5: Reject facebook.com/SitePad for Clean O\' Clock',
  isBusinessOwnedSocialProfile('https://facebook.com/SitePad', 'facebook', "Clean O' Clock", 'cleanoclock.com'),
  false
);

assertEqual(
  'Test 6: Reject twitter.com/sitepad_editor for Clean O\' Clock',
  isBusinessOwnedSocialProfile('https://twitter.com/sitepad_editor', 'twitter', "Clean O' Clock", 'cleanoclock.com'),
  false
);

assertEqual(
  'Test 7: Reject linkedin.com/company/softaculous-ltd- for Clean O\' Clock',
  isBusinessOwnedSocialProfile('https://linkedin.com/company/softaculous-ltd-', 'linkedin', "Clean O' Clock", 'cleanoclock.com'),
  false
);

assertEqual(
  'Test 8: Accept facebook.com/cleanoclock for Clean O\' Clock',
  isBusinessOwnedSocialProfile('https://facebook.com/cleanoclock', 'facebook', "Clean O' Clock", 'cleanoclock.com'),
  true
);

assertEqual(
  'Test 9: Accept facebook.com/hotel-yak-yeti for Hotel Yak & Yeti',
  isBusinessOwnedSocialProfile('https://facebook.com/hotel-yak-yeti', 'facebook', 'Hotel Yak & Yeti', 'yakandyeti.com'),
  true
);

assertEqual(
  'Test 10: Reject facebook.com/randomprofile999 for Hotel Yak & Yeti',
  isBusinessOwnedSocialProfile('https://facebook.com/randomprofile999', 'facebook', 'Hotel Yak & Yeti', 'yakandyeti.com'),
  false
);

// ── 11-18: Vendor Stripper Tests ──────────────────────────────────────────────
assertEqual(
  'Test 11: Strip Developed by Longtail e-Media',
  stripVendorAttribution('Hotel info. Developed by Longtail e-Media.').trim(),
  'Hotel info.'
);

assertEqual(
  'Test 12: Strip Powered by SitePad',
  stripVendorAttribution('Welcome. Powered by SitePad').trim(),
  'Welcome.'
);

assertEqual(
  'Test 13: Strip Website Designed & Developed by MyAgency',
  stripVendorAttribution('Website Designed & Developed by MyAgency').trim(),
  ''
);

assertEqual(
  'Test 14: Preserve "Managed by Himalayan Hospitality Group"',
  stripVendorAttribution('Managed by Himalayan Hospitality Group'),
  'Managed by Himalayan Hospitality Group'
);

assertEqual(
  'Test 15: Preserve "Contact us by email"',
  stripVendorAttribution('Contact us by email'),
  'Contact us by email'
);

assertEqual(
  'Test 16: Preserve "By appointment only"',
  stripVendorAttribution('By appointment only'),
  'By appointment only'
);

assertEqual(
  'Test 17: Preserve "Designed by our architectural team"',
  stripVendorAttribution('Designed by our architectural team'),
  'Designed by our architectural team'
);

assertEqual(
  'Test 18: Strip <!-- Powered by SitePad -->',
  stripVendorAttribution('<!-- Powered by SitePad -->').trim(),
  ''
);

// ── 19-22: Corporate Parent Tests ──────────────────────────────────────────────
const ihgCorp = classifyWebsiteRelationship(
  'https://ihg.com/holidayinn/kathmandu',
  'Holiday Inn Express Kathmandu'
);
assertEqual('Test 19A: IHG child brand relationship', ihgCorp.relationship, 'corporate_parent');
assertEqual('Test 19B: IHG child brand enrichable flag', ihgCorp.isContactEnrichable, true);

const ihgUnrelated = classifyWebsiteRelationship('https://ihg.com', 'Nepal Travel Agency');
assertEqual('Test 20: IHG non-brand name fallback', ihgUnrelated.relationship, 'unverified');

// Exact vs near-miss corporate phone test
const mapsPhone = '+977-9802356232';
const corporatePhoneExact = '9802356232';
const corporatePhoneNearMiss = '+977-9812356232';

assertEqual(
  'Test 21: Corporate phone exact canonical match',
  normalizePhoneDigits(mapsPhone) === normalizePhoneDigits(corporatePhoneExact),
  true
);

assertEqual(
  'Test 22: Corporate phone near-miss mismatch',
  normalizePhoneDigits(mapsPhone) === normalizePhoneDigits(corporatePhoneNearMiss),
  false
);

// ── 23-27: Classification Tests ───────────────────────────────────────────────
const wixRel = classifyWebsiteRelationship('https://mybusiness.wixsite.com/mysite', 'My Business');
assertEqual('Test 23: Wix domain -> service_platform', wixRel.relationship, 'service_platform');

const sitepadSub = classifyWebsiteRelationship('https://myhotel.sitepad.com', 'My Hotel');
assertEqual('Test 24: sitepad subdomain -> service_platform', sitepadSub.relationship, 'service_platform');

const ypRel = classifyWebsiteRelationship('https://yellowpages.com/business', 'ABC Corp');
assertEqual('Test 25: yellowpages -> directory', ypRel.relationship, 'directory');

const searchactualRel = classifyWebsiteRelationship('https://searchactual.com', 'ABC Corp');
assertEqual('Test 26: searchactual -> directory', searchactualRel.relationship, 'directory');

const myhotelFingerprint = classifyWebsiteRelationship(
  'https://myhotel.com',
  'My Hotel',
  'Powered by SitePad'
);
assertEqual(
  'Test 27A: First-party domain stays first_party despite vendor content',
  myhotelFingerprint.relationship,
  'first_party'
);
assertEqual(
  'Test 27B: Vendor fingerprint is detected in signals',
  detectVendorFromContent('Powered by SitePad') !== null,
  true
);

console.log('\n================================================================');
console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
console.log('================================================================');

if (failed > 0) {
  process.exit(1);
}
