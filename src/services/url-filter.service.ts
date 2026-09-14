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

export function isSocialOrDirectory(url: string): boolean {
  return BLOCKLIST_PATTERNS.some((pattern) => pattern.test(url));
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


