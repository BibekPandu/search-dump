#  Agentic Business Discovery Pipeline
An intelligent, multi-stage business intelligence engine built on **Mastra**, **Google Serper (Google Search & Google Maps Places)**, **DuckDuckGo**, **Tavily Extract**, and **Google Gemma / Gemini** via **OpenRouter** and **UnoRouter**.
The pipeline discovers local businesses and commercial entities by fusing Google Maps Places with web search, filters noise using a hybrid deterministic + LLM classifier, crawls official websites with a multi-layer extraction strategy (Tavily + Raw HTML safety net + AJAX footer recovery), runs deterministic phone/email/social normalization, and synthesizes verified business listings with contact details, GPS coordinates, ratings, and confidence scores.
---
##  System Architecture
```
                           ┌──────────────────────────────────┐
                           │     User Query + Location        │
                           │  target=N, maxPages, maxMapsPages│
                           └────────────────┬─────────────────┘
                                            │
                     ──── Phase 0: Google Maps Places First ────
                                            ▼
           ┌────────────────────────────────────────────────────────────┐
           │ maps-discovery.service.ts / paginateMapsDiscovery()        │
           │ • Paginates Serper.dev /places (up to maxMapsPages)        │
           │ • Captures: title, address, phone, GPS, rating, placeId    │
           │ • 4 safeguards: target_reached | maps_exhausted |          │
           │   stale_limit_reached (2 consecutive) | max_pages_reached  │
           │ • Targeted Web Lookup: discovers official sites for        │
           │   Maps entries lacking a website URL                       │
           │ • Entity dedup via resolveEntityPair() cascade:            │
           │   phone digits → domain → name+address Jaccard             │
           └───────────────────────────┬────────────────────────────────┘
                                       │
            ┌── target reached? ───────┴──────────── no ──┐
            │  (skip web search)           Phase 1 Web Fallback
            ▼                                             ▼
           ┌────────────────────────────────────────────────────────────┐
           │ research-workflow.ts / runResearchDiscovery()              │
           │ Web Fallback Pagination Loop (page 1..maxPages)            │
           │  1. searchWithFallback() — Serper → DuckDuckGo cascade     │
           │     7-day disk cache (.cache/search-results.json)          │
           │  2. seenUrls dedup — URL-level across pages                │
           │  3. filterSearchResults() — deterministic domain/path/     │
           │     listicle regex (0 API cost)                            │
           │  4. searchWorkerAgent — LLM classification of ambiguous    │
           │     items only (Gemini Flash Lite)                         │
           │  5. buildResearchCandidates() — entity merge & dedup       │
           │  Stopping: target_reached | no_more_pages |                │
           │            no_new_results (2+ consecutive stale) |         │
           │            max_pages_reached                               │
           └───────────────────────────┬────────────────────────────────┘
                                       │
                    output/0-research-candidates.json
                    output/0b-research-candidates-lean.json
                                       │
                 ──── Step 1: Human-in-the-Loop Review ────
                                       ▼
           ┌────────────────────────────────────────────────────────────┐
           │ humanReviewStep()                                          │
           │ • autoApprove=true: passes through instantly (headless)    │
           │ • autoApprove=false: suspends for interactive review       │
           │   Supports optional URL filter for partial approval        │
           └───────────────────────────┬────────────────────────────────┘
                                       │
           ──── Step 2: Deep Website Extraction & Verification ────
                                       ▼
           ┌────────────────────────────────────────────────────────────┐
           │ deepExtractionStep() — Per-candidate 5-layer extraction    │
           │                                                            │
           │  For each candidate with an official website:              │
           │  1. Homepage Tavily Extract (basic depth, cached)          │
           │  2. discoverWebsitePages() — finds best internal pages     │
           │     (/contact, /about) via markdown link parsing +         │
           │     fallback guessing (0 extra API calls)                  │
           │  3. Batch Tavily Extract for up to 4 internal pages        │
           │  4. Raw HTML Safety Net (fetchRawPageHtml)                 │
           │     Always for: homepage, contact page                     │
           │     Also if: candidate has zero contact or social signals  │
           │     Cost: 0 API credits (~80-120ms native fetch)           │
           │  5. AJAX/Componentized Footer Recovery                     │
           │     Probes /footer.html if footer placeholder detected     │
           │     or still-zero social signals after raw HTML pass       │
           │  6. Secondary Tavily Advanced Retry                        │
           │     Only if still zero phones/emails after all passes      │
           │                                                            │
           │  buildVerifiedEvidence() — deterministic per-candidate     │
           │  structure: extractedPhones, extractedMobiles, emails,     │
           │  socialLinks, favicon, PhoneEvidence[] page provenance     │
           └───────────────────────────┬────────────────────────────────┘
                                       │
                    output/2-deep-extractions.json
                    output/2b-verified-evidence.json
                                       │
              ──── Step 3: AI Business Data Synthesis ────
                                       ▼
           ┌────────────────────────────────────────────────────────────┐
           │ supervisorSynthesisStep() — 3-Layer AI Cascade             │
           │                                                            │
           │  Layer 1: UnoRouter AI Consensus Tribunal                  │
           │    generateWithUnoTribunal() — multi-model consensus       │
           │    (used when UNOROUTER_API_KEY is set)                    │
           │                                                            │
           │  Layer 2: OpenRouter Supervisor Agent                      │
           │    gemmaSupervisorAgent — Gemma 4 / Nemotron on OpenRouter │
           │    Cascade: gemma-4-26b → gemma-4-31b → nemotron → nex    │
           │                                                            │
           │  Layer 3: Zero-Token Deterministic Fallback                │
           │    buildFallbackListing() — no LLM required                │
           │                                                            │
           │  Post-synthesis re-injection (deterministic, no LLM):      │
           │  • GPS coordinates from Google Maps candidates             │
           │  • Star ratings, review counts, placeIds                   │
           │  • sanitizeListingWithEvidence() routes phones, mobiles,   │
           │    emails, socialLinks from verifiedEvidence               │
           └───────────────────────────┬────────────────────────────────┘
                                       │
                    output/3-final-listings.json
                    output/latest/businesses.json
                    output/latest/summary-report.json
                    output/history/{timestamp}-{slug}/  (all stages)
```
---
##  v1.5 Deterministic Phone Normalization Pipeline

