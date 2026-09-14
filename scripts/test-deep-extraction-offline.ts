import fs from 'fs';
import path from 'path';
import { deepExtractionStep } from '../src/mastra/workflows/research-workflow';
import type { ResearchCandidate } from '../src/mastra/agents/research-agent/schema';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

/**
 * OFFLINE workflow test: deepExtractionStep with website-less candidates.
 * With no usable websites there are ZERO network calls (no Tavily, no page
 * fetch) — every candidate must get a deterministic placeholder record.
 */
function websiteLess(): ResearchCandidate {
  return {
    name: 'Thamel Street Momo Corner',
    location: 'Thamel, Kathmandu',
    website: '',
    phone: '01-4441111',
    coordinates: { lat: 27.7149, lng: 85.3123 },
    rating: 4.2,
    ratingCount: 55,
    category: 'Fast Food',
    sources: {
      googleMaps: {
        found: true,
        placeId: 'ChIJ-offline1',
        address: 'Thamel, Kathmandu',
        phone: '01-4441111',
        website: '',
      },
      webSearch: [],
    },
    entityMatch: { matched: false, confidence: 0, method: 'none' },
    classification: { status: 'usable', type: 'business', confidence: 0.9, reason: 'Maps' },
  };
}

async function runTests() {
  console.log('===============================================================');
  console.log('🧪 DEEP-EXTRACTION OFFLINE WORKFLOW TEST (ZERO NETWORK)');
  console.log('===============================================================');

  const researchCandidates = [websiteLess(), { ...websiteLess(), name: 'Pokhara Lakeside Tea House' }];
  const result = (await deepExtractionStep.execute({
    inputData: {
      candidates: [],
      researchCandidates,
      query: 'momo corner',
      autoApprove: true,
      maxDeepVerifyCandidates: 3,
    },
  } as any)) as any;

  // 1. One VerifiedBusinessEvidence per candidate — no exceptions.
  assert(
    result.verifiedEvidence.length === researchCandidates.length,
    `verifiedEvidence.length (${result.verifiedEvidence.length}) === candidates (${researchCandidates.length})`
  );

  // 2. All placeholders are failed/no-website (0 Tavily cost).
  for (const ev of result.verifiedEvidence) {
    assert(ev.verification.status === 'failed', `"${ev.candidate.name}" status failed (no usable website)`);
    assert(ev.websiteEvidence === undefined, `"${ev.candidate.name}" has no WebsiteEvidence`);
    assert(
      ev.verification.notes.some((n: string) => n.toLowerCase().includes('no usable official website')),
      `"${ev.candidate.name}" note explains missing website`
    );
  }

  // 3. No raw extractions were needed; flattened list still present for compat.
  assert(Array.isArray(result.extractions), 'extractions array present (backward-compatible)');
  assert(result.extractions.length === 0, 'No page extractions attempted for website-less candidates');

  // 4. The 2b artifact is always saved (even when empty of evidence).
  const evidencePath = path.resolve(process.cwd(), 'output/2b-verified-evidence.json');
  assert(fs.existsSync(evidencePath), 'output/2b-verified-evidence.json exists on disk');
  const saved = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  assert(
    Array.isArray(saved.verifiedEvidence) && saved.verifiedEvidence.length === researchCandidates.length,
    '2b artifact contains the full placeholder records'
  );

  console.log('\n===============================================================');
  console.log('🎉 DEEP-EXTRACTION OFFLINE WORKFLOW TEST PASSED (100%)');
  console.log('===============================================================');
}

runTests().catch((err) => {
  console.error('Deep-extraction offline test failed:', err);
  process.exit(1);
});