import assert from 'node:assert/strict';
import { extractDistinctiveNameTokens } from '../src/config/token-vocabulary.config.js';
import { namesAlign } from '../src/services/resolution/fallback-listing.service.js';
import { mergeDuplicateEntities, type ConflictCheckListing } from '../src/services/resolution/entity-resolution.service.js';
import { classifySocialProfile, extractFacebookHandle } from '../src/services/extraction/social-extractor.service.js';
import { extractAllFromPages } from '../src/services/extraction/page-extractor.service.js';
import { completeSocials } from '../src/services/resolution/social-completion.service.js';

console.log('=== Running Multi-Category False-Merge Guard & Data Quality Suite ===\n');

// ----------------------------------------------------------------------------
// Test 1: extractDistinctiveNameTokens Scoping & Guards
// ----------------------------------------------------------------------------
console.log('Test 1: extractDistinctiveNameTokens');

// 1a. Brand with distinctive part
const tCareFirst = extractDistinctiveNameTokens('CareFirst Dental');
assert.deepEqual(tCareFirst, ['carefirst']);
console.log('  ✓ "CareFirst Dental" -> ["carefirst"] (dental stripped)');

// 1b. Brand with fallback non-pure-generic token
const tCare = extractDistinctiveNameTokens('Care Dental Clinic');
assert.deepEqual(tCare, ['care']);
console.log('  ✓ "Care Dental Clinic" -> ["care"] (fallback guard active)');

// 1c. Pure generic names -> []
assert.deepEqual(extractDistinctiveNameTokens('Dental Clinic'), []);
assert.deepEqual(extractDistinctiveNameTokens('Best Dental Clinic'), []);
assert.deepEqual(extractDistinctiveNameTokens('The Restaurant & Bar'), []);
assert.deepEqual(extractDistinctiveNameTokens('Hotel & Cafe'), []);
console.log('  ✓ Pure generic names ("Dental Clinic", "Best Dental Clinic") -> []');

// 1d. Multi-category distinctive extraction
assert.deepEqual(extractDistinctiveNameTokens('Annapurna Restaurant & Bar'), ['annapurna']);
assert.deepEqual(extractDistinctiveNameTokens('Everest Restaurant & Bar'), ['everest']);
assert.deepEqual(extractDistinctiveNameTokens('Apex Law Associates'), ['apex']);
assert.deepEqual(extractDistinctiveNameTokens('Bright Future Secondary School'), ['bright', 'future', 'secondary']);
assert.deepEqual(extractDistinctiveNameTokens('Ever Vision Secondary School'), ['ever', 'vision', 'secondary']);
console.log('  ✓ Multi-category distinctive tokens extracted accurately');


// ----------------------------------------------------------------------------
// Test 2: Incident-Specific & Cross-Category namesAlign Non-Collision Tests
// ----------------------------------------------------------------------------
console.log('\nTest 2: namesAlign Incident-Specific & Cross-Category Non-Collision');

// 2a. Incident-specific pairs from 2026-09-28 corrupted run: MUST NOT MATCH
assert(!namesAlign('Dental Bee - Dental Clinic', 'Agrim Dental And Multi-speciality Clinic Thamel'));
assert(!namesAlign('Dental Bee - Dental Clinic', 'Dent Inn- the dental clinic'));
assert(!namesAlign('Dental Bee - Dental Clinic', 'Smile The Dental Clinic, Kathmandu'));
assert(!namesAlign('Dental Bee - Dental Clinic', 'Kathmandu Smile Dental Clinic'));
assert(!namesAlign('Dental Bee - Dental Clinic', 'Carefirst Dental clinic'));
assert(!namesAlign('Dental Bee - Dental Clinic', 'Infinity Dental Clinic'));
assert(!namesAlign('Dental Bee - Dental Clinic', 'Shangrila Dental Clinic'));
assert(!namesAlign('Dental Bee - Dental Clinic', 'Baishdhara Dental Clinic'));
assert(!namesAlign('Dental Bee - Dental Clinic', 'Smile 360 Dental Clinic'));
assert(!namesAlign('Dental Bee - Dental Clinic', 'Tarakeshwor Multi-Speciality Dental Clinic'));
assert(!namesAlign('Dental Bee - Dental Clinic', 'DentaLife Oral Concern - Dental Clinic'));
console.log('  ✓ Incident-specific false-matches strictly rejected from matching Dental Bee');

