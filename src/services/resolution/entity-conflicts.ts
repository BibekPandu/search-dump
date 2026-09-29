/**
 * Conflict detection, duplicate merging and multi-branch attribution.
 *
 * Consumes the matching layer: a conflict is a claim about an already
 * identified pair, and merging must never invent identity the matcher would
 * not have accepted.
 */

import { 
  AGGREGATOR_DOMAINS,
  DIRECTORY_DOMAINS,
  SOCIAL_DOMAINS
 } from '@/services/resolution/candidate-classifier.service';
import { 
  classifyNepalPhone,
  UNIVERSAL_STOPWORDS,
  CATEGORY_GENERIC_TOKENS
 } from '@/services/business-extractor.service';
import { 
  extractDistinctiveNameTokens
 } from '@/config/token-vocabulary.config';
import {
  findRegisteredLocalityCluster,
  normalizeLocalityString,
  REGISTERED_LOCALITY_CLUSTERS,
} from '@/config/geo-localities.config.js';
import { NTA_LANDLINE_AREA_CODES } from '@/config/nepal-telecom.config.js';
import type {
  ClassifiedContact,
  BranchAttributionResult,
} from '@/types/contact.js';
import {
  calculateHaversineDistanceKm,
  evaluateGeographicLocality,
  type CandidateGeoInput,
} from '@/services/resolution/geographic-evaluator.service';
import { 
  normalizePhoneDigits,
  normalizeNameKey,
  domainFromUrlOrHost,
  tokenJaccard,
  isIdentifyingEmail
 } from '@/services/resolution/entity-normalizers';
import { 
  isUsableOfficialWebsite
 } from '@/services/resolution/entity-matching';


// ============================================================================
// Cross-Listing Conflict & Cluster Detection Types (Task 3)
// ============================================================================

export interface ConflictCheckListing {
  name: string;
  location?: string;
  phones?: string[];
  mobiles?: string[];
  emails?: string[];
  websites?: string[];
  socialLinks?: {
    facebook?: string;
    tiktok?: string;
    instagram?: string;
    other?: Record<string, string>;
  };
  metadata?: {
    confidence?: number;
    source?: string;
    [key: string]: unknown;
  };
  otherDetails?: Record<string, unknown>;
  [key: string]: unknown;
}


export type CrossListingConflictType =
  | 'DUPLICATE_MAPS_LISTING'
  | 'POSSIBLY_SAME_ENTITY'
  | 'RELATED_BRAND'
  | 'SHARED_OFFICE'
  | 'NO_CONFLICT';


export interface CrossListingConflict {
  conflictType: CrossListingConflictType;
  conflictingListingName: string;
  conflictingListingIndex: number;
  signals: string[];
  sharedContacts: {
    emails: string[];
    phones: string[];
    domains: string[];
    socials: string[];
  };
  confidence: number;
  reason: string;
}


export interface ListingConflictSummary {
  hasConflict: boolean;
  conflictType: CrossListingConflictType;
  conflictingWith: string[];
  sharedSignals: string[];
  reasons: string[];
  clusterId?: number;
}


export interface ConflictDetectionResult {
  conflicts: Array<{
    listingIndexA: number;
    listingNameA: string;
    listingIndexB: number;
    listingNameB: string;
    conflict: CrossListingConflict;
  }>;
  clusters: Array<{
    clusterId: number;
    conflictType: CrossListingConflictType;
    listingIndices: number[];
    listingNames: string[];
    sharedIdentitySignals: string[];
  }>;
  annotatedListings: ConflictCheckListing[];
}


const SEVERITY_RANK: Record<CrossListingConflictType, number> = {
  DUPLICATE_MAPS_LISTING: 4,
  POSSIBLY_SAME_ENTITY: 3,
  RELATED_BRAND: 2,
  SHARED_OFFICE: 1,
  NO_CONFLICT: 0,
};


/**
 * Collects normalized social URLs from a listing.
 */
export function collectSocialUrls(listing: ConflictCheckListing): string[] {
  const urls: string[] = [];
  if (listing.socialLinks) {
    if (listing.socialLinks.facebook) urls.push(listing.socialLinks.facebook);
    if (listing.socialLinks.tiktok) urls.push(listing.socialLinks.tiktok);
    if (listing.socialLinks.instagram) urls.push(listing.socialLinks.instagram);
    if (listing.socialLinks.other && typeof listing.socialLinks.other === 'object') {
      for (const val of Object.values(listing.socialLinks.other)) {
        if (typeof val === 'string' && val.trim()) urls.push(val.trim());
      }
    }
  }
  return urls
    .map((u) => u.trim().toLowerCase().replace(/\/+$/, ''))
    .filter((u) => u.length > 0);
}


function extractCoordinates(listing: ConflictCheckListing): { lat?: number; lon?: number } {
  if (typeof listing.latitude === 'number' && typeof listing.longitude === 'number') {
    return { lat: listing.latitude, lon: listing.longitude };
  }
  const coords = listing.coordinates as { latitude?: number; longitude?: number; lat?: number; lon?: number } | undefined;
  if (coords) {
    if (typeof coords.latitude === 'number' && typeof coords.longitude === 'number') {
      return { lat: coords.latitude, lon: coords.longitude };
    }
    if (typeof coords.lat === 'number' && typeof coords.lon === 'number') {
      return { lat: coords.lat, lon: coords.lon };
    }
  }
  if (listing.otherDetails && typeof listing.otherDetails === 'object') {
    const od = listing.otherDetails as Record<string, unknown>;
    if (typeof od.latitude === 'number' && typeof od.longitude === 'number') {
      return { lat: od.latitude, lon: od.longitude };
    }
  }
  return {};
}


