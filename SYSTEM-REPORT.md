# SYSTEM REPORT — `searchDump` (Agentic Business Discovery & Extraction Engine)

> Generated: 2026-09-26 · Full file/folder structure, per-file responsibilities, import graph, line counts.

---

## 1. What this system is

A **Mastra-based agentic pipeline** that discovers local businesses (Nepal/Kathmandu focus) by fusing Google Maps Places + organic web search, verifies them against official websites, and emits structured, confidence-scored business listings.

**Stack:** TypeScript (ESM) · Mastra 1.x (workflow/agent framework) · Serper.dev (Google Search + Maps) · DuckDuckGo (fallback) · Tavily Extract (page crawling) · OpenRouter + UnoRouter (free LLMs) · MongoDB (optional cache/history) · LibSQL (`mastra.db`) for agent memory · Zod for all schemas.

**Scale:** 46 source TS files (16,740 lines) + 48 script TS files (10,293 lines) = **~27,000 lines of TypeScript**, plus 426-line README, 949-line cspell dictionary.

---

## 2. Top-level folder structure

```
searchDump/
├── .agents/skills/mastra/        Agent skill docs (SKILL.md 84L + 9 reference MDs, ~1,270L) — tooling, not app code
├── .cache/                       RUNTIME CACHE (gitignored)
│   ├── search-results.json       7-day shared disk cache (Serper/DDG/Tavily) — 3.2 MB
│   └── geocoding/*.json          2 OSM Nominatim geocode results
├── .mastra/                      Mastra BUILD OUTPUT (gitignored)
│   ├── .build/, bundler-config, mastra-packages.json
│   └── output/                   bundled .mjs + Studio UI (index.html, assets/, routes-manifest.json)
├── output/                       PIPELINE ARTIFACTS (gitignored)
│   ├── latest/                   businesses.json, summary-report.json, entity-conflicts.json (overwritten each run)
│   ├── history/<ISO-runId>-<slug>/  11 archived runs (full stage-by-stage audit trail)
│   └── 0-…1-…2-…3-*.json         root mirror of last run's stage artifacts
├── scripts/                      48 TS test/benchmark/probe/seeder scripts + fixtures/
├── src/
│   ├── config/                   6 pure config/policy modules (915 L)
│   ├── services/                 27 service modules (11,634 L) — the engine
│   └── mastra/                   framework wiring (4,191 L)
│       ├── index.ts              Mastra app instance
│       ├── agents/               3 agents + 4 schema files + 2 prompt.md
│       ├── Tools/                3 Mastra tools
│       ├── workflows/            research-workflow.ts (3,981 L — the core)
│       └── public/               Mastra static dir (currently holds an accidental geocode cache)
├── mastra.db / -wal / -shm       LibSQL agent memory store (393 MB + 114 MB WAL)
├── .env / .env.example           secrets (gitignored) / 15-line template
├── cspell.json                   949-line spell-check dictionary
├── package.json (51 L)           scripts + deps
├── tsconfig.json (16 L)          ES2022, strict, noEmit, bundler resolution
├── README.md (426 L)             architecture doc
├── skills-lock.json (11 L)       pinned mastra skill hash
└── .gitignore (18 L)             ignores .env, *.db*, .mastra, .cache, output/, scripts/, tests/
```

> **.gitignore quirk:** it ignores `scripts/`, `tests/`, `fixtures/` — yet `scripts/` is tracked and present.

---

## 3. Source tree with line counts

```
src/  (46 files, 16,740 lines)
├── config/                          6 files,   915 lines
│   ├── category-expansion.config.ts        132
│   ├── directory-domains.config.ts         196
│   ├── freshness.config.ts                 120
│   ├── geo-localities.config.ts            227
│   ├── nepal-telecom.config.ts              72
│   └── website-discovery.config.ts         168
├── services/                       27 files, 11,634 lines
│   ├── business-extractor.service.ts     3348   ◀ largest service
│   ├── entity-resolution.service.ts      1381
│   ├── website-discovery-gate.service.ts  655
│   ├── mongo.service.ts                   612
│   ├── website-search-ranker.service.ts   565
│   ├── search-fallback.service.ts         458
│   ├── website-relationship.service.ts    415
│   ├── website-discovery.service.ts       391
│   ├── candidate-classifier.service.ts    358
│   ├── geographic-evaluator.service.ts    346
│   ├── research-candidate.service.ts      321
│   ├── verification.service.ts            312
│   ├── geocoding.service.ts               277
│   ├── candidate-validation.service.ts    228
│   ├── url-filter.service.ts              224
│   ├── serper-places.service.ts           221
│   ├── confidence.service.ts              220
│   ├── output-storage.service.ts          209
│   ├── tavily-extract.service.ts          202
│   ├── unorouter.service.ts               173
│   ├── maps-discovery.service.ts          114
│   ├── serper-search.service.ts            70
│   ├── cache.service.ts                    66
│   ├── telemetry.service.ts                53
│   ├── discovery-state.service.ts          41
│   ├── openrouter.service.ts               35
│   └── db.service.ts                       24   ◀ smallest service
└── mastra/                         13 files,  4,191 lines
    ├── index.ts                            36
    ├── workflows/research-workflow.ts    3981   ◀ largest file in repo
    ├── Tools/
    │   ├── broad-search.ts                 64
    │   ├── google-maps-search.ts           53
    │   └── deep-extract.ts                 50
    └── agents/
        ├── research-agent/
        │   ├── verification.schema.ts     247
        │   ├── schema.ts                  157
        │   ├── contact.schema.ts           81
        │   └── social.schema.ts            50
        ├── search-worker/config.ts         42  (+ prompt.md 62)
        ├── gemma-supervisor/config.ts      33  (+ prompt.md 73)
        ├── uno-supervisor/config.ts        32
        └── search-agent.ts                  1  (dead re-export)
```

---

## 4. `src/config/` — pure policy, zero runtime deps

