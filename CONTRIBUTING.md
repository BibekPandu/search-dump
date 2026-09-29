# Contributing to `searchDump`

Operational rules for changing this repository. The pipeline writes business
records to MongoDB and to `output/`, so a "harmless" change can corrupt data
silently. These rules exist because that has happened.

---

## 1. Architecture layering

Dependencies point **one way only**:

```
src/types  ·  src/config  ·  src/lib      (contracts, policy, pure math)
                 ▲
                 │
            src/services                   (the engine)
                 ▲
                 │
            src/mastra                     (workflow + agents)
```

- `types/`, `config/` and `lib/` never import upward. `config/` is pure policy
  with no I/O; `lib/` is a cycle-free leaf.
- `services/` may import `types`/`config`/`lib` freely and may import across its
  own domain layers, but must not import `mastra/`.
- `mastra/` is the only layer allowed to compose services into a workflow.

### Thin facades

The 27 files at `src/services/*.service.ts` are **re-export shims only** — a
stable import surface for `@/services/...` paths that predate the service
regrouping. They exist so old imports keep working; they must not accumulate
logic. The one exception is `telemetry.service.ts`, which keeps its
implementation at the root.

Two gates enforce this: `check-shim-exports.ts` proves every facade still
re-exports the same references, and `madge --circular` proves the graph is
still acyclic.

### Never anchor paths to `process.cwd()`

There are exactly three `process.cwd()` call sites left in `src/`, and they
are the known debt that Sprint 1 removes:

| Location | Problem |
|---|---|
| `services/storage/db.service.ts:6,13` | `getProjectRootDir()` walks up from the cwd; falls back to `process.cwd()` |
| `services/resolution/geocoding.service.ts:27` | Resolves `.cache/geocoding` against the cwd |

A cwd-anchored cache directory is why a stray
`src/mastra/public/.cache/geocoding/kathmandu.json` exists: a run started
from a different working directory wrote its cache next to the process. The
correct pattern is the one `cache.service.ts` already uses — anchor on
`getProjectRootDir()`.

**When adding any path resolution, use a root-anchored helper. Never
`process.cwd()`.**

---

## 2. Quality gates

All seven must pass **after every commit**, not just before a merge. A commit
that turns a gate red must be fixed in that commit.

```bash
npm run typecheck                                              # tsc strict → 0 errors
npm run spellcheck                                             # cspell → 0 issues
npm test                                                       # 18/18 core suites
npm run test:full                                              # 32/32 full regression
npx tsx scripts/fixtures/golden/replay-golden.ts               # offline replay → 0 drift
npx tsx scripts/fixtures/golden/check-shim-exports.ts          # shim identity → ALL PASSED
npx madge --circular --extensions ts --ts-config tsconfig.json src   # → 0 cycles
```

> **Verify the chain actually completed.** `npm test` and `npm run test:full`
> are long `&&` chains on Windows, and a killed process can still surface
> exit code `0` while stopping mid-chain. Confirm the final suite's own
> completion marker is present in the output, not just the exit code.

### Keeping documentation counts honest

`README.md` and `ARCHITECTURE.md` carry file counts, line counts and suite
counts. **The same change that alters those numbers updates the documents in
the same commit.** A count that drifts is worse than no count, because readers
trust it.

Line counts use the `wc -l` convention (newline count). Note that 104 of 105

---

## 3. Test tiers

| Tier | Command | Contents |
|---|---|---|
| Core (tracked in git) | `npm test` | 18 suites — every cross-cutting invariant |
| Full (local-only) | `npm run test:full` | 18 core + 14 phase regression suites |

**A new invariant suite belongs in the core chain and in both chains.** The
core tier is the critical path; a suite sitting only in the local-only tier
does not protect anything on a machine that has not run `test:full`.

Add a suite to the core tier when it asserts something that, if it broke,
would corrupt data without an obvious error. The multi-category false-merge
guard suite is the reference example: it covers false-merge prevention across
verticals, token inflation, Phase 0 social promotion and Facebook namespace
handling — all of which failed silently once already.

