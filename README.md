# Agentic Business Discovery Pipeline

An intelligent, multi-stage business intelligence engine built on **Mastra**, **Google Serper** (Search & Maps Places), **DuckDuckGo**, **Tavily Extract**, and **Google Gemma / Gemini** via **OpenRouter** and **UnoRouter**.

The pipeline discovers local businesses by fusing Google Maps Places with targeted web search, filters noise with a hybrid deterministic + LLM classifier, crawls official websites using a multi-layer extraction strategy, runs deterministic phone/email/social normalization, and synthesizes verified business listings with contact details, GPS coordinates, ratings, and confidence scores.

---

## System Architecture

```
                       ┌──────────────────────────────────────────┐
                       │         User Query + Location            │
                       │  query, location, targetCandidates,      │
                       │  maxPages, maxMapsPages,                  │
                       │  websiteDiscoveryMode, maxWebsite         │
                       │  DiscoveryLookups, autoApprove            │
                       └─────────────────┬────────────────────────┘
                                         │
                  ──── Phase 0: Google Maps Places First ────
                                         ▼
         ┌────────────────────────────────────────────────────────────────┐
         │ maps-discovery.service.ts / paginateMapsDiscovery()           │
         │ • Paginates Serper.dev /places (up to maxMapsPages)           │
         │ • Captures: title, address, phone, GPS, rating, review count, │
         │   business category, placeId                                  │
         │ • 4 safeguards:                                               │
         │     target_reached | maps_exhausted |                         │
         │     stale_limit_reached (2 consecutive stale pages) |         │
         │     max_pages_reached                                         │
         │ • isUsableOfficialWebsite() filters Maps-supplied URLs        │
         │ • Entity dedup via resolveEntityPair() 3-level cascade:       │
         │     1. Phone digits (≥7, exact) → confidence 1.0             │
         │     2. Official domain (exact, excludes social/google) → 1.0  │
         │     3. Name+Address Jaccard (nameSim ≥ 0.85 + addrSim ≥ 0.5) │
         └────────────────────────┬───────────────────────────────────────┘
                                  │
         ──── Phase 7a: Website Discovery Gate (Universal Evaluation) ────
                                  ▼
         ┌────────────────────────────────────────────────────────────────┐
         │ website-discovery-gate.service.ts / runWebsiteDiscoveryGate() │
         │                                                                │
         │  Every Maps candidate without a usable website is EVALUATED   │
         │  and receives one of 5 explicit discovery states:             │
         │                                                                │
         │  MAPS_HAS_WEBSITE           — Maps already supplied a URL     │
         │  DISCOVERY_FOUND_FIRST_PARTY — ranked search found own site   │
         │  DISCOVERY_FOUND_ONLY_THIRD_PARTY — only directories/socials  │
         │  DISCOVERY_EXHAUSTED_NO_FIRST_PARTY — zero usable results     │
         │  DISCOVERY_NOT_ATTEMPTED_BUDGET — lookup budget exhausted     │
         │                                                                │
         │  Budget:                                                       │
         │    production mode  → 10 targeted lookups per run (default)  │
         │    benchmark mode   → all eligible, hard-capped at 50/run    │
         │                                                                │
         │  Invariant enforced: Σ(all 5 state counts) == totalEvaluated  │
         │                                                                │
         │  Per-candidate provenance:                                     │
         │    queries[], candidateUrlsReviewed[] (capped at 20 URLs),    │
         │    selectedUrl, selectionReason, secondChanceAttempted        │
         │                                                                │
         │  Ranker (website-search-ranker.service.ts):                   │
         │    Zero-HTTP, deterministic token scoring on ALL results      │
         │    (replaces legacy first-pick / results.find() behaviour)    │
         │    Scoring: nameTokenMatch(12) + allTokensBonus(10) +         │
         │      locationMatch(10) + tldBest(12) + rootPath(6) + …       │
         │    Strict majority token gate (≥ 2 tokens → majority must     │
         │    match; 1 token → must match + location check)              │
         │    Third-party penalty: −50 (larger than max TLD bonus: 12)  │
         │    Min score to be accepted: configurable threshold           │
         │                                                                │
         │  Second-chance query (Task 5):                                │
         │    When primary query yields zero usable candidates, one      │
         │    reformulated query is attempted (bounded, 1 retry max)     │
         │                                                                │
         │  Phone attribution from own domain (selectPhoneFromOwnDomain) │
         │    Snippet phone extraction attributed only to first-party    │
         │    domains — never from directory/aggregator snippets          │
         │                                                                │
         │  Reconciliation (sanitizeListingWithEvidence):                 │
         │    After extraction, if discoveryState is                      │
         │    DISCOVERY_FOUND_ONLY_THIRD_PARTY, the provisional website  │
         │    is CLEARED and discoveryState is written to otherDetails.  │
         └────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
         output/0-website-discovery.json   ← audit envelope with counters
                                  │
             ┌─ target reached? ──┴──────── no ──┐
             │   (skip web search)       Phase 1 Web Fallback
             ▼                                    ▼
         ┌────────────────────────────────────────────────────────────────┐
         │ research-workflow.ts / runResearchDiscovery()                  │
         │ Web Fallback Pagination Loop (page 1..maxPages)               │
         │  1. searchWithFallback() — Serper → DuckDuckGo cascade        │
         │     7-day disk cache (.cache/search-results.json)             │
         │  2. seenUrls dedup — URL-level across pages                   │
         │  3. filterSearchResults() — deterministic domain/path/        │
         │     listicle regex (0 API cost)                               │
         │  4. searchWorkerAgent — LLM classification of ambiguous       │
         │     items only (google/gemini-3.5-flash-lite)                 │
         │  5. buildResearchCandidates() — entity merge & dedup          │
         │  Stopping: target_reached | no_more_pages |                   │
         │            no_new_results (2+ consecutive stale) |            │
         │            max_pages_reached                                   │
         └────────────────────────┬───────────────────────────────────────┘
                                  │
                  output/0-research-candidates.json
                  output/0b-research-candidates-lean.json
                                  │
               ──── Step 1: Human-in-the-Loop Review ────
                                  ▼
         ┌────────────────────────────────────────────────────────────────┐
         │ humanReviewStep()                                              │
         │ • autoApprove=true  → passes through instantly (headless)     │
         │ • autoApprove=false → suspends for interactive review         │
         │   Supports optional URL filter for partial approval           │
         └────────────────────────┬───────────────────────────────────────┘
                                  │
            ──── Step 2: Deep Website Extraction & Verification ────
                                  ▼
         ┌────────────────────────────────────────────────────────────────┐
         │ deepExtractionStep() — Per-candidate 5-layer extraction        │
         │                                                                │
         │  For each candidate with an official website:                 │
         │  1. Homepage Tavily Extract (basic depth, cached 7 days)      │
         │  2. discoverWebsitePages() — finds best internal pages        │
         │     (/contact, /about) via markdown link parsing +            │
         │     fallback guessing (0 extra API calls)                     │
         │  3. Batch Tavily Extract for up to 4 internal pages           │
         │  4. Raw HTML Safety Net (fetchRawPageHtml)                    │
         │     • Always fires for homepage and contact page              │
         │     • Also if: candidate has zero contact/social signals      │
         │     • 0 API credits (~80-120ms native fetch)                  │
         │     • Recovers icon-only social anchors, mailto:/tel: hrefs   │
         │       that readability parsers strip                          │
         │  5. AJAX/Componentized Footer Recovery                        │
         │     Probes /footer.html when footer placeholder is detected   │
         │     or social signals are still zero after raw HTML pass      │
         │  6. Secondary Tavily Advanced Retry                           │
         │     Only fires when all prior layers yield zero contact signals│
         │                                                                │
         │  buildVerifiedEvidence() — deterministic per-candidate        │
         │  structure: extractedPhones, extractedMobiles, emails,        │
         │  socialLinks, favicon, PhoneEvidence[] page provenance        │
         └────────────────────────┬───────────────────────────────────────┘
                                  │
                  output/2-deep-extractions.json
                  output/2b-verified-evidence.json
                                  │
             ──── Step 3: AI Business Data Synthesis ────
                                  ▼
         ┌────────────────────────────────────────────────────────────────┐
         │ supervisorSynthesisStep() — 3-Layer AI Cascade                │
         │                                                                │
         │  Layer 1: UnoRouter AI Consensus Tribunal                     │
         │    generateWithUnoTribunal() — multi-model consensus          │
         │    Used when UNOROUTER_API_KEY is set                         │
         │                                                                │
         │  Layer 2: OpenRouter Supervisor Agent                         │
         │    gemmaSupervisorAgent — model cascade:                      │
         │    gemma-4-26b → gemma-4-31b → nemotron → nex                │
         │    Used when Layer 1 is unavailable or fails                  │
         │                                                                │
         │  Layer 3: Zero-Token Deterministic Fallback                   │
         │    buildFallbackListing() — no LLM required                   │
         │    Used when both AI layers fail or return empty              │
         │                                                                │
         │  Post-synthesis deterministic re-injection (no LLM):         │
         │  • GPS coordinates from Maps candidates (never LLM-inferred) │
         │  • Star ratings, review counts, placeIds                      │
         │  • sanitizeListingWithEvidence() routes phones, mobiles,      │
         │    emails, socialLinks from verifiedEvidence                  │
         │  • websiteRelationship flag-gating: only written when         │
         │    verifiedEvidence confirms a usable website exists          │
         │  • discoveryState & reconciliationReason forwarded to         │
         │    otherDetails for full provenance chain                     │
         │  • deduplicateClassifiedContacts(): first-seen-wins dedup     │
         │    with pagesSeenOn[] tracking (Rule A)                       │
         └────────────────────────┬───────────────────────────────────────┘
                                  │
                  output/3-final-listings.json
                  output/latest/businesses.json
                  output/latest/summary-report.json
                  output/history/{timestamp}-{slug}/  (all stages)
```

