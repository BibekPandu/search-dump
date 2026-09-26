import { extractDomain } from './search-fallback.service';
import { domainFromUrlOrHost } from './entity-resolution.service';

// ============================================================================
// Website Discovery — find the best pages of a candidate's official website
// ============================================================================
// Discovery strategy (Correction 1 — no blind-only path guessing):
//   1. Homepage is always included first.
//   2. Real same-domain internal links are parsed from the Tavily homepage
//      content (markdown links) — 0 extra API cost.
//   3. If that yields too few links, a direct homepage HTML fetch (with timeout
//      + browser User-Agent) is used to discover hrefs.
//   4. Guessed common paths (fallback_guess) are used ONLY as a last resort and
//      are explicitly marked as fallback, never as real discovery.

export type DiscoveredPageType =
  | 'home'
  | 'contact'
  | 'about'
  | 'services'
  | 'location'
  | 'team'
  | 'menu'
  | 'other';

export type DiscoverySource = 'homepage' | 'internal_link' | 'fallback_guess';

export interface DiscoveredWebsitePage {
  url: string;
  pageType: DiscoveredPageType;
  discoverySource: DiscoverySource;
}

const IGNORED_PATTERNS: RegExp[] = [
  /\/blog(\/|$)/i,
  /\/news(\/|$)/i,
  /\/article[s]?(\/|$)/i,
  /\/careers(\/|$)/i,
  /\/privacy(\/|$)/i,
  /\/terms(\/|$)/i,
  /\/login(\/|$)/i,
  /\/admin(\/|$)/i,
  /\/cart(\/|$)/i,
  /\/checkout(\/|$)/i,
  /\/search(\/|$)/i,
  /\/tag(\/|$)/i,
  /\/category(\/|$)/i,
  /\/author(\/|$)/i,
  /\/wp-json(\/|$)/i,
  /\/feed(\/|$)/i,
  /\/(img|images|assets|media|uploads?|storage|videos?|static|css|js|fonts?)(\/|$)/i,
  /\.(pdf|jpg|jpeg|png|gif|svg|webp|zip|rar|tar|gz|docx?|xlsx?|pptx?|mp4|webm|avi|mov|mkv|mp3|wav|ogg)$/i,
];

const CONTACT_PATTERNS =
  /(?:^|\/)[a-z0-9_-]*contact[a-z0-9_-]*(\.[a-z0-9]+|\/|$)|(?:\/|^)(get-in-touch|reach-us|enquiry|write-to-us|lets-connect|connect-with-us|talk-to-us|feedback)(\.[a-z0-9]+|\/|$)/i;
const ABOUT_PATTERNS = /\/(about|about-us|aboutus|who-we-are|our-company|company)(\.[a-z0-9]+|\/|$)/i;
const SERVICES_PATTERNS = /\/(services|our-services|what-we-do|solutions|products)(\.[a-z0-9]+|\/|$)/i;
const LOCATION_PATTERNS = /\/(location|locations|find-us|our-locations|branches|store-locator)(\.[a-z0-9]+|\/|$)/i;
const TEAM_PATTERNS = /\/(team|our-team|doctors|staff|leadership|founders)(\.[a-z0-9]+|\/|$)/i;
const MENU_PATTERNS = /\/(menu|pricing|rates|price-list)(\.[a-z0-9]+|\/|$)/i;

const FALLBACK_GUESSED_PATHS: Array<{ path: string; type: DiscoveredPageType }> = [
  { path: '/contact', type: 'contact' },
  { path: '/contact.php', type: 'contact' },
  { path: '/contact-us', type: 'contact' },
  { path: '/contact-us.php', type: 'contact' },
  { path: '/about', type: 'about' },
  { path: '/about.php', type: 'about' },
  { path: '/aboutus.php', type: 'about' },
  { path: '/about-us', type: 'about' },
  { path: '/services', type: 'services' },
  { path: '/our-services', type: 'services' },
  { path: '/locations', type: 'location' },
  { path: '/team', type: 'team' },
  { path: '/menu', type: 'menu' },
];

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
/**
 * Determines the page TYPE of a website URL based on path keywords.
 */
