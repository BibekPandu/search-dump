# Generated Dependency & Export Inventory (Phase 0.2)

Generated: 2026-09-26T13:16:25.907Z

## Totals

| Metric | Count |
| --- | --- |
| filesScanned | 97 |
| importEdges | 418 |
| internalEdges | 296 |
| externalSpecifiers | 26 |
| crossServiceSiblingImports | 47 |
| servicesToMastraImports | 12 |
| mastraToServicesImports | 36 |
| dynamicImportSites | 3 |
| unresolvedRelativeSpecifiers | 0 |

## Cross-service sibling imports (`src/services/*` -> `src/services/*`)

- `src/services/business-extractor.service.ts` -> `src/services/search-fallback.service.ts`
- `src/services/business-extractor.service.ts` -> `src/services/telemetry.service.ts`
- `src/services/cache.service.ts` -> `src/services/db.service.ts`
- `src/services/candidate-classifier.service.ts` -> `src/services/search-fallback.service.ts`
- `src/services/candidate-validation.service.ts` -> `src/services/geographic-evaluator.service.ts`
- `src/services/candidate-validation.service.ts` -> `src/services/telemetry.service.ts`
- `src/services/entity-resolution.service.ts` -> `src/services/business-extractor.service.ts`
- `src/services/entity-resolution.service.ts` -> `src/services/candidate-classifier.service.ts`
- `src/services/entity-resolution.service.ts` -> `src/services/geographic-evaluator.service.ts`
- `src/services/entity-resolution.service.ts` -> `src/services/search-fallback.service.ts`
- `src/services/entity-resolution.service.ts` -> `src/services/serper-places.service.ts`
- `src/services/entity-resolution.service.ts` -> `src/services/url-filter.service.ts`
- `src/services/geocoding.service.ts` -> `src/services/geographic-evaluator.service.ts`
- `src/services/geographic-evaluator.service.ts` -> `src/services/geocoding.service.ts`
- `src/services/geographic-evaluator.service.ts` -> `src/services/telemetry.service.ts`
- `src/services/maps-discovery.service.ts` -> `src/services/research-candidate.service.ts`
- `src/services/maps-discovery.service.ts` -> `src/services/serper-places.service.ts`
- `src/services/mongo.service.ts` -> `src/services/entity-resolution.service.ts`
- `src/services/mongo.service.ts` -> `src/services/geocoding.service.ts`
- `src/services/output-storage.service.ts` -> `src/services/db.service.ts`
- `src/services/research-candidate.service.ts` -> `src/services/entity-resolution.service.ts`
- `src/services/research-candidate.service.ts` -> `src/services/search-fallback.service.ts`
- `src/services/research-candidate.service.ts` -> `src/services/serper-places.service.ts`
- `src/services/search-fallback.service.ts` -> `src/services/cache.service.ts`
- `src/services/search-fallback.service.ts` -> `src/services/discovery-state.service.ts`
- `src/services/search-fallback.service.ts` -> `src/services/serper-search.service.ts`
- `src/services/serper-places.service.ts` -> `src/services/cache.service.ts`
- `src/services/serper-places.service.ts` -> `src/services/discovery-state.service.ts`
- `src/services/tavily-extract.service.ts` -> `src/services/cache.service.ts`
- `src/services/verification.service.ts` -> `src/services/business-extractor.service.ts`
- `src/services/verification.service.ts` -> `src/services/entity-resolution.service.ts`
- `src/services/verification.service.ts` -> `src/services/website-relationship.service.ts`
- `src/services/website-discovery-gate.service.ts` -> `src/services/business-extractor.service.ts`
- `src/services/website-discovery-gate.service.ts` -> `src/services/discovery-state.service.ts`
- `src/services/website-discovery-gate.service.ts` -> `src/services/discovery-state.service.ts`
- `src/services/website-discovery-gate.service.ts` -> `src/services/entity-resolution.service.ts`
- `src/services/website-discovery-gate.service.ts` -> `src/services/serper-places.service.ts`
- `src/services/website-discovery-gate.service.ts` -> `src/services/website-search-ranker.service.ts`
- `src/services/website-discovery.service.ts` -> `src/services/entity-resolution.service.ts`
- `src/services/website-discovery.service.ts` -> `src/services/search-fallback.service.ts`
- `src/services/website-relationship.service.ts` -> `src/services/entity-resolution.service.ts`
- `src/services/website-search-ranker.service.ts` -> `src/services/business-extractor.service.ts`
- `src/services/website-search-ranker.service.ts` -> `src/services/candidate-classifier.service.ts`
- `src/services/website-search-ranker.service.ts` -> `src/services/entity-resolution.service.ts`
- `src/services/website-search-ranker.service.ts` -> `src/services/telemetry.service.ts`
- `src/services/website-search-ranker.service.ts` -> `src/services/url-filter.service.ts`
- `src/services/website-search-ranker.service.ts` -> `src/services/website-relationship.service.ts`