---

## Phase 7 — Website Discovery System (v2.0)

Phase 7 replaces the legacy "first usable URL wins" pattern with a four-component, fully auditable website discovery system. Each component below is independently tested.

### Component 1 — Discovery Budget Policy (`website-discovery.config.ts`)

| Mode | Behaviour |
|---|---|
| `production` (default) | Up to `maxWebsiteDiscoveryLookups` targeted lookups per run (default: 10) |
| `benchmark` | Every eligible Maps candidate, hard-capped at 50 lookups/run |

Invalid values degrade silently to `production`. The budget decides **only which candidates receive a live search** — evaluation and state assignment are always universal.

### Component 2 — Universal Evaluation Gate (`website-discovery-gate.service.ts`)

Every Maps candidate that needs enrichment is evaluated. The gate:
1. Assigns one of 5 explicit `DiscoveryState` values (see state machine below).
2. Records full per-candidate provenance (queries sent, URLs reviewed, selected URL, selection reason).
3. Collapses duplicate appearances of the same business (same `placeId`/`cid`) into a single lookup — no duplicate searches, no contradictory states.
4. Enforces the exhaustive state invariant: `Σ(all 5 state counts) === totalEvaluated` (validated by `validateDiscoveryStateInvariant()`).

**Discovery State Machine:**

```
Maps candidate arrives
       │
       ├─ already has a usable website? ──────────────────► MAPS_HAS_WEBSITE
       │
       ├─ budget not exhausted?
       │    │
       │    └─ run search (primary query)
       │         │
       │         ├─ zero usable results?
       │         │    └─ run second-chance query (bounded, 1 retry)
       │         │         ├─ still zero? ─────────────────► DISCOVERY_EXHAUSTED_NO_FIRST_PARTY
       │         │         └─ results found → rank & select ↓
       │         │
       │         └─ results found → rank & select
       │               │
       │               ├─ score ≥ threshold & first-party? ► DISCOVERY_FOUND_FIRST_PARTY
       │               └─ only directories/socials? ───────► DISCOVERY_FOUND_ONLY_THIRD_PARTY
       │
       └─ budget exhausted? ──────────────────────────────► DISCOVERY_NOT_ATTEMPTED_BUDGET
```

### Component 3 — Zero-HTTP URL Ranker (`website-search-ranker.service.ts`)

Replaces `results.find(isUsableOfficialWebsite)` (legacy first-pick) with deterministic token scoring of **all** results simultaneously.

**Scoring weights (`RANK_WEIGHTS`):**

