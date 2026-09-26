# Phase 0.6 — Circular Dependency Baseline (R3, via Madge)

- **Madge version: `8.0.0`** — run pinned as `npx --yes madge@8.0.0` (see "Installation decision" below).
- Baseline command: `npx --yes madge@8.0.0 --extensions ts --circular src` (46 files, 9.2 s), plus the
  plan's `--ts-config tsconfig.json` variant (46 files, 1.3 s) — **both report the same 3 cycles**.
- Full graph: `artifacts/madge-graph.json` (46 modules); raw outputs:
  `artifacts/madge-circular-baseline.txt`, `artifacts/madge-circular-tsconfig.txt`.

## Baseline cycles (3)

1. `mastra/index.ts` ↔ `mastra/workflows/research-workflow.ts`
   - Forward: `index.ts:27` statically imports `researchWorkflow`.
   - Reverse: `research-workflow.ts` does a **runtime dynamic** `await import('../index')`
     (recorded in the dependency inventory as `research-workflow.ts → src/mastra/index.ts`).
2. `services/geographic-evaluator.service.ts` ↔ `services/geocoding.service.ts`
   - Forward (static): `geocoding.service.ts:8` imports `calculateHaversineDistanceKm` from the evaluator.
   - Reverse (runtime dynamic): `geographic-evaluator.service.ts:337` does
     `await import('./geocoding.service.js')` — with a code comment saying it exists to *avoid* cycles.
3. `mastra/workflows/research-workflow.ts` ↔ `services/mongo.service.ts` *(the plan's tracked cycle)*
   - Forward (static, runtime): `research-workflow.ts` imports `mongo.service`.
   - Reverse (**type-only**, erased at compile time): `mongo.service.ts:39`
     `import type { BusinessListing } from '../mastra/workflows/research-workflow'`.

**Phase 1 Gate G1 target: 0 cycles.** Note cycle 3's reverse edge is type-only, so a `/types` extraction of
`BusinessListing` breaks it without touching any runtime path.

## Installation decision (empirical, protects the repo)

The pre-execution item "install `madge` as a `devDependency`" was attempted and **rejected on evidence**:

1. `npm install --save-dev madge` → **fails** with `ERESOLVE`: `madge@8.0.0` declares
   `peerOptional typescript@"^5.4.4"`, but this repo pins `typescript@"^7.0.2` (conflict tries to pull
   `typescript@5.9.3`).
2. `npm install --save-dev madge --legacy-peer-deps` succeeds locally (madge 8.0.0 + 125 packages added,
   10 removed) but **breaks a plain `npm install` for everyone else** (same ERESOLVE on re-resolve).
3. Therefore `package.json`/`package-lock.json` were **reverted** (`git checkout --`) and the tree restored
   (`npm install`, exit 0, madge absent from `node_modules`); current devDependencies remain
   `{ cspell: ^10.3.4, tsx: ^4.23.13 }`.

**Standing decision:** Madge is a Phase 0 measurement tool, not a project dependency. The frozen command is
`npx --yes madge@8.0.0 --extensions ts --circular src` — version-pinned, zero lockfile mutation, and the
Phase 1 gate re-runs exactly this command.
