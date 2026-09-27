/**
 * Phase 4 — Single source of truth for extraction-module ownership.
 *
 * Every symbol declared in `src/services/business-extractor.service.ts` is
 * assigned to exactly one module. The rank list is a strict DAG: a module may
 * only import symbols owned by modules that appear EARLIER (lower rank) in
 * `RANKS`. `scripts/phase4-freeze/print-plan.ts` proves the assignment is
 * acyclic; `scripts/phase4-slicing/slice.ts` materialises it.
 *
 * Rule: one symbol, one owner, one canonical implementation. The facade at
 * `src/services/business-extractor.service.ts` contains re-exports only.
 */

/** Strict dependency order. A module may import only from lower ranks. */
export const RANKS = [
  'vocab', // src/config/token-vocabulary.config.ts          (pure data, no imports)
  'category', // src/services/extraction/category-token.service.ts (pure vocabulary resolver)
  'regex', // src/services/extraction/extraction-regex.ts       (pure regex/const)
  'pagetype', // src/services/extraction/page-type.service.ts     (pure URL/title heuristic)
  'norm', // src/services/extraction/content-normalization.service.ts
  'contact', // src/services/extraction/contact-extractor.service.ts
  'social', // src/services/extraction/social-extractor.service.ts
  'phone', // src/services/extraction/phone-extractor.service.ts
  'branch', // src/services/extraction/branch-extractor.service.ts
  'page', // src/services/extraction/page-extractor.service.ts
] as const;

export type Rank = (typeof RANKS)[number];

/**
 * Every symbol declared in `business-extractor.service.ts` mapped to its single
 * owning module. Asserted complete (98/98) by `scripts/phase4-freeze/print-plan.ts`.
 */
export const ASSIGNMENT: Readonly<Record<Rank, readonly string[]>> = {
  vocab: [
    'INDUSTRY_GENERIC_TOKENS',
    'UNIVERSAL_STOPWORDS',
    'NEPAL_LOCALITY_TOKENS',
    'CATEGORY_GENERIC_TOKENS',
    'CONFLICTING_VERTICAL_TOKENS',
    'PLATFORM_DOMAINS',
    'BUSINESS_EMAIL_PREFIXES',
    'CONSUMER_EMAIL_DOMAINS',
    'OWNER_LEADERSHIP_TITLES',
    'STAFF_TITLES',
    'PLATFORM_OFFICIAL_HANDLES',
    'KNOWN_VENDOR_SOCIAL_HANDLES',
    'FACEBOOK_NON_CANONICAL_SUBPATHS',
    'EXCLUDED_LEGAL_AND_GOV_ENTITIES',
    'FACEBOOK_RESERVED_PATHS',
    'TWITTER_RESERVED_PATHS',
    'INSTAGRAM_RESERVED_PATHS',
    'NEPAL_BRANCH_LOCALITIES',
    'QUESTION_STARTER_WORDS',
  ],
  regex: [
    'MEDIA_FILENAME_PATTERN',
    'MEDIA_DPR_PATTERN',
    'IMAGE_FILE_TLDS',
    'LANDLINE_OR_MOBILE_REGEX',
    'MOBILE_REGEX',
    'NEPAL_LANDLINE_REGEX',
    'INTERNATIONAL_REGEX',
    'LINKEDIN_COMPANY_REGEX',
    'LINKEDIN_PERSONAL_REGEX',
    'LINKEDIN_REGEX',
    'SCHEDULE_GARBAGE_PATTERNS',
    'EMAIL_REGEX',
    'PLACEHOLDER_EMAIL_PATTERNS',
    'TEL_PROTECT_REGEX',
    'FACEBOOK_REGEX',
    'INSTAGRAM_REGEX',
    'TIKTOK_REGEX',
    'X_TWITTER_REGEX',
    'YOUTUBE_REGEX',
    'BARE_HANDLE_REGEX',
  ],
  pagetype: ['PageType', 'classifyPageType'],
  category: ['resolveCategoryKey'],
  norm: [
    'cleanTrailingPunctuation',
    'stripVendorAttribution',
    'stripHtmlTags',
    'decodeCloudflareEmail',
    'decodeObfuscatedEmails',
    'extractMailtoEmails',
    'stripNoiseContexts',
    'extractUrlsFromMarkdown',
    'liftBareHandles',
    'extractUrlsFromHtml',
    'extractStructuredSocialUrls',
    'isGenericName',
    'domainFromUrlOrHost',
    'extractContextAroundMatch',
  ],
  contact: [
    'sanitizeEmailString',
    'extractEmails',
    'classifyEmailRole',
    'ContactSignalSnapshot',
    'evaluateContactRoleMatrix',
    'deduplicateClassifiedContacts',
  ],
  social: [
    'computeCanonicalSocialUrl',
    'isRealSocialProfile',
    'classifySocialProfile',
    'isBusinessOwnedSocialProfile',
    'classifyAllSocialProfiles',
    'ExtractedSocialLinks',
    'extractSocialLinks',
    'requiredSocialNameOverlap',
    'brandSegmentFromBusinessName',
  ],
  phone: [
    'sanitizePhoneString',
    'ClassifiedPhone',
    'PhoneEvidence',
    'formatPhoneDisplay',
    'classifyNepalPhone',
    'expandSlashExtensions',
    'extractPhones',
    'extractMobiles',
    'extractLandlines',
    'extractLandlinesAndIntl',
    'PhoneRoleClassificationResult',
    'classifyPhoneRole',
  ],
  branch: ['cleanBranchAddress', 'StructuredBranchBlock', 'extractStructuredBranchBlocks'],
  page: [
    'detectTemplateContent',
    'extractFaviconFromHtml',
    'extractFavicon',
    'extractBusinessInfo',
    'ExtractedPageBusinessName',
    'extractPageBusinessName',
    'getLlmMultiBusinessCallCount',
    'resetLlmMultiBusinessCallCount',
    'detectMultiBusinessPage',
    'detectMultiBusinessPageWithLlmFallback',
    'extractAllFromPages',
    'llmMultiBusinessCallCount',
  ],
};