## Service -> Mastra boundary crossings

- `src/services/business-extractor.service.ts` -> `src/mastra/agents/research-agent/contact.schema.ts`
- `src/services/business-extractor.service.ts` -> `src/mastra/agents/research-agent/social.schema.ts`
- `src/services/business-extractor.service.ts` -> `src/mastra/agents/research-agent/verification.schema.ts`
- `src/services/candidate-classifier.service.ts` -> `src/mastra/agents/research-agent/schema.ts`
- `src/services/candidate-validation.service.ts` -> `src/mastra/agents/research-agent/schema.ts`
- `src/services/entity-resolution.service.ts` -> `src/mastra/agents/research-agent/contact.schema.ts`
- `src/services/maps-discovery.service.ts` -> `src/mastra/agents/research-agent/schema.ts`
- `src/services/mongo.service.ts` -> `src/mastra/workflows/research-workflow.ts`
- `src/services/research-candidate.service.ts` -> `src/mastra/agents/research-agent/schema.ts`
- `src/services/verification.service.ts` -> `src/mastra/agents/research-agent/schema.ts`
- `src/services/verification.service.ts` -> `src/mastra/agents/research-agent/verification.schema.ts`
- `src/services/website-relationship.service.ts` -> `src/mastra/agents/research-agent/verification.schema.ts`

## Mastra -> service imports

- `src/mastra/Tools/broad-search.ts` -> `src/services/output-storage.service.ts`
- `src/mastra/Tools/broad-search.ts` -> `src/services/search-fallback.service.ts`
- `src/mastra/Tools/deep-extract.ts` -> `src/services/output-storage.service.ts`
- `src/mastra/Tools/deep-extract.ts` -> `src/services/tavily-extract.service.ts`
- `src/mastra/Tools/google-maps-search.ts` -> `src/services/serper-places.service.ts`
- `src/mastra/agents/gemma-supervisor/config.ts` -> `src/services/db.service.ts`
- `src/mastra/agents/gemma-supervisor/config.ts` -> `src/services/openrouter.service.ts`
- `src/mastra/agents/research-agent/schema.ts` -> `src/services/discovery-state.service.ts`
- `src/mastra/agents/research-agent/schema.ts` -> `src/services/search-fallback.service.ts`
- `src/mastra/agents/search-worker/config.ts` -> `src/services/db.service.ts`
- `src/mastra/agents/uno-supervisor/config.ts` -> `src/services/db.service.ts`
- `src/mastra/agents/uno-supervisor/config.ts` -> `src/services/unorouter.service.ts`
- `src/mastra/index.ts` -> `src/services/db.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/business-extractor.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/business-extractor.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/candidate-classifier.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/candidate-validation.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/confidence.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/entity-resolution.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/entity-resolution.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/entity-resolution.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/geocoding.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/geographic-evaluator.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/maps-discovery.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/mongo.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/output-storage.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/research-candidate.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/search-fallback.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/serper-places.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/tavily-extract.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/telemetry.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/url-filter.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/verification.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/website-discovery-gate.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/website-discovery.service.ts`
- `src/mastra/workflows/research-workflow.ts` -> `src/services/website-search-ranker.service.ts`

## Dynamic `import()` call sites

- `src/mastra/workflows/research-workflow.ts` -> `../index` (resolved: src/mastra/index.ts)
- `src/services/entity-resolution.service.ts` -> `../config/geo-localities.config.js` (resolved: src/config/geo-localities.config.ts)
- `src/services/geographic-evaluator.service.ts` -> `./geocoding.service.js` (resolved: src/services/geocoding.service.ts)

## Unresolved relative specifiers

- none

## Export inventory — `src/services/business-extractor.service.ts`