// 2b. Legitimate duplicate matches from incident & general
assert(namesAlign('Dental Bee - Dental Clinic', 'Dental Bee - Dental Clinic'));
assert(namesAlign('Big Smile Dental Clinic', 'Big Smile Dental Clinic & Prosthodontic Center Pvt. Ltd.'));
assert(namesAlign('Om Samaj Dental Hospital', 'Om Samaj Dental'));
assert(namesAlign('Himalayan Dental & Orthodontic Center', 'Himalayan Dental &amp; Orthodontic Center'));
assert(namesAlign('Dent Inn- the dental clinic', 'Dent Inn'));
console.log('  ✓ Legitimate duplicate candidate-evidence pairs align accurately');

// 2c. Restaurant category safety
assert.equal(namesAlign('Annapurna Restaurant & Bar', 'Everest Restaurant & Bar'), false);
assert.equal(namesAlign('Annapurna Restaurant & Bar', 'Annapurna Restaurant'), true);
console.log('  ✓ Restaurant category: Annapurna vs Everest rejected; Annapurna subset accepted');

// 2d. Legal category safety
assert.equal(namesAlign('Apex Law Associates', 'Himalayan Law Associates'), false);
assert.equal(namesAlign('Apex Law Associates', 'Apex Law Firm'), true);
console.log('  ✓ Legal category: Apex vs Himalayan rejected; Apex Law Firm accepted');

// 2e. School category safety
assert.equal(namesAlign('Bright Future Secondary School', 'Ever Vision Secondary School'), false);
assert.equal(namesAlign('Ever Vision Secondary School', 'Ever Vision School'), true);
console.log('  ✓ School category: Bright Future vs Ever Vision rejected; Ever Vision accepted');

// 2f. Pure generic names equality requirement
assert.equal(namesAlign('Dental Clinic', 'Dental Clinic'), true);
assert.equal(namesAlign('Dental Clinic', 'Dental Hospital'), false);
console.log('  ✓ Pure generic names require strict equality');


// ----------------------------------------------------------------------------
// Test 3: mergeDuplicateEntities Two-Gate Safety & Cluster Cap
// ----------------------------------------------------------------------------
console.log('\nTest 3: mergeDuplicateEntities Two-Gate Safety Architecture');

// 3a. False-merge rejection: Two different clinics falsely assigned dentalbee.com.np
const falseMergeListings: ConflictCheckListing[] = [
  {
    name: 'Dental Bee - Dental Clinic',
    websites: ['https://dentalbee.com.np/'],
    phones: ['+977-981-2755804'],
    mobiles: [],
    emails: ['info@dentalbee.com.np'],
    socialLinks: { facebook: 'https://facebook.com/dentalbeee' },
  },
  {
    name: 'Tarakeshwor Multi-Speciality Dental Clinic',
    websites: ['https://dentalbee.com.np/'], // Corruptly assigned domain
    phones: ['+977-01-4155122'], // Different phone
    mobiles: [],
    emails: [],
    socialLinks: {},
  },
];

const falseMergeResult = mergeDuplicateEntities(falseMergeListings);
assert.equal(falseMergeResult.mergedListings.length, 2, 'Must not merge different businesses sharing domain without name alignment');
console.log('  ✓ Refused to merge different businesses (Dental Bee vs Tarakeshwor) sharing domain');

