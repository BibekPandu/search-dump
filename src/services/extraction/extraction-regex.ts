/**
 * Shared regular expressions and pattern tables. No service imports.
 *
 * Phase 4 split of `src/services/business-extractor.service.ts`. Every declaration
 * below is copied byte-exact from the monolith; only the import block is new.
 */



export const EMAIL_REGEX = /\b[a-zA-Z0-9_.%+-]{1,64}@[a-zA-Z0-9-]{1,63}(?:\.[a-zA-Z0-9-]{1,63})+\b/g;

// Placeholder / throwaway addresses that must never be treated as real evidence.

export const PLACEHOLDER_EMAIL_PATTERNS = [
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

export const MEDIA_FILENAME_PATTERN = /\.(png|jpe?g|gif|svg|webp|bmp|ico|tiff?|avif)$/i;

export const MEDIA_DPR_PATTERN = /@\d+(?:\.\d+)?x\.(?:png|jpe?g|gif|svg|webp)$/i;

export const IMAGE_FILE_TLDS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'avif'
]);

export const LANDLINE_OR_MOBILE_REGEX =
  /(?<!\d)(?:(?:\+977[-.\s]?)?(?:01[-.\s]?\d{6,8}|9[78]\d[-.\s]?\d{7})|(?:\+977[-.\s]?1[-.\s]?\d{6,8}))(?!\d)/g;

export const MOBILE_REGEX = /(?<!\d)(?:\+977[-.\s]?)?9[78]\d[-.\s]?\d{7}(?!\d)/g;

export const NEPAL_LANDLINE_REGEX = /(?<!\d)(?:\+977[-.\s]?)?0?(?:1[-.\s]?\d{6,7}|[2-9]\d[-.\s]?\d{6})(?!\d)/g;

export const INTERNATIONAL_REGEX = /\+[\d\s()-]{7,25}/g;

// Phone numbers hidden in hrefs that must survive URL/noise stripping:
//   tel:+977-1-4522833 / callto:+977... (HTML attributes & markdown links)
//   wa.me/977… · api.whatsapp.com/send?phone=… (https URLs)

export const TEL_PROTECT_REGEX =
  /(?:href=["'](?:tel|callto):|wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\+?[\d\s().-]{7,25})|(?:tel|callto):(\+?[\d\s().-]{7,25})/gi;

export const FACEBOOK_REGEX = /https?:\/\/(?:www\.)?(?:m\.)?facebook\.com\/(?:profile\.php\?[^\s"'<>)]+|[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*\/?)/i;

export const INSTAGRAM_REGEX = /https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*\/?/i;

export const TIKTOK_REGEX = /https?:\/\/(?:www\.)?tiktok\.com\/@[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*\/?/i;

export const X_TWITTER_REGEX = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[a-zA-Z0-9_]+/i;

export const YOUTUBE_REGEX = /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:channel\/|c\/|user\/|@)?|youtu\.be\/)[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*\/?/i;

export const LINKEDIN_COMPANY_REGEX = /https?:\/\/(?:www\.)?linkedin\.com\/company\/[\w-]+/i;

export const LINKEDIN_PERSONAL_REGEX = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w-]+/i;

export const LINKEDIN_REGEX = /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[\w-]+/i;

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

export const BARE_HANDLE_REGEX = /\b(facebook|instagram|tiktok)\s*[:\-–—]?\s*@([a-zA-Z0-9._-]{2,30})/gi;

/**
 * Harvests absolute http(s) URLs from markdown [text](href) pairs.
 * Relative, fragment, mailto: and tel: destinations are skipped.
 */