/** Flattened name -> owner lookup. */
export const OWNER_OF: ReadonlyMap<string, Rank> = (() => {
  const m = new Map<string, Rank>();
  for (const rank of RANKS) for (const name of ASSIGNMENT[rank]) m.set(name, rank);
  return m;
})();

export interface ModuleSpec {
  /** Output path, repo-relative. */
  readonly file: string;
  /** Import specifier other modules use to reach it. */
  readonly specifier: string;
  /** One-line summary used in the generated file header. */
  readonly summary: string;
}

export const MODULES: Readonly<Record<Rank, ModuleSpec>> = {
  vocab: {
    file: 'src/config/token-vocabulary.config.ts',
    specifier: '@/config/token-vocabulary.config',
    summary: 'Pure token sets and lookup tables. No service imports.',
  },
  category: {
    file: 'src/services/extraction/category-token.service.ts',
    specifier: '@/services/extraction/category-token.service',
    summary: 'Pure category-key resolver over the shared vocabulary.',
  },
  regex: {
    file: 'src/services/extraction/extraction-regex.ts',
    specifier: '@/services/extraction/extraction-regex',
    summary: 'Shared regular expressions and pattern tables. No service imports.',
  },
  pagetype: {
    file: 'src/services/extraction/page-type.service.ts',
    specifier: '@/services/extraction/page-type.service',
    summary: 'Pure URL/title page-type heuristic. No service imports.',
  },
  norm: {
    file: 'src/services/extraction/content-normalization.service.ts',
    specifier: '@/services/extraction/content-normalization.service',
    summary: 'Content cleanup helpers: vendor stripping, HTML/markdown unwrapping, URL harvesting.',
  },
  contact: {
    file: 'src/services/extraction/contact-extractor.service.ts',
    specifier: '@/services/extraction/contact-extractor.service',
    summary: 'Email extraction and contact-role evaluation.',
  },
  social: {
    file: 'src/services/extraction/social-extractor.service.ts',
    specifier: '@/services/extraction/social-extractor.service',
    summary: 'Social URL canonicalisation, profile classification and ownership.',
  },
  phone: {
    file: 'src/services/extraction/phone-extractor.service.ts',
    specifier: '@/services/extraction/phone-extractor.service',
    summary: 'Nepal phone classification, mobile/landline extraction and formatting.',
  },
  branch: {
    file: 'src/services/extraction/branch-extractor.service.ts',
    specifier: '@/services/extraction/branch-extractor.service',
    summary: 'Structured branch-block extraction and address cleanup.',
  },
  page: {
    file: 'src/services/extraction/page-extractor.service.ts',
    specifier: '@/services/extraction/page-extractor.service',
    summary: 'Favicon, page business name, multi-business detection and page aggregation.',
  },
};
