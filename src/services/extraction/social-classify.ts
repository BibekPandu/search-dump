/**
 * Social profile classification and ownership decisions.
 *
 * The core stage: given a profile URL plus business context, decide
 * platform, handle, ownership and acceptance status. Token-alignment
 * rules (acronym, brand overlap, category-generic stripping,
 * cross-vertical conflicts) all live inside this single decision path.
 */

import type { ClassifiedSocialProfile } from '@/types/social.js';
import {
  INDUSTRY_GENERIC_TOKENS,
  UNIVERSAL_STOPWORDS,
  NEPAL_LOCALITY_TOKENS,
  CATEGORY_GENERIC_TOKENS,
  CATEGORY_VERTICALS,
  GEOGRAPHIC_MODIFIERS,
  CONFLICTING_VERTICAL_TOKENS,
  PLATFORM_OFFICIAL_HANDLES,
  KNOWN_VENDOR_SOCIAL_HANDLES,
  FACEBOOK_RESERVED_PATHS,
  FB_NAMESPACE_PATHS,
  TWITTER_RESERVED_PATHS,
  INSTAGRAM_RESERVED_PATHS,
} from '@/config/token-vocabulary.config';
import { resolveCategoryKey } from '@/services/extraction/category-token.service';
import { decodeHtmlEntities, domainFromUrlOrHost } from '@/services/extraction/content-normalization.service';
import {
  extractFacebookHandle,
  computeCanonicalSocialUrl,
  brandSegmentFromBusinessName,
  isReservedNamespaceAction,
  requiredSocialNameOverlap,
} from '@/services/extraction/social-url';

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

  const decodedUrl = decodeHtmlEntities(url);
  let parsed: URL;
  try {
    parsed = new URL(decodedUrl);
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
    if (
      FACEBOOK_RESERVED_PATHS.has(firstSegment) ||
      (FB_NAMESPACE_PATHS.has(firstSegment) && isReservedNamespaceAction(pathSegments))
    ) {
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
        const cleanUrl = `https://facebook.com/profile.php?id=${id}`;
        return {
          url: cleanUrl,
          canonicalUrl: cleanUrl,
          platform: plat,
          handle: id,
          profileType: 'business_page',
          owner: origin === 'website_evidence' ? 'business' : 'unknown',
          status: origin === 'website_evidence' ? 'accepted' : 'unknown',
          confidence: origin === 'website_evidence' ? 0.95 : 0.6,
          rejectionReason: origin === 'website_evidence' ? 'NONE' : 'INSUFFICIENT_EVIDENCE',
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
    const isNamespacePattern = FB_NAMESPACE_PATHS.has(firstSegment) && pathSegments.length > 1;

    if (!isNamespacePattern && firstSegment.length < 3) {
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
  if (plat === 'facebook') {
    const fbHandle = extractFacebookHandle(pathSegments);
    if (fbHandle) {
      handle = fbHandle;
    }
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
  const resolvedCategoryKey = resolveCategoryKey(categoryContext, businessName);
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

  // Generic + Locality + Descriptor tokens to filter out from distinctive brand set
  const nonDistinctiveTokens = new Set<string>([
    ...categoryGenericTokens,
    ...CATEGORY_VERTICALS,
    ...NEPAL_LOCALITY_TOKENS,
    ...GEOGRAPHIC_MODIFIERS,
    'branch',
    'pvt',
    'ltd',
    'private',
    'limited',
    'center',
    'centre',
    'speciality',
    'multispeciality',
    'department',
    'dept',
  ]);

  // Distinctive business tokens (generic, locality, and descriptor terms filtered out)
  let distinctiveBusinessTokens: string[] = brandBusinessName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !nonDistinctiveTokens.has(t));

  // Fallback: If stripping left no distinctive tokens, preserve full business tokens (minus stop words/geo)
  if (distinctiveBusinessTokens.length === 0) {
    distinctiveBusinessTokens = brandBusinessName
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2 && !NEPAL_LOCALITY_TOKENS.has(t) && !GEOGRAPHIC_MODIFIERS.has(t) && !UNIVERSAL_STOPWORDS.has(t));
  }

  if (websiteDomain) {
    let domainLabel = domainFromUrlOrHost(websiteDomain);
    domainLabel = domainLabel.split('.')[0]?.toLowerCase() || '';
    const domainWords = domainLabel
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 2 && !nonDistinctiveTokens.has(w));
    for (const dw of domainWords) {
      if (!distinctiveBusinessTokens.includes(dw)) {
        distinctiveBusinessTokens.push(dw);
      }
    }
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
    // Primary brand token (longest distinctive token in the brand name)
    const sortedDistinctiveTokens = [...uniqueDistinctiveBusinessTokens].sort((a, b) => b.length - a.length);
    const primaryBrandToken = sortedDistinctiveTokens[0];

    // Phase 8L Component 8 (D21 Initialism Corroboration Rule):
    // If the only matching distinctive tokens are short (<= 3 characters, e.g. "apf", "rs", "nk", "ab"),
    // an initialism alone is ambiguous. Require at least one corroborating signal:
    //  1. Brand-root match: handle starts with the business's distinctive brand token (e.g. "idpstudyabroad.nepal", "idpnepal")
    //  2. A category token from the vertical or CATEGORY_VERTICALS
    //  3. A locality/country token from NEPAL_LOCALITY_TOKENS or GEOGRAPHIC_MODIFIERS
    //  4. Another distinctive business token with length >= 4
    const onlyShortTokens = matchingDistinctive.every((t) => t.length <= 3);
    if (onlyShortTokens) {
      // Brand-root fast path: If handle starts with the business's distinctive brand token,
      // it is an authentic brand handle (e.g. "idp" in "idpstudyabroad.nepal"), not an ambiguous mid-string coincidence (e.g. "somewhere.idp.nested").
      const startsWithBrandToken = uniqueDistinctiveBusinessTokens.some(
        (t) => t.length >= 2 && (cleanHandle.startsWith(t) || allHandleWords[0] === t)
      );

      const hasCategoryCorroboration =
        resolvedCategoryTokens.some((catToken) =>
          catToken.length >= 3 && (cleanHandle.includes(catToken) || allHandleWords.includes(catToken))
        ) ||
        Array.from(CATEGORY_VERTICALS).some((vertToken) =>
          vertToken.length >= 3 && (cleanHandle.includes(vertToken) || allHandleWords.includes(vertToken))
        );
      const hasLocationCorroboration =
        Array.from(NEPAL_LOCALITY_TOKENS).some((locToken) =>
          locToken.length >= 3 && (cleanHandle.includes(locToken) || allHandleWords.includes(locToken))
        ) ||
        Array.from(GEOGRAPHIC_MODIFIERS).some((geoToken) =>
          geoToken.length >= 3 && (cleanHandle.includes(geoToken) || allHandleWords.includes(geoToken))
        );
      const hasLongDistinctiveOverlap = uniqueDistinctiveBusinessTokens.some(
        (bt) => bt.length >= 4 && (cleanHandle.includes(bt) || allHandleWords.includes(bt))
      );

      if (!startsWithBrandToken && !hasCategoryCorroboration && !hasLocationCorroboration && !hasLongDistinctiveOverlap) {
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

    // Qualitative Brand-Match Rule:
    // Accept if:
    // (a) Handle matches the primary brand token (length >= 4 or longest distinctive token)
    // (b) Handle matches >= 2 distinctive tokens
    // AND the handle does not contain conflicting distinctive tokens from an unrelated brand
    const hasPrimaryOrLongMatch = matchingDistinctive.some(
      (t) => (primaryBrandToken && t === primaryBrandToken && t.length >= 3) || t.length >= 4
    );

    const unmatchedDistinctiveHandleTokens = distinctiveHandleTokens.filter(
      (dh) =>
        !matchingDistinctive.includes(dh) &&
        !nonDistinctiveTokens.has(dh) &&
        !NEPAL_LOCALITY_TOKENS.has(dh) &&
        !GEOGRAPHIC_MODIFIERS.has(dh) &&
        !CATEGORY_VERTICALS.has(dh) &&
        !matchingDistinctive.some((md) => md.length >= 3 && dh.includes(md)) &&
        !normalizedBusinessName.includes(dh) &&
        !normalizedBrandName.includes(dh)
    );

    const hasConflictingBrandInHandle = unmatchedDistinctiveHandleTokens.some(
      (tok) => tok.length >= 4 && !cleanHandle.startsWith(primaryBrandToken || '') && !allHandleWords.includes(primaryBrandToken || '')
    );

    if ((hasPrimaryOrLongMatch || matchingDistinctive.length >= 2) && !hasConflictingBrandInHandle) {
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

    const requiredOverlap = requiredSocialNameOverlap(uniqueDistinctiveBusinessTokens.length);
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
