import { type UnifiedSearchResult, type CategoryIntent } from './search-fallback.service';
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
  'yellowpages.com.np',
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
  'edusanjal.com',
  'collegesnepal.com',
  'noshnepal.com',
  'mapcarta.com',
  'restaurantguru.com',
  'usnepal.com',
  'directoryofnepal.com',
  'wikimapia.org',
  'openstreetmap.org',
  'bhansaghar.com',
  'bhansaghar.com.np',
  'skillsewa.com',
  'nepalhotel.com',
  'yandex.ru',
  'yandex.com',
  'booking.com',
  'agoda.com',
  'tripadvisor.com',
  'airbnb.com',
  'expedia.com',
  'trivago.com',
  'searchactual.com',
  'realestateinnepal.com',
  'prolinknepal.com',
  'hamrobazaar.com',
  'volza.com',
  'collegenp.com',
  'suvidhasewa.com.np',
  'aarohnepal.org',
  'virtualedufairnepal.com',
  'play.google.com',
  'apps.apple.com',
  'merokirana.com',
  'nepalhomesearch.com',
  'bihebazaar.com',
  'playo.co',
  'cybo.com',
  'turantcall.com',
  'findallnepal.com',
  'scorchdeal.com',
  'hospitalnepal.com',
  'nepalcompany.com',
  'inquirynepal.com',
  'esscobathware.com',
  'companynepal.com',
  'nepalbusinessdirectory.com',
  'biznepal.com',
  'ghargharsewa.com',
  'gamatrain.com',
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
  'khabarhub.com',
  'english.khabarhub.com',
  'hamropatro.com',
  'onlinekhabar.com',
  'ratopati.com',
  'setopati.com',
  'nagariknetwork.com',
  'ekantipur.com',
  'thehimalayantimes.com',
  'nepalnews.com',
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

export const DIRECTORY_LISTING_PATHS: RegExp[] = [
  /\/(restaurant|restaurants|listing|listings|business|businesses|company|companies|places|eatery|profile|catalog|vendor|classifieds?|org|services?)\/[a-z0-9_-]+/i,
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

  // 2b. Check directory listing template path pattern
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }

  const isDirectoryListingPath = DIRECTORY_LISTING_PATHS.some((pattern) => pattern.test(pathname));
  if (isDirectoryListingPath && !DIRECT_BUSINESS_PATHS.some((pattern) => pattern.test(pathname))) {
    return {
      status: 'excluded',
      classification: 'directory',
      confidence: 0.9,
      reason: `Directory listing template path detected (${pathname})`,
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

// ============================================================================
// Strict Tri-State Category Relevance Classifier (Phase 4)
// ============================================================================

export type RelevanceStatus = 'relevant' | 'irrelevant' | 'ambiguous';

export interface RelevanceResult {
  status: RelevanceStatus;
  reason: string;
  confidence: number;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Checks if a candidate is relevant to the CategoryIntent.
 *
 * Rules:
 * 1. Empty/null candidate name -> status: 'ambiguous', reason: 'EMPTY_CANDIDATE_NAME', confidence: 0.00
 * 2. Narrow query (!intent.isBroad) -> status: 'relevant', reason: 'NARROW_QUERY_NO_FILTER', confidence: 1.00
 * 3. Excluded terms matching (declaration order, word boundary) -> status: 'irrelevant', reason: `EXCLUDED_TERM_MATCH:${term}`, confidence: 0.95
 * 4. Tier 1: Category positive term AND business form noun -> status: 'relevant', reason: 'CATEGORY_AND_FORM_MATCH', confidence: 0.90
 * 5. Tier 2: Distinctive sport token -> status: 'relevant', reason: 'CATEGORY_TOKEN_MATCH', confidence: 0.85
 * 6. Ambiguous default (generic sports alone without form noun, or insufficient signals) -> status: 'ambiguous', reason: 'INSUFFICIENT_CATEGORY_EVIDENCE', confidence: 0.30
 */
export function checkCategoryRelevance(
  candidateName: string | undefined | null,
  candidateCategory: string | undefined | null,
  intent: CategoryIntent
): RelevanceResult {
  // 1. Empty or null candidate name guard (fires first)
  if (!candidateName || !candidateName.trim()) {
    return {
      status: 'ambiguous',
      reason: 'EMPTY_CANDIDATE_NAME',
      confidence: 0.0,
    };
  }

  // 2. Narrow query bypass: no expansion was performed, so no broad filtering is applied
  if (!intent.isBroad) {
    return {
      status: 'relevant',
      reason: 'NARROW_QUERY_NO_FILTER',
      confidence: 1.0,
    };
  }

  const combinedText = `${candidateName.trim()} ${candidateCategory ? candidateCategory.trim() : ''}`.toLowerCase();

  // 3. Excluded terms matching in declaration order with word boundaries
  for (const excluded of intent.excludedTerms) {
    const pattern = new RegExp(`\\b${escapeRegex(excluded.toLowerCase())}\\b`, 'i');
    if (pattern.test(combinedText)) {
      return {
        status: 'irrelevant',
        reason: `EXCLUDED_TERM_MATCH:${excluded}`,
        confidence: 0.95,
      };
    }
  }

  // 4. Tier 1: Category positive term AND business form noun
  const hasPositiveTerm = intent.positiveTerms.some((term) => {
    const pattern = new RegExp(`\\b${escapeRegex(term.toLowerCase())}\\b`, 'i');
    return pattern.test(combinedText);
  });

  const hasBusinessForm = intent.businessFormTerms.some((term) => {
    const pattern = new RegExp(`\\b${escapeRegex(term.toLowerCase())}\\b`, 'i');
    return pattern.test(combinedText);
  });

  if (hasPositiveTerm && hasBusinessForm) {
    return {
      status: 'relevant',
      reason: 'CATEGORY_AND_FORM_MATCH',
      confidence: 0.90,
    };
  }

  // 5. Tier 2: Distinctive sport token (e.g. futsal, taekwondo, badminton) without requiring form noun
  const hasDistinctiveSport = intent.distinctiveTerms.some((term) => {
    const pattern = new RegExp(`\\b${escapeRegex(term.toLowerCase())}\\b`, 'i');
    return pattern.test(combinedText);
  });

  if (hasDistinctiveSport) {
    return {
      status: 'relevant',
      reason: 'CATEGORY_TOKEN_MATCH',
      confidence: 0.85,
    };
  }

  // 6. Strict ambiguous default (generic 'sports' alone without form noun, or missing category evidence)
  return {
    status: 'ambiguous',
    reason: 'INSUFFICIENT_CATEGORY_EVIDENCE',
    confidence: 0.30,
  };
}

