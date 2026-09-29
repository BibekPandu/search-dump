/**
 * Ownership queries and batch classification over page content.
 *
 * Consumes the classifier to answer "does this profile belong to the
 * business?" and to classify every social URL found in a document,
 * de-duplicating while preserving first-seen order.
 */

import type { ClassifiedSocialProfile } from '@/types/social.js';
import {
  cleanTrailingPunctuation,
  extractUrlsFromMarkdown,
  extractUrlsFromHtml,
  liftBareHandles,
} from '@/services/extraction/content-normalization.service';
import { classifySocialProfile } from '@/services/extraction/social-classify';

export function isBusinessOwnedSocialProfile(
  url: string,
  platform?: string,
  businessName?: string,
  websiteDomain?: string,
  categoryContext?: string | string[],
  origin?: 'website_evidence' | 'serp' | 'maps'
): boolean {
  const result = classifySocialProfile(url, platform, businessName, websiteDomain, categoryContext, origin);
  if (businessName || websiteDomain) {
    return result.status === 'accepted';
  }
  return result.status !== 'rejected';
}

export function classifyAllSocialProfiles(
  content: string,
  context?: {
    businessName?: string;
    websiteDomain?: string;
    categoryContext?: string | string[];
    origin?: 'website_evidence' | 'serp' | 'maps';
  }
): ClassifiedSocialProfile[] {
  if (!content) return [];
  const structuredUrls = [
    ...extractUrlsFromMarkdown(content),
    ...extractUrlsFromHtml(content),
    ...liftBareHandles(content),
  ];
  const rawUrls = content.match(/https?:\/\/[^\s<>")\]]+/gi) || [];
  const combinedUrls = [...new Set([...structuredUrls, ...rawUrls].map(cleanTrailingPunctuation))];

  const seenUrls = new Set<string>();
  const classifiedProfiles: ClassifiedSocialProfile[] = [];

  for (const url of combinedUrls) {
    if (!url || seenUrls.has(url)) continue;
    const isSocial = /https?:\/\/(?:www\.)?(?:m\.)?(?:facebook\.com|instagram\.com|tiktok\.com|(?:x|twitter)\.com|youtube\.com|linkedin\.com)/i.test(url);
    if (!isSocial) continue;

    seenUrls.add(url);
    const classified = classifySocialProfile(
      url,
      undefined,
      context?.businessName,
      context?.websiteDomain,
      context?.categoryContext,
      context?.origin ?? 'website_evidence'
    );
    classifiedProfiles.push(classified);
  }

  return classifiedProfiles;
}