| Signal | Points |
|---|---|
| Name token match (per token) | +12 |
| All tokens in domain bonus | +10 |
| Location token match | +10 |
| Location in domain bonus | +4 |
| Best TLD (`.edu.np`, `.school`, etc.) | +12 |
| Good TLD (`.com.np`, `.org.np`) | +8 |
| Generic TLD (`.com`, `.org`) | +4 |
| Other TLD | +2 |
| Root or short path | +6 |
| Contact/about path | +4 |
| Deep path penalty | −6 |
| **Third-party domain penalty** | **−50** |
| Unrelated domain penalty | −40 |

> **Invariant**: Third-party penalty (−50) is strictly larger in magnitude than the maximum TLD bonus (+12), so a directory on a strong TLD can never outscore a real first-party site.

**Token gate (strict majority rule):**
- ≥ 2 distinctive tokens → strict majority must match (minimum 2): 2 tokens → both; 3 → 2; 4 → 3; …
- Exactly 1 distinctive token → that token must match AND location must match (if available)
- 0 distinctive tokens → no name requirement; location/usability decide

Region noise tokens excluded from distinctiveness: `nepal`, `kathmandu`, `pokhara`, `lalitpur`, `himalayan`, `national`, `global`.

### Component 4 — Snippet Phone Attribution Guard (`website-search-ranker.service.ts`)

`selectPhoneFromOwnDomain()` extracts phone numbers from SERP snippets but attributes them **only when the snippet URL belongs to the candidate's own domain**. Directory/aggregator snippets are never used as phone sources.

### Component 5 — Provenance Chain & Audit Envelope (`output/0-website-discovery.json`)

Full provenance is forwarded end-to-end:

```
SerperPlaceResult
  → ResearchCandidate.discoveryProvenance (queries, candidateUrlsReviewed, selectedUrl, selectionReason)
  → VerifiedBusinessEvidence.candidate
  → BusinessListing.otherDetails (discoveryState, discoveryProvenance, reconciliationReason)
```

The audit envelope (`0-website-discovery.json`) contains:
- `runId`, `generatedAt`
- `counters`: lookupsAttempted, searchesSent, firstPartyFound, thirdPartyOnly, exhaustedNoFirstParty, notAttemptedBudget, phoneOnlyLookups
- `statesApplied`: distribution across all 5 states
- `records[]`: per-candidate provenance records

---

## Phase 7c — Defect Remediation (v2.1)

Four production defects found during live benchmark acceptance were remediated and are now regression-tested:

| Defect | Root Cause | Fix |
|---|---|---|
| **D1 — Map directory selected as official website** (e.g., `mapcarta.com`) | Missing third-party domain blocklist + SERP-title token scoring bypass + unconditional website attachment + unreconciled `discoveryState` | Added `mapcarta.com` and its class to the ranker's `THIRD_PARTY_PLATFORMS` blocklist; `sanitizeListingWithEvidence` now reconciles state to `DISCOVERY_FOUND_ONLY_THIRD_PARTY` and clears the provisional URL |
| **D2 — Email truncation at multi-part ccTLD** (e.g., `info@aischool.edu.np` extracted as `info@aischool.edu`) | `EMAIL_REGEX` didn't support multi-part ccTLDs like `.edu.np` | Updated `EMAIL_REGEX` to optionally match one additional TLD segment: `[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?` with a negative lookahead `(?!\.[a-zA-Z])` to prevent over-matching |
| **D3 — `websiteRelationship` written without evidence gating** | `sanitizeListingWithEvidence` assigned `websiteRelationship` from the verified evidence before confirming a usable website exists | Added explicit evidence gate: `websiteRelationship` is only written when `verifiedEvidence.websiteEvidence` confirms a usable URL |
| **D4 — Duplicate classified contacts across extraction pages** | Multiple extraction pages (homepage + contact + about) produced duplicate contact entries without deduplication | Implemented `deduplicateClassifiedContacts()` — first-seen-wins rule with `pagesSeenOn: string[]` tracking; integrated into the extraction pipeline and `sanitizeListingWithEvidence` |

All four fixes are covered by `scripts/test-phase7c-defect-remediation.ts` (22 assertions) and verified live in the Task 15 acceptance benchmark.

---

## v1.5 Deterministic Phone Normalization Pipeline

All phone handling is **zero-LLM** and fully deterministic:

```
Raw phone candidate (text / HTML / tel: href / wa.me URL)
  ↓
expandSlashExtensions()       e.g. "+977 1 5363501/511/560" → 3 numbers
  ↓
classifyNepalPhone(raw)       Explicit structure recognition (no guessing):
  │  PATH A: +977 prefix present
  │    • 97x/98x + 10 mobile digits → mobile
  │    • 1 + 7-8 landline digits    → landline
  │    • Short/truncated            → INCOMPLETE_MOBILE or INCOMPLETE_LANDLINE
  │  PATH B: No +977 prefix (international checked FIRST to avoid mis-gating)
  │    • Explicit '+' present       → international (raw format preserved)
  │    • 9x/8x domestic 10-digit   → mobile
  │    • 01/1 + 7-digit trunk      → landline
  │    • Everything else           → INVALID_STRUCTURE
  ↓
formatPhoneDisplay(digits, type, raw?)
  • Nepal mobile:    9808222425  → +977-980-8222425
  • Nepal landline:  14522833    → +977-01-4522833
  • International:               → raw format preserved
  ↓
Canonical dedup by digits-only identity
  • +977-1-4522833 == 01-4522833 == +977 1 4522833 → ONE entry
  ↓
PhoneEvidence[]    (raw, canonicalDigits, display, type, source, pageUrl, reason?)
  • Valid   → extractedPhones or extractedMobiles (public arrays)
  • Invalid → extractedPhoneEvidence ONLY (forensic, never public)
  ↓
Strict invariant enforced: phones ∩ mobiles = ∅
```

**NTA prefix tables** (`nepal-telecom.config.ts`): Mobile prefixes (97x/98x) and landline area codes are loaded from authoritative config — never hardcoded inline.

---

## Email Extraction Rules

Extraction is performed by `extractEmails()` using `EMAIL_REGEX`:

```
/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?\b(?!\.[a-zA-Z])/g
```