// 3b. Phone match with conflicting official domains (Belt-and-Suspenders Guard)
const conflictingDomainPhoneListings: ConflictCheckListing[] = [
  {
    name: 'Om Shivaya Dental Care Pvt. Ltd.',
    websites: ['https://omshivayadental.com/'],
    phones: ['+977-984-1983155'],
    mobiles: [],
    emails: [],
    socialLinks: {},
  },
  {
    name: 'Advanced Dental Care',
    websites: ['https://dentist.com.np/'],
    phones: ['+977-984-1983155'],
    mobiles: [],
    emails: [],
    socialLinks: {},
  },
];
const conflictPhoneResult = mergeDuplicateEntities(conflictingDomainPhoneListings);
assert.equal(conflictPhoneResult.mergedListings.length, 2, 'Phone match with conflicting domains and non-aligning names must NOT merge');
console.log('  ✓ Phone match with conflicting domains strictly requires name Jaccard >= 0.6');

// 3c. Real duplicate with phone match & same domain / no domain conflict (Gate 1)
const phoneMergeListings: ConflictCheckListing[] = [
  {
    name: 'Om Samaj Dental Hospital',
    websites: ['https://omsamajdental.com/'],
    phones: ['+977-01-4580880'],
    mobiles: [],
    emails: ['info@omsamajdental.com'],
    socialLinks: {},
  },
  {
    name: 'Samaj Dental Clinic',
    websites: [],
    phones: ['+977-01-4580880'],
    mobiles: [],
    emails: [],
    socialLinks: {},
  },
];

const phoneMergeResult = mergeDuplicateEntities(phoneMergeListings);
assert.equal(phoneMergeResult.mergedListings.length, 1, 'Exact phone match must merge duplicate listings when no domain conflict');
console.log('  ✓ Merged real duplicate with exact phone match');

// 3d. Real duplicate with domain match AND distinctive name alignment (Gate 2a)
const domainNameMergeListings: ConflictCheckListing[] = [
  {
    name: 'Agrim Dental Home',
    websites: ['https://agrimdentalclinic.com/'],
    phones: ['+977-986-1234567'],
    mobiles: [],
    emails: [],
    socialLinks: {},
  },
  {
    name: 'Agrim Dental Home Dental Clinic Kathmandu',
    websites: ['https://agrimdentalclinic.com/'],
    phones: [],
    mobiles: [],
    emails: [],
    socialLinks: {},
  },
];

const domainNameMergeResult = mergeDuplicateEntities(domainNameMergeListings);
assert.equal(domainNameMergeResult.mergedListings.length, 1, 'Domain match with name alignment must merge');
console.log('  ✓ Merged real duplicate with domain and distinctive name alignment');

// 3e. Cluster size cap guard (Cap = 3): If cluster size > 3 (e.g. 4+), refuse auto-merge
const clusterOf4: ConflictCheckListing[] = Array.from({ length: 4 }, (_, i) => ({
  name: `Agrim Dental Clinic Branch ${i}`,
  websites: ['https://agrimdentalclinic.com/'],
  phones: ['+977-01-4111111'],
  mobiles: [],
  emails: [],
  socialLinks: {},
}));

const cluster4Result = mergeDuplicateEntities(clusterOf4);
assert.equal(cluster4Result.mergedListings.length, 4, 'Cluster of 4 listings must exceed cap 3 and refuse auto-merge');
assert.ok((cluster4Result.mergedListings[0].otherDetails as any)?.suspectedCluster, 'Cluster of 4 tagged with suspectedCluster');
console.log('  ✓ Cluster size cap (size > 3) safely rejected from auto-merge and tagged with suspectedCluster');

// 3f. Distinct domains cap guard (Cap = 2): If cluster contains >= 2 distinct domains, refuse auto-merge
const multiDomainCluster: ConflictCheckListing[] = [
  {
    name: 'Samaj Dental Clinic',
    websites: ['https://omsamajdental.com/'],
    phones: ['+977-01-4580880'],
    mobiles: [],
    emails: [],
    socialLinks: {},
  },
  {
    name: 'Samaj Dental Hospital',
    websites: ['https://samajdentalcareclinic.com/'],
    phones: ['+977-01-4580880'],
    mobiles: [],
    emails: [],
    socialLinks: {},
  },
];
const multiDomainResult = mergeDuplicateEntities(multiDomainCluster);
assert.equal(multiDomainResult.mergedListings.length, 2, 'Cluster with 2 distinct domains must be refused');
assert.ok((multiDomainResult.mergedListings[0].otherDetails as any)?.suspectedCluster, 'Distinct-domain cluster tagged with suspectedCluster');
console.log('  ✓ Distinct domains cap (>= 2 domains) safely rejected from auto-merge and tagged with suspectedCluster');

