# ARCHITECTURE — `searchDump` (Agentic Business Discovery & Extraction Engine)

> Complete system map: end-to-end flow, storage architecture, module inventory, quality gates.
> Branch `refactor/code-2` · Regenerated 2026-09-28 · Post-refactor, post-fixture-refresh state.

---

## 1. Executive summary

A **Mastra-based agentic pipeline** that discovers local businesses (Nepal/Kathmandu focus) by
fusing Google Maps Places with organic web search, verifies candidates against their official
websites using deterministic extraction, and emits structured, confidence-scored business
listings — to disk (`output/latest/businesses.json`) and optionally to MongoDB.

| Dimension | Value |
|---|---|
| Runtime | Node.js + TypeScript 7 (ESM, `strict`), executed with `tsx` |
| Framework | Mastra 1.x — workflow with 4 `.then()` steps + 3 registered agents |
| Schemas | Zod 4 everywhere (workflow I/O, agents, evidence, listings) |
| External APIs | Serper.dev (Google Search + Maps) · DuckDuckGo (fallback) · Tavily Extract · OpenRouter (Gemma) · UnoRouter (Gemini free) · OSM Nominatim (geocoding) |
| Persistence | MongoDB (`businesses` + `runs`, optional) · LibSQL `mastra.db` (agent memory) · `.cache/` (search + geocode) · `output/` (artifacts) |
| Scale | `src/`: 120 TS files, 20,278 lines · `scripts/`: 20 tracked core suites (34 with `test:full`) · 164 tracked files |
| LLM budget | 3 bounded calls/run: 30s ambiguous classification, 20s synthesis, 10-call extraction escape hatch — everything else deterministic |

**Design principle:** *determinism first*. Ranking, extraction, contact taxonomy, geography,
dedup and confidence are pure code with zero HTTP; LLMs are bounded side-quests with
zero-token fallbacks that always produce a well-formed result.

---

## 2. End-to-end flow map

### 2.1 Pipeline overview

```
                     ┌────────────────────────────────────────────────────────┐
 INPUT               │  research-workflow (src/mastra/workflows/)             │  OUTPUT
                     │                                                        │
 query ────────────▶ │  STEP 1  research-agent-step                           │
 location            │  ├─ M1 cache-first guard ── MongoDB run snapshot ──── HIT ──▶ finalizeCacheHit ─┐
 autoApprove         │  │        (miss / refresh / stale / skipped_mongo_down) │                      │
 targetCandidates    │  └─ MISS: runResearchDiscovery (services/discovery/)   │                      │
 refresh  …          │       Phase 0  Maps-first pagination                   │                      │
                     │              → relevance gate → geography gate         │                      │
                     │              → website discovery gate (budget 10)      │                      │
                     │       Phase 1  Web fallback (if Maps short)            │                      │
                     │              → classifier → search-worker LLM (30s)    │                      │
                     │       Writes: 0-website-discovery.json                 │                      │
                     │               0-research-candidates.json (+0b lean)    │                      │
                     ├────────────────────────────────────────────────────────┤                      │
                     │  STEP 2  human-review-step                             │                      │
                     │  autoApprove=true → pass · else suspend() → HITL       │                      │
                     │  approved=false → throw                                │                      │
                     ├────────────────────────────────────────────────────────┤                      │
                     │  STEP 3  deep-extraction                               │                      │
                     │  Tavily homepage → page discovery → batch extract      │                      │
                     │  → raw-HTML safety net → advanced retry                │                      │
                     │  → buildVerifiedEvidence → address re-validation       │                      │
                     │  Writes: 2-deep-extractions.json, 2b-verified-evidence │                      │
                     ├────────────────────────────────────────────────────────┤                      │
                     │  STEP 4  supervisor-synthesis                          │                      │
                     │  Layer 2 supervisor agent (20s) ──fail──▶ Layer 3      │                      │
                     │  buildFallbackListing (zero-token)                     │                      │
                     │  → Zod validate → drop geo-excluded                    │                      │
                     │  → Maps re-injection → sanitize → merge duplicates     │                      │
                     │  → normalize phones → cross-listing conflicts          │                      │
                     │  → confidence + integrity → cap quality                │                      │
                     │  → upsertBusinesses + saveRunRecord (MongoDB)          │                      │
                     │  → ledger + summary report                             │                      │
                     │  Writes: 3-final-listings.json / results.json          │                      │
                     │          entity-conflicts.json, candidate-ledger.json  │                      │
                     └────────────────────────────────────────────────────────┤                      │
                                                                              ▼                      ▼
                                                    output/latest/  +  output/history/<run>/  + MongoDB
```

