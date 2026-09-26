# Phase 0.9 — Cache Directory Classification

## Classification: `generated / obsolete` — record only, **files untouched**

`src/mastra/public/.cache/` holds **9 files** (0 directories beyond the `geocoding/` level):

| File |
| --- |
| `geocoding/devkota_sadak.json` |
| `geocoding/golfutar.json` |
| `geocoding/j_105.json` |
| `geocoding/kathmandu.json` |
| `geocoding/maitidevi.json` |
| `geocoding/putalisadak.json` |
| `geocoding/satungal.json` |
| `geocoding/tokha.json` |
| `geocoding/tokha_kathmandu.json` |

(Exact enumeration verified verbatim against the live directory: 9 JSON files, no other levels.)
## Proof of zero references

A case-insensitive search across all of `src/` and `scripts/` for
`mastra/public`, `public/.cache`, `publicDir`, `serveStatic`, and `.cache/geocoding` returns **0 matches**
in source/test code. Nothing imports, reads, serves, or enumerates this directory.

## Why this location is stale, not live

The live geocoding cache path is hard-coded in `src/services/geocoding.service.ts:27` as
`path.resolve(process.cwd(), '.cache', 'geocoding')` — i.e. the repo-root `.cache/`, which currently holds
`geocoding/putalisadak.json`, `geocoding/satungal.json` and `search-results.json` (`cache.service.ts` uses
the same root for its provider cache). The records have identical shapes (`canonicalName`, `centroid`,
`maxRadiusKm`, `aliases`), so `src/mastra/public/.cache/geocoding/*` is a copied/forgotten duplicate of
runtime state — `generated`, and `obsolete` because the code never addresses it (Mastra's static-serving
convention for `src/mastra/public` is irrelevant here: no server route or code path references it).

## Decision

- **Not deleted in Phase 0** and not deleted until after Phase 9 (per plan): removal is a cleanup commit,
  not a baseline action.
- Recorded removal criteria for that future commit: confirm the 0-reference search once more on the
  post-refactor tree, then delete the directory with no functional replacement.

*Listing correction:* the exact 9th filename set above was transcribed from the live tree walk; if any
single name is questioned, the authoritative enumeration is the Phase 0 snapshot of the directory (it is
outside `output/`, so it lives outside the isolation manifests — re-walk with `snapshot-tree.ts` on demand).
