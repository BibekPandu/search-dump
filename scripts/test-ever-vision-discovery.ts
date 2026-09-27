process.env.DISCOVERY_MODE = 'benchmark';

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  runWebsiteDiscoveryGate,
  getDiscoveryTelemetryCounters,
  type WebsiteDiscoveryArtifact,
  type DiscoveryLookupResult,
  type DiscoveryGateSummary,
} from '@/services/discovery/website-discovery-gate.service';
import {
  selectFirstPartyWebsiteUrl,
  distinctiveNameTokens,
} from '@/services/discovery/website-search-ranker.service';
import { isUsableOfficialWebsite } from '@/services/resolution/entity-resolution.service';
import { buildResearchCandidates } from '@/services/resolution/research-candidate.service';
import {
  buildVerifiedEvidence,
  verifyCandidateWebsite,
  keyOfCandidate,
} from '@/services/resolution/verification.service';
import type {
  WebsitePageEvidence,
  VerifiedBusinessEvidence,
} from '@/mastra/agents/research-agent/verification.schema';
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

// ============================================================================
// Phase 7b Task 11 — Ever Vision School Discovery Acceptance Test (OFFLINE)
// ============================================================================
// Acceptance criteria verified here:
//   1. process.env.DISCOVERY_MODE = 'benchmark' set at module load
//   2. Test-isolated scratch directory (outputRoot) ensures clean isolation
//   3. Maps place without website simulated (Ever Vision School, Satungal)
//   4. Discovery Gate runs against SERP with Edusanjal + evervision.edu.np
//   5. evervision.edu.np selected as DISCOVERY_FOUND_FIRST_PARTY
//   6. candidateUrlsReviewed contains both URLs, capped at 20
//   7. selectionReason populated (score, tokens, non-empty)
//   8. verifyCandidateWebsite runs (single path, Task 7 verification)
//   9. sanitizeListingWithEvidence attaches official website and enriches contacts
//  10. discoveryProvenance survives intact in listing.otherDetails + Stage 0 envelope
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

const TEST_OUTPUT_ROOT = path.join(os.tmpdir(), `ever-vision-discovery-${Date.now()}`);

function cleanupTempDir() {
  try {
    if (fs.existsSync(TEST_OUTPUT_ROOT)) {
      fs.rmSync(TEST_OUTPUT_ROOT, { recursive: true, force: true });
    }
  } catch {}
}

process.on('exit', cleanupTempDir);

