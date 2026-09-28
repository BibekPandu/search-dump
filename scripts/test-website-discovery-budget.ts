import {
  resolveWebsiteDiscoveryBudget,
  resolveWebsiteDiscoveryMode,
  formatWebsiteDiscoveryBudgetLog,
  PRODUCTION_DEFAULT_WEBSITE_DISCOVERY_LOOKUPS,
  ABSOLUTE_MAX_WEBSITE_DISCOVERY_LOOKUPS,
} from '@/config/website-discovery.config';
import { rankWebsiteLookupTargets } from '@/services/resolution/entity-resolution.service';
import type { SerperPlaceResult } from '@/services/external/serper-places.service';

// ============================================================================
// Phase 7a Task 2 — Website Discovery Budget Policy (OFFLINE, ZERO API)
// ============================================================================
// Verifies the acceptance criteria from the Phase 7a plan:
//   [ ] No hard-coded 3 remains as the architectural limit
//   [ ] Lookup budget is configurable (mode + explicit cap + env)
//   [ ] Existing cost controls still work (hard ceiling, eligible clamp)
//   [ ] targetCandidates and the website lookup budget are independent
//   [ ] Budget-skipped candidates are reported (no silent truncation)
// Deterministic by construction: every call injects `env`, so the host
// machine's DISCOVERY_MODE can never change the outcome.

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

function makePlace(id: string, overrides: Partial<SerperPlaceResult> = {}): SerperPlaceResult {
  return {
    position: 1,
    title: `Place ${id}`,
    address: 'Satungal, Kathmandu',
    rating: 4.5,
    ratingCount: 100,
    category: 'School',
    phoneNumber: '014310000',
    placeId: id,
    ...overrides,
  };
}