/**
 * Builds a clear, human-readable reason string explaining the conflict.
 */
export function buildConflictReason(
  conflictType: CrossListingConflictType,
  nameA: string,
  nameB: string,
  shared: {
    emails: string[];
    phones: string[];
    domains: string[];
    socials: string[];
    gpsDistanceKm?: number;
  }
): string {
  const parts: string[] = [];
  if (shared.phones.length > 0) parts.push(`phone(s) [${shared.phones.join(', ')}]`);
  if (shared.emails.length > 0) parts.push(`email(s) [${shared.emails.join(', ')}]`);
  if (shared.domains.length > 0) parts.push(`domain(s) [${shared.domains.join(', ')}]`);
  if (shared.socials.length > 0) parts.push(`social profile(s) [${shared.socials.join(', ')}]`);
  if (shared.gpsDistanceKm !== undefined && shared.gpsDistanceKm < 0.5) {
    parts.push(`GPS proximity (${(shared.gpsDistanceKm * 1000).toFixed(0)}m)`);
  }

  const details = parts.join(' and ');

  switch (conflictType) {
    case 'DUPLICATE_MAPS_LISTING':
      return `Potential duplicate Google Maps listing between "${nameA}" and "${nameB}" sharing ${details}`;
    case 'POSSIBLY_SAME_ENTITY':
      return `Strong contact-identity overlap between "${nameA}" and "${nameB}" sharing ${details}`;
    case 'RELATED_BRAND':
      return `Related brand or sister business relationship between "${nameA}" and "${nameB}" sharing ${details}`;
    case 'SHARED_OFFICE':
      return `Co-located or shared office indicators between "${nameA}" and "${nameB}" sharing ${details}`;
    default:
      return `Cross-listing contact overlap between "${nameA}" and "${nameB}" sharing ${details}`;
  }
}


/**
 * Evaluates whether two listings have contact identity overlap or conflict.
 * Returns a CrossListingConflict if suspicious overlap is found, or null otherwise.
 */