- Supports multi-part ccTLDs: `.edu.np`, `.com.np`, `.org.np`
- Negative lookahead prevents over-matching of longer extensions
- Placeholder/throwaway addresses are always rejected (see `PLACEHOLDER_EMAIL_PATTERNS`)
- Media filename false positives are filtered: `*.png`, `*.jpg`, `@2x.webp`, etc.
- Email roles are classified: `primary_business`, `department`, `personal`, `noreply`, `support`

---

## Contact Deduplication

`deduplicateClassifiedContacts()` implements **Rule A — First-seen wins**:

1. Canonical key: `type + ":" + canonicalDigits` (phones/mobiles) or `type + ":" + normalizedValue` (emails/socials)
2. First occurrence is kept; subsequent duplicates are dropped
3. `pagesSeenOn: string[]` accumulates all page URLs where the contact appeared
4. Trailing-slash URL canonicalization is applied before comparison
5. `pagesSeenOn` is always populated for web contacts; it is `optional()` for backward compatibility with Maps-sourced contacts

---

## Key Features

### 1. Google Maps-First Discovery (Phase 0)
- Paginates Google Maps Places via Serper.dev `/places` with up to `maxMapsPages` pages.
- Captures: addresses, phone numbers, GPS coordinates, star ratings, review counts, business categories, placeIds.
- **Targeted Web Lookup**: For each Maps entry without a website, runs the Phase 7 discovery gate (budget-aware, state-tracked, provenance-recorded).
- **Entity deduplication**: `dedupeByEntity()` collapses duplicate Maps entries before adding to the candidate pool.

### 2. Zero-API-Cost Deterministic Candidate Filtering
- `candidate-classifier.service.ts` handles >90% of filtering with no LLM tokens.
- **Aggregators blocked**: Booking.com, Agoda, TripAdvisor, Expedia, Trivago, Makemytrip, Kayak, Airbnb, Hostelworld, Viator, GetYourGuide, and dozens more.
- **Directories blocked**: YellowPages, Yelp, Justdial, SignalHire, ZoomInfo, Manta, Crunchbase, Foursquare, Edusanjal, CollegesNepal, and more.
- **Social media blocked**: Facebook, Instagram, TikTok, LinkedIn, Twitter/X, YouTube, Reddit, Quora, Pinterest, etc.
- **Listicles blocked**: Paths matching `/blog/`, `/news/`, `/article/`, `/guides/`, and title patterns like *"10 Best…"*.
- **Map directories blocked** (Phase 7c D1): `mapcarta.com` and its class are penalized at −50 in the ranker.

### 3. LLM Ambiguous Item Classification
- Only genuinely ambiguous candidates go to `searchWorkerAgent` (`google/gemini-3.5-flash-lite`).
- Classifies: `business | aggregator | directory | article | social | irrelevant`.
- LLM failure is safe: ambiguous items default to excluded.

### 4. Multi-Provider Search Fallback
- **Primary**: Google Serper API with native `page` parameter.
- **Fallback**: DuckDuckGo (`duck-duck-scrape`) with native offset-based pagination.
- Both share the same 7-day disk cache.

### 5. Deterministic Entity Resolution (0-Token)
Three-level cascade in `resolveEntityPair()`:
1. **Phone digits** (≥7 digits, exact match) → confidence 1.0
2. **Official domain** (exact match, excludes social/google) → confidence 1.0
3. **VETO**: conflicting phone or domain blocks soft matches entirely
4. **Name + Address Jaccard** (nameSim ≥ 0.85 + addrSim ≥ 0.5, or nameSim ≥ 0.95 alone) → confidence 0.85–0.9

### 6. Multi-Layer Website Extraction
- **Tavily Extract** (basic depth, cached per-URL 7 days): homepage + up to 4 internal pages.
- **Raw HTML Safety Net**: Always fires for homepage and contact pages (0 API credits). Recovers icon-only social anchors, `mailto:` and `tel:` href links that readability parsers strip.
- **AJAX Footer Recovery**: Probes `/footer.html` for sites with componentized/templated footers.
- **Secondary Tavily Advanced Retry**: Only when all prior layers yield zero contact signals.

