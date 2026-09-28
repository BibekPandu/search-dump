/**
 * Social Completion Service
 *
 * Dedicated pipeline seam for reconciling, enriching, and deduplicating
 * social profiles across multiple sources (website HTML, Schema.org sameAs,
 * Google Maps bookingLinks, and direct place owner links) with strict provenance.
 */

import type { ClassifiedSocialProfile } from '@/types/social.js';
import { SOCIAL_DOMAINS } from '@/services/resolution/candidate-classifier.service.js';
import { domainFromUrlOrHost } from '@/services/extraction/content-normalization.service.js';
import {
  classifySocialProfile,
  computeCanonicalSocialUrl,
} from '@/services/extraction/social-extractor.service.js';

export interface CompleteSocialsInput {
  name: string;
  websiteDomain?: string;
  existingSocials?: {
    facebook?: string;
    tiktok?: string;
    instagram?: string;
    other?: Record<string, string>;
  };
  bookingLinks?: string[];
  schemaSameAs?: string[];
  discoveredSocials?: Record<string, string>;
  websiteRelationship?: string;
  existingClassifiedProfiles?: ClassifiedSocialProfile[];
}

export interface CompleteSocialsResult {
  socialLinks: {
    facebook: string;
    tiktok: string;
    instagram: string;
    other: Record<string, string>;
  };
  classifiedProfiles: ClassifiedSocialProfile[];
  completedCount: number;
}

/**
 * Reconciles and augments candidate social links using first-party sources:
 * 1. Preserves already-verified first-party website socials.
 * 2. Ingests Schema.org `sameAs` links (tagged origin: 'schema_org_sameAs').
 * 3. Ingests Google Maps `bookingLinks` matching SOCIAL_DOMAINS (tagged origin: 'maps_booking_link').
 */
export function completeSocials(input: CompleteSocialsInput): CompleteSocialsResult {
  const socialLinks = {
    facebook: input.existingSocials?.facebook || '',
    tiktok: input.existingSocials?.tiktok || '',
    instagram: input.existingSocials?.instagram || '',
    other: { ...(input.existingSocials?.other || {}) },
  };

  const classifiedProfiles: ClassifiedSocialProfile[] = [
    ...(input.existingClassifiedProfiles || []),
  ];

  let completedCount = 0;

  const mergeProfile = (
    profile: ClassifiedSocialProfile,
    origin: ClassifiedSocialProfile['origin']
  ) => {
    profile.origin = origin;
    classifiedProfiles.push(profile);

    if (profile.status !== 'accepted') return;

    const canonical = profile.canonicalUrl || computeCanonicalSocialUrl(profile.url, profile.platform) || profile.url;

    if (profile.platform === 'facebook' && !socialLinks.facebook) {
      socialLinks.facebook = canonical;
      completedCount++;
    } else if (profile.platform === 'instagram' && !socialLinks.instagram) {
      socialLinks.instagram = canonical;
      completedCount++;
    } else if (profile.platform === 'tiktok' && !socialLinks.tiktok) {
      socialLinks.tiktok = canonical;
      completedCount++;
    } else if (profile.platform === 'twitter' && !socialLinks.other.x) {
      socialLinks.other.x = canonical;
      completedCount++;
    } else if (profile.platform === 'youtube' && !socialLinks.other.youtube) {
      socialLinks.other.youtube = canonical;
      completedCount++;
    } else if (profile.platform === 'linkedin' && !socialLinks.other.linkedin) {
      socialLinks.other.linkedin = canonical;
      completedCount++;
    }
  };

  // 1. Process Schema.org sameAs URLs
  if (input.schemaSameAs && input.schemaSameAs.length > 0) {
    for (const rawUrl of input.schemaSameAs) {
      if (!rawUrl) continue;
      const domain = domainFromUrlOrHost(rawUrl);
      if (!SOCIAL_DOMAINS.has(domain)) continue;

      const classified = classifySocialProfile(
        rawUrl,
        undefined,
        input.name,
        input.websiteDomain,
        undefined,
        'website_evidence'
      );
      mergeProfile(classified, 'schema_org_sameAs');
    }
  }

  // 2. Process Google Maps bookingLinks (Strict SOCIAL_DOMAINS Gate)
  if (input.bookingLinks && input.bookingLinks.length > 0) {
    for (const rawUrl of input.bookingLinks) {
      if (!rawUrl) continue;
      const domain = domainFromUrlOrHost(rawUrl);
      // Strictly gate: ignore internal contact/booking pages or non-social aggregators
      if (!SOCIAL_DOMAINS.has(domain)) continue;

      const classified = classifySocialProfile(
        rawUrl,
        undefined,
        input.name,
        input.websiteDomain,
        undefined,
        'maps'
      );
      mergeProfile(classified, 'maps_booking_link');
    }
  }

  // 3. Process Phase 0 discoveredSocials (Strict validation gate)
  if (input.discoveredSocials && Object.keys(input.discoveredSocials).length > 0) {
    for (const [platform, rawUrl] of Object.entries(input.discoveredSocials)) {
      if (!rawUrl || typeof rawUrl !== 'string') continue;
      const domain = domainFromUrlOrHost(rawUrl);
      if (!SOCIAL_DOMAINS.has(domain)) continue;

      const classified = classifySocialProfile(
        rawUrl,
        platform,
        input.name,
        input.websiteDomain,
        undefined,
        'serp'
      );
      if (classified.status === 'accepted') {
        mergeProfile(classified, 'phase0_discovery');
      } else {
        console.log(
          `[SocialCompletion] Phase 0 social rejected: ${rawUrl} (${classified.rejectionReason})`
        );
        classified.origin = 'phase0_discovery';
        classifiedProfiles.push(classified);
      }
    }
  }

  return {
    socialLinks,
    classifiedProfiles,
    completedCount,
  };
}
