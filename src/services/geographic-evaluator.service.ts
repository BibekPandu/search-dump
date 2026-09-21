import {
  type LocalityClusterConfig,
  findRegisteredLocalityCluster,
  normalizeLocalityString,
  REGISTERED_LOCALITY_CLUSTERS,
} from '../config/geo-localities.config.js';
import { incrementTelemetry } from './telemetry.service.js';

export type GeographicStatus = 'inside' | 'outside' | 'ambiguous';

export interface GeographicDecision {
  status: GeographicStatus;
  reason: string;
  matchedRequestedLocality: boolean;
  matchedAlias?: string;
  matchedCanonicalLocality?: string;
  distanceKm?: number;
  evidence: {
    candidateAddress?: string;
    candidateTitle?: string;
    requestedLocation: string;
    extractedLocality?: string;
    coordinates?: { lat: number; lng: number };
  };
}

export interface CandidateGeoInput {
  title?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  extraSnippets?: string[];
}

const STREET_SUFFIX_REGEX = /^\s+(galli|gali|marga|marg|sadak|road|street|lane|way|path)\b/i;
const STREET_PREFIX_REGEX = /\b(galli|gali|marga|marg|sadak|road|street|lane|way|path)\s+$/i;

/**
 * Checks whether all occurrences of a locality/alias token in the text
 * are merely qualifiers within a street/lane name (e.g. "Chandragiri Galli", "Satungal Sadak").
 *
 * If every occurrence of the token is accompanied by a street marker
 * (and there are no standalone locality occurrences), returns true.
 */
export function isStreetNameOccurrence(text: string, localityToken: string): boolean {
  if (!text || !localityToken) return false;
  const lowerText = text.toLowerCase();
  const lowerToken = localityToken.toLowerCase().trim();
  if (!lowerToken || !lowerText.includes(lowerToken)) return false;

  const escapedToken = lowerToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokenRegex = new RegExp(`\\b${escapedToken}\\b`, 'gi');

  let match: RegExpExecArray | null;
  let totalOccurrences = 0;
  let streetOccurrences = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    totalOccurrences++;
    const matchIndex = match.index;
    const postText = text.slice(matchIndex + match[0].length);
    const preText = text.slice(Math.max(0, matchIndex - 30), matchIndex);

    const hasStreetSuffix = STREET_SUFFIX_REGEX.test(postText);
    const hasStreetPrefix = STREET_PREFIX_REGEX.test(preText);

    if (hasStreetSuffix || hasStreetPrefix) {
      streetOccurrences++;
    }
  }

  return totalOccurrences > 0 && streetOccurrences === totalOccurrences;
}

/**
 * Calculates Great-Circle distance between two GPS coordinates in kilometers using Haversine formula.
 */
export function calculateHaversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}

/**
 * Evaluates whether a candidate business is geographically inside, outside, or ambiguous
 * relative to the user's requested location.
 *
 * Implements the 5-layer evaluation model:
 * 1. Exact locality text match -> 'inside'
 * 2. Ward-level / contiguous alias match -> 'inside'
 * 3. GPS coordinate distance vs locality boundary radius -> 'inside' (<= R_max) | 'outside' (> R_max)
 * 4. Distinct conflicting non-adjacent locality text conflict -> 'outside'
 * 5. Generic / ambiguous fallback -> 'ambiguous' (or token fallback for unregistered regions)
 */
