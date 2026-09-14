import { type UnifiedSearchResult } from './search-fallback.service';
import {
  type CandidateType,
  type ResearchDecision,
} from '../mastra/agents/research-agent/schema';

// ============================================================================
// Domain & Pattern Dictionaries
// ============================================================================

export const AGGREGATOR_DOMAINS = new Set([
  'booking.com',
  'agoda.com',
  'hotels.com',
  'tripadvisor.com',
  'tripadvisor.co.uk',
  'tripadvisor.in',
  'goibibo.com',
  'makemytrip.com',
  'expedia.com',
  'expedia.co.uk',
  'trivago.com',
  'trivago.in',
  'kayak.com',
  'airbnb.com',
  'hostelworld.com',
  'hotelscombined.com',
  'priceline.com',
  'orbitz.com',
  'travelocity.com',
  'skyscanner.com',
  'cleartrip.com',
  'yatra.com',
  'oyorooms.com',
  'easemytrip.com',
  'momondo.com',
  'lastminute.com',
  'hotwire.com',
  'vrbo.com',
  'boutiquehotel.me',
  'hometogo.com',
  'couchsurfing.com',
]);

export const DIRECTORY_DOMAINS = new Set([
  'yellowpages.com',
  'justdial.com',
  'yelp.com',
  'signalhire.com',
  'zoominfo.com',
  'manta.com',
  'crunchbase.com',
  'foursquare.com',
  'mapquest.com',
  'nepalyp.com',
  'dnb.com',
  'kompass.com',
  'indiamart.com',
  'tradeindia.com',
  'sulekha.com',
  'whitepages.com',
  'superpages.com',
  'bbb.org',
  'trustpilot.com',
  'sitejabber.com',
]);

export const SOCIAL_DOMAINS = new Set([
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'youtube.com',
  'reddit.com',
  'quora.com',
  'pinterest.com',
  'wikipedia.org',
  'medium.com',
  'tumblr.com',
  'threads.net',
]);

export const CONTENT_TRAVEL_DOMAINS = new Set([
  'thecommonwanderer.com',
  'thehoteljournal.com',
  'lonelyplanet.com',
  'travelandleisure.com',
  'cntraveler.com',
  'timeout.com',
  'culturetrip.com',
  'nomadicmatt.com',
  'fulltimeexplorer.com',
  'roundtheworldrachel.com',
  'travelinsighter.com',
  'sprudge.com',
  'thelongestwayhome.com',
]);

const NON_ENTITY_PATHS: RegExp[] = [
  /\/blog(\/|$)/i,
  /\/news(\/|$)/i,
  /\/article[s]?(\/|$)/i,
  /\/stories(\/|$)/i,
  /\/guides?(\/|$)/i,
  /\/careers(\/|$)/i,
  /\/privacy(\/|$)/i,
  /\/terms(\/|$)/i,
  /\/tag(\/|$)/i,
  /\/category(\/|$)/i,
  /\/author(\/|$)/i,
  /\/city\/[a-z0-9_-]+\.html/i,
];

const LISTICLE_TITLE_PATTERNS: RegExp[] = [
  /\b(top|best|\d+)\s+(best|top|luxury|cheap|boutique)?\s*(hotels|cafes|coffee|restaurants|places|things to do|spots|stays)\b/i,
  /\bwhere to stay\b/i,
  /\bthe\s+\d+\s+best\b/i,
  /\bguide to\b/i,
  /\b\d+\s+best\s+hotels\b/i,
  /\b\d+\s+best\s+cafes\b/i,
  /\b\d+\s+best\s+restaurants\b/i,
];

const DIRECT_BUSINESS_PATHS: RegExp[] = [
  /^\/?$/,
  /\/contact(\/|$)/i,
  /\/about(\/|$)/i,
  /\/rooms(\/|$)/i,
  /\/menu(\/|$)/i,
  /\/services(\/|$)/i,
  /\/location(\/|$)/i,
  /\/accommodation(\/|$)/i,
  /\/amenities(\/|$)/i,
  /\/dining(\/|$)/i,
  /\/stay(\/|$)/i,
  /\/enquiry(\/|$)/i,
  /\/reach-us(\/|$)/i,
  /\/destination\/[a-z0-9_-]+/i,
];

const FIRST_PERSON_SIGNALS: RegExp[] = [
  /\b(our hotel|our rooms|our cafe|our restaurant|welcome to|we offer|located in the heart of|situated in|book direct|official site|official website)\b/i,
  /\b(free wifi|room service|front desk|guestrooms|boutique rooms|swimming pool|dining)\b/i,
];

// ============================================================================
// Classification Functions
// ============================================================================

