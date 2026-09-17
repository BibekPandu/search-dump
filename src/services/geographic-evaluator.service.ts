import {
  findRegisteredLocalityCluster,
  normalizeLocalityString,
  REGISTERED_LOCALITY_CLUSTERS,
} from '../config/geo-localities.config.js';

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
  requestedLocation: string
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

  const cluster = findRegisteredLocalityCluster(normalizedRequested);

  // === BRANCH 1: Registered Locality Cluster (e.g. Satungal, Kirtipur, Sinamangal) ===
  if (cluster) {
    const canonicalKey = cluster.canonicalName;

    // 1. Exact Locality Name Text Match (e.g. text contains "satungal")
    if (normalizedCandidateText.includes(canonicalKey)) {
      return {
        status: 'inside',
        reason: `Candidate address or title explicitly matches target locality '${canonicalKey}'`,
        matchedRequestedLocality: true,
        matchedCanonicalLocality: canonicalKey,
        evidence: { ...baseEvidence, extractedLocality: canonicalKey },
      };
    }

    // 2. Ward-level / Contiguous Locality Alias Match
    for (const alias of cluster.aliases) {
      const normAlias = normalizeLocalityString(alias);
      if (normalizedCandidateText.includes(normAlias)) {
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
      if (normalizedCandidateText.includes(otherKey)) {
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
        if (normalizedCandidateText.includes(normAlias)) {
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

    // Explicit non-Satungal ward check for Chandragiri (e.g., Chandragiri-1 through Chandragiri-10, 14-15)
    const wardMatch = normalizedCandidateText.match(/chandragiri\s*-?\s*(\d+)/i);
    if (wardMatch) {
      const wardNum = parseInt(wardMatch[1], 10);
      if (wardNum && ![11, 12, 13].includes(wardNum)) {
        return {
          status: 'outside',
          reason: `Candidate address specifies Chandragiri Ward ${wardNum}, which is outside Satungal's administrative extent (Wards 11-13)`,
          matchedRequestedLocality: false,
          matchedCanonicalLocality: canonicalKey,
          evidence: { ...baseEvidence, extractedLocality: `chandragiri-${wardNum}` },
        };
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