| File | L | What it does | Exports | Imported by |
|---|---|---|---|---|
| `category-expansion.config.ts` | 132 | Per-category query-expansion ontology (broad vs narrow), Phase 4. Declares discovery/positive/distinctive/business-form/excluded terms + `maxTotalQueries`. | `CategoryExpansionPolicy`, `CATEGORY_EXPANSION_POLICIES`, `BROAD_QUERY_PATTERNS`, `CATEGORY_STEM_MAPPINGS` | `search-fallback.service` |
| `directory-domains.config.ts` | 196 | **Single source of truth** blocklist of directory/document/platform domains (created to stop two services drifting apart). | `DOCUMENT_PLATFORM_DOMAINS`, `EXTRA_DIRECTORY_DOMAINS`, `SHARED_DIRECTORY_DOMAINS` | `candidate-classifier.service`, `website-relationship.service` |
| `freshness.config.ts` | 120 | M1 cache freshness policy: default 30 days, per-category windows (restaurants 14, lawyers 90, schools 180), env override `CACHE_MAX_AGE_DAYS`, key normalization. | `DEFAULT_MAX_AGE_DAYS`, `MAX_AGE_DAYS_BY_CATEGORY`, `normalizeQueryKeyPart`, `lookupMaxAgeDays`, `describeLookupMaxAgeDays`, `FreshnessResolution` | `research-workflow`, `mongo.service`, `test-mongo-service` |
| `geo-localities.config.ts` | 227 | Registered locality clusters: centroids, max radii, ward aliases (e.g. Satungal = Chandragiri Wards 11–13). Prevents municipality-wide false accepts. | `LocalityClusterConfig`, `REGISTERED_LOCALITY_CLUSTERS`, `normalizeLocalityString`, `findRegisteredLocalityCluster` | `research-workflow`, `seed-mongo-from-output`, `test-mongo-service`, `test-phase8h-w208` |
| `nepal-telecom.config.ts` | 72 | NTA numbering reference (provenance: NTA Numbering Plan 2079). Mobile 10-digit prefixes (96x/97x/98x), landline area codes (01 KTM, 061 Pokhara…). | `NEPAL_COUNTRY_CODE`, `NTA_MOBILE_PREFIXES`, `NTA_LANDLINE_AREA_CODES` | `business-extractor.service`, `entity-resolution.service` |
| `website-discovery.config.ts` | 168 | Discovery **budget** policy: production = 10 lookups/run, benchmark = all eligible clamped to hard ceiling 50. Explicitly scoped: budget ≠ evaluation ≠ deep-extraction cap. | `WebsiteDiscoveryMode`, `PRODUCTION_DEFAULT_WEBSITE_DISCOVERY_LOOKUPS`, `ABSOLUTE_MAX_WEBSITE_DISCOVERY_LOOKUPS`, `resolveWebsiteDiscoveryBudget`, `resolveWebsiteDiscoveryMode`, `formatWebsiteDiscoveryBudgetLog` | `research-workflow`, `website-discovery-gate.service`, `test-website-discovery-budget` |

---

## 5. `src/services/` — the engine (27 files, 11,634 lines)

### 5.1 External API clients (network edge)

| File | L | What it does | Exports | Imported by |
|---|---|---|---|---|
| `serper-search.service.ts` | 70 | Google **web** search client. `POST https://google.serper.dev/search`, `X-API-KEY`, defaults `country='np'`, `language='en'`, 10 results. Throws if `SERPER_API_KEY` missing. **Not cached here.** | `SerperResult`, `SerperSearchResponse`, `searchSerper` | `search-fallback.service` |
| `serper-places.service.ts` | 221 | Google **Maps/Places** client. `searchSerperPlaces` (POST `/maps`, falls back to `/places` on page>1 failure, returns `[]` never throws); `lookupSerperMapsPlace` (single detail); `backfillMissingMapsPhones(places, loc, max=20)`. Disk-cached under provider `serper-places`. | `SerperPlaceResult`, `searchSerperPlaces`, `lookupSerperMapsPlace`, `backfillMissingMapsPhones` | `maps-discovery`, `website-discovery-gate`, `google-maps-search` tool, `research-workflow`, `entity-resolution` (type), `research-candidate` (type), 6 scripts |
| `tavily-extract.service.ts` | 202 | Page-content extraction. `POST https://api.tavily.com/extract`, max 5 URLs/call, auto-retry at `advanced` depth when basic fails or content <150 chars. Timeouts 25s/30s. Caches only >100-char successes. | `tavilyExtract`, `TavilyExtraction`, `TavilyExtractResponse`, `TavilyExtractOptions` | `deep-extract` tool, `research-workflow` |
| `search-fallback.service.ts` | 458 | **The search orchestrator + shared search contract.** Serper-first → DuckDuckGo second (`duck-duck-scrape`), 10s/12s timeouts. Defines `unifiedSearchResultSchema`/`searchResponseSchema` used everywhere. URL normalization (strips `www.`, tracking params, sorts query), dedup, error classification, category-intent normalization + query expansion. Cache provider `broad-search-v2`. | `searchWithFallback`, `unifiedSearchResultSchema`, `searchMetadataSchema`, `searchResponseSchema`, `normalizeUrl`, `extractDomain`, `deduplicateResults`, `withTimeout`, `classifyProviderError`, `normalizeCategoryIntent`, `expandCategoryQueries`, `CategoryIntent`, `ExpandedQuery` | `broad-search` tool, `research-workflow`, `research-agent/schema`, `business-extractor`, `candidate-classifier`, `entity-resolution`, `research-candidate`, `website-discovery`, 1 script |

### 5.2 LLM providers

| File | L | What it does | Exports | Imported by |
|---|---|---|---|---|
| `openrouter.service.ts` | 35 | OpenRouter AI-SDK provider factory for **Gemma** free models. `FREE_MODELS` = gemma-4-26b-a4b-it:free, gemma-4-31b-it:free, nemotron-3-super-120b, nex-n2.5-pro. `allow_fallbacks: true`. Throws without `OPENROUTER_API_KEY`. | `FREE_MODELS`, `getGemmaModel` | `gemma-supervisor/config` only |
| `unorouter.service.ts` | 173 | UnoRouter gateway with **two resilience strategies**: (a) sequential model fallback chain (Gemini 3.5 → Step, 4s timeouts), (b) **AI Consensus Tribunal** — Expert 1 + Expert 2 in parallel → Arbiter Judge reconciles two JSON drafts, with degrade paths A–D. | `UNO_FREE_MODELS`, `getUnoRouterProvider`, `getUnoModel`, `generateWithUnoFallback`, `generateWithUnoTribunal`, `UnoFallbackOptions`, `UnoTribunalOptions` | `uno-supervisor/config` only |