function runTests() {
  console.log('===============================================================');
  console.log('🧪 WEBSITE DISCOVERY BUDGET POLICY TESTS (ZERO API)');
  console.log('===============================================================\n');

  // --- 1. Production default = 10 per run (per run, not per candidate) ---
  console.log('--- 1. Production default is 10 per run ---');
  const b1 = resolveWebsiteDiscoveryBudget({ eligibleCount: 25, env: {} });
  assert(b1.mode === 'production', 'Unspecified mode defaults to production');
  assert(
    b1.lookupBudget === PRODUCTION_DEFAULT_WEBSITE_DISCOVERY_LOOKUPS,
    `Default production budget is ${PRODUCTION_DEFAULT_WEBSITE_DISCOVERY_LOOKUPS} per run (got ${b1.lookupBudget})`
  );
  assert(b1.ceiling === ABSOLUTE_MAX_WEBSITE_DISCOVERY_LOOKUPS, 'Hard ceiling reported as 50');

  // --- 2. Benchmark mode covers ALL eligible candidates ---
  console.log('\n--- 2. Benchmark mode covers all eligible ---');
  const b2 = resolveWebsiteDiscoveryBudget({ eligibleCount: 25, mode: 'benchmark', env: {} });
  assert(b2.mode === 'benchmark', 'Explicit benchmark mode honoured');
  assert(b2.lookupBudget === 25, `Benchmark covers all 25 eligible (got ${b2.lookupBudget})`);

  // --- 3. Benchmark is still hard-capped per run ---
  console.log('\n--- 3. Benchmark obeys the 50 per-run ceiling ---');
  const b3 = resolveWebsiteDiscoveryBudget({ eligibleCount: 80, mode: 'benchmark', env: {} });
  assert(
    b3.lookupBudget === ABSOLUTE_MAX_WEBSITE_DISCOVERY_LOOKUPS,
    `Benchmark clamped to 50 when 80 are eligible (got ${b3.lookupBudget})`
  );

  // --- 4. Env-driven mode + input precedence over env ---
  console.log('\n--- 4. DISCOVERY_MODE env + precedence ---');
  const b4 = resolveWebsiteDiscoveryBudget({
    eligibleCount: 25,
    env: { DISCOVERY_MODE: 'benchmark' },
  });
  assert(
    b4.mode === 'benchmark' && b4.lookupBudget === 25,
    'Env DISCOVERY_MODE=benchmark covers all eligible'
  );

  const b5 = resolveWebsiteDiscoveryBudget({
    eligibleCount: 25,
    mode: 'production',
    env: { DISCOVERY_MODE: 'benchmark' },
  });
  assert(
    b5.mode === 'production' && b5.lookupBudget === 10,
    'Explicit input mode overrides env DISCOVERY_MODE'
  );

  const modeResolution = resolveWebsiteDiscoveryMode('BENCHMARK', {});
  assert(modeResolution.mode === 'benchmark', 'Mode resolution is case-insensitive');

  // --- 5. Invalid mode/values degrade deterministically, never throw ---
  console.log('\n--- 5. Invalid inputs degrade deterministically ---');
  const b6 = resolveWebsiteDiscoveryBudget({ eligibleCount: 25, mode: 'turbo', env: {} });
  assert(b6.mode === 'production' && b6.lookupBudget === 10, 'Invalid mode degrades to production');
  assert(b6.reason.includes('ignored invalid mode'), 'Invalid mode is reported in the budget reason');

  const b7 = resolveWebsiteDiscoveryBudget({ eligibleCount: 25, explicitCap: Number.NaN, env: {} });
  assert(
    b7.lookupBudget === 10 && b7.usedExplicitCap === false,
    'NaN explicit cap ignored — mode default retained'
  );
  assert(b7.reason.includes('ignored invalid explicit cap'), 'Invalid cap is reported');

  const b8 = resolveWebsiteDiscoveryBudget({ eligibleCount: 25, explicitCap: -5, env: {} });
  assert(b8.lookupBudget === 10, 'Negative explicit cap cannot reduce the budget');

  // --- 6. Explicit cap precedence + clamping by ceiling and eligible count ---
  console.log('\n--- 6. Explicit cap precedence and clamping ---');
  const b9 = resolveWebsiteDiscoveryBudget({ eligibleCount: 25, explicitCap: 25, env: {} });
  assert(b9.lookupBudget === 25 && b9.usedExplicitCap === true, 'Explicit cap 25 accepted (eligible 25)');

  const b10 = resolveWebsiteDiscoveryBudget({ eligibleCount: 80, explicitCap: 120, env: {} });
  assert(b10.lookupBudget === 50, 'Explicit cap 120 clamped to hard ceiling 50 (80 eligible)');
  assert(b10.reason.includes('clamped to hard ceiling'), 'Ceiling clamp is reported in the reason');

  const b10b = resolveWebsiteDiscoveryBudget({ eligibleCount: 25, explicitCap: 120, env: {} });
  assert(b10b.lookupBudget === 25, 'Explicit cap can never exceed the eligible candidate count (25)');

  const b10c = resolveWebsiteDiscoveryBudget({ eligibleCount: 25, explicitCap: 0, env: {} });
  assert(
    b10c.lookupBudget === 0 && b10c.usedExplicitCap === true,
    'Explicit cap 0 is honoured (deliberate switch to disable lookups)'
  );

  const b11 = resolveWebsiteDiscoveryBudget({
    eligibleCount: 25,
    explicitCap: 7,
    mode: 'benchmark',
    env: {},
  });
  assert(b11.lookupBudget === 7, 'Explicit cap wins inside benchmark mode');

  const b12 = resolveWebsiteDiscoveryBudget({ eligibleCount: 6, explicitCap: 40, env: {} });
  assert(b12.lookupBudget === 6, 'Budget never exceeds eligible candidate count (6)');

  const b13 = resolveWebsiteDiscoveryBudget({ eligibleCount: 0, env: {} });
  assert(b13.lookupBudget === 0, 'Zero eligible candidates yields zero lookups');

  // --- 7. DECOUPLING: targetCandidates no longer influences the budget ---
  console.log('\n--- 7. targetCandidates decoupling (Task 1 root cause) ---');
  const legacySmallTarget = resolveWebsiteDiscoveryBudget({
    eligibleCount: 25,
    env: {},
    ...({ targetCandidates: 3 } as Record<string, unknown>),
  } as Parameters<typeof resolveWebsiteDiscoveryBudget>[0]);
  assert(
    legacySmallTarget.lookupBudget === 10,
    'targetCandidates=3 does NOT shrink the budget (legacy Math.max(target,10) coupling removed)'
  );

  const legacyLargeTarget = resolveWebsiteDiscoveryBudget({
    eligibleCount: 25,
    env: {},
    ...({ targetCandidates: 100 } as Record<string, unknown>),
  } as Parameters<typeof resolveWebsiteDiscoveryBudget>[0]);
  assert(
    legacyLargeTarget.lookupBudget === 10,
    'targetCandidates=100 does NOT enlarge the budget either'
  );

  // --- 8. Budget provenance log distinguishes NOT_SEARCHED from NOT_FOUND ---
  console.log('\n--- 8. Skip reporting (no silent truncation) ---');
  const log = formatWebsiteDiscoveryBudgetLog(b1, 25);
  assert(log.includes('not attempted: 15'), 'Log reports 15 not-attempted candidates');
  assert(
    log.includes('DISCOVERY_NOT_ATTEMPTED_BUDGET'),
    'Log carries the explicit not-attempted state token'
  );
  const logFull = formatWebsiteDiscoveryBudgetLog(b2, 25);
  assert(logFull.includes('not attempted: 0'), 'Benchmark log reports zero not-attempted candidates');

  // --- 9. rankWebsiteLookupTargets de-trap: no hidden `limit = 3` ---
  console.log('\n--- 9. rankWebsiteLookupTargets de-trap (latent limit=3 removed) ---');
  const pool: SerperPlaceResult[] = [
    makePlace('a', { rating: 4.9, ratingCount: 400 }),
    makePlace('b', { rating: 3.1, ratingCount: 5, phoneNumber: undefined }),
    makePlace('c', { rating: 4.0, ratingCount: 50 }),
    makePlace('d', { rating: 4.4, ratingCount: 120, address: undefined }),
    makePlace('e', { rating: 4.7, ratingCount: 300 }),
    makePlace('f', { rating: 2.0, ratingCount: 2 }),
    makePlace('g', { rating: 4.6, ratingCount: 220 }),
    makePlace('h', { rating: 3.9, ratingCount: 30 }),
    makePlace('i', { rating: 4.2, ratingCount: 90 }),
    makePlace('j', { rating: 4.1, ratingCount: 60 }),
  ];

  const allRanked = rankWebsiteLookupTargets(pool);
  assert(
    allRanked.length === 10,
    `Omitting limit returns ALL 10 places (no default 3 truncation) — got ${allRanked.length}`
  );

  const capped2 = rankWebsiteLookupTargets(pool, 2);
  assert(capped2.length === 2, 'Explicit limit=2 still honoured (legacy callers unaffected)');
  assert(
    capped2[0].placeId === 'a' && capped2[1].placeId === 'e',
    'Ranking still orders by evidence weight (phone+address+rating+reviews)'
  );

  const cappedZero = rankWebsiteLookupTargets(pool, 0);
  assert(cappedZero.length === 0, 'Budget of 0 produces zero lookups');

  const budgetTen = rankWebsiteLookupTargets(pool, 10);
  assert(budgetTen.length === 10, 'Budget of 10 selects the full eligible pool');

  console.log('\n===============================================================');
  console.log('🎉 WEBSITE DISCOVERY BUDGET POLICY TESTS PASSED (100%)');
  console.log('===============================================================');
}

try {
  runTests();
} catch (err) {
  console.error('Test failed:', err);
  process.exit(1);
}
