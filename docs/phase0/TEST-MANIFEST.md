# Phase 0.2 — Test Manifest (frozen, in `npm test` chain order)

31 active suites. This list is the parity reference for Phases 1–9: no suite may be dropped, skipped or
renamed without a recorded decision. Measured per-suite durations are from
`artifacts/baseline-test-results.json` (all `passed`).

| # | Suite | Result | Duration |
| --- | --- | --- | --- |
| 1 | `scripts/test-website-ranker.ts` | passed | 2,857 ms |
| 2 | `scripts/test-second-chance.ts` | passed | 2,566 ms |
| 3 | `scripts/test-satungal-sweep-defects.ts` | passed | 3,616 ms |
| 4 | `scripts/test-website-discovery-budget.ts` | passed | 2,587 ms |
| 5 | `scripts/test-website-discovery-gate.ts` | passed | 2,371 ms |
| 6 | `scripts/test-snippet-phone-attribution.ts` | passed | 2,537 ms |
| 7 | `scripts/test-ever-vision-discovery.ts` | passed | 2,973 ms |
| 8 | `scripts/test-negative-directory-contamination.ts` | passed | 3,310 ms |
| 9 | `scripts/test-phase7c-defect-remediation.ts` | passed | 3,032 ms |
| 10 | `scripts/test-phase8a-geographic-evaluator.ts` | passed | 818 ms |
| 11 | `scripts/test-phase8b-contact-role-aggregation.ts` | passed | 3,494 ms |
| 12 | `scripts/test-phase8-geographic-contact-reconciliation.ts` | passed | 3,073 ms |
| 13 | `scripts/test-phase8d-defect-fixes.ts` | passed | 3,463 ms |
| 14 | `scripts/test-phase8f-rich-metadata.ts` | passed | 2,917 ms |
| 15 | `scripts/test-phase8g-defects.ts` | passed | 3,116 ms |
| 16 | `scripts/test-phase8h-defects.ts` | passed | 4,117 ms |
| 17 | `scripts/test-phase8h-w207.ts` | passed | 4,265 ms |
| 18 | `scripts/test-phase8h-w208.ts` | passed | 3,193 ms |
| 19 | `scripts/test-phase8i-defects.ts` | passed | 2,829 ms |
| 20 | `scripts/test-phase8j-defects.ts` | passed | 3,329 ms |
| 21 | `scripts/test-phase8k-defects.ts` | passed | 2,476 ms |
| 22 | `scripts/test-phase8l-defects.ts` | passed | 2,929 ms |
| 23 | `scripts/test-phase8m-defects.ts` | passed | 2,469 ms |
| 24 | `scripts/test-phase8n-defects.ts` | passed | 3,115 ms |
| 25 | `scripts/test-phase8o-defects.ts` | passed | 3,209 ms |
| 26 | `scripts/test-mongo-service.ts` | passed | 3,114 ms |
| 27 | `scripts/test-m2a-locality-and-maps.ts` | passed | 3,355 ms |
| 28 | `scripts/test-m2b-candidate-preservation.ts` | passed | 2,644 ms |
| 29 | `scripts/test-m2c-social-extraction.ts` | passed | 2,888 ms |
| 30 | `scripts/test-m2c-cascade-semantics.ts` | passed | 3,006 ms |
| 31 | `scripts/test-m2c-structured-branch-attribution.ts` | passed | 2,782 ms |

Totals: 31 suites, 31 passed, 0 failed, 0 timed out — 92,450 ms of suite time (per-suite process
spawn adds the wall-clock remainder).

## Integrity properties verified at baseline

- **Network-free (except skips):** no suite calls live providers. `test-mongo-service.ts` runs its unit
  checks offline and **SKIPs its live checks (exit 0) when MongoDB is unreachable**; a reviewer on a machine
  *with* Mongo running may see its live path execute against `MONGODB_DB_NAME=business_directory_test`.
- **Self-isolating outputs:** the write-capable suites target `os.tmpdir()` scratch roots
  (`test-ever-vision-discovery.ts`, `test-negative-directory-contamination.ts`) or restore what they borrow
  (`test-m2a-locality-and-maps.ts` rewrites the runtime `.cache/geocoding/putalisadak.json` inside a
  `try/finally` that restores or deletes it). No suite writes to `output/`, proven empirically in
  `ISOLATION-PROOF.md`.
- **`npm test` is a `&&` chain** that halts at the first failure; the Phase 0 runner
  (`scripts/fixtures/golden/run-baseline-tests.ts`) executes the identical 31-suite list one process at a
  time so pre-existing failures, if any, are catalogued instead of merely halting the chain.

## Out-of-scope scripts (present, not part of `npm test`)

Not subject to parity checks but recorded so nothing is silently added to the chain later:

- **Probes:** `probe-serper-maps-batch.ts`, `probe-serper-maps-phone.ts`, `probe-serper-rich-fields.ts`,
  `probe-w410-direct-verification.ts` (3 of these call `fetch(`/live APIs and need keys)
- **Benchmarks/checkpoints:** `run-home-cleaning-benchmark.ts`, `run-plumbing-benchmark.ts`,
  `run-restaurants-benchmark.ts`, `run-m2c-consultancy.ts`, `run-satungal-schools-acceptance.ts`,
  `run-phase8i/o/j/k/l/m/n-checkpoint.ts`
- **Tooling:** `seed-mongo-from-output.ts`

## Removed dead targets (Phase 0.8)

`test:e2e` → `scripts/test-research-workflow-e2e.ts`, `test:e2e:phase2` → `scripts/test-phase2-e2e.ts`,
`test:all` → `scripts/test-all-fixes.ts` — files that do not exist. Removed; every remaining script target
now resolves (validator `scripts/fixtures/golden/check-scripts.ts`: 19 scripts, 45 valid `tsx` targets,
0 missing; see `artifacts/script-targets-before.json` → `script-targets-after.json`).