> Note: the workflow's Layer-1 tribunal was **removed** — synthesis now uses Layer 2 (supervisor agent, 20s) → Layer 3 (deterministic fallback).

### 5.3 Discovery / search ranking

| File | L | What it does | Key exports | Imported by |
|---|---|---|---|---|
| `maps-discovery.service.ts` | 114 | Multi-page Maps pagination with 4 stop reasons (`target_reached`, `maps_exhausted`, `max_pages_reached`, `stale_limit_reached`), counting **unique** candidates. Injectable `fetchPlaces` for offline tests. | `paginateMapsDiscovery`, `MapsPaginationStopReason`, `PaginateMapsDiscoveryParams/Result` | `research-workflow`, `test-m2a` |
| `research-candidate.service.ts` | 321 | Builds canonical `ResearchCandidate`s from Maps places + web results using 0-token entity resolution. Enforces invariants (web-only candidates never get GPS). | `buildResearchCandidates`, `toUnifiedCandidates` | `maps-discovery`, `research-workflow`, 6 scripts |
| `candidate-classifier.service.ts` | 358 | Deterministic (0-LLM) classification of SERP results into usable/excluded/ambiguous + tri-state category-relevance gate with fixed confidences (0.00/1.00/0.95/0.90/0.85/0.30). Huge domain dictionaries. | `classifySearchResult`, `filterSearchResults`, `checkCategoryRelevance`, `AGGREGATOR_DOMAINS`, `DIRECTORY_DOMAINS`, `SOCIAL_DOMAINS`, `CONTENT_TRAVEL_DOMAINS`, `RelevanceStatus` | `research-workflow`, `entity-resolution`, `website-search-ranker`, 5 scripts |
| `website-search-ranker.service.ts` | 565 | **Zero-HTTP deterministic URL ranker.** Weighted token scoring: name +12, domain bonus +10, location +10, TLD 12/8/4/2, third-party **−100** (unbeatable), unrelated −40; `MIN_FIRST_PARTY_SCORE = 40`. Hard usability gate runs *before* scoring. Includes `isThirdPartyDomain`, `looksThirdPartyUrl`, tiered-corroboration rules, Nepal phone-corroboration regexes. | `rankWebsiteSearchResults`, `selectFirstPartyWebsiteUrl`, `scoreCandidate`, `RANK_WEIGHTS`, `isThirdPartyDomain`, `looksThirdPartyUrl`, `distinctiveNameTokens`, `locationTokens`, `requiredNameOverlap`, `resolveDynamicGenericTokens` | `research-workflow`, `website-discovery-gate`, `website-relationship`, 13 scripts — **most-imported ranker in repo** |
| `website-discovery-gate.service.ts` | 655 | **Universal evaluation gate.** Every Maps candidate gets an explicit `DiscoveryState`; duplicates (placeId/cid) collapse to one lookup; budget only decides who gets a search. Injects search/selector/phone-attribution (purity contract). Second-chance queries (quoted `name`+`phone`, or `site:.edu.np` for education). Snippet phones attributed **only from own domain**. Mutates input places. Throws only if state invariant fails in `DISCOVERY_MODE=benchmark`. | `runWebsiteDiscoveryGate`, `discoveryGroupKey`, `hasMapsWebsite`, `needsPhone`, `selectPhoneFromOwnDomain`, `buildSecondChanceQuery`, `isEducationCandidate`, `WebsiteDiscoveryArtifact`, `DiscoveryGateSummary`, `validateDiscoveryStateInvariant` | `research-workflow`, 7 scripts |
| `website-discovery.service.ts` | 391 | Finds best pages of an official site: homepage → same-domain links from Tavily markdown → raw HTML href fetch (Chrome UA, 10s) → guessed paths (`/contact`, `/about`… 13 fallbacks). Never throws. | `discoverWebsitePages`, `normalizeInternalUrl`, `prioritizeInternalLinks`, `extractContactLinksFromMarkdown`, `classifyPageType`, `isIgnoredWebsitePath` | `research-workflow` only |
| `url-filter.service.ts` | 224 | URL hygiene: eTLD+1 with 27 multi-part TLDs, directory-subdomain hosters (wordpress.com, wixsite.com…), ~50 blocklist regexes, `filterCandidateUrls` (official-first priority: /contact > /about > /booking). | `extractEtldPlusOne`, `isDirectoryIssuedSubdomain`, `isSocialOrDirectory`, `isGoogleMapsUrl`, `filterCandidateUrls`, `MULTI_PART_TLDS` | `research-workflow`, `entity-resolution`, `website-search-ranker` |
| `candidate-validation.service.ts` | 228 | **Phase 8g unified validation gauntlet** — 5 stages every candidate passes: artifact-name guard → country/ccTLD guard (`.in .co.in .ae .cn .pk .bd .uk` blocked unless query mentions it) → geographic locality → address sanitization → directory filtering. Plus async `revalidateExtractedCandidateAddress` (can escalate to live geocoding). | `validateCandidate`, `revalidateExtractedCandidateAddress`, `isNonBusinessArtifactName`, `CandidateValidationContext/Result` | `research-workflow`, 3 scripts |

### 5.4 Geolocation

