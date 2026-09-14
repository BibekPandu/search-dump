import { sanitizeListingWithEvidence, type BusinessListing } from '../src/mastra/workflows/research-workflow';
import { expandSlashExtensions, extractLandlinesAndIntl, extractMobiles, isRealSocialProfile } from '../src/services/business-extractor.service';
import type { VerifiedBusinessEvidence } from '../src/mastra/agents/research-agent/verification.schema';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${message}`);
}

console.log('===============================================================');
console.log('🧪 RUNNING STEP-3 PROJECTION & TAXONOMY REGRESSION TESTS (v1.4)');
console.log('===============================================================');

// --- TEST 1: Strict Phone/Mobile Separation (phones ∩ mobiles = ∅) ---
console.log('\n--- 1. Strict Phone / Mobile Separation in sanitizeListingWithEvidence ---');

const mockEvidence: VerifiedBusinessEvidence = {
  candidate: {
    name: 'Kumari Tours & Travels',
    location: 'Woodland complex, Kathmandu',
    website: 'https://kumaritravel.com/',
    phone: '01-5363501',
    rating: 5,
    ratingCount: 212,
    category: 'Airline ticket agency',
    sources: {
      googleMaps: { found: true, address: 'Kathmandu' },
      webSearch: [],
    },
    entityMatch: { matched: true, confidence: 1, method: 'phone' },
    classification: { status: 'usable', type: 'business', confidence: 1, reason: 'Test' },
  },
  websiteEvidence: {
    url: 'https://kumaritravel.com/',
    domain: 'kumaritravel.com',
    pages: [],
    extractedEmails: ['info@kumaritravel.com'],
    extractedPhones: ['01-5363501', '01-5363511', '01-5363560', '+1 301 322 1427'],
    extractedMobiles: ['+977-9851334626', '9801025057'],
    extractedSocialLinks: {
      facebook: 'https://www.facebook.com/kumaritravel',
      instagram: 'https://www.instagram.com/kumaritravel',
      tiktok: '',
      other: {},
    },
    extractedServices: [],
    favicon: 'https://kumaritravel.com/favicon.ico',
  },
  verification: {
    status: 'verified',
    overallConfidence: 0.95,
    checks: {
      websiteIsUsableOfficial: true,
      websiteDomainMatchesCandidate: true,
      businessNameFoundOnWebsite: true,
      phoneMatchesMaps: true,
      addressOrLocationFoundOnWebsite: true,
      emailFoundOnWebsite: true,
      socialLinksFoundOnWebsite: true,
    },
    notes: ['Verified test'],
  },
};

const baseListing: BusinessListing = {
  name: 'Kumari Tours & Travels',
  location: 'Kathmandu',
  emails: [],
  phones: [],
  mobiles: [],
  websites: [],
  icon: '',
  socialLinks: { facebook: '', instagram: '', tiktok: '', other: {} },
  otherDetails: { snippet: '', address: '', rating: 5, ratingCount: 212, businessType: 'Travel', placeId: '1' },
  metadata: { source: 'google_maps', extractedAt: new Date().toISOString(), confidence: 0.95 },
  process: 'test',
  links: [],
};

const sanitized = sanitizeListingWithEvidence(baseListing, mockEvidence);

assert(sanitized.mobiles.length === 2, `mobiles is populated with exactly 2 mobiles (got ${sanitized.mobiles.length})`);
assert(sanitized.mobiles.includes('+977-9851334626'), 'mobiles contains +977-9851334626');
assert(sanitized.mobiles.includes('9801025057'), 'mobiles contains 9801025057');
assert(sanitized.phones.includes('01-5363501'), 'phones contains 01-5363501');
assert(sanitized.phones.includes('01-5363511'), 'phones contains 01-5363511');
assert(sanitized.phones.includes('01-5363560'), 'phones contains 01-5363560');
assert(sanitized.phones.includes('+1 301 322 1427'), 'phones contains international non-mobile +1 301 322 1427');

// Invariant: phones ∩ mobiles = ∅
const phoneDigits = new Set(sanitized.phones.map((p) => p.replace(/\D/g, '')));
const hasOverlap = sanitized.mobiles.some((m) => phoneDigits.has(m.replace(/\D/g, '')));
assert(!hasOverlap, 'Strict taxonomy invariant: phones ∩ mobiles = ∅ (ZERO overlap)');

// --- TEST 2: Kumari Slash-Extension Expansion ---
console.log('\n--- 2. EPABX Slash Extension Expansion ---');

const kumariExtensions = expandSlashExtensions('+977 1 5363501/511/560');
assert(kumariExtensions.length === 3, `Kumari +977 1 5363501/511/560 expanded to 3 numbers (got ${kumariExtensions.length})`);
assert(kumariExtensions[0] === '+977 1 5363501', `First expanded number is +977 1 5363501 (got ${kumariExtensions[0]})`);
assert(kumariExtensions[1] === '+977 1 5363511', `Second expanded number is +977 1 5363511 (got ${kumariExtensions[1]})`);
assert(kumariExtensions[2] === '+977 1 5363560', `Third expanded number is +977 1 5363560 (got ${kumariExtensions[2]})`);

const trunkExtensions = expandSlashExtensions('01-5363501/511/560');
assert(trunkExtensions.length === 3, `01-5363501/511/560 expanded to 3 numbers (got ${trunkExtensions.length})`);
assert(trunkExtensions[1] === '01-5363511', `Trunk expanded candidate is 01-5363511 (got ${trunkExtensions[1]})`);

// Guardrail: arbitrary mobile strings without shared prefix are strictly rejected
const mobileSlash = expandSlashExtensions('9851234567/568');
assert(mobileSlash.length === 0, `Mobile slash 9851234567/568 strictly rejected without shared prefix (got ${mobileSlash.length})`);

// --- TEST 3: Social Profile Validation (Facebook profile.php?id=...) ---
console.log('\n--- 3. Social Profile Validation (Sabai Sabai Facebook fix) ---');

assert(
  isRealSocialProfile('https://www.facebook.com/profile.php?id=61578085095209', 'facebook'),
  'Facebook profile.php with numeric id= parameter accepted'
);
assert(
  !isRealSocialProfile('https://www.facebook.com/profile.php', 'facebook'),
  'Bare Facebook profile.php without id= parameter rejected'
);
assert(
  !isRealSocialProfile('https://www.facebook.com/profile.php?id=notdigits', 'facebook'),
  'Facebook profile.php with non-digit id= rejected'
);
assert(
  isRealSocialProfile('https://www.tiktok.com/@sabai.sabai.trip', 'tiktok'),
  'TikTok handle @sabai.sabai.trip accepted'
);
assert(
  isRealSocialProfile('https://www.instagram.com/sabai_sabai.trip/', 'instagram'),
  'Instagram handle sabai_sabai.trip accepted'
);

console.log('\n===============================================================');
console.log('🎉 ALL STEP-3 PROJECTION & TAXONOMY TESTS PASSED (100%)');
console.log('===============================================================');