export function detectConflictBetweenListings(
  listingA: ConflictCheckListing,
  listingB: ConflictCheckListing,
  indexA: number,
  indexB: number
): CrossListingConflict | null {
  const phonesA = [...(listingA.phones || []), ...(listingA.mobiles || [])]
    .map((p) => normalizePhoneDigits(p))
    .filter((p) => p.length >= 7);
  const phonesB = [...(listingB.phones || []), ...(listingB.mobiles || [])]
    .map((p) => normalizePhoneDigits(p))
    .filter((p) => p.length >= 7);

  const emailsA = (listingA.emails || []).map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@'));
  const emailsB = (listingB.emails || []).map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@'));

  const domainsA = (listingA.websites || [])
    .map((w) => domainFromUrlOrHost(w))
    .filter((d) => Boolean(d) && !AGGREGATOR_DOMAINS.has(d) && !DIRECTORY_DOMAINS.has(d) && !SOCIAL_DOMAINS.has(d));
  const domainsB = (listingB.websites || [])
    .map((w) => domainFromUrlOrHost(w))
    .filter((d) => Boolean(d) && !AGGREGATOR_DOMAINS.has(d) && !DIRECTORY_DOMAINS.has(d) && !SOCIAL_DOMAINS.has(d));

  const socialsA = collectSocialUrls(listingA);
  const socialsB = collectSocialUrls(listingB);

  const sharedPhones = Array.from(new Set(phonesA.filter((p) => phonesB.includes(p))));
  const sharedEmails = Array.from(new Set(emailsA.filter((e) => emailsB.includes(e))));
  const sharedDomains = Array.from(new Set(domainsA.filter((d) => domainsB.includes(d))));
  const sharedSocials = Array.from(new Set(socialsA.filter((s) => socialsB.includes(s))));

  const coordsA = extractCoordinates(listingA);
  const coordsB = extractCoordinates(listingB);
  let gpsDistanceKm: number | undefined;
  if (coordsA.lat !== undefined && coordsA.lon !== undefined && coordsB.lat !== undefined && coordsB.lon !== undefined) {
    gpsDistanceKm = calculateHaversineDistanceKm(coordsA.lat, coordsA.lon, coordsB.lat, coordsB.lon, false);
  }

  const hasIdentifyingEmail = sharedEmails.some((e) => isIdentifyingEmail(e));
  const hasStrongIdentityContact = sharedPhones.length > 0 || hasIdentifyingEmail;

  let confidence = 0;
  const signals: string[] = [];

  if (hasIdentifyingEmail) {
    confidence += 0.40;
    signals.push(`shared_identifying_email:${sharedEmails.filter(isIdentifyingEmail).join(',')}`);
  } else if (sharedEmails.length > 0) {
    confidence += 0.30;
    signals.push(`shared_generic_email:${sharedEmails.join(',')}`);
  }

  if (sharedPhones.length >= 2) {
    confidence += 0.45;
    signals.push(`shared_multiple_phones:${sharedPhones.length}`);
  } else if (sharedPhones.length === 1) {
    confidence += 0.35;
    signals.push(`shared_phone:${sharedPhones[0]}`);
  }

  if (sharedDomains.length > 0) {
    confidence += 0.35;
    signals.push(`shared_domain:${sharedDomains.join(',')}`);
  }

  if (sharedSocials.length >= 3) {
    confidence += 0.25;
    signals.push(`shared_multiple_socials:${sharedSocials.length}`);
  } else if (sharedSocials.length > 0) {
    confidence += 0.15;
    signals.push(`shared_social:${sharedSocials.join(',')}`);
  }

  if (gpsDistanceKm !== undefined) {
    if (gpsDistanceKm < 0.05) {
      confidence += 0.35;
      signals.push(`gps_distance_under_50m:${(gpsDistanceKm * 1000).toFixed(0)}m`);
    } else if (gpsDistanceKm < 0.5) {
      confidence += 0.30;
      signals.push(`gps_distance_under_500m:${(gpsDistanceKm * 1000).toFixed(0)}m`);
    }
  }

  const nameSimilarity = tokenJaccard(normalizeNameKey(listingA.name), normalizeNameKey(listingB.name));
  if (nameSimilarity >= 0.85) {
    confidence += 0.15;
    signals.push(`high_name_similarity:${nameSimilarity.toFixed(2)}`);
  }

  confidence = Math.min(0.99, Math.round(confidence * 100) / 100);

  if (confidence < 0.30 || signals.length === 0) {
    return null;
  }

  let conflictType: CrossListingConflictType = 'NO_CONFLICT';

  // 1. DUPLICATE_MAPS_LISTING — Strict duplicate gate: GPS <50m AND shared canonical phone AND shared domain
  if (gpsDistanceKm !== undefined && gpsDistanceKm < 0.05 && sharedPhones.length > 0 && sharedDomains.length > 0) {
    conflictType = 'DUPLICATE_MAPS_LISTING';
  }
  // 2. POSSIBLY_SAME_ENTITY — Strong contact-identity overlap across different listing identities
  else if (hasStrongIdentityContact) {
    conflictType = 'POSSIBLY_SAME_ENTITY';
  }
  // 3. RELATED_BRAND — Same website domain or social media profile without direct contact identity clash
  else if (sharedDomains.length > 0 || sharedSocials.length > 0) {
    conflictType = 'RELATED_BRAND';
  }
  // 4. SHARED_OFFICE — Generic email / co-located address only
  else if (sharedEmails.length > 0 || (gpsDistanceKm !== undefined && gpsDistanceKm < 0.5)) {
    conflictType = 'SHARED_OFFICE';
  }

  if (conflictType === 'NO_CONFLICT') {
    return null;
  }

  const reason = buildConflictReason(conflictType, listingA.name, listingB.name, {
    emails: sharedEmails,
    phones: sharedPhones,
    domains: sharedDomains,
    socials: sharedSocials,
    gpsDistanceKm,
  });

  return {
    conflictType,
    conflictingListingName: listingB.name,
    conflictingListingIndex: indexB,
    signals,
    sharedContacts: {
      emails: sharedEmails,
      phones: sharedPhones,
      domains: sharedDomains,
      socials: sharedSocials,
    },
    confidence,
    reason,
  };
}


/**
 * Detects cross-listing entity conflicts and returns annotated listings.
 *
 * CONTRACT: `annotatedListings` is returned in the exact same order and
 * cardinality as the input `listings` array. `annotatedListings[i]`
 * corresponds to `listings[i]`.
 *
 * This ordering guarantee is used by the confidence model (Task 5) to
 * reapply entity conflict annotations back to the original listings.
 * Do NOT change this to `.filter().map()` or any operation that alters order.
 */
