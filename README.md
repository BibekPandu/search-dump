# Agentic Business Discovery & Extraction Engine

An intelligent, multi-stage business intelligence and data synthesis pipeline built on **Mastra**, **Google Serper** (Search & Places), **DuckDuckGo**, **Tavily Extract**, and **OpenRouter** AI supervisor agents with zero-token deterministic fallback.

The engine discovers authentic local businesses by fusing Google Maps Places with organic web search, enforces strict geographic locality boundaries using dynamic OSM geocoding and registered clusters, discovers official websites via deterministic token ranking, crawls websites through multi-layer extraction, validates contact information using official telecom standards, applies cascade rejection to purge third-party directory contamination, promotes verified social links independently, and synthesizes structured, high-confidence business profiles with GPS coordinates, phone taxonomies, and provenance metadata.

---

##  System Architecture

```
                               ┌──────────────────────────────────────────┐
                               │         User Query + Location            │
                               │  query, location, targetCandidates,      │
                               │  maxPages, maxMapsPages, discoveryMode   │
                               └─────────────────┬────────────────────────┘
                                                 │
                   ──── Stage 0: Google Maps Ingestion & Discovery ────
                                                 ▼
               ┌──────────────────────────────────────────────────────────────────┐
               │ 1. Google Maps Places Discovery (maps-discovery.service.ts)      │
               │    • Paginates Serper /places with pagination safeguards         │
               │    • Captures: Title, address, phone, GPS, rating, placeId       │
               │                                                                  │
               │ 2. Dynamic Geocoding & Boundary Gate (geographic-evaluator)      │
               │    • extractCanonicalLocality: Strips trailing district qualifiers│
               │    • Dynamic OSM Nominatim geocoding with clamped radius formula │
               │      R = min(max(bboxRadius * 1.25, 2.0km), 8.0km)               │
               │    • Static registry fallback with ward aliasing (Satungal-11..13)│
               │    • Strict exclusion of out-of-boundary Places                  │
               │                                                                  │
               │ 3. Yield-Protecting Overfetch Buffer (W2-08)                     │
               │    • Bounds candidates to max(2x target, target + 5)             │
               │    • Early halt on search queries once overfetch cap reached     │
               │    • Absorbs extraction dropouts without starving final yield    │
               │                                                                  │
               │ 4. Universal Website Discovery Gate (website-discovery-gate)     │
               │    • Evaluates all Maps candidates lacking websites              │
               │    • Zero-HTTP Token Ranker: First-party match vs directory block │
               │    • Multi-tenant template detection (/service/{slug}, etc.)     │
               │    • Phone Attribution Guard: Snippet phones from own domain only│
               │                                                                  │
               │ 5. Entity Deduplication Cascade (entity-resolution.service.ts)   │
               │    • Exact Phone Digits (≥7) → Official Domain → Name+Address    │
               └─────────────────────────────────┬────────────────────────────────┘
                                                 │
                               ┌─ Target Reached? ─┴─ No ──┐
                               │                           ▼
                               │        Stage 1: Web Search Fallback
                               │        • Serper → DuckDuckGo search cascade
                               │        • Deterministic Aggregator/Directory filter
                               │        • LLM classifier for ambiguous search items
                               │                           │
                               └─────────────┬─────────────┘
                                             │
                   ──── Stage 2: Deep Extraction & Evidence Verification ────
                                             ▼
               ┌──────────────────────────────────────────────────────────────────┐
               │ Multi-Layer Extraction Pipeline (deepExtractionStep)             │
               │ 1. Homepage Tavily Extract (Markdown + structured links)         │
               │ 2. Internal Page Discovery (/contact, /about, /services)         │
               │ 3. Batch Internal Page Extraction                                │
               │ 4. Raw HTML Safety Net: Native fast fetch for icon-only socials, │
               │    tel:, mailto: links stripped by markdown parsers              │
               │ 5. AJAX / Componentized Footer Recovery (/footer.html)           │
               │ 6. Address Re-check: Revalidates extracted addresses against geo│
               │                                                                  │
               │ Verified Evidence Builder (verification.service.ts)              │
               │ • Extracts Phones, Mobiles, Emails, Social Links, Favicons       │
               │ • Contact Role Decision Matrix: Maps Authority vs Staff Person   │
               │ • Rule A First-Seen-Wins Contact Deduplication (pagesSeenOn[])   │
               └─────────────────────────────────┬────────────────────────────────┘
                                                 │
                   ──── Stage 3: Synthesis, Sanitization & Output Capping ────
                                                 ▼
               ┌──────────────────────────────────────────────────────────────────┐
               │ 1. Direct Synthesis & Deterministic Fallback                     │
               │    • Layer 2: OpenRouter Supervisor Agent (gemma-supervisor)     │
               │    • Layer 3: Zero-Token Deterministic Fallback                  │
               │                                                                  │
               │ 2. Deterministic Evidence Sanitizer (Zero Hallucination)         │
               │    • Deterministically re-injects GPS, placeId, ratings from Maps│
               │    • Cascade Rejection: Discards all contacts and socials        │
               │      sourced from unverified or directory domains                │
               │    • Corporate Parent Guard: Blocks HQ emails & foreign phones   │
               │    • Social Link Independence: Promotes verified SERP socials    │
               │      independently; applies deliberate empty fallback if none    │
               │    • Enforces Phone Invariant: phones ∩ mobiles = ∅              │
               │                                                                  │
               │ 3. Post-Synthesis Filtering & Output Capping                     │
               │    • Zero-Actionable Filter: Drops listings with 0 contact modes │
               │    • Quality-Sorted Hard Cap (W2-08): Sorts by confidence and    │
               │      completeness, strictly enforcing requested targetCandidates │
               │    • Multi-dimensional deterministic confidence calculation      │
               └─────────────────────────────────┬────────────────────────────────┘
                                                 │
                                                 ▼
                                     Dual Output Generation
                                     • output/latest/businesses.json
                                     • output/latest/summary-report.json
                                     • output/history/{timestamp}-{slug}/
```