Suites must be offline and deterministic (injected `fetch`, fixture data).
`test-mongo-service` skips cleanly when MongoDB is unreachable.

---

## 4. Run-locality is a required input

The canonical identity of a business is:

```
name:<nameKey>|<locationKey>
```

`listing.location` is a **street address**, not a locality, so the locality in
the key comes from the **run's** `location` input.

Omitting `location` does not fall back to a safe default. It substitutes
`unknown-location`:

```ts
return `name:${nameKey}|${locationKey || 'unknown-location'}`;
```

Because the locality is part of the identity, a run without `location` writes
`|unknown-location` keys and **creates duplicate identities** instead of
updating the records that already exist. This is silent: the run reports
success and the listings look correct.

**Always pass a non-empty `location` to the workflow.**

The schema keeps `location` optional for backward compatibility, so this is a
practical requirement rather than an enforced one. A write-time guard in
`mongo.service.ts` warns when an `unknown-location` key is produced; a
schema-level guard is deferred.

> **Studio note:** `location` is required in practice. Studio renders the
> field, and omitting it corrupts canonicalKey identity. Supplying a locality
> is the expected behaviour, not an optional refinement.

### Gate 8 — canonicalKey stability

Not a routine gate; run it when changing identity, persistence, dedupe or
locality handling.

1. Snapshot the current keys:

```bash
node -e "require('dotenv').config();const fs=require('fs');const{MongoClient}=require('mongodb');(async()=>{const c=new MongoClient(process.env.MONGODB_URI||'mongodb://localhost:27017');await c.connect();const d=await c.db('business_directory').collection('businesses').find({},{projection:{canonicalKey:1,_id:0}}).toArray();fs.writeFileSync('.cache/mongo-keys-before.txt',d.map(x=>x.canonicalKey||'<missing>').sort().join('\n')+'\n');await c.close();})()"
```

2. Run the workflow with:

```ts
{
  query: 'dental clinics in Kathmandu',
  location: 'Kathmandu',   // REQUIRED — see above
  refresh: true,
  autoApprove: true,
}
```

3. Snapshot after, writing to `.cache/mongo-keys-after.txt`, then compare:

```powershell
Compare-Object (Get-Content .cache/mongo-keys-before.txt) (Get-Content .cache/mongo-keys-after.txt)
```

**Pass = additions only (`=>`). Any removal (`<=`) is a normalization
regression** — stop, diagnose, and do not proceed.

Additions should be **genuinely new businesses**. If an addition shares a
name with an existing key but differs only in locality suffix, the run
produced duplicates: check that `location` was passed.

---

## 5. Commits and pull requests

- One coherent unit per branch and per pull request. Do not bundle unrelated
  changes; do not mix documentation with code unless the documentation change
  is caused by the code change (see the count rule in section 2).
- Merge each pull request before starting the next. Work on an unmerged
  branch is how drift accumulates.
- Every commit message records **why**, not just what. A future reader needs to
  know which failure motivated the change.
- Gates run after every commit, and a red gate is fixed in the commit that
  caused it.

### Golden fixtures

The golden lock (`scripts/fixtures/golden/expected/`) is a baseline for
behaviour, not a formality. If it goes red, **diagnose before re-locking**.

Re-lock with `--update` only after establishing that the new behaviour is the
intended behaviour. A golden diff is a signal, and `--update` silences it —
including when the new behaviour is a regression that nobody has noticed yet.

When investigating a golden diff, match entries on their URL key rather than
by array index: `sortKeyFor` in `compare.ts` falls back to `JSON.stringify` for
`{sample, classified}` wrappers, so a single real change re-sorts the list and
reports a cascade of false diffs. Establish the real change count before
concluding anything.

source files are CRLF, so a `split("\n").length` count reports 19,684 where
`wc -l` reports 19,579.
