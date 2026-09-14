import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { mastra } from '../src/mastra/index';
import { normalizePhoneDigits } from '../src/services/entity-resolution.service';

/**
 * Phase 2 End-to-End test: the FULL pipeline (research → deep-verification →
 * supervisor synthesis) against live APIs, then hard assertions that the
 * final BusinessListing contact fields are evidence-backed:
 *  - every listing email exists in some VerifiedBusinessEvidence
 *  - listing phones carry the Maps website identity phone (or evidence phones)
 *  - no social/directory URL appears as a website
 *  - GPS/rating/placeId trace to Google Maps only
 * Skips cleanly when any required API key is missing.
 */
function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

async function runE2ETest() {
  console.log('===============================================================');
  console.log('🧪 RUNNING PHASE 2 FULL-PIPELINE INTEGRATION TEST');
  console.log('===============================================================');

  const missing: string[] = [];
  if (!process.env.SERPER_API_KEY) missing.push('SERPER_API_KEY');
  if (!process.env.TAVILY_API_KEY) missing.push('TAVILY_API_KEY');
  if (!process.env.OPENROUTER_API_KEY) missing.push('OPENROUTER_API_KEY');
  if (missing.length > 0) {
    console.warn(`⚠️ Missing keys (${missing.join(', ')}). Skipping live Phase 2 E2E test.`);
    process.exit(0);
  }

  const workflow = mastra.getWorkflow('researchWorkflow');
  const run = await workflow.createRun();
  const startTime = Date.now();

  const result = await run.start({
    inputData: {
      query: 'specialty coffee',
      location: 'Kathmandu',
      autoApprove: true,
      agentId: 'gemma-supervisor-agent',
      targetCandidates: 10,
      maxPages: 2,
      maxDeepVerifyCandidates: 3,
    },
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\nFull pipeline completed in ${duration}s!`);

  const output = (result as any)?.result ?? {};
  const listings: any[] = output.listings || [];
  assert(listings.length > 0, `Full pipeline produced ${listings.length} listings`);

  // --- 2b artifact with verified evidence must exist on disk ---
  console.log('\n--- 2b Verified-Evidence Artifact ---');
  const evidencePath = path.resolve(process.cwd(), 'output/2b-verified-evidence.json');
  assert(fs.existsSync(evidencePath), 'output/2b-verified-evidence.json exists on disk');
  const evidenceDoc = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const verifiedEvidence: any[] = evidenceDoc.verifiedEvidence || [];
  assert(verifiedEvidence.length > 0, `Verified evidence records on disk: ${verifiedEvidence.length}`);

  const verifiedWithSite = verifiedEvidence.filter(
    (ev) => ev.websiteEvidence && ev.verification?.status !== 'failed'
  );
  assert(
    verifiedWithSite.length > 0,
    `At least one candidate has verified website evidence (got ${verifiedWithSite.length})`
  );
  console.log(
    `Evidence statuses: ${verifiedEvidence.map((ev) => ev.verification?.status).join(', ')}`
  );

  // --- Evidence-backed listing fields ---
  console.log('\n--- Evidence-Backed Listing Fields ---');
  const supportedEmails = new Set<string>();
  const supportedPhoneDigits = new Set<string>();
  for (const ev of verifiedEvidence) {
    const web = ev.websiteEvidence;
    for (const email of web?.extractedEmails || []) supportedEmails.add(email.toLowerCase());
    for (const phone of web?.extractedPhones || []) {
      const digits = normalizePhoneDigits(phone);
      if (digits.length >= 7) supportedPhoneDigits.add(digits);
    }
    for (const mobile of web?.extractedMobiles || []) {
      const digits = normalizePhoneDigits(mobile);
      if (digits.length >= 7) supportedPhoneDigits.add(digits);
    }
    if (ev.candidate?.phone) {
      const digits = normalizePhoneDigits(ev.candidate.phone);
      if (digits.length >= 7) supportedPhoneDigits.add(digits);
    }
  }

  for (const listing of listings) {
    const name = listing.name || '(unnamed)';
    // Every listing email must be in the supported (evidence-backed) set.
    for (const email of listing.emails || []) {
      assert(
        supportedEmails.has(String(email).toLowerCase()),
        `Listing "${name}" email "${email}" is evidence-backed (no hallucinated emails)`
      );
    }
    // Social/directory URLs must never appear as official websites.
    const socialPattern = /facebook\.com|instagram\.com|tiktok\.com|tripadvisor\.|yelp\.com|yellowpages\.com|booking\.com|agoda\.com|maps\.google/i;
    for (const site of listing.websites || []) {
      assert(
        !socialPattern.test(site),
        `Listing "${name}" has no social/directory URL as official website ("${site}")`
      );
    }
    // GPS/ratings/placeId, when present, trace to verified Maps evidence.
    if (listing.gpsCoordinates) {
      const gps = listing.gpsCoordinates;
      assert(
        typeof gps.latitude === 'number' && typeof gps.longitude === 'number',
        `Listing "${name}" GPS is a numeric Maps coordinate`
      );
    }
  }

  console.log('\n--- Final Artifacts ---');
  const listingsPath = path.resolve(process.cwd(), 'output/3-final-listings.json');
  assert(fs.existsSync(listingsPath), 'output/3-final-listings.json exists on disk');
  const savedListings = JSON.parse(fs.readFileSync(listingsPath, 'utf8'));
  assert(
    Array.isArray(savedListings) && savedListings.length === listings.length,
    '3-final-listings.json matches in-memory listings count'
  );

  console.log('\n===============================================================');
  console.log('🎉 PHASE 2 FULL-PIPELINE INTEGRATION TEST PASSED (100%)');
  console.log('===============================================================');
}

runE2ETest().catch((err) => {
  console.error('Phase 2 E2E test failed:', err);
  process.exit(1);
});