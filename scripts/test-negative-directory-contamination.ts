process.env.DISCOVERY_MODE = 'benchmark';

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  runWebsiteDiscoveryGate,
  getDiscoveryTelemetryCounters,
  validateDiscoveryStateInvariant,
  type WebsiteDiscoveryArtifact,
  type DiscoveryLookupResult,
  type DiscoveryGateSummary,
} from '@/services/discovery/website-discovery-gate.service';
import { selectFirstPartyWebsiteUrl } from '@/services/discovery/website-search-ranker.service';
import {
  isUsableOfficialWebsite,
  domainFromUrlOrHost,
} from '@/services/resolution/entity-resolution.service';
import { buildResearchCandidates } from '@/services/resolution/research-candidate.service';
import {
  classifyWebsiteRelationship,
} from '@/services/resolution/website-relationship.service';
import {
  businessListingSchema,
  sanitizeListingWithEvidence,
  type BusinessListing,
} from '@/mastra/workflows/research-workflow';
import {
  saveStageOutput,
  startRunSession,
  endRunSession,
} from '@/services/storage/output-storage.service';
import type { SerperPlaceResult } from '@/services/external/serper-places.service';
import type { VerifiedBusinessEvidence } from '@/mastra/agents/research-agent/verification.schema';

// ============================================================================
// Phase 7b Task 12 — Negative Directory Contamination Regression Test (OFFLINE)
// ============================================================================
// Acceptance criteria verified here:
//   1. process.env.DISCOVERY_MODE = 'benchmark' set at module load
//   2. School with ONLY Edusanjal & CollegesNepal yields DISCOVERY_FOUND_ONLY_THIRD_PARTY
//   3. Restaurant with ONLY NoshNepal yields DISCOVERY_FOUND_ONLY_THIRD_PARTY
//   4. Candidate website remains empty (0 contamination) across all directory-only SERPs
//   5. classifyWebsiteRelationship tags Edusanjal/CollegesNepal as 'directory' and NoshNepal as 'service_platform'
//   6. isContactEnrichable is strictly false for both directory and service_platform (Task 6 verification)
//   7. isUsableOfficialWebsite directly rejects all directory and platform profiles
//   8. sanitizeListingWithEvidence merges 0 contacts from directory/platform pages (Task 6 verification)
//   9. Candidate with 0 search results yields DISCOVERY_EXHAUSTED_NO_FIRST_PARTY
//  10. validateDiscoveryStateInvariant holds strictly across the negative batch
//  11. Stage 0 discovery artifact envelope (0-website-discovery.json) persists cleanly to isolated scratch root
// ============================================================================

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testId: string, description: string) {
  totalTests++;
  if (condition) {
    console.log(`✅ [PASS] ${testId}: ${description}`);
    passedTests++;
  } else {
    console.error(`❌ [FAIL] ${testId}: ${description}`);
    failedTests++;
  }
}

const TEST_OUTPUT_ROOT = path.join(os.tmpdir(), `negative-contamination-test-${Date.now()}`);

function cleanupTempDir() {
  try {
    if (fs.existsSync(TEST_OUTPUT_ROOT)) {
      fs.rmSync(TEST_OUTPUT_ROOT, { recursive: true, force: true });
    }
  } catch {}
}

process.on('exit', cleanupTempDir);

