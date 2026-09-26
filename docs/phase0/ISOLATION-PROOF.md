# Phase 0.4 — Test Output Isolation Proof (R4)

**Claim:** running the full test suites leaves `output/` and the runtime `.cache/` byte-identical.

**Method:** `scripts/fixtures/golden/snapshot-tree.ts` records every regular file as
`relative-path + bytes + sha256` (POSIX separators, sorted), so directories are compared by content, not
timestamps. Snapshots were taken **before** the 31-suite run, **after** it, and **after the `mastra dev`
alias spike** (which started a real server and resumed cached workflow activity — see `ALIAS-SPIKE.md`).
All comparisons used deterministic `treeDigest`s (sha256 of the sorted `path:bytes:sha256` list).

## Results

| Tree | Pre (files / bytes / treeDigest) | Post-run | Post-spike | Verdict |
| --- | --- | --- | --- | --- |
| `output/` | 75 / 112,192,604 / `14d75fd960685a593bd7437c55f07c19` | identical | identical | **PASS — 0 added/removed/changed** |
| `.cache/` (runtime) | 3 / 3,195,249 / `2437f570fd51bd42c49bc9283b7897cc` | identical | identical | **PASS — 0 added/removed/changed** |

Raw manifests: `artifacts/output-snapshot-{pre,post,after-spike}.json`,
`artifacts/cache-snapshot-{pre,mid,post,after-spike}.json`; comparators print
`identical: no added, removed or changed files` and exit 0.

An interrupted first attempt (a terminal takeover killed the runner mid-suite) left no mutation behind
either: a mid-run `.cache` comparison against the pre snapshot was also identical.

## Why this holds (code-level)

- All write-capable suites use `os.tmpdir()` scratch roots and clean up on `process.on('exit')`.
- `saveStageOutput`/`saveSummaryReport` honor `options.outputRoot`, and the suites that exercise them pass
  test-only roots — the live `output/` tree is never their target.
- `test-m2a-locality-and-maps.ts` temporarily rewrites `.cache/geocoding/putalisadak.json` but restores the
  original bytes in `finally` (and the empirical diff confirms byte-identity held).
- The golden replay (`replay-golden.ts --report`) additionally asserts `output/` is unchanged across its own
  run and refuses to pass a gate if it ever mutates: it reports `output isolation: output/ unchanged`.

## Out-of-scope-but-observed runtime state

The alias spike's `mastra dev` run (the only Phase 0 step that starts the real server) **did** mutate two
generated, gitignored stores, exactly as expected of a dev server:

| Store | Effect | Tracked? |
| --- | --- | --- |
| `.mastra/` bundle dir | 61 → 62 files; `.build/entry-0.mjs`, `bundler-config.mjs` rebuilt, 3 `output/tools/*.mjs` regenerated, `dev.lock` added | No (gitignored) |
| `mastra.db` / `-wal` (393 MB LibSQL store) | write timestamps advanced during cached workflow activity | No (`*.db*` ignored) |

Neither is an R4 target. The R4 targets (`output/latest`, `output/history`, runtime `.cache`) remained
provably unchanged. **Forward rule:** any future phase that starts `mastra dev` must re-snapshot `output/`
before and after, using the same tooling (`snapshot-tree.ts --compare`), because this runtime resumes
cached workflow activity on startup (Tavily hits at 0 credits were observed).
