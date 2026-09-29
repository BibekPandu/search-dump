/**
 * Identity-key normalizers and identity-signal predicates.
 *
 * Leaf module: pure string/number helpers with no service dependencies, so
 * both matching and conflict detection share one notion of a canonical
 * phone, name, domain, address and email. Duplicating these is what
 * produced the cross-listing false merges they exist to prevent.
 */

import { extractDomain } from '@/services/discovery/search-fallback.service';
import { 
  classifySocialProfile
 } from '@/services/business-extractor.service';


// ============================================================================
// Normalization & Extraction Utilities
// ============================================================================

/**
 * Normalizes phone numbers to digits-only for MATCHING.
 * Handles Nepal country code (+977), trunk prefix (01-), and mobile/landline variations.
 */
export function normalizePhoneDigits(raw: string): string {
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  // 1. +977-1-XXXXXXX (11 digits): strip 977 -> 1XXXXXXX (8 digits)
  if (digits.startsWith('9771') && digits.length === 11) {
    digits = digits.slice(3);
  }
  // 2. +977-01-XXXXXXX (12 digits): strip 9770 -> 1XXXXXXX (8 digits)
  else if (digits.startsWith('97701') && digits.length === 12) {
    digits = digits.slice(4);
  }
  // 3. +977 mobile (13 digits starting with 97798, 97797, 97796): strip 977 -> 10 digits
  else if (digits.startsWith('977') && digits.length === 13 && (digits.startsWith('97798') || digits.startsWith('97797') || digits.startsWith('97796'))) {
    digits = digits.slice(3);
  }
  // 4. Duplicate country code (e.g. +977 977...): strip duplicate
  else if (digits.startsWith('977977')) {
    digits = digits.slice(3);
    if (digits.startsWith('977') && (digits.length === 13 || digits.length === 14)) {
      digits = digits.slice(3);
    }
  }
  // 5. 01-XXXXXXX (9 digits starting with trunk 0): strip 0 -> 1XXXXXXX
  else if (digits.length === 9 && digits.startsWith('01')) {
    digits = digits.slice(1);
  }
  // 6. Regional domestic landlines (9 digits starting with trunk 0): strip 0 -> 8 digits
  else if (digits.length === 9 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  return digits;
}


/**
 * Normalizes entity name into clean token set for matching.
 */
export function normalizeNameKey(name: string): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    // Conservative legal/decorative token stripping ONLY. Venue-type words
    // (cafe, hotel, restaurant, coffee) are intentionally NOT stripped: they can
    // be the distinguishing part of a business name (e.g. "Sunrise Cafe" vs
    // "Sunrise Hotel" must NOT collapse to the same identity). Principle:
    // a false non-match is safer than a false merge at this stage, because
    // method 'none' simply means "insufficient deterministic evidence to merge".
    .replace(/\b(pvt|ltd|llc|inc|co|corp|p\s*ltd|the|and)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


/**
 * Pure HTML entity decoder for names and titles.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text) return '';
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}


/**
 * Lenient name normalizer that decodes HTML entities before tokenizing.
 * Used for candidate-to-evidence matching, subtitle tolerance, and fallback linkage.
 * Note: normalizeNameKey remains byte-identical to preserve DB canonicalKey stability.
 */
export function normalizeNameKeyLenient(name: string): string {
  if (!name) return '';
  return normalizeNameKey(decodeHtmlEntities(name));
}


/**
 * Extracts domain from full URL or bare host string.
 */
export function domainFromUrlOrHost(value: string): string {
  if (!value) return '';
  const trimmed = value.trim();
  const fromUrl = extractDomain(trimmed);
  if (fromUrl) return fromUrl;

  return trimmed
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split(':')[0];
}


/**
 * Normalizes address for token matching.
 */
export function normalizeAddressKey(addr: string): string {
  if (!addr) return '';
  return addr
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


/**
 * Computes Jaccard similarity across whitespace-delimited word tokens.
 */
export function tokenJaccard(aKey: string, bKey: string): number {
  if (!aKey || !bKey) return 0;
  const tokensA = new Set(aKey.split(' ').filter((t) => t.length > 1));
  const tokensB = new Set(bKey.split(' ').filter((t) => t.length > 1));

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  return union > 0 ? intersection / union : 0;
}


// ============================================================================
// Cross-Listing Conflict & Cluster Detection (Task 3)
// ============================================================================

export const GENERIC_EMAIL_PREFIXES = new Set([
  'info',
  'contact',
  'office',
  'admin',
  'support',
  'sales',
  'hello',
  'enquiry',
  'inquiry',
  'reception',
  'booking',
  'legal',
  'hr',
  'accounts',
  'billing',
  'marketing',
]);


/**
 * Distinguishes personal / identifying emails (e.g. ram.shrestha@gmail.com, john@hotel.com)
 * from generic role-based inboxes (e.g. info@domain.com, contact@domain.com).
 */
export function isIdentifyingEmail(email: string): boolean {
  if (!email || !email.includes('@')) return false;
  const prefix = email.split('@')[0].toLowerCase().trim();
  return !GENERIC_EMAIL_PREFIXES.has(prefix);
}


/**
 * Determines whether a social profile URL represents a personal / individual identifying profile
 * (e.g. linkedin.com/in/john-smith, personal Facebook profile) that uniquely identifies a person
 * (analogous to isIdentifyingEmail for personal inboxes), vs generic shared company pages,
 * vendor handles, platform endpoints, or share dialogs.
 */
export function isIdentifyingSocialProfile(url: string): boolean {
  if (!url) return false;
  const classified = classifySocialProfile(url);
  if (classified.profileType === 'personal_profile') return true;
  return false;
}