export function detectCrossListingConflicts(listings: ConflictCheckListing[]): ConflictDetectionResult {
  if (!listings || listings.length <= 1) {
    const annotatedListings = (listings || []).map((listing) => ({
      ...listing,
      otherDetails: {
        ...(listing.otherDetails || {}),
        entityConflict: {
          hasConflict: false,
          conflictType: 'NO_CONFLICT' as CrossListingConflictType,
          conflictingWith: [],
          sharedSignals: [],
          reasons: [],
        },
      },
    }));

    return {
      conflicts: [],
      clusters: [],
      annotatedListings,
    };
  }

  const detectedConflicts: ConflictDetectionResult['conflicts'] = [];
  const adj = new Map<number, number[]>();
  const listingConflictsMap = new Map<number, Array<{ conflict: CrossListingConflict; otherIndex: number; otherName: string }>>();

  for (let i = 0; i < listings.length; i++) {
    adj.set(i, []);
    listingConflictsMap.set(i, []);
  }

  for (let i = 0; i < listings.length; i++) {
    for (let j = i + 1; j < listings.length; j++) {
      const conflict = detectConflictBetweenListings(listings[i], listings[j], i, j);
      if (conflict) {
        detectedConflicts.push({
          listingIndexA: i,
          listingNameA: listings[i].name,
          listingIndexB: j,
          listingNameB: listings[j].name,
          conflict,
        });

        adj.get(i)!.push(j);
        adj.get(j)!.push(i);

        listingConflictsMap.get(i)!.push({ conflict, otherIndex: j, otherName: listings[j].name });

        // Symmetrical conflict for listing B referencing listing A
        const reverseConflict: CrossListingConflict = {
          ...conflict,
          conflictingListingName: listings[i].name,
          conflictingListingIndex: i,
          reason: buildConflictReason(conflict.conflictType, listings[j].name, listings[i].name, {
            emails: conflict.sharedContacts.emails,
            phones: conflict.sharedContacts.phones,
            domains: conflict.sharedContacts.domains,
            socials: conflict.sharedContacts.socials,
          }),
        };
        listingConflictsMap.get(j)!.push({ conflict: reverseConflict, otherIndex: i, otherName: listings[i].name });
      }
    }
  }

  // Build Connected Component Clusters using BFS
  const visited = new Set<number>();
  const clusters: ConflictDetectionResult['clusters'] = [];
  const listingToClusterId = new Map<number, number>();
  let nextClusterId = 1;

  for (let i = 0; i < listings.length; i++) {
    if (visited.has(i)) continue;
    const neighbors = adj.get(i) || [];
    if (neighbors.length === 0) continue;

    const component: number[] = [];
    const queue: number[] = [i];
    visited.add(i);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);

      for (const neighbor of adj.get(current) || []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (component.length > 1) {
      const clusterId = nextClusterId++;
      component.sort((a, b) => a - b);
      for (const idx of component) {
        listingToClusterId.set(idx, clusterId);
      }

      // Collect all signals & highest severity conflict in component
      let maxSeverityType: CrossListingConflictType = 'NO_CONFLICT';
      const clusterSignals = new Set<string>();

      for (const cIdx of component) {
        const itemConflicts = listingConflictsMap.get(cIdx) || [];
        for (const ic of itemConflicts) {
          if (SEVERITY_RANK[ic.conflict.conflictType] > SEVERITY_RANK[maxSeverityType]) {
            maxSeverityType = ic.conflict.conflictType;
          }
          for (const sig of ic.conflict.signals) {
            clusterSignals.add(sig);
          }
        }
      }

      clusters.push({
        clusterId,
        conflictType: maxSeverityType,
        listingIndices: component,
        listingNames: component.map((idx) => listings[idx].name),
        sharedIdentitySignals: Array.from(clusterSignals),
      });
    }
  }

  // Annotate listings without mutating any other listing fields
  const annotatedListings = listings.map((listing, idx) => {
    const conflicts = listingConflictsMap.get(idx) || [];
    if (conflicts.length === 0) {
      return {
        ...listing,
        otherDetails: {
          ...(listing.otherDetails || {}),
          entityConflict: {
            hasConflict: false,
            conflictType: 'NO_CONFLICT' as CrossListingConflictType,
            conflictingWith: [],
            sharedSignals: [],
            reasons: [],
          },
        },
      };
    }

    let maxSeverity: CrossListingConflictType = 'NO_CONFLICT';
    const conflictingWith: string[] = [];
    const sharedSignalsSet = new Set<string>();
    const reasons: string[] = [];

    for (const c of conflicts) {
      conflictingWith.push(c.otherName);
      reasons.push(c.conflict.reason);
      if (SEVERITY_RANK[c.conflict.conflictType] > SEVERITY_RANK[maxSeverity]) {
        maxSeverity = c.conflict.conflictType;
      }
      for (const sig of c.conflict.signals) {
        sharedSignalsSet.add(sig);
      }
    }

    return {
      ...listing,
      otherDetails: {
        ...(listing.otherDetails || {}),
        entityConflict: {
          hasConflict: true,
          conflictType: maxSeverity,
          conflictingWith,
          sharedSignals: Array.from(sharedSignalsSet),
          reasons,
          clusterId: listingToClusterId.get(idx),
        },
      },
    };
  });

  return {
    conflicts: detectedConflicts,
    clusters,
    annotatedListings,
  };
}


/**
 * Phase 8g: Automated Same-Domain Entity Deduplication
 *
 * Phase 8j Task 3 (Group H) & Phase 8e Master: Multi-Signal Duplicate Entity Merging.
 * Automatically merges candidate listings when:
 * 1. They share a first-party domain, verified phone number, or verified social profile, AND
 * 2. They have strong entity alignment (POSSIBLY_SAME_ENTITY, DUPLICATE_MAPS_LISTING, or RELATED_BRAND with name similarity >= 0.5).
 *
 * The primary listing absorbs contacts, while the merged secondary listing
 * is tracked in `otherDetails.mergedAliases`.
 */