### 2.2 Workflow composition

`src/mastra/workflows/research-workflow.ts` (109-line composer; step bodies live in
`workflows/steps/`, schemas in `workflows/workflow-contracts.ts`) — a strictly linear chain,
no `.branch()` / `.foreach()`; all branching is early returns keyed on `fromCache`:

```ts
createWorkflow({ id: 'research-workflow', inputSchema, outputSchema })
  .then(researchAgentStep)        // id: research-agent-step  — cache guard + discovery
  .then(humanReviewStep)          // id: human-review-step    — HITL suspend gate
  .then(deepExtractionStep)       // id: deep-extraction      — Tavily + evidence
  .then(supervisorSynthesisStep)  // id: supervisor-synthesis — LLM/fallback + persistence
  .commit();
```

`cachePassthroughSchema` (`fromCache`, `cachedListings`, `cacheLookupStatus`, `cachePolicyDays`,
`cacheSourceRunId`, `refreshRequested`, `runConfig`) is spread into **every** step's I/O schema
so Zod never strips the cache signals.

### 2.3 Input contract (`research-workflow` inputSchema)

| Field | Type | Meaning |
|---|---|---|
| `query` | string, required | Search query, e.g. `"hotels in Kathmandu"` |
| `location` | string? | Optional location constraint |
| `autoApprove` | boolean, default `true` | Skip human review (headless execution) |
| `agentId` | string, default `gemma-supervisor-agent` | Synthesis agent |
| `targetCandidates` | number? | Target usable candidates |
| `maxMapsPages` | number?, default 5 | Google Maps pagination cap |
| `maxPages` | number? | Web search page cap |
| `websiteDiscoveryMode` | `production` \| `benchmark` | Budget mode: 10 lookups/run vs all-eligible (hard cap) |
| `maxWebsiteDiscoveryLookups` | number? | Explicit per-run gate budget |
| `maxDeepVerifyCandidates` | number? | Tavily deep-verify cap (default `max(target,10)`) |
| `refresh` | boolean? | **M1:** bypass cache, re-run, replace stored snapshot |
| `maxCacheAgeDays` | number? | **M1:** freshness window override (input > env > category > 30) |

### 2.4 Discovery engine (`services/discovery/research-discovery.service.ts`, 894 L)

Runs inside Step 1 on cache miss:

1. **Phase 0 — Maps-first.** Query expansion (category policy) → `paginateMapsDiscovery`
   (Serper Places, 4 stop reasons, unique-candidate counting) → `checkCategoryRelevance`
   (tri-state gate) → `evaluateGeographicLocality` (5-layer inside/outside/ambiguous) →
   overfetch cap `max(ceil(t*2), t+5)` → `backfillMissingMapsPhones` →
   **`runWebsiteDiscoveryGate`** (duplicate collapse, budget only decides who gets a search,
   second-chance queries, snippet-phone attribution from own domain only).
2. **Phase 1 — Web fallback** (only if Maps short of target): `searchWithFallback`
   (Serper → DuckDuckGo) → `validateCandidate` gauntlet → `filterSearchResults` →
   ambiguous residue classified by **search-worker agent** (30s) → stop conditions.
3. **Finalize:** builds canonical `ResearchCandidate`s (`buildResearchCandidates`,
   entity resolution with 0 tokens; web-only candidates never get GPS) and writes
   `0-website-discovery.json`, `0-research-candidates.json`, `0b-research-candidates-lean.json`.

### 2.5 Synthesis pipeline (Step 4, in order)

