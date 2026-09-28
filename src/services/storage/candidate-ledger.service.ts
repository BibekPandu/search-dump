/**
 * Candidate ledger service for candidate ID generation and listing-candidate matching.
 */
import type { UnifiedSearchResult } from '@/types/search';
import type { BusinessListing } from '@/types/business-listing';
import {
  domainFromUrlOrHost,
  normalizeNameKey,
  normalizePhoneDigits,
} from '@/services/resolution/entity-resolution.service';
import { normalizeUrl } from '@/services/discovery/search-fallback.service';

export function buildCandidateLedgerId(candidate: UnifiedSearchResult): string {
  const placeId = (candidate as any).placeId;
  if (typeof placeId === 'string' && placeId.trim()) return `maps:${placeId.trim()}`;

  const domain = candidate.domain && !candidate.domain.includes('google.com')
    ? domainFromUrlOrHost(candidate.domain)
    : '';
  const name = normalizeNameKey(candidate.title || 'unknown');
  const phone = normalizePhoneDigits(candidate.phoneNumber || '');
  const identity = [domain, name, phone].filter(Boolean).join('|');
  return `candidate:${identity || normalizeUrl(candidate.url)}`;
}

export function candidateMatchesListing(
  candidate: UnifiedSearchResult,
  listing: BusinessListing
): boolean {
  const candidateDomain = candidate.domain && !candidate.domain.includes('google.com')
    ? domainFromUrlOrHost(candidate.domain)
    : '';
  if (candidateDomain && listing.websites.some((website) => domainFromUrlOrHost(website) === candidateDomain)) {
    return true;
  }

  const candidatePhone = normalizePhoneDigits(candidate.phoneNumber || '');
  if (candidatePhone && [...listing.phones, ...listing.mobiles].some((phone) => normalizePhoneDigits(phone) === candidatePhone)) {
    return true;
  }

  const candidateName = normalizeNameKey(candidate.title || '');
  const listingName = normalizeNameKey(listing.name || '');
  return Boolean(
    candidateName &&
      listingName &&
      (candidateName.includes(listingName) || listingName.includes(candidateName))
  );
}