async function runEverVisionDiscoveryAcceptanceTests() {
  console.log('================================================================');
  console.log('🧪 TASK 11: EVER VISION DISCOVERY ACCEPTANCE TEST SUITE (10 CRITERIA, 15 ASSERTIONS)');
  console.log('================================================================\n');

  // Criterion 1: Benchmark mode set at module load
  assert(
    process.env.DISCOVERY_MODE === 'benchmark',
    'T11.1',
    'process.env.DISCOVERY_MODE is strictly set to "benchmark" at module load'
  );

  // Criterion 2: Test-isolated scratch directory exists and is cleanly separated
  fs.mkdirSync(TEST_OUTPUT_ROOT, { recursive: true });
  assert(
    fs.existsSync(TEST_OUTPUT_ROOT) && !TEST_OUTPUT_ROOT.includes('searchDump/output'),
    'T11.2',
    `Test-isolated scratch directory created outside live output (${TEST_OUTPUT_ROOT})`
  );

  // Criterion 3: Maps place without website simulated (Ever Vision School in Satungal)
  const everVisionPlace: SerperPlaceResult = {
    position: 1,
    title: 'Ever Vision School',
    address: 'Ward 10, Satungal, Chandragiri, Kathmandu 44600',
    category: 'School',
    phoneNumber: '+977 1-4310567',
    placeId: 'ChIJ_ever_vision_satungal_001',
    rating: 4.6,
    ratingCount: 85,
    website: undefined, // Simulating Maps candidate with NO website
  };

  assert(
    everVisionPlace.website === undefined && everVisionPlace.phoneNumber === '+977 1-4310567',
    'T11.3',
    'Simulated Maps place lacks website and carries canonical phone and address'
  );

  // Criterion 4: Discovery Gate runs against SERP containing Edusanjal and evervision.edu.np
  const serpResults = [
    {
      title: 'Ever Vision School - Satungal, Kathmandu | Edusanjal',
      url: 'https://edusanjal.com/school/ever-vision-school',
      snippet: 'Ever Vision School is a private educational institution located in Satungal, Kathmandu.',
    },
    {
      title: 'Ever Vision School - Official Website',
      url: 'https://evervision.edu.np',
      snippet: 'Welcome to Ever Vision School, Satungal, Kathmandu. Excellence in education. Phone: 01-4310567.',
    },
  ];

  let lookupCallCount = 0;
  const summary: DiscoveryGateSummary = await runWebsiteDiscoveryGate({
    places: [everVisionPlace],
    lookupBudget: 50,
    lookup: async (place): Promise<DiscoveryLookupResult> => {
      lookupCallCount++;
      return {
        queries: [`${place.title} Satungal Kathmandu`],
        results: serpResults,
      };
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

  assert(
    lookupCallCount === 1 && summary.groupsLookedUp === 1,
    'T11.4',
    'Discovery Gate evaluated Ever Vision against SERP containing Edusanjal and evervision.edu.np'
  );

  // Criterion 5: evervision.edu.np selected as DISCOVERY_FOUND_FIRST_PARTY
  const groupRecord = summary.records[0];
  assert(
    groupRecord.state === 'DISCOVERY_FOUND_FIRST_PARTY' &&
      groupRecord.selectedUrl === 'https://evervision.edu.np' &&
      everVisionPlace.website === 'https://evervision.edu.np' &&
      everVisionPlace.discoveryState === 'DISCOVERY_FOUND_FIRST_PARTY',
    'T11.5',
    'evervision.edu.np selected as DISCOVERY_FOUND_FIRST_PARTY (Edusanjal directory rejected)'
  );

  // Criterion 6: candidateUrlsReviewed contains both URLs, capped at 20
  const bothUrlsPresent =
    groupRecord.candidateUrlsReviewed.includes('https://edusanjal.com/school/ever-vision-school') &&
    groupRecord.candidateUrlsReviewed.includes('https://evervision.edu.np');

  // Also test 25-URL cap enforcement
  const synthetic25 = Array.from({ length: 25 }, (_, i) => ({
    url: `https://example${i}.com/school`,
  }));
  const placeForCap: SerperPlaceResult = {
    position: 2,
    title: 'Cap Test School',
    address: 'Satungal',
    placeId: 'place_cap_test',
  };
  const capSummary = await runWebsiteDiscoveryGate({
    places: [placeForCap],
    lookupBudget: 50,
    lookup: async () => ({
      queries: ['Cap Test School'],
      results: synthetic25,
    }),
    selectFirstPartyUrl: () => undefined,
  });
  const capRecord = capSummary.records[0];

  assert(
    bothUrlsPresent &&
      groupRecord.candidateUrlsReviewed.length === 2 &&
      capRecord.candidateUrlsReviewed.length === 20,
    'T11.6',
    'candidateUrlsReviewed records both URLs reviewed and strictly caps at 20 (25 inputs -> 20 recorded)'
  );

  // Criterion 7: selectionReason populated
  const nameTokens = distinctiveNameTokens('Ever Vision School');
  assert(
    nameTokens.includes('ever') && nameTokens.includes('vision') && !nameTokens.includes('school'),
    'T11.7a',
    'distinctiveNameTokens correctly extracts [ever, vision] (school is industry-generic)'
  );

  assert(
    typeof groupRecord.selectionReason === 'string' &&
      groupRecord.selectionReason.length > 0 &&
      groupRecord.selectionReason.includes('evervision.edu.np') &&
      groupRecord.selectionReason.includes('tokens'),
    'T11.7b',
    `selectionReason populated with token/score justification: "${groupRecord.selectionReason}"`
  );

  // Criterion 8: verifyCandidateWebsite runs (single path, Task 7's verification)
  // Maps place is transformed to ResearchCandidate via canonical buildResearchCandidates
  const { candidates } = buildResearchCandidates([everVisionPlace]);
  const candidate = candidates[0];

  assert(
    candidate.website === 'https://evervision.edu.np/' &&
      candidate.discoveryState === 'DISCOVERY_FOUND_FIRST_PARTY' &&
      Boolean(candidate.discoveryProvenance),
    'T11.8a',
    'buildResearchCandidates seeds discovered website and discoveryProvenance onto candidate'
  );

  // Simulate extracted website evidence for Ever Vision
  const pages: WebsitePageEvidence[] = [
    {
      url: 'https://evervision.edu.np',
      content:
        'Welcome to Ever Vision School in Satungal, Kathmandu. Providing quality education since 2000. ' +
        'Contact: info@evervision.edu.np, Phone: 01-4310567, Mobile: 9851012345.',
      favicon: 'https://evervision.edu.np/favicon.ico',
      success: true,
      discoverySource: 'homepage',
      pageType: 'home',
    },
    {
      url: 'https://evervision.edu.np/contact',
      content:
        'Contact Ever Vision School. Address: Ward 10, Satungal, Kathmandu. ' +
        'Official Email: info@evervision.edu.np. Landline: 01-4310567.',
      favicon: 'https://evervision.edu.np/favicon.ico',
      success: true,
      discoverySource: 'internal_link',
      pageType: 'contact',
    },
  ];

  const extractionsMap = new Map<string, WebsitePageEvidence[]>();
  extractionsMap.set(keyOfCandidate(candidate), pages);

  // Single verification path via buildVerifiedEvidence -> verifyCandidateWebsite
  const evidenceList: VerifiedBusinessEvidence[] = buildVerifiedEvidence(candidates, extractionsMap);
  const evidence = evidenceList[0];

  assert(
    evidence.websiteRelationship === 'first_party' &&
      (evidence.verification.status === 'verified' || evidence.verification.status === 'partial') &&
      evidence.verification.checks.websiteDomainMatchesCandidate === true &&
      evidence.verification.checks.businessNameFoundOnWebsite === true &&
      evidence.verification.checks.phoneMatchesMaps === true,
    'T11.8b',
    `verifyCandidateWebsite (single path, Task 7) verifies discovered domain: status=${evidence.verification.status}, relationship=${evidence.websiteRelationship}`
  );

  // Assert direct invocation of verifyCandidateWebsite confirms zero-divergence contract
  const directVerification = verifyCandidateWebsite(candidate, evidence.websiteEvidence);
  assert(
    directVerification.status === 'verified' &&
      directVerification.checks.websiteDomainMatchesCandidate === true &&
      directVerification.checks.businessNameFoundOnWebsite === true &&
      directVerification.checks.phoneMatchesMaps === true,
    'T11.8c',
    'verifyCandidateWebsite() directly confirms single-path identity verification (Task 7)'
  );

  // Criterion 9: sanitizeListingWithEvidence attaches website and enriches contacts
  const initialListing: BusinessListing = businessListingSchema.parse({
    name: 'Ever Vision School',
    location: 'Satungal, Kathmandu',
    metadata: { source: 'google_maps', confidence: 0.5 },
  });

  const enrichedListing: BusinessListing = sanitizeListingWithEvidence(initialListing, evidence);

  assert(
    enrichedListing.websites.includes('https://evervision.edu.np/') &&
      enrichedListing.phones.includes('+977-01-4310567') &&
      enrichedListing.emails.includes('info@evervision.edu.np') &&
      enrichedListing.mobiles.includes('+977-985-1012345'),
    'T11.9',
    'sanitizeListingWithEvidence attaches discovered website and enriches phone, mobile, and email contacts'
  );

  // Criterion 10: discoveryProvenance survives in listing.otherDetails + Stage 0 envelope persistence
  const prov = enrichedListing.otherDetails?.discoveryProvenance;
  assert(
    enrichedListing.otherDetails?.discoveryState === 'DISCOVERY_FOUND_FIRST_PARTY' &&
      prov !== undefined &&
      prov.queries[0] === 'Ever Vision School Satungal Kathmandu' &&
      prov.selectedUrl === 'https://evervision.edu.np' &&
      prov.selectionReason === groupRecord.selectionReason &&
      prov.candidateUrlsReviewed.includes('https://evervision.edu.np'),
    'T11.10a',
    'discoveryProvenance survives end-to-end in listing.otherDetails with all attributes intact'
  );

  // Test Stage 0 Artifact envelope persistence into test-isolated scratch directory
  const runId = startRunSession('Schools in Satungal, Kathmandu', 'Kathmandu', {
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

  saveStageOutput('website-discovery', '0-website-discovery.json', discoveryArtifact, 'Schools in Satungal', {
    outputRoot: TEST_OUTPUT_ROOT,
  });

  const persistedPath = path.join(TEST_OUTPUT_ROOT, '0-website-discovery.json');
  const historyPath = path.join(TEST_OUTPUT_ROOT, 'history', runId, '0-website-discovery.json');
  assert(
    fs.existsSync(persistedPath) && fs.existsSync(historyPath),
    'T11.10b',
    'Stage 0 discovery artifact envelope (0-website-discovery.json) persisted to isolated scratch root and history archive'
  );

  const persistedJson = JSON.parse(fs.readFileSync(persistedPath, 'utf-8')) as WebsiteDiscoveryArtifact;
  assert(
    persistedJson.counters.firstPartyFound === 1 &&
      persistedJson.statesApplied.DISCOVERY_FOUND_FIRST_PARTY === 1 &&
      persistedJson.records[0].selectedUrl === 'https://evervision.edu.np',
    'T11.10c',
    'Persisted 0-website-discovery.json validates full provenance and counters matching in-memory execution'
  );

  endRunSession();

  console.log('\n================================================================');
  console.log(`TOTAL TESTS: ${totalTests} | PASSED: ${passedTests} | FAILED: ${failedTests}`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runEverVisionDiscoveryAcceptanceTests().catch((err) => {
  console.error('Unexpected test failure:', err);
  process.exit(1);
});
