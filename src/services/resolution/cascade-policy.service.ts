/**
 * Cascade policy service.
 * Enforces quality-sorted hard caps and strict phone taxonomy normalization.
 */
import { z } from 'zod';
import { businessListingSchema } from '@/types/business-listing';
import { classifyNepalPhone } from '@/services/business-extractor.service';
import { normalizePhoneDigits } from '@/services/resolution/entity-resolution.service';

/**
 * Phase 8h (W2-08): Quality-Sorted Hard Cap for Final Business Listings.
 *
 * When targetCandidates is explicitly provided, sorts listings descending by confidence
 * (with contact completeness tie-breaking: phone/mobile, website, email, ratingCount),
 * and slices to the requested target.
 *
 * When targetCandidates is undefined/unset, preserves all listings without capping.
 */
export function applyTargetCandidatesCap(
  listings: Array<z.infer<typeof businessListingSchema>>,
  targetCandidates?: number
): Array<z.infer<typeof businessListingSchema>> {
  if (targetCandidates === undefined || listings.length <= targetCandidates) {
    return listings;
  }
  const sorted = [...listings].sort((a, b) => {
    const confA = a.metadata?.confidence ?? 0;
    const confB = b.metadata?.confidence ?? 0;
    if (confB !== confA) {
      return confB - confA;
    }
    const completenessA =
      (a.phones?.length || 0) +
      (a.mobiles?.length || 0) +
      (a.websites?.length ? 2 : 0) +
      (a.emails?.length ? 1 : 0) +
      (a.ratingCount ? 1 : 0);
    const completenessB =
      (b.phones?.length || 0) +
      (b.mobiles?.length || 0) +
      (b.websites?.length ? 2 : 0) +
      (b.emails?.length ? 1 : 0) +
      (b.ratingCount ? 1 : 0);
    return completenessB - completenessA;
  });
  return sorted.slice(0, targetCandidates);
}

/**
 * Re-classifies ALL phone/mobile numbers in a listing through classifyNepalPhone,
 * enforcing the strict phone taxonomy invariant:
 *
 *   canonicalDigits(all phones + mobiles) must be unique
 *   phones ∩ mobiles = ∅
 *
 * This is the FINAL safety net. Even if an earlier stage mis-routes a number,
 * this pass normalizes everything before downstream processing (Task 3 conflicts, save).
 *
 * Display policy: canonical digits determine identity; the first valid raw occurrence
 * for each canonical identity is preserved as the display string.
 */
export function normalizeListingPhones(listing: z.infer<typeof businessListingSchema>): void {
  const allRawPhones = [...(listing.phones || []), ...(listing.mobiles || [])];
  const normalizedPhones: string[] = [];
  const normalizedMobiles: string[] = [];
  const seenDigits = new Set<string>();

  for (const raw of allRawPhones) {
    const classified = classifyNepalPhone(raw);
    if (classified.type === 'invalid') continue; // Drop invalid
    const canonicalKey = normalizePhoneDigits(classified.digits || raw);
    if (!canonicalKey || seenDigits.has(canonicalKey)) continue; // Cross-array dedup by canonical identity
    seenDigits.add(canonicalKey);

    const display = classified.normalized || raw.trim();
    if (classified.type === 'mobile') {
      normalizedMobiles.push(display);
    } else {
      // landline | international
      normalizedPhones.push(display);
    }
  }

  listing.phones = normalizedPhones;
  listing.mobiles = normalizedMobiles;
}