| File | L | What it does | Key exports | Imported by |
|---|---|---|---|---|
| `geocoding.service.ts` | 277 | Dynamic OSM **Nominatim** geocoder. Static-registry-first, then `GET nominatim.openstreetmap.org/search?q=…, Nepal` (custom UA, 5s timeout). Two-level cache: in-memory Map + `.cache/geocoding/<key>.json`. Radius formula `min(max(bbox*1.25, 2.0), 8.0)` km. `extractCanonicalLocality("Tokha, Kathmandu") → "Tokha"`. | `geocodeLocality`, `extractCanonicalLocality`, `calculateBoundingBoxRadiusKm`, `BROAD_REGIONS`, `NominatimGeocodeResult` | `research-workflow`, `mongo.service`, `geographic-evaluator` (dynamic import), 3 scripts |
| `geographic-evaluator.service.ts` | 346 | **5-layer inside/outside/ambiguous decision**: exact locality text → ward/alias → GPS Haversine vs radius → conflicting non-adjacent locality → generic fallback. Street-name-collision guard (catches "Chandragiri Galli" false positives). Async escalation path does live geocoding. Emits telemetry. | `evaluateGeographicLocality`, `evaluateGeographicLocalityWithEscalation`, `calculateHaversineDistanceKm`, `isStreetNameOccurrence`, `GeographicStatus/Decision` | `research-workflow`, `candidate-validation`, `entity-resolution`, 3 scripts |

### 5.5 Extraction, verification, evidence

| File | L | What it does |
|---|---|---|
| `business-extractor.service.ts` | **3348** | The extraction workhorse. Header: *"ALL functions here are pure and deterministic. No LLM usage, ever"* — except one bounded escape hatch. ~69 exports in groups: (a) regex pools for emails/phones/media; (b) sanitizers (`sanitizeEmailString`, `sanitizePhoneString`, `formatPhoneDisplay`); (c) NTA phone classification (`classifyNepalPhone`, `extractPhones/Mobiles/Landlines`); (d) email role classification + `classifyPageType`; (e) huge token dictionaries (`UNIVERSAL_STOPWORDS`, `CATEGORY_GENERIC_TOKENS`, `INDUSTRY_GENERIC_TOKENS`) + `resolveCategoryKey`; (f) **social profile classification** (`classifySocialProfile` → accepted/rejected/unknown with forensic `rejectionReason`); (g) **9-row contact-role decision matrix** (`evaluateContactRoleMatrix` → primary_business/branch_contact/staff_person/unknown/platform); (h) multi-business page detection (`detectMultiBusinessPage`, + `…WithLlmFallback` — injected agent, **10-call/run cap**, 5s abort); (i) structured branch-block extraction; (j) orchestrator `extractAllFromPages(pages, name?, url?)`. **Imported by 14 files.** |
| `verification.service.ts` | 312 | Cross-checks candidate identity vs extracted website evidence using **the same** entity-resolution normalizers (*"deliberately NO second identity algorithm"*). Signal weights: gate .15, domain .05, name .25, phone .25, address .15, email .10, social .05 → `verified|partial|weak|failed`. `buildVerifiedEvidence` handles 3 cases (no website → free `failed` placeholder, 0 Tavily cost). Also does authoritative page-based business-name correction. | `verifyCandidateWebsite`, `buildVerifiedEvidence`, `keyOfCandidate` — imported by `research-workflow`, `test-ever-vision`, `test-phase7c` |
| `website-relationship.service.ts` | 415 | Classifies URL↔business relationship: `first_party|directory|marketplace|service_platform|corporate_parent|related_entity|unrelated|unverified`. Hard-block domains (0.95) → phrases (0.85) → paths (0.9) → token matching (first_party 0.8). Corporate brand maps (IHG/Marriott/Hyatt…), vendor fingerprints, `DIRECTORY_PHRASES`. Plus website **lifecycle** state machine + invariant validator. | `classifyWebsiteRelationship`, `determineWebsiteLifecycle`, `validateLifecycleRelationshipInvariant`, `detectVendorFromContent`, `detectIndustryPortalSignals`, `extractBusinessNameTokens`, 9 dictionary exports — imported by `verification`, `website-search-ranker`, 6 scripts |
| `confidence.service.ts` | 220 | Pure multi-dimensional confidence: weights `maps .30 + website .35 + contact .35` (maps-only: `maps*.65 + .35*.5`), relationship multipliers (first_party 1.0 → unrelated 0.05), conflict penalties (0.65–1.0), `MAPS_ONLY_FALLBACK_BASELINE = 0.5`, integrity validator. **Zero project dependencies.** | `computeConfidenceBreakdown`, `computeMapsConfidence`, `computeWebsiteEvidenceConfidence`, `computeContactConfidence`, `computeConflictPenalty`, `validateConfidenceIntegrity` — imported by `research-workflow` only |

### 5.6 Identity / dedup

| File | L | What it does |
|---|---|---|
| `entity-resolution.service.ts` | **1381** | Second-largest service. (a) Normalizers: `normalizePhoneDigits`, `normalizeNameKey`, `domainFromUrlOrHost`, `normalizeAddressKey`, `tokenJaccard`; (b) **matching cascade**: phone ≥7 digits → 1.0, official domain → 1.0, conflicting phone/domain **vetoes**, name Jaccard ≥0.85 + address ≥0.5 → 0.85, name ≥0.95 → 0.9; (c) `isUsableOfficialWebsite` + category-conflict detection (`detectBusinessCategory`/`detectWebsiteCategory`); (d) `rankWebsiteLookupTargets`; (e) cross-listing conflict detection (`detectCrossListingConflicts` — pairs + clusters, severity ranking); (f) union-find merging (`mergeDuplicateEntities`, `mergeDuplicateDomainEntities`); (g) **Phase 8k four-tier multi-branch contact attribution** (`attributeMultiBranchContacts`, `isAllContactsUnattributed`). Pure/in-memory. Philosophically: *"not matched = insufficient deterministic evidence, NOT proof of a different business."* **Imported by 18 files.** |

### 5.7 Persistence, cache, output