export function mergeDuplicateEntities<T extends ConflictCheckListing>(
  listings: T[]
): { mergedListings: T[]; mergedCount: number; autoMergedCount: number } {
  if (!listings || listings.length <= 1) {
    return { mergedListings: listings, mergedCount: 0, autoMergedCount: 0 };
  }

  const { conflicts } = detectCrossListingConflicts(listings);
  // Find pairs with shared first-party domain, phone, or social AND distinctive entity alignment
  const mergePairs = conflicts.filter((c) => {
    const listingA = listings[c.listingIndexA];
    const listingB = listings[c.listingIndexB];
    if (!listingA || !listingB) return false;

    const isDomainShared =
      c.conflict.sharedContacts.domains.length > 0 &&
      c.conflict.sharedContacts.domains.some((d: string) => isUsableOfficialWebsite(`https://${d}`));

    const isPhoneShared =
      c.conflict.sharedContacts.phones.length > 0 || ((c.conflict.sharedContacts as any).mobiles?.length || 0) > 0;

    const isSocialShared =
      c.conflict.sharedContacts.socials && c.conflict.sharedContacts.socials.length > 0;

    const hasSharedContact = isDomainShared || isPhoneShared || isSocialShared;
    if (!hasSharedContact) return false;

    // Distinctive Name Analysis (Two-Gate Safety Architecture)
    const distinctiveA = extractDistinctiveNameTokens(listingA.name || '');
    const distinctiveB = extractDistinctiveNameTokens(listingB.name || '');
    const sharedTokens = distinctiveA.filter((t) => distinctiveB.includes(t));
    const unionTokens = new Set([...distinctiveA, ...distinctiveB]);
    const nameJaccard =
      distinctiveA.length > 0 && distinctiveB.length > 0 && unionTokens.size > 0
        ? sharedTokens.length / unionTokens.size
        : 0;

    const domainA = listingA.websites?.[0] ? domainFromUrlOrHost(listingA.websites[0]) : '';
    const domainB = listingB.websites?.[0] ? domainFromUrlOrHost(listingB.websites[0]) : '';
    const hasConflictingDomains = Boolean(domainA && domainB && domainA !== domainB);

    // Gate 1: Exact phone match (>= 7 digits) - strongest physical identity signal
    const hasExactPhoneMatch = isPhoneShared && c.conflict.sharedContacts.phones.some((p) => {
      const digits = normalizePhoneDigits(p);
      return digits.length >= 7;
    });
    if (hasExactPhoneMatch) {
      // Strong phone signal, but conflicting official domains -> require distinctive name confirmation
      if (hasConflictingDomains) {
        return nameJaccard >= 0.6;
      }
      return true;
    }

    // Gate 2a: Exact first-party domain match AND distinctive name alignment (nameJaccard >= 0.4 or subset)
    const isNameSubset =
      distinctiveA.length > 0 &&
      distinctiveB.length > 0 &&
      (distinctiveA.every((t) => distinctiveB.includes(t)) || distinctiveB.every((t) => distinctiveA.includes(t)));

    if (isDomainShared && (nameJaccard >= 0.4 || isNameSubset)) {
      return true;
    }

    // Gate 2b: Very strong name similarity alone (nameJaccard >= 0.7) when contacts align
    if (nameJaccard >= 0.7 && (isDomainShared || isSocialShared)) {
      return true;
    }

    // Pure generic names fallback: if both have 0 distinctive tokens, require strict normalized name match
    if (distinctiveA.length === 0 && distinctiveB.length === 0) {
      if (normalizeNameKey(listingA.name) === normalizeNameKey(listingB.name)) {
        return true;
      }
    }

    return false;
  });

  if (mergePairs.length === 0) {
    return { mergedListings: listings, mergedCount: 0, autoMergedCount: 0 };
  }

  const parent = Array.from({ length: listings.length }, (_, i) => i);
  function find(i: number): number {
    if (parent[i] === i) return i;
    parent[i] = find(parent[i]);
    return parent[i];
  }
  function union(i: number, j: number) {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) parent[rootI] = rootJ;
  }

  for (const pair of mergePairs) {
    union(pair.listingIndexA, pair.listingIndexB);
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < listings.length; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(i);
  }

  const mergedListings: T[] = [];
  let mergedCount = 0;

  for (const indices of clusters.values()) {
    if (indices.length === 1) {
      mergedListings.push(listings[indices[0]]);
      continue;
    }

    // Multiple listings in cluster — apply 4-tier deterministic tie-breaker
    const clusterItems = indices.map((idx) => listings[idx]);


const MERGE_CLUSTER_SIZE_CAP = 3;

const MERGE_DISTINCT_DOMAINS_CAP = 2;

    const distinctDomains = new Set(
      clusterItems.flatMap((c) => c.websites || []).map(domainFromUrlOrHost).filter(Boolean)
    );

    // Safety guard: Refuse auto-merging oversized clusters (>3) or clusters with multiple distinct domains (>=2)
    if (clusterItems.length > MERGE_CLUSTER_SIZE_CAP || distinctDomains.size >= MERGE_DISTINCT_DOMAINS_CAP) {
      console.warn(
        `[MergeGuard] Refusing to auto-merge cluster of ${clusterItems.length} listings with ${distinctDomains.size} distinct domains (suspected false-merge cascade):`,
        clusterItems.map((c) => ({
          name: c.name,
          websites: c.websites,
          phones: c.phones,
          mobiles: c.mobiles,
          distinctiveTokens: extractDistinctiveNameTokens(c.name),
        }))
      );
      for (const item of clusterItems) {
        mergedListings.push({
          ...item,
          otherDetails: {
            ...(item.otherDetails as any),
            suspectedCluster: true,
          },
        });
      }
      continue;
    }

    clusterItems.sort((a, b) => {
      // 1. Confidence score
      const confA = a.metadata?.confidence ?? 0;
      const confB = b.metadata?.confidence ?? 0;
      if (confA !== confB) return confB - confA;

      // 2. Verified contact count
      const contactsA =
        (a.phones?.length || 0) +
        (a.mobiles?.length || 0) +
        (a.emails?.length || 0) +
        Object.keys(a.socialLinks || {}).filter((k) => (a.socialLinks as any)[k]).length;
      const contactsB =
        (b.phones?.length || 0) +
        (b.mobiles?.length || 0) +
        (b.emails?.length || 0) +
        Object.keys(b.socialLinks || {}).filter((k) => (b.socialLinks as any)[k]).length;
      if (contactsA !== contactsB) return contactsB - contactsA;

      // 3. Origin authority (google_maps > web)
      const isMapsA = a.metadata?.source === 'google_maps';
      const isMapsB = b.metadata?.source === 'google_maps';
      if (isMapsA && !isMapsB) return -1;
      if (!isMapsA && isMapsB) return 1;

      // 4. Alphabetical tie-breaker
      return a.name.localeCompare(b.name);
    });

    const primary = { ...clusterItems[0] };
    const secondaries = clusterItems.slice(1);
    mergedCount += secondaries.length;

    // Merge contacts from secondaries into primary
    const mergedEmails = new Set([...(primary.emails || [])]);
    const mergedPhones = new Set([...(primary.phones || [])]);
    const mergedMobiles = new Set([...(primary.mobiles || [])]);
    const mergedWebsites = new Set([...(primary.websites || [])]);

    const primarySocials = { ...(primary.socialLinks || { facebook: '', tiktok: '', instagram: '', other: {} }) };

    const aliases: Array<{ name: string; source?: string }> = [
      ...((primary.otherDetails as any)?.mergedAliases || []),
    ];

    for (const sec of secondaries) {
      for (const e of sec.emails || []) mergedEmails.add(e);
      for (const p of sec.phones || []) mergedPhones.add(p);
      for (const m of sec.mobiles || []) mergedMobiles.add(m);
      for (const w of sec.websites || []) mergedWebsites.add(w);

      if (!primarySocials.facebook && sec.socialLinks?.facebook) primarySocials.facebook = sec.socialLinks.facebook;
      if (!primarySocials.instagram && sec.socialLinks?.instagram) primarySocials.instagram = sec.socialLinks.instagram;
      if (!primarySocials.tiktok && sec.socialLinks?.tiktok) primarySocials.tiktok = sec.socialLinks.tiktok;

      aliases.push({
        name: sec.name,
        source: sec.metadata?.source,
      });
    }

    primary.emails = [...mergedEmails];
    primary.phones = [...mergedPhones];
    primary.mobiles = [...mergedMobiles];
    primary.websites = [...mergedWebsites];
    primary.socialLinks = primarySocials;
    primary.otherDetails = {
      ...(primary.otherDetails || {}),
      mergedAliases: aliases,
    };

    mergedListings.push(primary);
  }

  return {
    mergedListings,
    mergedCount,
    autoMergedCount: mergedCount,
  };
}