async function runNegativeDirectoryContaminationTests() {
  console.log('================================================================');
  console.log('🧪 TASK 12: NEGATIVE DIRECTORY CONTAMINATION REGRESSION TEST (17 ASSERTIONS)');
  console.log('================================================================\n');

  // --- 1. Module configuration & scratch isolation ---
  assert(
    process.env.DISCOVERY_MODE === 'benchmark',
    'T12.1',
    'process.env.DISCOVERY_MODE is strictly set to "benchmark" at module load'
  );

  fs.mkdirSync(TEST_OUTPUT_ROOT, { recursive: true });
  assert(
    fs.existsSync(TEST_OUTPUT_ROOT) && !TEST_OUTPUT_ROOT.includes('searchDump/output'),
    'T12.2',
    `Test-isolated scratch directory created outside live output (${TEST_OUTPUT_ROOT})`
  );

  // --- 2. School place with ONLY Edusanjal & CollegesNepal directory profiles ---
  const schoolPlace: SerperPlaceResult = {
    position: 1,
    title: 'Prabhat Secondary School',
    address: 'Patan, Lalitpur',
    category: 'School',
    phoneNumber: '+977 1-5521234',
    placeId: 'place_prabhat_school_001',
    website: undefined,
  };

  const schoolSerpResults = [
    {
      title: 'Prabhat Secondary School - Patan, Lalitpur | Edusanjal',
      url: 'https://edusanjal.com/school/prabhat-secondary-school',
      snippet: 'Directory profile of Prabhat Secondary School on Edusanjal education portal.',
    },
    {
      title: 'Prabhat Secondary School, Lalitpur | CollegesNepal',
      url: 'https://collegesnepal.com/school/prabhat-school',
      snippet: 'Educational directory listing for Prabhat Secondary School.',
    },
  ];

  // --- 3. Restaurant place with ONLY NoshNepal service platform profile ---
  const restaurantPlace: SerperPlaceResult = {
    position: 2,
    title: 'Himalayan Flavours Cafe',
    address: 'Jhamsikhel, Lalitpur',
    category: 'Restaurant',
    phoneNumber: '+977 1-5545678',
    placeId: 'place_himalayan_flavours_002',
    website: undefined,
  };

  const restaurantSerpResults = [
    {
      title: 'Himalayan Flavours Cafe - Order Online | NoshNepal',
      url: 'https://noshnepal.com/restaurant/himalayan-flavours',
      snippet: 'Order food delivery from Himalayan Flavours Cafe on NoshNepal delivery platform.',
    },
  ];

  // --- 4. Obscure place with empty search results ---
  const obscurePlace: SerperPlaceResult = {
    position: 3,
    title: 'Unknown Local Workshop',
    address: 'Balkhu, Kathmandu',
    category: 'Workshop',
    placeId: 'place_obscure_003',
    website: undefined,
  };

  // Run Website Discovery Gate across the 3 test places
  const batchPlaces = [schoolPlace, restaurantPlace, obscurePlace];
  const summary: DiscoveryGateSummary = await runWebsiteDiscoveryGate({
    places: batchPlaces,
    lookupBudget: 10,
    lookup: async (place): Promise<DiscoveryLookupResult> => {
      if (place.placeId === 'place_prabhat_school_001') {
        return { queries: [`${place.title} Patan`], results: schoolSerpResults };
      }
      if (place.placeId === 'place_himalayan_flavours_002') {
        return { queries: [`${place.title} Jhamsikhel`], results: restaurantSerpResults };
      }
      return { queries: [`${place.title} Kathmandu`], results: [] };
    },
    selectFirstPartyUrl: (place, results) => {
      const selection = selectFirstPartyWebsiteUrl({
        results,
        businessName: place.title,
        location: place.address,
        isUsable: (candidate) =>
          isUsableOfficialWebsite(
            candidate.url,
            place.title,
            place.category || place.type,
            candidate.title
          ),
      });
      return { url: selection.url, reason: selection.reason };
    },
  });

  // Assertions for School (Edusanjal / CollegesNepal)
  const schoolRecord = summary.records.find((r) => r.key.includes('prabhat'))!;
  assert(
    schoolRecord.state === 'DISCOVERY_FOUND_ONLY_THIRD_PARTY' &&
      schoolRecord.selectedUrl === undefined &&
      schoolPlace.website === undefined,
    'T12.3',
    'School with only Edusanjal/CollegesNepal yields DISCOVERY_FOUND_ONLY_THIRD_PARTY and website remains empty'
  );

  assert(
    schoolRecord.candidateUrlsReviewed.includes('https://edusanjal.com/school/prabhat-secondary-school') &&
      schoolRecord.candidateUrlsReviewed.includes('https://collegesnepal.com/school/prabhat-school'),
    'T12.4',
    'School record candidateUrlsReviewed captures all evaluated directory URLs for full auditability'
  );

  // Assertions for Restaurant (NoshNepal)
  const restaurantRecord = summary.records.find((r) => r.key.includes('himalayan_flavours'))!;
  assert(
    restaurantRecord.state === 'DISCOVERY_FOUND_ONLY_THIRD_PARTY' &&
      restaurantRecord.selectedUrl === undefined &&
      restaurantPlace.website === undefined,
    'T12.5',
    'Restaurant with only NoshNepal yields DISCOVERY_FOUND_ONLY_THIRD_PARTY and website remains empty'
  );

  // Assertions for Obscure Place (Empty SERP)
  const obscureRecord = summary.records.find((r) => r.key.includes('obscure'))!;
  assert(
    obscureRecord.state === 'DISCOVERY_EXHAUSTED_NO_FIRST_PARTY' &&
      obscureRecord.selectedUrl === undefined &&
      obscurePlace.website === undefined,
    'T12.6',
    'Obscure place with empty search results yields DISCOVERY_EXHAUSTED_NO_FIRST_PARTY and website remains empty'
  );

  // --- 5. Relationship Classification & isContactEnrichable Hard Gate ---
  const edusanjalRel = classifyWebsiteRelationship(
    'https://edusanjal.com/school/prabhat-secondary-school',
    'Prabhat Secondary School'
  );
  assert(
    edusanjalRel.relationship === 'directory' && edusanjalRel.isContactEnrichable === false,
    'T12.7',
    'classifyWebsiteRelationship tags Edusanjal as "directory" with isContactEnrichable: false'
  );

  const collegesNepalRel = classifyWebsiteRelationship(
    'https://collegesnepal.com/school/prabhat-school',
    'Prabhat Secondary School'
  );
  assert(
    collegesNepalRel.relationship === 'directory' && collegesNepalRel.isContactEnrichable === false,
    'T12.8',
    'classifyWebsiteRelationship tags CollegesNepal as "directory" with isContactEnrichable: false'
  );

  const noshnepalRel = classifyWebsiteRelationship(
    'https://noshnepal.com/restaurant/himalayan-flavours',
    'Himalayan Flavours Cafe'
  );
  assert(
    noshnepalRel.relationship === 'service_platform' && noshnepalRel.isContactEnrichable === false,
    'T12.9',
    'classifyWebsiteRelationship tags NoshNepal as "service_platform" with isContactEnrichable: false'
  );

  // --- 6. isUsableOfficialWebsite Hard Gate Verification ---
  assert(
    isUsableOfficialWebsite('https://edusanjal.com/school/prabhat-secondary-school') === false &&
      isUsableOfficialWebsite('https://collegesnepal.com/school/prabhat-school') === false &&
      isUsableOfficialWebsite('https://noshnepal.com/restaurant/himalayan-flavours') === false,
    'T12.10',
    'isUsableOfficialWebsite directly rejects Edusanjal, CollegesNepal, and NoshNepal URLs'
  );

  // --- 7. Task 6 Verification: sanitizeListingWithEvidence Contamination Gate ---
  // A. Edusanjal directory evidence simulation
  const { candidates: schoolCandidates } = buildResearchCandidates([schoolPlace]);
  const schoolCandidate = schoolCandidates[0];

  const directoryEvidence: VerifiedBusinessEvidence = {
    candidate: schoolCandidate,
    websiteEvidence: {
      url: 'https://edusanjal.com/school/prabhat-secondary-school',
      domain: domainFromUrlOrHost('https://edusanjal.com/school/prabhat-secondary-school'),
      pages: [],
      favicon: '',
      extractedServices: [],
      extractedEmails: ['directory-admin@edusanjal.com', 'support@edusanjal.com'],
      extractedPhones: ['+977 1-4412345'],
      extractedMobiles: ['9800000000'],
      extractedSocialLinks: {
        facebook: 'https://facebook.com/edusanjal',
        instagram: '',
        tiktok: '',
        other: {},
      },
    },
    verification: {
      status: 'failed',
      overallConfidence: 0,
      checks: {
        websiteIsUsableOfficial: false,
        websiteDomainMatchesCandidate: false,
        businessNameFoundOnWebsite: false,
        phoneMatchesMaps: false,
        addressOrLocationFoundOnWebsite: false,
        emailFoundOnWebsite: false,
        socialLinksFoundOnWebsite: false,
      },
      notes: ['Directory page detected — not an official website.'],
    },
    websiteRelationship: edusanjalRel.relationship,
    websiteLifecycle: 'discovered',
  };

  const schoolInitialListing: BusinessListing = businessListingSchema.parse({
    name: 'Prabhat Secondary School',
    location: 'Patan, Lalitpur',
    phones: ['+977 1-5521234'],
    metadata: { source: 'google_maps', confidence: 0.5 },
  });

  const sanitizedSchoolListing = sanitizeListingWithEvidence(schoolInitialListing, directoryEvidence);

  assert(
    sanitizedSchoolListing.websites.length === 0,
    'T12.11',
    'sanitizeListingWithEvidence does NOT adopt directory URL into listing websites (0 website contamination)'
  );

  assert(
    !sanitizedSchoolListing.emails.includes('directory-admin@edusanjal.com') &&
      !sanitizedSchoolListing.emails.includes('support@edusanjal.com'),
    'T12.12',
    'sanitizeListingWithEvidence does NOT adopt directory emails into listing emails (0 email contamination)'
  );

  assert(
    !sanitizedSchoolListing.phones.includes('+977 1-4412345') &&
      !sanitizedSchoolListing.mobiles.includes('9800000000'),
    'T12.13',
    'sanitizeListingWithEvidence does NOT adopt directory phone numbers into listing contacts (0 phone contamination)'
  );

  // B. NoshNepal service platform evidence simulation
  const { candidates: restaurantCandidates } = buildResearchCandidates([restaurantPlace]);
  const restaurantCandidate = restaurantCandidates[0];

  const platformEvidence: VerifiedBusinessEvidence = {
    candidate: restaurantCandidate,
    websiteEvidence: {
      url: 'https://noshnepal.com/restaurant/himalayan-flavours',
      domain: domainFromUrlOrHost('https://noshnepal.com/restaurant/himalayan-flavours'),
      pages: [],
      favicon: '',
      extractedServices: [],
      extractedEmails: ['orders@noshnepal.com'],
      extractedPhones: ['+977 1-5599999'],
      extractedMobiles: [],
      extractedSocialLinks: { facebook: '', instagram: '', tiktok: '', other: {} },
    },
    verification: {
      status: 'failed',
      overallConfidence: 0,
      checks: {
        websiteIsUsableOfficial: false,
        websiteDomainMatchesCandidate: false,
        businessNameFoundOnWebsite: false,
        phoneMatchesMaps: false,
        addressOrLocationFoundOnWebsite: false,
        emailFoundOnWebsite: false,
        socialLinksFoundOnWebsite: false,
      },
      notes: ['Service platform profile detected.'],
    },
    websiteRelationship: noshnepalRel.relationship,
    websiteLifecycle: 'discovered',
  };

  const restaurantInitialListing: BusinessListing = businessListingSchema.parse({
    name: 'Himalayan Flavours Cafe',
    location: 'Jhamsikhel, Lalitpur',
    phones: ['+977 1-5545678'],
    metadata: { source: 'google_maps', confidence: 0.5 },
  });

  const sanitizedRestaurantListing = sanitizeListingWithEvidence(restaurantInitialListing, platformEvidence);

  assert(
    sanitizedRestaurantListing.websites.length === 0 &&
      !sanitizedRestaurantListing.emails.includes('orders@noshnepal.com') &&
      !sanitizedRestaurantListing.phones.includes('+977 1-5599999'),
    'T12.14',
    'sanitizeListingWithEvidence completely blocks service platform websites, emails, and phones (0 platform contamination)'
  );

  // --- 8. State Invariant Verification ---
  const invariantCheck = validateDiscoveryStateInvariant(summary.statesApplied, 3);
  assert(
    invariantCheck.valid === true && invariantCheck.sum === 3 && invariantCheck.delta === 0,
    'T12.15',
    'validateDiscoveryStateInvariant holds strictly across the negative batch (sum: 3, delta: 0)'
  );

  // --- 9. Stage 0 Artifact Envelope Persistence in Scratch Isolation ---
  const runId = startRunSession('Negative Directory Contamination Benchmark', 'Lalitpur', {
    outputRoot: TEST_OUTPUT_ROOT,
  });

  const counters = getDiscoveryTelemetryCounters(summary);
  const discoveryArtifact: WebsiteDiscoveryArtifact = {
    runId,
    generatedAt: new Date().toISOString(),
    counters,
    statesApplied: summary.statesApplied,
    records: summary.records,
  };

  saveStageOutput('website-discovery', '0-website-discovery.json', discoveryArtifact, 'Negative Directory Run', {
    outputRoot: TEST_OUTPUT_ROOT,
  });

  const persistedPath = path.join(TEST_OUTPUT_ROOT, '0-website-discovery.json');
  const historyPath = path.join(TEST_OUTPUT_ROOT, 'history', runId, '0-website-discovery.json');

  assert(
    fs.existsSync(persistedPath) && fs.existsSync(historyPath),
    'T12.16',
    'Negative batch 0-website-discovery.json artifact saved to test-isolated root mirror and history archive'
  );

  const persistedJson = JSON.parse(fs.readFileSync(persistedPath, 'utf-8')) as WebsiteDiscoveryArtifact;
  assert(
    persistedJson.counters.firstPartyFound === 0 &&
      persistedJson.counters.thirdPartyOnly === 2 &&
      persistedJson.counters.exhaustedNoFirstParty === 1 &&
      persistedJson.statesApplied.DISCOVERY_FOUND_ONLY_THIRD_PARTY === 2 &&
      persistedJson.statesApplied.DISCOVERY_EXHAUSTED_NO_FIRST_PARTY === 1,
    'T12.17',
    'Persisted 0-website-discovery.json validates exact negative counters (0 first party, 2 third party only, 1 exhausted)'
  );

  endRunSession();

  console.log('\n================================================================');
  console.log(`TOTAL TESTS: ${totalTests} | PASSED: ${passedTests} | FAILED: ${failedTests}`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runNegativeDirectoryContaminationTests().catch((err) => {
  console.error('Unexpected negative contamination test failure:', err);
  process.exit(1);
});