### 7. Deterministic Data Quality
- `classifyNepalPhone()`: Explicit structure validation with NTA prefix tables. Never guesses.
- `formatPhoneDisplay()`: `+977-9XX-XXXXXXX` (mobile), `+977-01-XXXXXXX` (landline), raw-preserved (international).
- EPABX slash expansion: `+977 1 5363501/511/560` → 3 separate landlines.
- `PhoneEvidence[]` per-page provenance for every phone candidate.
- Strict taxonomy: `phones ∩ mobiles = ∅` enforced as a hard invariant.
- Social link validation: rejects Facebook `/sharer`, Twitter `/share`, Instagram posts/reels/explore, LinkedIn `/shareArticle`.
- Email sanitization: strips trailing `)*`, `\`, `\\`, markdown wrappers before dedup.
- Multi-part ccTLD support: `.edu.np`, `.com.np`, `.org.np` (Phase 7c D2).

### 8. 3-Layer AI Synthesis with Deterministic Fallback
| Layer | Mechanism | Trigger |
|---|---|---|
| 1 | UnoRouter AI Consensus Tribunal | When `UNOROUTER_API_KEY` is set |
| 2 | OpenRouter Supervisor Agent (Gemma 4 cascade) | When Layer 1 unavailable or fails |
| 3 | Zero-token `buildFallbackListing()` | When both AI layers fail or return empty |

### 9. Deterministic Post-Synthesis Re-injection
After AI synthesis, a deterministic pass re-injects:
- Exact GPS coordinates from Maps candidates (never LLM-inferred)
- Star ratings, review counts, placeIds
- `sanitizeListingWithEvidence()` routes phones, mobiles, emails, social links from `verifiedEvidence`
- `websiteRelationship` written only when evidence gate confirms a usable website (Phase 7c D3)
- `discoveryState`, `reconciliationReason`, and `discoveryProvenance` forwarded to `otherDetails`
- `deduplicateClassifiedContacts()` runs as the final contact normalization step (Phase 7c D4)

### 10. Multi-Dimensional Confidence Model (`confidence.service.ts`)
Pure deterministic function — no LLM. Takes `ConfidenceInputs` and emits `ConfidenceBreakdown`:

| Dimension | Signal |
|---|---|
| `mapsIdentityConfidence` | GPS, placeId, rating, address presence |
| `websiteEvidenceConfidence` | websiteRelationship, verificationConfidence, checks |
| `contactConfidence` | phones, mobiles counts |
| `conflictPenalty` | cross-listing conflict detection |
| `overallConfidence` | weighted combination of all dimensions |

Maps-only fallback baseline: **0.5** (prevents collapse when website/contact dimensions are absent).

### 11. No-Website Tradesmen Preservation
Local businesses with a Maps listing and phone but no website are preserved and emitted as valid listings — never dropped because extraction returns empty.

### 12. 7-Day Disk Cache (Shared Across All Providers)
- Single file: `.cache/search-results.json`
- Three namespaced providers in the same file: `serper-places`, `serper-search`, `tavily-extract`
- SHA-256 keyed: `hash(provider::query)` — collision-safe
- Atomic write lock prevents race conditions

### 13. Dual-Folder Output Architecture
- `output/latest/` — always the most recent run (overwrites every run)
- `output/history/{timestamp}-{slug}/` — permanent per-run archive (never overwritten)

---

## Project Structure

```
searchDump/
├── .cache/
│   └── search-results.json          # 7-day shared disk cache (Maps + Web + Tavily)
├── output/
│   ├── latest/                      # Most recent run (always current)
│   │   ├── businesses.json          # Final BusinessListing[] — UI/export ready
│   │   └── summary-report.json      # Run KPIs (count, contacts, runtime)
│   ├── history/                     # Permanent per-run archives
│   │   └── <timestamp>-<slug>/
│   │       ├── 0-website-discovery.json    # Phase 7 audit envelope
│   │       ├── 0-research-candidates.json
│   │       ├── 0b-research-candidates-lean.json
│   │       ├── 1-broad-search.json
│   │       ├── 2-deep-extractions.json
│   │       ├── 2b-verified-evidence.json
│   │       ├── 3-final-listings.json
│   │       └── summary-report.json
│   └── (root mirrors)               # Backward-compatible mirrors
│       ├── 0-website-discovery.json
│       ├── 0-research-candidates.json
│       ├── 2b-verified-evidence.json
│       ├── 3-final-listings.json
│       └── results.json
├── scripts/
│   ├── test-business-extractor.ts          # v1.5 phone/email/social (100+ assertions)
│   ├── test-entity-resolution.ts           # Entity matching cascade
│   ├── test-candidate-classifier.ts        # Deterministic classifier benchmark
│   ├── test-maps-discovery.ts              # Maps pagination safeguards
│   ├── test-website-discovery.ts           # Internal page discovery
│   ├── test-website-discovery-budget.ts    # Budget policy (Phase 7a Task 2)
│   ├── test-website-discovery-gate.ts      # Universal evaluation gate (Phase 7a Task 3)
│   ├── test-website-ranker.ts              # Zero-HTTP URL ranker (Phase 7a Task 4)
│   ├── test-snippet-phone-attribution.ts   # Phone attribution guard (Phase 7a Task 4.5)
│   ├── test-second-chance.ts               # Bounded second-chance queries (Phase 7a Task 5)
│   ├── test-ever-vision-discovery.ts       # Phase 7b primary acceptance fixture
│   ├── test-negative-directory-contamination.ts  # Phase 7b negative acceptance
│   ├── test-phase7c-defect-remediation.ts  # Phase 7c D1–D4 regression (22 assertions)
│   ├── test-provenance-integrity.ts        # End-to-end provenance chain (Phase 7b)
│   ├── test-verification.ts                # Verified evidence builder
│   ├── test-website-relationship.ts        # Website relationship classifier
│   ├── test-social-profile-vendor.ts       # Social profile vendor detection
│   ├── test-deep-extraction-offline.ts     # Offline extraction path tests
│   ├── test-output-structure.ts            # Output folder/file structure
│   ├── test-cross-listing-conflicts.ts     # Cross-listing conflict detection
│   ├── test-phone-dedup-invariant.ts       # phones ∩ mobiles = ∅ invariant
│   ├── test-confidence-model.ts            # Multi-dimensional confidence model
│   ├── test-foundation-hardening.ts        # Foundation hardening suite
│   ├── test-verification-state.ts          # Verification state machine
│   ├── test-email-sanity-filter.ts         # Email regex + placeholder filter
│   ├── test-nepal-phone-parsing.ts         # Nepal phone normalization
│   ├── test-contact-role-classifier.ts     # Contact role classification
│   ├── test-social-ownership.ts            # Social profile ownership
│   ├── test-website-lifecycle.ts           # Website discovery lifecycle
│   ├── test-category-expansion.ts          # Category intent expansion
│   ├── test-conflict-artifact.ts           # Conflict artifact generation
│   ├── test-foundation-v3.ts               # Foundation v3 golden fixtures
│   ├── test-step3-projection.ts            # Step 3 taxonomy + slash expansion
│   ├── test-all-fixes.ts                   # Comprehensive pipeline benchmark
│   ├── test-research-workflow-e2e.ts       # Live E2E workflow test
│   ├── test-phase2-e2e.ts                  # Phase 2 extraction E2E
│   ├── test-unorouter.ts                   # UnoRouter consensus tribunal
│   ├── test-gemma-experiment.ts            # OpenRouter Gemma reasoning
│   ├── test-enrichment-logic.ts            # Enrichment logic
│   ├── run-satungal-schools-acceptance.ts  # Task 15 live acceptance benchmark
│   └── inspect-lookups.ts                  # Targeted lookup debug tool
├── src/
│   ├── config/
│   │   ├── nepal-telecom.config.ts         # NTA mobile prefixes & landline area codes
│   │   └── website-discovery.config.ts     # Discovery budget policy (production/benchmark)
│   ├── services/
│   │   ├── business-extractor.service.ts   # Phone/email/social extraction + v1.5 normalization
│   │   │                                   # classifyNepalPhone, formatPhoneDisplay, PhoneEvidence
│   │   │                                   # extractEmails (multi-part ccTLD), extractSocialLinks
│   │   │                                   # deduplicateClassifiedContacts (Phase 7c D4)
│   │   ├── cache.service.ts                # Root-anchored SHA-256 disk cache, atomic write lock
│   │   ├── candidate-classifier.service.ts # Fast domain/path/listicle regex classifier
│   │   ├── confidence.service.ts           # Multi-dimensional confidence model (pure/deterministic)
│   │   ├── db.service.ts                   # LibSQL memory store + getProjectRootDir()
│   │   ├── discovery-state.service.ts      # Canonical DiscoveryState enum + provenance schema
│   │   │                                   # Standalone zero-dependency module (prevents ESM cycles)
│   │   ├── entity-resolution.service.ts    # resolveEntityPair, dedupeByEntity
│   │   │                                   # normalizeNameKey, tokenJaccard, normalizePhoneDigits
│   │   │                                   # isUsableOfficialWebsite, rankWebsiteLookupTargets
│   │   ├── maps-discovery.service.ts       # paginateMapsDiscovery() — 4-safeguard pagination
│   │   ├── openrouter.service.ts           # OpenRouter API client
│   │   ├── output-storage.service.ts       # saveStageOutput (dual-write), startRunSession
│   │   ├── research-candidate.service.ts   # buildResearchCandidates(), toUnifiedCandidates()
│   │   ├── search-fallback.service.ts      # searchWithFallback() — Serper → DuckDuckGo
│   │   ├── serper-places.service.ts        # searchSerperPlaces() — /places endpoint, cached
│   │   ├── serper-search.service.ts        # Google Serper web search client
│   │   ├── tavily-extract.service.ts       # tavilyExtract() — basic/advanced, per-URL cache
│   │   ├── unorouter.service.ts            # generateWithUnoTribunal() — multi-model consensus
│   │   ├── url-filter.service.ts           # filterCandidateUrls() — official domain prioritizer
│   │   ├── verification.service.ts         # buildVerifiedEvidence(), keyOfCandidate()
│   │   ├── website-discovery-gate.service.ts  # Universal evaluation gate + telemetry counters
│   │   ├── website-discovery.service.ts    # discoverWebsitePages() — internal page discovery
│   │   ├── website-relationship.service.ts # Website relationship classifier (first_party etc.)
│   │   └── website-search-ranker.service.ts   # Zero-HTTP URL ranker, RANK_WEIGHTS, token gate
│   └── mastra/
│       ├── index.ts                        # Mastra instance — registered agents & workflows
│       ├── Tools/
│       │   ├── broad-search.ts             # broadSearchTool
│       │   ├── deep-extract.ts             # deepExtractTool
│       │   └── google-maps-search.ts       # googleMapsSearchTool
│       ├── agents/
│       │   ├── research-agent/
│       │   │   ├── contact.schema.ts       # ClassifiedContact, ContactRole, ContactOwner, ContactChannel
│       │   │   ├── schema.ts               # ResearchReport, ResearchCandidate, DiscoveryProvenance
│       │   │   ├── social.schema.ts        # ClassifiedSocialProfile
│       │   │   └── verification.schema.ts  # VerifiedBusinessEvidence, PhoneEvidence, WebsiteEvidence
│       │   ├── search-worker/
│       │   │   ├── config.ts               # searchWorkerAgent (gemini-3.5-flash-lite)
│       │   │   └── prompt.md
│       │   ├── gemma-supervisor/
│       │   │   ├── config.ts               # gemmaSupervisorAgent (Gemma 4 via OpenRouter)
│       │   │   └── prompt.md
│       │   └── uno-supervisor/
│       │       ├── config.ts               # UnoRouter tribunal agent
│       │       └── prompt.md
│       └── workflows/
│           └── research-workflow.ts        # End-to-end 4-step discovery workflow
├── cspell.json                      # Domain-specific spellcheck dictionary
├── package.json
└── tsconfig.json
```

---

## Data Contracts

### Website Discovery Audit Envelope (`output/0-website-discovery.json`)

```json
{
  "runId": "run-2026-09-17-satungal-schools",
  "generatedAt": "2026-09-17T09:22:09.000Z",
  "counters": {
    "lookupsAttempted": 5,
    "searchesSent": 6,
    "firstPartyFound": 4,
    "thirdPartyOnly": 1,
    "exhaustedNoFirstParty": 0,
    "notAttemptedBudget": 0,
    "phoneOnlyLookups": 0
  },
  "statesApplied": {
    "MAPS_HAS_WEBSITE": 0,
    "DISCOVERY_FOUND_FIRST_PARTY": 4,
    "DISCOVERY_FOUND_ONLY_THIRD_PARTY": 1,
    "DISCOVERY_EXHAUSTED_NO_FIRST_PARTY": 0,
    "DISCOVERY_NOT_ATTEMPTED_BUDGET": 0
  },
  "records": [
    {
      "key": "place_403388678894595195",
      "title": "Oracle Ray Academy",
      "state": "DISCOVERY_FOUND_ONLY_THIRD_PARTY",
      "searchAttempted": true,
      "queries": ["Oracle Ray Academy Satungal, Kathmandu"],
      "resultsReviewed": 5,
      "candidateUrlsReviewed": [
        "https://facebook.com/oracleray",
        "https://play.google.com/store/apps/...",
        "https://mapcarta.com/W219223401"
      ],
      "selectedUrl": "https://play.google.com/store/apps/...",
      "selectionReason": "selected play.google.com (score 44; tokens [oracle, ray, academy])",
      "secondChanceAttempted": false
    }
  ]
}
```

### Research Candidates (`output/0-research-candidates.json`)

```json
{
  "query": "Schools",
  "location": "Satungal, Kathmandu",
  "pagesSearched": 0,
  "targetCandidates": 10,
  "uniqueBusinessesFound": 5,
  "matchesMerged": 0,
  "stoppedReason": "target_reached",
  "researchCandidates": [
    {
      "name": "Ever Vision School एभर भिजन स्कुल",
      "location": "Satungal, Chandragiri",
      "website": "https://evervisionschool.edu.np/",
      "phone": "+977-01-4311600",
      "coordinates": { "lat": 27.693, "lng": 85.268 },
      "rating": 4.4,
      "ratingCount": 87,
      "category": "School",
      "discoveryState": "DISCOVERY_FOUND_FIRST_PARTY",
      "discoveryProvenance": {
        "queries": ["Ever Vision School एभर भिजन स्कुल Satungal, Kathmandu"],
        "candidateUrlsReviewed": [
          "https://edusanjal.com/school/ever-vision-school",
          "https://evervisionschool.edu.np/"
        ],
        "selectedUrl": "https://evervisionschool.edu.np/",
        "selectionReason": "selected evervisionschool.edu.np (score 74; tokens [ever, vision, school])",
        "secondChanceAttempted": false
      },
      "sources": {
        "googleMaps": { "found": true, "placeId": "...", "address": "..." },
        "webSearch": []
      },
      "classification": { "status": "usable", "type": "business", "confidence": 1.0 }
    }
  ]
}
```

### Verified Evidence (`output/2b-verified-evidence.json`)

```json
{
  "query": "Schools",
  "maxDeepVerifyCandidates": 10,
  "verifiedEvidence": [
    {
      "candidateKey": "ever-vision-school",
      "name": "Ever Vision School एभर भिजन स्कुल",
      "candidate": {
        "discoveryState": "DISCOVERY_FOUND_FIRST_PARTY",
        "discoveryProvenance": { "...": "..." }
      },
      "websiteEvidence": {
        "url": "https://evervisionschool.edu.np/",
        "domain": "evervisionschool.edu.np",
        "extractedEmails": [],
        "extractedPhones": ["+977-01-4311600"],
        "extractedMobiles": [],
        "extractedSocialLinks": {
          "facebook": "https://facebook.com/evervisionschool",
          "instagram": "",
          "tiktok": "",
          "other": {}
        },
        "favicon": "https://evervisionschool.edu.np/favicon.ico",
        "extractedPhoneEvidence": [
          {
            "raw": "01-4311600",
            "canonicalDigits": "14311600",
            "display": "+977-01-4311600",
            "type": "landline",
            "source": "markdown",
            "pageUrl": "https://evervisionschool.edu.np/contact"
          }
        ]
      },
      "verification": {
        "status": "verified",
        "overallConfidence": 0.92,
        "checks": {
          "websiteIsUsableOfficial": true,
          "websiteDomainMatchesCandidate": true,
          "businessNameFoundOnWebsite": true,
          "phoneMatchesMaps": true,
          "emailFoundOnWebsite": false,
          "socialLinksFoundOnWebsite": true
        }
      }
    }
  ]
}
```

### Final Listings (`output/latest/businesses.json`)

```json
[
  {
    "name": "Ever Vision School एभर भिजन स्कुल",
    "location": "Satungal-13, Chandragiri, Kathmandu",
    "emails": [],
    "phones": ["+977-01-4311600"],
    "mobiles": [],
    "websites": ["https://evervisionschool.edu.np/"],
    "icon": "https://evervisionschool.edu.np/favicon.ico",
    "socialLinks": {
      "facebook": "https://facebook.com/evervisionschool",
      "tiktok": "",
      "instagram": "",
      "other": {}
    },
    "otherDetails": {
      "websiteRelationship": "first_party",
      "discoveryState": "DISCOVERY_FOUND_FIRST_PARTY",
      "discoveryProvenance": {
        "queries": ["Ever Vision School एभर भिजन स्कुल Satungal, Kathmandu"],
        "candidateUrlsReviewed": ["https://edusanjal.com/...", "https://evervisionschool.edu.np/"],
        "selectedUrl": "https://evervisionschool.edu.np/",
        "selectionReason": "selected evervisionschool.edu.np (score 74; tokens [ever, vision, school])",
        "secondChanceAttempted": false
      },
      "classifiedContacts": [
        {
          "value": "+977-01-4311600",
          "canonicalDigits": "14311600",
          "type": "phone",
          "phoneType": "landline",
          "role": "primary_business",
          "owner": "business",
          "channels": ["call"],
          "context": "Ever Vision School",
          "pagesSeenOn": ["https://evervisionschool.edu.np/contact"]
        }
      ]
    },
    "metadata": {
      "source": "web",
      "extractedAt": "2026-09-17T09:22:09.000Z",
      "runStartedAt": "2026-09-17T09:22:03.000Z",
      "confidence": 0.94,
      "confidenceBreakdown": {
        "mapsIdentityConfidence": 0.95,
        "websiteEvidenceConfidence": 0.92,
        "contactConfidence": 0.8,
        "overallConfidence": 0.94,
        "conflictPenalty": 1,
        "evidenceSummary": {
          "mapsVerified": true,
          "websiteVerified": true,
          "phoneVerified": true,
          "emailVerified": false,
          "relationshipType": "first_party"
        }
      }
    },
    "process": "Verified via Google + Web search",
    "links": [],
    "gpsCoordinates": { "latitude": 27.693, "longitude": 85.268 },
    "placeId": "...",
    "businessType": "School"
  },
  {
    "name": "Oracle Ray Academy",
    "websites": [],
    "otherDetails": {
      "websiteRelationship": "unverified",
      "discoveryState": "DISCOVERY_FOUND_ONLY_THIRD_PARTY",
      "reconciliationReason": "Provisional discovery URL rejected by downstream verification (unverified)"
    }
  }
]
```

---

## Agents & Tools Reference

| Component | Type | Identifier | Description | Model / Provider |
|:---|:---|:---|:---|:---|
| **`searchWorkerAgent`** | Agent | `search-worker-agent` | Classifies ambiguous candidates | `google/gemini-3.5-flash-lite` |
| **`gemmaSupervisorAgent`** | Agent | `gemma-supervisor-agent` | AI synthesis Layer 2 | `google/gemma-4-26b-a4b-it:free` → `31b` → `nemotron` → `nex` (OpenRouter cascade) |
| **`unoSupervisorAgent`** | Agent | `uno-supervisor-agent` | AI synthesis Layer 1 consensus tribunal | UnoRouter multi-model |
| **`googleMapsSearchTool`** | Tool | `google-maps-search-tool` | Maps Places discovery | Serper.dev `/places` |
| **`broadSearchTool`** | Tool | `broad-search-tool` | Multi-provider web search | Serper → DuckDuckGo |
| **`deepExtractTool`** | Tool | `deep-extract-tool` | Markdown extraction | Tavily Extract API |

---

## Environment Variables

Create `.env` in the `searchDump/` root:

| Variable | Required | Description |
|:---|:---|:---|
| `SERPER_API_KEY` | **Yes** | Google Search & Maps Places from [serper.dev](https://serper.dev) |
| `TAVILY_API_KEY` | **Yes** | Web content extraction from [tavily.com](https://tavily.com) |
| `OPENROUTER_API_KEY` | **Yes** | Gemma 4 / Nemotron via [openrouter.ai](https://openrouter.ai) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | **Yes** | Gemini API for `searchWorkerAgent` |
| `UNOROUTER_API_KEY` | Optional | UnoRouter consensus tribunal (Layer 1 AI). Falls back to OpenRouter if absent. |
| `GOOGLE_API_KEY` | Optional | Fallback alias for Gemini key |
| `DISCOVERY_MODE` | Optional | Website discovery budget mode. `production` (default) = up to `maxWebsiteDiscoveryLookups` targeted lookups per run. `benchmark` = every eligible Maps candidate, hard-capped at 50. Invalid values degrade to `production`. |

```env
SERPER_API_KEY=your_serper_key
TAVILY_API_KEY=your_tavily_key
OPENROUTER_API_KEY=your_openrouter_key
GOOGLE_GENERATIVE_AI_API_KEY=your_gemini_key
UNOROUTER_API_KEY=your_unorouter_key   # optional
DISCOVERY_MODE=production               # optional: production | benchmark
```

---

## Quickstart

### 1. Install Dependencies
```bash
npm install
```

### 2. Start Mastra Studio
```bash
npm run dev
```
Open **[http://localhost:4111](http://localhost:4111)** to trigger workflows, inspect runs, and view agent traces.

### 3. Trigger Programmatically
```typescript
import { mastra } from './src/mastra';