All phone handling is **zero-LLM** and fully deterministic:
```
Raw phone candidate (text / HTML / tel: href)
  ↓
expandSlashExtensions()       e.g. "+977 1 5363501/511/560" → 3 numbers
  ↓
classifyNepalPhone(raw)       Explicit structure recognition (no guessing):
  │  PATH A: +977 prefix
  │    • 97x/98x + 10 mobile digits → mobile
  │    • 1 + 8 landline digits      → landline
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
---
##  Key Features
### 1.  Google Maps-First Discovery (Phase 0)
- Paginates Google Maps Places via Serper.dev `/places` with up to `maxMapsPages` pages.
- Captures: addresses, phone numbers, GPS coordinates, star ratings, review counts, business categories, placeIds.
- **Targeted Web Lookup**: Automatically finds official websites for businesses with no Maps website (filtered through `isUsableOfficialWebsite()`).
- **Entity deduplication**: `dedupeByEntity()` collapses duplicate Maps entries before adding to the candidate pool.
### 2.  Zero-API-Cost Deterministic Candidate Filtering
- `candidate-classifier.service.ts` handles >90% of filtering with no LLM tokens.
- **Aggregators blocked**: Booking.com, Agoda, TripAdvisor, Expedia, Trivago, Makemytrip, Kayak, Airbnb, Hostelworld, Viator, GetYourGuide, and dozens more.
- **Directories blocked**: YellowPages, Yelp, Justdial, SignalHire, ZoomInfo, Manta, Crunchbase, Foursquare, etc.
- **Social media blocked**: Facebook, Instagram, TikTok, LinkedIn, Twitter/X, YouTube, Reddit, Quora, Pinterest, etc.
- **Listicles blocked**: Paths matching `/blog/`, `/news/`, `/article/`, `/guides/`, and title patterns like *"10 Best…"*.
### 3.  LLM Ambiguous Item Classification
- Only genuinely ambiguous candidates go to `searchWorkerAgent` (`google/gemini-3.5-flash-lite`).
- Classifies: `business | aggregator | directory | article | social | irrelevant`.
- LLM failure is safe: ambiguous items default to excluded.
### 4.  Multi-Provider Search Fallback
- **Primary**: Google Serper API with native `page` parameter.
- **Fallback**: DuckDuckGo (`duck-duck-scrape`) with native offset-based pagination.
- Both share the same 7-day disk cache.
### 5.  Deterministic Entity Resolution (0-Token)
Three-level cascade in `resolveEntityPair()`:
1. **Phone digits** (≥7 digits, exact match) → confidence 1.0
2. **Official domain** (exact match, excludes social/google) → confidence 1.0
3. **VETO**: conflicting phone or domain blocks soft matches entirely
4. **Name + Address Jaccard** (nameSim ≥ 0.85 + addrSim ≥ 0.5, or nameSim ≥ 0.95 alone) → confidence 0.85–0.9
### 6.  Multi-Layer Website Extraction
- **Tavily Extract** (basic depth, cached per-URL 7 days): homepage + up to 4 internal pages.
- **Raw HTML Safety Net**: Always fires for homepage and contact pages (0 API credits). Recovers icon-only social anchors, `mailto:` and `tel:` href links that readability parsers strip.
- **AJAX Footer Recovery**: Probes `/footer.html` for sites with componentized/templated footers that render empty on initial load.
- **Secondary Tavily Advanced Retry**: Only when all prior layers yield zero contact signals.
### 7.  Deterministic Data Quality (v1.5)
- `classifyNepalPhone()`: Explicit structure validation, never guesses.
- `formatPhoneDisplay()`: `+977-9XX-XXXXXXX` (mobile), `+977-01-XXXXXXX` (landline), raw-preserved (international).
- EPABX slash expansion: `+977 1 5363501/511/560` → 3 separate landlines.
- `PhoneEvidence[]` per-page provenance for every phone candidate.
- Strict taxonomy: `phones ∩ mobiles = ∅` enforced as a hard invariant.
- Social link validation: rejects Facebook `/sharer`, Twitter `/share`, Instagram posts/reels/explore, LinkedIn `/shareArticle`.
- Email sanitization: strips trailing `)*`, `\`, `\\`, markdown wrappers before dedup.
### 8.  3-Layer AI Synthesis with Deterministic Fallback
| Layer | Mechanism | Trigger |
|---|---|---|
| 1 | UnoRouter AI Consensus Tribunal | When `UNOROUTER_API_KEY` is set |
| 2 | OpenRouter Supervisor Agent (Gemma 4 cascade) | When Layer 1 unavailable or fails |
| 3 | Zero-token `buildFallbackListing()` | When both AI layers fail or return empty |
### 9.  Deterministic Post-Synthesis Re-injection
After AI synthesis, a deterministic pass re-injects:
- Exact GPS coordinates from Maps candidates (never LLM-inferred)
- Star ratings, review counts, placeIds
- `sanitizeListingWithEvidence()` routes phones, mobiles, emails, social links from `verifiedEvidence`
### 10.  No-Website Tradesmen Preservation
Local businesses with a Maps listing and phone but no website are preserved and emitted as valid listings — they are never dropped because extraction returns empty.
### 11.  7-Day Disk Cache (Shared Across All Providers)
- Single file: `.cache/search-results.json`
- Three namespaced providers in the same file: `serper-places`, `serper-search`, `tavily-extract`
- SHA-256 keyed: `hash(provider::query)` — collision-safe
- Atomic write lock prevents race conditions
### 12.  Dual-Folder Output Architecture
- `output/latest/` — always the most recent run (overwrites every run)
- `output/history/{timestamp}-{slug}/` — permanent per-run archive (never overwritten)
---
##  Project Structure
```
searchDump/
├── .cache/
│   └── search-results.json          # 7-day shared disk cache (Maps + Web + Tavily)
├── output/
│   ├── latest/                      # Most recent run (always current)
│   │   ├── businesses.json          # Final BusinessListing[] — UI/export ready
│   │   └── summary-report.json      # Run KPIs (count, contacts, runtime)
│   ├── history/                     # Permanent per-run archives (co-located)
│   │   └── <timestamp>-<slug>/
│   │       ├── 0-research-candidates.json
│   │       ├── 0b-research-candidates-lean.json
│   │       ├── 1-broad-search.json
│   │       ├── 2-deep-extractions.json
│   │       ├── 2b-verified-evidence.json
│   │       ├── 3-final-listings.json
│   │       └── summary-report.json
│   └── (root mirrors)               # Backward-compatible mirrors
│       ├── 0-research-candidates.json
│       ├── 2b-verified-evidence.json
│       ├── 3-final-listings.json
│       └── results.json
├── scripts/
│   ├── test-business-extractor.ts   # v1.5 phone/email/social regression suite (100+ assertions)
│   ├── test-entity-resolution.ts    # Entity matching cascade unit tests
│   ├── test-candidate-classifier.ts # Deterministic classifier benchmark
│   ├── test-maps-discovery.ts       # Maps pagination safeguard unit tests
│   ├── test-website-discovery.ts    # Website page discovery unit tests
│   ├── test-verification.ts         # Verified evidence builder tests
│   ├── test-step3-projection.ts     # Step 3 taxonomy + slash expansion tests
│   ├── test-deep-extraction-offline.ts  # Offline extraction path tests
│   ├── test-output-structure.ts     # Output folder/file structure tests
│   ├── test-all-fixes.ts            # Comprehensive pipeline benchmark
│   ├── test-research-workflow-e2e.ts    # Live E2E workflow test
│   ├── test-phase2-e2e.ts           # Phase 2 extraction E2E test
│   ├── test-unorouter.ts            # UnoRouter consensus tribunal test
│   ├── test-gemma-experiment.ts     # OpenRouter Gemma reasoning benchmark
│   ├── test-enrichment-logic.ts     # Enrichment logic unit tests
│   └── inspect-lookups.ts           # Targeted lookup debug tool
├── src/
│   ├── services/
│   │   ├── business-extractor.service.ts   # Phone/email/social extraction + v1.5 normalization
│   │   │                                   # classifyNepalPhone, formatPhoneDisplay, PhoneEvidence
│   │   │                                   # extractEmails, extractSocialLinks, expandSlashExtensions
│   │   ├── cache.service.ts                # Root-anchored SHA-256 disk cache, atomic write lock
│   │   ├── candidate-classifier.service.ts # Fast domain/path/listicle regex classifier
│   │   ├── db.service.ts                   # LibSQL memory store + getProjectRootDir()
│   │   ├── entity-resolution.service.ts    # resolveEntityPair, dedupeByEntity, isUsableOfficialWebsite
│   │   │                                   # normalizeNameKey, tokenJaccard, normalizePhoneDigits
│   │   ├── maps-discovery.service.ts       # paginateMapsDiscovery() — 4-safeguard Maps pagination
│   │   ├── openrouter.service.ts           # OpenRouter API client
│   │   ├── output-storage.service.ts       # saveStageOutput (dual-write), startRunSession
│   │   ├── research-candidate.service.ts   # buildResearchCandidates(), toUnifiedCandidates()
│   │   ├── search-fallback.service.ts      # searchWithFallback() — Serper → DuckDuckGo, caching
│   │   ├── serper-places.service.ts        # searchSerperPlaces() — /places endpoint, cached
│   │   ├── serper-search.service.ts        # Google Serper web search client
│   │   ├── tavily-extract.service.ts       # tavilyExtract() — basic/advanced, per-URL cache
│   │   ├── unorouter.service.ts            # generateWithUnoTribunal() — multi-model consensus
│   │   ├── url-filter.service.ts           # filterCandidateUrls() — official domain prioritizer
│   │   ├── verification.service.ts         # buildVerifiedEvidence(), keyOfCandidate()
│   │   └── website-discovery.service.ts    # discoverWebsitePages() — internal page discovery
│   └── mastra/
│       ├── index.ts                        # Mastra instance — registered agents & workflows
│       ├── Tools/
│       │   ├── broad-search.ts             # broadSearchTool
│       │   ├── deep-extract.ts             # deepExtractTool
│       │   └── google-maps-search.ts       # googleMapsSearchTool
│       ├── agents/
│       │   ├── research-agent/
│       │   │   ├── schema.ts               # ResearchReport, ResearchCandidate, ResearchDecision
│       │   │   └── verification.schema.ts  # VerifiedBusinessEvidence, PhoneEvidence, WebsiteEvidence
│       │   ├── search-worker/
│       │   │   ├── config.ts               # searchWorkerAgent (Gemini Flash Lite)
│       │   │   └── prompt.md
│       │   ├── gemma-supervisor/
│       │   │   ├── config.ts               # gemmaSupervisorAgent (Gemma 4 via OpenRouter)
│       │   │   └── prompt.md
│       │   └── uno-supervisor/
│       │       ├── config.ts               # UnoRouter tribunal agent
│       │       └── prompt.md
│       └── workflows/
│           └── research-workflow.ts        # End-to-end 4-step discovery workflow (1818 lines)
├── cspell.json                      # Domain-specific spellcheck dictionary
├── package.json
└── tsconfig.json
```
---
##  Data Contracts
### Research Candidates (`output/0-research-candidates.json`)
```json
{
  "query": "Tours and Travels",
  "location": "Kathmandu",
  "pagesSearched": 0,
  "targetCandidates": 10,
  "uniqueBusinessesFound": 10,
  "matchesMerged": 2,
  "stoppedReason": "target_reached",
  "researchCandidates": [
    {
      "name": "Kumari Tours & Travels",
      "location": "Thamel, Kathmandu",
      "website": "https://kumaritravel.com",
      "phone": "+977 1 5363501",
      "coordinates": { "lat": 27.7172, "lng": 85.3128 },
      "rating": 4.6,
      "ratingCount": 134,
      "category": "Travel agency",
      "sources": {
        "googleMaps": { "found": true, "placeId": "...", "address": "..." },
        "webSearch": []
      },
      "entityMatch": { "matched": false, "confidence": 0, "method": "none" },
      "classification": { "status": "usable", "type": "business", "confidence": 1.0 }
    }
  ]
}
```
### Verified Evidence (`output/2b-verified-evidence.json`)
```json
{
  "query": "Tours and Travels",
  "maxDeepVerifyCandidates": 10,
  "verifiedEvidence": [
    {
      "candidateKey": "kumari-tours-travels",
      "name": "Kumari Tours & Travels",
      "websiteEvidence": {
        "url": "https://kumaritravel.com",
        "domain": "kumaritravel.com",
        "extractedEmails": ["info@kumaritravel.com"],
        "extractedPhones": ["+977-01-5363501", "+977-01-5363511"],
        "extractedMobiles": ["+977-985-1334626"],
        "extractedSocialLinks": {
          "facebook": "https://facebook.com/kumaritravel",
          "instagram": "https://instagram.com/kumaritravel",
          "tiktok": "",
          "other": {}
        },
        "favicon": "https://kumaritravel.com/favicon.ico",
        "extractedPhoneEvidence": [
          {
            "raw": "+977 1 5363501/511",
            "canonicalDigits": "15363501",
            "display": "+977-01-5363501",
            "type": "landline",
            "source": "markdown",
            "pageUrl": "https://kumaritravel.com/contact"
          }
        ]
      },
      "verification": {
        "status": "verified",
        "overallConfidence": 0.95,
        "checks": {
          "websiteIsUsableOfficial": true,
          "websiteDomainMatchesCandidate": true,
          "businessNameFoundOnWebsite": true,
          "phoneMatchesMaps": true,
          "emailFoundOnWebsite": true,
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
    "name": "Kumari Tours & Travels",
    "location": "Thamel, Kathmandu",
    "emails": ["info@kumaritravel.com"],
    "phones": ["+977-01-5363501", "+977-01-5363511"],
    "mobiles": ["+977-985-1334626"],
    "websites": ["https://kumaritravel.com"],
    "icon": "https://kumaritravel.com/favicon.ico",
    "socialLinks": {
      "facebook": "https://facebook.com/kumaritravel",
      "tiktok": "",
      "instagram": "https://instagram.com/kumaritravel",
      "other": {}
    },
    "otherDetails": {
      "address": "Thamel, Kathmandu",
      "rating": 4.6,
      "ratingCount": 134,
      "businessType": "Travel agency"
    },
    "gpsCoordinates": { "latitude": 27.7172, "longitude": 85.3128 },
    "rating": 4.6,
    "ratingCount": 134,
    "placeId": "ChIJ...",
    "metadata": {
      "source": "google_maps",
      "extractedAt": "2026-09-14T06:00:00.000Z",
      "confidence": 0.95
    },
    "process": "Verified via Google Maps Places + Tavily Website Extract"
  }
]
```
---
##  Agents & Tools Reference
| Component | Type | Identifier | Description | Model / Provider |
|:---|:---|:---|:---|:---|
| **`searchWorkerAgent`** | Agent | `search-worker-agent` | Classifies ambiguous candidates | `google/gemini-3.5-flash-lite` |
| **`gemmaSupervisorAgent`** | Agent | `gemma-supervisor-agent` | AI synthesis Layer 2 | `google/gemma-4-26b-a4b-it:free` → 31b → nemotron → nex (OpenRouter) |
| **`unoSupervisorAgent`** | Agent | `uno-supervisor-agent` | AI synthesis Layer 1 consensus tribunal | UnoRouter multi-model |
| **`googleMapsSearchTool`** | Tool | `google-maps-search-tool` | Maps Places discovery | Serper.dev `/places` |
| **`broadSearchTool`** | Tool | `broad-search-tool` | Multi-provider web search | Serper → DuckDuckGo |
| **`deepExtractTool`** | Tool | `deep-extract-tool` | Markdown extraction | Tavily Extract API |
---
##  Environment Variables
Create `.env` in the `searchDump/` root:
| Variable | Required | Description |
|:---|:---|:---|
| `SERPER_API_KEY` | **Yes** | Google Search & Maps Places from [serper.dev](https://serper.dev) |
| `TAVILY_API_KEY` | **Yes** | Web content extraction from [tavily.com](https://tavily.com) |
| `OPENROUTER_API_KEY` | **Yes** | Gemma 4 / Nemotron via [openrouter.ai](https://openrouter.ai) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | **Yes** | Gemini API for `searchWorkerAgent` |
| `UNOROUTER_API_KEY` | Optional | UnoRouter consensus tribunal (Layer 1 AI). Falls back to OpenRouter if absent. |
| `GOOGLE_API_KEY` | Optional | Fallback alias for Gemini key |

```env
SERPER_API_KEY=your_serper_key
TAVILY_API_KEY=your_tavily_key
OPENROUTER_API_KEY=your_openrouter_key
GOOGLE_GENERATIVE_AI_API_KEY=your_gemini_key
UNOROUTER_API_KEY=your_unorouter_key   # optional
```
---
##  Quickstart
### 1. Install Dependencies
```bash
npm install
```
### 2. Start Mastra Studio
```bash
npm run dev
```
Open **[http://localhost:4111](http://localhost:4111)** to trigger workflows, inspect runs, and view agent traces
### 3. Trigger Programmatically
```typescript
import { mastra } from './src/mastra';
const workflow = mastra.getWorkflow('researchWorkflow');
const run = await workflow.createRun();
const response = await run.start({
  inputData: {
    query: 'Tours and Travels',
    location: 'Kathmandu',
    targetCandidates: 20,
    maxMapsPages: 3,
    maxPages: 5,
    maxDeepVerifyCandidates: 20,
    autoApprove: true,           // false = pause for human review
    agentId: 'gemma-supervisor-agent',
  },
});
console.log('Verified Listings:', response.results?.listings);
```
---
##  Test Suite
```bash
# Full unit + integration suite (zero API calls)
npm test
# Individual zero-API suites
npx tsx scripts/test-business-extractor.ts    # v1.5 phone/email/social (100+ assertions)
npx tsx scripts/test-entity-resolution.ts     # Entity matching cascade
npx tsx scripts/test-candidate-classifier.ts  # Deterministic classifier
npx tsx scripts/test-maps-discovery.ts        # Maps pagination safeguards
npx tsx scripts/test-website-discovery.ts     # Internal page discovery
npx tsx scripts/test-verification.ts          # Verified evidence builder
npx tsx scripts/test-step3-projection.ts      # Step 3 taxonomy invariants
npx tsx scripts/test-output-structure.ts      # Output folder structure
# End-to-end (live API calls)
npm run test:e2e         # Full workflow E2E
npm run test:e2e:phase2  # Phase 2 extraction E2E
npm run test:all         # Comprehensive pipeline benchmark
```
`npm test` runs 8 test files (entity resolution, candidate classification, Maps pagination, website discovery, v1.5 phone normalization with 100+ regression fixtures, verification, offline extraction, output structure) — all zero-API-cost.
---
##  Caching & Cross-Run Behaviour
- **Same query + location run twice within 7 days**: Maps discovery and web search both hit the **disk cache** — the same businesses will be returned. This is by design (saves API credits).
- **Cross-run deduplication**: Does **not** exist. The workflow has no knowledge of previous runs. `output/latest/businesses.json` is consumed by external clients, never read back by the pipeline.
- **Cache invalidation**: Delete `.cache/search-results.json` to force fresh provider calls on the next run.
---
##  License
ISC License. Built for agentic business research and discovery.
