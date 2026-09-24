import { extractDomain } from './search-fallback.service';
import type { WebsitePageEvidence, WebsiteEvidence, PhoneEvidenceRecord } from '../mastra/agents/research-agent/verification.schema';
import { NTA_MOBILE_PREFIXES, NTA_LANDLINE_AREA_CODES } from '../config/nepal-telecom.config';
import {
  type ContactRole,
  type ContactOwner,
  type ContactChannel,
  type ClassifiedContact,
} from '../mastra/agents/research-agent/contact.schema';
import type { ClassifiedSocialProfile } from '../mastra/agents/research-agent/social.schema';
import { incrementTelemetry } from './telemetry.service';

function domainFromUrlOrHost(value: string): string {
  if (!value) return '';
  const trimmed = value.trim();
  const fromUrl = extractDomain(trimmed);
  if (fromUrl) return fromUrl;

  return trimmed
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split(':')[0];
}

// ============================================================================
// Business Extractor — deterministic (0-token) structured fact extraction
// ============================================================================
// ALL functions here are pure and deterministic. No LLM usage, ever. Structured
// facts (emails, phones, mobiles, socials, favicon, services, hours) are
// extracted via regex/rules and used as EVIDENCE-BACKED authority downstream.

const EMAIL_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?\b(?!\.[a-zA-Z])/g;

// Placeholder / throwaway addresses that must never be treated as real evidence.
const PLACEHOLDER_EMAIL_PATTERNS = [
  /^example\./i,
  /@example\.(com|org|net|co|np)$/i,
  /@(?:mail|email|test|domain|yoursite)\.(?:com|org|net|co)$/i,
  /@(?:ourschool|myschool|yourschool|demomail|demotheme|template|dummy)\.(?:edu|com|org|net)$/i,
  /@(?:yourdomain|mycompany|sitename|companyname|themename)\.(?:com|org|net)$/i,
  /@mail\.com$/i,
  /@email\.com$/i,
  /@test\.(com|org|net)$/i,
  /sentry\.io$/i,
  /wixpress\.com$/i,
  /\.wix\.com$/i,
  /@domain\.(com|net|org)$/i,
  /^test@/i,
  /^user@/i,
  /^email@/i,
  /^name@/i,
  /^your(@|[-.])/i,
  /^youremail/i,
  /^contact@example/i,
  /^noreply@/i,
  /^no-reply@/i,
  /^admin@theme\./i,
  /^(?:apollo\.creed|john\.doe|jane\.doe|dummy|demo)@/i,
  /@yopmail\./i,
  /@mailinator\./i,
  // Cloudflare-protected relay / masked-email representations.
  /@privacy\.cloudflare\.com$/i,
  /@email\.cloudflare\.com$/i,
  // Literal "[email protected]" text that HTML renderers emit for masked emails.
  /\[email\s*protected\]/i,
  /^email(?:\s*protected)?@/i,
];

// Media filenames and display-pixel-ratio (DPR) assets misidentified as emails (Task 5)
export const MEDIA_FILENAME_PATTERN = /\.(png|jpe?g|gif|svg|webp|bmp|ico|tiff?|avif)$/i;
export const MEDIA_DPR_PATTERN = /@\d+(?:\.\d+)?x\.(?:png|jpe?g|gif|svg|webp)$/i;
export const IMAGE_FILE_TLDS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'avif'
]);

// Phone patterns (Nepal-aware, proven in buildFallbackListing + Phase 1):
// landline: +977-1-4240520 / 014240520 / 01-4240520
// mobile:   +977 98XXXXXXXX / 98XXXXXXXX (9[78] prefix)
export const LANDLINE_OR_MOBILE_REGEX =
  /(?<!\d)(?:(?:\+977[-.\s]?)?(?:01[-.\s]?\d{6,8}|9[78]\d[-.\s]?\d{7})|(?:\+977[-.\s]?1[-.\s]?\d{6,8}))(?!\d)/g;
export const MOBILE_REGEX = /(?<!\d)(?:\+977[-.\s]?)?9[78]\d[-.\s]?\d{7}(?!\d)/g;
export const NEPAL_LANDLINE_REGEX = /(?<!\d)(?:\+977[-.\s]?)?0?(?:1[-.\s]?\d{6,7}|[2-9]\d[-.\s]?\d{6})(?!\d)/g;
export const INTERNATIONAL_REGEX = /\+[\d\s()-]{7,15}/g;

// Phone numbers hidden in hrefs that must survive URL/noise stripping:
//   tel:+977-1-4522833 / callto:+977... (HTML attributes & markdown links)
//   wa.me/977… · api.whatsapp.com/send?phone=… (https URLs)
const TEL_PROTECT_REGEX =
  /(?:href=["'](?:tel|callto):|wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\+?[\d\s().-]{7,25})|(?:tel|callto):(\+?[\d\s().-]{7,25})/gi;

const FACEBOOK_REGEX = /https?:\/\/(?:www\.)?(?:m\.)?facebook\.com\/(?:profile\.php\?id=\d+|[a-zA-Z0-9._-]+)/i;
const INSTAGRAM_REGEX = /https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9._-]+/i;
const TIKTOK_REGEX = /https?:\/\/(?:www\.)?tiktok\.com\/@[a-zA-Z0-9._-]+/i;
const X_TWITTER_REGEX = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[a-zA-Z0-9_]+/i;
const YOUTUBE_REGEX = /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:channel\/|c\/|user\/|@)?|youtu\.be\/)[a-zA-Z0-9._-]+/i;
export const LINKEDIN_COMPANY_REGEX = /https?:\/\/(?:www\.)?linkedin\.com\/company\/[\w-]+/i;
export const LINKEDIN_PERSONAL_REGEX = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w-]+/i;
export const LINKEDIN_REGEX = /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[\w-]+/i;

export function cleanTrailingPunctuation(value: string): string {
  if (!value) return '';
  return value.replace(/[\s.)\]}'"`\\*;,!]+$/, '').trim();
}

/**
 * Universal Email Sanitizer:
 * Strips leading/trailing whitespace, markdown punctuation (*, ), ], etc.),
 * quotes, backslashes, colons, and semicolons BEFORE deduplication.
 */
