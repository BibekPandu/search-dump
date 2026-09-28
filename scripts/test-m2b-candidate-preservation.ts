import assert from 'node:assert';
import { applyTargetCandidatesCap, ledgerStatusEnum, type LedgerStatus, buildFallbackListing } from '@/mastra/workflows/research-workflow.js';

console.log('=== Running M2B Candidate Preservation and Ledger Invariant Tests ===\n');

// 1. Build test candidates: 15 Maps + 6 Web candidates
const mapsCandidates = Array.from({ length: 15 }, (_, i) => ({
  title: `Maps Consultancy ${i + 1}`,
  url: `https://mapsconsultancy${i + 1}.com.np`,
  domain: `mapsconsultancy${i + 1}.com.np`,
  source: 'google_maps' as const,
  phoneNumber: `+977-1-42000${i < 10 ? '0' + i : i}`,
  address: `Putalisadak, Kathmandu`,
  latitude: 27.7055,
  longitude: 85.3234,
}));

const webCandidates = Array.from({ length: 6 }, (_, i) => ({
  title: `Web Consultancy ${i + 1}`,
  url: `https://webconsultancy${i + 1}.edu.np`,
  domain: `webconsultancy${i + 1}.edu.np`,
  source: 'web_search' as const,
  address: `Putalisadak, Kathmandu`,
}));

const allCandidates = [...mapsCandidates, ...webCandidates];
assert.strictEqual(allCandidates.length, 21, 'Should have 21 total candidates (15 Maps + 6 Web)');

// 2. Validate fallback listing retention for web candidate
const webCandidate = {
  title: 'Web Consultancy Test',
  url: 'https://webconsultancytest.edu.np',
  domain: 'webconsultancytest.edu.np',
  source: 'web_search' as const,
  address: 'Putalisadak, Kathmandu',
  phoneNumber: '',
};

const fallbackResult = buildFallbackListing(webCandidate as any, [], undefined, 'Putalisadak, Kathmandu');

assert(
  fallbackResult.websites?.includes('https://webconsultancytest.edu.np'),
  `buildFallbackListing must retain web candidate URL. Got: ${JSON.stringify(fallbackResult.websites)}`
);

const isActionable = Boolean(
  (fallbackResult.phones && fallbackResult.phones.length > 0) ||
  (fallbackResult.mobiles && fallbackResult.mobiles.length > 0) ||
  (fallbackResult.emails && fallbackResult.emails.length > 0) ||
  (fallbackResult.websites && fallbackResult.websites.length > 0)
);
assert.strictEqual(isActionable, true, 'buildFallbackListing result must be actionable (website counts)');

// 3. Test Quality-Sorted Capping with targets 10, 20, and 30
const dummyListings = allCandidates.map((c, idx) => ({
  name: c.title,
  location: c.address,
  phones: 'phoneNumber' in c && c.phoneNumber ? [c.phoneNumber] : [],
  mobiles: [],
  websites: [c.url],
  emails: idx % 2 === 0 ? [`info@${c.domain}`] : [],
  metadata: {
    source: c.source,
    confidence: idx < 15 ? 0.8 : 0.65,
  },
}));

const capped10 = applyTargetCandidatesCap(dummyListings as any, 10);
assert.strictEqual(capped10.length, 10, 'Target 10 should cap to exactly 10 listings');

const capped20 = applyTargetCandidatesCap(dummyListings as any, 20);
assert.strictEqual(capped20.length, 20, 'Target 20 should cap to exactly 20 listings');

const capped30 = applyTargetCandidatesCap(dummyListings as any, 30);
assert.strictEqual(capped30.length, 21, 'Target 30 should keep all 21 available listings without shortfall fabrication');

// 4. Test Ledger Status Enum completeness
const validStatuses: LedgerStatus[] = [
  'persisted',
  'synthesis_omission',
  'verification_failed',
  'zero_actionable_fields',
  'geography_rejected',
  'provider_exhausted',
  'deduplicated',
  'category_rejected',
  'budget_skipped',
];

for (const s of validStatuses) {
  const parsed = ledgerStatusEnum.safeParse(s);
  assert(parsed.success, `LedgerStatus '${s}' must be valid in ledgerStatusEnum`);
}

console.log('M2B candidate preservation tests passed.\n');