// 3g. Shared social URL with distinct non-aligning names MUST NOT auto-merge
const sharedSocialDifferentNames: ConflictCheckListing[] = [
  {
    name: 'Om Shivaya Dental Care',
    websites: [],
    phones: [],
    mobiles: [],
    emails: [],
    socialLinks: { facebook: 'https://facebook.com/shared-dental-social' },
  },
  {
    name: 'Advanced Dental Care',
    websites: [],
    phones: [],
    mobiles: [],
    emails: [],
    socialLinks: { facebook: 'https://facebook.com/shared-dental-social' },
  },
];
const sharedSocialResult = mergeDuplicateEntities(sharedSocialDifferentNames);
assert.equal(sharedSocialResult.mergedListings.length, 2, 'Two businesses sharing a social link with non-aligning names must NOT merge');
console.log('  ✓ Shared social link with non-aligning names safely prevented from merging');


// ----------------------------------------------------------------------------
// Test 4: Schema.org sameAs Wiring & Chirayu End-to-End Extraction
// ----------------------------------------------------------------------------
console.log('\nTest 4: Schema.org sameAs Wiring & Chirayu Extraction');

const rawChirayuHtml = `
<!DOCTYPE html>
<html>
<head>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Dentist",
    "name": "Chirayu DentCare",
    "email": "dentcarechirayu@gmail.com",
    "sameAs": [
      "https://www.facebook.com/profile.php?id=100083470925351&amp;mibextid=ZbWKwL"
    ]
  }
  </script>
</head>
<body>
  <h1>Welcome to Chirayu DentCare</h1>
</body>
</html>
`;

const chirayuPageEvidence = [
  {
    url: 'https://chirayudentcare.com/',
    content: 'Welcome to Chirayu DentCare',
    rawHtml: rawChirayuHtml,
    pageType: 'home' as const,
    favicon: '',
    discoverySource: 'homepage' as const,
    success: true,
  },
];

const extractedChirayu = extractAllFromPages(chirayuPageEvidence, 'Chirayu DentCare', 'chirayudentcare.com');
assert.equal(
  extractedChirayu.extractedSocialLinks.facebook,
  'https://facebook.com/profile.php?id=100083470925351',
  'extractAllFromPages must extract Chirayu facebook profile.php from Schema.org sameAs'
);
assert.ok(extractedChirayu.extractedSchemaSameAs && extractedChirayu.extractedSchemaSameAs.length > 0);
console.log('  ✓ extractAllFromPages extracted Chirayu Facebook profile.php from Schema.org sameAs');


// ----------------------------------------------------------------------------
// Test 5: Facebook Namespace Resolver (/people/, /pages/, /p/)
// ----------------------------------------------------------------------------
console.log('\nTest 5: Facebook Namespace Resolver & Token Alignment');

// 5a. /people/ namespace URL (Agrim Dental)
const agrimUrl = 'https://www.facebook.com/people/Agrim-Dental-Home-Dental-clinic-Kathmandu/61554171923866/';
const agrimHandle = extractFacebookHandle(['people', 'Agrim-Dental-Home-Dental-clinic-Kathmandu', '61554171923866']);
assert.equal(agrimHandle, 'Agrim-Dental-Home-Dental-clinic-Kathmandu');

const agrimClassified = classifySocialProfile(
  agrimUrl,
  'facebook',
  'Agrim Dental and Multispecialty Dental Clinic Kathmandu',
  'agrimdentalclinic.com'
);
assert.equal(agrimClassified.status, 'accepted');
assert.equal(agrimClassified.handle, 'Agrim-Dental-Home-Dental-clinic-Kathmandu');
console.log('  ✓ Agrim /people/ namespace URL accepted with clean slug handle');

