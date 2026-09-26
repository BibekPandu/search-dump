# Phase 0.3 — Semantic Golden Fixtures & `compare.ts` (R2)

All fixture tooling under `scripts/fixtures/golden/` (note: `scripts/` is gitignored by repo policy — see
"Versioning note" below).

## Canonicalizer (`compare.ts`)

| Rule | Implementation |
| --- | --- |
| Strip dynamic metadata | `runId`, `_id`, `createdAt`, `updatedAt`, `extractedAt`, `runStartedAt`, `startedAt`, `finishedAt`, `timestamp`, `searchedAt`, `first/lastSeenAt`, `lastCheckedAt`, `sourceRunIds`, `generatedAt`, `capturedAt` |
| Sort lists | listings by `name`+`location`, contacts by `value`+`type`, socials by `platform`+`handle`, URLs, fallback JSON-string order |
| Normalize URLs | production `normalizeUrl` rules (www strip, tracking params, hash, param sort) |
| Confidence/numbers | round floats to 4 decimals |
| JSON-safe | `undefined` values dropped (mirrors `JSON.stringify`), arrays keep `null` |

CLI: `npx tsx scripts/fixtures/golden/compare.ts <a.json> <b.json> [--max-diffs N]` → semantic diff
with `$`-rooted paths, exit 1 on difference.

## Fixture (`input/replay-input.json`, 168,456 bytes)

Derived by `scripts/fixtures/golden/extract-fixture.ts` from real run artifacts
(`input/source-manifest.json` pins sha256 + byte size of every source):

| Source | sha256 (prefix) | Bytes |
| --- | --- | --- |
| `output/history/2026-09-25T11-49-07-627Z-consultancy/2b-verified-evidence.json` | `c92fe0cd…` | 26,677,493 |
| same run `/3-final-listings.json` | `77817ac4…` | 261,518 |
| same run `/0-research-candidates.json` | `412e2a36…` | 113,191 |
| `output/history/2026-09-25T07-48-18-469Z-consultancy/1-broad-search.json` | `169a46e5…` | 5,603 |
| `scripts/fixtures/royal-cleaning-fixture.json` → byte-copied into `input/` | `51cffe…` | 2,177 |

Reductions applied (recorded in the fixture's `provenance` block): first 8 Maps places, 3
Maps-corroborated web results (`kiec.edu.np`, `niec.edu.np`, `edwisefoundation.com`), 3
evidence/listing pairs (`verified_first_party_with_content`, `transient_failure_no_pages`,
`unverified_with_content`), 2 fallback cases, `pages[].rawHtml` removed, page content truncated to 2,000
chars, `runStartedAt` pinned to `1970-01-01T00:00:00.000Z`, plus 24 curated phone samples and 11 curated
social samples covering every accept/reject class.

## Replay (`replay-golden.ts`) — **PASSES, exit 0, 0 semantic differences**

```bash
npx tsx scripts/fixtures/golden/replay-golden.ts [--report <file.md>]   # verify
npx tsx scripts/fixtures/golden/replay-golden.ts --update               # re-lock (Phase 0 only)
```

| Stage | Canonical sha256 (prefix) |
| --- | --- |
| `buildResearchCandidates` | `ff426df4…` |
| `classifyNepalPhone` | `f3246057…` |
| `classifySocialProfile` | `c3cf39cd…` |
| `sanitizeListingWithEvidence` | `02e77981…` |
| `buildFallbackListing` | `6c694c9a…` |

Enforced guards (all true in the locked run): **0 `fetch` calls attempted** (throwing stub),
**MONGODB_URI/TAVILY/SERPER/OPENROUTER blanked**, **no workflow execution, no provider calls**,
**`output/` byte-identical across the replay** (asserted inside the runner).

Byte-locked static tables — 14 entries in `expected/static-tables-lock.json`
(order-preserving hash; `Set`/`Map` materialized deterministically):
NTA prefixes 14, landline area codes 37, locality clusters 18, directory domains 9+4+92,
expansion policies 1, stem mappings 1, broad-query patterns 1, stopwords 24, industry tokens 164,
locality tokens 30, category generic tokens 13, country code `977`.

## Versioning note

`scripts/` is in `.gitignore`, so the fixtures are frozen by **content hash**, not by VCS: the fixture
sha256 (`7e1cc958…`) is recorded in every replay report, and `docs/phase0/artifacts/` (tracked) holds the
locked outputs and manifests. If the roadmap needs the fixtures versioned, the owner can `git add -f`
`scripts/fixtures/golden/` — listed as a Phase 1 pre-step in the gate report.