```
finalizeCacheHit (if fromCache) ── skips synthesis, writes artifacts + 'cache-hit' run record,
                                   NEVER upsertBusinesses
else:
buildSupervisorPrompt → Layer 2 supervisor agent (agentId || gemma, 20s)
  → on failure Layer 3 buildFallbackListing (zero-token deterministic constructor)
  → Zod-validate → drop geo-excluded
  → Maps re-injection (GPS/rating/placeId) + preserve omitted candidates
  → sanitizeListingWithEvidence → mergeDuplicateEntities
  → normalizeListingPhones (phones ∩ mobiles = ∅; hard phone-collision throw)
  → detectCrossListingConflicts → entity-conflicts.json
  → computeConfidenceBreakdown + validateConfidenceIntegrity
  → zero-actionable filter → quality cap (applyTargetCandidatesCap)
  → upsertBusinesses + saveRunRecord (MongoDB; never throws — skipped_mongo_down)
  → candidate ledger (per-candidate LedgerStatus) → summary-report.json → endRunSession
```

### 2.6 Artifact catalog

| Stage | Artifact | Destination |
|---|---|---|
| 0 | `0-website-discovery.json`, `0-research-candidates.json`, `0b-research-candidates-lean.json` | root mirror + `output/history/<runId>/` |
| 1 | `1-broad-search.json` | same |
| 2 | `2-deep-extractions.json`, `2b-verified-evidence.json` | same |
| 3 | `3-final-listings.json`, `results.json` | mirror + history + **`output/latest/businesses.json`** |
| side | `entity-conflicts.json`, `candidate-ledger.json`, `summary-report.json` | mirror + history (+ `output/latest/summary-report.json`) |

`output-storage.service.ts` owns the **dual-folder write**: every `saveStageOutput` call lands in
the run's `output/history/<ISO-runId>-<slug>/` archive and the `output/` root mirror; finals are
additionally promoted to `output/latest/`. Never throws.

### 2.7 Cache-first guard (M1)

```
Step 1 open:
  refresh === true                    → skip lookup (run full, then replace snapshot)
  Mongo down / no MONGODB_URI         → cacheLookupStatus = 'skipped_mongo_down', run proceeds
  runs.lookupFreshRun(query, cfg)     → hit?  computeFreshRunCachePolicy → normalized query key
                                          + location + freshness window
                                        hit:  cachedListings injected, fromCache=true,
                                              Steps 2–4 pass through → finalizeCacheHit
                                        miss: full pipeline; Step 4 saves run snapshot
```

Freshness policy (`src/config/freshness.config.ts`): **precedence** `input.maxCacheAgeDays` >
env `CACHE_MAX_AGE_DAYS` > per-category window (restaurants/cafés 14 d, barber/salon 30 d,
lawyers 90 d, schools 180 d) > default **30 d**. Guards that key off `fromCache`:
human-review skip (Step 2), Tavily skip (Step 3), finalize path (Step 4).

---

## 3. Storage architecture

### 3.1 Five stores

| Store | Medium | Contents | Lifetime | Failure behavior |
|---|---|---|---|---|
| Search cache | `.cache/search-results.json` | Serper/DDG/Tavily responses, 7-day TTL, SHA-256 `provider::query` key | local, gitignored | miss → live call |
| Geocode cache | `.cache/geocoding/*.json` + in-memory Map | OSM Nominatim results | local, gitignored | miss → live call |
| MongoDB — `businesses` | `mongodb://localhost:27017/business_directory` | merged business identities | persistent | **never throws** (`skipped_mongo_down`) |
| MongoDB — `runs` | same DB | exact per-run snapshot = cache payload | persistent | same |
| Output | `output/latest/` + `output/history/<runId>/` | JSON artifacts + final listings | local, gitignored | never throws |
| LibSQL | `mastra.db` (+ `-wal`, `-shm`) | Mastra agent memory | local, gitignored (`*.db*`) | non-fatal |

### 3.2 MongoDB schema (`src/services/storage/mongo.service.ts`, 651 L)

**`businesses`** — one document per merged identity:

- `canonicalKey` — **unique index**; built from `normalizeNameKey` + `normalizePhoneDigits` +
  `domainFromUrlOrHost` (shared with the dedup cascade — same normalizers, no second algorithm).
- `geo.coordinates` — **2dsphere index** (optional; only when GPS known).
- Contacts accumulate with `$addToSet` on upsert — **never clobbers** existing
  phones/emails/socials; `firstSeenAt` frozen, `lastSeenAt` refreshed.
- Indexed: `canonicalKey`, `geo`, `category`, `lastSeenAt`.

**`runs`** — one document per run: `{ runId, query, location, savedAt, policy, payload: listings[] }`
where `payload` is the exact cache-pass-through shape the guard injects. `lookupFreshRun`
selects the newest non-stale run for the normalized query+location.

**Contract:** 1.5 s driver timeouts; `ensureIndexes()` on startup; down ⇒
`cacheLookupStatus='skipped_mongo_down'`, full run proceeds, seedable later via
`npm run db:seed` (rebuilds `businesses` from `output/history`; 2nd pass idempotent, 0 inserted).

### 3.3 Output layout

```
output/
├── latest/                    # consumable current state (overwritten each run)
│   ├── businesses.json        # BusinessListing[] — the product
│   └── summary-report.json    # KPIs, cache status, telemetry counters
├── history/<ISO-runId>-<slug>/  # immutable audit trail: all stage 0–3 artifacts
└── <stage file>.json            # root mirror of the most recent run
```

---

## 4. Source architecture

### 4.1 Layered tree with line counts

```
src/  (120 TS files, 20,278 lines)
├── types/          12 files     948 L   Contract schemas — zero runtime deps
├── config/          8 files   1,450 L   Pure policy — no I/O
├── lib/             1 file       43 L   Pure utilities (geo-distance leaf)
├── services/       77 files  15,266 L
│   ├── (root)      27 files     237 L   Backward-compat facades (re-exports)
│   ├── external/    5 files     804 L   Network edge (Serper/Tavily/OpenRouter/UnoRouter)
│   ├── discovery/   7 files   3,484 L   Maps/web search, gate, ranker, discovery engine
│   ├── extraction/ 16 files   3,569 L   Phone/email/social/branch/page + social stage modules
│   ├── observability/ 1 file    149 L   Structured per-step run logging
│   ├── resolution/ 16 files   5,927 L   Identity, geography, verification, confidence
│   └── storage/     5 files   1,096 L   MongoDB, output, cache, ledger, LibSQL
└── mastra/         22 files   2,571 L
    ├── index.ts               43 L   Mastra app registration
    ├── agents/    9 files     222 L   3 agents + 4 schemas (+ 2 prompt.md)
    ├── tools/     4 files     186 L   broad-search, deep-extract, google-maps-search
    └── workflows/ 8 files   2,120 L   composer (109) + contracts (92) + steps (1,784) + prompts (135)
```

### 4.2 Dependency rules & cycle hygiene

```
scripts/ (leaf consumers, tsx)
   → src/mastra/index.ts → 3 agent configs → 3 tools
   → src/mastra/workflows/research-workflow.ts → services (direct calls)
src/services/* (engine layer, cross-imports allowed within layer discipline)
   → src/config + src/types + src/lib   (policy/contract layer — never imports upward)
```

- **0 circular dependencies** (`npx madge --circular --extensions ts --ts-config tsconfig.json src`).
- The former `geocoding ↔ geographic-evaluator` cycle was broken by extracting
  `src/lib/geo-distance.ts` (pure haversine); the evaluator re-exports
  `calculateHaversineDistanceKm` for compatibility.
- `types/discovery-state.ts` is a deliberate zero-dependency schema island (original
  ESM-init cycle breaker).
- `research-workflow → mastra/index` stays a **dynamic** import (agent resolution at runtime).
- `mongo.service → research-workflow` is `import type` only (type-only edge).
- **27 facade files** at `services/*.service.ts` root: pure `export * from '@/services/<layer>/…'`
  re-exports (plus canonical `telemetry.service.ts` which keeps its implementation at root).
  Verified by `scripts/fixtures/golden/check-shim-exports.ts` (reference identity PASS).