| Kind | Count |
| --- | --- |
| const | 24 |
| function | 37 |
| interface | 7 |
| type | 1 |

| Line | Kind | Name |
| --- | --- | --- |
| 72 | const | `MEDIA_FILENAME_PATTERN` |
| 73 | const | `MEDIA_DPR_PATTERN` |
| 74 | const | `IMAGE_FILE_TLDS` |
| 81 | const | `LANDLINE_OR_MOBILE_REGEX` |
| 83 | const | `MOBILE_REGEX` |
| 84 | const | `NEPAL_LANDLINE_REGEX` |
| 85 | const | `INTERNATIONAL_REGEX` |
| 98 | const | `LINKEDIN_COMPANY_REGEX` |
| 99 | const | `LINKEDIN_PERSONAL_REGEX` |
| 100 | const | `LINKEDIN_REGEX` |
| 102 | function | `cleanTrailingPunctuation` |
| 112 | function | `sanitizeEmailString` |
| 126 | function | `sanitizePhoneString` |
| 134 | interface | `ClassifiedPhone` |
| 146 | interface | `PhoneEvidence` |
| 192 | function | `formatPhoneDisplay` |
| 235 | function | `classifyNepalPhone` |
| 439 | const | `INDUSTRY_GENERIC_TOKENS` |
| 471 | const | `UNIVERSAL_STOPWORDS` |
| 482 | const | `NEPAL_LOCALITY_TOKENS` |
| 495 | const | `CATEGORY_GENERIC_TOKENS` |
| 554 | const | `CONFLICTING_VERTICAL_TOKENS` |
| 591 | function | `resolveCategoryKey` |
| 655 | const | `SCHEDULE_GARBAGE_PATTERNS` |
| 684 | const | `FACEBOOK_NON_CANONICAL_SUBPATHS` |
| 702 | function | `computeCanonicalSocialUrl` |
| 774 | const | `PLATFORM_OFFICIAL_HANDLES` |
| 787 | const | `KNOWN_VENDOR_SOCIAL_HANDLES` |
| 797 | function | `isRealSocialProfile` |
| 867 | function | `classifySocialProfile` |
| 1586 | function | `isBusinessOwnedSocialProfile` |
| 1604 | function | `classifyAllSocialProfiles` |
| 1649 | function | `stripVendorAttribution` |
| 1772 | function | `extractEmails` |
| 1822 | const | `PLATFORM_DOMAINS` |
| 1828 | const | `BUSINESS_EMAIL_PREFIXES` |
| 1838 | const | `CONSUMER_EMAIL_DOMAINS` |
| 1847 | function | `extractContextAroundMatch` |
| 1874 | function | `classifyEmailRole` |
| 1994 | type | `PageType` |
| 1999 | function | `classifyPageType` |
| 2037 | const | `OWNER_LEADERSHIP_TITLES` |
| 2055 | const | `STAFF_TITLES` |
| 2095 | interface | `ContactSignalSnapshot` |
| 2109 | function | `evaluateContactRoleMatrix` |
| 2161 | interface | `PhoneRoleClassificationResult` |
| 2180 | function | `classifyPhoneRole` |
| 2319 | function | `detectTemplateContent` |
| 2417 | function | `expandSlashExtensions` |
| 2475 | function | `extractPhones` |
| 2533 | function | `extractMobiles` |
| 2555 | function | `extractLandlines` |
| 2599 | function | `extractLandlinesAndIntl` |
| 2703 | interface | `ExtractedSocialLinks` |
| 2715 | function | `extractSocialLinks` |
| 2771 | function | `extractFaviconFromHtml` |
| 2789 | function | `extractFavicon` |
| 2802 | function | `extractBusinessInfo` |
| 2852 | interface | `ExtractedPageBusinessName` |
| 2861 | function | `extractPageBusinessName` |
| 2951 | function | `getLlmMultiBusinessCallCount` |
| 2955 | function | `resetLlmMultiBusinessCallCount` |
| 2987 | function | `detectMultiBusinessPage` |
| 3076 | function | `detectMultiBusinessPageWithLlmFallback` |
| 3131 | function | `cleanBranchAddress` |
| 3185 | interface | `StructuredBranchBlock` |
| 3217 | function | `extractStructuredBranchBlocks` |
| 3323 | function | `extractAllFromPages` |
| 3534 | function | `deduplicateClassifiedContacts` |