const workflow = mastra.getWorkflow('researchWorkflow');
const run = await workflow.createRun();
const response = await run.start({
  inputData: {
    query: 'Schools',
    location: 'Satungal, Kathmandu',
    targetCandidates: 20,
    maxMapsPages: 3,
    maxPages: 5,
    maxDeepVerifyCandidates: 20,
    websiteDiscoveryMode: 'production',      // 'benchmark' = all eligible (max 50/run)
    maxWebsiteDiscoveryLookups: 10,          // explicit per-run lookup budget
    autoApprove: true,                       // false = pause for human review
    agentId: 'gemma-supervisor-agent',
  },
});
console.log('Verified Listings:', response.results?.listings);
```

---

## Test Suite

```bash
# Full unit + integration suite (zero API calls) — 32 suites
npm test

# Individual zero-API suites
npx tsx scripts/test-business-extractor.ts          # v1.5 phone/email/social (100+ assertions)
npx tsx scripts/test-entity-resolution.ts           # Entity matching cascade
npx tsx scripts/test-candidate-classifier.ts        # Deterministic classifier
npx tsx scripts/test-maps-discovery.ts              # Maps pagination safeguards
npx tsx scripts/test-website-discovery.ts           # Internal page discovery
npx tsx scripts/test-website-discovery-budget.ts    # Discovery budget policy (Phase 7a Task 2)
npx tsx scripts/test-website-discovery-gate.ts      # Universal evaluation gate (Phase 7a Task 3)
npx tsx scripts/test-website-ranker.ts              # Zero-HTTP URL ranker (Phase 7a Task 4)
npx tsx scripts/test-snippet-phone-attribution.ts   # Phone attribution guard (Phase 7a Task 4.5)
npx tsx scripts/test-second-chance.ts               # Bounded second-chance queries (Phase 7a Task 5)
npx tsx scripts/test-ever-vision-discovery.ts       # Phase 7b primary acceptance
npx tsx scripts/test-negative-directory-contamination.ts  # Phase 7b negative acceptance
npx tsx scripts/test-phase7c-defect-remediation.ts  # Phase 7c D1–D4 regression (22 assertions)
npx tsx scripts/test-provenance-integrity.ts        # End-to-end provenance chain
npx tsx scripts/test-verification.ts                # Verified evidence builder
npx tsx scripts/test-website-relationship.ts        # Website relationship classifier
npx tsx scripts/test-confidence-model.ts            # Multi-dimensional confidence model
npx tsx scripts/test-email-sanity-filter.ts         # Email regex + placeholder filter
npx tsx scripts/test-nepal-phone-parsing.ts         # Nepal phone normalization
npx tsx scripts/test-contact-role-classifier.ts     # Contact role classification
npx tsx scripts/test-social-ownership.ts            # Social profile ownership
npx tsx scripts/test-foundation-v3.ts               # Foundation v3 golden fixtures