### 4.3 Module inventory

**`src/types/`** — contracts (file: lines)

| File | L | Owns |
|---|---|---|
| `verification.ts` | 268 | Verified evidence, confidence breakdown |
| `research-candidate.ts` | 162 | Candidate pool shape + invariants |
| `contact.ts` / `social.ts` | 90 / 55 | Contact & social profile contracts |
| `search.ts` | 82 | Unified search result schemas |
| `business-listing.ts` | 67 | **`businessListingSchema`** (the output contract) |
| `runs.ts` / `run-summary.ts` / `ledger.ts` | 55 / 37 / 16 | Run records, summary, candidate ledger |
| `discovery-state.ts` | 47 | `DiscoveryState` enum + provenance (cycle island) |
| `research-input.ts` / `index.ts` | 32 / 21 | Input schema, barrel |

**`src/config/`** — policy (file: lines)

| File | L | Policy |
|---|---|---|
| `token-vocabulary.config.ts` | 340 | Category/industry/locality token vocabularies |
| `geo-localities.config.ts` | 233 | OSM centroids, ward aliases (Satungal = Chandragiri W11–13) |
| `directory-domains.config.ts` | 201 | **Single source of truth** directory/aggregator blocklist |
| `website-discovery.config.ts` | 190 | Budget: production 10/run, benchmark ≤ hard cap 50 |
| `category-expansion.config.ts` | 136 | Broad vs narrow query-expansion ontology |
| `freshness.config.ts` | 132 | M1 freshness windows + env override + key normalization |
| `nepal-telecom.config.ts` | 75 | NTA numbering plan (96x/97x/98x, area codes) |
| `index.ts` | 13 | Barrel |

**`src/services/external/`** — network edge (file: lines)

| File | L | Endpoint / role |
|---|---|---|
| `serper-places.service.ts` | 249 | Google Maps/Places (+ phone backfill), disk-cached |
| `tavily-extract.service.ts` | 230 | Page extraction, ≤5 URLs/call, retry at `advanced` depth |
| `unorouter.service.ts` | 197 | UnoRouter: sequential fallback chain + **Consensus Tribunal** |
| `serper-search.service.ts` | 80 | Google web search (`country=np`) |
| `openrouter.service.ts` | 38 | OpenRouter provider, Gemma free models |

**`src/services/discovery/`** (file: lines)

| File | L | Responsibility |
|---|---|---|
| `research-discovery.service.ts` | 894 | **Discovery engine** (Phases 0/1 + candidate finalize) |
| `website-discovery-gate.service.ts` | 709 | Universal evaluation gate, budget, second-chance queries |
| `website-search-ranker.service.ts` | 620 | Zero-HTTP URL ranker; `MIN_FIRST_PARTY_SCORE=40`, third-party −100 |
| `search-fallback.service.ts` | 441 | Serper→DDG orchestrator, shared search contract, query expansion |
| `website-discovery.service.ts` | 437 | Official-site page discovery (markdown → HTML → guessed paths) |
| `url-filter.service.ts` | 244 | eTLD+1, directory-subdomain hosters, official-first ordering |
| `maps-discovery.service.ts` | 128 | Multi-page Maps pagination, 4 stop reasons, injectable fetch |

**`src/services/extraction/`** (file: lines) — *all pure/deterministic, no LLM by default*

| File | L | Responsibility |
|---|---|---|
| `social-extractor.service.ts` | 18 | Facade re-exporting the 5 social stage modules below |
| `social-classify.ts` | 809 | `classifySocialProfile` decision path (accepted/rejected/unknown + forensic reason) |
| `phone-extractor.service.ts` | 542 | NTA phone pools, mobile/landline classification, formatting |
| `page-extractor.service.ts` | 646 | `extractAllFromPages` orchestrator |
| `contact-extractor.service.ts` | 421 | Emails + **9-row contact-role matrix** (primary/branch/staff/…) |
| `content-normalization.service.ts` | 286 | Page text normalization for downstream matching |
| `social-url.ts` | 134 | Handle parsing + canonical social URL construction |
| `social-validation.ts` | 84 | Structural `isRealSocialProfile` check |
| `social-links.ts` | 78 | Structured social link extraction from page content |
| `social-ownership.ts` | 72 | `isBusinessOwnedSocialProfile` + batch classification |
| `branch-extractor.service.ts` | 177 | Structured branch-block extraction (Phase 8k) |
| `extraction-regex.ts` | 122 | Shared regex pools (emails/phones/media) |
| `category-token.service.ts` | 67 | `resolveCategoryKey` |
| `page-type.service.ts` / `raw-html.service.ts` | 52 / 47 | Page-type classification, raw-HTML safety net |
| `index.ts` | 14 | Barrel (facade target) |

