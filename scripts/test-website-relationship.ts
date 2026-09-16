import assert from 'node:assert/strict';
import {
  classifyWebsiteRelationship,
} from '../src/services/website-relationship.service';
import {
  sanitizeListingWithEvidence,
  matchListingToEvidence,
} from '../src/mastra/workflows/research-workflow';
import type { VerifiedBusinessEvidence } from '../src/mastra/agents/research-agent/verification.schema';

console.log('=== Running Website Relationship & Validator Tests ===\n');

// ----------------------------------------------------------------------------
// 1. Classification Service Unit Tests
// ----------------------------------------------------------------------------

console.log('--- Test 1: FIRST_PARTY (domain contains business name token) ---');
const r1 = classifyWebsiteRelationship('http://lawimperial.com/', 'Imperial Law Associates');
assert.equal(r1.relationship, 'first_party');
assert.equal(r1.isContactEnrichable, true);
assert.equal(r1.signals.domainNameTokenMatch, true);
assert.equal(r1.signals.hardBlockMatch, false);
console.log('✔ Imperial Law → lawimperial.com correctly classified as first_party');

console.log('--- Test 2: FIRST_PARTY (exact brand domain) ---');
const r2 = classifyWebsiteRelationship('https://himalayanjava.com', 'Himalayan Java Coffee');
assert.equal(r2.relationship, 'first_party');
assert.equal(r2.isContactEnrichable, true);
console.log('✔ Himalayan Java → himalayanjava.com correctly classified as first_party');

console.log('--- Test 3: UNVERIFIED (different business name, no token match) ---');
const r3 = classifyWebsiteRelationship('http://lawimperial.com/', 'Lawneeti Associates');
assert.equal(r3.relationship, 'unverified');
assert.equal(r3.isContactEnrichable, false);
console.log('✔ Lawneeti + lawimperial.com correctly classified as unverified');

console.log('--- Test 4: DIRECTORY hard-block (searchactual.com) ---');
const r4 = classifyWebsiteRelationship('https://searchactual.com', 'Madhuram Thapa');
assert.equal(r4.relationship, 'directory');
assert.equal(r4.isContactEnrichable, false);
assert.equal(r4.signals.hardBlockMatch, true);
console.log('✔ searchactual.com correctly hard-blocked as directory');

console.log('--- Test 5: DIRECTORY hard-block beats domain token match (CRITICAL) ---');
// Domain contains token "abc" and "plumbing", but host is on a hard-blocked platform
const r5 = classifyWebsiteRelationship('https://abcplumbing.searchactual.com', 'ABC Plumbing Services');
assert.equal(r5.relationship, 'directory');
assert.equal(r5.isContactEnrichable, false);
assert.equal(r5.signals.hardBlockMatch, true);
console.log('✔ Hard-block successfully overrides domain token match for abcplumbing.searchactual.com');

console.log('--- Test 6: UNVERIFIED (empty or invalid URL) ---');
const r6 = classifyWebsiteRelationship('', 'Some Business');
assert.equal(r6.relationship, 'unverified');
assert.equal(r6.isContactEnrichable, false);
console.log('✔ Empty URL correctly classified as unverified');

console.log('--- Test 7: UNVERIFIED (unrelated domain) ---');
const r7 = classifyWebsiteRelationship('https://pranikacleaningservice.com.np', 'Clean O Clock');
assert.equal(r7.relationship, 'unverified');
assert.equal(r7.isContactEnrichable, false);
console.log('✔ Unrelated domain correctly classified as unverified');

// ----------------------------------------------------------------------------
// 2. Downstream Sanitizer & Differential Contamination Tests
// ----------------------------------------------------------------------------

const mockImperialEvidence: VerifiedBusinessEvidence = {
  candidate: {
    name: 'Imperial Law Associates',
    location: 'Kathmandu, Nepal',
    website: 'http://lawimperial.com/',
    phone: '+977 980-3888924',
    sources: {
      googleMaps: { found: true, address: 'Kathmandu, Nepal' },
      webSearch: [],
    },
    entityMatch: { matched: true, confidence: 1, method: 'name_address' },
  },
  websiteEvidence: {
    url: 'http://lawimperial.com/',
    domain: 'lawimperial.com',
    extractedEmails: ['info@lawimperial.com', 'contact@lawimperial.com'],
    extractedPhones: ['+977-1-4240520'],
    extractedMobiles: ['+977-9803888924', '+977-9851362823'],
    extractedSocialLinks: {
      facebook: 'https://facebook.com/lawimperial',
      tiktok: '',
      instagram: '',
      other: {},
    },
    extractedServices: [],
    favicon: 'http://lawimperial.com/favicon.ico',
    pages: [],
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
    notes: [],
  },
  websiteRelationship: 'first_party',
  websiteLifecycle: 'first_party_owned',
};

