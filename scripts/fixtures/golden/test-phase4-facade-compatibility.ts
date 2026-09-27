/**
 * Phase 4 Gate G4 Verification: Facade Name and Kind Compatibility Test.
 *
 * Verifies that src/services/business-extractor.service.ts exports all 69
 * canonical symbols catalogued in Phase 0 CONTRACTS.md with exact name and
 * typeof kind matching.
 */
import * as assert from 'node:assert/strict';
import * as Facade from '@/services/business-extractor.service';

const EXPECTED_FUNCTIONS = [
  'classifyNepalPhone',
  'classifySocialProfile',
  'computeCanonicalSocialUrl',
  'isRealSocialProfile',
  'isBusinessOwnedSocialProfile',
  'classifyAllSocialProfiles',
  'resolveCategoryKey',
  'sanitizePhoneString',
  'formatPhoneDisplay',
  'cleanTrailingPunctuation',
  'sanitizeEmailString',
  'extractEmails',
  'extractPhones',
  'extractMobiles',
  'extractLandlines',
  'extractLandlinesAndIntl',
  'extractSocialLinks',
  'extractFaviconFromHtml',
  'extractFavicon',
  'extractBusinessInfo',
  'extractPageBusinessName',
  'extractAllFromPages',
  'extractStructuredBranchBlocks',
  'deduplicateClassifiedContacts',
  'classifyPhoneRole',
  'classifyEmailRole',
  'evaluateContactRoleMatrix',
  'classifyPageType',
  'detectTemplateContent',
  'detectMultiBusinessPage',
  'detectMultiBusinessPageWithLlmFallback',
  'cleanBranchAddress',
  'expandSlashExtensions',
  'extractContextAroundMatch',
  'stripVendorAttribution',
  'getLlmMultiBusinessCallCount',
  'resetLlmMultiBusinessCallCount',
] as const;

const EXPECTED_CONSTANTS = [
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
  'INDUSTRY_GENERIC_TOKENS',
  'UNIVERSAL_STOPWORDS',
  'NEPAL_LOCALITY_TOKENS',
  'CATEGORY_GENERIC_TOKENS',
  'CONFLICTING_VERTICAL_TOKENS',
  'SCHEDULE_GARBAGE_PATTERNS',
  'FACEBOOK_NON_CANONICAL_SUBPATHS',
  'PLATFORM_OFFICIAL_HANDLES',
  'KNOWN_VENDOR_SOCIAL_HANDLES',
  'PLATFORM_DOMAINS',
  'BUSINESS_EMAIL_PREFIXES',
  'CONSUMER_EMAIL_DOMAINS',
  'OWNER_LEADERSHIP_TITLES',
  'STAFF_TITLES',
] as const;

console.log('=== Phase 4 Facade Compatibility Verification ===\n');

let functionPassed = 0;
for (const name of EXPECTED_FUNCTIONS) {
  assert.ok(name in Facade, `Missing exported function: ${name}`);
  const val = (Facade as any)[name];
  assert.equal(typeof val, 'function', `Export ${name} expected typeof 'function' but got '${typeof val}'`);
  functionPassed++;
}
console.log(`PASS: All ${functionPassed}/${EXPECTED_FUNCTIONS.length} functions present with typeof === 'function'`);

let constPassed = 0;
for (const name of EXPECTED_CONSTANTS) {
  assert.ok(name in Facade, `Missing exported constant: ${name}`);
  const val = (Facade as any)[name];
  assert.ok(val !== undefined, `Exported constant ${name} is undefined`);
  constPassed++;
}
console.log(`PASS: All ${constPassed}/${EXPECTED_CONSTANTS.length} runtime constants present`);

console.log(`\nAll ${functionPassed + constPassed} runtime exports validated successfully on facade.`);
