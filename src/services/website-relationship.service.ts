import { domainFromUrlOrHost } from './entity-resolution.service';
import type { WebsiteRelationship, WebsiteLifecycle } from '../mastra/agents/research-agent/verification.schema';

/**
 * Service platforms (SaaS hosts / website builders).
 */
export const SERVICE_PLATFORM_DOMAINS = new Set<string>([
  'wix.com',
  'wixsite.com',
  'wixpress.com',
  'squarespace.com',
  'wordpress.com',
  'godaddy.com',
  'sitepad.com',
  'sitepad.io',
  'softaculous.com',
  'nebuti.com',
  'yootheme.com',
  'myshopify.com',
  'shopify.com',
  'weebly.com',
  'webflow.io',
  'carrd.co',
  'cloudflare.com',
  'web.com',
  'noshnepal.com',
  'foodmandu.com',
  'pathao.com',
  'daraz.com',
  'daraz.com.np',
]);

/**
 * Directory / aggregator platforms.
 */
export const DIRECTORY_DOMAINS = new Set<string>([
  'yellowpages.com',
  'yelp.com',
  'justdial.com',
  'signalhire.com',
  'zoominfo.com',
  'manta.com',
  'crunchbase.com',
  'dnb.com',
  'indiamart.com',
  'tradeindia.com',
  'sulekha.com',
  'booking.com',
  'tripadvisor.com',
  'agoda.com',
  'airbnb.com',
  'expedia.com',
  'trivago.com',
  'searchactual.com',
  'nepalyp.com',
  'yellowpages.com.np',
  'realestateinnepal.com',
  'edusanjal.com',
  'collegesnepal.com',
  'mapcarta.com',
  'wikimapia.org',
  'openstreetmap.org',
  'restaurantguru.com',
  'usnepal.com',
  'noshnepal.com',
  'directoryofnepal.com',
  'bhansaghar.com',
  'bhansaghar.com.np',
  'skillsewa.com',
  'nepalhotel.com',
  'yandex.ru',
  'yandex.com',
  'prolinknepal.com',
  'hamrobazaar.com',
  'volza.com',
  'collegenp.com',
  'suvidhasewa.com.np',
  'aarohnepal.org',
  'virtualedufairnepal.com',
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
]);

export const DIRECTORY_LISTING_PATHS: RegExp[] = [
  /\/(restaurant|restaurants|listing|listings|business|businesses|company|companies|places|eatery|profile|catalog|vendor|classifieds?|org|services?)\/[a-z0-9_-]+/i,
];

/** Backward-compatible export combining all third-party platforms */
export const THIRD_PARTY_PLATFORMS = new Set<string>([
  ...SERVICE_PLATFORM_DOMAINS,
  ...DIRECTORY_DOMAINS,
]);

/**
 * Known corporate parent platforms mapping domain to child brand patterns.
 */
export const CORPORATE_PLATFORM_DOMAINS = new Map<string, RegExp[]>([
  ['ihg.com', [/\bholiday\s+inn\b/i, /\bcrowne\s+plaza\b/i, /\bintercontinental\b/i, /\bkimpton\b/i, /\bindigo\b/i]],
  ['marriott.com', [/\bmarriott\b/i, /\bsheraton\b/i, /\bwestin\b/i, /\brenaissance\b/i, /\bcourtyard\b/i]],
  ['hyatt.com', [/\bhyatt\b/i, /\bpark\s+hyatt\b/i, /\bgrand\s+hyatt\b/i]],
  ['accor.com', [/\bibis\b/i, /\bmercure\b/i, /\bnovotel\b/i, /\bsofitel\b/i, /\bpullman\b/i]],
  ['hilton.com', [/\bhilton\b/i, /\bhampton\b/i, /\bwaldorf\b/i, /\bconrad\b/i, /\bdoubletree\b/i]],
  ['wyndham.com', [/\bwyndham\b/i, /\bramada\b/i, /\bdays\s+inn\b/i, /\bsuper\s+8\b/i, /\bla\s+quinta\b/i]],
]);

export const VENDOR_FINGERPRINT_PATTERNS = [
  /\bpowered\s+by\s+sitepad\b/i,
  /\bbuilt\s+with\s+softaculous\b/i,
  /\bcreated\s+by\s+nebuti\b/i,
  /\/templates\/yootheme\//i,
  /\/cdn\.shopify\.com\//i,
  /\bpowered\s+by\s+wordpress\b/i,
  /\bbuilt\s+with\s+wix\b/i,
];

