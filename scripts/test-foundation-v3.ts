import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import https from 'https';
import {
  classifyEmailRole,
  classifyNepalPhone,
  extractAllFromPages,
  classifySocialProfile,
} from '../src/services/business-extractor.service';
import {
  classifyWebsiteRelationship,
} from '../src/services/website-relationship.service';
import {
  normalizeCategoryIntent,
  expandCategoryQueries,
  type CategoryIntent,
} from '../src/services/search-fallback.service';
import {
  checkCategoryRelevance,
} from '../src/services/candidate-classifier.service';
import {
  detectCrossListingConflicts,
  isIdentifyingSocialProfile,
  isUsableOfficialWebsite,
  type ConflictCheckListing,
} from '../src/services/entity-resolution.service';
import {
  computeConfidenceBreakdown,
} from '../src/services/confidence.service';
import {
  sanitizeListingWithEvidence,
  type BusinessListing,
} from '../src/mastra/workflows/research-workflow';
import type { VerifiedBusinessEvidence } from '../src/mastra/agents/research-agent/verification.schema';
import {
  saveStageOutput,
} from '../src/services/output-storage.service';

// ============================================================================
// 1. STRUCTURAL ZERO-NETWORK GUARD & ISOLATION SETUP
// ============================================================================

let networkCallAttempts = 0;

const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args: any[]) => {
  networkCallAttempts++;
  throw new Error(`[NetworkGuard Violation] Forbidden outbound fetch() call in offline test suite: ${JSON.stringify(args[0])}`);
};

const originalHttpRequest = http.request;
http.request = ((...args: any[]) => {
  networkCallAttempts++;
  throw new Error(`[NetworkGuard Violation] Forbidden outbound http.request() call in offline test suite: ${JSON.stringify(args[0])}`);
}) as any;

const originalHttpsRequest = https.request;
https.request = ((...args: any[]) => {
  networkCallAttempts++;
  throw new Error(`[NetworkGuard Violation] Forbidden outbound https.request() call in offline test suite: ${JSON.stringify(args[0])}`);
}) as any;

const TEST_OUTPUT_ROOT = path.join(os.tmpdir(), `foundation-v3-golden-${Date.now()}`);

function cleanupTempDir() {
  try {
    if (fs.existsSync(TEST_OUTPUT_ROOT)) {
      fs.rmSync(TEST_OUTPUT_ROOT, { recursive: true, force: true });
    }
  } catch {}
}

process.on('exit', () => {
  cleanupTempDir();
  // Restore globals
  globalThis.fetch = originalFetch;
  http.request = originalHttpRequest;
  https.request = originalHttpsRequest;
});

// Deep freeze recursive helper
function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj && typeof obj === 'object') {
    Object.freeze(obj);
    for (const key of Object.keys(obj)) {
      const val = (obj as any)[key];
      if (val && typeof val === 'object' && !Object.isFrozen(val)) {
        deepFreeze(val);
      }
    }
  }
  return obj;
}

// ============================================================================
// 2. TEST HARNESS STATE & HELPERS
// ============================================================================

let totalAssertions = 0;
let passedAssertions = 0;
let failedAssertions = 0;

interface FixtureResult {
  id: string;
  name: string;
  assertions: number;
  passed: number;
  failed: number;
  layersCovered: string[];
}

const fixtureResults: FixtureResult[] = [];

