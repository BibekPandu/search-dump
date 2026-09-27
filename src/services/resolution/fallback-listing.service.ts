/**
 * Deterministic fallback listing resolution service.
 */
import type { UnifiedSearchResult } from '@/types/search';
import type { VerifiedBusinessEvidence } from '@/types/verification';
import type { BusinessListing } from '@/types/business-listing';
import {
  domainFromUrlOrHost,
  normalizeNameKey,
  normalizePhoneDigits,
  isUsableOfficialWebsite,
} from '@/services/resolution/entity-resolution.service';
import {
  extractEmails,
  extractPhones,
  extractMobiles,
  extractSocialLinks,
  sanitizeEmailString,
  classifyNepalPhone,
  isRealSocialProfile,
  classifyAllSocialProfiles,
} from '@/services/business-extractor.service';

export function buildFallbackListing(
  candidate: UnifiedSearchResult,
  extractions: Array<{ url: string; content: string; favicon: string; success: boolean }>,
  verifiedEvidence?: VerifiedBusinessEvidence[],
  fallbackLocation?: string,
  runStartedAt?: string
): BusinessListing {
  const isMap = candidate.source === 'google_maps';
  const hasSite = candidate.domain && !candidate.domain.includes('google.com');

  // Match pre-extracted verified evidence for this candidate
  let matchingEvidence: VerifiedBusinessEvidence | undefined;
  if (verifiedEvidence && verifiedEvidence.length > 0) {
    const candidateDomain =
      candidate.domain && !candidate.domain.includes('google.com')
        ? domainFromUrlOrHost(candidate.url)
        : '';
    const candidatePhone = (candidate.phoneNumber || (candidate as any).phone) ? normalizePhoneDigits(candidate.phoneNumber || (candidate as any).phone) : '';
    const candidateNormName = normalizeNameKey(candidate.title || (candidate as any).name || '');

    matchingEvidence = verifiedEvidence.find((ev) => {
      const c = ev.candidate;
      if (candidateDomain && c.website && domainFromUrlOrHost(c.website) === candidateDomain) return true;
      if (candidatePhone && c.phone && normalizePhoneDigits(c.phone) === candidatePhone) return true;
      const evNormName = normalizeNameKey(c.name || '');
      if (candidateNormName && evNormName && (candidateNormName.includes(evNormName) || evNormName.includes(candidateNormName))) {
        return true;
      }
      return false;
    });
  }

  const relationship = matchingEvidence?.websiteRelationship || 'unverified';
  const candidateNameKey = matchingEvidence ? normalizeNameKey(matchingEvidence.candidate.name || '') : '';
  const fallbackTitleKey = normalizeNameKey(candidate.title || (candidate as any).name || '');
  const namesAlign = Boolean(
    !matchingEvidence ||
      (candidateNameKey &&
        fallbackTitleKey &&
        (fallbackTitleKey.includes(candidateNameKey) || candidateNameKey.includes(fallbackTitleKey)))
  );

  const isFirstParty = relationship === 'first_party' && namesAlign;
  const isCorporateParent = relationship === 'corporate_parent' && namesAlign;

  const isConfirmedWrongSource =
    relationship === 'directory' ||
    relationship === 'marketplace' ||
    relationship === 'service_platform' ||
    relationship === 'unrelated';
  const sourceHealth = matchingEvidence?.sourceHealth;
  const isTransientFailure = sourceHealth === 'transient_failure' || sourceHealth === 'unverified';
  const evidenceDomain = candidate.url ? domainFromUrlOrHost(candidate.url) : '';
  const officialDomain = candidate.domain || '';
  const domainCorroborated = Boolean(evidenceDomain && officialDomain && evidenceDomain === officialDomain);
  
  const mapsPhoneDigits = normalizePhoneDigits(candidate.phoneNumber || matchingEvidence?.candidate.phone || '');
  
  const phoneCorroborated = Boolean(
    mapsPhoneDigits &&
    matchingEvidence?.websiteEvidence?.extractedClassifiedContacts?.some(
      (c) => c.canonicalDigits && normalizePhoneDigits(c.canonicalDigits) === mapsPhoneDigits
    )
  );
  
  const isTransientButCorroborated = isTransientFailure && !isConfirmedWrongSource && (domainCorroborated || phoneCorroborated);

  const webEvidence = isFirstParty ? matchingEvidence?.websiteEvidence : undefined;
  const extraction = extractions.find((e) => e.url === candidate.url && e.success);
  const content = extraction?.content || '';

  // Emails: first_party ONLY (corporate_parent emails BLOCKED)
  const emailCandidates = isFirstParty && webEvidence?.extractedEmails?.length
    ? webEvidence.extractedEmails
    : isFirstParty
    ? extractEmails(content)
    : [];
  const emails = [...new Set(emailCandidates.map(sanitizeEmailString).filter((e) => /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(e)))];

  // Phones & Mobiles: strict separation (phones = landlines + non-mobile intl; mobiles = 97/98)
  const mergedPhones: string[] = [];
  const mergedMobiles: string[] = [];
  const seenDigits = new Set<string>();

  const routePhone = (p?: string) => {
    if (!p) return;
    const classified = classifyNepalPhone(p);
    if (classified.type === 'invalid' || classified.type === 'international') return;
    if (seenDigits.has(classified.digits)) return;
    seenDigits.add(classified.digits);

    const display = classified.normalized || p.trim();
    if (classified.type === 'mobile') {
      mergedMobiles.push(display);
    } else {
      mergedPhones.push(display);
    }
  };

  if (candidate.phoneNumber) routePhone(candidate.phoneNumber);
  if (matchingEvidence?.candidate.phone) routePhone(matchingEvidence.candidate.phone);
  if (isFirstParty || isTransientButCorroborated) {
    const evidenceToUse = matchingEvidence?.websiteEvidence || webEvidence;
    for (const m of evidenceToUse?.extractedMobiles || []) routePhone(m);
    for (const p of evidenceToUse?.extractedPhones || []) routePhone(p);
  } else if (isCorporateParent && mapsPhoneDigits && matchingEvidence?.websiteEvidence) {
    for (const m of matchingEvidence.websiteEvidence.extractedMobiles || []) {
      if (normalizePhoneDigits(m) === mapsPhoneDigits) routePhone(m);
    }
    for (const p of matchingEvidence.websiteEvidence.extractedPhones || []) {
      if (normalizePhoneDigits(p) === mapsPhoneDigits) routePhone(p);
    }
  }
  if (mergedPhones.length === 0 && mergedMobiles.length === 0 && (isFirstParty || isTransientButCorroborated)) {
    for (const m of extractMobiles(content)) routePhone(m);
    for (const p of extractPhones(content)) routePhone(p);
  }

  // Social Links: first_party website evidence OR SERP-discovered social profiles
  const fallbackDiscoveredSocials =
    (candidate as any).discoveredSocials ||
    (candidate.discoveryProvenance as any)?.discoveredSocials ||
    (matchingEvidence?.candidate as any)?.discoveredSocials ||
    (matchingEvidence?.candidate.discoveryProvenance as any)?.discoveredSocials;

  const fallbackSocials = (isFirstParty || (!isConfirmedWrongSource && content))
    ? extractSocialLinks(content, { businessName: candidate.title, websiteDomain: candidate.url })
    : { facebook: '', instagram: '', tiktok: '', other: {} };

  let rawFb = (isFirstParty ? webEvidence?.extractedSocialLinks?.facebook : '') || fallbackSocials.facebook || '';
  if (!rawFb && fallbackDiscoveredSocials?.facebook) rawFb = fallbackDiscoveredSocials.facebook;

  let rawTt = (isFirstParty ? webEvidence?.extractedSocialLinks?.tiktok : '') || fallbackSocials.tiktok || '';
  if (!rawTt && fallbackDiscoveredSocials?.tiktok) rawTt = fallbackDiscoveredSocials.tiktok;

  let rawIg = (isFirstParty ? webEvidence?.extractedSocialLinks?.instagram : '') || fallbackSocials.instagram || '';
  if (!rawIg && fallbackDiscoveredSocials?.instagram) rawIg = fallbackDiscoveredSocials.instagram;

  const otherSources: Record<string, unknown> = {
    ...(fallbackSocials.other || {}),
    ...(isFirstParty ? webEvidence?.extractedSocialLinks?.other || {} : {}),
    ...(fallbackDiscoveredSocials?.other || {}),
    ...(fallbackDiscoveredSocials?.linkedin ? { linkedin: fallbackDiscoveredSocials.linkedin } : {}),
  };
  const validatedOther: Record<string, string> = {};
  for (const [k, v] of Object.entries(otherSources)) {
    if (typeof v === 'string' && v && isRealSocialProfile(v, k)) {
      validatedOther[k] = v;
    }
  }

  const socialLinks = {
    facebook: isRealSocialProfile(rawFb, 'facebook') ? rawFb : '',
    tiktok: isRealSocialProfile(rawTt, 'tiktok') ? rawTt : '',
    instagram: isRealSocialProfile(rawIg, 'instagram') ? rawIg : '',
    other: validatedOther,
  };

  const finalLocation =
    candidate.address ||
    matchingEvidence?.candidate.location ||
    '';

  const websites: string[] = [];
  const candidateWebsite =
    (candidate.url && hasSite ? candidate.url : '') ||
    matchingEvidence?.candidate.website ||
    webEvidence?.url ||
    (candidate.source !== 'google_maps' && candidate.url && !candidate.url.includes('google.com') ? candidate.url : '');

  if (candidateWebsite && !isConfirmedWrongSource) {
    if (isFirstParty || isCorporateParent || candidate.source !== 'google_maps' || hasSite) {
      if (isUsableOfficialWebsite(candidateWebsite, candidate.title)) {
        websites.push(candidateWebsite);
      }
    }
  }

  const fallbackSocialProfiles = (webEvidence as any)?.extractedSocialProfiles ||
    (isFirstParty ? classifyAllSocialProfiles(content, { businessName: candidate.title, websiteDomain: candidate.url }) : []);
  const fallbackSocialsRejected = fallbackSocialProfiles.filter(
    (p: any) => p.status === 'rejected' || p.status === 'unknown'
  );

  // Phase 8f: Rich Maps Metadata Resolution
  const rawCandidateHours = (candidate as any).hours || matchingEvidence?.candidate.hours;
  const resolvedHours =
    webEvidence?.extractedHours ||
    (typeof rawCandidateHours === 'string'
      ? rawCandidateHours
      : rawCandidateHours && typeof rawCandidateHours === 'object'
      ? Object.entries(rawCandidateHours).map(([day, time]) => `${day}: ${time}`).join(', ')
      : '');

  const resolvedPriceRange =
    (candidate as any).priceRange ||
    (candidate as any).priceLevel ||
    matchingEvidence?.candidate.priceRange ||
    '';

  const resolvedCategories: string[] = [
    ...new Set([
      ...((candidate as any).categories || []),
      ...(matchingEvidence?.candidate.categories || []),
      ...(candidate.businessType ? [candidate.businessType] : []),
      ...(matchingEvidence?.candidate.category ? [matchingEvidence.candidate.category] : []),
    ]),
  ].filter(Boolean);

  const resolvedBusinessDesc =
    matchingEvidence?.candidate.description ||
    (candidate as any).businessDescription ||
    (candidate as any).description ||
    undefined;

  const resolvedThumbnail =
    (candidate as any).thumbnailUrl ||
    matchingEvidence?.candidate.thumbnailUrl ||
    undefined;

  const resolvedBookingLinks =
    (candidate as any).bookingLinks ||
    matchingEvidence?.candidate.bookingLinks ||
    undefined;

  return {
    name: candidate.title || (candidate as any).name || 'Unknown Business',
    location: finalLocation,
    emails,
    phones: mergedPhones,
    mobiles: mergedMobiles,
    websites,
    icon: webEvidence?.favicon || extraction?.favicon || '',
    socialLinks,
    otherDetails: {
      snippet: candidate.description,
      address: finalLocation,
      rating: candidate.rating,
      ratingCount: candidate.ratingCount,
      businessType: candidate.businessType,
      categories: resolvedCategories.length > 0 ? resolvedCategories : undefined,
      placeId: candidate.placeId || matchingEvidence?.candidate.sources.googleMaps?.placeId,
      services: webEvidence?.extractedServices?.length ? webEvidence.extractedServices : (resolvedCategories.length > 0 ? resolvedCategories : []),
      hours: resolvedHours,
      priceRange: resolvedPriceRange,
      businessDescription: resolvedBusinessDesc,
      thumbnailUrl: resolvedThumbnail,
      bookingLinks: resolvedBookingLinks,
      classifiedSocialProfiles: fallbackSocialProfiles.length > 0 ? fallbackSocialProfiles : undefined,
      socialLinksRejected: fallbackSocialsRejected.length > 0 ? fallbackSocialsRejected : undefined,
      discoveryState: matchingEvidence?.candidate.discoveryState || candidate.discoveryState,
      discoveryProvenance: matchingEvidence?.candidate.discoveryProvenance || candidate.discoveryProvenance,
    },
    gpsCoordinates:
      candidate.latitude !== undefined && candidate.longitude !== undefined
        ? { latitude: candidate.latitude, longitude: candidate.longitude }
        : matchingEvidence?.candidate.coordinates
        ? {
            latitude: matchingEvidence.candidate.coordinates.lat,
            longitude: matchingEvidence.candidate.coordinates.lng,
          }
        : undefined,
    rating: candidate.rating,
    ratingCount: candidate.ratingCount,
    businessType: candidate.businessType,
    placeId: candidate.placeId || matchingEvidence?.candidate.sources.googleMaps?.placeId,
    metadata: {
      source: isMap ? 'google_maps' : candidate.url,
      extractedAt: new Date().toISOString(),
      runStartedAt: runStartedAt ?? new Date().toISOString(),
      confidence: 0,
    },
    process: webEvidence
      ? 'Verified via Google Maps Places & Website extraction'
      : isMap
      ? 'Verified via Google Maps Places (Direct fallback)'
      : extraction
      ? 'Auto-extracted from website content (fallback mode — agent unavailable)'
      : 'From search snippet only (fallback mode — agent unavailable)',
    links: websites,
  };
}
