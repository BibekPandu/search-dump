/**
 * Social URL handle parsing and canonicalization.
 *
 * Leaf stage of the social pipeline: given a raw URL segment structure,
 * produce the canonical profile URL and handle. Shared by validation,
 * classification and link extraction so all three agree on what
 * "the same profile" means.
 */

import type { ClassifiedSocialProfile } from '@/types/social.js';
import {
  FACEBOOK_NON_CANONICAL_SUBPATHS,
  FB_NAMESPACE_PATHS,
  FB_NAMESPACE_RESERVED_ACTIONS,
  FACEBOOK_RESERVED_PATHS,
} from '@/config/token-vocabulary.config';
import { decodeHtmlEntities } from '@/services/extraction/content-normalization.service';

export function requiredSocialNameOverlap(distinctiveTokenCount: number): number {
  if (distinctiveTokenCount <= 1) return 1;
  if (distinctiveTokenCount <= 3) return 1;
  return Math.max(2, Math.ceil(distinctiveTokenCount * 0.5));
}

export function brandSegmentFromBusinessName(name: string): string {
  const brand = name.split(/\s*[:|]\s*|\s+[-–—]\s+/)[0]?.trim() || '';
  return brand.length >= 2 ? brand : name;
}

/**
 * True when a Facebook namespace path carries a reserved action word in the
 * slot that would otherwise be read as a page slug, e.g.
 * `facebook.com/pages/create` (the "Create a Page" form) or
 * `facebook.com/people/login`. These are UI routes, never business pages.
 */
export function isReservedNamespaceAction(pathSegments: string[]): boolean {
  const action = pathSegments[1]?.toLowerCase();
  if (!action) return false;
  return FB_NAMESPACE_RESERVED_ACTIONS.has(action) || FACEBOOK_RESERVED_PATHS.has(action);
}

export function extractFacebookHandle(pathSegments: string[]): string | null {
  if (!pathSegments || pathSegments.length === 0) return null;
  const first = pathSegments[0].toLowerCase().replace(/^@/, '');
  if (!FB_NAMESPACE_PATHS.has(first)) {
    if (first === 'profile.php') return 'profile.php';
    return first;
  }

  // /people/<slug>/<id> -> slug
  // /pages/<slug>/<id> -> slug
  // /p/<slug>-<id> -> strip trailing -<digits>
  const second = pathSegments[1];
  if (!second) return null;
  return second.replace(/-\d{6,}$/, '');
}

export function computeCanonicalSocialUrl(
  url: string,
  plat: ClassifiedSocialProfile['platform']
): string {
  if (!url) return '';
  const decodedUrl = decodeHtmlEntities(url);
  try {
    const parsed = new URL(decodedUrl);
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    if (pathSegments.length === 0) return url;

    if (plat === 'facebook') {
      const first = pathSegments[0].toLowerCase();
      if (first === 'p' && pathSegments.length > 1) {
        return `https://facebook.com/p/${pathSegments[1]}`;
      }
      if (first === 'people' && pathSegments.length > 1) {
        const id = pathSegments[2] ? `/${pathSegments[2]}` : '';
        return `https://facebook.com/people/${pathSegments[1]}${id}`;
      }
      if (first === 'pages' && pathSegments.length > 1) {
        const id = pathSegments[2] ? `/${pathSegments[2]}` : '';
        return `https://facebook.com/pages/${pathSegments[1]}${id}`;
      }
      if (first === 'profile.php') {
        const id = parsed.searchParams.get('id');
        return id ? `https://facebook.com/profile.php?id=${id}` : url;
      }
      if (pathSegments.length > 1 && FACEBOOK_NON_CANONICAL_SUBPATHS.has(pathSegments[1].toLowerCase())) {
        return `https://facebook.com/${pathSegments[0]}`;
      }
      return `https://facebook.com/${pathSegments[0]}`;
    }

    if (plat === 'tiktok') {
      const handle = pathSegments[0].startsWith('@') ? pathSegments[0] : `@${pathSegments[0]}`;
      return `https://tiktok.com/${handle}`;
    }

    if (plat === 'instagram') {
      const first = pathSegments[0].toLowerCase();
      if (['p', 'reel', 'reels', 'stories', 'explore'].includes(first)) {
        return url;
      }
      return `https://instagram.com/${pathSegments[0]}`;
    }

    if (plat === 'linkedin') {
      const first = pathSegments[0].toLowerCase();
      if (first === 'company' && pathSegments[1]) {
        return `https://linkedin.com/company/${pathSegments[1]}`;
      }
      if (first === 'in' && pathSegments[1]) {
        return `https://linkedin.com/in/${pathSegments[1]}`;
      }
      return url;
    }

    if (plat === 'twitter') {
      return `https://x.com/${pathSegments[0]}`;
    }

    if (plat === 'youtube') {
      if (pathSegments[0].startsWith('@')) {
        return `https://youtube.com/${pathSegments[0]}`;
      }
      if ((pathSegments[0] === 'channel' || pathSegments[0] === 'c') && pathSegments[1]) {
        return `https://youtube.com/${pathSegments[0]}/${pathSegments[1]}`;
      }
      return `https://youtube.com/${pathSegments[0]}`;
    }

    return url;
  } catch {
    return url;
  }
}