export function classifyPageType(url: string): DiscoveredPageType {
  if (!url) return 'other';
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // keep as-is
  }

  if (pathname === '/' || pathname === '') return 'home';
  if (CONTACT_PATTERNS.test(pathname)) return 'contact';
  if (ABOUT_PATTERNS.test(pathname)) return 'about';
  if (SERVICES_PATTERNS.test(pathname)) return 'services';
  if (LOCATION_PATTERNS.test(pathname)) return 'location';
  if (TEAM_PATTERNS.test(pathname)) return 'team';
  if (MENU_PATTERNS.test(pathname)) return 'menu';
  return 'other';
}

/**
 * Returns true when a URL path should be ignored (blog/news/careers/privacy/
 * terms/login/admin/cart/search/tag/category, non-HTML assets, etc.).
 */
export function isIgnoredWebsitePath(url: string): boolean {
  if (!url) return true;
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return true;
  }
  return IGNORED_PATTERNS.some((pattern) => pattern.test(pathname));
}

/**
 * Normalizes a possibly-relative href against a base URL and returns a canonical
 * same-domain absolute URL, or null when the href is unusable (cross-domain,
 * mailto/tel/javascript, fragment-only, ignored path, unparseable).
 */
export function normalizeInternalUrl(baseUrl: string, href: string): string | null {
  if (!baseUrl || !href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;

  if (/^(mailto:|tel:|javascript:|data:|#)/i.test(trimmed)) return null;

  // Bare-host hrefs (e.g. "www.example.com/about") occur in markdown content
  // parsed from page text. URL() would treat them as relative paths, so detect
  // a domain-like shape and promote it to https:// before resolution.
  // CRITICAL: Web files with extensions (e.g. contact.php, about.html) are relative paths, NOT domains!
  const isWebFile = /\.(php|html?|aspx?|jsp|do|action|cgi|css|js|png|jpe?g|gif|svg|ico)$/i.test(
    trimmed.split(/[?#]/)[0]
  );

  let parseSource = trimmed;
  if (!isWebFile && !trimmed.startsWith('/') && !trimmed.startsWith('./') && !trimmed.startsWith('../')) {
    const firstSegment = trimmed.split(/[/?#]/)[0];
    const isDomain =
      /^www\.[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/i.test(trimmed) ||
      /\.(com|org|net|edu|gov|io|co|np|com\.np|org\.np|biz|info|me|tv|ai|app|dev)$/i.test(firstSegment);
    if (isDomain) {
      parseSource = `https://${trimmed}`;
    }
  }

  let abs: URL;
  try {
    abs = new URL(parseSource, baseUrl);
  } catch {
    return null;
  }

  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;

  const baseHost = domainFromUrlOrHost(baseUrl);
  const absHost = domainFromUrlOrHost(abs.href);
  if (!baseHost || !absHost) return null;
  if (baseHost !== absHost) return null;

  if (isIgnoredWebsitePath(abs.href)) return null;

  // Canonical form: strip leading "www." from the host (matches the codebase's
  // normalizeUrl/extractDomain convention and makes dedupe stable across
  // www/non-www variants), strip fragment + query, strip trailing slash.
  if (abs.hostname.startsWith('www.') && abs.hostname.length > 4) {
    abs.hostname = abs.hostname.slice(4);
  }

  // Canonicalize default homepage filenames (/index.html, /index.php, /home, etc.) to root /
  if (/^\/(index\.(html?|php|htm|aspx?)|default\.(html?|php|asp)|home)\/?$/i.test(abs.pathname)) {
    abs.pathname = '/';
  }

  abs.hash = '';
  abs.search = '';
  const canonical = abs.href.replace(/\/+$/, '');

  return canonical;
}

const PAGE_TYPE_PRIORITY: Record<DiscoveredPageType, number> = {
  home: 0,
  contact: 8,
  about: 7,
  services: 6,
  location: 5,
  team: 4,
  menu: 3,
  other: 1,
};

/**
 * Normalizes, dedupes, drops ignored URLs, and ranks same-domain internal links
 * by usefulness (contact > about > services > location > team > menu > other),
 * with a stable tie-break preserving discovery order. Returns at most maxPages.
 */
export function prioritizeInternalLinks(
  baseUrl: string,
  links: string[],
  maxPages: number
): DiscoveredWebsitePage[] {
  const seen = new Set<string>();
  const pages: DiscoveredWebsitePage[] = [];

  for (const link of links) {
    const canonical = normalizeInternalUrl(baseUrl, link);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    pages.push({
      url: canonical,
      pageType: classifyPageType(canonical),
      discoverySource: 'internal_link',
    });
  }

  const ranked = pages
    .map((p) => ({ ...p }))
    .sort((a, b) => {
      if (PAGE_TYPE_PRIORITY[b.pageType] !== PAGE_TYPE_PRIORITY[a.pageType]) {
        return PAGE_TYPE_PRIORITY[b.pageType] - PAGE_TYPE_PRIORITY[a.pageType];
      }
      return pages.indexOf(a) - pages.indexOf(b);
    });

  return ranked.slice(0, maxPages);
}
/**
 * Parses markdown-style links [text](href) out of Tavily homepage content.
 */
function parseMarkdownLinks(content: string): string[] {
  if (!content) return [];
  const results: string[] = [];
  const regex = /\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const href = match[1].trim();
    if (href && !href.startsWith('#')) results.push(href);
  }
  return results;
}

/**
 * Semantic contact vocabulary for ANCHOR TEXT (link labels). Paths get the more
 * conservative CONTACT_PATTERNS set; anchor text may use richer language.
 */
const CONTACT_ANCHOR_TEXT = /\b(contact|contacts|reach|connect|support|help|enquiry|enquiries|enquire|feedback|write|talk|touch|find\s*us|where\s*to\s*find\s*us)\b/i;

/**
 * Extracts contact-candidate links from markdown [text](href) pairs by ANCHOR
 * TEXT semantics — catches custom pages and semantic variations (page-contact,
 * get-in-touch, reach-us) that path keywords may miss or rank too low.
 */
export function extractContactLinksFromMarkdown(content: string): string[] {
  if (!content) return [];
  const links: string[] = [];
  const regex = /\[([^\]]*)\]\(([^)]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const text = match[1].toLowerCase();
    const href = match[2].trim();
    if (!href) continue;
    if (CONTACT_ANCHOR_TEXT.test(text)) links.push(href);
  }
  return links;
}

/**
 * Directly fetches the homepage HTML (with timeout + browser User-Agent) and
 * extracts anchor hrefs. Returns [] on any failure (degradation is designed in).
 */
async function fetchHomepageHrefs(baseUrl: string, timeoutMs: number): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(baseUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      clearTimeout(timer);
      return [];
    }

    const html = await response.text();
    clearTimeout(timer);
    const anchors: string[] = [];
    const regex = /<a[^>]*href=["']([^"']+)["'][^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
      anchors.push(match[1].trim());
    }
    return anchors;
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[WebsiteDiscovery] Homepage fetch failed for ${baseUrl}:`, (err as Error).message);
    return [];
  }
}

/**
 * Builds the fallback guessed-path set, deduped against already-discovered URLs
 * and marked as 'fallback_guess'.
 */
function buildFallbackPages(baseUrl: string, existing: Set<string>, maxPages: number): DiscoveredWebsitePage[] {
  const baseNoSlash = baseUrl.replace(/\/+$/, '');
  const used = new Set(existing);
  const pages: DiscoveredWebsitePage[] = [];

  let originUrl = '';
  try {
    const parsed = new URL(baseUrl);
    originUrl = parsed.origin;
  } catch {
    originUrl = baseNoSlash;
  }

  // If baseUrl has a subpath (e.g. /cafe), include the root origin as a high-priority fallback page
  if (originUrl && originUrl !== baseNoSlash && !used.has(originUrl)) {
    used.add(originUrl);
    pages.push({ url: originUrl, pageType: 'home', discoverySource: 'fallback_guess' });
    if (pages.length >= maxPages) return pages;
  }

  for (const guess of FALLBACK_GUESSED_PATHS) {
    let url: string;
    try {
      url = new URL(guess.path, originUrl || baseUrl).href.replace(/\/+$/, '');
    } catch {
      url = `${baseNoSlash}${guess.path}`;
    }
    if (used.has(url)) continue;
    used.add(url);
    pages.push({ url, pageType: guess.type, discoverySource: 'fallback_guess' });
    if (pages.length >= maxPages) break;
  }

  return pages;
}

/**
 * Discovers the best pages (max 5) of a candidate's official website.
 *
 * Strategy (v1.3 — Contact Page Guaranteed Priority):
 *   1. Homepage always first (discoverySource 'homepage').
 *   2. Same-domain internal links parsed from Tavily homepage markdown content
 *      (tavilyHomepageContent) — 0 extra cost. Evaluated UNCAPPED so we know
 *      whether ANY contact page exists before spending a network fetch.
 *   3. Direct homepage fetch + href parse. MUST run when markdown provided no
 *      contact page (package/blog clutter starved it) even if the page quota
 *      looks full — the footer/nav contact link outranks any package link.
 *   4. Merged candidate pool ranked with CONTACT pages taking strict priority
 *      over 'other'/'package' links, so /contact is never pushed out of the
 *      5-page quota (Gorkha failure: 4 package links evicted the contact page).
 *   5. Not-yet-covered priority pages are filled with fallback_guess paths.
 *
 * Never throws: every network failure degrades to the fallback strategy.
 */
export async function discoverWebsitePages(
  baseUrl: string,
  options: { maxPages?: number; timeoutMs?: number; tavilyHomepageContent?: string } = {}
): Promise<DiscoveredWebsitePage[]> {
  const { maxPages = 5, timeoutMs = 10000, tavilyHomepageContent } = options;
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return [];

  const homepageUrl = baseUrl.replace(/\/+$/, '');
  // Evaluation cap well above the page quota: ranking needs the FULL link set
  // to decide whether a contact page exists anywhere in markdown.
  const evaluationCap = Math.max(maxPages * 2, 20);

  // Phase 1: parse internal links from any already-available markdown content.
  const markdownLinks = parseMarkdownLinks(tavilyHomepageContent || '');
  const contactAnchorLinks = extractContactLinksFromMarkdown(tavilyHomepageContent || '');
  const allLinks = [...new Set([...markdownLinks, ...contactAnchorLinks])];
  const markdownCandidates = prioritizeInternalLinks(homepageUrl, allLinks, evaluationCap);
  const hasMarkdownContact = markdownCandidates.some((p) => p.pageType === 'contact');

  // Phase 2: homepage raw HTML href scan. MUST run when:
  //   - markdown yielded no contact page (clutter starvation), OR
  //   - there is still room in the page quota.
  let fetchedCandidates: DiscoveredWebsitePage[] = [];
  if (!hasMarkdownContact || markdownCandidates.length < maxPages - 1) {
    const fetchedHrefs = await fetchHomepageHrefs(homepageUrl, timeoutMs);
    if (fetchedHrefs.length > 0) {
      fetchedCandidates = prioritizeInternalLinks(homepageUrl, fetchedHrefs, evaluationCap);
    }
  }

  // Phase 3: merge (markdown first for stable tie-breaks), then rank with the
  // established page-type priority — contact (highest) always survives the
  // quota cut even when the pool is dominated by package/blog links.
  const merged: DiscoveredWebsitePage[] = [];
  const seen = new Set<string>();
  for (const page of [...markdownCandidates, ...fetchedCandidates]) {
    if (seen.has(page.url)) continue;
    seen.add(page.url);
    merged.push(page);
  }
  const ranked = merged
    .map((page, index) => ({ page, index }))
    .sort((a, b) => {
      const pa = PAGE_TYPE_PRIORITY[a.page.pageType] ?? 0;
      const pb = PAGE_TYPE_PRIORITY[b.page.pageType] ?? 0;
      if (pa !== pb) return pb - pa;
      return a.index - b.index;
    })
    .map(({ page }) => page);

  const pages: DiscoveredWebsitePage[] = [
    { url: homepageUrl, pageType: 'home', discoverySource: 'homepage' },
    ...ranked.slice(0, maxPages - 1),
  ];
  const discovered = new Set(pages.map((p) => p.url));

  // Phase 4: LAST resort — guessed common paths (explicitly marked fallback).
  if (pages.length < maxPages) {
    const fallbacks = buildFallbackPages(homepageUrl, discovered, maxPages - pages.length);
    pages.push(...fallbacks);
  }

  return pages.slice(0, maxPages).map((p) => ({
    url: p.url,
    pageType: p.pageType,
    discoverySource: p.discoverySource,
  }));
}

export function extractDomainFromUrl(url: string): string {
  return extractDomain(url);
}