---

##  Core Engine Capabilities

### 1. Maps-First Discovery & Dynamic Geocoding
- **Google Maps Ingestion**: Queries Serper `/places` for authoritative business listings, ratings, and GPS coordinates.
- **Dynamic OSM Geocoding (`geocoding.service.ts`)**:
  - **Query Normalization (`extractCanonicalLocality`)**: Strips broad administrative qualifiers (`"Tokha, Kathmandu"` $\to$ `"Tokha"`) so variations share the same cache key and Nominatim polygon.
  - **Clamped Dynamic Radius**: Computes distance from centroid to the 4 bounding box corners and scales:
    $$\text{radiusKm} = \min(\max(\text{bboxRadius} \times 1.25, 2.0), 8.0)$$
  - **Static Registry Fallback**: Retains verified centroids and ward aliases for registered clusters (e.g. Satungal Wards 11–13).
- **Yield-Protecting Overfetch Buffer (W2-08)**:
  - Binds pre-enrichment places to $\max(2 \times \text{target}, \text{target} + 5)$.
  - Halts query pagination early once the buffer is met, protecting runtime while ensuring enough candidates to absorb downstream verification failures.

### 2. Universal Website Discovery & Directory Defense
- **Universal Evaluation Gate (`website-discovery-gate.service.ts`)**: Evaluates all Maps candidates lacking websites and assigns strict audit states (`MAPS_HAS_WEBSITE`, `DISCOVERY_FOUND_FIRST_PARTY`, `DISCOVERY_FOUND_ONLY_THIRD_PARTY`, `DISCOVERY_EXHAUSTED_NO_FIRST_PARTY`, `DISCOVERY_NOT_ATTEMPTED_BUDGET`).
- **Deterministic Token Ranker (`website-search-ranker.service.ts`)**:
  - Scores search results with weighted token matching (Name tokens $+12$, Domain bonus $+10$, Location $+10$, TLD bonus $+12$, Third-Party penalty $-50$).
  - Multi-tenant directory listing templates (`/restaurant/{slug}`, `/service/{slug}`, `/places/{id}`) are penalized and excluded.
  - **Directory Blocklist**: Hard blocks known aggregator domains (`bhansaghar.com`, `prolinknepal.com`, `hamrobazaar.com`, `volza.com`, `skillsewa.com`, `tripadvisor.com`, etc.).
- **Snippet Phone Attribution Guard**: Extracts phone numbers from search snippets only when the snippet URL belongs to the candidate's verified first-party domain.

### 3. Multi-Layer Extraction & Address Verification
- **Tavily Markdown Extraction**: Scrapes homepages and discovers internal `/contact`, `/about`, and `/services` pages.
- **Raw HTML Safety Net**: Native fast fetch inspecting raw markup to recover `tel:`, `mailto:`, and icon-only social anchors stripped by text parsers.
- **Step 2 Address Re-check**: Revalidates extracted addresses against the dynamic geocoder, excluding candidates whose web footers reveal out-of-boundary headquarters.

### 4. Deterministic Contact Taxonomy & Cascade Rejection
- **Nepal Telecom Authority (NTA) Parser (`nepal-telecom.config.ts`)**:
  - Validates domestic mobile prefixes (`98x`, `97x`, `96x`) and fixed-line area codes (`01` for Kathmandu, `061` for Pokhara, etc.).
  - Mathematical Invariant: Enforces $\text{phones} \cap \text{mobiles} = \emptyset$.
