# Phase 0 — Gate G0 Verification Report

Branch: `refactor/code-1` @ `ffa77387be22a6f7a7fe337b6aa877e01a43afee` (= `main` — see `BASELINE.md` for the
`refactor/structure` naming note). Gate wording follows the **corrected** form: *"All Phase 0 checks pass.
Known baseline failures are documented. No new failures, output mutations, contract changes, or runtime
behavior changes exist."*

## Gate checklist (0.1–0.10)

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| G0.1 | Baseline branch + commit recorded | ✅ | `BASELINE.md`; `git rev-parse HEAD` |
| G0.2 | Original typecheck / spellcheck / test results recorded | ✅ | `artifacts/typecheck-baseline.txt` (exit 0); `spellcheck-baseline.txt` + `spellcheck-final.txt` (38 pre-existing issues / 27 files); `baseline-test-results.json` |
| G0.3 | Every pre-existing failure classified | ✅ | `BASELINE.md`: 0 test failures; 38 spellcheck issues all `pre-existing/dev-vocabulary`; 0 issues in Phase 0 files (3 harness issues fixed in-harness) |
| G0.4 | Contract inventory uses correct current paths (not `src/services/*.schema.ts`) | ✅ | `CONTRACTS.md` — 11 groups, actual paths, frozen counts |
| G0.5 | Dependency + export inventories generated | ✅ | `CONTRACTS.md`; `artifacts/dependency-inventory.{json,md}` — 47 sibling edges, 12 S→M edges across 9 services, 2 runtime dynamic imports, 0 unresolved; `business-extractor` 69 exports kind-tagged |
| G0.6 | Golden replay passes without network, Mongo, or workflow writes | ✅ | `GOLDEN-FIXTURES.md`; `artifacts/golden-replay-verify.txt` — 5/5 stages, 14/14 tables, 0 fetch, `output/` unchanged, exit 0 |
| G0.7 | Output snapshots unchanged after tests (+ after the spike) | ✅ | `ISOLATION-PROOF.md` — `output/` digest `14d75fd9…` and `.cache/` digest `2437f570…` identical across pre/run/spike |
| G0.8 | Alias verdict explicitly ADOPT or ABORT | ✅ **ADOPT** (`@/*`) | `ALIAS-SPIKE.md` — tsc ✓, tsx ✓, Mastra bundle ✓; `baseUrl` rejected (TS5102) |
| G0.9 | Madge baseline recorded with version | ✅ madge **8.0.0**, 3 cycles | `MADGE-BASELINE.md`; `artifacts/madge-circular-*.txt`, `madge-graph.json` |
| G0.10 | Broken package targets removed (or retained with justification) | ✅ removed | `TEST-MANIFEST.md`; `artifacts/script-targets-before.json` → `-after.json` (19 scripts, 45 targets, **0 missing**) |
| G0.11 | Cache files classified, not deleted | ✅ generated / obsolete | `CACHE-CLASSIFICATION.md` — 9 files, 0 code references |
| G0.12 | No unexpected failure introduced | ✅ | typecheck exit 0; spellcheck 38/27 (= untouched); tests 31/31; replay 0 diffs |

## Explicit deviations from the draft plan (all evidence-driven)

1. **Madge is NOT a devDependency.** `npm install --save-dev madge` fails (ERESOLVE: madge's
   `peerOptional typescript@^5.4.4` vs repo `typescript@^7.0.2`), and forcing it breaks plain
   `npm install` repo-wide. Locked form: `npx --yes madge@8.0.0 …` (see `MADGE-BASELINE.md`).
2. **Alias config keeps `paths` only.** The plan's `baseUrl + paths` is a hard error in TS 7
   (`TS5102`); `paths`-only passes all three environments (see `ALIAS-SPIKE.md`).
3. **Measured counts replace estimates:** 47 (not 46) sibling imports; 48 (not "35/32") tsx references
   with 3 dead targets; 38 (not 39) true-baseline spellcheck issues — each documented in place.
4. **Fixtures are hash-frozen, not VCS-frozen:** `scripts/` is gitignored (see `GOLDEN-FIXTURES.md`
   "Versioning note"). Suggested Phase 1 pre-step: `git add -f scripts/fixtures/golden/`.
5. **`mastra dev` resumes real workflow activity** (M1 cache-first, 0-credit cache hits); any future phase
   starting it must re-snapshot `output/` with `snapshot-tree.ts --compare` (see `ISOLATION-PROOF.md`).

## Phase 6 scope (`lib/` utility extraction) — owner decision required

The draft lists a Phase 6 (`lib/` utility extraction) as an open confirmation item. Phase 0 makes no
recommendation either way; it only records the fact that the invariant inventory (`CONTRACTS.md`,
`dependency-inventory.json`) is exactly what a later `lib/` extraction would diff against.
**Do not start Phase 1 until the owner confirms (a) this Gate report, (b) the alias token `@/*`, and
(c) whether Phase 6 `lib/` stays in the roadmap or is deferred.**

Standing rules observed: R1 (no business-logic/provider/query/classification change — diff review below
will show only `package.json` scripts, `tsconfig.json` alias, new docs/tooling), R2 (canonicalized replay),
R3 (madge baseline), R4 (isolation proof), R6 (atomic commits — see commit plan).
