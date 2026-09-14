import { normalizePhoneDigits } from './entity-resolution.service';
import type { WebsitePageEvidence, WebsiteEvidence, PhoneEvidenceRecord } from '../mastra/agents/research-agent/verification.schema';

// ============================================================================
// Business Extractor — deterministic (0-token) structured fact extraction
// ============================================================================
// ALL functions here are pure and deterministic. No LLM usage, ever. Structured
// facts (emails, phones, mobiles, socials, favicon, services, hours) are
// extracted via regex/rules and used as EVIDENCE-BACKED authority downstream.

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Placeholder / throwaway addresses that must never be treated as real evidence.
const PLACEHOLDER_EMAIL_PATTERNS = [
  /^example\./i,
  /@example\.(com|org|net)$/i,
  /sentry\.io$/i,
  /wixpress\.com$/i,
  /\.wix\.com$/i,
  /@domain\.(com|net)$/i,
  /^test@/i,
  /^user@/i,
  /^email@/i,
  /^name@/i,
  /^your(@|[-.])/i,
  /^youremail/i,
  /^contact@example/i,
  /^noreply@/i,
  /^no-reply@/i,
  /@yopmail\./i,
  /@mailinator\./i,
  // Cloudflare-protected relay / masked-email representations.
  /@privacy\.cloudflare\.com$/i,
  /@email\.cloudflare\.com$/i,
  // Literal "[email protected]" text that HTML renderers emit for masked emails.
  /\[email\s*protected\]/i,
  /^email(?:\s*protected)?@/i,
];

// Phone patterns (Nepal-aware, proven in buildFallbackListing + Phase 1):
// landline: +977-1-4240520 / 014240520 / 01-4240520
// mobile:   +977 98XXXXXXXX / 98XXXXXXXX (9[78] prefix)
const LANDLINE_OR_MOBILE_REGEX =
  /(?:\+977[-.\s]?)?(?:01[-.\s]?\d{6,8}|9[78]\d[-.\s]?\d{7})|(?:\+977[-.\s]?1[-.\s]?\d{6,8})/g;
const MOBILE_REGEX = /(?:\+977[-.\s]?)?9[78]\d[-.\s]?\d{7}/g;
const NEPAL_LANDLINE_REGEX = /(?:\+977[-.\s]?)?0?1[-.\s]?\d{6,7}\b/g;
const INTERNATIONAL_REGEX = /\+[\d\s()-]{7,15}/g;