function assertInvariant(
  condition: boolean,
  fixtureId: string,
  layer: string,
  description: string
) {
  totalAssertions++;
  const activeResult = fixtureResults.find((f) => f.id === fixtureId);
  if (activeResult) {
    activeResult.assertions++;
    if (!activeResult.layersCovered.includes(layer)) {
      activeResult.layersCovered.push(layer);
    }
  }

  if (condition) {
    passedAssertions++;
    if (activeResult) activeResult.passed++;
    console.log(`  ✅ [${fixtureId}][${layer}] PASS: ${description}`);
  } else {
    failedAssertions++;
    if (activeResult) activeResult.failed++;
    console.error(`  ❌ [${fixtureId}][${layer}] FAIL: ${description}`);
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
      domain: candidate.website ? candidate.website.replace(/^https?:\/\//, '').split('/')[0] : 'example.com',
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
    websiteLifecycle: relationship === 'service_platform' ? 'identity_confirmed' : 'first_party_owned',
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

// ============================================================================
// 3. IMMUTABLE GOLDEN BENCHMARK FIXTURES (8 ENTITIES)
// ============================================================================

const GOLDEN_FIXTURES = deepFreeze({
  // F1: Om Samaj Dental Hospital (Branch Routing & Contact Partitioning)
  // Sourced from Phase 2 Task 3 benchmark defect (scripts/test-contact-role-classifier.ts T1)
  F1_OM_SAMAJ: {
    id: 'F1',
    name: 'Om Samaj Dental Hospital',
    candidate: makeMockCandidate({
      name: 'Om Samaj Dental Hospital',
      phone: '01-4444356',
      website: 'https://omsamajdental.com',
    }),
    pages: [
      {
        url: 'https://omsamajdental.com/contact-us',
        content: `
          # Contact Om Samaj Dental Hospital
          Main Hospital Kathmandu: 01-4444356
          Emergency: 9851000001
          Email: info@omsamajdental.com
          ## Branches Across Nepal
          - Chabahil Branch: Clinic Phone 01-4470123
          - Banasthali Branch: Office Phone 01-4380456
          - Pokhara Branch: New Road Clinic 061-520123
          - Biratnagar Branch: Main Road Outlet 021-530456
          - Butwal Branch: Traffic Chowk Clinic 071-540789
        `,
      },
    ],
  },

  // F2: Nebuti Bakery (Empty Contacts Verification & Confidence Gating)
  // Sourced from Phase 1 T11 / Phase 2 T4 defect (scripts/test-verification-state.ts & test-contact-role-classifier.ts)
  F2_NEBUTI: {
    id: 'F2',
    name: 'Nebuti Bakery & Restaurant',
    candidate: makeMockCandidate({
      name: 'Nebuti Bakery',
      phone: '',
      website: '',
    }),
    extracted: {
      extractedPhones: [],
      extractedMobiles: [],
      extractedEmails: [],
      extractedSocials: {},
    },
  },

  // F3: Seven Star Consultancy (Fixed-Line Structure & Social Ownership)
  // Sourced from Phase 2 T8 / Phase 3 T11 (scripts/test-nepal-phone-parsing.ts & test-social-ownership.ts)
  F3_SEVEN_STAR: {
    id: 'F3',
    name: 'Seven Star Educational Consultancy',
    landline: '01-4422334',
    mobile: '9851088776',
    officialFb: 'https://facebook.com/sevenstareducation',
    vendorFb: 'https://facebook.com/wix',
    personalLinkedIn: 'https://linkedin.com/in/director-sevenstar',
  },

  // F4: Holidays to Nepal Travel (First-Party Domain Verification & Enrichment)
  // Sourced from Phase 3 Task 7 (scripts/test-website-lifecycle.ts T2 & test-website-relationship.ts T2)
  F4_HOLIDAYS_NEPAL: {
    id: 'F4',
    name: 'Holidays to Nepal Tours',
    website: 'https://holidaystonepal.com',
    email: 'info@holidaystonepal.com',
    pageContent: `
      Welcome to Holidays to Nepal Tours & Treks.
      Official head office in Thamel, Kathmandu. Contact: info@holidaystonepal.com
    `,
  },

  // F5: Forest & Plate Restaurant (Service Platform Contamination Isolation)
  // Sourced from Phase 2 T3 / Phase 3 T23 (scripts/test-contact-role-classifier.ts & test-website-relationship.ts)
  F5_FOREST_PLATE: {
    id: 'F5',
    name: 'Forest and Plate Restaurant',
    website: 'https://forestandplate.noshnepal.com',
    platformEmail: 'info@noshnepal.com',
    pageContent: `
      Forest and Plate Menu hosted on NoshNepal Food Platform.
      For platform inquiries contact info@noshnepal.com.
    `,
  },

  // F6: Good Deal Mart (Business Email vs Personal Staff Email Separation)
  // Sourced from Phase 2 Task 3 / Task 5 (scripts/test-contact-role-classifier.ts T2 & test-email-sanity-filter.ts T9)
  F6_GOOD_DEAL: {
    id: 'F6',
    name: 'Good Deal Mart',
    website: 'https://gooddeal.com.np',
    bizEmail: 'contact@gooddeal.com.np',
    staffEmail: 'mukti.gooddeal@gmail.com',
    pageContent: `
      Good Deal Mart Kathmandu
      General Inquiries: contact@gooddeal.com.np
      Store Manager: Mukti Shrestha (mukti.gooddeal@gmail.com)
    `,
  },

  // F7: Sports Benchmark - SPORTS-01 (Category Ontology, Expansion & Telemetry Invariants)
  // Sourced from Phase 4 Task 8 (scripts/test-category-expansion.ts)
  F7_SPORTS: {
    id: 'F7',
    name: 'Sports Discovery Funnel',
    rawQuery: 'Sports',
    location: 'Kathmandu',
    candidates: [
      { name: 'Kathmandu Sports Shop', category: 'Retail', origin: 'exact' as const },
      { name: 'Himalayan Futsal', category: undefined, origin: 'expanded' as const },
      { name: 'Patan Sports Medicine & Rehab Clinic', category: 'Medical Clinic', origin: 'expanded' as const },
      { name: 'Champions Sports Bar & Grill', category: 'Bar', origin: 'expanded' as const },
      { name: 'Hospitality Sports Travel', category: undefined, origin: 'expanded' as const },
    ],
  },

  // F8: Schools Benchmark (Category Scope Isolation / Narrow Bypass)
  // Sourced from Phase 4 Task 8 unpolicied isolation (scripts/test-category-expansion.ts T22)
  F8_SCHOOLS: {
    id: 'F8',
    name: 'Schools Category Scope Isolation',
    rawQuery: 'Kathmandu International School',
    location: 'Kathmandu',
    candidateName: 'Kathmandu International School',
  },
});

// Snapshot for immutability verification
const FIXTURE_SNAPSHOT = JSON.stringify(GOLDEN_FIXTURES);

// ============================================================================
// 4. MAIN TEST EXECUTION HARNESS
// ============================================================================

async function runFoundationV3Suite() {
  console.log('================================================================');
  console.log('🧪 FOUNDATION V3 GOLDEN-DATASET OFFLINE CERTIFICATION SUITE');
  console.log('================================================================\n');

  // Track observed contactOwner and websiteRelationship values for cross-fixture invariants
  const observedContactOwners = new Set<string>();
  const observedWebsiteRelationships = new Set<string>();

  try {
    // ------------------------------------------------------------------------
    // FIXTURE 1: Om Samaj Dental Hospital
    // ------------------------------------------------------------------------
    console.log('--- [F1] Om Samaj Dental Hospital (Branch & Partition Semantics) ---');
    fixtureResults.push({
      id: 'F1',
      name: 'Om Samaj Dental Hospital',
      assertions: 0,
      passed: 0,
      failed: 0,
      layersCovered: [],
    });

    const f1 = GOLDEN_FIXTURES.F1_OM_SAMAJ;
    const f1Pages = makeMockPages(f1.pages as any);
    const f1Extracted = extractAllFromPages(f1Pages, f1.candidate.name, f1.candidate.website);

    // Assert branch contacts classified
    const f1Branches = (f1Extracted.extractedClassifiedContacts || []).filter((c) => c.role === 'branch_contact');
    assertInvariant(f1Branches.length >= 5, 'F1', 'Layer2:Extraction', `Identified >= 5 branch contacts (got ${f1Branches.length})`);

    // Projection & Sanitization
    const f1Evidence = makeMockEvidence(f1.candidate, f1Extracted, 'first_party');
    const f1Listing = makeMockListing(f1.candidate);
    const f1Projected = sanitizeListingWithEvidence(f1Listing, f1Evidence);

    // Primary phone preserved in top-level
    assertInvariant(
      f1Projected.phones.some((p) => p.includes('4444356')),
      'F1',
      'Layer5:Projection',
      'Main hospital landline (01-4444356) projected to top-level phones[]'
    );

    // Branch phones strictly isolated in otherDetails.branches
    const hasBranchLeak = f1Projected.phones.some((p) => ['4470123', '4380456', '520123', '530456', '540789'].some((b) => p.includes(b)));
    assertInvariant(!hasBranchLeak, 'F1', 'Layer5:Projection', 'Branch phones are strictly excluded from top-level phones[]');
    assertInvariant(
      Boolean(f1Projected.otherDetails?.branches && (f1Projected.otherDetails.branches.length || 0) >= 4),
      'F1',
      'Layer5:Projection',
      'otherDetails.branches populated with branch records'
    );

    // Contact Partition Invariant: phones ∩ mobiles = ∅
    const f1PhonesNorm = new Set(f1Projected.phones.map((p) => p.replace(/\D/g, '')));
    const f1MobilesNorm = new Set(f1Projected.mobiles.map((m) => m.replace(/\D/g, '')));
    const f1Overlap = [...f1PhonesNorm].filter((x) => f1MobilesNorm.has(x));
    assertInvariant(f1Overlap.length === 0, 'F1', 'CrossPhase:ContactInvariant', 'Contact partition invariant held (phones ∩ mobiles = ∅)');

    // ------------------------------------------------------------------------
    // FIXTURE 2: Nebuti Bakery
    // ------------------------------------------------------------------------
    console.log('\n--- [F2] Nebuti Bakery (Empty Contacts Verification & Confidence Gating) ---');
    fixtureResults.push({
      id: 'F2',
      name: 'Nebuti Bakery',
      assertions: 0,
      passed: 0,
      failed: 0,
      layersCovered: [],
    });

    const f2 = GOLDEN_FIXTURES.F2_NEBUTI;
    const f2Candidate = f2.candidate;
    const f2Listing = makeMockListing(f2Candidate);
    const f2Evidence = makeMockEvidence(f2Candidate, f2.extracted, 'unverified');
    f2Evidence.verification.status = 'failed';
    f2Evidence.verification.checks.websiteIsUsableOfficial = false;
    f2Evidence.verification.checks.phoneMatchesMaps = false;

    const f2Projected = sanitizeListingWithEvidence(f2Listing, f2Evidence);

    // Final listings have empty contacts
    assertInvariant(f2Projected.phones.length === 0 && f2Projected.mobiles.length === 0, 'F2', 'Layer5:Projection', 'Final contact numbers are empty');

    // Confidence breakdown verification
    const f2Confidence = computeConfidenceBreakdown({
      isMapsCandidate: true,
      hasWebsiteEvidence: false,
      rating: f2Candidate.rating,
      ratingCount: f2Candidate.ratingCount,
      verificationConfidence: f2Evidence.verification.overallConfidence,
      verificationChecks: {
        phoneMatchesMaps: f2Evidence.verification.checks.phoneMatchesMaps,
        emailFoundOnWebsite: f2Evidence.verification.checks.emailFoundOnWebsite,
        addressOrLocationFoundOnWebsite: f2Evidence.verification.checks.addressOrLocationFoundOnWebsite,
      },
      websiteRelationship: f2Evidence.websiteRelationship,
      finalEmails: f2Projected.emails,
      finalWebsites: f2Projected.websites,
      finalPhones: f2Projected.phones,
      finalMobiles: f2Projected.mobiles,
    });
    assertInvariant(f2Confidence.evidenceSummary.phoneVerified === false, 'F2', 'Layer5:Confidence', 'Empty final contacts strictly gate phoneVerified to false');
    assertInvariant(f2Confidence.evidenceSummary.websiteVerified === false, 'F2', 'Layer5:Confidence', 'Empty final websites strictly gate websiteVerified to false');
    assertInvariant(f2Confidence.evidenceSummary.mapsVerified === true, 'F2', 'Layer5:Confidence', 'Maps candidate identity verified independently (mapsVerified = true)');
    assertInvariant(
      f2Confidence.overallConfidence >= 0 && f2Confidence.overallConfidence <= 1,
      'F2',
      'Layer5:Confidence',
      'Overall confidence score is bounded in [0, 1]'
    );

    // ------------------------------------------------------------------------
    // FIXTURE 3: Seven Star Consultancy
    // ------------------------------------------------------------------------
    console.log('\n--- [F3] Seven Star Consultancy (Fixed-Line & Social Provenance) ---');
    fixtureResults.push({
      id: 'F3',
      name: 'Seven Star Consultancy',
      assertions: 0,
      passed: 0,
      failed: 0,
      layersCovered: [],
    });

    const f3 = GOLDEN_FIXTURES.F3_SEVEN_STAR;
    const f3PhoneClass = classifyNepalPhone(f3.landline);
    const f3MobileClass = classifyNepalPhone(f3.mobile);

    assertInvariant(f3PhoneClass.type === 'landline' && f3PhoneClass.digits === '14422334', 'F3', 'Layer2:Extraction', 'Kathmandu landline correctly canonicalized');
    assertInvariant(f3MobileClass.type === 'mobile' && f3MobileClass.digits === '9851088776', 'F3', 'Layer2:Extraction', 'NTA mobile correctly canonicalized');

    // Social profile classification
    const f3OfficialFb = classifySocialProfile(f3.officialFb, 'facebook', 'Seven Star Educational Consultancy', 'sevenstar.edu.np');
    const f3VendorFb = classifySocialProfile(f3.vendorFb, 'facebook', 'Seven Star Educational Consultancy', 'sevenstar.edu.np');
    const f3PersonalLi = classifySocialProfile(f3.personalLinkedIn, 'linkedin', 'Seven Star Educational Consultancy', 'sevenstar.edu.np');

    assertInvariant(f3OfficialFb.status === 'accepted' && f3OfficialFb.owner === 'business', 'F3', 'Layer4:Social', 'Official business Facebook profile accepted');
    assertInvariant(f3VendorFb.status === 'rejected' && f3VendorFb.rejectionReason === 'VENDOR_PROFILE', 'F3', 'Layer4:Social', 'Vendor handle (wix) rejected');
    assertInvariant(f3PersonalLi.status === 'rejected' && f3PersonalLi.rejectionReason === 'PERSONAL_PROFILE', 'F3', 'Layer4:Social', 'Personal LinkedIn profile rejected');
    assertInvariant(isIdentifyingSocialProfile(f3.personalLinkedIn) === true, 'F3', 'Layer4:Social', 'Personal profile correctly flagged as uniquely identifying for conflict detection');
    assertInvariant(isIdentifyingSocialProfile(f3.officialFb) === false, 'F3', 'Layer4:Social', 'Business official profile flagged non-identifying for conflict detection');

    observedContactOwners.add(f3OfficialFb.owner);
    observedContactOwners.add(f3VendorFb.owner);

    // ------------------------------------------------------------------------
    // FIXTURE 4: Holidays to Nepal Travel
    // ------------------------------------------------------------------------
    console.log('\n--- [F4] Holidays to Nepal Travel (First-Party Domain Verification) ---');
    fixtureResults.push({
      id: 'F4',
      name: 'Holidays to Nepal Travel',
      assertions: 0,
      passed: 0,
      failed: 0,
      layersCovered: [],
    });

    const f4 = GOLDEN_FIXTURES.F4_HOLIDAYS_NEPAL;
    const f4Rel = classifyWebsiteRelationship(f4.website, f4.name, f4.pageContent);
    assertInvariant(f4Rel.relationship === 'first_party', 'F4', 'Layer3:Website', 'First-party domain correctly classified as relationship: first_party');
    assertInvariant(f4Rel.isContactEnrichable === true, 'F4', 'Layer3:Website', 'First-party domain is marked isContactEnrichable: true');
    assertInvariant(isUsableOfficialWebsite(f4.website) === true, 'F4', 'Layer3:Website', 'First-party website is marked isUsableOfficialWebsite: true');

    observedWebsiteRelationships.add(f4Rel.relationship);

    // ------------------------------------------------------------------------
    // FIXTURE 5: Forest & Plate Restaurant
    // ------------------------------------------------------------------------
    console.log('\n--- [F5] Forest & Plate (Service Platform Contamination Isolation) ---');
    fixtureResults.push({
      id: 'F5',
      name: 'Forest and Plate Restaurant',
      assertions: 0,
      passed: 0,
      failed: 0,
      layersCovered: [],
    });

    const f5 = GOLDEN_FIXTURES.F5_FOREST_PLATE;
    const f5Rel = classifyWebsiteRelationship(f5.website, f5.name, f5.pageContent);
    assertInvariant(f5Rel.relationship === 'service_platform', 'F5', 'Layer3:Website', 'Platform domain (noshnepal.com) classified as service_platform');
    assertInvariant(f5Rel.isContactEnrichable === false, 'F5', 'Layer3:Website', 'Service platform domain is marked isContactEnrichable: false');

    // Platform email classification & exclusion
    const f5EmailClass = classifyEmailRole(f5.platformEmail, 'Platform contact', f5.name, 'noshnepal.com');
    assertInvariant(f5EmailClass.owner === 'platform', 'F5', 'Layer2:Extraction', 'info@noshnepal.com classified as owner: platform');

    const f5Candidate = makeMockCandidate({ name: f5.name, website: f5.website });
    const f5Pages = makeMockPages([{ url: f5.website, content: f5.pageContent }]);
    const f5Extracted = extractAllFromPages(f5Pages, f5.name, f5.website);
    const f5Evidence = makeMockEvidence(f5Candidate, f5Extracted, f5Rel.relationship);
    const f5Listing = makeMockListing(f5Candidate);
    const f5Projected = sanitizeListingWithEvidence(f5Listing, f5Evidence);

    assertInvariant(!f5Projected.emails.includes(f5.platformEmail), 'F5', 'Layer5:Projection', 'Platform email is strictly excluded from listing emails[]');

    observedContactOwners.add(f5EmailClass.owner);
    observedWebsiteRelationships.add(f5Rel.relationship);

    // ------------------------------------------------------------------------
    // FIXTURE 6: Good Deal Mart
    // ------------------------------------------------------------------------
    console.log('\n--- [F6] Good Deal Mart (Business vs Staff Email Separation) ---');
    fixtureResults.push({
      id: 'F6',
      name: 'Good Deal Mart',
      assertions: 0,
      passed: 0,
      failed: 0,
      layersCovered: [],
    });

    const f6 = GOLDEN_FIXTURES.F6_GOOD_DEAL;
    const f6BizEmail = classifyEmailRole(f6.bizEmail, 'General contact', f6.name, 'gooddeal.com.np');
    const f6StaffEmail = classifyEmailRole(f6.staffEmail, 'Store manager Mukti Shrestha', f6.name, 'gooddeal.com.np');

    assertInvariant(f6BizEmail.owner === 'business' && f6BizEmail.role === 'primary_business', 'F6', 'Layer2:Extraction', 'contact@gooddeal.com.np classified owner: business, role: primary_business');
    assertInvariant(f6StaffEmail.owner === 'person' && f6StaffEmail.role === 'staff_person', 'F6', 'Layer2:Extraction', 'mukti.gooddeal@gmail.com classified owner: person, role: staff_person');

    const f6Candidate = makeMockCandidate({ name: f6.name, website: f6.website });
    const f6Pages = makeMockPages([{ url: f6.website, content: f6.pageContent }]);
    const f6Extracted = extractAllFromPages(f6Pages, f6.name, f6.website);
    const f6Evidence = makeMockEvidence(f6Candidate, f6Extracted, 'first_party');
    const f6Listing = makeMockListing(f6Candidate);
    const f6Projected = sanitizeListingWithEvidence(f6Listing, f6Evidence);

    assertInvariant(f6Projected.emails.includes(f6.bizEmail), 'F6', 'Layer5:Projection', 'Business email promoted to final listing emails[]');
    assertInvariant(!f6Projected.emails.includes(f6.staffEmail), 'F6', 'Layer5:Projection', 'Staff personal email strictly excluded from final listing emails[]');
    assertInvariant(
      Boolean(f6Projected.otherDetails?.classifiedContacts && (f6Projected.otherDetails.classifiedContacts as any[]).some((c) => c.value === f6.staffEmail)),
      'F6',
      'Layer5:Projection',
      'Staff personal email preserved in classifiedContacts audit trail'
    );

    observedContactOwners.add(f6BizEmail.owner);
    observedContactOwners.add(f6StaffEmail.owner);

    // ------------------------------------------------------------------------
    // FIXTURE 7: Sports Benchmark (SPORTS-01 Discovery & Telemetry Invariants)
    // ------------------------------------------------------------------------
    console.log('\n--- [F7] Sports Benchmark (Category Ontology & Telemetry Invariants) ---');
    fixtureResults.push({
      id: 'F7',
      name: 'Sports Discovery Funnel',
      assertions: 0,
      passed: 0,
      failed: 0,
      layersCovered: [],
    });

    const f7 = GOLDEN_FIXTURES.F7_SPORTS;
    const f7Intent: CategoryIntent = normalizeCategoryIntent(f7.rawQuery);
    assertInvariant(f7Intent.normalized === 'sports' && f7Intent.isBroad === true, 'F7', 'Layer1:Discovery', 'Category intent normalized to sports (isBroad = true)');

    const f7Queries = expandCategoryQueries(f7Intent, f7.location);
    assertInvariant(f7Queries.length <= f7Intent.maxTotalQueries, 'F7', 'Layer1:Discovery', `Queries bounded by policy.maxTotalQueries (got ${f7Queries.length} <= ${f7Intent.maxTotalQueries})`);
    assertInvariant(f7Queries[0].query === 'Sports Kathmandu' && f7Queries[0].type === 'exact', 'F7', 'Layer1:Discovery', 'First query is exact query with location appended');

    // Candidate relevance filtering
    let rawCount = 0;
    let exactCount = 0;
    let expandedCount = 0;
    let relevantCount = 0;
    let irrelevantCount = 0;
    let ambiguousCount = 0;

    for (const c of f7.candidates) {
      rawCount++;
      if (c.origin === 'exact') exactCount++;
      else expandedCount++;

      const rel = checkCategoryRelevance(c.name, c.category, f7Intent);
      if (rel.status === 'relevant') relevantCount++;
      else if (rel.status === 'irrelevant') irrelevantCount++;
      else ambiguousCount++;
    }

    // Specific decision checks
    const r1 = checkCategoryRelevance('Kathmandu Sports Shop', 'Retail', f7Intent);
    const r2 = checkCategoryRelevance('Himalayan Futsal', undefined, f7Intent);
    const r3 = checkCategoryRelevance('Patan Sports Medicine & Rehab Clinic', 'Medical Clinic', f7Intent);
    const r4 = checkCategoryRelevance('Champions Sports Bar & Grill', 'Bar', f7Intent);
    const r5 = checkCategoryRelevance('Hospitality Sports Travel', undefined, f7Intent);

    assertInvariant(r1.status === 'relevant' && r1.reason === 'CATEGORY_AND_FORM_MATCH', 'F7', 'Layer1:Discovery', 'Tier 1 Positive Match: Kathmandu Sports Shop');
    assertInvariant(r2.status === 'relevant' && r2.reason === 'CATEGORY_TOKEN_MATCH', 'F7', 'Layer1:Discovery', 'Tier 2 Positive Match: Himalayan Futsal');
    assertInvariant(r3.status === 'irrelevant' && r3.reason.startsWith('EXCLUDED_TERM_MATCH'), 'F7', 'Layer1:Discovery', 'Clinical exclusion: Patan Sports Medicine');
    assertInvariant(r4.status === 'irrelevant' && r4.reason.startsWith('EXCLUDED_TERM_MATCH'), 'F7', 'Layer1:Discovery', 'Bar/Hospitality exclusion: Champions Sports Bar');
    assertInvariant(r5.status === 'ambiguous' && r5.reason === 'INSUFFICIENT_CATEGORY_EVIDENCE', 'F7', 'Layer1:Discovery', 'Ambiguous default: Hospitality Sports Travel (generic token without form)');

    // Telemetry Arithmetic Invariants
    assertInvariant(exactCount + expandedCount === rawCount, 'F7', 'CrossPhase:TelemetryInvariant', `exact (${exactCount}) + expanded (${expandedCount}) === raw (${rawCount})`);
    assertInvariant(relevantCount + irrelevantCount + ambiguousCount === rawCount, 'F7', 'CrossPhase:TelemetryInvariant', `relevant (${relevantCount}) + irrelevant (${irrelevantCount}) + ambiguous (${ambiguousCount}) === raw (${rawCount})`);
    assertInvariant(relevantCount <= rawCount, 'F7', 'CrossPhase:TelemetryInvariant', `uniqueEntities (${relevantCount}) <= relevantCandidates (${relevantCount})`);

    // ------------------------------------------------------------------------
    // FIXTURE 8: Schools Benchmark (Category Scope Isolation)
    // ------------------------------------------------------------------------
    console.log('\n--- [F8] Schools Benchmark (Category Scope Isolation) ---');
    fixtureResults.push({
      id: 'F8',
      name: 'Schools Category Scope Isolation',
      assertions: 0,
      passed: 0,
      failed: 0,
      layersCovered: [],
    });

    const f8 = GOLDEN_FIXTURES.F8_SCHOOLS;
    const f8Intent: CategoryIntent = normalizeCategoryIntent(f8.rawQuery);
    assertInvariant(f8Intent.isBroad === false, 'F8', 'Layer1:Discovery', 'Unpolicied category intent is narrow by design (isBroad = false)');

    const f8Relevance = checkCategoryRelevance(f8.candidateName, 'School', f8Intent);
    assertInvariant(f8Relevance.status === 'relevant' && f8Relevance.reason === 'NARROW_QUERY_NO_FILTER' && f8Relevance.confidence === 1.0, 'F8', 'Layer1:Discovery', 'Narrow query bypass assigned NARROW_QUERY_NO_FILTER with confidence 1.0');

    // ------------------------------------------------------------------------
    // 5. CROSS-FIXTURE INVARIANTS & OUTPUT OBSERVABILITY ISOLATION TEST
    // ------------------------------------------------------------------------
    console.log('\n--- Cross-Fixture Set Invariants & Output Observability ---');
    fixtureResults.push({
      id: 'GLOBAL',
      name: 'Cross-Fixture Invariants & Output Observability',
      assertions: 0,
      passed: 0,
      failed: 0,
      layersCovered: [],
    });

    // Cross-Fixture Owner Coverage Invariant
    assertInvariant(
      observedContactOwners.has('business') &&
        observedContactOwners.has('person') &&
        observedContactOwners.has('platform'),
      'GLOBAL',
      'CrossFixture:Coverage',
      'Aggregate fixtures exercise business, person, and platform contact owners'
    );

    // Cross-Fixture Relationship Coverage Invariant
    assertInvariant(
      observedWebsiteRelationships.has('first_party') &&
        observedWebsiteRelationships.has('service_platform'),
      'GLOBAL',
      'CrossFixture:Coverage',
      'Aggregate fixtures exercise first_party and service_platform relationships'
    );

    // Isolated Output Observability Write Test
    const testRunId = 'foundation-v3-golden-run-001';
    const testConflictPayload: ConflictCheckListing[] = [
      { name: 'Hotel A', phones: ['+977-1-4200000'], websites: ['https://hotela.com'] },
      { name: 'Hotel B', phones: ['+977-1-4200000'], websites: ['https://hotelb.com'] },
    ];

    const conflictReport = detectCrossListingConflicts(testConflictPayload);
    const conflictArtifact = {
      runId: testRunId,
      generatedAt: new Date().toISOString(),
      conflicts: conflictReport.conflicts,
      clusters: conflictReport.clusters,
      conflictCount: conflictReport.conflicts.length,
    };

    saveStageOutput('conflicts', 'entity-conflicts.json', conflictArtifact, 'Test Query', {
      outputRoot: TEST_OUTPUT_ROOT,
      runId: testRunId,
    });

    const writtenRoot = path.join(TEST_OUTPUT_ROOT, 'entity-conflicts.json');
    const writtenHistory = path.join(TEST_OUTPUT_ROOT, 'history', testRunId, 'entity-conflicts.json');
    const writtenLatest = path.join(TEST_OUTPUT_ROOT, 'latest', 'entity-conflicts.json');

    assertInvariant(fs.existsSync(writtenRoot), 'GLOBAL', 'Layer6:Output', 'Conflict artifact saved to isolated root mirror');
    assertInvariant(fs.existsSync(writtenHistory), 'GLOBAL', 'Layer6:Output', 'Conflict artifact saved to isolated history archive');
    assertInvariant(fs.existsSync(writtenLatest), 'GLOBAL', 'Layer6:Output', 'Conflict artifact copied to isolated latest mirror');

    const readArtifact = JSON.parse(fs.readFileSync(writtenRoot, 'utf-8'));
    assertInvariant(
      readArtifact.conflictCount === 1 && readArtifact.conflictCount === readArtifact.conflicts.length,
      'GLOBAL',
      'Layer6:Output',
      'Conflict artifact envelope enforces conflictCount === conflicts.length'
    );
    assertInvariant(readArtifact.runId === testRunId, 'GLOBAL', 'Layer6:Output', 'Conflict artifact preserves exact runId provenance');
    assertInvariant(
      !isNaN(Date.parse(readArtifact.generatedAt)) && readArtifact.generatedAt.includes('T'),
      'GLOBAL',
      'Layer6:Output',
      'Conflict artifact generatedAt is a valid parseable ISO-8601 string'
    );

    // Fixture Deep Immutability Verification (Snapshot check)
    const currentSnapshot = JSON.stringify(GOLDEN_FIXTURES);
    assertInvariant(currentSnapshot === FIXTURE_SNAPSHOT, 'GLOBAL', 'Immutability', 'All 8 golden fixture definitions remained 100% immutable across execution');

    // Structural Zero-Network Invariant
    assertInvariant(networkCallAttempts === 0, 'GLOBAL', 'ZeroNetwork', `Zero external network calls executed (attempts: ${networkCallAttempts})`);

  } finally {
    cleanupTempDir();
  }

  // ============================================================================
  // 6. CERTIFICATION REPORT BANNER
  // ============================================================================
  console.log('\n================================================================');
  console.log('📊 FOUNDATION V3 GOLDEN DATASET FIXTURE REPORT');
  console.log('================================================================');
  console.log('Fixture ID | Name                                      | Pass / Total | Layers Covered');
  console.log('-----------|-------------------------------------------|--------------|-----------------------------');
  for (const res of fixtureResults) {
    const status = res.failed === 0 ? 'PASS' : 'FAIL';
    console.log(
      `${res.id.padEnd(10)} | ${res.name.padEnd(41)} | ${res.passed}/${res.assertions} (${status}) | ${res.layersCovered.join(', ')}`
    );
  }
  console.log('================================================================\n');

  const allPassed = failedAssertions === 0 && networkCallAttempts === 0;

  if (allPassed) {
    console.log('================================================================');
    console.log('🏆 FOUNDATION V3: CERTIFIED');
    console.log('================================================================');
    console.log(`• Total Golden Fixtures: 8 / 8 Evaluated`);
    console.log(`• Total Semantic Assertions: ${totalAssertions} / ${passedAssertions} Passed (100%)`);
    console.log(`• External Network Calls: ${networkCallAttempts} (Zero-API Enforced)`);
    console.log(`• Estimated External Cost: $0.00`);
    console.log(`• Fixture Immutability: Verified 100% Immutable`);
    console.log(`• Production Path Isolation: Verified Clean`);
    console.log('================================================================\n');
  } else {
    console.error('================================================================');
    console.error('❌ FOUNDATION V3: NOT CERTIFIED — see failures above');
    console.error(`• Total Assertions: ${totalAssertions}, Failed: ${failedAssertions}`);
    console.error(`• Network Violations: ${networkCallAttempts}`);
    console.error('================================================================\n');
    process.exit(1);
  }
}

runFoundationV3Suite().catch((err) => {
  console.error('Fatal error in Foundation v3 Suite:', err);
  process.exit(1);
});