- **Cascade Contact Rejection (W2-07)**:
  - When a candidate's website is classified as `unverified` or directory, **all** contacts extracted from that site are purged. Only Maps-verified contacts survive.
  - **Corporate Parent Isolation**: Corporate parent domains do not leak headquarters emails or foreign manufacturer (+91...) phones; only exact matching Maps phone digits are accepted.
- **Social Link Independence**:
  - Validates social URLs independently of website status using token matching against the business name.
  - Verified `discoveredSocials` from SERP review are promoted directly.
  - If no candidate profile matches, `socialLinks` remains deliberately empty (`{ facebook: '', instagram: '', tiktok: '', other: {} }`).

### 5. Synthesis, Quality Capping & Confidence Scoring
- **Direct Synthesis Cascade**:
  - Direct execution via Layer 2 OpenRouter Supervisor Agent (`gemma-supervisor-agent` or specified model), bypassing free-tier rate limits.
  - Layer 3 zero-token deterministic fallback guarantees structured output if LLM generation fails or produces malformed JSON.
- **Post-Synthesis Quality-Sorted Hard Cap (W2-08)**:
  - Sorts final listings descending by `metadata.confidence` (with contact completeness tie-breaking).
  - Slices strictly to `targetCandidates`.
  - When `targetCandidates` is undefined, all valid listings are preserved without artificial caps.
- **Zero-Actionable Filter (W2-05)**:
  - Drops zombie listings where all contact channels (phones, mobiles, emails, websites) are completely empty.
- **Multi-Dimensional Deterministic Confidence**:
  - Formula combining Maps identity ($0.95$), website evidence, contact verification, and entity conflict penalties.

---

##  Repository Structure

```
searchDump/
├── .cache/
│   ├── geocoding/                   # Persistent OSM Nominatim geocoding cache
│   └── search-results.json          # 7-day shared disk cache (Maps + Web + Tavily)
├── output/
│   ├── latest/                      # Most recent run (overwritten each execution)
│   │   ├── businesses.json          # Verified BusinessListing[] ready for consumption
│   │   └── summary-report.json      # Run KPIs and execution telemetry
│   └── history/                     # Permanent timestamped run archives
│       └── <timestamp>-<slug>/      # Complete audit trail (Stage 0, 1, 2, 3 artifacts)
├── src/
│   ├── config/
│   │   ├── geo-localities.config.ts    # OSM centroids & ward-level geographic boundaries
│   │   ├── nepal-telecom.config.ts     # Authoritative NTA mobile & landline prefix tables
│   │   └── website-discovery.config.ts # Discovery budget policy (production vs benchmark)
│   ├── services/
│   │   ├── business-extractor.service.ts   # Phone/email/social normalization & contact role matrix
│   │   ├── candidate-classifier.service.ts # Fast regex candidate filter & directory blocklist
│   │   ├── candidate-validation.service.ts # Country and geographic candidate validation
│   │   ├── confidence.service.ts           # Multi-dimensional deterministic confidence model
│   │   ├── discovery-state.service.ts      # Canonical DiscoveryState enum & schemas
│   │   ├── entity-resolution.service.ts    # Phone/Domain/Jaccard entity matching cascade
│   │   ├── geocoding.service.ts            # Dynamic OSM Nominatim geocoder & query normalizer
│   │   ├── geographic-evaluator.service.ts # Ward alias & Haversine distance boundary gate
│   │   ├── maps-discovery.service.ts       # Google Maps Places pagination & safeguards
│   │   ├── output-storage.service.ts       # Dual-write output storage & session management
│   │   ├── research-candidate.service.ts   # Candidate pool builder & state preservation
│   │   ├── search-fallback.service.ts      # Serper to DuckDuckGo search fallback
│   │   ├── tavily-extract.service.ts       # Tavily Extract client with disk caching
│   │   ├── verification.service.ts         # Verified business evidence builder
│   │   ├── website-discovery-gate.service.ts  # Universal evaluation gate & audit telemetry
│   │   ├── website-relationship.service.ts # Website relationship & cascade rejection classifier
│   │   └── website-search-ranker.service.ts   # Zero-HTTP token ranker & penalty model
│   └── mastra/
│       ├── index.ts                        # Mastra configuration & registered workflows
│       ├── agents/                         # Supervisor agents & schema definitions
│       ├── Tools/                          # Mastra execution tools (Maps, Search, Extract)
│       └── workflows/
│           └── research-workflow.ts        # Core 4-stage business research workflow
├── .env.example
├── cspell.json
├── package.json
└── tsconfig.json
```

---

## Data Contract: Final Output Schema (`output/latest/businesses.json`)