// Phone numbers hidden in hrefs that must survive URL/noise stripping:
//   tel:+977-1-4522833 / callto:+977... (HTML attributes & markdown links)
//   wa.me/977… · api.whatsapp.com/send?phone=… (https URLs)
const TEL_PROTECT_REGEX =
  /(?:href=["'](?:tel|callto):|wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\+?[\d\s().-]{7,25})|(?:tel|callto):(\+?[\d\s().-]{7,25})/gi;

const FACEBOOK_REGEX = /https?:\/\/(?:www\.)?(?:m\.)?facebook\.com\/(?:profile\.php\?id=\d+|[a-zA-Z0-9._-]+)/i;
const INSTAGRAM_REGEX = /https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9._-]+/i;
const TIKTOK_REGEX = /https?:\/\/(?:www\.)?tiktok\.com\/@[a-zA-Z0-9._-]+/i;
const X_TWITTER_REGEX = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[a-zA-Z0-9_]+/i;
const YOUTUBE_REGEX = /https?:\/\/(?:www\.)?youtube\.com\/(?:@[\w-]+|c\/[\w-]+|channel\/[\w-]+)/i;
const LINKEDIN_REGEX = /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[\w-]+/i;

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
 *
 * NOTE: classifyNepalPhone also handles international formats — rename to
 * classifyPhone() in a future cleanup pass.
 */
export function classifyNepalPhone(raw: string): ClassifiedPhone {
  const cleaned = sanitizePhoneString(raw);
  if (!cleaned) return { type: 'invalid', digits: '', normalized: '', reason: 'EMPTY' };

  const digits = cleaned.replace(/\D/g, '');
  if (!digits) return { type: 'invalid', digits: '', normalized: cleaned, reason: 'NO_DIGITS' };

  // Hard limits: below 7 digits or above 15 digits cannot be any valid phone.
  if (digits.length > 15) return { type: 'invalid', digits, normalized: cleaned, reason: 'TOO_LONG' };

  const hasPlus = cleaned.startsWith('+');
  const startsWith977 = digits.startsWith('977');

  // ── PATH A: Nepal country code prefix (977…) ────────────────────────────────
  if (startsWith977) {
    const afterCC = digits.slice(3); // digits after the 977 country code

    // Mobile: 977 + exactly 10 digits starting with 98 or 97 (not 977)
    if ((afterCC.startsWith('98') || afterCC.startsWith('97')) && !afterCC.startsWith('977')) {
      if (afterCC.length === 10) {
        return { type: 'mobile', digits: afterCC, normalized: `+977-${afterCC}` };
      }
      // Has mobile-looking prefix but wrong length → INCOMPLETE_MOBILE
      return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_MOBILE' };
    }

    // Landline: 977 + 01 + 7 digits  (total afterCC length = 9)
    if (afterCC.startsWith('01')) {
      if (afterCC.length === 9) {
        const landlineDigits = afterCC.slice(1); // strip trunk 0
        return { type: 'landline', digits: landlineDigits, normalized: landlineDigits };
      }
      return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_LANDLINE' };
    }

    // Landline: 977 + 1 + 7 digits  (total afterCC length = 8)
    if (afterCC.startsWith('1')) {
      if (afterCC.length === 8) {
        return { type: 'landline', digits: afterCC, normalized: afterCC };
      }
      return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_LANDLINE' };
    }

    // Has 977 prefix but no recognised afterCC structure → international?
    if (hasPlus && digits.length >= 8 && digits.length <= 15) {
      const opens = (cleaned.match(/\(/g) || []).length;
      const closes = (cleaned.match(/\)/g) || []).length;
      if (opens === closes) return { type: 'international', digits, normalized: cleaned };
    }

    return { type: 'invalid', digits, normalized: cleaned, reason: 'INVALID_STRUCTURE' };
  }

  // ── PATH B: No 977 prefix — domestic or explicit international ───────────────

  // INTERNATIONAL: check FIRST for explicit '+' so numbers like +1 301 322 1427
  // do not hit the Nepal bare-digit checks below (e.g. startsWith('1') guard).
  // Must have explicit '+' and 8–15 digits with balanced parens.
  if (hasPlus && digits.length >= 8 && digits.length <= 15) {
    const opens = (cleaned.match(/\(/g) || []).length;
    const closes = (cleaned.match(/\)/g) || []).length;
    if (opens === closes) return { type: 'international', digits, normalized: cleaned };
  }

  // Nepal mobile (domestic, 10 digits, 97x/98x, not 977)
  if (digits.length === 10 && (digits.startsWith('98') || digits.startsWith('97')) && !digits.startsWith('977')) {
    return { type: 'mobile', digits, normalized: digits };
  }

  // Nepal mobile prefix present but WRONG length → INCOMPLETE_MOBILE (e.g. +977 (980) 822-2)
  if ((digits.startsWith('98') || digits.startsWith('97')) && !digits.startsWith('977') && digits.length !== 10) {
    return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_MOBILE' };
  }

  // Kathmandu landline: 01 + 7 digits → strip trunk
  if (digits.length === 9 && digits.startsWith('01')) {
    return { type: 'landline', digits: digits.slice(1), normalized: digits.slice(1) };
  }
  if (digits.startsWith('01') && digits.length !== 9) {
    return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_LANDLINE' };
  }

  // Kathmandu landline: 1 + 7 digits (8 digits total)
  if (digits.length === 8 && digits.startsWith('1')) {
    return { type: 'landline', digits, normalized: digits };
  }
  // Starts with 1 but wrong length (including 7-digit fragments) → INCOMPLETE_LANDLINE
  if (digits.startsWith('1') && digits.length !== 8) {
    return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_LANDLINE' };
  }


  return { type: 'invalid', digits, normalized: cleaned, reason: 'INVALID_STRUCTURE' };
}

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
      const trimmed = raw.trim();
      return trimmed.startsWith('+') ? trimmed : `+${trimmed.replace(/^\D+/, '')}`;
    }
    return `+${canonicalDigits}`;
  }
  // invalid or unknown: return raw or canonical
  return raw ?? canonicalDigits;
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
      if (firstSegment.length < 3) return false;
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
      /^([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.(?:com\.np|org\.np|com|org|net|edu|gov|io|co|np|biz|info))([A-Z].*)$/
    );
    if (gluedMatch) {
      email = gluedMatch[1];
    }
    email = sanitizeEmailString(email);
    if (!email) continue;
    if (PLACEHOLDER_EMAIL_PATTERNS.some((pattern) => pattern.test(email))) continue;
    if (email.includes(' ') || !email.includes('@')) continue;
    if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) continue;
    unique.add(email);
  }
  return [...unique];
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
 * Extracts Nepal landline/mobile phone numbers (display form preserved) with
 * deduplication by normalized digits.
 *
 * Enforces strict mathematical invariants via classifyNepalPhone:
 * - Nepal mobiles (98/97 x10, not 977)
 * - Nepal landlines (exact 8 normalized digits starting with 1)
 * - International numbers (starts with '+', balanced parentheses, 8-15 digits)
 * - All fragments (including 7-digit runs like 977 1532074) are strictly discarded as invalid.
 */
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
 * (Social-platform scraping / profile enrichment is explicitly OUT OF SCOPE.)
 */
