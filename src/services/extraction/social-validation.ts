/**
 * Social profile structural validation.
 *
 * Answers "is this URL even a profile page?" for a known platform —
 * separating UI routes, reserved endpoints and malformed handles from
 * real profile URLs before the classifier assigns ownership.
 */

import {
  FACEBOOK_RESERVED_PATHS,
  FB_NAMESPACE_PATHS,
  TWITTER_RESERVED_PATHS,
  INSTAGRAM_RESERVED_PATHS,
} from '@/config/token-vocabulary.config';
import { decodeHtmlEntities } from '@/services/extraction/content-normalization.service';
import { isReservedNamespaceAction } from '@/services/extraction/social-url';

export function isRealSocialProfile(url: string, platform?: string): boolean {
  if (!url) return false;
  const decodedUrl = decodeHtmlEntities(url);
  try {
    const parsed = new URL(decodedUrl);
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    if (pathSegments.length === 0) return false; // Bare domain e.g. https://facebook.com/

    const firstSegment = pathSegments[0].toLowerCase().replace(/^@/, '');

    // Facebook validation:
    if (platform === 'facebook' || parsed.hostname.includes('facebook.com')) {
      if (firstSegment === 'profile.php') {
        const id = parsed.searchParams.get('id');
        return !!(id && /^\d+$/.test(id));
      }
      if (FACEBOOK_RESERVED_PATHS.has(firstSegment)) return false;
      const isNamespacePattern = FB_NAMESPACE_PATHS.has(firstSegment) && pathSegments.length > 1;
      // A namespace route whose action segment is reserved (e.g. /pages/create)
      // is a Facebook UI form, not a page profile.
      if (isNamespacePattern && isReservedNamespaceAction(pathSegments)) return false;
      if (!isNamespacePattern && firstSegment.length < 3) return false;
      return true;
    }

    // Twitter / X validation:
    if (platform === 'twitter' || parsed.hostname.includes('twitter.com') || parsed.hostname.includes('x.com')) {
      if (TWITTER_RESERVED_PATHS.has(firstSegment)) return false;
      if (!/^[a-zA-Z0-9_]{2,30}$/.test(firstSegment)) return false;
      return true;
    }

    // Instagram validation:
    if (platform === 'instagram' || parsed.hostname.includes('instagram.com')) {
      if (INSTAGRAM_RESERVED_PATHS.has(firstSegment)) return false;
      if (!/^[a-zA-Z0-9._]{2,30}$/.test(firstSegment)) return false;
      return true;
    }

    // TikTok validation:
    if (platform === 'tiktok' || parsed.hostname.includes('tiktok.com')) {
      if (['video', 'share', 'embed', 'tag', 'music', 'live', 'discover'].includes(firstSegment)) return false;
      const handle = firstSegment.replace(/^@/, '');
      if (!/^[a-zA-Z0-9._]{2,30}$/.test(handle)) return false;
      return true;
    }

    // LinkedIn validation:
    if (platform === 'linkedin' || parsed.hostname.includes('linkedin.com')) {
      if (firstSegment !== 'company' && firstSegment !== 'in') return false;
      const handle = pathSegments[1]?.toLowerCase();
      if (!handle || handle.length < 2) return false;
      if (['sharearticle', 'share-offsite'].includes(handle)) return false;
      return true;
    }

    // YouTube validation:
    if (platform === 'youtube' || parsed.hostname.includes('youtube.com')) {
      if (['watch', 'feed', 'channel', 'results'].includes(firstSegment) && !pathSegments[1]) return false;
      return true;
    }

    return true;
  } catch {
    return false;
  }
}