```json
[
  {
    "name": "Crystal Home Cleaning",
    "location": "Satungal, Kathmandu",
    "emails": ["info@crystalcleaning.com.np"],
    "phones": ["+977-01-4311600"],
    "mobiles": ["+977-985-1201603"],
    "websites": ["https://crystalcleaning.com.np/"],
    "icon": "https://crystalcleaning.com.np/favicon.ico",
    "socialLinks": {
      "facebook": "https://facebook.com/crystalcleaningnp",
      "instagram": "https://instagram.com/crystalcleaningnp",
      "tiktok": "",
      "other": {}
    },
    "gpsCoordinates": {
      "latitude": 27.6931,
      "longitude": 85.2684
    },
    "rating": 4.8,
    "ratingCount": 42,
    "placeId": "17540895154546494724",
    "businessType": "House cleaning service",
    "otherDetails": {
      "websiteRelationship": "first_party",
      "discoveryState": "DISCOVERY_FOUND_FIRST_PARTY",
      "socialsCascadeRejected": 0,
      "contactsCascadeRejected": 0,
      "classifiedContacts": [
        {
          "value": "+977-01-4311600",
          "canonicalDigits": "14311600",
          "type": "phone",
          "phoneType": "landline",
          "role": "primary_business",
          "owner": "business",
          "channels": ["call"],
          "context": "Main Office",
          "pagesSeenOn": ["https://crystalcleaning.com.np/contact"]
        },
        {
          "value": "+977-985-1201603",
          "canonicalDigits": "9851201603",
          "type": "phone",
          "phoneType": "mobile",
          "role": "primary_business",
          "owner": "business",
          "channels": ["call", "whatsapp"],
          "pagesSeenOn": ["https://crystalcleaning.com.np/"]
        }
      ]
    },
    "metadata": {
      "source": "web",
      "extractedAt": "2026-09-18T11:46:19.784Z",
      "runStartedAt": "2026-09-18T11:42:05.485Z",
      "confidence": 0.94,
      "confidenceBreakdown": {
        "mapsIdentityConfidence": 0.95,
        "websiteEvidenceConfidence": 0.92,
        "contactConfidence": 0.9,
        "overallConfidence": 0.94,
        "conflictPenalty": 1.0,
        "evidenceSummary": {
          "mapsVerified": true,
          "websiteVerified": true,
          "phoneVerified": true,
          "emailVerified": true,
          "relationshipType": "first_party"
        }
      }
    }
  }
]
```

---

## Quickstart & Usage

### 1. Environment Configuration

Create a `.env` file in the project root:

```env
# Required Provider API Keys
SERPER_API_KEY=your_serper_dev_api_key
TAVILY_API_KEY=your_tavily_api_key
OPENROUTER_API_KEY=your_openrouter_api_key
GOOGLE_GENERATIVE_AI_API_KEY=your_gemini_api_key

# Optional Configuration
DISCOVERY_MODE=production                       # 'production' (default) or 'benchmark'
```

### 2. Installation & Running

```bash
# Install dependencies
npm install

# Start Mastra Studio UI
npm run dev
```

### 3. Programmatic Invocation

```typescript
import { mastra } from './src/mastra';

const workflow = mastra.getWorkflow('researchWorkflow');
const run = await workflow.createRun();

const response = await run.start({
  inputData: {
    query: 'Plumber',
    location: 'Tokha, Kathmandu',
    targetCandidates: 5,                // Output strictly capped to top 5
    maxMapsPages: 3,
    maxPages: 3,
    maxDeepVerifyCandidates: 10,
    websiteDiscoveryMode: 'benchmark',  // 'benchmark' evaluates all eligible candidates
    autoApprove: true,                  // true = headless; false = human review step
    agentId: 'gemma-supervisor-agent',
  },
});

console.log('Discovered Businesses:', response.results?.listings);
```

---

##  Test Suite & Invariant Verification

The codebase includes **39 zero-API test suites** validating all invariants offline with deterministic fixtures:

```bash
# Run complete test suite (all 39 suites)
npm test

# Run specific Phase 8 suites
npm run test:phase8h                                      # Core Phase 8h defects (W2-01 to W2-06)
npx tsx scripts/test-phase8h-w207.ts                      # Defect W2-07 (Cascade rejection & social independence)
npx tsx scripts/test-phase8h-w208.ts                      # Defect W2-08 (Target cap & query normalization)
npx tsx scripts/test-phase8a-geographic-evaluator.ts      # Geographic boundary & distance tests
npx tsx scripts/test-phase8b-contact-role-aggregation.ts  # Contact role decision matrix tests
```

---

##  License

ISC License. Built for agentic business research and extraction.