| File | L | What it does | Imported by |
|---|---|---|---|
| `db.service.ts` | 24 | Finds project root (walks up to `package.json`), builds `file:` URL to `mastra.db`. Exports `getProjectRootDir()` (used as the **path source by cache + output-storage**) and `createMemoryStorage(id)` → `LibSQLStore`. | `mastra/index`, 3 agent configs, `cache.service`, `output-storage`, `seed-mongo-from-output` |
| `cache.service.ts` | 66 | JSON file KV cache at `.cache/search-results.json`, 7-day TTL, SHA-256 key `provider::query` truncated to 16 chars, write-queue serialization, sync I/O. | `search-fallback`, `serper-places`, `tavily-extract` |
| `mongo.service.ts` | 612 | Optional MongoDB layer: `businesses` (merged identity, `$addToSet` accumulation, never clobbers contacts) + `runs` (exact per-run snapshot = cache payload). Cache-first `lookupFreshRun`, `upsertBusinesses`, `saveRunRecord`, `ensureIndexes` (unique `canonicalKey`, 2dsphere geo…). **Never throws into the pipeline** — Mongo down ⇒ `skipped_mongo_down`, full run proceeds. 1.5s driver timeouts. | `research-workflow`, `seed-mongo-from-output`, `test-mongo-service` |
| `output-storage.service.ts` | 209 | **Dual-folder architecture**: every stage file → `output/<file>` root mirror + `output/history/<runId>/` + selected finals → `output/latest/`. Owns the run-session (`startRunSession`/`endRunSession`) and `saveSummaryReport`. Special-cases `3-final-listings.json`/`results.json` → `latest/businesses.json`. Never throws. | `research-workflow`, both tools, 2 scripts |
| `telemetry.service.ts` | 53 | 8 in-memory counters (`streetNameCollisionsCaught`, `templateFingerprintMatches`, `directorySubdomainPenalties`, `webOnlyAmbiguousExclusions`…). No persistence. | `research-workflow`, `business-extractor`, `candidate-validation`, `website-search-ranker` |
| `discovery-state.service.ts` | 41 | **Zero-dependency schema module created specifically to break ESM init cycles** between gate/entity-resolution/search-fallback. 5-value `DiscoveryState` enum + `DiscoveryProvenance` schema (queries, top-20 URLs reviewed, selection reason, discoveredSocials). | `research-agent/schema`, `search-fallback`, `serper-places`, `website-discovery-gate` |

---

## 6. `src/mastra/` — framework wiring (4,191 lines)

### 6.1 `index.ts` (36 L)

Monkey-patches `process.stderr.write`/`console.error` (lines 3–20) to silence Studio feedback noise, then:

```ts
export const mastra = new Mastra({
  storage,
  agents: { searchWorkerAgent, gemmaSupervisorAgent, unoSupervisorAgent },
  workflows: { researchWorkflow },
});
```

**Imported by 13 scripts** + dynamically by `research-workflow.ts:731` (`await import('../index')` to resolve the search-worker agent).

### 6.2 `workflows/research-workflow.ts` — 3,981 lines (3,660 non-blank) — the core

**Control flow is a strictly linear chain — no `.branch()`, `.foreach()`, `.until()`:**

```ts
researchWorkflow = createWorkflow({ id:'research-workflow', inputSchema, outputSchema })  // 3940–3976
  .then(researchAgentStep)        // 3977  cache guard + Stage 0/1 discovery
  .then(humanReviewStep)          // 3978  HITL suspend gate
  .then(deepExtractionStep)       // 3979  Stage 2 Tavily + evidence
  .then(supervisorSynthesisStep)  // 3980  Stage 3 LLM/fallback + persistence
  .commit();                      // 3981
```

All branching happens **inside** each step via early returns keyed on `fromCache`.

**Line map:**

| Lines | Item |
|---|---|
| 1–151 | imports (19 distinct project modules) |
| 163–222 / 224 | `businessListingSchema` / `type BusinessListing` |
| 234–284 | `cachePassthroughSchema` + `takeCachePassthrough` (spread into **every** step's I/O schema so Zod doesn't strip cache fields) |
| 286–317 | `RunResearchDiscoveryInput` |
| 319–1151 | `runResearchDiscovery()` — the discovery engine |
| 1153–1255 | **`researchAgentStep`** — M1 cache-first guard (1183–1230) → on miss runs discovery |
| 1258 | `broadDiscoveryStep = researchAgentStep` (back-compat alias) |
| 1260–1354 | **`humanReviewStep`** — `autoApprove` bypass, else `suspend()`; `approved:false` throws |
| 1356–1831 | **`deepExtractionStep`** — Tavily homepage → page discovery → batch extract → raw-HTML safety net (1440) → `footer.html` recovery → advanced-depth retry → `buildVerifiedEvidence` → address re-validation |
| 1842–1919 | `finalizeCacheHit()` — writes artifacts + `cache-hit` run record, **never** `upsertBusinesses` |
| 1921–2660 | **`supervisorSynthesisStep`** — see below |
| 2671–2699 | `applyTargetCandidatesCap` (W2-08 quality-sorted hard cap) |
| 2711–2753 | `matchListingToEvidence` (phone → name → domain, 3 passes) |
| 2755–3446 | `sanitizeListingWithEvidence` (~690 lines — the largest helper) |
| 3461–3485 | `normalizeListingPhones` (guarantees `phones ∩ mobiles = ∅`) |
| 3487–3615 | `buildSupervisorPrompt` (private) |
| 3655–3938 | `buildFallbackListing` (~284 lines, Layer-3 zero-token constructor) |
| 3940–3981 | `researchWorkflow` composition |

**`runResearchDiscovery` internals:**

- **Phase 0 (386–725)** Maps-first: query expansion → `paginateMapsDiscovery` → `checkCategoryRelevance` → `evaluateGeographicLocality` → overfetch cap `max(ceil(t*2), t+5)` → `backfillMissingMapsPhones` → `runWebsiteDiscoveryGate` → writes `0-website-discovery.json`
- **Phase 1 (736–1067)** Web fallback (skipped if Maps hit target): `searchWithFallback` → validation → `filterSearchResults` → ambiguous ones to **`search-worker-agent` LLM** (30s timeout) → stop conditions
- **Finalize (1069–1150)**: writes `0-research-candidates.json` + `0b-…-lean.json`

**`supervisorSynthesisStep` pipeline (in order):**