export interface ClassificationResult {
  status: 'usable' | 'excluded' | 'ambiguous';
  classification: CandidateType;
  confidence: number;
  reason: string;
}

export function classifySearchResult(candidate: UnifiedSearchResult): ClassificationResult {
  const domain = (candidate.domain || '').toLowerCase().replace(/^www\./, '');
  const url = candidate.url || '';
  const title = candidate.title || '';
  const description = candidate.description || '';

  // 1. Check known booking aggregators
  if (AGGREGATOR_DOMAINS.has(domain) || /tripadvisor\./i.test(domain) || /booking\.com/i.test(domain)) {
    return {
      status: 'excluded',
      classification: 'aggregator',
      confidence: 1.0,
      reason: `Known booking aggregator domain: ${domain}`,
    };
  }

  // 2. Check known business & company directories
  if (DIRECTORY_DOMAINS.has(domain)) {
    return {
      status: 'excluded',
      classification: 'directory',
      confidence: 1.0,
      reason: `Known directory domain: ${domain}`,
    };
  }

  // 3. Check social and forum platforms
  if (SOCIAL_DOMAINS.has(domain)) {
    return {
      status: 'excluded',
      classification: 'social',
      confidence: 1.0,
      reason: `Social media or content community: ${domain}`,
    };
  }

  // 4. Check path-based article/blog/listicle indicators
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }

  const isArticlePath = NON_ENTITY_PATHS.some((pattern) => pattern.test(pathname));
  const isListicleTitle = LISTICLE_TITLE_PATTERNS.some((pattern) => pattern.test(title));
  const isTravelGuideDomain = CONTENT_TRAVEL_DOMAINS.has(domain);

  if (isTravelGuideDomain || (isArticlePath && isListicleTitle)) {
    return {
      status: 'excluded',
      classification: 'article',
      confidence: 0.95,
      reason: `Article, blog, or travel guide content: ${title || domain}`,
    };
  }

  if (isArticlePath) {
    return {
      status: 'excluded',
      classification: 'article',
      confidence: 0.9,
      reason: `Blog or article path detected (${pathname})`,
    };
  }

  // 5. Check strong direct business website signals
  const isDirectPath = DIRECT_BUSINESS_PATHS.some((pattern) => pattern.test(pathname));
  const hasFirstPersonSignal = FIRST_PERSON_SIGNALS.some(
    (pattern) => pattern.test(description) || pattern.test(title)
  );

  // If domain looks like an official single-entity brand and has direct business signals
  if (!isListicleTitle && (isDirectPath || hasFirstPersonSignal)) {
    return {
      status: 'usable',
      classification: 'business',
      confidence: 0.9,
      reason: `Official single-entity brand website with direct business offerings (${domain})`,
    };
  }

  // If title is a pure brand name on root or shallow path without aggregator patterns
  if (!isListicleTitle && (pathname === '/' || pathname === '')) {
    return {
      status: 'usable',
      classification: 'business',
      confidence: 0.85,
      reason: `Root homepage for single business domain (${domain})`,
    };
  }

  // 6. Ambiguous: unrecognized domain or mixed signals requiring LLM verification
  return {
    status: 'ambiguous',
    classification: 'business', // default hypothesis; LLM will verify
    confidence: 0.5,
    reason: `Unrecognized domain with mixed signals: ${domain} (requires LLM classification)`,
  };
}

export function filterSearchResults(candidates: UnifiedSearchResult[]): {
  usable: Array<{ candidate: UnifiedSearchResult; decision: ResearchDecision }>;
  excluded: Array<{ candidate: UnifiedSearchResult; decision: ResearchDecision }>;
  ambiguous: Array<{ candidate: UnifiedSearchResult; decision: ResearchDecision }>;
} {
  const usable: Array<{ candidate: UnifiedSearchResult; decision: ResearchDecision }> = [];
  const excluded: Array<{ candidate: UnifiedSearchResult; decision: ResearchDecision }> = [];
  const ambiguous: Array<{ candidate: UnifiedSearchResult; decision: ResearchDecision }> = [];

  for (const candidate of candidates) {
    const classification = classifySearchResult(candidate);
    const decision: ResearchDecision = {
      url: candidate.url,
      domain: candidate.domain,
      title: candidate.title,
      classification: classification.classification,
      confidence: classification.confidence,
      reason: classification.reason,
      source: 'deterministic',
    };

    if (classification.status === 'usable') {
      usable.push({ candidate, decision });
    } else if (classification.status === 'excluded') {
      excluded.push({ candidate, decision });
    } else {
      ambiguous.push({ candidate, decision });
    }
  }

  return { usable, excluded, ambiguous };
}