**`src/services/resolution/`** (file: lines)

| File | L | Responsibility |
|---|---|---|
| `entity-resolution.service.ts` | 14 | Facade re-exporting the 3 entity modules below |
| `entity-conflicts.ts` | 1,126 | Conflict detection, union-find merge, Phase 8k branch attribution, unattributed-contacts guard |
| `entity-matching.ts` | 426 | Matching cascade (phone/domain vetoes, Jaccard) + dedupe + website-lookup ranking |
| `entity-normalizers.ts` | 205 | Phone/name/domain/address normalizers + identity-signal predicates |
| `listing-sanitizer.service.ts` | 779 | `sanitizeListingWithEvidence` — evidence-bound listing sanitation |
| `website-relationship.service.ts` | 450 | URL↔business relationship (first_party … unrelated) + lifecycle |
| `candidate-classifier.service.ts` | 402 | 0-LLM SERP classification + tri-state category gate |
| `fallback-listing.service.ts` | 391 | Layer-3 zero-token listing constructor |
| `geographic-evaluator.service.ts` | 367 | 5-layer locality decision, street-collision guard; re-exports haversine |
| `research-candidate.service.ts` | 346 | Candidate building, GPS invariant (web-only ⇒ no GPS) |
| `verification.service.ts` | 338 | Evidence cross-check → `verified\|partial\|weak\|failed` |
| `geocoding.service.ts` | 327 | Nominatim geocoder, two-level cache, radius formula |
| `confidence.service.ts` | 252 | Maps .30 / website .35 / contact .35 weights + integrity validator |
| `candidate-validation.service.ts` | 251 | 5-stage validation gauntlet (name/country/geo/address/directory) |
| `social-completion.service.ts` | 167 | Phase 0 social discovery ingestion + validation (added by `ef5ba21`) |
| `cascade-policy.service.ts` | 86 | Rejection-cascade semantics (M2C) |

**`src/services/storage/`** (file: lines)

| File | L | Responsibility |
|---|---|---|
| `mongo.service.ts` | 706 | Cache-first lookup, `businesses` upsert, `runs` snapshots, indexes, health probe |
| `output-storage.service.ts` | 203 | Dual-folder writes, run session, summary report |
| `cache.service.ts` | 79 | `.cache/search-results.json` KV, 7-day TTL, write queue |
| `candidate-ledger.service.ts` | 49 | Per-candidate outcome ledger |
| `db.service.ts` | 59 | Project-root discovery → LibSQL store factory |

**`src/mastra/`**

| File | L | Role |
|---|---|---|
| `workflows/research-workflow.ts` | 109 | Composer: cache guard + 4 `.then()` steps + persistence wiring |
| `workflows/workflow-contracts.ts` | 92 | Shared schemas (`businessListingSchema`, `cachePassthroughSchema`, …) |
| `workflows/steps/*.ts` | 1,784 | Step bodies: research-agent (160), human-review (129), deep-extraction (524), supervisor-synthesis (851), finalize-cache-hit (120) |
| `workflows/research-prompts.ts` | 135 | Supervisor prompt builders |
| `agents/search-worker/config.ts` | 48 | Ambiguous-SERP classifier (6-class rubric), own `prompt.md` |
| `agents/gemma-supervisor/config.ts` | 39 | Primary synthesis agent (OpenRouter Gemma), own `prompt.md` |
| `agents/uno-supervisor/config.ts` | 38 | Alternate synthesis agent (UnoRouter) |
| `agents/research-agent/*.schema.ts` | 89 | Input/verification/contact/social Zod contracts (schemas only — no agent) |
| `tools/broad-search.ts` | 69 | `searchWithFallback` + writes `1-broad-search.json` |
| `tools/deep-extract.ts` | 55 | `tavilyExtract` (≤5 URLs) + writes `2-deep-extractions.json` |
| `tools/google-maps-search.ts` | 55 | `searchSerperPlaces` + place schema |
| `index.ts` | 43 | Registers 3 agents + `researchWorkflow`; stderr noise suppression |

