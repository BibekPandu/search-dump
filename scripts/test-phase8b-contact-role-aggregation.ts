import assert from 'node:assert';
import {
  classifyPageType,
  evaluateContactRoleMatrix,
  extractAllFromPages,
  deduplicateClassifiedContacts,
} from '@/services/business-extractor.service';
import {
  sanitizeListingWithEvidence,
  type BusinessListing,
} from '@/mastra/workflows/research-workflow.js';
import type { VerifiedBusinessEvidence } from '@/mastra/agents/research-agent/verification.schema.js';

async function runPhase8bTests() {
  console.log('=== Running Phase 8b Contact Role Evidence Aggregation Tests ===\n');

  // =========================================================================
  // Task 8b.1: Page-Type Classifier Tests
  // =========================================================================
  console.log('--- 1. Task 8b.1: Page-Type Classifier (classifyPageType) ---');
  assert.strictEqual(classifyPageType('https://royalcleaning.com.np'), 'homepage');
  assert.strictEqual(classifyPageType('https://royalcleaning.com.np/'), 'homepage');
  assert.strictEqual(classifyPageType('https://royalcleaning.com.np/index.html'), 'homepage');
  assert.strictEqual(classifyPageType('https://royalcleaning.com.np/contact'), 'contact');
  assert.strictEqual(classifyPageType('https://royalcleaning.com.np/contact-us/'), 'contact');
  assert.strictEqual(classifyPageType('https://royalcleaning.com.np/get-a-quote'), 'contact');
  assert.strictEqual(classifyPageType('https://royalcleaning.com.np/about-us'), 'about');
  assert.strictEqual(classifyPageType('https://royalcleaning.com.np/our-team'), 'team');
  assert.strictEqual(classifyPageType('https://royalcleaning.com.np/services'), 'services');
  assert.strictEqual(classifyPageType('https://royalcleaning.com.np/blog/cleaning-tips'), 'other');
  console.log('  ✅ PASS: All URL page-type patterns classified correctly');

  // =========================================================================
  // Task 8b.2 & 8b.3: 9-Row Role Decision Matrix Unit Tests
  // =========================================================================
  console.log('\n--- 2. Task 8b.3: 9-Row Role Decision Matrix ---');

  // Row 1: Maps phone (Identity Authority) -> primary_business
  const r1 = evaluateContactRoleMatrix({
    hasMapsSignal: true,
    hasPageCtaSignal: false,
    hasGeneralContactSignal: false,
    hasOwnerLeadershipSignal: false,
    hasStaffSignal: true,
    hasBranchSignal: false,
    hasPlatformSignal: false,
    pageTypesSeen: new Set(['about']),
  });
  assert.strictEqual(r1.role, 'primary_business');
  assert.strictEqual(r1.owner, 'business');
  console.log('  ✅ PASS [Row 1]: Maps phone promotes to primary_business regardless of staff signal');

  // Row 2: Maps phone + Platform conflict -> Maps wins (primary_business)
  const r2 = evaluateContactRoleMatrix({
    hasMapsSignal: true,
    hasPageCtaSignal: false,
    hasGeneralContactSignal: false,
    hasOwnerLeadershipSignal: false,
    hasStaffSignal: false,
    hasBranchSignal: false,
    hasPlatformSignal: true,
    pageTypesSeen: new Set(['homepage']),
  });
  assert.strictEqual(r2.role, 'primary_business');
  assert.strictEqual(r2.owner, 'business');
  console.log('  ✅ PASS [Row 2]: Maps phone overrules platform conflict');

  // Row 3: Homepage CTA + Owner/Leadership title -> primary_business
  const r3 = evaluateContactRoleMatrix({
    hasMapsSignal: false,
    hasPageCtaSignal: true,
    hasGeneralContactSignal: false,
    hasOwnerLeadershipSignal: true,
    hasStaffSignal: false,
    hasBranchSignal: false,
    hasPlatformSignal: false,
    pageTypesSeen: new Set(['homepage']),
  });
  assert.strictEqual(r3.role, 'primary_business');
  assert.strictEqual(r3.owner, 'business');
  console.log('  ✅ PASS [Row 3]: Homepage CTA + Owner/Leadership -> primary_business');

  // Row 4: Homepage + Staff Signal -> staff_person
  const r4 = evaluateContactRoleMatrix({
    hasMapsSignal: false,
    hasPageCtaSignal: false,
    hasGeneralContactSignal: false,
    hasOwnerLeadershipSignal: false,
    hasStaffSignal: true,
    hasBranchSignal: false,
    hasPlatformSignal: false,
    pageTypesSeen: new Set(['homepage']),
  });
  assert.strictEqual(r4.role, 'staff_person');
  assert.strictEqual(r4.owner, 'person');
  console.log('  ✅ PASS [Row 4]: Homepage without business CTA + Staff title -> staff_person');

  // Row 5: Homepage CTA + No person -> primary_business
  const r5 = evaluateContactRoleMatrix({
    hasMapsSignal: false,
    hasPageCtaSignal: true,
    hasGeneralContactSignal: false,
    hasOwnerLeadershipSignal: false,
    hasStaffSignal: false,
    hasBranchSignal: false,
    hasPlatformSignal: false,
    pageTypesSeen: new Set(['homepage']),
  });
  assert.strictEqual(r5.role, 'primary_business');
  assert.strictEqual(r5.owner, 'business');
  console.log('  ✅ PASS [Row 5]: Homepage CTA (no person) -> primary_business');

  // Row 6: About page + Owner/Leadership (no Maps/CTA) -> staff_person
  const r6 = evaluateContactRoleMatrix({
    hasMapsSignal: false,
    hasPageCtaSignal: false,
    hasGeneralContactSignal: false,
    hasOwnerLeadershipSignal: true,
    hasStaffSignal: false,
    hasBranchSignal: false,
    hasPlatformSignal: false,
    pageTypesSeen: new Set(['about']),
  });
  assert.strictEqual(r6.role, 'staff_person');
  assert.strictEqual(r6.owner, 'person');
  console.log('  ✅ PASS [Row 6]: About page profile (no CTA/Maps) -> staff_person');

  // Row 7: About page + Staff/Supervisor -> staff_person
  const r7 = evaluateContactRoleMatrix({
    hasMapsSignal: false,
    hasPageCtaSignal: false,
    hasGeneralContactSignal: false,
    hasOwnerLeadershipSignal: false,
    hasStaffSignal: true,
    hasBranchSignal: false,
    hasPlatformSignal: false,
    pageTypesSeen: new Set(['about']),
  });
  assert.strictEqual(r7.role, 'staff_person');
  assert.strictEqual(r7.owner, 'person');
  console.log('  ✅ PASS [Row 7]: About page supervisor profile -> staff_person');

  // Row 8: Branch signal -> branch_contact
  const r8 = evaluateContactRoleMatrix({
    hasMapsSignal: false,
    hasPageCtaSignal: true,
    hasGeneralContactSignal: false,
    hasOwnerLeadershipSignal: false,
    hasStaffSignal: false,
    hasBranchSignal: true,
    hasPlatformSignal: false,
    pageTypesSeen: new Set(['contact']),
  });
  assert.strictEqual(r8.role, 'branch_contact');
  assert.strictEqual(r8.owner, 'branch');
  console.log('  ✅ PASS [Row 8]: Branch context -> branch_contact');

  // Row 9: Bare text / blog (no signals) -> unknown
  const r9 = evaluateContactRoleMatrix({
    hasMapsSignal: false,
    hasPageCtaSignal: false,
    hasGeneralContactSignal: false,
    hasOwnerLeadershipSignal: false,
    hasStaffSignal: false,
    hasBranchSignal: false,
    hasPlatformSignal: false,
    pageTypesSeen: new Set(['other']),
  });
  assert.strictEqual(r9.role, 'unknown');
  assert.strictEqual(r9.owner, 'unknown');
  console.log('  ✅ PASS [Row 9]: Bare phone in blog post -> unknown, unknown');

  // =========================================================================
  // Task 8b.3: Cross-Page Signal OR-Combination
  // =========================================================================
  console.log('\n--- 3. Cross-Page Signal OR-Combination ---');
  const sighting1 = {
    value: '+977-985-1201603',
    canonicalDigits: '9851201603',
    type: 'phone' as const,
    phoneType: 'mobile' as const,
    role: 'primary_business' as const,
    owner: 'business' as const,
    channels: ['call' as const],
    context: '[Call Now: 9851201603](tel:9851201603)',
    pageUrl: 'https://example.com/',
  };
  const sighting2 = {
    value: '+977-985-1201603',
    canonicalDigits: '9851201603',
    type: 'phone' as const,
    phoneType: 'mobile' as const,
    role: 'staff_person' as const,
    owner: 'person' as const,
    channels: ['whatsapp' as const],
    context: 'Kabita Rai Sales Head [9851201603](tel:9851201603)',
    pageUrl: 'https://example.com/about-us',
  };

  const deduplicated = deduplicateClassifiedContacts([sighting1, sighting2]);
  assert.strictEqual(deduplicated.length, 1);
  const combined = deduplicated[0];
  assert.strictEqual(combined.canonicalDigits, '9851201603');
  assert.strictEqual(combined.role, 'primary_business', 'Homepage CTA should elevate combined phone to primary_business');
  assert.strictEqual(combined.owner, 'business');
  assert(combined.channels.includes('call') && combined.channels.includes('whatsapp'), 'Channels must union [call, whatsapp]');
  assert.strictEqual(combined.pagesSeenOn?.length, 2, 'pagesSeenOn must record both URLs');
  console.log('  ✅ PASS: Multi-page sightings successfully OR-combined (homepage CTA elevates about page contact)');

  // =========================================================================
  // Task 8b.4: Royal Cleaning End-to-End Test (The Real Benchmark Case)
  // =========================================================================
  console.log('\n--- 4. Task 8b.4: Royal Cleaning End-to-End Contact Reconciliation ---');

  // Exact page content from dump run: 2026-09-17T10-11-28-749Z-home-cleaning
  const royalHomepage = {
    url: 'https://royalcleaning.com.np/',
    success: true,
    content: `[Skip to content](#content "Skip to content") [Call Now: 9851201603](tel:9851201603) [Get a Quote](https://royalcleaning.com.np/get-a-quote/) [![Royal Cleaning Service]
Always Available! ### 365 Days ### 24/7 Hours ### Fast Service ### Emergency Service ### [Call Us](tel:9851239227) ### [Messenger](https://www.facebook.com/share/1CCHR5HKJy/) ### [Email Us](mailto:royalcleaning005@gmail.com) ### [WhatsApp](https://wa.me/9851201603) ### [Viber](viber://chat/?number=9851201603)`,
  };

  const royalAboutUs = {
    url: 'https://royalcleaning.com.np/about-us',
    success: true,
    content: `## **Our Team**
### Kamal Bahadur Thapa Chairman * [royalclean005@gmail.com](mailto:royalclean005@gmail.com) * [9851239227](tel:9851239227)
### Bhim Magar Managing Director * [royalclean005@gmail.com](mailto:royalclean005@gmail.com) * [9851239228](tel:9851239227)
### Kabita Rai Sales & Marketing Head | Main Office * [cleaningcarpet666@gmail.com](mailto:royalclean005@gmail.com) * [9851201603](tel:9851201603)
### Sunita Lama Front Desk | Head Office * [servicehousemaid43@gmail.com](mailto:royalclean005@gmail.com) * [+9779802324351](tel:+9779802324351)
### Sricha Magar Front Desk | Royal HR solution * [royalhrjobsolution@gmail.com](mailto:royalhrjobsolution@gmail.com) * [9801354394](tel:9801354394)
### Roshan Tulsibkhya Housekeeping Supervisor * [roshan@gmail.com](mailto:roshan@gmail.com) * [9849939318](tel:9849939318)
### Lochan Rai Field Marketing Executive * [lochanrai@gmail.com](mailto:lochanrai@gmail.com) * [9851312822](tel:9851312822)
### Rohit Magar Supervisor * [rohitranamagar@gmail.com](mailto:rohitranamagar@gmail.com) * [9801355746](tel:9801355746)
### Shailendra Adhikari Web / Graphic Design * [adk.shailendra@gmail.com](mailto:adk.shailendra@gmail.com) * [9860099249](tel:9860099249)`,
  };

  const extracted = extractAllFromPages(
    [royalHomepage, royalAboutUs] as any,
    'Royal Cleaning Services and suppliers Pvt LTD',
    'https://royalcleaning.com.np/'
  );

  const mockCandidate = {
    name: 'Royal Cleaning Services and suppliers Pvt LTD',
    location: 'Bullbulley, Kathmandu 44600',
    website: 'https://royalcleaning.com.np/',
    phone: '+977-985-1239227', // Maps phone
    rating: 4.7,
    ratingCount: 1500,
    category: 'House cleaning service',
    sources: { googleMaps: { found: true }, webSearch: [] },
    entityMatch: { matched: true, confidence: 1, method: 'name' },
  };

  const mockEvidence: VerifiedBusinessEvidence = {
    candidate: mockCandidate as any,
    websiteEvidence: {
      url: 'https://royalcleaning.com.np/',
      domain: 'royalcleaning.com.np',
      pages: [royalHomepage, royalAboutUs] as any,
      ...extracted,
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

  const initialListing: BusinessListing = {
    name: mockCandidate.name,
    location: mockCandidate.location,
    emails: [],
    phones: [],
    mobiles: [],
    websites: [mockCandidate.website],
    icon: '',
    socialLinks: { facebook: '', tiktok: '', instagram: '', other: {} },
    otherDetails: {},
    links: [],
    metadata: { source: 'google_maps', confidence: 0.9, extractedAt: new Date().toISOString() },
    process: 'Verified listing',
  };

  const sanitized = sanitizeListingWithEvidence(
    initialListing,
    mockEvidence
  );

  console.log('  Output Top-level Mobiles:', sanitized.mobiles);
  console.log('  Output Classified Contacts Count:', sanitized.otherDetails?.classifiedContacts?.length);

  // Assertions:
  // 1. Top-level mobiles must contain the 2 legitimate public business numbers (Maps + Homepage Call Now)
  assert(sanitized.mobiles.includes('+977-985-1239227'), 'Must include Maps phone 9851239227');
  assert(sanitized.mobiles.includes('+977-985-1201603'), 'Must include Homepage CTA phone 9851201603');

  // 2. Staff mobile numbers MUST NOT be promoted to top-level mobiles
  assert(!sanitized.mobiles.some((m) => m.includes('9849939318')), 'Roshan Tulsibkhya (Supervisor 9849939318) must NOT be in top-level mobiles');
  assert(!sanitized.mobiles.some((m) => m.includes('9851312822')), 'Lochan Rai (Marketing 9851312822) must NOT be in top-level mobiles');
  assert(!sanitized.mobiles.some((m) => m.includes('9801355746')), 'Rohit Magar (Supervisor 9801355746) must NOT be in top-level mobiles');
  assert(!sanitized.mobiles.some((m) => m.includes('9860099249')), 'Shailendra Adhikari (Design 9860099249) must NOT be in top-level mobiles');

  // Total mobiles should be 2, strictly fixing the 13-mobile pollution defect
  assert.strictEqual(sanitized.mobiles.length, 2, 'Top-level mobiles must contain exactly 2 entries (fixed 13-mobile pollution)');

  // 3. ClassifiedContacts must retain full provenance for staff
  const roshanContact = sanitized.otherDetails?.classifiedContacts?.find((c: any) => c.canonicalDigits === '9849939318');
  assert(roshanContact, 'Roshan contact must be present in classifiedContacts');
  assert.strictEqual(roshanContact?.role, 'staff_person');
  assert.strictEqual(roshanContact?.owner, 'person');

  console.log('  ✅ PASS: Royal Cleaning defect completely resolved (top-level mobiles: 2 entries, staff preserved in classifiedContacts)');

  console.log('\n=== All Phase 8b Tests PASSED successfully! ===');
}

runPhase8bTests().catch((err) => {
  console.error('Phase 8b Test Failure:', err);
  process.exit(1);
});