`finalizeCacheHit` if cached → build prompt → **Layer 2** supervisor agent (`agentId || 'gemma-supervisor-agent'`, 20s race) → **Layer 3** `buildFallbackListing` on failure → Zod-validate → drop geo-excluded → **Maps re-injection** (GPS/rating/placeId) + preserve omitted candidates → `sanitizeListingWithEvidence` → `mergeDuplicateEntities` → `normalizeListingPhones` + hard phone-collision throw → `detectCrossListingConflicts` → `entity-conflicts.json` → confidence computation + integrity check → W2-05 zero-actionable filter → W2-08 cap → `upsertBusinesses` + `saveRunRecord` → **candidate ledger** (per-candidate `LedgerStatus`) → summary report → `endRunSession`.

**Stage → artifact mapping:**

| Stage | Artifact | Written at |
|---|---|---|
| 0 | `0-website-discovery.json`, `0-research-candidates.json`, `0b-…-lean.json` | 695, 1127, 1130 |
| 1 | `1-broad-search.json` | 764 (also by `broadSearchTool`) |
| 2 | `2-deep-extractions.json`, `2b-verified-evidence.json` | 1761, 1762 |
| 3 | `3-final-listings.json`, `results.json` | 1864 / 2473 |
| side | `entity-conflicts.json`, `candidate-ledger.json`, `summary-report.json` | 2320, 2632, 2588 |

### 6.3 `Tools/` (3 files, 167 L)

Thin `createTool` wrappers — **only the agent configs import them; the workflow calls services directly.**

| File | L | Tool id | Calls | Imported by |
|---|---|---|---|---|
| `broad-search.ts` | 64 | `broad-search-tool` | `searchWithFallback` + writes `1-broad-search.json`; errors → well-formed empty response | gemma, uno, search-worker |
| `google-maps-search.ts` | 53 | `google-maps-search-tool` | `searchSerperPlaces`; exports `googleMapsPlaceSchema` | all 3 agents |
| `deep-extract.ts` | 50 | `deep-extract-tool` | `tavilyExtract` (≤5 URLs) + writes `2-deep-extractions.json` | gemma, uno (**not** search-worker) |

### 6.4 `agents/`

| File | L | Model | Tools | Prompt | Imported by |
|---|---|---|---|---|---|
| `gemma-supervisor/config.ts` | 33 | `gemma-4-26b-a4b-it:free` (OpenRouter) | all 3 | own `prompt.md` (73 L) — 2 modes: conversational search vs `{listings:[…]}` synthesis; Evidence-First contact rules | `mastra/index:25` |
| `uno-supervisor/config.ts` | 32 | `gemini-3.5-flash-lite:free` (UnoRouter) | all 3 | ⚠️ **loads `gemma-supervisor/prompt.md`** — no uno-specific prompt exists, so both supervisors share it verbatim | `mastra/index:26` |
| `search-worker/config.ts` | 42 | `gemini-3.5-flash-lite` | broad-search + maps only | own `prompt.md` (62 L) — 6-class rubric `business\|aggregator\|directory\|article\|social\|irrelevant`, strict JSON-array output | `mastra/index:24` + dynamic `research-workflow:731` |
| `search-agent.ts` | 1 | — | — | — | ⚠️ **nothing** (dead re-export) |
| `research-agent/schema.ts` | 157 | — | — | — | workflow, 6 services, 4 scripts |
| `research-agent/contact.schema.ts` | 81 | — | — | — | workflow, `business-extractor`, `entity-resolution`, 3 scripts |
| `research-agent/social.schema.ts` | 50 | — | — | — | ⚠️ `business-extractor` **only** |
| `research-agent/verification.schema.ts` | 247 | — | — | — | workflow, `business-extractor`, `verification`, `website-relationship`, 7 scripts |

> `research-agent/` contains **schemas only — no agent class**. `verification.schema.ts` is the Tier-2.5 contract bridging `ResearchCandidate` (identity) → `BusinessListing` (presentation), incl. `confidenceBreakdownSchema` with the invariant `metadata.confidence === overallConfidence`.

### 6.5 `public/` — 9 JSON files, no code

Mastra's static-asset directory. Current contents (`.cache/geocoding/*.json` — kathmandu, tokha, satungal…) are an **accident**: `geocoding.service` writes to `path.resolve(process.cwd(), '.cache', 'geocoding')`, so a run executed with `cwd === src/mastra/public` dropped its cache there. Safe to delete.

---

## 7. `scripts/` — 48 files, 10,293 lines

### Category breakdown

| Category | Count | Lines | Wired to npm? |
|---|---|---|---|
| Unit/defect tests (`test-*`) | 31 | ~7,900 | ✅ all 31 in `npm test` chain |
| Live checkpoint runners (`run-phase8*-checkpoint`) | 7 | 702 | ❌ not referenced |
| Benchmark runs (`run-*-benchmark`, `run-m2c-consultancy`) | 4 | 243 | ❌ |
| API probes (`probe-*`) | 3 | 122 | ❌ |
| Acceptance runs (`run-satungal-schools-acceptance`, `test-ever-vision-discovery`) | 2 | 624 | only `test-ever-vision-discovery` (in `test`) |
| Data seeder (`seed-mongo-from-output`) | 1 | 249 | ✅ `db:seed` |
| Probe w/ assertions (`probe-w410-direct-verification`) | 1 | 191 | ❌ |
| Fixture JSON | 1 | 22 | — |

### Full test inventory (31 in `npm test`, in execution order)

`test-website-ranker` (267) → `test-second-chance` (419) → `test-satungal-sweep-defects` (358) → `test-website-discovery-budget` (194) → `test-website-discovery-gate` (478) → `test-snippet-phone-attribution` (369) → `test-ever-vision-discovery` (336) → `test-negative-directory-contamination` (395) → `test-phase7c-defect-remediation` (518) → `test-phase8a-geographic-evaluator` (121) → `test-phase8b-contact-role-aggregation` (303) → `test-phase8-geographic-contact-reconciliation` (216) → `test-phase8d-defect-fixes` (300) → `test-phase8f-rich-metadata` (117) → `test-phase8g-defects` (315) → `test-phase8h-defects` (245) → `test-phase8h-w207` (447) → `test-phase8h-w208` (226) → `test-phase8i-defects` (693, largest) → `test-phase8j-defects` (350) → `test-phase8k-defects` (206) → `test-phase8l-defects` (179) → `test-phase8m-defects` (236) → `test-phase8n-defects` (332) → `test-phase8o-defects` (190) → `test-mongo-service` (446) → `test-m2a-locality-and-maps` (78) → `test-m2b-candidate-preservation` (80) → `test-m2c-social-extraction` (18) → `test-m2c-cascade-semantics` (124) → `test-m2c-structured-branch-attribution` (162)