export function evaluateGeographicLocality(
  candidate: CandidateGeoInput,
  requestedLocation: string,
  dynamicCluster?: LocalityClusterConfig | null
): GeographicDecision {
  const normalizedRequested = normalizeLocalityString(requestedLocation);
  const combinedCandidateText = [
    candidate.title || '',
    candidate.address || '',
    ...(candidate.extraSnippets || []),
  ].join(' ');
  const normalizedCandidateText = normalizeLocalityString(combinedCandidateText);

  const coords =
    typeof candidate.latitude === 'number' && typeof candidate.longitude === 'number'
      ? { lat: candidate.latitude, lng: candidate.longitude }
      : undefined;

  const baseEvidence = {
    candidateAddress: candidate.address,
    candidateTitle: candidate.title,
    requestedLocation,
    coordinates: coords,
  };

  // If no requested location provided, cannot filter by geography -> ambiguous
  if (!normalizedRequested) {
    return {
      status: 'ambiguous',
      reason: 'No geographic location specified in query',
      matchedRequestedLocality: false,
      evidence: baseEvidence,
    };
  }

  const cluster = dynamicCluster || findRegisteredLocalityCluster(normalizedRequested);

  // === BRANCH 1: Registered Locality Cluster (e.g. Satungal, Kirtipur, Sinamangal) ===
  if (cluster) {
    const canonicalKey = cluster.canonicalName;

    // 1. Exact Locality Name Text Match (e.g. text contains "satungal")
    if (normalizedCandidateText.includes(canonicalKey)) {
      if (isStreetNameOccurrence(combinedCandidateText, canonicalKey)) {
        incrementTelemetry('streetNameCollisionsCaught');
      } else {
        return {
          status: 'inside',
          reason: `Candidate address or title explicitly matches target locality '${canonicalKey}'`,
          matchedRequestedLocality: true,
          matchedCanonicalLocality: canonicalKey,
          evidence: { ...baseEvidence, extractedLocality: canonicalKey },
        };
      }
    }

    // Ward exclusion guard before alias matching (e.g. Chandragiri Ward 5 is NOT Satungal Wards 11-13)
    if (canonicalKey === 'satungal') {
      const wardMatch = normalizedCandidateText.match(/chandragiri\s*(?:ward\s*|-)?\s*(\d+)/i);
      if (wardMatch) {
        const wardNum = parseInt(wardMatch[1], 10);
        if (wardNum && ![11, 12, 13].includes(wardNum)) {
          incrementTelemetry('conflictingLocalityExclusions');
          return {
            status: 'outside',
            reason: `Candidate address specifies Chandragiri Ward ${wardNum}, which is outside Satungal's administrative extent (Wards 11-13)`,
            matchedRequestedLocality: false,
            matchedCanonicalLocality: canonicalKey,
            evidence: { ...baseEvidence, extractedLocality: `chandragiri-${wardNum}` },
          };
        }
      }
    }

    // 2. Ward-level / Contiguous Locality Alias Match
    for (const alias of cluster.aliases) {
      const normAlias = normalizeLocalityString(alias);
      if (normalizedCandidateText.includes(normAlias)) {
        if (isStreetNameOccurrence(combinedCandidateText, alias)) {
          incrementTelemetry('streetNameCollisionsCaught');
          continue;
        }
        return {
          status: 'inside',
          reason: `Candidate matched verified administrative alias '${alias}' for '${canonicalKey}'`,
          matchedRequestedLocality: true,
          matchedAlias: alias,
          matchedCanonicalLocality: canonicalKey,
          evidence: { ...baseEvidence, extractedLocality: alias },
        };
      }
    }

    // 3. GPS Coordinate Distance Check (if candidate has coordinates)
    if (coords) {
      const distance = calculateHaversineDistanceKm(
        cluster.centroid.lat,
        cluster.centroid.lng,
        coords.lat,
        coords.lng
      );

      if (distance <= cluster.maxRadiusKm) {
        return {
          status: 'inside',
          reason: `Candidate GPS coordinates are within ${cluster.maxRadiusKm}km locality radius (${distance}km from ${canonicalKey} center)`,
          matchedRequestedLocality: true,
          matchedCanonicalLocality: canonicalKey,
          distanceKm: distance,
          evidence: { ...baseEvidence, extractedLocality: canonicalKey },
        };
      } else {
        incrementTelemetry('conflictingLocalityExclusions');
        return {
          status: 'outside',
          reason: `Candidate GPS distance (${distance}km) exceeds max boundary radius (${cluster.maxRadiusKm}km) for '${canonicalKey}'`,
          matchedRequestedLocality: false,
          matchedCanonicalLocality: canonicalKey,
          distanceKm: distance,
          evidence: baseEvidence,
        };
      }
    }

    // 4. Distinct Non-Adjacent Locality Text Conflict (No GPS available)
    // Check if address explicitly matches another registered cluster
    for (const [otherKey, otherCluster] of Object.entries(REGISTERED_LOCALITY_CLUSTERS)) {
      if (otherKey === canonicalKey) continue;
      if (
        normalizedCandidateText.includes(otherKey) &&
        !isStreetNameOccurrence(combinedCandidateText, otherKey)
      ) {
        incrementTelemetry('conflictingLocalityExclusions');
        return {
          status: 'outside',
          reason: `Candidate address specifies distinct non-adjacent locality '${otherKey}' instead of '${canonicalKey}'`,
          matchedRequestedLocality: false,
          matchedCanonicalLocality: canonicalKey,
          evidence: { ...baseEvidence, extractedLocality: otherKey },
        };
      }
      for (const alias of otherCluster.aliases) {
        const normAlias = normalizeLocalityString(alias);
        if (
          normalizedCandidateText.includes(normAlias) &&
          !isStreetNameOccurrence(combinedCandidateText, alias)
        ) {
          incrementTelemetry('conflictingLocalityExclusions');
          return {
            status: 'outside',
            reason: `Candidate address specifies distinct non-adjacent area '${alias}' instead of '${canonicalKey}'`,
            matchedRequestedLocality: false,
            matchedCanonicalLocality: canonicalKey,
            evidence: { ...baseEvidence, extractedLocality: alias },
          };
        }
      }
    }

    // 5. Generic / Ambiguous Fallback (e.g. "Kathmandu 44600" without specific tole)
    return {
      status: 'ambiguous',
      reason: `Address specifies district/city level only ('${candidate.address || 'unspecified'}'); exact locality unverifiable without GPS`,
      matchedRequestedLocality: false,
      matchedCanonicalLocality: canonicalKey,
      evidence: baseEvidence,
    };
  }

  // === BRANCH 2: Unregistered Locality Query (Permissive Token Fallback) ===
  const localityTokens = normalizedRequested
    .split(' ')
    .filter((t) => t.length > 3 && !['kathmandu', 'lalitpur', 'bhaktapur', 'nepal', 'district'].includes(t));

  for (const token of localityTokens) {
    if (normalizedCandidateText.includes(token)) {
      return {
        status: 'inside',
        reason: `Candidate text matches requested locality token '${token}'`,
        matchedRequestedLocality: true,
        evidence: { ...baseEvidence, extractedLocality: token },
      };
    }
  }

  return {
    status: 'ambiguous',
    reason: `Unregistered locality '${requestedLocation}'; candidate does not explicitly state token and is treated as ambiguous`,
    matchedRequestedLocality: false,
    evidence: baseEvidence,
  };
}

