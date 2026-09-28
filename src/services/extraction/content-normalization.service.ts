/**
 * Content cleanup helpers: vendor stripping, HTML/markdown unwrapping, URL harvesting.
 *
 * Phase 4 split of `src/services/business-extractor.service.ts`. Every declaration
 * below is copied byte-exact from the monolith; only the import block is new.
 */

import { extractDomain } from '@/services/discovery/search-fallback.service';
import { TEL_PROTECT_REGEX, BARE_HANDLE_REGEX } from '@/services/extraction/extraction-regex';

export function domainFromUrlOrHost(value: string): string {
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

export function decodeHtmlEntities(text: string): string {
  if (!text) return '';
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

export function cleanTrailingPunctuation(value: string): string {
  if (!value) return '';
  return value.replace(/[\s.)\]}'"`\\*;,!]+$/, '').trim();
}

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

export function stripHtmlTags(content: string): string {
  if (!content) return '';
  return content
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ');
}

export function decodeCloudflareEmail(content: string): string[] {
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

export function decodeObfuscatedEmails(content: string): string[] {
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

export function extractMailtoEmails(content: string): string[] {
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

export function stripNoiseContexts(content: string): string {
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

export function extractUrlsFromMarkdown(content: string): string[] {
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

export function liftBareHandles(content: string): string[] {
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

export function extractUrlsFromHtml(content: string): string[] {
  if (!content) return [];
  const urls: string[] = [];
  const regex = /href=["'](https?:\/\/[^"'\s>]+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

export function extractStructuredSocialUrls(content: string): string[] {
  if (!content) return [];
  const urls: string[] = [];

  const markdownImageLink = /\[[^\]]*!\[[^\]]*\]\([^)]*\)\]\((https?:\/\/[^)\s]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = markdownImageLink.exec(content)) !== null) urls.push(match[1]);

  const metaTags = content.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    if (!/(?:property|name)=["'](?:og:see_also|social:[^"']+)["']/i.test(tag)) continue;
    const urlMatch = tag.match(/content=["'](https?:\/\/[^"']+)["']/i);
    if (urlMatch) urls.push(urlMatch[1]);
  }

  return urls;
}

export function isGenericName(name: string): boolean {
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
