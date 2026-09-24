const BLOCKLIST_PATTERNS: RegExp[] = [
  /facebook\.com/i,
  /instagram\.com/i,
  /tiktok\.com/i,
  /twitter\.com/i,
  /x\.com/i,
  /linkedin\.com/i,
  /youtube\.com/i,
  /tripadvisor\./i,
  /yelp\.com/i,
  /signalhire\.com/i,
  /zoominfo\.com/i,
  /mapquest\.com/i,
  /justdial\.com/i,
  /wikipedia\.org/i,
  /yellowpages\.com/i,
  /manta\.com/i,
  /crunchbase\.com/i,
  /foursquare\.com/i,
  /reddit\.com/i,
  /pinterest\.com/i,
  /quora\.com/i,
  /edusanjal\.com/i,
  /collegesnepal\.com/i,
  /noshnepal\.com/i,
  /mapcarta\.com/i,
  /wikimapia\.org/i,
  /openstreetmap\.org/i,
  /play\.google\.com/i,
  /apps\.apple\.com/i,
  /slideshare\.net/i,
  /scribd\.com/i,
  /docs\.google\.com/i,
  /prezi\.com/i,
  /issuu\.com/i,
  /coursehero\.com/i,
  /studocu\.com/i,
  /eticketnepal\.com/i,
  /yopoho\.com/i,
  /khabarhub\.com/i,
  /hamropatro\.com/i,
  /onlinekhabar\.com/i,
  /ratopati\.com/i,
  /setopati\.com/i,
  /ekantipur\.com/i,
  /nagariknetwork\.com/i,
  /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|webp|svg|gif|zip|rar|gz|mp4|mp3|avi|txt|csv)(\?.*)?$/i,
  /\/wp-content\/uploads\//i,
  /\/notice-download\//i,
  /\/wp-includes\//i,
];

const PRIORITY_PATH_PATTERNS: RegExp[] = [
  /\/contact/i,
  /\/about/i,
  /\/booking/i,
  /\/enquiry/i,
  /\/reach-us/i,
  /\/our-locations/i,
  /\/branches/i,
  /\/location/i,
];

export const MULTI_PART_TLDS = [
  // Nepal
  '.com.np',
  '.edu.np',
  '.org.np',
  '.gov.np',
  '.net.np',
  '.mil.np',
  '.coop.np',
  '.museum.np',
  '.ac.np',
  // UK
  '.co.uk',
  '.org.uk',
  '.gov.uk',
  '.ac.uk',
  '.net.uk',
  // India
  '.co.in',
  '.net.in',
  '.org.in',
  '.gen.in',
  '.firm.in',
  '.ind.in',
  // Australia
  '.com.au',
  '.net.au',
  '.org.au',
  '.edu.au',
  '.gov.au',
];

export function extractEtldPlusOne(domainOrHost: string): {
  rootDomain: string;
  subdomain: string;
  sld: string;
  suffix: string;
  isSubdomain: boolean;
} {
  const host = domainOrHost
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split(':')[0];

  const matchedMulti = MULTI_PART_TLDS.find((suffix) => host.endsWith(suffix));
  if (matchedMulti) {
    const withoutSuffix = host.slice(0, -matchedMulti.length);
    const labels = withoutSuffix.split('.').filter(Boolean);
    const sld = labels[labels.length - 1] || '';
    const rootDomain = `${sld}${matchedMulti}`;
    const subLabels = labels.slice(0, -1);
    const subdomain = subLabels.join('.');
    return {
      rootDomain,
      subdomain,
      sld,
      suffix: matchedMulti,
      isSubdomain: subLabels.length > 0 && subLabels[0] !== 'www',
    };
  }

  // Standard single-dot suffix fallback
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) {
    return {
      rootDomain: host,
      subdomain: '',
      sld: labels[0] || '',
      suffix: labels[1] ? `.${labels[1]}` : '',
      isSubdomain: false,
    };
  }

  const suffix = `.${labels[labels.length - 1]}`;
  const sld = labels[labels.length - 2];
  const rootDomain = `${sld}${suffix}`;
  const subLabels = labels.slice(0, -2);
  return {
    rootDomain,
    subdomain: subLabels.join('.'),
    sld,
    suffix,
    isSubdomain: subLabels.length > 0 && subLabels[0] !== 'www',
  };
}

export const DIRECTORY_SUBDOMAIN_HOSTERS = new Set([
  'localo.site',
  'wordpress.com',
  'blogspot.com',
  'business.site',
  'wixsite.com',
  'weebly.com',
  'site123.me',
  'godaddysites.com',
  'jimdofree.com',
  'hubspotpagebuilder.com',
  'webador.com',
  'mystrikingly.com',
  'yolasite.com',
  'yellowpages.com.np',
  'biznepal.com',
  'nepalyp.com',
]);

export function isDirectoryIssuedSubdomain(domainOrUrl: string): boolean {
  if (!domainOrUrl) return false;
  const { rootDomain, isSubdomain } = extractEtldPlusOne(domainOrUrl);
  return isSubdomain && DIRECTORY_SUBDOMAIN_HOSTERS.has(rootDomain);
}

export function isSocialOrDirectory(url: string): boolean {
  if (BLOCKLIST_PATTERNS.some((pattern) => pattern.test(url))) return true;
  if (isDirectoryIssuedSubdomain(url)) return true;
  return false;
}

export function isGoogleMapsUrl(url: string): boolean {
  if (!url) return false;
  return (
    url.startsWith('google_maps:') ||
    url.includes('google.com/maps') ||
    url.includes('maps.google.com') ||
    url.includes('maps.app.goo.gl')
  );
}

function getPriorityScore(url: string): number {
  let score = 0;
  if (PRIORITY_PATH_PATTERNS.some((p) => p.test(url))) score += 10;
  if (/\.np(\/|$)/i.test(url)) score += 5;
  if (/\.com(\/|$)/i.test(url)) score += 3;
  if (/\/contact/i.test(url)) score += 5;
  if (/\/about/i.test(url)) score += 3;
  return score;
}

export function filterCandidateUrls<
  T extends {
    url: string;
    title: string;
    description?: string;
    extraSnippets?: string[];
    provider?: string;
    rank?: number;
    domain?: string;
    originalUrl?: string;
  }
>(
  candidates: T[],
  maxCount: number = 5
): T[] {
  if (candidates.length === 0) return [];

  const scrapeable = candidates.filter(
    (c) => c.url && c.url.startsWith('http') && !isGoogleMapsUrl(c.url)
  );

  const official = scrapeable.filter((c) => !isSocialOrDirectory(c.url));
  const social = scrapeable.filter((c) => isSocialOrDirectory(c.url));

  const sorted = official.sort((a, b) => getPriorityScore(b.url) - getPriorityScore(a.url));

  const result = sorted.slice(0, maxCount);

  if (result.length === 0) {
    if (social.length > 0) {
      console.warn('[URLFilter] All scrapeable candidates are social/directory — falling back to social list');
      return social.slice(0, maxCount);
    }
    console.log('[URLFilter] No scrapeable external website URLs found (all candidates are Google Maps or non-web)');
    return [];
  }

  console.log(`[URLFilter] Filtered ${candidates.length} candidates → ${result.length} official URLs (${social.length} social/directory excluded)`);
  return result;
}


