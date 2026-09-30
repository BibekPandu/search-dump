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
import {
  extractDistinctiveNameTokens,
  COMMON_SURNAMES,
  CATEGORY_VERTICALS,
  GEOGRAPHIC_MODIFIERS,
} from '@/config/token-vocabulary.config';


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

/**
 * Checks whether candidate name and evidence name align using distinctive tokens.
 * Requires Jaccard >= 0.5 or full subset match, with at least one shared token of length >= 4.
 */
export function namesAlign(candidateName: string, evidenceName: string): boolean {
  if (!candidateName && !evidenceName) return true;
  if (!candidateName || !evidenceName) return false;

  const normA = normalizeNameKeyLenient(candidateName);
  const normB = normalizeNameKeyLenient(evidenceName);
  if (normA && normB && (normA === normB || normA.includes(normB) || normB.includes(normA))) {
    // If one normalized string strictly contains the other (e.g. subtitle additions)
    const cTokens = extractDistinctiveNameTokens(candidateName);
    const evTokens = extractDistinctiveNameTokens(evidenceName);
    if (cTokens.length === 0 && evTokens.length === 0) return true;
    const shared = cTokens.filter((t) => evTokens.includes(t));
    if (shared.length > 0) return true;
  }

  const cTokens = extractDistinctiveNameTokens(candidateName);
  const evTokens = extractDistinctiveNameTokens(evidenceName);

  // Both empty → require exact normalized equality
  if (cTokens.length === 0 && evTokens.length === 0) {
    return normA === normB;
  }

  // One empty, one not → cannot align a distinctive name to a generic one
  if (cTokens.length === 0 || evTokens.length === 0) {
    return false;
  }

  const shared = cTokens.filter((t) => evTokens.includes(t));
  if (shared.length === 0) return false;

  // Distinctive floor: require at least one shared token of length >= 4
  // (or single-token exact match if both have exactly 1 token)
  const hasDistinctiveShared =
    shared.some((t) => t.length >= 4) ||
    (cTokens.length === 1 && evTokens.length === 1 && cTokens[0] === evTokens[0]);
  if (!hasDistinctiveShared) return false;

  const union = new Set([...cTokens, ...evTokens]);
  const jaccard = shared.length / union.size;

  const isSubset =
    cTokens.every((t) => evTokens.includes(t)) || evTokens.every((t) => cTokens.includes(t));

  return jaccard >= 0.5 || isSubset;
}

export interface EvidenceAlignmentOptions {
  phoneMatches?: boolean;
  domainMatches?: boolean;
}

/**
 * Enhanced name alignment guard specifically for evidence binding & candidate re-injection.
 * Enforces that:
 * 1. Base namesAlign() check passes.
 * 2. Distinctive brand token overlap passes:
 *    - Strips common surnames, geographic modifiers, and vertical modifiers.
 *    - Empty-set fallback: if either name's pure distinctive set becomes empty (e.g. "Kandel Consultancy"),
 *      falls back to the full distinctive set so legitimate single-token surname businesses can match.
 * 3. Match criteria:
 *    - >= 2 shared distinctive brand tokens (e.g. "Om Samaj Dental", "Big Smile Dental") -> MATCH
 *    - >= 1 shared distinctive brand token AND phone matches -> MATCH
 *    - >= 1 shared distinctive brand token AND domain matches -> MATCH
 *    - >= 1 shared distinctive brand token AND normalized names are identical or one strictly contains the other -> MATCH
 *    - Otherwise -> REJECT (prevents cross-industry single-token collisions like "Apex Law" vs "Apex Dental")
 */
export function namesAlignForEvidence(
  listingName: string,
  candidateName: string,
  options?: EvidenceAlignmentOptions
): boolean {
  if (!listingName || !candidateName) return false;

  // Base distinctive containment & Jaccard check
  if (!namesAlign(listingName, candidateName)) {
    return false;
  }

  const cTokens = extractDistinctiveNameTokens(listingName);
  const evTokens = extractDistinctiveNameTokens(candidateName);

  if (cTokens.length === 0 || evTokens.length === 0) {
    const normA = normalizeNameKey(listingName);
    const normB = normalizeNameKey(candidateName);
    return Boolean(normA && normB && normA === normB);
  }

  const isNonBrandModifier = (t: string) =>
    COMMON_SURNAMES.has(t) ||
    GEOGRAPHIC_MODIFIERS.has(t) ||
    CATEGORY_VERTICALS.has(t);

  const pureCTokens = cTokens.filter((t) => !isNonBrandModifier(t));
  const pureEvTokens = evTokens.filter((t) => !isNonBrandModifier(t));

  // Fallback: If stripping non-brand modifiers leaves either set empty,
  // fall back to the full distinctive set so single-token surname businesses
  // (e.g. "Kandel Consultancy") do not lose their only distinctive token.
  const effectiveCTokens = pureCTokens.length > 0 ? pureCTokens : cTokens;
  const effectiveEvTokens = pureEvTokens.length > 0 ? pureEvTokens : evTokens;

  const shared = effectiveCTokens.filter((t) => effectiveEvTokens.includes(t));
  if (shared.length === 0) {
    return false;
  }

  // 1. Strong brand match: >= 2 shared distinctive brand tokens
  if (shared.length >= 2) {
    return true;
  }

  // 2. Corroborated match: 1 shared brand token + matching phone or domain
  if (options?.phoneMatches || options?.domainMatches) {
    return true;
  }

  // 3. Name identity match: 1 shared brand token + exact normalized equality or strict containment
  const normA = normalizeNameKey(listingName);
  const normB = normalizeNameKey(candidateName);
  if (normA && normB && (normA === normB || normA.includes(normB) || normB.includes(normA))) {
    return true;
  }

  return false;
}