export function extractSocialLinks(content: string): ExtractedSocialLinks {
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

  const rawFacebook = fbMatches.map(cleanTrailingPunctuation).find((u) => isRealSocialProfile(u, 'facebook')) || '';
  const rawInstagram = igMatches.map(cleanTrailingPunctuation).find((u) => isRealSocialProfile(u, 'instagram')) || '';
  const rawTiktok = ttMatches.map(cleanTrailingPunctuation).find((u) => isRealSocialProfile(u, 'tiktok')) || '';

  const other: Record<string, string> = {};
  const xTwitter = xMatches.map(cleanTrailingPunctuation).find((u) => isRealSocialProfile(u, 'twitter'));
  const youtube = ytMatches.map(cleanTrailingPunctuation).find((u) => isRealSocialProfile(u, 'youtube'));
  const linkedin = liMatches.map(cleanTrailingPunctuation).find((u) => isRealSocialProfile(u, 'linkedin'));
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

/**
 * Runs ALL deterministic extractors over a set of successfully-extracted pages
 * and produces a lean WebsiteEvidence payload (minus url/domain/pages which the
 * caller supplies).
 *
 * Architecture (v1.5 with PhoneEvidence tracing):
 *   Tavily Markdown + Raw HTML -> field-specific extractors
 *   - Emails: plain text + obfuscated + mailto: hrefs across markdown & raw HTML
 *   - Phones/Mobiles: per-page per-candidate PhoneEvidence[] with full provenance;
 *     valid phones in extractedPhones/extractedMobiles (strict separation),
 *     invalid candidates only in extractedPhoneEvidence (never in public arrays)
 *   - Socials: markdown links + HTML href attributes
 *   - Services/Hours: extracted ONLY from clean markdown (never raw HTML)
 *   - rawContentSummary: small context-only excerpt from clean markdown (never raw HTML)
 */
export function extractAllFromPages(
  pages: WebsitePageEvidence[]
): Omit<WebsiteEvidence, 'url' | 'domain' | 'pages'> {
  const successful = pages.filter((p) => p.success && (p.content || p.rawHtml));
  const combinedMarkdown = successful.map((p) => p.content).filter(Boolean).join('\n\n');

  // 1. Emails: extracted from both clean markdown and rawHtml safety net
  const emailSet = new Set<string>();
  for (const e of extractEmails(combinedMarkdown)) emailSet.add(e);
  for (const p of successful) {
    if (p.rawHtml) {
      for (const e of extractEmails(p.rawHtml)) emailSet.add(e);
    }
  }

  // 2. Phones & Mobiles: per-page evidence tracing (v1.5)
  //    - Valid candidates   -> extractedPhones / extractedMobiles AND extractedPhoneEvidence
  //    - Invalid candidates -> extractedPhoneEvidence ONLY (never in public arrays)
  //    Invariant enforced: phones ∩ mobiles = ∅
  const phoneSet = new Set<string>();        // display strings (landlines + intl)
  const mobileSet = new Set<string>();       // display strings (mobiles)
  const phoneDigitsSeen = new Set<string>(); // canonical dedup for phones
  const mobileDigitsSeen = new Set<string>(); // canonical dedup for mobiles
  const allPhoneEvidence: PhoneEvidenceRecord[] = [];

  /**
   * Processes a single raw phone candidate from a given page and source type.
   * Builds a PhoneEvidence entry and, if valid, routes into the correct public set.
   */
  const processCandidate = (raw: string, source: PhoneEvidenceRecord['source'], pageUrl: string) => {
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
    // invalid -> evidence only, never in public arrays
  };

  // Process per-page so each evidence entry carries its pageUrl
  for (const page of successful) {
    const pageUrl = page.url;

    // Extract from Tavily markdown content
    if (page.content) {
      for (const raw of extractLandlinesAndIntl(page.content)) processCandidate(raw, 'markdown', pageUrl);
      for (const raw of extractMobiles(page.content)) processCandidate(raw, 'markdown', pageUrl);
    }

    // Extract from raw HTML safety net
    if (page.rawHtml) {
      for (const raw of extractLandlinesAndIntl(page.rawHtml)) processCandidate(raw, 'rawHtml', pageUrl);
      for (const raw of extractMobiles(page.rawHtml)) processCandidate(raw, 'rawHtml', pageUrl);
    }
  }

  // 3. Socials: extracted from markdown links + raw HTML href attributes
  const allSocialSources = [
    combinedMarkdown,
    ...successful.map((p) => p.rawHtml).filter(Boolean) as string[],
  ].join('\n');
  const socialLinks = extractSocialLinks(allSocialSources);

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

  return {
    extractedEmails: [...emailSet],
    extractedPhones: [...phoneSet],
    extractedMobiles: [...mobileSet],
    extractedPhoneEvidence: allPhoneEvidence.length > 0 ? allPhoneEvidence : undefined,
    extractedSocialLinks: socialLinks,
    extractedServices: info.services,
    extractedHours: info.hours,
    favicon,
    rawContentSummary: rawContentSummary || undefined,
  };
}