// 5b. /p/ namespace URL with trailing ID suffix (Sunrise Dental)
const sunriseUrl = 'https://www.facebook.com/p/Sunrise-Dental-100593865882795';
const sunriseHandle = extractFacebookHandle(['p', 'Sunrise-Dental-100593865882795']);
assert.equal(sunriseHandle, 'Sunrise-Dental');

const sunriseClassified = classifySocialProfile(
  sunriseUrl,
  'facebook',
  'Sunrise Dental Clinic',
  'sunrisedental.com'
);
assert.equal(sunriseClassified.status, 'accepted');
assert.equal(sunriseClassified.handle, 'Sunrise-Dental');
console.log('  ✓ Sunrise /p/ namespace URL accepted with numeric suffix stripped');

// 5c. /pages/ namespace URL without token match (Unrelated Company)
const unrelatedUrl = 'https://www.facebook.com/pages/Unrelated-Company/12345';
const unrelatedClassified = classifySocialProfile(
  unrelatedUrl,
  'facebook',
  'Agrim Dental and Multispecialty Dental Clinic Kathmandu',
  'agrimdentalclinic.com'
);
assert.equal(unrelatedClassified.status, 'rejected');
assert.equal(unrelatedClassified.rejectionReason, 'BUSINESS_NAME_MISMATCH');
console.log('  ✓ Unrelated /pages/ namespace URL strictly rejected on business name mismatch');


// ----------------------------------------------------------------------------
// Test 6: Google Maps bookingLinks Ingestion & completeSocials Service
// ----------------------------------------------------------------------------
console.log('\nTest 6: Google Maps bookingLinks Ingestion & completeSocials');

// 6a. Big Smile Dental bookingLinks with Facebook page
const bigSmileInput = {
  name: 'Big Smile Dental Clinic & Prosthodontic Center Pvt. Ltd.',
  websiteDomain: 'bigsmiledentalclinicnepal.com',
  existingSocials: { facebook: '', instagram: '', tiktok: '', other: {} },
  bookingLinks: [
    'https://www.facebook.com/Big-Smile-Dental-Clinic-Prosthodontic-Center-Pvt-Ltd-100593865882795/',
  ],
  websiteRelationship: 'first_party',
};
const bigSmileCompleted = completeSocials(bigSmileInput);
assert.equal(
  bigSmileCompleted.socialLinks.facebook,
  'https://facebook.com/Big-Smile-Dental-Clinic-Prosthodontic-Center-Pvt-Ltd-100593865882795',
  'Must ingest verified Facebook page from Maps bookingLinks'
);
assert.equal(
  bigSmileCompleted.classifiedProfiles.find((p) => p.platform === 'facebook')?.origin,
  'maps_booking_link'
);
console.log('  ✓ Big Smile Facebook page ingested from Maps bookingLinks with origin: maps_booking_link');

// 6b. Studio Dentale bookingLinks pointing to internal /contact/ page (Ignored)
const studioDentaleInput = {
  name: 'Studio Dentale',
  websiteDomain: 'studiodentale.org',
  existingSocials: { facebook: 'https://facebook.com/studiodentalenp', instagram: '', tiktok: '', other: {} },
  bookingLinks: ['https://studiodentale.org/contact/'],
  websiteRelationship: 'first_party',
};
const studioDentaleCompleted = completeSocials(studioDentaleInput);
assert.equal(
  studioDentaleCompleted.socialLinks.facebook,
  'https://facebook.com/studiodentalenp',
  'Must preserve existing verified Facebook'
);
assert.equal(studioDentaleCompleted.completedCount, 0, 'Must ignore non-social internal booking pages');
console.log('  ✓ Non-social internal booking pages safely ignored by SOCIAL_DOMAINS gate');

