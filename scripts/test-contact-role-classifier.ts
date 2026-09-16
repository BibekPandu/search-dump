import assert from 'node:assert/strict';
import {
  classifyEmailRole,
  classifyPhoneRole,
  classifyNepalPhone,
  extractAllFromPages,
} from '../src/services/business-extractor.service';
import { computeConfidenceBreakdown } from '../src/services/confidence.service';
import {
  sanitizeListingWithEvidence,
  type BusinessListing,
} from '../src/mastra/workflows/research-workflow';
import type { VerifiedBusinessEvidence } from '../src/mastra/agents/research-agent/verification.schema';

console.log('================================================================');
console.log('🧪 TASK 3: CONTACT ROLE CLASSIFIER & PROJECTION TESTS (11 CASES)');
console.log('================================================================\n');

let passedTests = 0;
let totalTests = 0;

function assertTest(name: string, fn: () => void) {
  totalTests++;
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ FAIL: ${name}`);
    console.error(err);
    throw err;
  }
}

function makeMockCandidate(overrides: Record<string, any>): any {
  return {
    name: 'Test Business',
    location: 'Kathmandu, Nepal',
    website: 'https://example.com',
    phone: '01-4444356',
    rating: 4.5,
    ratingCount: 100,
    category: 'Business',
    sources: { googleMaps: { found: true }, webSearch: [] },
    entityMatch: { matched: true, confidence: 1, method: 'name' },
    ...overrides,
  };
}

function makeMockPages(pages: Array<{ url: string; content: string; success?: boolean }>): any[] {
  return pages.map((p) => ({
    url: p.url,
    content: p.content,
    rawHtml: '',
    favicon: '',
    success: p.success ?? true,
    discoverySource: 'homepage' as const,
    pageType: 'contact' as const,
  }));
}

function makeMockEvidence(candidate: any, extracted: any, relationship = 'first_party'): VerifiedBusinessEvidence {
  return {
    candidate,
    websiteEvidence: {
      url: candidate.website || candidate.url || '',
      domain: 'example.com',
      pages: [],
      ...extracted,
    },
    verification: {
      status: 'verified',
      overallConfidence: 0.9,
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
    websiteRelationship: relationship as any,
    websiteLifecycle: 'first_party_owned',
  };
}

function makeMockListing(candidate: any): BusinessListing {
  return {
    name: candidate.name,
    location: candidate.location || 'Kathmandu, Nepal',
    emails: [],
    phones: [],
    mobiles: [],
    websites: candidate.website ? [candidate.website] : [],
    icon: '',
    socialLinks: { facebook: '', tiktok: '', instagram: '', other: {} },
    otherDetails: {},
    metadata: { source: 'web', extractedAt: new Date().toISOString(), confidence: 0 },
    process: 'test',
    links: [],
  };
}

// ---------------------------------------------------------------------------
// T1: Om Samaj multi-branch fixture (5 branch landlines to otherDetails.branches)
// ---------------------------------------------------------------------------
assertTest('T1: Om Samaj multi-branch fixture routes branch landlines to otherDetails.branches and preserves primary', () => {
  const candidate = makeMockCandidate({
    name: 'Om Samaj Dental Hospital',
    phone: '01-4444356', // Primary Kathmandu hospital number
    website: 'https://omsamajdental.com',
    url: 'https://omsamajdental.com',
  });

  const pages = makeMockPages([
    {
      url: 'https://omsamajdental.com/contact-us',
      content: `
        # Contact Om Samaj Dental Hospital
        Main Central Office: Kathmandu (Phone: 01-4444356)
        Email: info@omsamajdental.com

        ## Our Branches Across Nepal
        - Chabahil Branch: Clinic Phone 01-4470123
        - Banasthali Branch: Office Phone 01-4380456
        - Pokhara Branch: New Road Clinic 061-520123
        - Biratnagar Branch: Main Road Outlet 021-530456
        - Butwal Branch: Traffic Chowk Clinic 071-540789
      `,
      success: true,
    },
  ]);

  const extracted = extractAllFromPages(pages, candidate.name, candidate.website);
  assert.ok(extracted.extractedClassifiedContacts, 'extractedClassifiedContacts should be populated');

  // Verify branch contacts are classified
  const branchContacts = extracted.extractedClassifiedContacts.filter(
    (c) => c.role === 'branch_contact'
  );
  assert.ok(branchContacts.length >= 5, `Expected >= 5 branch contacts, got ${branchContacts.length}`);

  const evidence = makeMockEvidence(candidate, extracted, 'first_party');
  const initialListing = makeMockListing(candidate);
  const projected = sanitizeListingWithEvidence(initialListing, evidence);

  // Top-level phones should NOT contain the 5 branch landlines
  assert.ok(
    !projected.phones.includes('01-4470123') &&
    !projected.phones.includes('01-4380456') &&
    !projected.phones.includes('061-520123') &&
    !projected.phones.includes('021-530456') &&
    !projected.phones.includes('071-540789'),
    'Branch landlines must not be flattened into top-level phones[]'
  );

  // Top-level phones should contain the main central hospital landline
  assert.ok(
    projected.phones.some((p) => p.includes('4444356')),
    'Main hospital phone must remain in top-level phones[]'
  );

  // otherDetails.branches must contain the branch records
  assert.ok(projected.otherDetails?.branches, 'otherDetails.branches must exist');
  assert.ok(
    (projected.otherDetails.branches?.length || 0) >= 4,
    `Expected >= 4 branches in otherDetails.branches, got ${projected.otherDetails?.branches?.length}`
  );
});

// ---------------------------------------------------------------------------
// T2: Good Deal Mart fixture (staff email classified staff_person, excluded from top-level)
// ---------------------------------------------------------------------------
assertTest('T2: Good Deal Mart personal staff email is classified as staff_person and excluded from emails[]', () => {
  const bizEmailRes = classifyEmailRole('contact@gooddeal.com.np', 'Contact our sales office', 'Good Deal Mart', 'gooddeal.com.np');
  assert.equal(bizEmailRes.role, 'primary_business');
  assert.equal(bizEmailRes.owner, 'business');

  const staffEmailRes = classifyEmailRole('mukti.gooddeal@gmail.com', 'Store Manager Mukti Shrestha', 'Good Deal Mart', 'gooddeal.com.np');
  assert.equal(staffEmailRes.role, 'staff_person');
  assert.equal(staffEmailRes.owner, 'person');

  const candidate = makeMockCandidate({
    name: 'Good Deal Mart',
    website: 'https://gooddeal.com.np',
    phone: '9851012345',
  });

  const pages = makeMockPages([
    {
      url: 'https://gooddeal.com.np/about',
      content: `
        Good Deal Mart
        Contact our store: contact@gooddeal.com.np
        Branch Manager: Mukti Shrestha (mukti.gooddeal@gmail.com)
      `,
      success: true,
    },
  ]);

  const extracted = extractAllFromPages(pages, candidate.name, candidate.website);
  const evidence = makeMockEvidence(candidate, extracted, 'first_party');
  const initialListing = makeMockListing(candidate);
  const projected = sanitizeListingWithEvidence(initialListing, evidence);

  // contact@gooddeal.com.np promoted to emails[]
  assert.ok(projected.emails.includes('contact@gooddeal.com.np'), 'Official business email must be promoted');
  // mukti.gooddeal@gmail.com excluded from emails[]
  assert.ok(!projected.emails.includes('mukti.gooddeal@gmail.com'), 'Staff personal email must NOT be promoted to top-level emails[]');

  // Stored in otherDetails.classifiedContacts for audit
  const contacts = projected.otherDetails?.classifiedContacts || [];
  const staffContact = contacts.find((c) => c.value === 'mukti.gooddeal@gmail.com');
  assert.ok(staffContact, 'Staff email must be preserved in classifiedContacts audit log');
  assert.equal(staffContact?.role, 'staff_person');
  assert.equal(staffContact?.owner, 'person');
});

// ---------------------------------------------------------------------------
// T3: NoshNepal / Forest & Plate aggregator platform email
// ---------------------------------------------------------------------------
assertTest('T3: Platform aggregator email is classified owner: platform, role: unknown and excluded from emails[]', () => {
  const platformRes = classifyEmailRole('info@noshnepal.com', 'Online ordering powered by NoshNepal', 'Forest & Plate', 'forestandplate.com');
  assert.equal(platformRes.owner, 'platform');
  assert.equal(platformRes.role, 'unknown');

  const darazRes = classifyEmailRole('support@daraz.com.np', 'Delivery partner Daraz', 'Forest & Plate', 'forestandplate.com');
  assert.equal(darazRes.owner, 'platform');
  assert.equal(darazRes.role, 'unknown');

  const foodmanduRes = classifyEmailRole('order@foodmandu.com', 'Order on Foodmandu', 'Forest & Plate', 'forestandplate.com');
  assert.equal(foodmanduRes.owner, 'platform');
  assert.equal(foodmanduRes.role, 'unknown');

  const candidate = makeMockCandidate({
    name: 'Forest & Plate',
    website: 'https://forestandplate.com',
    phone: '01-4412345',
  });

  const pages = makeMockPages([
    {
      url: 'https://forestandplate.com',
      content: `
        Forest & Plate Restaurant
        Order via platform: info@noshnepal.com
        Contact restaurant directly: info@forestandplate.com
      `,
      success: true,
    },
  ]);

  const extracted = extractAllFromPages(pages, candidate.name, candidate.website);
  const evidence = makeMockEvidence(candidate, extracted, 'first_party');
  const initialListing = makeMockListing(candidate);
  const projected = sanitizeListingWithEvidence(initialListing, evidence);

  assert.ok(projected.emails.includes('info@forestandplate.com'), 'Direct restaurant email should be present');
  assert.ok(!projected.emails.includes('info@noshnepal.com'), 'Platform email info@noshnepal.com must be excluded');
});

// ---------------------------------------------------------------------------
// T4: Nebuti confidence fixture (phones: [], mobiles: [] -> phoneVerified: false)
// ---------------------------------------------------------------------------
assertTest('T4: Nebuti confidence check gates phoneVerified to false when final listing phones and mobiles are empty', () => {
  // Scenario: Maps candidate had a phone that matched Google Maps lookup check,
  // but due to lack of evidence / invalid phone, the final listing has 0 phones and 0 mobiles.
  const breakdownWithEmptyPhones = computeConfidenceBreakdown({
    isMapsCandidate: true,
    hasWebsiteEvidence: true,
    verificationConfidence: 0.9,
    websiteRelationship: 'first_party',
    verificationChecks: {
      phoneMatchesMaps: true, // verification check passed on raw candidate input
      emailFoundOnWebsite: true,
      addressOrLocationFoundOnWebsite: true,
    },
    // Authoritative final listing projection:
    finalEmails: ['info@nebuti.com'],
    finalWebsites: ['https://nebuti.com'],
    finalPhones: [], // Empty!
    finalMobiles: [], // Empty!
  });

  // INVARIANT: phoneVerified MUST be false because final listing has 0 phones/mobiles
  assert.equal(
    breakdownWithEmptyPhones.evidenceSummary.phoneVerified,
    false,
    'phoneVerified must be false when finalPhones and finalMobiles are empty'
  );

  // If final listing HAS a phone, phoneVerified can be true
  const breakdownWithPhones = computeConfidenceBreakdown({
    isMapsCandidate: true,
    hasWebsiteEvidence: true,
    verificationConfidence: 0.9,
    websiteRelationship: 'first_party',
    verificationChecks: {
      phoneMatchesMaps: true,
      emailFoundOnWebsite: true,
      addressOrLocationFoundOnWebsite: true,
    },
    finalEmails: ['info@nebuti.com'],
    finalWebsites: ['https://nebuti.com'],
    finalPhones: ['01-4412345'],
    finalMobiles: [],
  });

  assert.equal(
    breakdownWithPhones.evidenceSummary.phoneVerified,
    true,
    'phoneVerified must be true when phone matches and is present in final listing'
  );
});

// ---------------------------------------------------------------------------
// T5: Branch + WhatsApp fixture (orthogonal role and channels)
// ---------------------------------------------------------------------------
assertTest('T5: Branch + WhatsApp preserves branch ownership and assigns whatsapp channel', () => {
  const classified = classifyNepalPhone('9801234567');
  const res = classifyPhoneRole(
    '9801234567',
    'Pokhara Branch WhatsApp: 9801234567',
    'Apex Logistics',
    classified
  );

  assert.equal(res.role, 'branch_contact', 'Must be classified as branch_contact');
  assert.equal(res.owner, 'branch', 'Must be owned by branch');
  assert.ok(res.channels.includes('whatsapp'), 'Must include whatsapp channel');
  assert.ok(res.channels.includes('call'), 'Must include call channel');
});

// ---------------------------------------------------------------------------
// T6: Main business WhatsApp fixture
// ---------------------------------------------------------------------------
assertTest('T6: Main business WhatsApp is primary_business with whatsapp channel', () => {
  const classified = classifyNepalPhone('9851234567');
  const res = classifyPhoneRole(
    '9851234567',
    'Chat with us on WhatsApp: 9851234567',
    'Everest Outfitters',
    classified
  );

  assert.equal(res.role, 'primary_business');
  assert.equal(res.owner, 'business');
  assert.ok(res.channels.includes('whatsapp'));
});

// ---------------------------------------------------------------------------
// T7: Viber channel detection fixture
// ---------------------------------------------------------------------------
assertTest('T7: Viber channel detection captures call and viber channels', () => {
  const classified = classifyNepalPhone('9801234567');
  const res = classifyPhoneRole(
    '9801234567',
    'Call or Viber us at 9801234567 for orders',
    'Himalayan Spices',
    classified
  );

  assert.ok(res.channels.includes('viber'), 'Must include viber channel');
  assert.ok(res.channels.includes('call'), 'Must include call channel');
});

// ---------------------------------------------------------------------------
// T8: Careers / Support email fixture
// ---------------------------------------------------------------------------
assertTest('T8: careers@ and support@ are primary_business with business ownership', () => {
  const careers = classifyEmailRole('careers@techcompany.com.np', 'Join our team', 'Tech Company', 'techcompany.com.np');
  assert.equal(careers.role, 'primary_business');
  assert.equal(careers.owner, 'business');

  const support = classifyEmailRole('support@techcompany.com.np', 'Helpdesk support', 'Tech Company', 'techcompany.com.np');
  assert.equal(support.role, 'primary_business');
  assert.equal(support.owner, 'business');
});

// ---------------------------------------------------------------------------
// T9: Bare city name fixture ("24/7 delivery in Pokhara" is NOT branch)
// ---------------------------------------------------------------------------
assertTest('T9: Bare city name in delivery sentence does not trigger branch contact', () => {
  const classified = classifyNepalPhone('9851098765');
  const res = classifyPhoneRole(
    '9851098765',
    'We provide 24/7 delivery in Pokhara. Call 9851098765 now',
    'Quick Delivery Service',
    classified
  );

  assert.equal(res.role, 'primary_business', 'Bare city name in delivery statement must not trigger branch_contact');
  assert.equal(res.owner, 'business');
});

// ---------------------------------------------------------------------------
// T10: Ambiguous email fixture ("customtag@company.com" -> unknown, NOT promoted to emails[])
// ---------------------------------------------------------------------------
assertTest('T10: Ambiguous unlisted prefix falls back to unknown and is not promoted to emails[]', () => {
  const res = classifyEmailRole('newsletter@somecompany.com', 'Subscribe to our newsletter', 'Some Company', 'somecompany.com');
  assert.equal(res.role, 'unknown');
  assert.equal(res.owner, 'unknown');

  const candidate = makeMockCandidate({
    name: 'Some Company',
    website: 'https://somecompany.com',
    phone: '01-4412345',
  });

  const pages = makeMockPages([
    {
      url: 'https://somecompany.com',
      content: 'Subscribe to newsletter: newsletter@somecompany.com',
      success: true,
    },
  ]);

  const extracted = extractAllFromPages(pages, candidate.name, candidate.website);
  const evidence = makeMockEvidence(candidate, extracted, 'first_party');
  const initialListing = makeMockListing(candidate);
  const projected = sanitizeListingWithEvidence(initialListing, evidence);

  assert.ok(
    !projected.emails.includes('newsletter@somecompany.com'),
    'Unknown email must not be promoted to top-level emails[]'
  );
});

// ---------------------------------------------------------------------------
// T11: Consumer domain personal pattern fixture (kzeeyash58@gmail.com -> staff_person)
// ---------------------------------------------------------------------------
assertTest('T11: Consumer domain personal pattern (kzeeyash58@gmail.com) classified as staff_person and excluded from emails[]', () => {
  const personalRes = classifyEmailRole('kzeeyash58@gmail.com', 'Our lead representative', 'Sunrise Trekking', 'sunrisetrekking.com');
  assert.equal(personalRes.role, 'staff_person', 'Consumer email with digits/dots pattern must be staff_person');
  assert.equal(personalRes.owner, 'person', 'Consumer personal email must be owned by person');

  const candidate = makeMockCandidate({
    name: 'Sunrise Trekking',
    website: 'https://sunrisetrekking.com',
    phone: '01-4498765',
  });

  const pages = makeMockPages([
    {
      url: 'https://sunrisetrekking.com/contact',
      content: `
        Sunrise Trekking Pvt Ltd
        Official Email: info@sunrisetrekking.com
        Guide Contact: kzeeyash58@gmail.com
      `,
      success: true,
    },
  ]);

  const extracted = extractAllFromPages(pages, candidate.name, candidate.website);
  const evidence = makeMockEvidence(candidate, extracted, 'first_party');
  const initialListing = makeMockListing(candidate);
  const projected = sanitizeListingWithEvidence(initialListing, evidence);

  // info@sunrisetrekking.com promoted to emails[]
  assert.ok(projected.emails.includes('info@sunrisetrekking.com'), 'Official company email must be promoted');
  // kzeeyash58@gmail.com excluded from emails[]
  assert.ok(
    !projected.emails.includes('kzeeyash58@gmail.com'),
    'Personal Gmail with digits pattern must NOT be promoted to top-level emails[]'
  );

  // Preserved in otherDetails.classifiedContacts for audit
  const contacts = projected.otherDetails?.classifiedContacts || [];
  const personalContact = contacts.find((c) => c.value === 'kzeeyash58@gmail.com');
  assert.ok(personalContact, 'Personal email must be preserved in classifiedContacts audit log');
  assert.equal(personalContact?.role, 'staff_person');
  assert.equal(personalContact?.owner, 'person');
});

console.log('\n================================================================');
console.log(`TOTAL TASK 3 TESTS: ${totalTests} | PASSED: ${passedTests} | FAILED: ${totalTests - passedTests}`);
console.log('================================================================');
