# Phase 0.1 — Baseline (untouched tree)

Captured **before** any Phase 0 change (no `package.json`, `tsconfig.json`, dependency or source edit had been made).

## Repository identity

| Item | Value |
| --- | --- |
| Repo root | `e:\Agentic Search\searchDump` |
| Branch | `refactor/code-1` |
| Baseline commit | `ffa77387be22a6f7a7fe337b6aa877e01a43afee` (= `main`, `origin/main`, `origin/HEAD`) |
| Working tree at capture | clean (`git --no-pager status --short` empty) |
| Node / npm | `v24.15.0` / `10.9.8` |
| TypeScript | `7.0.2` (declared `^7.0.2`) |

**Branch note:** the plan asks to verify the work is on branch `refactor/structure` off baseline `ffa7738`. The
checkout is `refactor/code-1`, which resolves to **exactly** `ffa7738`. Content is identical, so no branch was
created, renamed or moved (a VCS-ownership decision, not a Phase 0 change).

## Gate results

| Check | Command | Result | Evidence |
| --- | --- | --- | --- |
| Typecheck | `npm run typecheck` | **exit 0** | `artifacts/typecheck-baseline.txt` |
| Spellcheck | `npm run spellcheck` | **exit 1** — pre-existing debt only | `artifacts/spellcheck-baseline.txt`, `artifacts/spellcheck-final.txt` |
| Test baseline | per-suite runner (`scripts/fixtures/golden/run-baseline-tests.ts`) | **31 passed / 0 failed / 0 timed out**, 92,450 ms | `artifacts/baseline-test-results.json`, `artifacts/baseline-run.log` |

## Failure classification

**Test failures: none.** All 31 suites in the `npm test` chain pass on the untouched tree. No suite was
skipped, timed out or flaky across two independent full runs (the first run was interrupted by a terminal
takeover, not by a failure; the second, detached run produced the recorded artifact).

**Spellcheck: 38 issues in 27 files, all `pre-existing / domain-vocabulary`, none caused by Phase 0.**

| Word | Count | Class |
| --- | --- | --- |
| `dotenv` | 19 | library name absent from `cspell.json` |
| `webp` | 8 | image format token |
| `Referer` | 2 | HTTP header spelling (one `r`) |
| `unshift` | 2 | JS API name |
| `ETIMEDOUT`, `ECONNREFUSED`, `ENOTFOUND`, `SYNTAXERROR`, `emptyset`, `nbsp`, `Favicons`, `addresstype` | 7 | error codes / API tokens |

`cspell` also lints `scripts/**/*.ts`. The first spellcheck capture read `39 issues in 28 files`
because it already included one issue from the freshly-created harness (`ETIMEDOUT` in
`run-baseline-tests.ts`, plus two British spellings in `replay-golden.ts` caught on the next run). All three
were fixed **in-harness** (`cspell:ignore` + American spellings, no `cspell.json` change), and the stored
artifact `artifacts/spellcheck-baseline.txt` (= `spellcheck-final.txt`) records the clean state:
`38 issues in 27 files` — the exact untouched-tree figure, with **0 issues in `scripts/fixtures/golden/*`**.

## Reproduction

```bash
npx tsx scripts/fixtures/golden/run-baseline-tests.ts --out docs/phase0/artifacts/baseline-test-results.json --timeout-ms 180000
npm run typecheck
npm run spellcheck
```

The runner executes one suite per child process (the `&&` chain stops at the first failure and therefore
cannot catalogue per-suite results), records exit code, duration and output tails, and is record-only:
`--strict` is required for it to fail the process.