# Phase 7c defects only
npm run test:phase7c-defects

# End-to-end (live API calls)
npm run test:e2e           # Full workflow E2E
npm run test:e2e:phase2    # Phase 2 extraction E2E
npm run test:all           # Comprehensive pipeline benchmark

# Live acceptance benchmark (Task 15)
npx tsx scripts/run-satungal-schools-acceptance.ts
```

`npm test` runs **32 zero-API suites** covering: entity resolution, candidate classification, Maps pagination, website page discovery, discovery budget policy, universal evaluation gate, zero-HTTP URL ranker, snippet phone attribution guard, bounded second-chance queries, v1.5 phone normalization (100+ regression fixtures), verified evidence builder, website relationship classifier, social profile vendors, offline extraction, output structure, cross-listing conflicts, phone dedup invariant, confidence model, foundation hardening, verification state, provenance integrity, email sanity filter, Nepal phone parsing, contact role classification, social ownership, website lifecycle, category expansion, conflict artifact, foundation v3 golden fixtures, Phase 7b positive acceptance, Phase 7b negative acceptance, and Phase 7c defect remediation — all zero-API-cost.

---

## Caching & Cross-Run Behaviour

- **Same query + location run twice within 7 days**: Maps discovery and web search both hit the **disk cache** — the same businesses will be returned. This is by design (saves API credits).
- **Cross-run deduplication**: Does **not** exist. The workflow has no knowledge of previous runs. `output/latest/businesses.json` is consumed by external clients, never read back by the pipeline.
- **Cache invalidation**: Delete `.cache/search-results.json` to force fresh provider calls on the next run.

---

## License

ISC License. Built for agentic business research and discovery.
