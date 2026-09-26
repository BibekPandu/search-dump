# Phase 0.5 — Path Alias Spike (`@/*` → `./src/*`)

## Verdict: **ADOPT** — with a mandatory correction: **no `baseUrl`** (removed in TypeScript 7).

## What was tested

Alias token: `@/*`. Spike probe files: `scripts/fixtures/golden/alias-probe.ts` (kept as the permanent
`tsc`/`tsx` canary) and a temporary `src/mastra/alias-probe.ts` wired into `src/mastra/index.ts`
(deleted after the spike; `index.ts` restored via `git checkout`).

| Environment | Config tried | Result | Evidence |
| --- | --- | --- | --- |
| TypeScript compiler `npx tsc -p tsconfig.json` | `baseUrl: "."` + `paths` | **FAIL** — `error TS5102: Option 'baseUrl' has been removed… Use '"paths": {"*": ["./*"]}' instead` | `artifacts/alias-tsc-errors.txt` |
| TypeScript compiler | `paths` only, no `baseUrl` | **PASS** — exit 0 | re-ran cleanly in the same session |
| Script runner `npx tsx scripts/fixtures/golden/alias-probe.ts` | both variants | **PASS** — `alias-probe(tsx/tsc): prefixes=14 type=mobile digits=9851180403`, exit 0 | console output |
| Mastra runtime `npx mastra dev` (bounded, then killed) | `paths` only | **PASS** — `✓ Initial bundle complete`, server up on `:4111`, `HTTP_STATUS=200` on `/api`, and the spike module was **inlined into the app bundle**: `.mastra/.build/entry-0.mjs` contains `const aliasProbeSummary = \`alias-probe:${NTA_MOBILE_PREFIXES.length}\`` (2 matches across `.mastra` bundles) | `artifacts/mastra-alias-dev.log`, bundle grep |

## Corrections to the original plan

1. **The plan's prescribed config is invalid on this toolchain.** `"baseUrl": "."` is a hard error in
   TS 7.0.2. The correct adopted config, kept in `tsconfig.json`, is:
   ```json
   { "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }
   ```
   (`paths` resolves relative to the tsconfig location in TS 5+; no `baseUrl` needed.)
2. A transient authoring defect during the spike (a JSDoc line containing `scripts/**/*` closed the probe's
   block comment early and produced `TS1109/TS1005` noise) was fixed in the probe file; it is unrelated to
   the alias mechanism and documented so it is not mistaken for an alias failure.

## Side effects (observed, bounded, documented)

Running `mastra dev` — which this spike requires — **starts the real server and resumes cached workflow
activity** (M1 cache-first; observed Tavily hits at 0 credits and `[Workflow:Step2]` processing). Guards:

- `output/` and runtime `.cache/` were snapshotted before and after the spike: **byte-identical, 0 diffs**
  (see `ISOLATION-PROOF.md`).
- The process tree was killed (`taskkill /F /T`) after the endpoint probe; port 4111 confirmed free and no
  `node` mastra processes remain.
- Expected generated-store churn (`.mastra/` bundle rebuild, `mastra.db` write timestamps) occurred; both
  are gitignored runtime artifacts, not R4 targets.

## Rollback state

- `src/mastra/index.ts`: restored to baseline (`git checkout`), spike import removed.
- `src/mastra/alias-probe.ts`: deleted (confirmed absent).
- `tsconfig.json`: **intentionally retains** the adopted `paths`-only mapping; the `baseUrl` variant is
  recorded only as the rejected experiment (`artifacts/tsconfig-baseline.json` preserves the untouched
  file, sha256 `c895777228de…`).
- The `scripts/fixtures/golden/alias-probe.ts` canary stays so any future phase can re-prove `tsc`+`tsx`
  resolution in one command.
