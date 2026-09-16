import { businessListingSchema } from '../src/mastra/workflows/research-workflow';

// ============================================================================
// ASSERTION HELPERS (Placed at top of file)
// ============================================================================

let passed = 0;
let failed = 0;

function assertBool(name: string, value: boolean) {
  if (!value) {
    console.error(`❌ FAIL: ${name}`);
    failed++;
    process.exit(1);
  }
  console.log(`✅ PASS: ${name}`);
  passed++;
}

console.log('================================================================');
console.log('🧪 TASK 2: PROVENANCE INTEGRITY & LIVE TIMESTAMPS TESTS (8 CASES)');
console.log('================================================================\n');

// ============================================================================
// T1: Live recent timestamp verification
// ============================================================================
const listing1 = businessListingSchema.parse({
  name: 'Test Business 1',
  metadata: {
    source: 'google_maps',
    extractedAt: new Date().toISOString(),
    confidence: 0,
  },
});
const diff = Math.abs(Date.now() - new Date(listing1.metadata!.extractedAt).getTime());
assertBool('T1: extractedAt is recent (< 5000ms delta)', diff < 5000);

// ============================================================================
// T2: Deterministic lazy default validation
// (Proves that the field-level default fires at parse time, not module load)
// ============================================================================
const beforeParse = Date.now();
const listing2 = businessListingSchema.parse({
  name: 'Test Business 2',
  metadata: { source: 'web', confidence: 0 }, // no extractedAt -> lazy default fires
});
const parsedAt = new Date(listing2.metadata!.extractedAt).getTime();
assertBool('T2: lazy default fires at parse time (parsedAt >= beforeParse)', parsedAt >= beforeParse);

// ============================================================================
// T3: extractedAt is valid ISO-8601
// ============================================================================
assertBool(
  'T3: extractedAt is valid ISO-8601',
  !isNaN(new Date(listing1.metadata!.extractedAt).getTime())
);

// ============================================================================
// T4: runStartedAt is valid ISO-8601 (when present)
// ============================================================================
const listing3 = businessListingSchema.parse({
  name: 'Test Business 3',
  metadata: {
    source: 'google_maps',
    extractedAt: new Date().toISOString(),
    runStartedAt: new Date().toISOString(),
    confidence: 0,
  },
});
assertBool(
  'T4: runStartedAt is valid ISO-8601',
  !isNaN(new Date(listing3.metadata!.runStartedAt!).getTime())
);

// ============================================================================
// T5: Year floor check (no stale 2025 leak, year >= 2026)
// ============================================================================
for (const l of [listing1, listing2, listing3]) {
  const year = new Date(l.metadata!.extractedAt).getFullYear();
  assertBool(`T5: no 2025 leak in ${l.name} (year ${year} >= 2026)`, year >= 2026);
}

// ============================================================================
// T6: Schema rejects missing metadata (no silent static default fallback)
// Previously the object-level .default() would silently replace with
// a stale module-load timestamp. After removal, omitting metadata throws.
// ============================================================================
try {
  (businessListingSchema.parse as any)({ name: 'No Metadata Listing' });
  console.error('❌ FAIL: T6 — schema silently accepted missing metadata');
  process.exit(1);
} catch {
  console.log('✅ PASS: T6 — schema rejects missing metadata (static default removed)');
  passed++;
}

// ============================================================================
// T7: ISO-8601 date parseability and formatting consistency
// ============================================================================
function isValidISO(ts: string): boolean {
  const d = new Date(ts);
  return !isNaN(d.getTime()) && ts.includes('T') && (ts.endsWith('Z') || ts.includes('+'));
}

assertBool('T7: listing1 extractedAt valid ISO format', isValidISO(listing1.metadata!.extractedAt));
assertBool('T7: listing3 runStartedAt valid ISO format', isValidISO(listing3.metadata!.runStartedAt!));

// ============================================================================
// T8: Dynamic timestamp freshness check
// ============================================================================
const listing4 = businessListingSchema.parse({
  name: 'Test Business 4',
  metadata: {
    source: 'google_maps',
    extractedAt: new Date().toISOString(),
    confidence: 0,
  },
});
const extractedTime = new Date(listing4.metadata!.extractedAt).getTime();
assertBool('T8: extractedAt timestamp is not in the future', extractedTime <= Date.now() + 100);

// ============================================================================
// SUMMARY
// ============================================================================
console.log('\n================================================================');
console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
}