### Other notable scripts

| File | L | Purpose |
|---|---|---|
| `test-phase8i-defects.ts` | 693 | Largest suite: exported groups A–H (social alignment, geography/street collision, website discovery & tiered corroboration, multi-business disambiguation, contact role/phone, template fingerprints, provenance diagnostics) |
| `test-phase8h-w207.ts` | 447 | Directory classifier coverage, purge of directory emails/international phones, corporate-parent blocking, social attach/reject (GharDailo vs BhansaGhar) |
| `test-negative-directory-contamination.ts` | 395 | Directory/service-platform SERPs must yield `DISCOVERY_FOUND_ONLY_THIRD_PARTY`, zero contamination |
| `test-mongo-service.ts` | 446 | Storage layer tests; live tests skip cleanly (exit 0) when Mongo unreachable; `business_directory_test` DB |
| `test-second-chance.ts` | 419 | Bounded second-chance query generator, offline, zero API |
| `test-website-discovery-gate.ts` | 478 | Universal gate, injected search/selector, no network |
| `test-phase7c-defect-remediation.ts` | 518 | 3 fixture groups + `buildVerifiedEvidence` unit layer |
| `seed-mongo-from-output.ts` | 249 | Seeds Mongo from `output/history` (run twice: 2nd pass `inserted 0`, frozen `firstSeenAt`) |
| `run-satungal-schools-acceptance.ts` | 211 | Live acceptance: 4 gates on "schools in Satungal" |
| `test-ever-vision-discovery.ts` | 336 | Offline acceptance: gate picks `evervision.edu.np`, URL review cap 20 |

### ⚠️ Broken npm scripts (target files do not exist anywhere)

| Script | Target | Status |
|---|---|---|
| `test:e2e` | `scripts/test-research-workflow-e2e.ts` | **MISSING** |
| `test:e2e:phase2` | `scripts/test-phase2-e2e.ts` | **MISSING** |
| `test:all` | `scripts/test-all-fixes.ts` | **MISSING** |

### 16 scripts with no npm wiring

All 4 `probe-*`, 4 benchmarks, 7 `run-phase8*-checkpoint`, `run-satungal-schools-acceptance`, `run-m2c-consultancy`.

---

## 8. Import graph — who imports what

### 8.1 Entry points

```
npm run dev / start  →  mastra dev  →  src/mastra/index.ts  →  registers 3 agents + researchWorkflow
tsx scripts/*.ts     →  mastra.getWorkflow('researchWorkflow').createRun()
```

### 8.2 Layered dependency view

```
┌──────────────────────────────────────────────────────────────┐
│ scripts/ (48 files) — leaf consumers                          │
├──────────────────────────────────────────────────────────────┤
│ src/mastra/index.ts  →  3 agent configs  →  3 Tools          │
│                    ↘ research-workflow.ts (3,981 L)  ←───────┼── imports 19 project modules
├──────────────────────────────────────────────────────────────┤
│ src/services/*  (27 files) — cross-importing engine layer     │
├──────────────────────────────────────────────────────────────┤
│ src/config/* (6) + src/mastra/agents/research-agent/* (4)     │
│   ↑ schema/policy layer — no upward imports                   │
└──────────────────────────────────────────────────────────────┘
```

### 8.3 Reverse import table (src files only) — `file ← importers`

| Module | Imported by (project files) |
|---|---|
| `config/category-expansion.config` | search-fallback |
| `config/directory-domains.config` | candidate-classifier, website-relationship |
| `config/freshness.config` | research-workflow, mongo, test-mongo-service |
| `config/geo-localities.config` | research-workflow, seed-mongo, test-mongo, test-phase8h-w208 |
| `config/nepal-telecom.config` | business-extractor, entity-resolution |
| `config/website-discovery.config` | research-workflow, website-discovery-gate, test-website-discovery-budget |
| `mastra/index.ts` | 13 run-* scripts (+ dynamic import from research-workflow:731) |
| `mastra/agents/gemma-supervisor/config` | mastra/index |
| `mastra/agents/uno-supervisor/config` | mastra/index |
| `mastra/agents/search-worker/config` | mastra/index |
| `mastra/agents/search-agent.ts` | **— (nothing)** |
| `mastra/agents/research-agent/schema` | research-workflow, candidate-classifier, candidate-validation, maps-discovery, research-candidate, verification, 4 scripts |
| `mastra/agents/research-agent/contact.schema` | research-workflow, business-extractor, entity-resolution, 3 scripts |
| `mastra/agents/research-agent/social.schema` | business-extractor **only** |
| `mastra/agents/research-agent/verification.schema` | research-workflow, business-extractor, verification, website-relationship, 7 scripts |
| `mastra/Tools/broad-search` | gemma, uno, search-worker configs |
| `mastra/Tools/deep-extract` | gemma, uno configs |
| `mastra/Tools/google-maps-search` | all 3 agent configs |
| `mastra/workflows/research-workflow` | **mastra/index, mongo.service (type-only), 13 run-* scripts, 11 test scripts** ← most-imported file |
| `services/business-extractor` | research-workflow, entity-resolution, verification, website-discovery-gate, website-search-ranker, 9 scripts — **14 total** |
| `services/cache` | search-fallback, serper-places, tavily-extract |
| `services/candidate-classifier` | research-workflow, entity-resolution, website-search-ranker, 5 scripts |
| `services/candidate-validation` | research-workflow, 3 scripts |
| `services/confidence` | research-workflow **only** |
| `services/db` | mastra/index, 3 agent configs, cache, output-storage, seed-mongo |
| `services/discovery-state` | research-agent/schema, search-fallback, serper-places, website-discovery-gate |
| `services/entity-resolution` | **18 files**: research-workflow, mongo, research-candidate, verification, website-discovery, website-relationship, website-search-ranker + 11 scripts |
| `services/geocoding` | research-workflow, mongo, geographic-evaluator (dynamic), 3 scripts |
| `services/geographic-evaluator` | research-workflow, candidate-validation, entity-resolution |
| `services/maps-discovery` | research-workflow, test-m2a |
| `services/mongo` | research-workflow, seed-mongo, test-mongo |
| `services/openrouter` | gemma-supervisor config **only** |
| `services/unorouter` | uno-supervisor config **only** |
| `services/output-storage` | research-workflow, broad-search, deep-extract tools, 2 scripts |
| `services/research-candidate` | maps-discovery, research-workflow, 6 scripts |
| `services/search-fallback` | broad-search tool, research-workflow, research-agent/schema, business-extractor, candidate-classifier, entity-resolution, research-candidate, website-discovery, test-phase8h |
| `services/serper-places` | maps-discovery, website-discovery-gate, google-maps-search tool, research-workflow, entity-resolution (type), research-candidate (type), 7 scripts |
| `services/serper-search` | search-fallback **only** |
| `services/tavily-extract` | deep-extract tool, research-workflow |
| `services/telemetry` | research-workflow, business-extractor, candidate-validation, website-search-ranker |
| `services/url-filter` | research-workflow, entity-resolution, website-search-ranker |
| `services/verification` | research-workflow, 2 scripts |
| `services/website-discovery` | research-workflow **only** |
| `services/website-discovery-gate` | research-workflow, 7 scripts |
| `services/website-relationship` | verification, website-search-ranker, 6 scripts |
| `services/website-search-ranker` | research-workflow, website-discovery-gate, website-relationship, **13 scripts** |