export function sanitizeEmailString(raw: string): string {
  if (!raw) return '';
  return raw
    .trim()
    .replace(/^[\s<(\['"`\\*]+/, '')
    .replace(/[\s>)\]'"`\\*.,;:!]+$/, '')
    .toLowerCase();
}

/**
 * Universal Phone Token Boundary Cleaner:
 * Strips leading non-digits (preserving leading '+') and trailing non-digits
 * (stripping unmatched '(', ')', quotes, markdown delimiters, punctuation).
 */
export function sanitizePhoneString(raw: string): string {
  if (!raw) return '';
  return raw
    .trim()
    .replace(/^[^+\d]+/, '')
    .replace(/[^\d]+$/, '');
}

export interface ClassifiedPhone {
  type: 'mobile' | 'landline' | 'international' | 'invalid';
  digits: string;
  normalized: string;
  /** Why the number was rejected — set only when type === 'invalid'. */
  reason?: string;
}

/**
 * A single phone number as it was found, classified, and formatted.
 * Invalid candidates carry a reason but are NEVER placed into phones/mobiles arrays.
 */
export interface PhoneEvidence {
  /** The verbatim string extracted from the source (before any normalization). */
  raw: string;
  /** Digits-only canonical identity — used for dedup and matching. */
  canonicalDigits: string;
  /** User-facing display string. Nepal numbers are deterministically formatted.
   *  International numbers preserve the original source grouping. */
  display: string;
  type: 'mobile' | 'landline' | 'international' | 'invalid';
  /** How the candidate was found: Tavily markdown, raw HTML, or tel/href attribute. */
  source: 'markdown' | 'rawHtml' | 'href';
  /** The page URL where this candidate was found. */
  pageUrl: string;
  /** Populated only when type === 'invalid'. Describes why the candidate was rejected. */
  reason?: string;
}

/**
 * Classifies phone candidates with EXPLICIT complete-structure matching.
 *
 * Accepted structures:
 *   Nepal Mobile     — exactly 10 digits starting with 97 or 98 (not 977), with or without +977 prefix
 *   Kathmandu Landline — exactly 8 digits starting with 1 (after stripping +977/01 trunk)
 *   International    — explicit '+' prefix, 8–15 digits, balanced parentheses
 *
 * Explicit rejection (never silently passes):
 *   INCOMPLETE_MOBILE    — starts with 98/97 pattern after 977, but digit count ≠ 10
 *   INCOMPLETE_LANDLINE  — starts with 01 or 1 after 977, but digit count ≠ 8 (normalized)
 *   INVALID_STRUCTURE    — does not match any recognised complete format
 */
/**
 * Formats a phone number for display.
 *
 * - Nepal mobile (`canonicalDigits` = 10-digit 97x/98x after stripping +977):
 *   → `+977-9XX-XXXXXXX` (e.g. `9808222425` → `+977-980-8222425`)
 * - Nepal landline (`canonicalDigits` = 8-digit `1XXXXXXX`):
 *   → `+977-01-XXXXXXX` (e.g. `15363501` → `+977-01-5363501`)
 * - International: preserves the original source string (`raw`) when available,
 *   otherwise prepends `+` to canonical digits. This avoids inventing grouping
 *   that was not in the source.
 * - Invalid: returns `raw` unchanged.
 *
 * @param canonicalDigits - The digits-only canonical identity produced by classifyNepalPhone.
 * @param type            - The classification type.
 * @param raw             - Optional: the original verbatim string (used for international display).
 */
export function formatPhoneDisplay(
  canonicalDigits: string,
  type: ClassifiedPhone['type'],
  raw?: string
): string {
  if (type === 'mobile' && canonicalDigits.length === 10) {
    // +977-9XX-XXXXXXX  (split at position 3 within the 10-digit mobile number)
    return `+977-${canonicalDigits.slice(0, 3)}-${canonicalDigits.slice(3)}`;
  }
  if (type === 'landline' && canonicalDigits.length === 8 && canonicalDigits.startsWith('1')) {
    // +977-01-XXXXXXX  (strip leading 1, replace with 01)
    return `+977-01-${canonicalDigits.slice(1)}`;
  }
  if (type === 'international') {
    // Preserve source grouping when available (avoids invented format)
    if (raw) {
      const sanitized = sanitizePhoneString(raw);
      return sanitized.startsWith('+') ? sanitized : `+${sanitized.replace(/^\D+/, '')}`;
    }
    return `+${canonicalDigits}`;
  }
  // invalid or unknown: return raw or canonical
  return raw ?? canonicalDigits;
}

/**
 * Classifies a phone number string into:
 *   - mobile: Nepal 10-digit mobile (prefix 97/98, after stripping +977 if present).
 *             Canonical identity: 10 digits without +977 (e.g. "9808222425").
 *   - landline: Kathmandu landline (prefix 01 or +977-1 or bare 1 + 7 digits).
 *             Canonical identity: 8 digits starting with 1 (e.g. "15363501").
 *   - international: Non-Nepal number with explicit country code prefix.
 *             Canonical identity: all digits with leading + (e.g. "+13013221427").
 *   - invalid: Fragment, too short, unbalanced parens, or unrecognizable structure.
 *
 * Invariant guarantees:
 *   - Mobile canonical digits are always exactly 10 digits.
 *   - Landline canonical digits are always exactly 8 digits starting with 1.
 *   - Canonical digits never overlap between valid mobiles and valid landlines.
 *
 * NOTE: classifyNepalPhone also handles international formats — rename to
 * classifyPhone() in a future cleanup pass.
 */
export function classifyNepalPhone(raw: string): ClassifiedPhone {
  const cleaned = sanitizePhoneString(raw);
  if (!cleaned) return { type: 'invalid', digits: '', normalized: '', reason: 'EMPTY' };

  let digits = cleaned.replace(/\D/g, '');
  if (!digits) return { type: 'invalid', digits: '', normalized: cleaned, reason: 'NO_DIGITS' };

  // Phase 8g: Reject floating-point GPS coordinate strings misparsed as numbers (e.g. 27.382262 or 85.309623)
  if (/\b\d{1,3}\.\d{4,8}\b/.test(raw.trim())) {
    return { type: 'invalid', digits: '', normalized: cleaned, reason: 'COORDINATE_FLOAT' };
  }

  // Task 4: Duplicate country code (+977 977 9851234567 -> +977 9851234567)
  if (digits.startsWith('977977')) {
    digits = digits.slice(3);
  }

  // Hard limits: below 7 digits or above 15 digits cannot be any valid phone.
  if (digits.length > 15) return { type: 'invalid', digits, normalized: cleaned, reason: 'TOO_LONG' };

  const hasPlus = cleaned.startsWith('+');
  const startsWith977 = digits.startsWith('977');

  // ── PATH A: Nepal country code prefix (977…) ────────────────────────────────
  if (startsWith977) {
    const afterCC = digits.slice(3); // digits after the 977 country code

    // Mobile: 977 + exactly 10 digits starting with verified NTA mobile prefix
    const isNtaMobilePrefix = NTA_MOBILE_PREFIXES.some((p) => afterCC.startsWith(p));
    if (isNtaMobilePrefix) {
      if (afterCC.length === 10) {
        return { type: 'mobile', digits: afterCC, normalized: formatPhoneDisplay(afterCC, 'mobile', cleaned) };
      }
      return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_MOBILE' };
    }

    // Landline: 977 + 01 + 7 digits (total afterCC length = 9) -> strip trunk 0 -> 1XXXXXXX (8 digits)
    if (afterCC.startsWith('01')) {
      if (afterCC.length === 9) {
        const landlineDigits = afterCC.slice(1);
        return { type: 'landline', digits: landlineDigits, normalized: formatPhoneDisplay(landlineDigits, 'landline', cleaned) };
      }
      return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_LANDLINE' };
    }

    // Landline: 977 + 1 + 7 digits (total afterCC length = 8)
    if (afterCC.startsWith('1')) {
      if (afterCC.length === 8) {
        return { type: 'landline', digits: afterCC, normalized: formatPhoneDisplay(afterCC, 'landline', cleaned) };
      }
      return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_LANDLINE' };
    }

    // Regional Landlines in Path A: 977 + 2-digit area code + 6 digits (e.g. +977-61-520123)
    for (const [code, info] of Object.entries(NTA_LANDLINE_AREA_CODES)) {
      if (code !== '01' && afterCC.startsWith(info.areaCodeDigits)) {
        const expectedLen = info.areaCodeDigits.length + info.subscriberLength;
        if (afterCC.length === expectedLen) {
          return { type: 'landline', digits: afterCC, normalized: formatPhoneDisplay(afterCC, 'landline', cleaned) };
        }
      }
    }

    // Has 977 prefix but no recognised afterCC structure -> international?
    if (hasPlus && digits.length >= 8 && digits.length <= 15) {
      const opens = (cleaned.match(/\(/g) || []).length;
      const closes = (cleaned.match(/\)/g) || []).length;
      if (opens === closes) return { type: 'international', digits, normalized: formatPhoneDisplay(digits, 'international', cleaned) };
    }

    return { type: 'invalid', digits, normalized: cleaned, reason: 'INVALID_STRUCTURE' };
  }

  // ── PATH B: No 977 prefix — domestic or explicit international ───────────────

  // Nepal mobile: exactly 10 digits starting with verified NTA mobile prefix
  const isNtaMobilePrefix = NTA_MOBILE_PREFIXES.some((p) => digits.startsWith(p));
  if (isNtaMobilePrefix) {
    if (digits.length === 10) {
      return { type: 'mobile', digits, normalized: formatPhoneDisplay(digits, 'mobile', cleaned) };
    }
    return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_MOBILE' };
  }

  // Kathmandu domestic landline (with or without '+'): 01 + 7 digits (9 digits total) -> strip trunk 0
  if (digits.length === 9 && digits.startsWith('01')) {
    const landlineDigits = digits.slice(1);
    return { type: 'landline', digits: landlineDigits, normalized: formatPhoneDisplay(landlineDigits, 'landline', cleaned) };
  }

  // Regional domestic landlines (e.g. 061-520123): check NTA_LANDLINE_AREA_CODES
  for (const [code, info] of Object.entries(NTA_LANDLINE_AREA_CODES)) {
    if (code !== '01' && digits.startsWith(code)) {
      const expectedLen = code.length + info.subscriberLength; // e.g. 3 + 6 = 9 digits
      if (digits.length === expectedLen) {
        const canonical = digits.slice(1); // strip trunk 0 -> 8 digits
        return { type: 'landline', digits: canonical, normalized: formatPhoneDisplay(canonical, 'landline', cleaned) };
      }
    }
  }

  // Kathmandu landline bare form: 1 + 7 digits (8 digits total)
  if (digits.length === 8 && digits.startsWith('1')) {
    return { type: 'landline', digits, normalized: formatPhoneDisplay(digits, 'landline', cleaned) };
  }

  // Regional bare landlines (2-digit area code + 6 digits = 8 digits total)
  for (const [code, info] of Object.entries(NTA_LANDLINE_AREA_CODES)) {
    if (code !== '01' && digits.startsWith(info.areaCodeDigits)) {
      const expectedLen = info.areaCodeDigits.length + info.subscriberLength;
      if (digits.length === expectedLen) {
        return { type: 'landline', digits, normalized: formatPhoneDisplay(digits, 'landline', cleaned) };
      }
    }
  }

  // INTERNATIONAL: check for explicit '+' and 8–15 digits with balanced parens
  // Checked AFTER domestic landline so +01-XXXXXXX is recognized as landline, not intl!
  if (hasPlus && digits.length >= 8 && digits.length <= 15) {
    const opens = (cleaned.match(/\(/g) || []).length;
    const closes = (cleaned.match(/\)/g) || []).length;
    if (opens === closes) return { type: 'international', digits, normalized: formatPhoneDisplay(digits, 'international', cleaned) };
  }

  if (digits.startsWith('01') && digits.length !== 9) {
    return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_LANDLINE' };
  }

  if (digits.startsWith('1') && digits.length !== 8) {
    return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_LANDLINE' };
  }

  return { type: 'invalid', digits, normalized: cleaned, reason: 'INVALID_STRUCTURE' };
}

const FACEBOOK_RESERVED_PATHS = new Set([
  'sharer',
  'sharer.php',
  'share',
  'share.php',
  'dialog',
  'plugins',
  'hashtag',
  'login',
  'login.php',
  'signup',
  'tr',
  'policies',
  'help',
  'events',
  'groups',
  'pages',
  'watch',
  'photo',
  'video',
  'story.php',
  'about',
  'terms',
  'privacy',
  'people',
  'directory',
  'marketplace',
  'gaming',
  'reels',
  'saved',
  'memories',
  'fundraiser',
  'crisisresponse',
  'explore',
]);

const TWITTER_RESERVED_PATHS = new Set([
  'share',
  'intent',
  'search',
  'hashtag',
  'home',
  'login',
  'signup',
  'explore',
  'i',
  'privacy',
  'tos',
  'notifications',
  'messages',
  'settings',
]);

const INSTAGRAM_RESERVED_PATHS = new Set([
  'p',
  'reel',
  'reels',
  'stories',
  'explore',
  'accounts',
  'developer',
  'about',
  'legal',
  'nametag',
]);

/**
 * Note: This list is maintained, not derived. Additions should be reviewed for false-positive risk.
 */
export const INDUSTRY_GENERIC_TOKENS = new Set([
  'dental', 'dentist', 'dentistry', 'orthodontic', 'orthodontics', 'oral', 'smile',
  'clinic', 'care', 'hospital', 'health', 'healthcare', 'medical', 'med',
  'pharma', 'pharmacy', 'diagnostic', 'pathology', 'lab', 'laboratory', 'center',
  'centre', 'institute', 'poly', 'polyclinic', 'nursing', 'home',
  'realtors', 'realestate', 'properties', 'property', 'homes', 'builders', 'developers',
  'construction', 'group', 'pvt', 'ltd', 'inc', 'co', 'corp', 'company',
  'hotel', 'resort', 'lodge', 'guest', 'house', 'inn', 'stay', 'cafe', 'restaurant',
  'coffee', 'bakery', 'kitchen', 'food', 'foods', 'travel', 'travels', 'tours',
  'trekking', 'adventure', 'expedition', 'holidays', 'nepal', 'kathmandu', 'pokhara',
  'lalitpur', 'bhaktapur', 'services', 'service', 'solutions', 'tech', 'technologies',
  'auto', 'automobiles', 'motors', 'cleaning', 'clean', 'hygiene', 'express',
  'international', 'global', 'nepali', 'official', 'hub', 'point', 'mart', 'store',
  // Phase 8i additions: commercial, retail, trade, medical, education
  'shop', 'shops', 'stores', 'marts', 'market', 'bazaar',
  'drug', 'drugs', 'chemist', 'dispensary',
  'repair', 'repairs', 'mobile', 'electronics', 'supplier', 'suppliers', 'supply', 'supplies', 'hardware',
  'trade', 'trading', 'traders', 'trader', 'link', 'udhyog', 'enterprises', 'enterprise',
  'machinery', 'tools', 'sanitary', 'steel', 'metal', 'iron', 'cement', 'paint', 'paints', 'pipes', 'fittings',
  'school', 'schools', 'college', 'colleges', 'academy', 'vidya', 'mandir', 'gyanpeeth', 'secondary', 'higher',
  // Nepal administrative localities (must not count as distinctive brand tokens)
  'satungal', 'chandragiri', 'thamel', 'patan', 'kirtipur', 'baneshwor', 'thankot', 'naikap',
  'gurjudhara', 'chabahil', 'kalanki', 'koteshwor', 'dillibazar', 'lazimpat', 'maharajgunj',
  'balkhu', 'anamnagar', 'sinamangal', 'tinkune', 'kupondole', 'jawalakhel', 'sanepa',
  'kumaripati', 'satdobato', 'gongabu', 'balaju',
  // Satungal sweep Class B: cross-category generic gym/venue words
  'active', 'station',
]);

/**
 * Universal stopwords that are stripped across all categories before distinctive matching.
 */
export const UNIVERSAL_STOPWORDS = new Set<string>([
  'and', 'the', 'of', 'in', 'for', 'at', 'by', 'to',
  '&', 'pvt', 'ltd', 'p', 'l', 'inc', 'co',
  'international', 'global',
  // Glue words that must never count as distinctive brand tokens (Satungal sweep).
  'with', 'without', 'via', 'near', 'upon', 'into', 'from',
]);

/**
 * Administrative localities used for social profile location corroboration (D23).
 */
export const NEPAL_LOCALITY_TOKENS = new Set<string>([
  'satungal', 'chandragiri', 'thamel', 'patan', 'kirtipur', 'baneshwor', 'thankot', 'naikap',
  'gurjudhara', 'chabahil', 'kalanki', 'koteshwor', 'dillibazar', 'lazimpat', 'maharajgunj',
  'balkhu', 'anamnagar', 'sinamangal', 'tinkune', 'kupondole', 'jawalakhel', 'sanepa',
  'kumaripati', 'satdobato', 'gongabu', 'balaju', 'kathmandu', 'pokhara', 'lalitpur', 'bhaktapur',
]);

/**
 * Phase 8k/8M — Category-scoped generic tokens map.
 * Used by the website ranker and social alignment gate to build per-category stop-lists.
 * Keys are normalized category slugs derived from Maps categories[] or user query tokens.
 * UNIVERSAL_STOPWORDS (in website-search-ranker.service.ts) are applied first, then this map.
 */
export const CATEGORY_GENERIC_TOKENS: Record<string, string[]> = {
  dental: ['dental', 'dentist', 'dentistry', 'orthodontic', 'orthodontics', 'oral', 'smile',
    'clinic', 'care', 'hospital', 'center', 'centre', 'health', 'healthcare'],
  medical: ['clinic', 'hospital', 'health', 'healthcare', 'polyclinic', 'pharmacy', 'medical',
    'care', 'center', 'centre', 'nursing', 'diagnostic', 'lab', 'laboratory'],
  education: ['school', 'secondary', 'primary', 'academy', 'college', 'vidyalaya', 'shiksha',
    'institute', 'campus', 'vidya', 'mandir', 'gyanpeeth', 'higher'],
  hospitality: ['hotel', 'resort', 'lodge', 'inn', 'stay', 'guest', 'house', 'restaurant', 'cafe',
    'coffee', 'bakery', 'kitchen'],
  legal: ['law', 'lawyer', 'advocate', 'legal', 'associates', 'chambers', 'attorney', 'solicitors'],
  fitness: ['gym', 'fitness', 'club', 'center', 'centre', 'workout', 'training', 'health',
    // Satungal sweep Class B (D-2.3 Active Fitness Gym)
    'active', 'station', 'zone', 'body', 'physique', 'exercise'],
  retail: ['store', 'shop', 'mart', 'kirana', 'pasal', 'center', 'centre', 'enterprise',
    'market', 'bazaar', 'mart'],
  beauty: [
    'beauty', 'salon', 'parlour', 'parlor', 'hair', 'makeup', 'cosmetic', 'cosmetics',
    'spa', 'nail', 'wellness', 'skin', 'skincare', 'grooming', 'threading', 'waxing',
    'facial', 'pedicure', 'manicure', 'bridal', 'studio', 'care', 'center', 'centre',
    'style', 'styling', 'look', 'glam', 'glamour', 'fashion',
    // additional generic terms surfaced by Checkpoint 1 analysis (D16-D22)
    'unisex', 'ladies', 'gents', 'royal', 'hub', 'collection', 'classic', 'elegant',
    // Satungal sweep Class B (D-3.1 Santosh Hair cutting)
    'cutting', 'cut', 'saloon', 'barber', 'barbershop', 'haircut', 'haircuts',
    'shave', 'shaving', 'clipper', 'clippers',
  ],
  venue: [
    'banquet', 'banquets', 'hall', 'halls', 'party', 'palace', 'venue', 'venues',
    'reception', 'community', 'function', 'functions', 'programme', 'program',
    'auditorium', 'marriage', 'wedding', 'event', 'events', 'celebration',
    'ceremony', 'party palace', 'garden', 'banquet hall',
  ],
  hardware: [
    'hardware', 'machinery', 'machine', 'supplier', 'suppliers', 'supply', 'supplies',
    'tools', 'steel', 'metal', 'iron', 'heavy', 'sanitary', 'sanitation', 'tiles',
    'pipe', 'pipes', 'fittings', 'electric', 'electrical', 'paints', 'paint', 'cement',
    'construction', 'materials', 'plywood', 'glass', 'aluminum', 'distributor', 'distributors',
    'dealers', 'dealer', 'wholesale', 'retail', 'udhyog', 'enterprises', 'enterprise',
    'trade', 'trading', 'link', 'traders', 'trader', 'ware', 'multitrade',
  ],
  driving: [
    'driving', 'driver', 'drivers', 'motor', 'motors', 'training', 'school',
    'institute', 'academy', 'center', 'centre', 'vehicle', 'vehicles', 'car',
    'bike', 'scooter', 'scooty', 'license', 'licence', 'trial', 'transport',
    'auto', 'learners', 'instructor', 'riding', 'heavy', 'trail',
  ],
  furniture: [
    'furniture', 'furnishing', 'furnishings', 'interior', 'interiors', 'sofa',
    'bed', 'table', 'chair', 'wood', 'wooden', 'decor', 'home', 'living',
    'store', 'shop', 'house', 'handicraft', 'kitchen', 'mattress', 'design',
    'udhyog', 'plywood', 'almirah', 'wardrobe', 'cabinet', 'fixture', 'fixtures',
  ],
  services: ['service', 'services', 'repair', 'cleaning', 'plumbing', 'solutions', 'works'],
};

/**
 * Phase 8O (D36 — Amendment 2) — Cross-Category Social Rejection Map.
 * Prevents handles with explicit alien category tokens from attaching to disjoint business types.
 */
export const CONFLICTING_VERTICAL_TOKENS: Record<string, string[]> = {
  furniture: ['food', 'cafe', 'restaurant', 'kitchen', 'bakery'],
  dental: ['furniture', 'sofa', 'food', 'cafe'],
  beauty: ['furniture', 'sofa', 'food', 'cafe'],
  hardware: ['food', 'cafe', 'restaurant'],
  driving: ['furniture', 'sofa', 'food', 'cafe'],
};

/**
 * Strict-majority overlap threshold for social handles (mirrors ranker requiredNameOverlap).
 * Defined locally to avoid a circular import with website-search-ranker.service.ts.
 * Table: 0->0, 1->1, 2->2, 3->2, 4->3, 5->3, 6->4, ...
 */
function requiredSocialNameOverlap(distinctiveTokenCount: number): number {
  if (distinctiveTokenCount <= 0) return 0;
  if (distinctiveTokenCount === 1) return 1;
  return Math.max(2, Math.floor(distinctiveTokenCount / 2) + 1);
}

/**
 * Brand segment for title-style Maps/SERP names: "R S Dental: Multispeciality Clinic"
 * → "R S Dental". Used for social distinctive-token matching so descriptor words after
 * `:` / ` | ` / ` - ` do not inflate the strict-majority denominator.
 */
function brandSegmentFromBusinessName(name: string): string {
  const brand = name.split(/\s*[:|]\s*|\s+[-–—]\s+/)[0]?.trim() || '';
  return brand.length >= 2 ? brand : name;
}

/**
 * Phase 8k/8M/8N — Normalizes a Maps category string (e.g. 'Dental clinic', 'Hardware store', 'Driving school') to a CATEGORY_GENERIC_TOKENS key.
 * Resolution order:
 *  1. Priority category-specific keywords (e.g. 'driving', 'dental', 'furniture', 'hardware', 'beauty')
 *  2. General institutional keywords (e.g. 'school' -> education, 'clinic' -> medical, 'store' -> retail)
 *  3. User query token match
 *  4. Default to 'services' (most permissive) and increment CATEGORY_UNRESOLVED telemetry
 */
export function resolveCategoryKey(
  categoryContext: string | string[] | undefined,
  userQuery?: string
): string {
  // Specific vertical keywords take strict priority over generic institutional nouns like 'school' or 'store'
  const PRIORITY_KEYWORD_MAP: Record<string, string> = {
    driving: 'driving', driver: 'driving', drivers: 'driving', motor: 'driving', motors: 'driving',
    license: 'driving', licence: 'driving', vehicle: 'driving', vehicles: 'driving', trial: 'driving',
    furniture: 'furniture', furnishing: 'furniture', furnishings: 'furniture',
    interior: 'furniture', interiors: 'furniture', sofa: 'furniture', wood: 'furniture',
    wooden: 'furniture', decor: 'furniture', mattress: 'furniture',
    dental: 'dental', dentist: 'dental', dentistry: 'dental', orthodontic: 'dental', oral: 'dental',
    beauty: 'beauty', salon: 'beauty', parlour: 'beauty', parlor: 'beauty',
    hair: 'beauty', spa: 'beauty', cosmetic: 'beauty', makeup: 'beauty',
    barber: 'beauty', barbershop: 'beauty', unisex: 'beauty',
    hardware: 'hardware', machinery: 'hardware', tools: 'hardware', sanitary: 'hardware',
    tiles: 'hardware', paint: 'hardware', paints: 'hardware', cement: 'hardware',
    construction: 'hardware', steel: 'hardware', metal: 'hardware', pipe: 'hardware',
    pipes: 'hardware', plywood: 'hardware',
    gym: 'fitness', fitness: 'fitness', workout: 'fitness',
    banquet: 'venue', venue: 'venue', reception: 'venue',
    palace: 'venue', party: 'venue', hall: 'venue',
  };

  const GENERAL_KEYWORD_MAP: Record<string, string> = {
    clinic: 'medical', hospital: 'medical', pharmacy: 'medical', medical: 'medical',
    school: 'education', college: 'education', academy: 'education', institute: 'education',
    hotel: 'hospitality', resort: 'hospitality', restaurant: 'hospitality', cafe: 'hospitality',
    law: 'legal', lawyer: 'legal', advocate: 'legal', legal: 'legal', attorney: 'legal',
    store: 'retail', shop: 'retail', mart: 'retail', kirana: 'retail', grocery: 'retail',
    service: 'services', repair: 'services', cleaning: 'services', plumbing: 'services',
  };

  const contexts = [
    ...(Array.isArray(categoryContext) ? categoryContext : categoryContext ? [categoryContext] : []),
    ...(userQuery ? [userQuery] : []),
  ];

  // Pass 1: Check high-priority vertical keywords
  for (const ctx of contexts) {
    if (!ctx) continue;
    const normalized = ctx.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    for (const word of normalized) {
      if (PRIORITY_KEYWORD_MAP[word]) return PRIORITY_KEYWORD_MAP[word];
    }
  }

  // Pass 2: Check general institutional keywords
  for (const ctx of contexts) {
    if (!ctx) continue;
    const normalized = ctx.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    for (const word of normalized) {
      if (GENERAL_KEYWORD_MAP[word]) return GENERAL_KEYWORD_MAP[word];
    }
  }

  return 'services';
}

/**
 * Phase 8k Component 5 — Negative patterns for person name extraction garbage filtering.
 * Phrases that look structurally like schedules, business instructions, or CTA text
 * are rejected before being set as `associatedPerson`.
 */
export const SCHEDULE_GARBAGE_PATTERNS: RegExp[] = [
  /during\s+opening\s+hours/i,
  /\bworking\s+hours/i,
  /\boffice\s+hours/i,
  /\bbusiness\s+hours/i,
  /\bopening\s+hours/i,
  /\bsun\s*[-–]\s*fri/i,
  /\bmon\s*[-–]\s*fri/i,
  /\bsun\s*[-–]\s*sat/i,
  /\bsaturday\s+closed/i,
  /\bam\s*[-–to]+\s*pm/i,
  /\bopen\s+now/i,
  /\bclosed\s+now/i,
  /\bavailable\s+during/i,
  /\bcontact\s+us\s+during/i,
  /\bbook\s+(?:an\s+)?appointment/i,
  /\bcall\s+us\s+today/i,
  /\d{1,2}\s*(?:am|pm)/i,
  /\b(?:ions|hours|here|gap|start)\b/i,
  /\bdirections?\b/i,
  /\bhours\s+here\b/i,
  /\bstart\s+gap\b/i,
  /\bdirections\s+and\s+hours\b/i,
  /\btimings?\b/i,
  /\bschedule\b/i,
  /\bemergency\s+services?\b/i,
  /\bquick\s+links?\b/i,
];

export const FACEBOOK_NON_CANONICAL_SUBPATHS = new Set([
  'mentions',
  'videos',
  'posts',
  'photos',
  'reviews',
  'about',
  'community',
  'events',
  'reels',
  'services',
  'shop',
  'offers',
]);

/**
 * Strips subpaths and content endpoints to derive canonical social profile URLs.
 */
export function computeCanonicalSocialUrl(
  url: string,
  plat: ClassifiedSocialProfile['platform']
): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    if (pathSegments.length === 0) return url;

    if (plat === 'facebook') {
      const first = pathSegments[0].toLowerCase();
      if (first === 'p' && pathSegments.length > 1) {
        return `https://facebook.com/p/${pathSegments[1]}`;
      }
      if (first === 'pages' && pathSegments.length > 2) {
        return `https://facebook.com/pages/${pathSegments[1]}/${pathSegments[2]}`;
      }
      if (first === 'profile.php') {
        const id = parsed.searchParams.get('id');
        return id ? `https://facebook.com/profile.php?id=${id}` : url;
      }
      if (pathSegments.length > 1 && FACEBOOK_NON_CANONICAL_SUBPATHS.has(pathSegments[1].toLowerCase())) {
        return `https://facebook.com/${pathSegments[0]}`;
      }
      return `https://facebook.com/${pathSegments[0]}`;
    }

    if (plat === 'tiktok') {
      const handle = pathSegments[0].startsWith('@') ? pathSegments[0] : `@${pathSegments[0]}`;
      return `https://tiktok.com/${handle}`;
    }

    if (plat === 'instagram') {
      const first = pathSegments[0].toLowerCase();
      if (['p', 'reel', 'reels', 'stories', 'explore'].includes(first)) {
        return url;
      }
      return `https://instagram.com/${pathSegments[0]}`;
    }

    if (plat === 'linkedin') {
      const first = pathSegments[0].toLowerCase();
      if (first === 'company' && pathSegments[1]) {
        return `https://linkedin.com/company/${pathSegments[1]}`;
      }
      if (first === 'in' && pathSegments[1]) {
        return `https://linkedin.com/in/${pathSegments[1]}`;
      }
      return url;
    }

    if (plat === 'twitter') {
      return `https://x.com/${pathSegments[0]}`;
    }

    if (plat === 'youtube') {
      if (pathSegments[0].startsWith('@')) {
        return `https://youtube.com/${pathSegments[0]}`;
      }
      if ((pathSegments[0] === 'channel' || pathSegments[0] === 'c') && pathSegments[1]) {
        return `https://youtube.com/${pathSegments[0]}/${pathSegments[1]}`;
      }
      return `https://youtube.com/${pathSegments[0]}`;
    }

    return url;
  } catch {
    return url;
  }
}

export const PLATFORM_OFFICIAL_HANDLES = new Map<string, string[]>([
  ['facebook',  ['facebook', 'fb', 'meta', 'help', 'support', 'business', 'developers']],
  ['instagram', ['instagram', 'meta', 'help', 'support', 'creators', 'business']],
  ['twitter',   ['twitter', 'x', 'support', 'help', 'api', 'verified']],
  ['linkedin',  ['linkedin', 'help', 'support', 'learning']],
  ['youtube',   ['youtube', 'google', 'creators']],
  ['tiktok',    ['tiktok', 'bytedance', 'creators', 'ads']],
]);

/**
 * Known third-party site-builder / vendor social handles.
 * These profiles belong to technology/CMS platforms, not the business entity.
 */
export const KNOWN_VENDOR_SOCIAL_HANDLES = new Map<string, string[]>([
  ['facebook',  ['sitepad', 'softaculous', 'wix', 'wixcom', 'shopify', 'squarespace',
                 'weebly', 'godaddy', 'longtail', 'longtailemed', 'webflow', 'carrd']],
  ['twitter',   ['sitepad_editor', 'softaculous', 'wix', 'shopify', 'squarespace',
                 'weebly', 'godaddy', 'longtail', 'webflow']],
  ['linkedin',  ['softaculous-ltd-', 'wix', 'shopify-inc', 'squarespace', 'godaddy',
                 'longtail-e-media', 'webflow']],
  ['instagram', ['sitepadorcom', 'wix', 'shopify', 'squarespace', 'weebly']],
]);

export function isRealSocialProfile(url: string, platform?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    if (pathSegments.length === 0) return false; // Bare domain e.g. https://facebook.com/

    const firstSegment = pathSegments[0].toLowerCase().replace(/^@/, '');

    // Facebook validation:
    if (platform === 'facebook' || parsed.hostname.includes('facebook.com')) {
      if (firstSegment === 'profile.php') {
        const id = parsed.searchParams.get('id');
        return !!(id && /^\d+$/.test(id));
      }
      if (FACEBOOK_RESERVED_PATHS.has(firstSegment)) return false;
      const isModernPagePattern = firstSegment === 'p' && pathSegments.length > 1;
      const isPagesPattern = firstSegment === 'pages' && pathSegments.length > 2;
      if (!isModernPagePattern && !isPagesPattern && firstSegment.length < 3) return false;
      return true;
    }

    // Twitter / X validation:
    if (platform === 'twitter' || parsed.hostname.includes('twitter.com') || parsed.hostname.includes('x.com')) {
      if (TWITTER_RESERVED_PATHS.has(firstSegment)) return false;
      if (!/^[a-zA-Z0-9_]{2,30}$/.test(firstSegment)) return false;
      return true;
    }

    // Instagram validation:
    if (platform === 'instagram' || parsed.hostname.includes('instagram.com')) {
      if (INSTAGRAM_RESERVED_PATHS.has(firstSegment)) return false;
      if (!/^[a-zA-Z0-9._]{2,30}$/.test(firstSegment)) return false;
      return true;
    }

    // TikTok validation:
    if (platform === 'tiktok' || parsed.hostname.includes('tiktok.com')) {
      if (['video', 'share', 'embed', 'tag', 'music', 'live', 'discover'].includes(firstSegment)) return false;
      const handle = firstSegment.replace(/^@/, '');
      if (!/^[a-zA-Z0-9._]{2,30}$/.test(handle)) return false;
      return true;
    }

    // LinkedIn validation:
    if (platform === 'linkedin' || parsed.hostname.includes('linkedin.com')) {
      if (firstSegment !== 'company' && firstSegment !== 'in') return false;
      const handle = pathSegments[1]?.toLowerCase();
      if (!handle || handle.length < 2) return false;
      if (['sharearticle', 'share-offsite'].includes(handle)) return false;
      return true;
    }

    // YouTube validation:
    if (platform === 'youtube' || parsed.hostname.includes('youtube.com')) {
      if (['watch', 'feed', 'channel', 'results'].includes(firstSegment) && !pathSegments[1]) return false;
      return true;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Classifies a social profile URL into a 3-state ownership decision model:
 * status: 'accepted' | 'rejected' | 'unknown'
 * with explicit forensic rejectionReason and profileType.
 */
export function classifySocialProfile(
  url: string,
  platform?: string,
  businessName?: string,
  websiteDomain?: string,
  categoryContext?: string | string[],
  origin?: 'website_evidence' | 'serp' | 'maps'
): ClassifiedSocialProfile {
  if (!url) {
    return {
      url: '',
      platform: 'other',
      handle: '',
      profileType: 'unknown',
      owner: 'unknown',
      status: 'rejected',
      confidence: 1.0,
      rejectionReason: 'NOT_A_REAL_PROFILE',
      distinctiveTokensFound: [],
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      url,
      platform: 'other',
      handle: '',
      profileType: 'unknown',
      owner: 'unknown',
      status: 'rejected',
      confidence: 1.0,
      rejectionReason: 'NOT_A_REAL_PROFILE',
      distinctiveTokensFound: [],
    };
  }

  const host = parsed.hostname.toLowerCase();
  let plat: ClassifiedSocialProfile['platform'] = 'other';
  if (host.includes('facebook.com') || host.includes('fb.com')) plat = 'facebook';
  else if (host.includes('instagram.com')) plat = 'instagram';
  else if (host.includes('tiktok.com')) plat = 'tiktok';
  else if (host.includes('twitter.com') || host.includes('x.com')) plat = 'twitter';
  else if (host.includes('youtube.com') || host.includes('youtu.be')) plat = 'youtube';
  else if (host.includes('linkedin.com')) plat = 'linkedin';
  else if (platform) {
    const p = platform.toLowerCase();
    if (['facebook', 'instagram', 'tiktok', 'twitter', 'youtube', 'linkedin'].includes(p)) {
      plat = p as ClassifiedSocialProfile['platform'];
    }
  }

  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  if (pathSegments.length === 0) {
    return {
      url,
      platform: plat,
      handle: '',
      profileType: 'unknown',
      owner: 'unknown',
      status: 'rejected',
      confidence: 1.0,
      rejectionReason: 'NOT_A_REAL_PROFILE',
      distinctiveTokensFound: [],
    };
  }

  const firstSegment = pathSegments[0].toLowerCase().replace(/^@/, '');

  // 1. Share / intent / reserved endpoints across platforms
  if (plat === 'facebook') {
    if (
      firstSegment === 'sharer.php' ||
      firstSegment === 'sharer' ||
      firstSegment === 'dialog' ||
      firstSegment === 'plugins' ||
      parsed.pathname.includes('/sharer')
    ) {
      return {
        url,
        platform: plat,
        handle: firstSegment,
        profileType: 'unknown',
        owner: 'unknown',
        status: 'rejected',
        confidence: 1.0,
        rejectionReason: 'NOT_A_REAL_PROFILE',
        distinctiveTokensFound: [],
      };
    }
    if (FACEBOOK_RESERVED_PATHS.has(firstSegment)) {
      return {
        url,
        platform: plat,
        handle: firstSegment,
        profileType: 'unknown',
        owner: 'unknown',
        status: 'rejected',
        confidence: 1.0,
        rejectionReason: 'RESERVED_PATH',
        distinctiveTokensFound: [],
      };
    }
    if (firstSegment === 'profile.php') {
      const id = parsed.searchParams.get('id');
      if (id && /^\d+$/.test(id)) {
        return {
          url,
          platform: plat,
          handle: id,
          profileType: 'unknown',
          owner: 'unknown',
          status: 'unknown',
          confidence: 0.5,
          rejectionReason: 'INSUFFICIENT_EVIDENCE',
          distinctiveTokensFound: [],
        };
      }
      return {
        url,
        platform: plat,
        handle: 'profile.php',
        profileType: 'unknown',
        owner: 'unknown',
        status: 'rejected',
        confidence: 1.0,
        rejectionReason: 'NOT_A_REAL_PROFILE',
        distinctiveTokensFound: [],
      };
    }
    const isModernPagePattern = firstSegment === 'p' && pathSegments.length > 1;
    const isPagesPattern = firstSegment === 'pages' && pathSegments.length > 2;

    if (!isModernPagePattern && !isPagesPattern && firstSegment.length < 3) {
      return {
        url,
        platform: plat,
        handle: firstSegment,
        profileType: 'unknown',
        owner: 'unknown',
        status: 'rejected',
        confidence: 1.0,
        rejectionReason: 'NOT_A_REAL_PROFILE',
        distinctiveTokensFound: [],
      };
    }
  } else if (plat === 'twitter') {
    if (
      firstSegment === 'intent' ||
      firstSegment === 'share' ||
      parsed.pathname.includes('/intent') ||
      parsed.pathname.includes('/share')
    ) {
      return {
        url,
        platform: plat,
        handle: firstSegment,
        profileType: 'unknown',
        owner: 'unknown',
        status: 'rejected',
        confidence: 1.0,
        rejectionReason: 'NOT_A_REAL_PROFILE',
        distinctiveTokensFound: [],
      };
    }
    if (TWITTER_RESERVED_PATHS.has(firstSegment)) {
      return {
        url,
        platform: plat,
        handle: firstSegment,
        profileType: 'unknown',
        owner: 'unknown',
        status: 'rejected',
        confidence: 1.0,
        rejectionReason: 'RESERVED_PATH',
        distinctiveTokensFound: [],
      };
    }
  } else if (plat === 'instagram') {
    if (INSTAGRAM_RESERVED_PATHS.has(firstSegment)) {
      return {
        url,
        platform: plat,
        handle: firstSegment,
        profileType: 'unknown',
        owner: 'unknown',
        status: 'rejected',
        confidence: 1.0,
        rejectionReason: 'RESERVED_PATH',
        distinctiveTokensFound: [],
      };
    }
  } else if (plat === 'linkedin') {
    if (
      firstSegment === 'sharearticle' ||
      firstSegment === 'share-offsite' ||
      firstSegment === 'sharing'
    ) {
      return {
        url,
        platform: plat,
        handle: firstSegment,
        profileType: 'unknown',
        owner: 'unknown',
        status: 'rejected',
        confidence: 1.0,
        rejectionReason: 'NOT_A_REAL_PROFILE',
        distinctiveTokensFound: [],
      };
    }
    if (firstSegment === 'in') {
      const handle = pathSegments[1] || '';
      return {
        url,
        platform: plat,
        handle,
        profileType: 'personal_profile',
        owner: 'person',
        status: 'rejected',
        confidence: 1.0,
        rejectionReason: 'PERSONAL_PROFILE',
        distinctiveTokensFound: [],
      };
    }
    if (firstSegment !== 'company') {
      return {
        url,
        platform: plat,
        handle: firstSegment,
        profileType: 'unknown',
        owner: 'unknown',
        status: 'rejected',
        confidence: 1.0,
        rejectionReason: 'NOT_A_REAL_PROFILE',
        distinctiveTokensFound: [],
      };
    }
  } else if (plat === 'tiktok') {
    if (['video', 'share', 'embed', 'tag', 'music', 'live', 'discover'].includes(firstSegment)) {
      return {
        url,
        platform: plat,
        handle: firstSegment,
        profileType: 'unknown',
        owner: 'unknown',
        status: 'rejected',
        confidence: 1.0,
        rejectionReason: 'NOT_A_REAL_PROFILE',
        distinctiveTokensFound: [],
      };
    }
  } else if (plat === 'youtube') {
    if (['watch', 'playlist', 'embed', 'shorts', 'feed', 'results', 'gaming', 'premium'].includes(firstSegment)) {
      return {
        url,
        platform: plat,
        handle: firstSegment,
        profileType: 'unknown',
        owner: 'unknown',
        status: 'rejected',
        confidence: 1.0,
        rejectionReason: 'NOT_A_REAL_PROFILE',
        distinctiveTokensFound: [],
      };
    }
    const isChannelSegment = firstSegment === 'channel' || firstSegment === 'c' || firstSegment === 'user';
    const channelId = pathSegments[1] || '';
    if (isChannelSegment) {
      const canonicalUrl = computeCanonicalSocialUrl(url, plat) || url;
      if (origin === 'website_evidence') {
        return {
          url,
          canonicalUrl,
          platform: plat,
          handle: channelId || firstSegment,
          profileType: 'business_page',
          owner: 'business',
          status: 'accepted',
          confidence: 0.9,
          rejectionReason: 'NONE',
          distinctiveTokensFound: [],
        };
      } else {
        return {
          url,
          canonicalUrl,
          platform: plat,
          handle: channelId || firstSegment,
          profileType: 'business_page',
          owner: 'unknown',
          status: 'rejected',
          confidence: 0.8,
          rejectionReason: 'OPAQUE_CHANNEL_ID',
          distinctiveTokensFound: [],
        };
      }
    }
  }

  // Extract handle
  let handle = firstSegment;
  if (plat === 'facebook' && firstSegment === 'p' && pathSegments.length > 1) {
    handle = (pathSegments[1] || '').replace(/-\d{8,}$/, '');
  } else if (plat === 'facebook' && firstSegment === 'pages' && pathSegments.length > 2) {
    handle = (pathSegments[2] || '').replace(/-\d+$/, '');
  } else if (plat === 'linkedin' && firstSegment === 'company') {
    handle = (pathSegments[1] || '').toLowerCase();
    if (!handle || handle.length < 2 || ['sharearticle', 'share-offsite'].includes(handle)) {
      return {
        url,
        platform: plat,
        handle: handle || '',
        profileType: 'unknown',
        owner: 'unknown',
        status: 'rejected',
        confidence: 1.0,
        rejectionReason: 'NOT_A_REAL_PROFILE',
        distinctiveTokensFound: [],
      };
    }
  } else if (plat === 'youtube' && (firstSegment === 'c' || firstSegment === 'channel' || firstSegment === 'user') && pathSegments.length > 1) {
    handle = pathSegments[1] || '';
  }

  const cleanHandle = handle.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (cleanHandle.length < 2) {
    return {
      url,
      platform: plat,
      handle,
      profileType: 'unknown',
      owner: 'unknown',
      status: 'rejected',
      confidence: 1.0,
      rejectionReason: 'NOT_A_REAL_PROFILE',
      distinctiveTokensFound: [],
    };
  }

  const canonicalUrl = computeCanonicalSocialUrl(url, plat) || url;

  // 2. Check Platform Official Handles
  const platformOfficials = PLATFORM_OFFICIAL_HANDLES.get(plat) || [];
  if (platformOfficials.some((p) => cleanHandle === p.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
    return {
      url,
      canonicalUrl,
      platform: plat,
      handle,
      profileType: 'business_page',
      owner: 'platform',
      status: 'rejected',
      confidence: 1.0,
      rejectionReason: 'PLATFORM_PROFILE',
      distinctiveTokensFound: [],
    };
  }

  // 3. Check Vendor Handles
  const vendorHandles = KNOWN_VENDOR_SOCIAL_HANDLES.get(plat) || [];
  for (const v of vendorHandles) {
    const cleanV = v.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cleanHandle === cleanV || cleanHandle.includes(cleanV) || cleanV.includes(cleanHandle)) {
      return {
        url,
        canonicalUrl,
        platform: plat,
        handle,
        profileType: 'business_page',
        owner: 'vendor',
        status: 'rejected',
        confidence: 1.0,
        rejectionReason: 'VENDOR_PROFILE',
        distinctiveTokensFound: [],
      };
    }
  }

  // 4. Token Alignment & Ownership Classification
  if (!businessName && !websiteDomain) {
    return {
      url,
      canonicalUrl,
      platform: plat,
      handle,
      profileType: 'business_page',
      owner: 'unknown',
      status: 'unknown',
      confidence: 0.5,
      rejectionReason: 'INSUFFICIENT_EVIDENCE',
      distinctiveTokensFound: [],
    };
  }

  // Decompose cleanHandle by removing generic tokens to isolate distinctive brand parts
  // Sort generic tokens descending by length so longer terms match first
  //
  // Phase 8L fix (D16-D22 root cause): previously only INDUSTRY_GENERIC_TOKENS + raw category-string
  // words were merged here, meaning curated beauty-specific tokens like 'unisex', 'royal', 'studio'
  // were never added → treated as distinctive → wrong socials accepted.
  // Fix: resolve the category key (same as website ranker) and merge the full CATEGORY_GENERIC_TOKENS list.
  const resolvedCategoryKey = resolveCategoryKey(categoryContext);
  const resolvedCategoryTokens = CATEGORY_GENERIC_TOKENS[resolvedCategoryKey] ?? CATEGORY_GENERIC_TOKENS['services'];

  const categoryGenericTokens = new Set<string>([
    ...UNIVERSAL_STOPWORDS,
    ...INDUSTRY_GENERIC_TOKENS,
    ...resolvedCategoryTokens,
  ]);

  if (categoryContext) {
    // Also add raw words from the Maps category strings (e.g. 'Beauty salon', 'Hair salon')
    // as additional coverage for category-specific terms not in the curated map.
    const contexts = Array.isArray(categoryContext) ? categoryContext : [categoryContext];
    for (const ctx of contexts) {
      if (!ctx || typeof ctx !== 'string') continue;
      const words = ctx
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3);
      for (const w of words) {
        categoryGenericTokens.add(w);
        if (w.endsWith('s') && w.length > 3) {
          categoryGenericTokens.add(w.slice(0, -1));
        }
      }
    }
  }

  const sortedGenericTokens = Array.from(categoryGenericTokens).sort((a, b) => b.length - a.length);
  let strippedHandle = cleanHandle;
  for (const gen of sortedGenericTokens) {
    if (strippedHandle.includes(gen)) {
      strippedHandle = strippedHandle.split(gen).join(' ');
    }
  }
  const handleWordsFromSeparators = handle.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const handleWordsFromStripped = strippedHandle.split(/\s+/).filter(Boolean);
  const allHandleWords = Array.from(new Set([...handleWordsFromSeparators, ...handleWordsFromStripped]));
  const distinctiveHandleTokens = handleWordsFromStripped.filter(
    (w) => w.length >= 2 && !/^\d+$/.test(w) && !categoryGenericTokens.has(w)
  );

  // Phase 8O (D36 — Amendment 2): Category-Inverse Cross-Vertical Collision Check
  const conflictingVerticalTokens = CONFLICTING_VERTICAL_TOKENS[resolvedCategoryKey] || [];
  if (conflictingVerticalTokens.length > 0) {
    const bizLower = (businessName || '').toLowerCase();
    const ctxLower = Array.isArray(categoryContext)
      ? categoryContext.join(' ').toLowerCase()
      : (categoryContext || '').toLowerCase();

    const hasConflictingToken = conflictingVerticalTokens.some((tok) => {
      const appearsInHandle = allHandleWords.includes(tok) || cleanHandle.includes(tok);
      if (!appearsInHandle) return false;
      // Do not reject if the target business name or category context itself contains the token
      if (bizLower.includes(tok) || ctxLower.includes(tok)) return false;
      return true;
    });

    if (hasConflictingToken) {
      return {
        url,
        canonicalUrl,
        platform: plat,
        handle,
        profileType: 'business_page',
        owner: 'unknown',
        status: 'rejected',
        confidence: 0.95,
        rejectionReason: 'BUSINESS_NAME_MISMATCH',
        distinctiveTokensFound: [],
      };
    }
  }

  // Derive business tokens (full and distinctive) from the brand segment so
  // title descriptors ("R S Dental: Multispeciality Clinic") do not add
  // non-matching distinctive tokens that break strict-majority overlap.
  const brandBusinessName = brandSegmentFromBusinessName(businessName || '');
  const fullBusinessTokens = brandBusinessName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);

  // Clarification 1: The acronym rule derives from full business-name tokens (pre-generic-filter)
  const businessAcronym = fullBusinessTokens.map((t) => t[0]).join('');

  // Distinctive business tokens (generic terms filtered out)
  const distinctiveBusinessTokens: string[] = brandBusinessName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !categoryGenericTokens.has(t));

  if (websiteDomain) {
    let domainLabel = domainFromUrlOrHost(websiteDomain);
    domainLabel = domainLabel.split('.')[0]?.toLowerCase() || '';
    if (domainLabel.length >= 2 && !categoryGenericTokens.has(domainLabel)) {
      distinctiveBusinessTokens.push(domainLabel);
    }
    const domainWords = domainLabel
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 2 && !categoryGenericTokens.has(w));
    distinctiveBusinessTokens.push(...domainWords);
  }

  // Support initialisms at the start of business name (e.g. "J. B Machinery" -> "jb", "R S Dental" -> "rs", "D.I. Dental" -> "di")
  const initialismMatch = brandBusinessName.match(/^([a-zA-Z])[\s.]*([a-zA-Z])(?:[\s.]*([a-zA-Z]))?\b/);
  const initialism = initialismMatch
    ? (initialismMatch[1] + initialismMatch[2] + (initialismMatch[3] || '')).toLowerCase()
    : '';
  if (initialism && initialism.length >= 2) {
    // Prevent false positives on 2-3 char initialisms (like "ab" matching inside "fabulous")
    // by requiring the handle to start with it or contain it as a distinct word
    if (
      cleanHandle === initialism ||
      cleanHandle.startsWith(initialism) ||
      allHandleWords.includes(initialism)
    ) {
      distinctiveBusinessTokens.push(initialism);
    }
  }

  const uniqueDistinctiveBusinessTokens = Array.from(new Set(distinctiveBusinessTokens));

  // Check Acronym Match (>= 3 chars)
  // Must match the business acronym either exactly or as the distinctive portion before/after generic tokens
  const isAcronymMatch =
    businessAcronym.length >= 3 &&
    (cleanHandle === businessAcronym ||
      allHandleWords.includes(businessAcronym) ||
      (cleanHandle.startsWith(businessAcronym) &&
        (cleanHandle === businessAcronym ||
          sortedGenericTokens.some((g) => cleanHandle === businessAcronym + g || cleanHandle === g + businessAcronym))));

  if (isAcronymMatch) {
    return {
      url,
      canonicalUrl,
      platform: plat,
      handle,
      profileType: 'business_page',
      owner: 'business',
      status: 'accepted',
      confidence: 0.9,
      rejectionReason: 'NONE',
      distinctiveTokensFound: [businessAcronym],
    };
  }

  // Exact normalized full-name handle match (Satungal sweep Class B structural path).
  // All-generic business names like "Chandragiri Party Palace" / "B&L Fitness Station"
  // have an empty distinctive set — equality on the normalized name still attaches
  // the correct page without requiring a distinctive-token majority.
  // Also try the brand segment so "Brand: Descriptor" titles match shortened handles.
  const normalizedBusinessName = (businessName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedBrandName = brandBusinessName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (
    normalizedBusinessName.length >= 4 &&
    (cleanHandle === normalizedBusinessName ||
      (normalizedBrandName.length >= 4 && cleanHandle === normalizedBrandName))
  ) {
    return {
      url,
      canonicalUrl,
      platform: plat,
      handle,
      profileType: 'business_page',
      owner: 'business',
      status: 'accepted',
      confidence: 1.0,
      rejectionReason: 'NONE',
      distinctiveTokensFound: fullBusinessTokens,
    };
  }

  // Check Distinctive Token Overlap
  const matchingDistinctive = uniqueDistinctiveBusinessTokens.filter(
    (token) =>
      cleanHandle.includes(token) ||
      allHandleWords.includes(token) ||
      distinctiveHandleTokens.some((dh) => dh === token || (dh.length >= 4 && token.length >= 4 && (dh.includes(token) || token.includes(dh))))
  );

  if (matchingDistinctive.length >= 1) {
    // Strict-majority overlap (mirrors website ranker requiredNameOverlap).
    // Single distinctive token still needs exactly 1 match; multi-token names
    // require a strict majority so partial generic-facade handles cannot attach.
    const requiredOverlap = requiredSocialNameOverlap(uniqueDistinctiveBusinessTokens.length);

    // Phase 8L Component 8 (D21 Initialism Corroboration Rule):
    // If the only matching distinctive tokens are short (<= 3 characters, e.g. "apf", "rs", "nk", "ab"),
    // an initialism alone is ambiguous. Require at least one corroborating signal:
    //  1. A category token from the vertical (e.g. "dental", "clinic" for dental; "salon", "parlour", "nail", "beauty" for beauty)
    //  2. Another distinctive business token with length >= 4
    const onlyShortTokens = matchingDistinctive.every((t) => t.length <= 3);
    if (onlyShortTokens) {
      const hasCategoryCorroboration = resolvedCategoryTokens.some((catToken) =>
        catToken.length >= 3 && (cleanHandle.includes(catToken) || allHandleWords.includes(catToken))
      );
      const hasLocationCorroboration = Array.from(NEPAL_LOCALITY_TOKENS).some((locToken) =>
        locToken.length >= 3 && (cleanHandle.includes(locToken) || allHandleWords.includes(locToken))
      );
      const hasLongDistinctiveOverlap = uniqueDistinctiveBusinessTokens.some(
        (bt) => bt.length >= 4 && (cleanHandle.includes(bt) || allHandleWords.includes(bt))
      );

      if (!hasCategoryCorroboration && !hasLocationCorroboration && !hasLongDistinctiveOverlap) {
        // Handle only has a short initialism without vertical or brand corroboration (e.g. "nepalapfhospital" for "Apf satugal" in Nail salon)
        if (distinctiveHandleTokens.length >= 1) {
          return {
            url,
            canonicalUrl,
            platform: plat,
            handle,
            profileType: 'business_page',
            owner: 'unknown',
            status: 'rejected',
            confidence: 0.9,
            rejectionReason: 'BUSINESS_NAME_MISMATCH',
            distinctiveTokensFound: [],
          };
        }
        return {
          url,
          canonicalUrl,
          platform: plat,
          handle,
          profileType: 'business_page',
          owner: 'unknown',
          status: 'unknown',
          confidence: 0.5,
          rejectionReason: 'INSUFFICIENT_EVIDENCE',
          distinctiveTokensFound: [],
        };
      }
    }

    if (matchingDistinctive.length < requiredOverlap) {
      if (distinctiveHandleTokens.length >= 1) {
        return {
          url,
          canonicalUrl,
          platform: plat,
          handle,
          profileType: 'business_page',
          owner: 'unknown',
          status: 'rejected',
          confidence: 0.9,
          rejectionReason: 'BUSINESS_NAME_MISMATCH',
          distinctiveTokensFound: matchingDistinctive,
        };
      }
      return {
        url,
        canonicalUrl,
        platform: plat,
        handle,
        profileType: 'business_page',
        owner: 'unknown',
        status: 'unknown',
        confidence: 0.5,
        rejectionReason: 'INSUFFICIENT_EVIDENCE',
        distinctiveTokensFound: matchingDistinctive,
      };
    }

    return {
      url,
      canonicalUrl,
      platform: plat,
      handle,
      profileType: 'business_page',
      owner: 'business',
      status: 'accepted',
      confidence: 1.0,
      rejectionReason: 'NONE',
      distinctiveTokensFound: matchingDistinctive,
    };
  }

  // If distinctive overlap is 0:
  // If handle contains distinctive non-generic brand tokens that do not match the business name:
  if (distinctiveHandleTokens.length >= 1) {
    return {
      url,
      canonicalUrl,
      platform: plat,
      handle,
      profileType: 'business_page',
      owner: 'unknown',
      status: 'rejected',
      confidence: 0.9,
      rejectionReason: 'BUSINESS_NAME_MISMATCH',
      distinctiveTokensFound: [],
    };
  }

  // Generic-only tokens, short acronym (<3 chars), or ambiguous without matching distinctive tokens:
  return {
    url,
    canonicalUrl,
    platform: plat,
    handle,
    profileType: 'business_page',
    owner: 'unknown',
    status: 'unknown',
    confidence: 0.5,
    rejectionReason: 'INSUFFICIENT_EVIDENCE',
    distinctiveTokensFound: [],
  };
}

/**
 * Validates social ownership using classifySocialProfile:
 * Returns true if status === 'accepted' when context is provided, or status !== 'rejected' when unconstrained.
 */
export function isBusinessOwnedSocialProfile(
  url: string,
  platform?: string,
  businessName?: string,
  websiteDomain?: string,
  categoryContext?: string | string[],
  origin?: 'website_evidence' | 'serp' | 'maps'
): boolean {
  const result = classifySocialProfile(url, platform, businessName, websiteDomain, categoryContext, origin);
  if (businessName || websiteDomain) {
    return result.status === 'accepted';
  }
  return result.status !== 'rejected';
}

/**
 * Classifies all candidate social URLs from raw page content into structured ClassifiedSocialProfile records.
 */
export function classifyAllSocialProfiles(
  content: string,
  context?: {
    businessName?: string;
    websiteDomain?: string;
    categoryContext?: string | string[];
    origin?: 'website_evidence' | 'serp' | 'maps';
  }
): ClassifiedSocialProfile[] {
  if (!content) return [];
  const structuredUrls = [
    ...extractUrlsFromMarkdown(content),
    ...extractUrlsFromHtml(content),
    ...liftBareHandles(content),
  ];
  const rawUrls = content.match(/https?:\/\/[^\s<>")\]]+/gi) || [];
  const combinedUrls = [...new Set([...structuredUrls, ...rawUrls].map(cleanTrailingPunctuation))];

  const seenUrls = new Set<string>();
  const classifiedProfiles: ClassifiedSocialProfile[] = [];

  for (const url of combinedUrls) {
    if (!url || seenUrls.has(url)) continue;
    const isSocial = /https?:\/\/(?:www\.)?(?:m\.)?(?:facebook\.com|instagram\.com|tiktok\.com|(?:x|twitter)\.com|youtube\.com|linkedin\.com)/i.test(url);
    if (!isSocial) continue;

    seenUrls.add(url);
    const classified = classifySocialProfile(
      url,
      undefined,
      context?.businessName,
      context?.websiteDomain,
      context?.categoryContext,
      context?.origin ?? 'website_evidence'
    );
    classifiedProfiles.push(classified);
  }

  return classifiedProfiles;
}

/**
 * Strips explicit developer/technology attribution from page content.
 * Conservative: preserves generic phrases like "Contact us by email" and "By appointment only".
 */
export function stripVendorAttribution(content: string): string {
  if (!content) return '';
  let cleaned = content;

  // 1. HTML comments & Meta tags FIRST:
  cleaned = cleaned.replace(/<!--\s*(?:powered|built|designed|developed)\s+by[^>]{0,60}-->/gi, ' ');
  cleaned = cleaned.replace(/<meta\s[^>]*name=["']author["'][^>]*>/gi, ' ');

  // 2. Explicit developer/technology attribution phrases with uppercase proper-noun:
  cleaned = cleaned.replace(/(?:[Ww]ebsite\s+)?(?:[Dd]eveloped|[Dd]esigned(?:\s+&\s+[Dd]eveloped)?)\s+by\s+[A-Z][A-Za-z0-9\s.&'-]{1,40}(?=\.|\n|$|<)/g, ' ');
  cleaned = cleaned.replace(/\b[Bb]uilt\s+by\s+[A-Z][A-Za-z0-9\s.&'-]{1,40}(?=\.|\n|$|<)/g, ' ');
  cleaned = cleaned.replace(/\b[Pp]owered\s+by\s+[A-Z][A-Za-z0-9\s.&'-]{1,40}(?=\.|\n|$|<)/g, ' ');
  cleaned = cleaned.replace(/\b[Bb]uilt\s+with\s+[A-Z][A-Za-z0-9\s.&'-]{1,40}(?=\.|\n|$|<)/g, ' ');
  cleaned = cleaned.replace(/\b[Cc]reated\s+with\s+[A-Z][A-Za-z0-9\s.&'-]{1,40}(?=\.|\n|$|<)/g, ' ');

  return cleaned.replace(/\s+/g, ' ').replace(/\s+\./g, '.').trim();
}

function stripHtmlTags(content: string): string {
  if (!content) return '';
  return content
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ');
}

/**
 * Decodes Cloudflare-protected email addresses (free-tier email obfuscation).
 *
 * Cloudflare encodes emails as a hex string where the first byte is an XOR key
 * and every subsequent byte XOR'd with it produces the email characters:
 *   <a href="/cdn-cgi/l/email-protection#HEX">…</a>
 *   <span class="__cf_email__" data-cfemail="HEX">…</span>
 *
 * Safety: hex must be even-length, must decode to printable ASCII, and the
 * result must contain '@'. Decoded values are NOT trusted directly — they flow
 * through the same validation/placeholder/dedupe funnel as plain-text emails.
 */
function decodeCloudflareEmail(content: string): string[] {
  if (!content) return [];
  const emails: string[] = [];
  const pattern = /(?:\/cdn-cgi\/l\/email-protection#|data-cfemail=")([a-f0-9]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const hex = match[1];
    if (hex.length < 4 || hex.length % 2 !== 0) continue;
    const key = parseInt(hex.slice(0, 2), 16);
    let decoded = '';
    let printable = true;
    for (let i = 2; i < hex.length; i += 2) {
      const charCode = parseInt(hex.slice(i, i + 2), 16) ^ key;
      if (charCode < 0x20 || charCode > 0x7e) {
        printable = false;
        break;
      }
      decoded += String.fromCharCode(charCode);
    }
    if (!printable || !decoded.includes('@')) continue;
    emails.push(decoded);
  }
  return emails;
}

/**
 * Decodes common human-written email obfuscations found on websites:
 *   Sales: info [at] company.com   -> info@company.com
 *   Support: sales(at)example.com  -> sales@example.com
 *   Contact: admin&#64;business.org -> admin@business.org
 *   Email: bookings at hotel.com   -> bookings@hotel.com
 *
 * Both sides must be email-shaped (local part + domain with a 2-letter TLD),
 * and the local part must follow a label-ish boundary (line start, colon,
 * newline or pipe) so ordinary prose like "reach the team at company.com"
 * cannot produce a bogus address.
 */
function decodeObfuscatedEmails(content: string): string[] {
  if (!content) return [];
  const emails: string[] = [];
  const markers = /(?:\[at\]|\(at\)|\{at\}|&#64;|&amp;#64;|\bat\b)/;
  const pattern = /(?:^|[:\n|;])\s*([a-zA-Z0-9._%+-]{2,64})\s*(?:\[at\]|\(at\)|\{at\}|&#64;|&amp;#64;|\bat\b)\s*([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const local = match[1];
    const domain = match[2];
    if (!local || !domain) continue;
    // Guard against self-capture around the marker (e.g. "[email protected]"
    // has no '@' and must never become "email@protected][email").
    if (markers.test(`${local}${domain}`)) continue;
    emails.push(`${local}@${domain}`);
  }
  return emails;
}

/**
 * Extracts emails directly from mailto: link attributes:
 *   <a href="mailto:info@nebuti.com">…</a>
 *   <a href="mailto:anil@nebuti.com?subject=Inquiry">…</a>
 *   [Email Us](mailto:sales@holidaystonepal.com)
 */
function extractMailtoEmails(content: string): string[] {
  if (!content) return [];
  const emails: string[] = [];
  const pattern = /(?:href=["']mailto:|mailto:)([^"'?#\s>]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    let raw = match[1];
    try {
      raw = decodeURIComponent(raw);
    } catch {}
    emails.push(raw);
  }
  return emails;
}

/**
 * Extracts unique non-placeholder email addresses from content.
 *
 * Cloudflare-masked, mailto: hrefs, and textually-obfuscated emails are
 * decoded FIRST (raw content, before tag-stripping) and merged into the SAME
 * validation funnel as plain-text emails — decoded output is never trusted by construction.
 */
export function extractEmails(content: string): string[] {
  if (!content) return [];

  const cloudflareEmails = decodeCloudflareEmail(content);
  const obfuscatedEmails = decodeObfuscatedEmails(content);
  const mailtoEmails = extractMailtoEmails(content);

  const text = stripHtmlTags(content);
  const found = text.match(EMAIL_REGEX) || [];

  const allEmails = [...cloudflareEmails, ...obfuscatedEmails, ...mailtoEmails, ...found];
  const unique = new Set<string>();
  for (let raw of allEmails) {
    let email = raw.trim();
    if (!email) continue;
    // Detach glued words from markdown before lowercasing (e.g. gmail.comOpening -> gmail.com)
    const gluedMatch = email.match(
      /^([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.(?:edu\.np|com\.np|org\.np|gov\.np|net\.np|mil\.np|com|org|net|edu|gov|io|co|np|biz|info))([A-Z].*)$/
    );
    if (gluedMatch) {
      email = gluedMatch[1];
    }
    email = sanitizeEmailString(email);
    if (!email) continue;
    if (PLACEHOLDER_EMAIL_PATTERNS.some((pattern) => pattern.test(email))) continue;
    // Task 5: Reject media filenames and DPR retina assets misparsed as emails
    if (MEDIA_FILENAME_PATTERN.test(email) || MEDIA_DPR_PATTERN.test(email)) continue;
    if (email.includes(' ') || !email.includes('@')) continue;
    if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?$/.test(email)) continue;

    // Reject emails whose final domain segment is a single character (e.g. .n)
    const emailDomain = email.split('@')[1]?.toLowerCase() ?? '';
    const tld = emailDomain.split('.').pop() ?? '';
    if (tld.length < 2) continue;

    // Phase 8g: Reject invalid / typo Nepal ccTLDs (e.g. .co.np is a typo for .com.np)
    if (emailDomain.endsWith('.co.np')) continue;

    // Task 5: Reject emails whose domain ends with an image/media file extension
    if (IMAGE_FILE_TLDS.has(tld)) continue;

    unique.add(email);
  }
  return [...unique];
}

// ══════════════════════════════════════════════════════════════════════════════
// Contact Ownership, Multi-Dimensional Channels & Semantic Classifiers (Task 3)
// ══════════════════════════════════════════════════════════════════════════════

export const PLATFORM_DOMAINS = new Set([
  'noshnepal.com', 'foodmandu.com', 'pathao.com', 'indrive.com',
  'daraz.com', 'daraz.com.np', 'tripadvisor.com', 'booking.com',
  'airbnb.com', 'wixpress.com', 'wordpress.com', 'blogspot.com',
]);

export const BUSINESS_EMAIL_PREFIXES = new Set([
  'info', 'contact', 'office', 'admin', 'support', 'sales', 'hello',
  'enquiry', 'inquiry', 'reception', 'booking', 'legal', 'hr', 'accounts',
  'billing', 'marketing', 'admission', 'frontdesk', 'reservation', 'help',
  'service', 'careers', 'jobs', 'press', 'pr', 'partners', 'media',
  'investors', 'security', 'lawyer', 'advocate', 'desk', 'query',
  'general', 'principal', 'headmaster', 'receptionist', 'services',
  'appointment', 'inquiries', 'mail',
]);

export const CONSUMER_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'live.com', 'protonmail.com', 'aol.com',
]);

/**
 * Extracts surrounding text context around a match in content.
 * Prioritizes the enclosing line/tag block, with a bounded window fallback (+-100 chars).
 */
export function extractContextAroundMatch(content: string, matchStr: string): string {
  if (!content || !matchStr) return '';
  const idx = content.indexOf(matchStr);
  if (idx === -1) return '';

  // Find enclosing line boundaries
  const prevNewline = content.lastIndexOf('\n', idx);
  const nextNewline = content.indexOf('\n', idx + matchStr.length);

  const lineStart = prevNewline === -1 ? 0 : prevNewline + 1;
  const lineEnd = nextNewline === -1 ? content.length : nextNewline;
  const line = content.slice(lineStart, lineEnd).trim();

  if (line.length >= matchStr.length + 10 && line.length <= 300) {
    return stripHtmlTags(line).replace(/\s+/g, ' ').trim();
  }

  const start = Math.max(0, idx - 100);
  const end = Math.min(content.length, idx + matchStr.length + 100);
  const snippet = content.slice(start, end);

  return stripHtmlTags(snippet).replace(/\s+/g, ' ').trim();
}

/**
 * Classifies an email address into functional role and ownership entity.
 */
export function classifyEmailRole(
  email: string,
  context: string = '',
  businessName?: string,
  websiteDomain?: string
): { role: ContactRole; owner: ContactOwner } {
  if (!email || !email.includes('@')) {
    return { role: 'unknown', owner: 'unknown' };
  }

  const parts = email.toLowerCase().trim().split('@');
  const prefix = parts[0];
  const domain = parts[1] || '';

  // 1. Platform domain check (allowlist + suffix match e.g. daraz.com, foodmandu.com)
  for (const plat of PLATFORM_DOMAINS) {
    if (domain === plat || domain.endsWith('.' + plat)) {
      return { role: 'unknown', owner: 'platform' };
    }
  }

  // 2. Known business prefixes -> primary_business, business
  if (BUSINESS_EMAIL_PREFIXES.has(prefix)) {
    return { role: 'primary_business', owner: 'business' };
  }

  // 3. First-party domain matching
  const isFirstPartyDomain = Boolean(
    websiteDomain &&
    (domain === websiteDomain.toLowerCase() ||
     domain.endsWith('.' + websiteDomain.toLowerCase()) ||
     websiteDomain.toLowerCase().endsWith('.' + domain))
  );

  // If on business domain and prefix matches brand name (e.g. narayani@narayanilawfirm.org.np)
  if (isFirstPartyDomain && businessName) {
    const brandTokens = businessName.toLowerCase().split(/[\s,.-]+/).filter((t) => t.length >= 3);
    if (brandTokens.some((token) => prefix.includes(token))) {
      return { role: 'primary_business', owner: 'business' };
    }
  }

  // 4. Consumer provider personal signal: domain is consumer provider AND prefix looks personal
  if (CONSUMER_EMAIL_DOMAINS.has(domain)) {
    // Phase 8k CONTACT-06: If consumer email prefix matches >= 2 brand name tokens, classify as business
    // (e.g. gurjudhara.dentalcare@gmail.com matches 'gurjudhara' and 'dental' from brand)
    if (businessName) {
      const brandTokens = businessName.toLowerCase().split(/[\s,.-]+/).filter((t) => t.length >= 3);
      const matchCount = brandTokens.filter((token) => prefix.includes(token)).length;
      if (matchCount >= 2) {
        return { role: 'primary_business', owner: 'business' };
      }
      // Single-token match with no digits/dots in prefix is still a business signal
      if (matchCount >= 1 && !/\d/.test(prefix) && !prefix.includes('_')) {
        return { role: 'primary_business', owner: 'business' };
      }
    }
    // Personal signal: digits, dots, or underscores in prefix strongly indicate personal email
    if (/\d/.test(prefix) || prefix.includes('.') || prefix.includes('_')) {
      return { role: 'staff_person', owner: 'person' };
    }
  }

  const lowerContext = context.toLowerCase();

  // Phase 8k Component 4 (CONTACT-06): Schema-aware & structured metadata email classification
  if (
    lowerContext.includes('schema.org') ||
    lowerContext.includes('jsonld') ||
    lowerContext.includes('json-ld') ||
    lowerContext.includes('@type')
  ) {
    if (/\b(person|physician|employee|author|founder|member)\b/i.test(lowerContext)) {
      return { role: 'staff_person', owner: 'person' };
    }
    if (
      /\b(localbusiness|organization|dentist|medicalbusiness|hospital|clinic|store|corporation|educationalorganization)\b/i.test(
        lowerContext
      )
    ) {
      return { role: 'primary_business', owner: 'business' };
    }
  }

  // 5. Personal honorifics / markers in context: "Dr.", "Mr.", "Mrs.", "Director", etc.
  if (/\b(dr\.|dr\s|mr\.|mrs\.|ms\.|prof\.|director|founder|doctor|owner:)/i.test(lowerContext)) {
    return { role: 'staff_person', owner: 'person' };
  }

  // Initialism / Acronym matching (e.g. KDCH / kdchktm for Kantipur Dental College Hospital)
  if (businessName) {
    const rawTokens = businessName.toLowerCase().split(/[\s,.-]+/).filter(Boolean);
    const nonStopTokens = rawTokens.filter((t) => !['and', 'the', 'of', 'in', '&'].includes(t));
    const fullAcronym = rawTokens.map((t) => t[0]).join('');
    const shortAcronym = nonStopTokens.map((t) => t[0]).join('');
    const cleanPrefix = prefix.replace(/[^a-z]/g, '');

    if (
      (shortAcronym.length >= 3 && cleanPrefix.startsWith(shortAcronym)) ||
      (fullAcronym.length >= 3 && cleanPrefix.startsWith(fullAcronym)) ||
      (shortAcronym.length >= 3 && cleanPrefix.includes(shortAcronym))
    ) {
      return { role: 'primary_business', owner: 'business' };
    }
  }

  // 6. Personal name pattern in prefix: e.g. "first.last" on business domain
  if (prefix.includes('.') || prefix.includes('_')) {
    return { role: 'staff_person', owner: 'person' };
  }

  // 7. If on first-party domain and no personal markers -> primary_business, business
  if (isFirstPartyDomain) {
    return { role: 'primary_business', owner: 'business' };
  }

  // Conservative fallback: unknown, unknown (never guess staff_person)
  return { role: 'unknown', owner: 'unknown' };
}

export type PageType = 'homepage' | 'contact' | 'about' | 'team' | 'services' | 'other';

/**
 * Classifies a URL into a page type based on pathname heuristics.
 */
export function classifyPageType(url?: string, pageTitle?: string): PageType {
  if (!url) return 'other';
  try {
    const raw = url.startsWith('http') ? url : `https://${url}`;
    const parsed = new URL(raw);
    const path = parsed.pathname.toLowerCase().replace(/\/+$/, '');

    // Homepage: root, index.html, index.php, /home
    if (path === '' || path === '/' || path === '/index.html' || path === '/index.php' || path === '/home') {
      return 'homepage';
    }

    // Contact: contact, contact-us, reach-us, get-in-touch, get-a-quote, location
    if (/\b(contact|contact-us|reach-us|get-in-touch|get-a-quote|contactus|location|branches)\b/i.test(path)) {
      return 'contact';
    }

    // Team: team, our-team, leadership, board, management, staff, members
    if (/\b(team|our-team|leadership|board|management|staff|members)\b/i.test(path)) {
      return 'team';
    }

    // About: about, about-us, who-we-are, company, profile
    if (/\b(about|about-us|who-we-are|company|profile)\b/i.test(path)) {
      return 'about';
    }

    // Services: service, services, our-services
    if (/\b(service|services|our-services)\b/i.test(path)) {
      return 'services';
    }

    return 'other';
  } catch {
    return 'other';
  }
}

export const OWNER_LEADERSHIP_TITLES = [
  'owner',
  'founder',
  'co-founder',
  'proprietor',
  'managing director',
  'ceo',
  'chairman',
  'chairperson',
  'president',
  'principal',
  'managing partner',
  'senior partner',
  'partner',
  'head of legal',
  'medical director',
];

export const STAFF_TITLES = [
  'supervisor',
  'housekeeping supervisor',
  'manager',
  'executive',
  'field marketing executive',
  'officer',
  'coordinator',
  'accountant',
  'front desk',
  'receptionist',
  'maid',
  'cleaner',
  'designer',
  'graphic designer',
  'graphic design',
  'web design',
  'design',
  'developer',
  'technician',
  'operator',
  'sales head',
  'head',
  // Legal, Medical & Academic roles (Phase 8i)
  'advocate',
  'senior advocate',
  'attorney',
  'lawyer',
  'associate',
  'counsel',
  'legal advisor',
  'physician',
  'doctor',
  'specialist',
  'teacher',
  'faculty',
  'professor',
  'lecturer',
];

export interface ContactSignalSnapshot {
  hasMapsSignal: boolean;
  hasPageCtaSignal: boolean;
  hasGeneralContactSignal: boolean;
  hasOwnerLeadershipSignal: boolean;
  hasStaffSignal: boolean;
  hasBranchSignal: boolean;
  hasPlatformSignal: boolean;
  pageTypesSeen: Set<PageType>;
}

/**
 * Evaluates the 9-Row Role Decision Matrix against accumulated contact signals.
 */
export function evaluateContactRoleMatrix(s: ContactSignalSnapshot): {
  role: ContactRole;
  owner: ContactOwner;
} {
  // Row 1 & 2: Maps phone is the absolute identity authority -> primary_business
  if (s.hasMapsSignal) {
    return { role: 'primary_business', owner: 'business' };
  }

  // Row 8: Branch signal -> branch_contact
  if (s.hasBranchSignal) {
    return { role: 'branch_contact', owner: 'branch' };
  }

  // Platform number -> unknown, platform
  if (s.hasPlatformSignal) {
    return { role: 'unknown', owner: 'platform' };
  }

  const isHomepageOrContact = s.pageTypesSeen.has('homepage') || s.pageTypesSeen.has('contact');
  const isAboutOrTeam = s.pageTypesSeen.has('about') || s.pageTypesSeen.has('team');

  // Row 3: Prominent Business CTA on Homepage / Contact page -> primary_business
  // (Homepage CTA elevates the number to primary_business even if it also appears as staff on team page)
  if (isHomepageOrContact && s.hasPageCtaSignal) {
    return { role: 'primary_business', owner: 'business' };
  }

  // Standalone CTA with no team page association
  if (s.hasPageCtaSignal && !s.hasStaffSignal && !isAboutOrTeam) {
    return { role: 'primary_business', owner: 'business' };
  }

  // Row 5: Homepage or Contact page sighting without staff signals -> primary_business
  if (isHomepageOrContact && !s.hasStaffSignal) {
    return { role: 'primary_business', owner: 'business' };
  }

  // Row 6 & 7: About or team page profiles without Homepage CTA -> staff_person
  if (isAboutOrTeam && (s.hasOwnerLeadershipSignal || s.hasStaffSignal)) {
    return { role: 'staff_person', owner: 'person' };
  }

  // Row 4: Staff title without Homepage CTA -> staff_person
  if (s.hasStaffSignal) {
    return { role: 'staff_person', owner: 'person' };
  }

  // Row 9: No CTA / bare text / blog -> unknown, unknown
  return { role: 'unknown', owner: 'unknown' };
}

export interface PhoneRoleClassificationResult {
  role: ContactRole;
  owner: ContactOwner;
  channels: ContactChannel[];
  associatedPerson?: string;
  associatedJobTitle?: string;
  hasMapsSignal?: boolean;
  hasPageCtaSignal?: boolean;
  hasGeneralContactSignal?: boolean;
  hasOwnerLeadershipSignal?: boolean;
  hasStaffSignal?: boolean;
  hasBranchSignal?: boolean;
  hasPlatformSignal?: boolean;
}

/**
 * Classifies a phone number into functional role, ownership entity, communication channels,
 * and associated person metadata based on context, URL, and signal aggregation.
 */
export function classifyPhoneRole(
  phone: string,
  context: string = '',
  businessName?: string,
  classifiedPhone?: ClassifiedPhone,
  pageUrl?: string,
  isMapsPhone?: boolean
): PhoneRoleClassificationResult {
  const lowerContext = context.toLowerCase();
  const channels: ContactChannel[] = ['call'];

  // Channels detection
  if (lowerContext.includes('whatsapp') || lowerContext.includes('wa.me') || lowerContext.includes('wa/')) {
    channels.push('whatsapp');
  }
  if (lowerContext.includes('viber')) {
    channels.push('viber');
  }

  const pageType = classifyPageType(pageUrl);

  // 1. Channel / CTA Signals
  const hasPageCtaSignal =
    /\b(call now|call us|emergency service|emergency|direct contact|fast service|toll free|customer care|hotline|get a quote|need clean|book now|talk to us|phone:|chat with us|whatsapp|viber|call|order|orders|delivery)\b/i.test(
      lowerContext
    ) || /\[(?:call|phone|tel|emergency|hotline|now|quote)[^\]]*\]\(tel:/i.test(context);

  const hasGeneralContactSignal =
    pageType === 'contact' ||
    /\b(head office|main office|central office|contact us|email us)\b/i.test(lowerContext);

  // 2. Branch Signals
  const lowerBizName = (businessName || '').toLowerCase().trim();
  const lowerCtxTrim = lowerContext.trim();
  let hasBranchKeyword = /\b(branch|branches|outlet|outlets|our branches)\b/i.test(lowerContext);

  // Phase 8O (D40): If branch keyword is part of businessName itself (e.g. "Shrestha Brothers Furniture Satungal Outlet"),
  // self-context must NOT trigger a branch signal.
  if (hasBranchKeyword && lowerBizName) {
    const branchWordInBiz = ['outlet', 'outlets', 'branch', 'branches', 'center', 'centre', 'showroom'].some((w) => lowerBizName.includes(w));
    if (branchWordInBiz && (lowerCtxTrim === lowerBizName || lowerBizName.includes(lowerCtxTrim) || lowerCtxTrim.includes(lowerBizName))) {
      hasBranchKeyword = false;
    }
  }

  const hasLocationCues = /\b(clinic|center|centre|office|outlet)\b/i.test(lowerContext);
  const hasLocalities = /\b(chabahil|naikap|bardibas|banasthali|chapagaun|jawalakhel|koteshwor|kumaripati|pokhara|biratnagar|birgunj|dharan|hetauda|nepalgunj|butwal)\b/i.test(lowerContext);
  const hasAddressCues = /\b(chowk|marga|street|road|ward|tole)\b/i.test(lowerContext);
  const hasBranchSignal = hasBranchKeyword || (hasLocationCues && hasLocalities) || (hasLocalities && hasAddressCues);

  // 3. Person / Title Signals
  let hasOwnerLeadershipSignal = false;
  let hasStaffSignal = false;
  let associatedPerson: string | undefined;
  let associatedJobTitle: string | undefined;

  for (const title of OWNER_LEADERSHIP_TITLES) {
    if (new RegExp(`\\b${title}\\b`, 'i').test(lowerContext)) {
      hasOwnerLeadershipSignal = true;
      associatedJobTitle = title;
      break;
    }
  }

  for (const title of STAFF_TITLES) {
    if (new RegExp(`\\b${title}\\b`, 'i').test(lowerContext)) {
      hasStaffSignal = true;
      if (!associatedJobTitle) associatedJobTitle = title;
      break;
    }
  }

  if (/\b(dr\.|dr\s|mr\.|mrs\.|ms\.|prof\.)\b/i.test(lowerContext)) {
    hasStaffSignal = true;
  }

  // Extract person name if present in markdown team cues or direct contact cues
  const NON_PERSON_WORDS = new Set([
    'and', 'or', 'the', 'of', 'in', 'at', 'on', 'for', 'to', 'with', 'from', 'by',
    'hours', 'hour', 'here', 'start', 'gap', 'direction', 'directions', 'ions',
    'open', 'close', 'closed', 'opening', 'closing', 'time', 'timing', 'timings',
    'appointment', 'appointments', 'day', 'days', 'week', 'month', 'year',
    'location', 'locations', 'details', 'detail', 'info', 'information', 'about',
    'service', 'services', 'clinic', 'hospital', 'center', 'centre', 'branch',
    'home', 'page', 'site', 'website', 'call', 'contact', 'email', 'phone', 'mobile'
  ]);

  const personMatch =
    context.match(/(?:###|\*\*|##)?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:Chairman|Managing Director|Director|Supervisor|Marketing|Front Desk|Design|Executive|Head|Manager|Cleaner|Maid|Technician|Owner|Founder|Advocate|Lawyer|Attorney|Doctor|Principal|Partner)\b/i) ||
    context.match(/\b(?:call|contact|emergency|direct|attorney|lawyer|advocate|dr|mr|mrs|ms|shree)\b\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i) ||
    context.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*[-:]\s*(?:\+?[\d\s-]{7,})/);
  if (personMatch) {
    const candidate = personMatch[1].trim();
    const candidateTokens = candidate.toLowerCase().split(/\s+/).filter(Boolean);
    const hasNonPersonWord = candidateTokens.some((t) => NON_PERSON_WORDS.has(t));
    const isGarbage =
      hasNonPersonWord ||
      candidateTokens.length < 2 ||
      SCHEDULE_GARBAGE_PATTERNS.some((pat) => pat.test(candidate));
    if (!isGarbage) {
      associatedPerson = candidate;
    }
  }

  const hasMapsSignal = Boolean(isMapsPhone);
  const hasPlatformSignal = false;

  const decision = evaluateContactRoleMatrix({
    hasMapsSignal,
    hasPageCtaSignal,
    hasGeneralContactSignal,
    hasOwnerLeadershipSignal,
    hasStaffSignal,
    hasBranchSignal,
    hasPlatformSignal,
    pageTypesSeen: new Set([pageType]),
  });

  return {
    role: decision.role,
    owner: decision.owner,
    channels,
    associatedPerson,
    associatedJobTitle,
    hasMapsSignal,
    hasPageCtaSignal,
    hasGeneralContactSignal,
    hasOwnerLeadershipSignal,
    hasStaffSignal,
    hasBranchSignal,
    hasPlatformSignal,
  };
}

/**
 * Phase 8i (Group E / W3-10): Multi-signal demo / template fingerprint detector.
 * Identifies WordPress/theme dummy content (e.g. "Apollo Creed", "@ourschool.edu", "+1 6335 xxxx")
 * based on co-occurrence of 2 or more template signals.
 */
export function detectTemplateContent(text: string, contextUrl?: string): boolean {
  if (!text) return false;
  let signals = 0;

  // Signal 1: Dummy / celebrity placeholder names in staff / leadership sections
  if (/\b(apollo\s+creed|john\s+doe|jane\s+doe|lorem\s+ipsum|themeforest|envato|templatemonster)\b/i.test(text)) {
    signals++;
  }

  // Signal 2: Template / demo email pattern occurrences
  if (/\b[a-zA-Z0-9._%+-]+@(?:ourschool|myschool|yourschool|demomail|demotheme|template|dummy)\.(?:edu|com|org|net)\b/i.test(text)) {
    signals++;
  }

  // Signal 3: Dummy / template phone format (e.g. +1 6335..., 1234567890, +1 234 567 890, 0123456789)
  if (/(?:\+1[-.\s]?6335\d{3,6}|\+1[-.\s]?234[-.\s]?567[-.\s]?890|\+44[-.\s]?1234[-.\s]?567890|\b1234567890\b|\b0123456789\b)/i.test(text)) {
    signals++;
  }

  // Signal 4: Demo placeholder address / domain indicators
  if (/\b(?:123\s+(?:fake|main|sample)\s+street|your\s+company\s+address|domain\.com|yourdomain\.com)\b/i.test(text)) {
    signals++;
  }

  if (signals >= 2) {
    incrementTelemetry('templateFingerprintMatches');
    return true;
  }
  return false;
}

/**
 * Removes known non-business-contact contexts that produce phone-shaped noise:
 * image URLs/timestamps, media/file paths, http(s) links, date strings and
 * clock timestamps.
 *
 * WhatsApp/wa.me deep-link phones live inside https URLs and are PRESERVED
 * (collected before stripping, then spliced back). tel:/callto: hrefs survive
 * directly — only https?:// URLs are removed — so their numbers need no
 * special handling here.
 */
function stripNoiseContexts(content: string): string {
  if (!content) return '';

  // 1. Preserve phones hidden inside link hrefs BEFORE any stripping.
  const preservedPhones: string[] = [];
  TEL_PROTECT_REGEX.lastIndex = 0;
  let telMatch: RegExpExecArray | null;
  while ((telMatch = TEL_PROTECT_REGEX.exec(content)) !== null) {
    let raw = (telMatch[1] || telMatch[2] || '').trim();
    if (!raw) continue;
    try {
      raw = decodeURIComponent(raw);
    } catch {}
    raw = cleanTrailingPunctuation(raw);
    if (!raw) continue;
    // Normalize to a +-prefixed token so the phone regexes can re-match it.
    preservedPhones.push(raw.startsWith('+') ? raw : `+${raw}`);
  }
  const safeguarded = preservedPhones.length > 0 ? ` ${preservedPhones.join(' ')} ` : '';

  let cleaned = content;

  // 2. Markdown images ![alt](url) and <img> tags.
  cleaned = cleaned.replace(/!\[[^\]]*\]\([^)]+\)/gi, ' ');
  cleaned = cleaned.replace(/<img\b[^>]*>/gi, ' ');

  // 3. http(s) URLs (anchor text around them is kept).
  cleaned = cleaned.replace(/https?:\/\/[^\s<>")\]]+/gi, ' ');

  // 4. Media/document file paths (kills "31012024173722lk.png" style timestamps and binary media).
  cleaned = cleaned.replace(
    /\/?[\w.-]+\.(png|jpe?g|gif|svg|webp|pdf|docx?|xlsx?|zip|rar|mp4|webm|avi|mov|mkv|mp3|wav|ogg|tar|gz)/gi,
    ' '
  );

  // 5. Date shapes WITH separators: YYYY-MM-DD, YYYY/MM/DD, DD-MM-YYYY.
  //    Deliberately NOT stripping contiguous runs (YYYYMMDD): bare digit runs
  //    must survive for Nepal landlines (01-4240520) and mobiles (982-9469962),
  //    and with strict validation a contiguous run can never become a phone.
  cleaned = cleaned.replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, ' ');
  cleaned = cleaned.replace(/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, ' ');

  // 6. Clock timestamps HH:MM(:SS) — Nepal phones never contain colons.
  cleaned = cleaned.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ');

  return `${cleaned}${safeguarded}`;
}

/**
 * Expands slash-delimited EPABX hunting-line extensions:
 *   e.g. "01-5363501/511/560" -> ["01-5363501", "01-5363511", "01-5363560"]
 *   e.g. "+977 1 5363501/511/560" -> ["+977 1 5363501", "+977 1 5363511", "+977 1 5363560"]
 *
 * Guardrail (Reviewer Amendment): Only expands when the base number establishes a shared Kathmandu landline prefix
 * (starts with 1 or 01, followed by 7-digit subscriber number starting with 2-6).
 * Arbitrary strings without shared prefixes (e.g. "9851234567/568") are STRICTLY NOT expanded.
 */
export function expandSlashExtensions(rawText: string): string[] {
  if (!rawText || !rawText.includes('/')) return [];

  const pattern = /(?:(?:\+?977[-\s]?)?(?:0?1[-\s]?)?[2-6]\d{6}(?:\s*\/\s*\d{2,7})+)/g;
  const results: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rawText)) !== null) {
    const fullMatch = match[0];
    const parts = fullMatch.split('/').map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;

    const baseRaw = parts[0];
    const baseCleanDigits = baseRaw.replace(/\D/g, '');
    if (baseCleanDigits.length < 7) continue;

    const baseSubscriber = baseCleanDigits.slice(-7);
    const prefix = baseRaw.slice(0, baseRaw.length - 7);

    const baseClassified = classifyNepalPhone(baseRaw);
    if (baseClassified.type === 'landline') {
      results.push(baseRaw);
    }

    for (let i = 1; i < parts.length; i++) {
      const ext = parts[i];
      if (!/^\d+$/.test(ext)) continue;

      let candidateSubscriber = '';
      if (ext.length === 7) {
        candidateSubscriber = ext;
      } else if (ext.length >= 2 && ext.length <= 4) {
        candidateSubscriber = baseSubscriber.slice(0, 7 - ext.length) + ext;
      } else {
        continue;
      }

      const candidate = `${prefix}${candidateSubscriber}`;
      const classified = classifyNepalPhone(candidate);
      if (classified.type === 'landline') {
        results.push(candidate);
      }
    }
  }

  return results;
}

/**
 * Extracts Nepal landline/mobile phone numbers (display form preserved) with
 * deduplication by normalized digits.
 *
 * Enforces strict mathematical invariants via classifyNepalPhone:
 * - Nepal mobiles (98/97 x10, not 977)
 * - Nepal landlines (exact 8 normalized digits starting with 1)
 * - International numbers (starts with '+', balanced parentheses, 8-15 digits)
 * - All fragments (including 7-digit runs like 977 1532074) are strictly discarded as invalid.
 */
export function extractPhones(content: string): string[] {
  if (!content) return [];

  const cleaned = stripNoiseContexts(content);
  const text = stripHtmlTags(cleaned);
  const internationalRaw = text.match(INTERNATIONAL_REGEX) || [];
  const foundRaw = text.match(LANDLINE_OR_MOBILE_REGEX) || [];
  const slashExpanded = expandSlashExtensions(cleaned);
  const international = internationalRaw.map((raw) => sanitizePhoneString(raw)).filter(Boolean);
  const found = [...foundRaw, ...slashExpanded].map((raw) => sanitizePhoneString(raw)).filter(Boolean);

  // International provenance analysis (v1.3 fragment guard):
  //   intlRuns      — accepted international digit runs.
  //   nepalOwned    — runs that THEMSELVES classify as Nepal landline/mobile
  //                   (country-coded, e.g. "+977-1-4240520"): their inner
  //                   Nepal-form matches are legit duplicates of the SAME
  //                   number and must be kept (deduped by digits).
  //   foreignRuns   — runs classified 'international' (e.g. "+1 301 322 1427"):
  //                   inner Nepal-form matches are spurious fragments
  //                   ("013221427" inside the US tel: number) and discarded.
  const intlRuns = international
    .filter((p) => classifyNepalPhone(p).type !== 'invalid')
    .map((p) => ({ run: p.replace(/\D/g, ''), cls: classifyNepalPhone(p) }));
  const foreignRuns = intlRuns.filter(({ cls }) => cls.type === 'international').map(({ run }) => run);
  const nepalOwnedDigits = new Set(
    intlRuns
      .filter(({ cls }) => cls.type === 'landline' || cls.type === 'mobile')
      .map(({ cls }) => cls.digits)
  );

  const byDigits = new Map<string, string>();
  // International candidates first — full provenance, never fragment-guarded.
  for (const candidate of international) {
    const classified = classifyNepalPhone(candidate);
    if (classified.type === 'invalid') continue;
    if (!byDigits.has(classified.digits)) byDigits.set(classified.digits, candidate);
  }
  // Nepal-form candidates — fragment-guarded against FOREIGN intl runs.
  for (const candidate of found) {
    const classified = classifyNepalPhone(candidate);
    if (classified.type === 'invalid') continue;
    if (byDigits.has(classified.digits)) continue; // covered by a trusted form
    if (classified.type === 'landline' || classified.type === 'mobile') {
      const isFragmentOfForeignNumber =
        !nepalOwnedDigits.has(classified.digits) &&
        foreignRuns.some((run) => run.includes(classified.digits));
      if (isFragmentOfForeignNumber) continue;
    }
    byDigits.set(classified.digits, candidate);
  }
  return [...byDigits.values()];
}

/**
 * Extracts Nepal mobile numbers (98X / 97X) separately, deduped by digits.
 * A Nepal mobile must be exactly 10 digits starting with 97 or 98 (never 977).
 * Fragments and landlines are strictly excluded.
 */
export function extractMobiles(content: string): string[] {
  if (!content) return [];
  const cleaned = stripNoiseContexts(content);
  const text = stripHtmlTags(cleaned);
  const found = text.match(MOBILE_REGEX) || [];
  const byDigits = new Map<string, string>();
  for (const raw of found) {
    const candidate = sanitizePhoneString(raw);
    const classified = classifyNepalPhone(candidate);
    if (classified.type !== 'mobile') continue;
    if (!byDigits.has(classified.digits)) {
      byDigits.set(classified.digits, candidate);
    }
  }
  return [...byDigits.values()];
}

/**
 * Extracts Nepal landline numbers (01 area code, Kathmandu) separately,
 * deduped by normalized digits (exactly 8, leading '1').
 * Incomplete 7-digit fragments are strictly discarded.
 */
export function extractLandlines(content: string): string[] {
  if (!content) return [];
  const cleaned = stripNoiseContexts(content);
  const text = stripHtmlTags(cleaned);
  const found = text.match(NEPAL_LANDLINE_REGEX) || [];
  const slashExpanded = expandSlashExtensions(cleaned);
  const allCandidates = [...found, ...slashExpanded];

  // Fragment provenance guard (v1.3): a Nepal landline shape found INSIDE a
  // FOREIGN international run (e.g. "013221427" inside a US "+1 301 322 1427"
  // tel: href) is a spurious inner match, never a Kathmandu number. Runs that
  // THEMSELVES classify as Nepal numbers (e.g. "+977-1-4522833") OWN their
  // inner landline forms — those are legit and always kept.
  const intlRuns = (text.match(INTERNATIONAL_REGEX) || [])
    .map((raw) => sanitizePhoneString(raw))
    .filter((p) => classifyNepalPhone(p).type !== 'invalid')
    .map((p) => ({ run: p.replace(/\D/g, ''), cls: classifyNepalPhone(p) }));
  const foreignRuns = intlRuns.filter(({ cls }) => cls.type === 'international').map(({ run }) => run);
  const nepalOwnedDigits = new Set(
    intlRuns
      .filter(({ cls }) => cls.type === 'landline' || cls.type === 'mobile')
      .map(({ cls }) => cls.digits)
  );

  const byDigits = new Map<string, string>();
  for (const raw of allCandidates) {
    const candidate = sanitizePhoneString(raw);
    const classified = classifyNepalPhone(candidate);
    if (classified.type !== 'landline') continue;
    const isFragmentOfForeignNumber =
      !nepalOwnedDigits.has(classified.digits) &&
      foreignRuns.some((run) => run.includes(classified.digits));
    if (isFragmentOfForeignNumber) continue;
    if (!byDigits.has(classified.digits)) {
      byDigits.set(classified.digits, candidate);
    }
  }
  return [...byDigits.values()];
}

/**
 * Extracts verified landline numbers and verified non-mobile international numbers ONLY.
 * Invariant: extractLandlinesAndIntl(content) ∩ extractMobiles(content) = ∅.
 */
export function extractLandlinesAndIntl(content: string): string[] {
  if (!content) return [];
  const landlines = extractLandlines(content);

  const cleaned = stripNoiseContexts(content);
  const text = stripHtmlTags(cleaned);
  const internationalRaw = text.match(INTERNATIONAL_REGEX) || [];
  const international = internationalRaw.map((raw) => sanitizePhoneString(raw)).filter(Boolean);

  const byDigits = new Map<string, string>();
  for (const l of landlines) {
    const classified = classifyNepalPhone(l);
    if (classified.type === 'landline' && !byDigits.has(classified.digits)) {
      byDigits.set(classified.digits, l);
    }
  }

  for (const intl of international) {
    const classified = classifyNepalPhone(intl);
    // Only verified non-mobile international numbers:
    if (classified.type === 'international' && !byDigits.has(classified.digits)) {
      byDigits.set(classified.digits, intl);
    }
  }

  return [...byDigits.values()];
}
const BARE_HANDLE_REGEX = /\b(facebook|instagram|tiktok)\s*[:\-–—]?\s*@([a-zA-Z0-9._-]{2,30})/gi;

/**
 * Harvests absolute http(s) URLs from markdown [text](href) pairs.
 * Relative, fragment, mailto: and tel: destinations are skipped.
 */
function extractUrlsFromMarkdown(content: string): string[] {
  if (!content) return [];
  const urls: string[] = [];
  const regex = /\[[^\]]*\]\(([^)]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const url = match[1].trim();
    if (!url) continue;
    if (url.startsWith('#') || url.startsWith('/') || url.startsWith('mailto:') || url.startsWith('tel:')) continue;
    urls.push(url);
  }
  return urls;
}

/**
 * Lifts contextual bare handles ("Instagram: @handle") into canonical profile
 * URLs. Free-standing "@handle" references are ignored — too ambiguous to be
 * evidence on their own.
 */
function liftBareHandles(content: string): string[] {
  if (!content) return [];
  const urls: string[] = [];
  BARE_HANDLE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_HANDLE_REGEX.exec(content)) !== null) {
    const platform = match[1].toLowerCase();
    const handle = match[2];
    if (platform === 'facebook') urls.push(`https://facebook.com/${handle}`);
    else if (platform === 'instagram') urls.push(`https://instagram.com/${handle}`);
    else if (platform === 'tiktok') urls.push(`https://tiktok.com/@${handle}`);
  }
  return urls;
}

/**
 * Harvests absolute http(s) URLs from HTML href attributes:
 *   <a href="https://facebook.com/company">…</a>
 */
function extractUrlsFromHtml(content: string): string[] {
  if (!content) return [];
  const urls: string[] = [];
  const regex = /href=["'](https?:\/\/[^"'\s>]+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

export interface ExtractedSocialLinks {
  facebook: string;
  instagram: string;
  tiktok: string;
  other: Record<string, string>;
}

/**
 * Extracts social profile URLs found directly on the official website content.
 * Handles markdown links, HTML href attributes, bare contextual handles, and plain http(s) URLs.
 * Validates social ownership using isBusinessOwnedSocialProfile.
 */
export function extractSocialLinks(
  content: string,
  context?: { businessName?: string; websiteDomain?: string }
): ExtractedSocialLinks {
  const empty = { facebook: '', instagram: '', tiktok: '', other: {} };
  if (!content) return empty;

  const structuredUrls = [
    ...extractUrlsFromMarkdown(content),
    ...extractUrlsFromHtml(content),
    ...liftBareHandles(content),
  ];
  const rawUrls = content.match(/https?:\/\/[^\s<>")\]]+/gi) || [];
  const combinedContent = [...structuredUrls, ...rawUrls].join('\n');

  const fbMatches = combinedContent.match(new RegExp(FACEBOOK_REGEX.source, 'gi')) || [];
  const igMatches = combinedContent.match(new RegExp(INSTAGRAM_REGEX.source, 'gi')) || [];
  const ttMatches = combinedContent.match(new RegExp(TIKTOK_REGEX.source, 'gi')) || [];
  const xMatches = combinedContent.match(new RegExp(X_TWITTER_REGEX.source, 'gi')) || [];
  const ytMatches = combinedContent.match(new RegExp(YOUTUBE_REGEX.source, 'gi')) || [];
  const liMatches = combinedContent.match(new RegExp(LINKEDIN_REGEX.source, 'gi')) || [];

  const bName = context?.businessName;
  const wDomain = context?.websiteDomain;

  const rawFacebook = fbMatches.map(cleanTrailingPunctuation).find((u) => isBusinessOwnedSocialProfile(u, 'facebook', bName, wDomain)) || '';
  const rawInstagram = igMatches.map(cleanTrailingPunctuation).find((u) => isBusinessOwnedSocialProfile(u, 'instagram', bName, wDomain)) || '';
  const rawTiktok = ttMatches.map(cleanTrailingPunctuation).find((u) => isBusinessOwnedSocialProfile(u, 'tiktok', bName, wDomain)) || '';

  const other: Record<string, string> = {};
  const xTwitter = xMatches.map(cleanTrailingPunctuation).find((u) => isBusinessOwnedSocialProfile(u, 'twitter', bName, wDomain));
  const youtube = ytMatches.map(cleanTrailingPunctuation).find((u) => isBusinessOwnedSocialProfile(u, 'youtube', bName, wDomain));
  const linkedin = liMatches.map(cleanTrailingPunctuation).find((u) => isBusinessOwnedSocialProfile(u, 'linkedin', bName, wDomain));
  if (xTwitter) other.x = xTwitter;
  if (youtube) other.youtube = youtube;
  if (linkedin) other.linkedin = linkedin;

  return {
    facebook: rawFacebook,
    instagram: rawInstagram,
    tiktok: rawTiktok,
    other,
  };
}

/**
 * Extracts a favicon URL from raw HTML <link rel="icon" ...> or <link rel="shortcut icon" ...>
 */
export function extractFaviconFromHtml(baseUrl: string, html: string): string | undefined {
  if (!html) return undefined;
  const match =
    html.match(/<link\b[^>]*\brel=["'](?:shortcut )?icon["'][^>]*\bhref=["']([^"']+)["']/i) ||
    html.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["'](?:shortcut )?icon["']/i);
  if (match && match[1]) {
    try {
      return new URL(match[1], baseUrl).href;
    } catch {
      return match[1];
    }
  }
  return undefined;
}

/**
 * Selects the first non-empty favicon across the successfully extracted pages.
 */
export function extractFavicon(
  pages: Array<{ url: string; favicon?: string }>
): string | undefined {
  for (const page of pages) {
    if (page.favicon && page.favicon.trim().length > 0) return page.favicon.trim();
  }
  return undefined;
}

/**
 * Deterministically (best-effort) extracts services and opening hours from
 * content. Absent signals return empty arrays/undefined — NEVER invented.
 */
export function extractBusinessInfo(content: string): {
  services: string[];
  hours?: string;
} {
  const result: { services: string[]; hours?: string } = { services: [] };

  if (!content) return result;

  // Hours: first HH:MM AM/PM or HH AM/PM range.
  const hoursMatch = content.match(
    /((?:\d{1,2})(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\s*[-–—to]\s*(?:\d{1,2})(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.))/i
  );
  if (hoursMatch) result.hours = hoursMatch[1].trim();

  // Services: lines following a services-style heading, up to next heading/blank.
  const servicesRegex = /(?:^|\n)\s*(?:our\s+)?(?:services?|what\s+we\s+offer|products?)(?:\s*:)?\s*\n([^\n]{0,1200})/i;
  const match = servicesRegex.exec(content);
  if (match) {
    const block = match[1];
    const lines = block
      .split(/\n|,|•|\u2022|;|\||- {1,3}/)
      .map((l) => l.trim().replace(/^[-•\s]+/, ''))
      .filter((l) => l.length >= 3 && l.length <= 80 && !/^[a-z]+$/i.test(l))
      .slice(0, 10);
    result.services = [...new Set(lines)];
  }

  return result;
}

function isGenericName(name: string): boolean {
  const lower = name.toLowerCase().trim();
  const genericStrings = [
    'home',
    'welcome',
    'about us',
    'contact us',
    'privacy policy',
    'terms of service',
    'services',
    'our services',
    '404',
    'not found',
    'error',
    'untitled',
    'index',
  ];
  return genericStrings.includes(lower);
}

export interface ExtractedPageBusinessName {
  name: string;
  source: 'schema' | 'h1' | 'og' | 'title';
}

/**
 * Phase 8h (W2-02): Authoritatively extracts real business name from page HTML / Markdown.
 * Priority: Schema.org JSON-LD -> og:site_name -> Clean <h1> -> Clean <title>.
 */
export function extractPageBusinessName(
  rawHtml?: string,
  markdown?: string
): ExtractedPageBusinessName | null {
  // 1. JSON-LD Schema.org name
  if (rawHtml) {
    const schemaMatches = rawHtml.matchAll(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    );
    for (const match of schemaMatches) {
      try {
        const json = JSON.parse(match[1]);
        const entities = Array.isArray(json) ? json : [json];
        for (const item of entities) {
          const type = (item['@type'] || '').toString().toLowerCase();
          if (
            type.includes('organization') ||
            type.includes('business') ||
            type.includes('store') ||
            type.includes('restaurant') ||
            type.includes('company') ||
            type.includes('service') ||
            type.includes('hotel')
          ) {
            if (
              typeof item.name === 'string' &&
              item.name.trim().length >= 3 &&
              item.name.trim().length <= 70
            ) {
              const cleaned = item.name.trim();
              if (!isGenericName(cleaned)) {
                return { name: cleaned, source: 'schema' };
              }
            }
          }
        }
      } catch {}
    }

    // 2. OpenGraph site_name
    const ogMatch =
      rawHtml.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i) ||
      rawHtml.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i);
    if (ogMatch && ogMatch[1]) {
      const ogName = ogMatch[1].trim();
      if (ogName.length >= 3 && ogName.length <= 60 && !isGenericName(ogName)) {
        return { name: ogName, source: 'og' };
      }
    }

    // 3. Clean <h1> from HTML
    const h1Match = rawHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match && h1Match[1]) {
      const h1Text = h1Match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (h1Text.length >= 3 && h1Text.length <= 60 && !isGenericName(h1Text)) {
        return { name: h1Text, source: 'h1' };
      }
    }
  }

  // 4. Markdown # Heading
  if (markdown) {
    const mdH1 = markdown.match(/^#\s+([^\n\r]+)/m);
    if (mdH1 && mdH1[1]) {
      const heading = mdH1[1].trim();
      if (heading.length >= 3 && heading.length <= 60 && !isGenericName(heading)) {
        return { name: heading, source: 'h1' };
      }
    }
  }

  // 5. HTML <title> tag (stripping common marketing / location suffixes)
  if (rawHtml) {
    const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      let titleText = titleMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      titleText = titleText
        .split(/\s*[-–|:]\s*(?:home|official|welcome|about|contact|best|top|kathmandu|nepal|services)/i)[0]
        .trim();
      if (titleText.length >= 3 && titleText.length <= 60 && !isGenericName(titleText)) {
        return { name: titleText, source: 'title' };
      }
    }
  }

  return null;
}

let llmMultiBusinessCallCount = 0;

export function getLlmMultiBusinessCallCount(): number {
  return llmMultiBusinessCallCount;
}

export function resetLlmMultiBusinessCallCount(): void {
  llmMultiBusinessCallCount = 0;
}

const EXCLUDED_LEGAL_AND_GOV_ENTITIES = new Set([
  'office of the company registrar',
  'department of industry',
  'department of immigration',
  'nepal rastra bank',
  'investment board',
  'inland revenue department',
  'tribhuvan university',
  'kathmandu university',
  'government of nepal',
  'supreme court',
  'high court',
  'district court',
  'private limited company',
  'public limited company',
  'sole proprietorship',
  'partnership firm',
  'notary nepal',
  'company darta nepal',
]);

const QUESTION_STARTER_WORDS = /^(how|what|why|when|where|who|which|can|is|are|do|does|should|will|could|would|step|faq|question|reason|practice|service)\b/i;

/**
 * Phase 8h (W2-04) & Phase 8i (CONTACT-02 / Group D): Enhanced multi-business listing / directory / aggregator / blog post detector.
 * Identifies pages presenting multiple distinct companies, contacts, or listicles while disambiguating
 * FAQ question headings, attorney/doctor rosters, and legal/regulatory authority mentions.
 */
export function detectMultiBusinessPage(
  content: string,
  url?: string,
  businessName?: string
): boolean {
  if (!content) return false;

  if (url) {
    const lowerUrl = url.toLowerCase();
    if (
      lowerUrl.includes('/directory') ||
      lowerUrl.includes('/yellow-pages') ||
      lowerUrl.includes('/yellowpages') ||
      lowerUrl.includes('/listings') ||
      lowerUrl.includes('/category/') ||
      lowerUrl.includes('/categories/') ||
      lowerUrl.includes('/listing/') ||
      lowerUrl.includes('/eatery/') ||
      lowerUrl.includes('skillsewa.com')
    ) {
      return true;
    }
  }

  // 1. Numbered listicle headings (e.g. <h2>1. Apex Hotel... <h2>2. Kathmandu Guest House...)
  // Exclude FAQ questions (e.g. "1. How much does it cost?", "2. Can a foreign company..."), steps, services
  const listicleMatches =
    content.match(/(?:<h[1-6][^>]*>|^|\n|\.\s+)\s*\d{1,2}\.?\s+(?:Top|Best|[A-Z])[A-Za-z0-9\s&'-]{3,60}/gi) || [];

  const realListicles = listicleMatches.filter((m) => {
    const cleaned = m.replace(/^[^A-Za-z0-9]+/, '').replace(/^\d{1,2}\.?\s*/, '').trim();
    if (cleaned.endsWith('?')) return false;
    if (QUESTION_STARTER_WORDS.test(cleaned)) return false;
    if (/\b(branch|office|step|faq|question|practice|service|publication|attorney|lawyer|doctor|teacher|team)\b/i.test(cleaned)) return false;
    return true;
  });

  if (realListicles.length >= 3) {
    return true;
  }

  // 2. Distinct standalone corporate entities (e.g. "X Pvt Ltd", "Y Suppliers", "Z Traders", "W Enterprises")
  // Strip team rosters and FAQ sections first
  const sanitizedContent = content
    .replace(/(?:##?\s*(?:Meet Our|Our Team|Attorneys?|Lawyers?|Doctors?|Faculty|Staff|Leadership|Board)[\s\S]*?(?=\n##|$))/gi, ' ')
    .replace(/(?:##?\s*(?:Frequently Asked Questions|FAQ|Q&A)[\s\S]*?(?=\n##|$))/gi, ' ');

  const text = sanitizedContent.replace(/<[^>]+>/g, ' ');
  const entityMatches =
    text.match(
      /\b[A-Z][A-Za-z0-9\s&'-]{2,35}\s+(?:Pvt\.?\s*Ltd\.?|Suppliers?|Traders?|Enterprises?|Pvt\b|Limited\b)\b/gi
    ) || [];

  const bTokens = businessName
    ? businessName.toLowerCase().split(/\s+/).filter((t) => t.length > 2)
    : [];

  const filteredEntities = entityMatches.filter((e) => {
    const lower = e.toLowerCase().trim();
    if (lower.includes('branch') || lower.includes('office') || lower.includes('counter')) return false;
    if (EXCLUDED_LEGAL_AND_GOV_ENTITIES.has(lower)) return false;
    if (bTokens.length > 0 && bTokens.some((t) => lower.includes(t))) return false;
    return true;
  });

  const uniqueEntities = new Set(filteredEntities.map((e) => e.trim().toLowerCase()));
  if (uniqueEntities.size >= 4) {
    return true;
  }

  // 3. Multi-business directory / listicle phone dump
  const phones = extractPhones(content);
  const mobiles = extractMobiles(content);
  const totalPhones = new Set([...phones, ...mobiles]);
  if (realListicles.length >= 2 && totalPhones.size >= 4) {
    return true;
  }
  if (uniqueEntities.size >= 3 && totalPhones.size >= 5) {
    return true;
  }

  return false;
}

/**
 * Phase 8h (W2-04): Two-Tier Hybrid Gate (Deterministic first, bounded LLM fallback with telemetry).
 * Budget cap: 10 LLM calls per run, 4,000 char prompt snippet, 5-second timeout.
 */
export async function detectMultiBusinessPageWithLlmFallback(
  content: string,
  url?: string,
  businessName?: string,
  options?: { agent?: any }
): Promise<{ isMulti: boolean; usedLlm: boolean; reason: string }> {
  // Tier 1: Deterministic evaluation
  if (detectMultiBusinessPage(content, url, businessName)) {
    return { isMulti: true, usedLlm: false, reason: 'DETERMINISTIC_MULTI_PAGE' };
  }

  // Borderline check: If page mentions blog-like listicle keywords or 2 distinct entities
  const lowerContent = content.toLowerCase();
  const isBorderline =
    /\b(?:top\s*\d+|best\s*\d+|list\s*of|directory|companies\s*in|services\s*in)\b/i.test(
      lowerContent.slice(0, 4000)
    );

  if (isBorderline && options?.agent && llmMultiBusinessCallCount < 10) {
    llmMultiBusinessCallCount++;
    try {
      const promptSnippet = content.slice(0, 4000);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const prompt = `Analyze this webpage content snippet. Is this a multi-business aggregator/directory/blog listing multiple companies, or is it the official single business website for "${businessName || 'the company'}"? Respond ONLY with a JSON object: {"isMultiBusiness": true/false, "reason": "short explanation"}`;

      const res = await options.agent.generate([
        { role: 'user', content: `${prompt}\n\nContent:\n${promptSnippet}` },
      ]);
      clearTimeout(timeoutId);

      const parsed = JSON.parse(res.text?.trim() || '{}');
      return {
        isMulti: Boolean(parsed.isMultiBusiness),
        usedLlm: true,
        reason: parsed.reason || 'LLM_CLASSIFICATION',
      };
    } catch {
      return { isMulti: false, usedLlm: true, reason: 'LLM_FALLBACK_TIMEOUT' };
    }
  }

  return { isMulti: false, usedLlm: false, reason: 'DETERMINISTIC_SINGLE_PAGE' };
}

/**
 * Runs ALL deterministic extractors over a set of successfully-extracted pages
 * and produces a lean WebsiteEvidence payload (minus url/domain/pages which the
 * caller supplies).
 */
export function extractAllFromPages(
  pages: WebsitePageEvidence[],
  businessName?: string,
  websiteUrl?: string
): Omit<WebsiteEvidence, 'url' | 'domain' | 'pages'> {
  const successful = pages.filter((p) => p.success && (p.content || p.rawHtml)).map((p) => ({
    ...p,
    content: stripVendorAttribution(p.content || ''),
    rawHtml: stripVendorAttribution(p.rawHtml || ''),
  }));

  const combinedMarkdown = successful.map((p) => p.content).filter(Boolean).join('\n\n');
  const websiteDomain = websiteUrl ? domainFromUrlOrHost(websiteUrl) : undefined;

  // 1. Emails: extracted from both clean markdown and rawHtml safety net
  const emailSet = new Set<string>();
  const phoneSet = new Set<string>();        // display strings (landlines + intl)
  const mobileSet = new Set<string>();       // display strings (mobiles)
  const phoneDigitsSeen = new Set<string>(); // canonical dedup for phones
  const mobileDigitsSeen = new Set<string>(); // canonical dedup for mobiles
  const allPhoneEvidence: PhoneEvidenceRecord[] = [];
  const allClassifiedContacts: ClassifiedContact[] = [];

  // Classify extracted emails with context
  for (const page of successful) {
    const pageUrl = page.url;
    const pageText = (page.content || '') + '\n' + (page.rawHtml || '');

    // Phase 8g: Multi-entity directory gate — reject contacts if page mentions >=3 distinct businesses
    if (detectMultiBusinessPage(pageText, pageUrl, businessName)) {
      continue;
    }

    for (const email of extractEmails(pageText)) {
      emailSet.add(email);
      const ctx = extractContextAroundMatch(pageText, email);
      const role = classifyEmailRole(email, ctx, businessName, websiteDomain);
      allClassifiedContacts.push({
        value: email,
        type: 'email',
        role: role.role,
        owner: role.owner,
        channels: [],
        context: ctx || undefined,
        pageUrl,
      });
    }
  }

  const processCandidate = (raw: string, source: PhoneEvidenceRecord['source'], pageUrl: string, pageText?: string) => {
    const classified = classifyNepalPhone(raw);
    const display = formatPhoneDisplay(classified.digits, classified.type, raw);
    const evidence: PhoneEvidenceRecord = {
      raw,
      canonicalDigits: classified.digits,
      display,
      type: classified.type,
      source,
      pageUrl,
      reason: classified.reason,
    };
    allPhoneEvidence.push(evidence);

    const context = pageText ? extractContextAroundMatch(pageText, raw) : '';

    // Group E (W3-10): Demo / Template placeholder filter
    if (
      detectTemplateContent(context) ||
      detectTemplateContent(raw) ||
      /(?:\+1[-.\s]?6335\d{3,6}|\+1[-.\s]?234[-.\s]?567[-.\s]?890|\+44[-.\s]?1234[-.\s]?567890|\b1234567890\b|\b0123456789\b)/i.test(raw)
    ) {
      return;
    }

    const phoneRole = classifyPhoneRole(raw, context, businessName, classified, pageUrl);

    if (classified.type !== 'invalid') {
      allClassifiedContacts.push({
        value: display,
        canonicalDigits: classified.digits,
        type: 'phone',
        phoneType: classified.type,
        role: phoneRole.role,
        owner: phoneRole.owner,
        channels: phoneRole.channels,
        associatedPerson: phoneRole.associatedPerson,
        associatedJobTitle: phoneRole.associatedJobTitle,
        context: context || undefined,
        pageUrl,
      });
    }

    if (classified.type === 'mobile') {
      if (!mobileDigitsSeen.has(classified.digits)) {
        mobileDigitsSeen.add(classified.digits);
        mobileSet.add(display);
      }
    } else if (classified.type === 'landline' || classified.type === 'international') {
      if (!phoneDigitsSeen.has(classified.digits)) {
        phoneDigitsSeen.add(classified.digits);
        phoneSet.add(display);
      }
    }
  };

  for (const page of successful) {
    const pageUrl = page.url;
    const pageText = (page.content || '') + '\n' + (page.rawHtml || '');

    // Phase 8g: Multi-entity directory gate — reject contacts if page mentions >=3 distinct businesses
    if (detectMultiBusinessPage(pageText, pageUrl, businessName)) {
      continue;
    }

    if (page.content) {
      for (const raw of extractLandlinesAndIntl(page.content)) processCandidate(raw, 'markdown', pageUrl, page.content);
      for (const raw of extractMobiles(page.content)) processCandidate(raw, 'markdown', pageUrl, page.content);
    }

    if (page.rawHtml) {
      for (const raw of extractLandlinesAndIntl(page.rawHtml)) processCandidate(raw, 'rawHtml', pageUrl, page.rawHtml);
      for (const raw of extractMobiles(page.rawHtml)) processCandidate(raw, 'rawHtml', pageUrl, page.rawHtml);
    }
  }

  // 3. Socials: extracted from markdown links + raw HTML href attributes
  const allSocialSources = [
    combinedMarkdown,
    ...successful.map((p) => p.rawHtml).filter(Boolean) as string[],
  ].join('\n');
  const socialLinks = extractSocialLinks(allSocialSources, { businessName, websiteDomain });

  // 4. Services and Hours: ONLY from markdown prose (clean text, no HTML tags)
  const info = extractBusinessInfo(combinedMarkdown);

  // 5. Favicon: from Tavily first, or extracted from raw HTML
  let favicon = extractFavicon(successful) || '';
  if (!favicon) {
    for (const p of successful) {
      if (p.rawHtml) {
        const fav = extractFaviconFromHtml(p.url, p.rawHtml);
        if (fav) {
          favicon = fav;
          break;
        }
      }
    }
  }

  // Lean summary: from clean markdown ONLY, never raw HTML
  const summaryParts = successful
    .filter((p) => p.content)
    .slice(0, 3)
    .map((p) => p.content.replace(/\s+/g, ' ').slice(0, 200));
  const rawContentSummary = summaryParts.join(' ... ').slice(0, 600);

  const deduplicatedContacts = deduplicateClassifiedContacts(allClassifiedContacts);

  return {
    extractedEmails: [...emailSet],
    extractedPhones: [...phoneSet],
    extractedMobiles: [...mobileSet],
    extractedPhoneEvidence: allPhoneEvidence.length > 0 ? allPhoneEvidence : undefined,
    extractedClassifiedContacts: deduplicatedContacts.length > 0 ? deduplicatedContacts : undefined,
    extractedSocialLinks: socialLinks,
    extractedServices: info.services,
    extractedHours: info.hours,
    favicon,
    rawContentSummary: rawContentSummary || undefined,
  };
}

/**
 * Deduplicates ClassifiedContact records deterministically using Rule (A): "First-seen wins"
 * and Rule (B): "Signal OR-Combination" across all page sightings.
 * Keyed by canonical identity (canonicalDigits for phones, lowercase value for emails).
 * pagesSeenOn aggregates all normalized unique URLs where the contact was witnessed.
 */
export function deduplicateClassifiedContacts(contacts: ClassifiedContact[]): ClassifiedContact[] {
  const map = new Map<
    string,
    {
      contact: ClassifiedContact;
      pages: Set<string>;
      pageTypesSeen: Set<PageType>;
      hasMapsSignal: boolean;
      hasPageCtaSignal: boolean;
      hasGeneralContactSignal: boolean;
      hasOwnerLeadershipSignal: boolean;
      hasStaffSignal: boolean;
      hasBranchSignal: boolean;
      hasPlatformSignal: boolean;
    }
  >();

  for (const c of contacts) {
    const key = c.type === 'phone'
      ? (c.canonicalDigits || c.value.replace(/\D/g, ''))
      : c.value.toLowerCase().trim();

    if (!key) continue;

    const normalizedPageUrl = c.pageUrl ? c.pageUrl.replace(/\/+$/, '') : undefined;
    const pType = classifyPageType(c.pageUrl);

    const ctx = (c.context || '').toLowerCase();
    const ctaSignal =
      /\b(call now|call us|emergency service|fast service|toll free|customer care|hotline|get a quote|need clean|book now|talk to us|phone:)\b/i.test(
        ctx
      ) || /\[(?:call|phone|tel|emergency|hotline|now|quote)[^\]]*\]\(tel:/i.test(c.context || '');
    const generalSignal =
      pType === 'contact' ||
      /\b(head office|main office|central office|contact us|email us)\b/i.test(ctx);
    const branchSignal =
      c.role === 'branch_contact' ||
      c.owner === 'branch' ||
      /\b(branch|branches|outlet|outlets)\b/i.test(ctx);
    const platformSignal = c.owner === 'platform';

    let ownerSignal = Boolean(
      c.associatedJobTitle &&
        OWNER_LEADERSHIP_TITLES.some((t) => c.associatedJobTitle?.toLowerCase().includes(t))
    );
    let staffSignal =
      Boolean(c.owner === 'person' || c.role === 'staff_person') ||
      Boolean(
        c.associatedJobTitle &&
          STAFF_TITLES.some((t) => c.associatedJobTitle?.toLowerCase().includes(t))
      );

    if (!ownerSignal) {
      for (const t of OWNER_LEADERSHIP_TITLES) {
        if (new RegExp(`\\b${t}\\b`, 'i').test(ctx)) {
          ownerSignal = true;
          break;
        }
      }
    }

    if (!staffSignal) {
      for (const t of STAFF_TITLES) {
        if (new RegExp(`\\b${t}\\b`, 'i').test(ctx)) {
          staffSignal = true;
          break;
        }
      }
      if (/\b(dr\.|dr\s|mr\.|mrs\.|ms\.|prof\.)\b/i.test(ctx)) {
        staffSignal = true;
      }
    }

    const existing = map.get(key);
    if (!existing) {
      const pages = new Set<string>();
      if (normalizedPageUrl) pages.add(normalizedPageUrl);
      if (c.pagesSeenOn) {
        for (const p of c.pagesSeenOn) {
          const norm = p.replace(/\/+$/, '');
          if (norm) pages.add(norm);
        }
      }
      const pageTypesSeen = new Set<PageType>([pType]);

      map.set(key, {
        contact: { ...c },
        pages,
        pageTypesSeen,
        hasMapsSignal: c.role === 'primary_business' && c.owner === 'business' && !c.context, // raw Maps seed
        hasPageCtaSignal: ctaSignal,
        hasGeneralContactSignal: generalSignal,
        hasOwnerLeadershipSignal: ownerSignal,
        hasStaffSignal: staffSignal,
        hasBranchSignal: branchSignal,
        hasPlatformSignal: platformSignal,
      });
    } else {
      if (normalizedPageUrl) existing.pages.add(normalizedPageUrl);
      if (c.pagesSeenOn) {
        for (const p of c.pagesSeenOn) {
          const norm = p.replace(/\/+$/, '');
          if (norm) existing.pages.add(norm);
        }
      }
      existing.pageTypesSeen.add(pType);
      existing.hasPageCtaSignal = existing.hasPageCtaSignal || ctaSignal;
      existing.hasGeneralContactSignal = existing.hasGeneralContactSignal || generalSignal;
      existing.hasOwnerLeadershipSignal = existing.hasOwnerLeadershipSignal || ownerSignal;
      existing.hasStaffSignal = existing.hasStaffSignal || staffSignal;
      existing.hasBranchSignal = existing.hasBranchSignal || branchSignal;
      existing.hasPlatformSignal = existing.hasPlatformSignal || platformSignal;

      for (const ch of c.channels || []) {
        if (!existing.contact.channels.includes(ch)) {
          existing.contact.channels.push(ch);
        }
      }

      if (!existing.contact.associatedPerson && c.associatedPerson) {
        existing.contact.associatedPerson = c.associatedPerson;
      }
      if (!existing.contact.associatedJobTitle && c.associatedJobTitle) {
        existing.contact.associatedJobTitle = c.associatedJobTitle;
      }
    }
  }

  return Array.from(map.values()).map(
    ({
      contact,
      pages,
      pageTypesSeen,
      hasMapsSignal,
      hasPageCtaSignal,
      hasGeneralContactSignal,
      hasOwnerLeadershipSignal,
      hasStaffSignal,
      hasBranchSignal,
      hasPlatformSignal,
    }) => {
      // Re-evaluate 9-row decision matrix on the OR-combined signal vector for phones
      if (contact.type === 'phone') {
        const reevaluated = evaluateContactRoleMatrix({
          hasMapsSignal,
          hasPageCtaSignal,
          hasGeneralContactSignal,
          hasOwnerLeadershipSignal,
          hasStaffSignal,
          hasBranchSignal,
          hasPlatformSignal,
          pageTypesSeen,
        });
        contact.role = reevaluated.role;
        contact.owner = reevaluated.owner;
      }

      return {
        ...contact,
        pagesSeenOn:
          pages.size > 0
            ? Array.from(pages)
            : contact.pageUrl
            ? [contact.pageUrl.replace(/\/+$/, '')]
            : undefined,
      };
    }
  );
}