/** Backward-compatible alias for mergeDuplicateEntities */
export const mergeDuplicateDomainEntities = mergeDuplicateEntities;

// ============================================================================
// Phase 8k Component 3 — Four-Tier Multi-Branch Contact Attribution
// ============================================================================




/**
 * Expanded hotline/head-office indicator phrases that mark a contact as belonging
 * to the whole business rather than a specific branch.
 */
const GENERAL_BUSINESS_PHRASES = [
  'head office', 'head-office', 'headoffice',
  'main office', 'main-office', 'mainoffice',
  'central office', 'central-office',
  'hotline', 'toll free', 'toll-free', 'tollfree',
  'customer care', 'customer service',
  'national helpline', 'national contact',
  'corporate office', 'registered office',
  'hq', 'headquarters',
  'general enquiry', 'general inquiry',
];


/**
 * Phase 8k Component 3 — Evidence-driven four-tier branch attribution.
 *
 * For each classified contact in a multi-branch listing, determines whether it belongs to:
 *  1. `target_branch`    — matches the queried locality (by GPS haversine or address text)
 *  2. `general_business` — a national hotline / head-office signal, or intra-district contact
 *  3. `branch_contact`   — a foreign-district contact (GPS > R from target, or conflicting locality text)
 *  4. `unattributed`     — not enough evidence to determine branch ownership
 *
 * @param contacts         All dedup'd classified contacts from a multi-branch candidate
 * @param targetLocation   The locality the user searched (e.g. 'Satungal')
 * @param mapsPhone        The canonical phone from Maps (if any) — Maps phone is always target_branch
 * @param candidateCoords  GPS of the Maps-anchor place result (if available)
 * @param dynamicCluster   Pre-resolved locality cluster from the geo evaluator
 */