/**
 * Asynchronous geographic locality evaluator with dynamic geocoding escalation.
 *
 * Fast-path: Runs deterministic 5-layer evaluateGeographicLocality().
 * Escalation: If deterministic evaluation is 'ambiguous', candidate has NO GPS, and candidate
 * specifies an address, dynamically geocodes the candidate address using OpenStreetMap Nominatim,
 * calculates Haversine distance from the target cluster centroid, and asserts distance <= maxRadiusKm.
 */
export async function evaluateGeographicLocalityWithEscalation(
  candidate: CandidateGeoInput,
  requestedLocation: string,
  dynamicCluster?: LocalityClusterConfig | null,
  options?: { timeoutMs?: number; disableNetwork?: boolean }
): Promise<GeographicDecision> {
  const baseDecision = evaluateGeographicLocality(candidate, requestedLocation, dynamicCluster);

  // Deterministic fast-path: if already decided 'inside' or 'outside', return immediately
  if (baseDecision.status !== 'ambiguous') {
    return baseDecision;
  }

  // Escalation only applies if candidate has an address, no GPS coords, and a target cluster exists
  const candidateAddress = candidate.address?.trim();
  const hasGps = typeof candidate.latitude === 'number' && typeof candidate.longitude === 'number';
  if (!candidateAddress || hasGps) {
    return baseDecision;
  }

  const normalizedRequested = normalizeLocalityString(requestedLocation);
  const targetCluster = dynamicCluster || findRegisteredLocalityCluster(normalizedRequested);
  if (!targetCluster) {
    return baseDecision;
  }

  try {
    // Dynamically import geocoding service to avoid circular dependency cycles
    const { geocodeLocality } = await import('./geocoding.service.js');
    const addressCluster = await geocodeLocality(candidateAddress, options);

    if (addressCluster && addressCluster.centroid) {
      const distance = calculateHaversineDistanceKm(
        targetCluster.centroid.lat,
        targetCluster.centroid.lng,
        addressCluster.centroid.lat,
        addressCluster.centroid.lng
      );

      if (distance <= targetCluster.maxRadiusKm) {
        return {
          status: 'inside',
          reason: `Dynamic geocoding escalation: Address '${candidateAddress}' resolved to (${addressCluster.centroid.lat}, ${addressCluster.centroid.lng}), within ${distance}km of '${targetCluster.canonicalName}' (max radius ${targetCluster.maxRadiusKm}km)`,
          matchedRequestedLocality: true,
          matchedCanonicalLocality: targetCluster.canonicalName,
          distanceKm: distance,
          evidence: {
            ...baseDecision.evidence,
            coordinates: addressCluster.centroid,
            extractedLocality: addressCluster.canonicalName,
          },
        };
      } else {
        incrementTelemetry('conflictingLocalityExclusions');
        return {
          status: 'outside',
          reason: `Dynamic geocoding escalation: Address '${candidateAddress}' resolved to (${addressCluster.centroid.lat}, ${addressCluster.centroid.lng}), distance ${distance}km exceeds max radius ${targetCluster.maxRadiusKm}km for '${targetCluster.canonicalName}'`,
          matchedRequestedLocality: false,
          matchedCanonicalLocality: targetCluster.canonicalName,
          distanceKm: distance,
          evidence: {
            ...baseDecision.evidence,
            coordinates: addressCluster.centroid,
            extractedLocality: addressCluster.canonicalName,
          },
        };
      }
    }
  } catch (err: any) {
    console.warn(`[GeoEvaluator] Dynamic geocoding escalation failed for '${candidateAddress}': ${err.message || err}`);
  }

  return baseDecision;
}