### 8.4 Circular-dependency notes

- **Real cycle (type-only):** `mongo.service → research-workflow (type BusinessListing)` ← `research-workflow → mongo.service`. Mitigated by `import type`.
- **Dynamic-import breaks:** `geographic-evaluator → geocoding` (via `await import()`), `research-workflow:731 → mastra/index`.
- **Deliberate cycle-breaker:** `discovery-state.service.ts` exists solely as a zero-dependency schema island between gate/entity-resolution/search-fallback.

---

## 9. Root files

| File | L | Purpose |
|---|---|---|
| `package.json` | 51 | ESM (`"type":"module"`); `dev`/`start` → `mastra dev`; `typecheck` → `tsc`; `spellcheck` → cspell; `test` → 31 chained `tsx` runs; `db:seed`; 12 individual `test:*` aliases. Deps: `@mastra/core ^1.64`, `@mastra/libsql`, `@mastra/memory`, `@openrouter/ai-sdk-provider`, `duck-duck-scrape`, `mongodb ^7.6`, `typescript ^7.0.2`, `zod ^4.5.4`, `mastra ^1.27`. Dev: `cspell`, `tsx`. |
| `tsconfig.json` | 16 | ES2022 / bundler resolution / `strict` / `noEmit` / `noUnusedLocals` / `allowImportingTsExtensions`; includes `src/**/*` + `scripts/**/*` |
| `.env.example` | 15 | Required: `SERPER_API_KEY`, `TAVILY_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY`. Optional: `UNOROUTER_API_KEY/BASE_URL`, `DISCOVERY_MODE`, `MONGODB_URI`, `MONGODB_DB_NAME` |
| `.gitignore` | 18 | `.env`, `*.db*`, `.mastra`, `.cache`, `.agents/`, `output/`, `scripts/`, `tests/`, `fixtures/` |
| `cspell.json` | 949 | ~900 Nepal place-name/entity words (Tilottama, Narayangarh, budhanilkantha…) |
| `README.md` | 426 | Full architecture ASCII diagram, storage/cache contract, repo structure, data contract sample, quickstart |
| `skills-lock.json` | 11 | Pinned `mastra` skill from `mastra-ai/skills` with SHA-256 |
| `mastra.db` (+wal/shm) | — | 393 MB + 114 MB WAL — LibSQL agent memory, gitignored |

### npm scripts

| Script | Command |
|---|---|
| `dev` / `start` | `mastra dev` |
| `typecheck` | `tsc -p tsconfig.json` |
| `spellcheck` | `cspell lint "src/**/*.{ts,md}" "scripts/**/*.ts" "README.md"` |
| `test` | 31 × `tsx scripts/test-*.ts` chained with `&&` |
| `db:seed` | `tsx scripts/seed-mongo-from-output.ts` |
| `test:mongo`, `test:phase8*`, `test:phase7c-defects`, `test:m2a/b/c*` | individual suite runners |
| `test:e2e`, `test:e2e:phase2`, `test:all` | ⚠️ broken — target files missing |

---

## 10. Notable findings

1. **3 npm scripts point at non-existent files** (`test:e2e`, `test:e2e:phase2`, `test:all`).
2. **Dead code:** `src/mastra/agents/search-agent.ts` (1 line) has zero importers; `broadDiscoveryStep` alias; exports `runResearchDiscovery`, `humanReviewStep`, `deepExtractionStep`, `supervisorSynthesisStep`, `matchListingToEvidence`, `normalizeListingPhones` have no external references (exported "for tests/future use").
3. **`uno-supervisor` reuses `gemma-supervisor/prompt.md`** — no uno-specific prompt exists.
4. **`src/mastra/public/`** contains only an accidentally-written geocoding cache (cwd side effect of `geocoding.service`).
5. **393 MB `mastra.db`** sits in the repo root (gitignored but present).
6. **`.gitignore` ignores `scripts/`** yet `scripts/` is tracked.
7. **`social.schema.ts`** has only one importer (`business-extractor`) despite being a shared contract.
8. **LLM usage is deliberately bounded:** one 10-call/run escape hatch in `business-extractor`, one 30s ambiguous-classification call to `search-worker-agent`, one 20s synthesis call — everything else is deterministic with a zero-token fallback.
9. **16 scripts have no npm wiring** (all probes, benchmarks, checkpoints) — run manually via `tsx scripts/<file>`.