export function attributeMultiBranchContacts(
  contacts: ClassifiedContact[],
  targetLocation: string,
  mapsPhone?: string,
  candidateCoords?: { lat: number; lng: number },
  dynamicCluster?: import('@/config/geo-localities.config.js').LocalityClusterConfig | null,
  businessName?: string
): BranchAttributionResult[] {
  const results: BranchAttributionResult[] = [];

  // Canonicalize the Maps phone digits for identity comparison
  const mapsPhoneDigits = mapsPhone ? classifyNepalPhone(mapsPhone).digits : undefined;

  const allGenericCategoryTokens = new Set<string>([
    ...UNIVERSAL_STOPWORDS,
    ...Object.values(CATEGORY_GENERIC_TOKENS).flat(),
  ]);

  const GENERIC_BRANCH_NOUNS = new Set(['branch', 'office', 'center', 'centre', 'outlet', 'outlets']);

  // Distinctive tokens from the business name
  const businessTokens = (businessName || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !allGenericCategoryTokens.has(w));

  for (const contact of contacts) {
    const ctx = (contact.context || '').toLowerCase();
    const canonicalDigits = contact.canonicalDigits || '';

    // ── Tier 1: General Business / Hotline Phrases ───────────────────────────
    // General business/hotline/head-office phrases ALWAYS take precedence over raw phone assignment.
    const hasGeneralPhrase = GENERAL_BUSINESS_PHRASES.some((phrase) => ctx.includes(phrase));
    if (hasGeneralPhrase) {
      results.push({
        contact,
        attribution: 'general_business',
        reason: `General business phrase detected in context: "${ctx.slice(0, 60)}"`,
      });
      continue;
    }

    // ── Tier 2: Locality Conflict Detection in Context ───────────────────────
    // If context text explicitly specifies a distinct foreign locality (e.g. "7 Banepa", "Patan Branch", "Pokhara"),
    // it is attributed as branch_contact regardless of whether it is a mobile or landline.
    if (ctx.trim()) {
      const lowerCtx = ctx.toLowerCase();

      // Phase 8N Amendment 2: Precise Self-Context Rule
      // Skip branch classification if, after stripping parens, stopwords, category tokens, and business tokens,
      // the remaining context is empty OR contains only generic branch nouns.
      const strippedCtx = lowerCtx
        .replace(/\(.*?\)/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .trim();

      const ctxWords = strippedCtx
        .split(/\s+/)
        .filter((w) => w.length >= 2);

      const nonSelfWords = ctxWords.filter(
        (w) =>
          !allGenericCategoryTokens.has(w) &&
          !businessTokens.includes(w) &&
          !GENERIC_BRANCH_NOUNS.has(w)
      );

      if (ctxWords.length > 0 && nonSelfWords.length === 0) {
        results.push({
          contact,
          attribution: 'target_branch',
          reason: `Context is self-referential to primary business name/category: "${ctx.slice(0, 60)}"`,
        });
        continue;
      }

      const targetClusterObj =
        dynamicCluster ||
        findRegisteredLocalityCluster(normalizeLocalityString(targetLocation)) ||
        REGISTERED_LOCALITY_CLUSTERS['satungal'];
      const targetCanonical = targetClusterObj?.canonicalName || 'satungal';
      const targetAliases = new Set([
        targetCanonical,
        ...(targetClusterObj?.aliases || []).map((a) => normalizeLocalityString(a)),
      ]);

      let foreignBranchFound = false;
      for (const [otherKey, otherCluster] of Object.entries(REGISTERED_LOCALITY_CLUSTERS)) {
        if (otherKey === targetCanonical || targetAliases.has(otherKey)) continue;

        const otherAliases = [otherKey, ...(otherCluster.aliases || [])].map((a) => normalizeLocalityString(a));
        const matchesOther = otherAliases.some((alias) => new RegExp(`\\b${alias}\\b`, 'i').test(lowerCtx));

        if (matchesOther) {
          const rawLabel = otherCluster.canonicalName || otherCluster.administrativeExtent.split('(')[0].trim();
          const branchLabel = rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1) + ' Branch';
          results.push({
            contact,
            attribution: 'branch_contact',
            branchLabel,
            reason: `Context text specifies foreign locality '${otherKey}' (${otherCluster.administrativeExtent})`,
          });
          foreignBranchFound = true;
          break;
        }
      }

      // Amendment 2: Generic fallback for unregistered localities in context (e.g., "Thamel Branch", "Naxal Center")
      if (!foreignBranchFound && contact.type === 'phone' && contact.phoneType === 'mobile') {
        const branchMatch = lowerCtx.match(/\b([a-z]+)\s+(branch|office|center|centre|outlet)\b/i);
        if (branchMatch) {
          const matchedLocality = branchMatch[1].toLowerCase();
          if (
            matchedLocality !== targetCanonical &&
            !targetAliases.has(matchedLocality) &&
            !allGenericCategoryTokens.has(matchedLocality) &&
            !businessTokens.includes(matchedLocality) &&
            !GENERIC_BRANCH_NOUNS.has(matchedLocality)
          ) {
            const rawLabel = branchMatch[1];
            const branchLabel = rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1) + ' Branch';
            results.push({
              contact,
              attribution: 'branch_contact',
              branchLabel,
              reason: `Context text implies foreign locality branch: '${rawLabel} ${branchMatch[2]}'`,
            });
            foreignBranchFound = true;
          }
        }
      }

      if (foreignBranchFound) {
        continue;
      }

      const contextGeoInput: CandidateGeoInput = {
        title: '',
        address: ctx,
      };
      const geoDecision = evaluateGeographicLocality(contextGeoInput, targetLocation, dynamicCluster);

      if (geoDecision.status === 'outside') {
        const matchedLocality =
          geoDecision.evidence.extractedLocality ||
          ctx.match(/\b([a-z]{4,})\b/i)?.[1] ||
          'Other';
        const branchLabel =
          matchedLocality.charAt(0).toUpperCase() + matchedLocality.slice(1).toLowerCase() + ' Branch';

        results.push({
          contact,
          attribution: 'branch_contact',
          branchLabel,
          reason: `Context text specifies a distinct non-adjacent locality: ${geoDecision.reason}`,
        });
        continue;
      }

      if (geoDecision.status === 'inside') {
        results.push({
          contact,
          attribution: 'target_branch',
          reason: `Context text matches target locality: ${geoDecision.reason}`,
        });
        continue;
      }
    }

    // ── Tier 2b: Telecom Landline STD Area Code Isolation ────────────────────
    // If contact is a landline, check whether its dialing area code is outside target zone
    const targetClusterForArea = dynamicCluster || findRegisteredLocalityCluster(normalizeLocalityString(targetLocation));
    const classifiedLandline = contact.phoneType === 'landline' ? classifyNepalPhone(contact.value) : null;
    if (classifiedLandline && classifiedLandline.type === 'landline') {
      const digits = classifiedLandline.digits;
      const isKathmanduLandline = digits.length === 8 && digits.startsWith('1');
      const targetIsKathmandu = !targetClusterForArea || [
        'satungal', 'anamnagar', 'kirtipur', 'sinamangal', 'baneshwor',
        'thamel', 'chabahil', 'koteshwor', 'kalanki', 'bhaktapur', 'lalitpur'
      ].includes(targetClusterForArea.canonicalName);

      if (targetIsKathmandu && !isKathmanduLandline && digits.length === 8) {
        const areaCode = '0' + digits.slice(0, 2);
        const areaInfo = NTA_LANDLINE_AREA_CODES[areaCode];
        const branchLabel = (areaInfo?.region || `Area ${areaCode}`) + ' Branch';
        results.push({
          contact,
          attribution: 'branch_contact',
          branchLabel,
          reason: `Landline area code ${areaCode} (${areaInfo?.region || 'Regional Nepal'}) is outside target Kathmandu locality`,
        });
        continue;
      }
    }

    // ── Tier 3: Maps Phone Anchor ───────────────────────────────────────────
    // If phone matches Maps ground-truth and has no conflicting context, attribute to target_branch.
    if (mapsPhoneDigits && canonicalDigits && canonicalDigits === mapsPhoneDigits) {
      results.push({
        contact,
        attribution: 'target_branch',
        reason: 'Maps anchor phone with no conflicting context: target_branch',
      });
      continue;
    }

    // ── Tier 4: GPS-Based Distance Check ────────────────────────────────────
    const targetCluster = dynamicCluster || findRegisteredLocalityCluster(normalizeLocalityString(targetLocation));

    if (targetCluster && candidateCoords) {
      const distance = calculateHaversineDistanceKm(
        targetCluster.centroid.lat,
        targetCluster.centroid.lng,
        candidateCoords.lat,
        candidateCoords.lng
      );

      if (distance <= targetCluster.maxRadiusKm) {
        results.push({
          contact,
          attribution: 'target_branch',
          distanceKm: distance,
          reason: `GPS within target radius: ${distance}km <= ${targetCluster.maxRadiusKm}km for '${targetCluster.canonicalName}'`,
        });
        continue;
      }
    }

    // ── Tier 4: Intra-District Fallback → General Business ───────────────────
    // No GPS, no locality conflict, no hotline phrase, but contact is phone/landline.
    // Intra-district contacts (district-level address, no sub-locality conflict) are
    // promoted to general_business rather than left unattributed.
    if (contact.role === 'primary_business' && contact.owner === 'business') {
      results.push({
        contact,
        attribution: 'general_business',
        reason: 'Primary business role with no locality conflict: treated as general_business (intra-district fallback)',
      });
      continue;
    }

    // ── Tier 4: Unattributed ─────────────────────────────────────────────────
    results.push({
      contact,
      attribution: 'unattributed',
      reason: 'Insufficient locality evidence to determine branch ownership',
    });
  }

  return results;
}


/**
 * Phase 8k Component 3 — Unattributed-Only Policy.
 *
 * When ALL non-Maps contacts are unattributed, the listing ships with phones: [].
 * The website and Maps phone (if present) remain intact.
 * A confidence penalty of -0.12 is applied to the listing metadata.
 *
 * @returns Whether all non-Maps contacts were unattributed
 */
export function isAllContactsUnattributed(
  attributions: BranchAttributionResult[],
  mapsPhoneDigits?: string
): boolean {
  const nonMapsAttributions = attributions.filter(
    (a) => !(mapsPhoneDigits && a.contact.canonicalDigits === mapsPhoneDigits)
  );
  if (nonMapsAttributions.length === 0) return false;
  return nonMapsAttributions.every((a) => a.attribution === 'unattributed');
}