export const DIRECTORY_PHRASES = [
  /\bbrowse\s+businesses\b/i,
  /\bcompany\s+directory\b/i,
  /\bproperty\s+directory\b/i,
  /\byellow\s+pages\b/i,
  /\bfind\s+(?:doctors|clinics|hospitals|hotels|restaurants|businesses|agents|lawyers|properties)\b/i,
  /\bnepal\s+business\s+directory\b/i,
  /\blist\s+of\s+(?:real\s+estate|businesses|companies|hotels|doctors|properties)\b/i,
  /\bbusiness\s+listings\b/i,
  /\bclassified\s+listings\b/i,
  /\bsearch\s+businesses\b/i,
  /\bdirectory\s+of\b/i,
  /\bpopular\s+listings\b/i,
  /\blist\s+your\s+business\b/i,
  /\badd\s+your\s+listing\b/i,
  /\bclaim\s+(?:this|your)\s+listing\b/i,
  /\breal\s+estate\s+(?:directory|listings|portal)\b/i,
];

export const MARKETPLACE_PHRASES = [
  /\badd\s+to\s+cart\b/i,
  /\bvendor\s+checkout\b/i,
  /\bbuy\s+online\b/i,
  /\bcompare\s+sellers\b/i,
  /\bseller\s+registration\b/i,
  /\bmarketplace\s+sellers\b/i,
  /\bmulti-vendor\b/i,
  /\bbecome\s+a\s+seller\b/i,
  /\bbecome\s+a\s+vendor\b/i,
  /\bseller\s+dashboard\b/i,
  /\bvendor\s+rating\b/i,
  /\bshop\s+products\b/i,
];

export const CORPORATE_FAMILY_PHRASES = [
  /\bpart\s+of\s+(?:the\s+)?([A-Za-z0-9\s]+(?:group|hospitality|holdings|enterprises|corporation))\b/i,
  /\ba\s+subsidiary\s+of\b/i,
  /\bsister\s+company\s+of\b/i,
  /\bparent\s+company\b/i,
  /\bmanaged\s+by\s+([A-Za-z0-9\s]+(?:group|hospitality|management))\b/i,
  /\bmember\s+of\s+([A-Za-z0-9\s]+(?:group|chain|hotels))\b/i,
  /\bcorporate\s+group\b/i,
  /\bgroup\s+of\s+companies\b/i,
];

export function detectVendorFromContent(content?: string): string | null {
  if (!content) return null;
  for (const pattern of VENDOR_FINGERPRINT_PATTERNS) {
    if (pattern.test(content)) {
      return pattern.source;
    }
  }
  return null;
}

export function detectIndustryPortalSignals(content?: string): 'directory' | 'marketplace' | null {
  if (!content) return null;
  const isMarketplace = MARKETPLACE_PHRASES.some((p) => p.test(content));
  if (isMarketplace) return 'marketplace';
  const isDirectory = DIRECTORY_PHRASES.some((p) => p.test(content));
  if (isDirectory) return 'directory';
  return null;
}

export interface RelationshipClassification {
  relationship: WebsiteRelationship;
  isContactEnrichable: boolean;
  confidence: number;
  signals: {
    domainNameTokenMatch: boolean;
    hardBlockMatch: boolean;
    corporatePlatformMatch?: boolean;
    vendorFingerprint?: string | null;
  };
}

/**
 * Extracts meaningful tokens (>= 3 chars, no stop words) from a business name.
 */
