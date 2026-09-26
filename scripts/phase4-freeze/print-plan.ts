/**
 * Phase 4.0 — Ownership planner.
 *
 * Reads the symbol dependency graph and proposes a module assignment per
 * symbol, then REPORTS (never silently fixes) any cross-module edge that would
 * close a cycle given the proposed layering. The layering is:
 *
 *   config/token-vocabulary     (pure data, no service imports)
 *   extraction/extraction-regex  (pure regex/const, no service imports)
 *   extraction/content-norm     (pure content helpers)
 *   extraction/phone
 *   extraction/social
 *   extraction/contact
 *   extraction/branch
 *   extraction/page             (depends on all of the above; nothing depends on it)
 *
 * Run with --edges to dump the full edge list for manual review.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DEPS = path.join(ROOT, 'docs', 'phase0', 'artifacts', 'phase4-symbol-deps.json');

const graph = JSON.parse(fs.readFileSync(DEPS, 'utf8')) as {
  declarations: { name: string; kind: string; isExported: boolean; startLine: number; refs: string[] }[];
  edges: { from: string; to: string[] }[];
};

const ranks = [
  'vocab',      // src/config/token-vocabulary.config.ts          (pure data, no imports)
  'category',   // src/services/extraction/category-token.service.ts (pure vocabulary resolver)
  'regex',      // src/services/extraction/extraction-regex.ts       (pure regex/const)
  'pagetype',   // src/services/extraction/page-type.service.ts     (pure URL/title heuristic)
  'norm',       // src/services/extraction/content-normalization.service.ts
  'contact',    // src/services/extraction/contact-extractor.service.ts
  'social',     // src/services/extraction/social-extractor.service.ts
  'phone',      // src/services/extraction/phone-extractor.service.ts
  'branch',     // src/services/extraction/branch-extractor.service.ts
  'page',       // src/services/extraction/page-extractor.service.ts
] as const;
type Rank = (typeof ranks)[number];

const owner = new Map<string, Rank>();
const assign = (rank: Rank, names: string[]) => names.forEach((n) => owner.set(n, rank));

assign('vocab', [
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
]);

assign('regex', [
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
]);

assign('pagetype', ['PageType', 'classifyPageType']);

assign('category', ['resolveCategoryKey']);

assign('norm', [
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
]);

assign('contact', [
  'sanitizeEmailString',
  'extractEmails',
  'classifyEmailRole',
  'ContactSignalSnapshot',
  'evaluateContactRoleMatrix',
  'deduplicateClassifiedContacts',
]);

assign('social', [
  'computeCanonicalSocialUrl',
  'isRealSocialProfile',
  'classifySocialProfile',
  'isBusinessOwnedSocialProfile',
  'classifyAllSocialProfiles',
  'ExtractedSocialLinks',
  'extractSocialLinks',
  'requiredSocialNameOverlap',
  'brandSegmentFromBusinessName',
]);

assign('phone', [
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
]);

assign('branch', ['cleanBranchAddress', 'StructuredBranchBlock', 'extractStructuredBranchBlocks']);

assign('page', [
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
]);

const unassigned = graph.declarations.filter((d) => !owner.has(d.name)).map((d) => d.name);

const crossEdges: { from: Rank | 'UNASSIGNED'; to: Rank | 'UNASSIGNED'; name: string }[] = [];
let selfEdges = 0;

for (const e of graph.edges) {
  if (e.to.includes(e.from)) selfEdges += 1;
  for (const t of e.to) {
    if (t === e.from) continue;
    const a = owner.get(e.from) ?? 'UNASSIGNED';
    const b = owner.get(t) ?? 'UNASSIGNED';
    if (a !== b) crossEdges.push({ from: a, to: b, name: `${e.from} -> ${t}` });
  }
}

process.stdout.write('=== COVERAGE ===\n');
process.stdout.write(`assigned    : ${owner.size}\n`);
process.stdout.write(`unassigned  : ${unassigned.length}\n`);
for (const n of unassigned) process.stdout.write(`   UNASSIGNED  ${n}\n`);

// An edge `from -> to` means `from` IMPORTS `to`. Under this layering a module
// may only import strictly LOWER-ranked modules, so a violation (and therefore a
// potential cycle) is when rank(to) > rank(from).
process.stdout.write('\n=== VIOLATIONS (import a higher-ranked module => cycle) ===\n');
const backward = crossEdges.filter((e) => ranks.indexOf(e.to as Rank) > ranks.indexOf(e.from as Rank));
if (backward.length === 0) process.stdout.write('none\n');
for (const e of backward) process.stdout.write(`   ${e.name}   [${e.from} -> ${e.to}]\n`);

process.stdout.write('\n=== LEGAL DOWNWARD CROSS-MODULE EDGES ===\n');
const forward = crossEdges.filter((e) => !backward.includes(e));
process.stdout.write(`${forward.length} total\n`);
for (const e of forward) process.stdout.write(`   ${e.name}   [${e.from} -> ${e.to}]\n`);

process.stdout.write(`\nself-referential edges: ${selfEdges}\n`);