// 6c. Third-party aggregator booking link (e.g. WhatClinic) (Ignored)
const aggregatorInput = {
  name: 'Sample Dental Care',
  websiteDomain: 'sampledental.com',
  existingSocials: { facebook: '', instagram: '', tiktok: '', other: {} },
  bookingLinks: ['https://whatclinic.com/dentists/nepal/sample-dental'],
  websiteRelationship: 'first_party',
};
const aggregatorCompleted = completeSocials(aggregatorInput);
assert.equal(aggregatorCompleted.socialLinks.facebook, '');
assert.equal(aggregatorCompleted.completedCount, 0, 'Aggregator booking link must be ignored');
console.log('  ✓ Third-party aggregator booking links (WhatClinic) safely excluded');

// 6d. Phase 0 discoveredSocials Promotion & Validation Gate
console.log('\nTest 7: Phase 0 discoveredSocials Promotion & Validation Gate');

// 7a. Zenith Dental (No website, discovered Facebook via Phase 0)
const zenithInput = {
  name: 'Zenith Dental Clinic',
  discoveredSocials: {
    facebook: 'https://facebook.com/ZenithDentalClinicDillibazar',
  },
};
const zenithCompleted = completeSocials(zenithInput);
assert.equal(
  zenithCompleted.socialLinks.facebook,
  'https://facebook.com/ZenithDentalClinicDillibazar',
  'Zenith Facebook must be promoted from Phase 0 discoveredSocials'
);
assert.equal(
  zenithCompleted.classifiedProfiles.find((p) => p.platform === 'facebook')?.origin,
  'phase0_discovery'
);
console.log('  ✓ Zenith Dental Facebook promoted from Phase 0 with origin: phase0_discovery');

// 7b. United Dental Care (Branch descriptor + locality in name, handle: @united_dentalcare_)
const unitedInput = {
  name: 'United Dental Care Pvt. Ltd. (Nayabazar Branch)',
  discoveredSocials: {
    instagram: 'https://instagram.com/united_dentalcare_?hl=en',
  },
};
const unitedCompleted = completeSocials(unitedInput);
assert.equal(
  unitedCompleted.socialLinks.instagram,
  'https://instagram.com/united_dentalcare_',
  'United Dental Care Instagram must be promoted with clean canonical URL'
);
console.log('  ✓ United Dental Care Instagram accepted and promoted from Phase 0');

// 7c. Beyond Smile Dental Clinic (handle: @beyondsmilektm)
const beyondSmileClassified = classifySocialProfile(
  'https://facebook.com/beyondsmilektm',
  'facebook',
  'Beyond Smile Dental Clinic',
  'beyondsmiledental.com'
);
assert.equal(beyondSmileClassified.status, 'accepted');
console.log('  ✓ Beyond Smile Facebook (@beyondsmilektm) accepted via qualitative brand rule');

// 7d. Big Smile Dental Clinic Instagram (handle: @bigsmile_dentalclinic)
const bigSmileIgClassified = classifySocialProfile(
  'https://www.instagram.com/bigsmile_dentalclinic/',
  'instagram',
  'Big Smile Dental Clinic & Prosthodontic Center Pvt. Ltd.',
  'bigsmiledentalclinicnepal.com'
);
assert.equal(bigSmileIgClassified.status, 'accepted');
console.log('  ✓ Big Smile Instagram (@bigsmile_dentalclinic) accepted via qualitative brand rule');

// 7e. Golden Dental Care (Numeric profile without slug or distinctive token) -> Rejected
const goldenInput = {
  name: 'Golden Dental Care',
  discoveredSocials: {
    facebook: 'https://facebook.com/100091738652602',
  },
};
const goldenCompleted = completeSocials(goldenInput);
assert.equal(
  goldenCompleted.socialLinks.facebook,
  '',
  'Numeric Facebook profile without brand match must not be promoted'
);
console.log('  ✓ Numeric Facebook profile without distinctive match correctly rejected');


console.log('\n=== ALL MULTI-CATEGORY REGRESSION & QUALITY TESTS PASSED ===');
