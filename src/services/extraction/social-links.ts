/**
 * Structured social link extraction from page content.
 *
 * Final stage: harvest every candidate URL from markdown/HTML/handle
 * forms, then keep the business-owned canonical URL per platform.
 */

import type { ClassifiedSocialProfile } from '@/types/social.js';
import { LINKEDIN_REGEX, FACEBOOK_REGEX, INSTAGRAM_REGEX, TIKTOK_REGEX, X_TWITTER_REGEX, YOUTUBE_REGEX } from '@/services/extraction/extraction-regex';
import {
  cleanTrailingPunctuation,
  extractUrlsFromMarkdown,
  extractUrlsFromHtml,
  extractStructuredSocialUrls,
  liftBareHandles,
} from '@/services/extraction/content-normalization.service';
import { isBusinessOwnedSocialProfile } from '@/services/extraction/social-ownership';
import { computeCanonicalSocialUrl } from '@/services/extraction/social-url';

export interface ExtractedSocialLinks {
  facebook: string;
  instagram: string;
  tiktok: string;
  other: Record<string, string>;
}

export function extractSocialLinks(
  content: string,
  context?: { businessName?: string; websiteDomain?: string }
): ExtractedSocialLinks {
  const empty = { facebook: '', instagram: '', tiktok: '', other: {} };
  if (!content) return empty;

  const structuredUrls = [
    ...extractUrlsFromMarkdown(content),
    ...extractUrlsFromHtml(content),
    ...extractStructuredSocialUrls(content),
    ...liftBareHandles(content),
  ];
  const rawUrls = content.match(/https?:\/\/[^\s<>")\]]+/gi) || [];
  const combinedContent = [...structuredUrls, ...rawUrls].join('\n');

  const fbMatches = combinedContent.match(new RegExp(FACEBOOK_REGEX.source, 'gi')) || [];
  const igMatches = combinedContent.match(new RegExp(INSTAGRAM_REGEX.source, 'gi')) || [];
  const ttMatches = combinedContent.match(new RegExp(TIKTOK_REGEX.source, 'gi')) || [];
  const xMatches = combinedContent.match(new RegExp(X_TWITTER_REGEX.source, 'gi')) || [];
  const ytMatches = combinedContent.match(new RegExp(YOUTUBE_REGEX.source, 'gi')) || [];
  const liMatches = combinedContent.match(new RegExp(LINKEDIN_REGEX.source, 'gi')) || [];

  const bName = context?.businessName;
  const wDomain = context?.websiteDomain;

  const selectCanonicalSocial = (matches: string[], platform: ClassifiedSocialProfile['platform']) => {
    const accepted = matches
      .map(cleanTrailingPunctuation)
      .find((u) => isBusinessOwnedSocialProfile(u, platform, bName, wDomain, undefined, 'website_evidence'));
    return accepted ? computeCanonicalSocialUrl(accepted, platform) : '';
  };

  const rawFacebook = selectCanonicalSocial(fbMatches, 'facebook');
  const rawInstagram = selectCanonicalSocial(igMatches, 'instagram');
  const rawTiktok = selectCanonicalSocial(ttMatches, 'tiktok');

  const other: Record<string, string> = {};
  const xTwitter = selectCanonicalSocial(xMatches, 'twitter');
  const youtube = selectCanonicalSocial(ytMatches, 'youtube');
  const linkedin = selectCanonicalSocial(liMatches, 'linkedin');
  if (xTwitter) other.x = xTwitter;
  if (youtube) other.youtube = youtube;
  if (linkedin) other.linkedin = linkedin;

  return {
    facebook: rawFacebook,
    instagram: rawInstagram,
    tiktok: rawTiktok,
    other,
  };
}