---

## 5. Agents, tools & LLM budget

| Agent | Model | Tools | Trigger |
|---|---|---|---|
| `gemma-supervisor-agent` (default) | `gemma-4-26b-a4b-it:free` via OpenRouter | all 3 | Step 4 synthesis, 20 s race |
| `uno-supervisor-agent` | `gemini-3.5-flash-lite:free` via UnoRouter | all 3 | selectable via `agentId` (shares gemma's `prompt.md`) |
| `search-worker-agent` | `gemini-3.5-flash-lite` | broad-search + maps | Phase 1 ambiguous SERP classification, 30 s |

**Hard budget per run:** 1 synthesis call (Layer 2) → on failure Layer 3 deterministic fallback
(no LLM); 1 ambiguous-classification call; extraction escape hatch capped at **10 LLM calls /
run** with 5 s abort (`detectMultiBusinessPage…WithLlmFallback`). All tool wrappers degrade to
well-formed empty responses on error — tools never break the workflow.

---

## 6. Data contract (`output/latest/businesses.json`)

`BusinessListing` (`src/types/business-listing.ts`, `businessListingSchema`) — top-level fields:

`name` · `location` · `emails[]` · `phones[]` · `mobiles[]` · `websites[]` · `icon` ·
`socialLinks` · `otherDetails` · `metadata` · `process` · `links` · `gpsCoordinates` · `rating` ·
`ratingCount` · `businessType` · `placeId`

`metadata` carries `confidence` (overall), `confidenceBreakdown` (maps/website/contact with
weights), relationship classification, provenance and run bookkeeping. Invariants enforced in
Step 4: `phones ∩ mobiles = ∅`, `metadata.confidence === overallConfidence`,
geo-excluded listings dropped, zero-actionable listings filtered.

---

## 7. Test strategy & quality gates

### 7.1 Two tiers

| Command | Suites | Scope |
|---|---|---|
| `npm test` | **20 (tracked in git)** | ranker, second-chance, discovery gate/budget, snippet-phone attribution, negative-directory contamination, ever-vision, satungal sweep defects, MongoDB service, M2a/b/c suites, phase8 geography/evaluator/reconciliation, phase8b aggregation, **multi-category false-merge guards**, geocoding cache-path, address revalidation |
| `npm run test:full` | **34** | 20 core + 14 phase regression suites (7c, 8d–8o, w207/w208) — **local-only, gitignored** |

All suites are offline/deterministic (injected fetch, fixture data); `test-mongo-service` skips
cleanly (exit 0) when MongoDB is unreachable.

### 7.2 Release gates (all must pass before merge)

```bash
npm run typecheck                                              # tsc strict → 0 errors
npm run spellcheck                                             # cspell (930 words) → 0 issues
npm test                                                       # 20/20
npm run test:full                                              # 34/34
npx tsx scripts/fixtures/golden/replay-golden.ts               # offline replay → 0 drift
npx tsx scripts/fixtures/golden/check-shim-exports.ts          # shim reference identity → ALL PASSED
npx madge --circular --extensions ts --ts-config tsconfig.json src   # → 0 cycles
```

Optional smoke: `npm run dev` twice — the second run must log
`[cache] lookup … hit` and complete without Tavily calls.

### 7.3 Golden harness (`scripts/fixtures/golden/`, tracked)

`replay-golden.ts` + `input/` fixtures + `expected/` snapshots — replays the deterministic
extraction/synthesis path offline and diffs against golden output (`compare.ts`,
`snapshot-tree.ts`); `test-phase4-facade-compatibility.ts` proves the pre-split export surface
is byte-identical after the service regrouping.

---

## 8. Configuration & environment

### 8.1 npm scripts

| Script | Command |
|---|---|
| `dev` / `start` | `mastra dev` (Studio UI + API) |
| `typecheck` | `tsc -p tsconfig.json` |
| `spellcheck` | `cspell lint "src/**/*.{ts,md}" "scripts/**/*.ts" "README.md" "ARCHITECTURE.md" "CONTRIBUTING.md"` |
| `test` | 20 core suites, chained `tsx` |
| `test:full` | all 34 suites, chained `tsx` |
| `db:seed` | `tsx scripts/seed-mongo-from-output.ts` |
| `test:mongo`, `test:m2a`, `test:m2b`, `test:m2c-*`, `test:phase8*`, `test:phase7c-defects`, `test:satungal` | individual suite runners |

### 8.2 Environment (`.env.example`)

| Key | Required | Purpose |
|---|---|---|
| `SERPER_API_KEY` | ✅ | Google Search + Maps |
| `TAVILY_API_KEY` | ✅ | Page extraction |
| `OPENROUTER_API_KEY` | ✅ | Gemma supervisor |
| `GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY` | ✅ | alternate providers |
| `UNOROUTER_API_KEY` / `UNOROUTER_BASE_URL` | optional | Uno supervisor |
| `DISCOVERY_MODE` | optional | `production` \| `benchmark` (gate throws only in benchmark on invariant failure) |
| `MONGODB_URI`, `MONGODB_DB_NAME` | optional | enable M1 cache + runs history |
| `CACHE_MAX_AGE_DAYS` | optional | freshness window override |

---

## 9. Repository hygiene (tracked vs local-only)

**Tracked (164 files):** `src/**` (120 TS + 2 agent prompts), 20 core test suites,
golden harness (`scripts/fixtures/golden/**`), 10 root files
(`README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `package.json`, `package-lock.json`,
`tsconfig.json`, `cspell.json`, `.gitignore`, `.env.example`, `skills-lock.json`).

**Local-only (gitignored):**

| Path | Why |
|---|---|
| `.env` | secrets |
| `output/`, `.cache/`, `.mastra/`, `*.db*`, `mastra.db` | runtime artifacts |
| `scripts/test-*.ts` (14 phase suites), `scripts/run-*.ts`, `scripts/seed-*.ts`, `scripts/probe-*.ts` | phase regression suites + benchmarks — run via `test:full` / `tsx` |
| `scripts/phase4-freeze/`, `scripts/phase4-slicing/`, 4 one-shot refactor scripts, 5 golden one-shots | refactoring tooling, removed from version control |
| `docs/` | deleted entirely (untracked + removed from disk + ignored) |

The service facades, `types/` contracts and `lib/` leaf are permanent: they are the stable
import surface (`@/services/...` legacy paths, `@/types/...`, `@/lib/...`).

---

## 10. Known limitations / non-defects

1. **The former `src/mastra/public/.cache/` stray file is gone** — `geocoding.service` now
   root-anchors its cache directory via `getProjectRootDir()` (commit `ed1b856`), so runs
   write to `<repo>/.cache/geocoding/` regardless of `process.cwd()`.
2. **`uno-supervisor` shares `gemma-supervisor/prompt.md`** — no uno-specific prompt exists;
   intentional simplification, not a bug.
3. **`scripts/run-*` / `probe-*` have no npm wiring** — executed manually via `tsx scripts/<file>`.
4. **MongoDB is optional by design** — every Mongo path degrades to `skipped_mongo_down` and the
   run completes; storage is an optimization (cache) + history, never a dependency.
5. **LLM output is advisory** — a failed/invalid synthesis always falls through to Layer 3
   `buildFallbackListing`, so a run can never end empty-handed because of a provider outage.
6. **Large-file watchlist:** `entity-conflicts.ts` (1,126 L), `social-classify.ts` (809 L),
   `supervisor-synthesis-step.ts` (851 L) — all well below the 1,700-line gate (the former
   3,981-line workflow is fully split).