export function extractBusinessNameTokens(businessName: string): string[] {
  const STOP_WORDS = new Set([
    'pvt',
    'ltd',
    'llc',
    'inc',
    'co',
    'corp',
    'the',
    'and',
    'of',
    'for',
    'in',
    'at',
    'to',
    'a',
    'an',
    'is',
    'or',
    'our',
    'your',
    'services',
    'service',
    'associates',
    'group',
    'company',
    'firm',
    'clean',
    'cleaning',
    'cleaners',
    'express',
    'fast',
    'quick',
    'top',
    'best',
    'pro',
    'master',
    'expert',
    'city',
    'center',
    'centre',
    'law',
    'legal',
    'lawyer',
    'lawyers',
    'office',
    'solutions',
    'global',
    'world',
    'shop',
    'store',
    'clinic',
    'house',
    'home',
    'care',
    'tech',
    'technology',
  ]);

  const normalized = businessName
    .replace(/([A-Za-z0-9])\s*[.&/]\s*([A-Za-z0-9])/g, '$1$2')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ');

  return normalized
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/**
 * Classifies the relationship between a business candidate and a website URL.
 * Hard-block platform checks ALWAYS take precedence over domain token matches.
 */
export function classifyWebsiteRelationship(
  websiteUrl: string,
  businessName: string,
  pageContent?: string,
  pageTitle?: string
): RelationshipClassification {
  const vendorFingerprint = detectVendorFromContent(pageContent);

  if (!websiteUrl || !businessName) {
    return {
      relationship: 'unverified',
      isContactEnrichable: false,
      confidence: 0,
      signals: { domainNameTokenMatch: false, hardBlockMatch: false, vendorFingerprint },
    };
  }

  const domain = domainFromUrlOrHost(websiteUrl);
  if (!domain) {
    return {
      relationship: 'unverified',
      isContactEnrichable: false,
      confidence: 0,
      signals: { domainNameTokenMatch: false, hardBlockMatch: false, vendorFingerprint },
    };
  }

  const domainLower = domain.toLowerCase();

  // STEP 1A: Service platform check (hard block for platform subdomains/domains)
  const isServicePlatform = Array.from(SERVICE_PLATFORM_DOMAINS).some(
    (platform) => domainLower === platform || domainLower.endsWith(`.${platform}`)
  );
  if (isServicePlatform) {
    return {
      relationship: 'service_platform',
      isContactEnrichable: false,
      confidence: 0.95,
      signals: { domainNameTokenMatch: false, hardBlockMatch: true, vendorFingerprint },
    };
  }

  // STEP 1B: Directory check from known domain list
  const isDirectoryDomain = Array.from(DIRECTORY_DOMAINS).some(
    (platform) => domainLower === platform || domainLower.endsWith(`.${platform}`)
  );
  if (isDirectoryDomain) {
    return {
      relationship: 'directory',
      isContactEnrichable: false,
      confidence: 0.95,
      signals: { domainNameTokenMatch: false, hardBlockMatch: true, vendorFingerprint },
    };
  }

  // STEP 1C: Portal phrase detection in content (directory vs marketplace)
  const portalType = detectIndustryPortalSignals(pageContent);
  if (portalType === 'directory') {
    return {
      relationship: 'directory',
      isContactEnrichable: false,
      confidence: 0.85,
      signals: { domainNameTokenMatch: false, hardBlockMatch: true, vendorFingerprint },
    };
  } else if (portalType === 'marketplace') {
    return {
      relationship: 'marketplace',
      isContactEnrichable: false,
      confidence: 0.85,
      signals: { domainNameTokenMatch: false, hardBlockMatch: true, vendorFingerprint },
    };
  }

  // STEP 1D: Directory listing path pattern check (e.g. /restaurant/{slug}, /places/{id})
  if (websiteUrl) {
    try {
      const pathname = new URL(websiteUrl).pathname;
      if (DIRECTORY_LISTING_PATHS.some((p) => p.test(pathname))) {
        const tokens = extractBusinessNameTokens(businessName);
        const domainTokens = domainLower.replace(/\.[^/.]+$/, '').split(/[.-]/);
        const hasDirectTokenMatch = tokens.some(
          (t) => domainTokens.includes(t) || (t.length >= 4 && domainLower.includes(t))
        );
        if (!hasDirectTokenMatch) {
          return {
            relationship: 'directory',
            isContactEnrichable: false,
            confidence: 0.9,
            signals: { domainNameTokenMatch: false, hardBlockMatch: true, vendorFingerprint },
          };
        }
      }
    } catch {
      // pass
    }
  }

  // STEP 1.5: Corporate parent check
  for (const [corpDomain, brandPatterns] of CORPORATE_PLATFORM_DOMAINS.entries()) {
    if (domainLower === corpDomain || domainLower.endsWith(`.${corpDomain}`)) {
      if (brandPatterns.some((pattern) => pattern.test(businessName))) {
        return {
          relationship: 'corporate_parent',
          isContactEnrichable: true,
          confidence: 0.7,
          signals: { domainNameTokenMatch: false, hardBlockMatch: false, corporatePlatformMatch: true, vendorFingerprint },
        };
      }
    }
  }

  // STEP 2: Name token match
  const tokens = extractBusinessNameTokens(businessName);
  const domainTokens = domainLower.replace(/\.[^/.]+$/, '').split(/[.-]/);
  const hasTokenMatch = tokens.some(
    (t) => domainTokens.includes(t) || (t.length >= 4 && domainLower.includes(t))
  );

  // Check for corporate family / sister entity signals for related_entity
  const hasCorporateFamilyEvidence = pageContent
    ? CORPORATE_FAMILY_PHRASES.some((p) => p.test(pageContent))
    : false;

  if (hasTokenMatch) {
    // If corporate family evidence exists and domain does NOT match the specific distinctive business name tokens
    // (e.g. himalayan-adventures.com for Himalayan Treks & Tours with corporate group footer)
    if (hasCorporateFamilyEvidence) {
      const specificBizTokens = tokens.filter((t) => !['nepal', 'kathmandu', 'pokhara', 'lalitpur', 'himalayan', 'national', 'global'].includes(t));
      const specificDomainTokens = domainTokens.filter((t) => !['nepal', 'kathmandu', 'pokhara', 'lalitpur', 'himalayan', 'national', 'global', 'com', 'org', 'net', 'np'].includes(t));
      const matchesSpecific = specificBizTokens.length > 0 && specificBizTokens.some((t) => domainTokens.includes(t) || domainLower.includes(t));
      const hasDivergentDomainToken = specificDomainTokens.some((dt) => !tokens.includes(dt) && dt.length >= 4);

      if (!matchesSpecific || hasDivergentDomainToken) {
        return {
          relationship: 'related_entity',
          isContactEnrichable: false,
          confidence: 0.75,
          signals: { domainNameTokenMatch: true, hardBlockMatch: false, vendorFingerprint },
        };
      }
    }

    return {
      relationship: 'first_party',
      isContactEnrichable: true,
      confidence: 0.8,
      signals: { domainNameTokenMatch: true, hardBlockMatch: false, vendorFingerprint },
    };
  }

  // Partial match / brand connection + corporate family evidence -> related_entity
  if (hasCorporateFamilyEvidence) {
    return {
      relationship: 'related_entity',
      isContactEnrichable: false,
      confidence: 0.75,
      signals: { domainNameTokenMatch: false, hardBlockMatch: false, vendorFingerprint },
    };
  }

  // STEP 2.5: Unrelated check (Clarification 2)
  // Requires all three:
  // (a) no business-name token in domain
  // (b) no business-name mention in page content
  // (c) an identifiable alternative business name in title/h1 or content
  if (pageContent || pageTitle) {
    const cleanBiz = businessName.toLowerCase().trim();
    const contentLower = (pageContent || '').toLowerCase();
    const titleLower = (pageTitle || '').toLowerCase();
    const noTokenInDomain = !hasTokenMatch;
    const noMentionInContent = !contentLower.includes(cleanBiz) && !tokens.some((t) => contentLower.includes(t));
    const hasAlternativeIdentity = titleLower.length >= 3 && !titleLower.includes(cleanBiz) && !tokens.some((t) => titleLower.includes(t));

    if (noTokenInDomain && noMentionInContent && hasAlternativeIdentity) {
      return {
        relationship: 'unrelated',
        isContactEnrichable: false,
        confidence: 0.85,
        signals: { domainNameTokenMatch: false, hardBlockMatch: false, vendorFingerprint },
      };
    }
  }

  // STEP 3: Fallback (unverified / preserve Maps identity)
  // Note: isContactEnrichable for unverified is false in Phase 3.
  return {
    relationship: 'unverified',
    isContactEnrichable: false,
    confidence: 0,
    signals: { domainNameTokenMatch: false, hardBlockMatch: false, vendorFingerprint },
  };
}

/**
 * Determines the processing lifecycle stage for a website based on extraction and verification state.
 */
export function determineWebsiteLifecycle(
  relationship: WebsiteRelationship,
  verificationStatus: 'verified' | 'partial' | 'weak' | 'failed',
  hasExtractedContent: boolean
): WebsiteLifecycle {
  if (!hasExtractedContent) {
    return 'discovered';
  }
  if (verificationStatus === 'failed' || verificationStatus === 'weak') {
    return 'usable';
  }
  if (verificationStatus === 'verified' && relationship === 'first_party') {
    return 'first_party_owned';
  }
  return 'identity_confirmed';
}

/**
 * Enforces the invariant that first_party_owned lifecycle requires first_party relationship.
 * Non-first-party sites confirming candidate identity are capped at 'identity_confirmed'.
 * Lifecycle coercion is intentional: any non-first-party relationship cannot claim first-party ownership.
 */
export function validateLifecycleRelationshipInvariant(
  lifecycle: WebsiteLifecycle,
  relationship: WebsiteRelationship
): WebsiteLifecycle {
  if (lifecycle === 'first_party_owned' && relationship !== 'first_party') {
    return 'identity_confirmed';
  }
  return lifecycle;
}