console.log('\n--- Test 8: Contamination Regression Test (Lawneeti + Imperial Evidence) ---');
const contaminatedLawneetiListing = {
  name: 'Lawneeti Associates',
  location: 'Kathmandu, Nepal',
  emails: [],
  phones: [],
  mobiles: [],
  websites: ['http://lawimperial.com/'], // Hallucinated/contaminated listing website
  icon: '',
  socialLinks: { facebook: '', tiktok: '', instagram: '', other: {} },
  otherDetails: { address: 'Anamnagar, Kathmandu', rating: 4.5, ratingCount: 12 },
  process: 'Synthesized via LLM',
  metadata: { source: 'google_maps', extractedAt: new Date().toISOString(), confidence: 0.9 },
  links: [],
};

const sanitizedLawneeti = sanitizeListingWithEvidence(
  contaminatedLawneetiListing,
  mockImperialEvidence
);

// INVARIANT CHECK: Non-matching candidate identity MUST NOT receive website evidence contacts
assert.equal(
  sanitizedLawneeti.emails.includes('info@lawimperial.com'),
  false,
  'Lawneeti listing MUST NOT be contaminated with Imperial Law email'
);
assert.equal(
  sanitizedLawneeti.mobiles.includes('+977-9803888924'),
  false,
  'Lawneeti listing MUST NOT be contaminated with Imperial Law mobile'
);
assert.equal(
  sanitizedLawneeti.socialLinks.facebook,
  '',
  'Lawneeti listing MUST NOT inherit Imperial Law social links'
);
assert.equal(
  sanitizedLawneeti.otherDetails.websiteRelationship,
  'first_party',
  'Audit metadata websiteRelationship must be attached'
);
console.log('✔ Lawneeti contamination blocked successfully! Maps identity preserved cleanly.');

console.log('--- Test 9: Positive Enrichment Test (Imperial Law + Imperial Evidence) ---');
const validImperialListing = {
  name: 'Imperial Law Associates',
  location: 'Kathmandu, Nepal',
  emails: [],
  phones: [],
  mobiles: [],
  websites: ['http://lawimperial.com/'],
  icon: '',
  socialLinks: { facebook: '', tiktok: '', instagram: '', other: {} },
  otherDetails: { address: 'Kathmandu, Nepal', rating: 4.8, ratingCount: 25 },
  process: 'Synthesized via LLM',
  metadata: { source: 'google_maps', extractedAt: new Date().toISOString(), confidence: 0.9 },
  links: [],
};

const sanitizedImperial = sanitizeListingWithEvidence(validImperialListing, mockImperialEvidence);

assert.equal(
  sanitizedImperial.emails.includes('info@lawimperial.com'),
  true,
  'Imperial Law listing SHOULD be enriched with its own official email'
);
assert.equal(
  sanitizedImperial.mobiles.some((m) => m.includes('9851362823') || m === '+977-985-1362823'),
  true,
  'Imperial Law listing SHOULD be enriched with its second official mobile'
);
assert.equal(
  sanitizedImperial.mobiles.length,
  2,
  'Imperial Law listing SHOULD have both mobiles enriched'
);
assert.equal(
  sanitizedImperial.socialLinks.facebook,
  'https://facebook.com/lawimperial',
  'Imperial Law listing SHOULD inherit its own official Facebook'
);
console.log('✔ Imperial Law positive enrichment verified successfully!');

console.log('--- Test 10: Invariant Test (non-first_party / directory website blocked) ---');
const directoryEvidence: VerifiedBusinessEvidence = {
  ...mockImperialEvidence,
  websiteRelationship: 'directory',
};

const sanitizedDirectoryListing = sanitizeListingWithEvidence(
  validImperialListing,
  directoryEvidence
);

assert.equal(
  sanitizedDirectoryListing.emails.includes('info@lawimperial.com'),
  false,
  'Directory relationship evidence MUST NOT enrich emails'
);
assert.equal(
  sanitizedDirectoryListing.mobiles.includes('+977-9851362823'),
  false,
  'Directory relationship evidence MUST NOT enrich website mobiles'
);
assert.equal(
  sanitizedDirectoryListing.mobiles.length,
  1,
  'Only candidate Maps phone present; directory website mobile blocked'
);
console.log('✔ Non-first_party/directory relationship contact enrichment invariant held!');

// ----------------------------------------------------------------------------
// 3. Evidence Matching Hierarchy Tests
// ----------------------------------------------------------------------------

console.log('--- Test 11: matchListingToEvidence candidate phone precedence ---');
const matchedByPhone = matchListingToEvidence(
  {
    name: 'Some Random LLM Title',
    phones: ['+977 980-3888924'],
    mobiles: [],
    websites: ['http://unrelated-domain.com'],
  } as any,
  [mockImperialEvidence]
);

assert.ok(matchedByPhone, 'Phone match must find Imperial evidence');
assert.equal(matchedByPhone.candidate.name, 'Imperial Law Associates');
console.log('✔ Candidate phone match precedence verified!');

console.log('\n✅ ALL WEBSITE RELATIONSHIP & VALIDATOR TESTS PASSED SUCCESSFULLY!\n');
