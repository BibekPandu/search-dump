import type { SerperPlaceResult } from './serper-places.service';
import {
  type UnifiedSearchResult,
  normalizeUrl,
  extractDomain,
} from './search-fallback.service';
import type {
  ResearchDecision,
  ResearchCandidate,
} from '../mastra/agents/research-agent/schema';
import {
  resolveEntityPair,
  dedupeByEntity,
  isUsableOfficialWebsite,
  type EntityEvidence,
} from './entity-resolution.service';

// ============================================================================
// Research Candidate Builder
// ============================================================================

export interface BuildResearchCandidatesParams {
  places: SerperPlaceResult[];
  webUsable: Array<{ candidate: UnifiedSearchResult; decision: ResearchDecision }>;
  defaultLocation?: string;
}

export interface BuildResearchCandidatesResult {
  candidates: ResearchCandidate[];
  matchesMerged: number;
}

/**
 * Builds canonical ResearchCandidate entities from Google Maps and Web search evidence.
 * Merges evidence deterministically using 0-token entity resolution.
 */
export function buildResearchCandidates(
  inputOrPlaces:
    | {
        places?: SerperPlaceResult[];
        webUsable?: Array<{ candidate: UnifiedSearchResult; decision: ResearchDecision }>;
        defaultLocation?: string;
      }
    | SerperPlaceResult[],
  legacyWebResults: UnifiedSearchResult[] = [],
  legacyOptions: {
    classifier?: (item: UnifiedSearchResult) => Promise<ResearchDecision> | ResearchDecision;
    defaultLocation?: string;
  } = {}
): { candidates: ResearchCandidate[]; matchesMerged: number } {
  let rawPlaces: SerperPlaceResult[] = [];
  let webUsable: Array<{ candidate: UnifiedSearchResult; decision: ResearchDecision }> = [];
  let defaultLocation: string | undefined;

  if (Array.isArray(inputOrPlaces)) {
    rawPlaces = inputOrPlaces;
    defaultLocation = legacyOptions.defaultLocation;
    for (const r of legacyWebResults) {
      webUsable.push({
        candidate: r,
        decision: {
          url: r.url,
          domain: r.domain,
          title: r.title,
          classification: 'business',
          confidence: 1.0,
          reason: 'Legacy input accepted',
          source: 'deterministic',
        },
      });
    }
  } else {
    rawPlaces = inputOrPlaces.places || [];
    webUsable = inputOrPlaces.webUsable || [];
    defaultLocation = inputOrPlaces.defaultLocation;
  }
  let matchesMerged = 0;

  // 1. Intra-Maps Deduplication via deterministic entity matching cascade
  const sortedPlaces = [...rawPlaces].sort((a, b) => (b.ratingCount || 0) - (a.ratingCount || 0));

  // Deduplicate Maps places using entity resolution
  const dedupedPlaces = dedupeByEntity(sortedPlaces, (p) => ({
    name: p.title,
    phone: p.phoneNumber,
    website: p.website,
    address: p.address,
  }));

  // 2. Seed ResearchCandidate records from surviving Maps places
  const candidates: ResearchCandidate[] = dedupedPlaces.map((place) => {
    const hasValidWebsite = Boolean(place.website && isUsableOfficialWebsite(place.website));
    const cleanWebsite = hasValidWebsite ? normalizeUrl(place.website!) : '';

    return {
      name: place.title,
      location: place.address || defaultLocation || '',
      website: cleanWebsite,
      phone: place.phoneNumber || '',
      // Structural GPS guarantee: coordinates ONLY ever populated from Maps place
      coordinates:
        place.latitude !== undefined && place.longitude !== undefined
          ? { lat: place.latitude, lng: place.longitude }
          : undefined,
      rating: place.rating,
      ratingCount: place.ratingCount,
      category: place.category || place.type,
      // Safeguard 1: Lean source provenance only, no raw provider blobs.
      // NOTE on provenance: sources.googleMaps.website is EXACTLY what Google Maps
      // reported (raw, unvalidated) — it may be a social/directory URL. The
      // validated, safe-to-use website lives at the top-level `candidate.website`
      // (empty when validation rejected the Maps-provided value). Downstream code
      // must consume `candidate.website`, never sources.googleMaps.website, for
      // extraction/lookup.
      sources: {
        googleMaps: {
          found: true,
          placeId: place.placeId || place.cid,
          address: place.address,
          phone: place.phoneNumber,
          website: place.website,
        },
        webSearch: [],
      },
      entityMatch: {
        matched: false,
        confidence: 0,
        method: 'none',
      },
      classification: {
        status: 'usable',
        type: 'business',
        confidence: 1.0,
        reason: 'Verified Google Maps business listing',
      },
    };
  });

  // 3. Merge Web Search results
  for (const { candidate: result, decision } of webUsable) {
    const webEvidence: EntityEvidence = {
      name: result.title,
      phone: result.phoneNumber,
      website: result.url,
      domain: result.domain,
      address: result.address,
    };

    let matchedCandidate: ResearchCandidate | undefined;
    let matchResult: ReturnType<typeof resolveEntityPair> | undefined;

    for (const candidate of candidates) {
      const candidateEvidence: EntityEvidence = {
        name: candidate.name,
        phone: candidate.phone,
        website: candidate.website,
        address: candidate.location,
      };

      const match = resolveEntityPair(candidateEvidence, webEvidence);
      if (match.matched) {
        matchedCandidate = candidate;
        matchResult = match;
        break;
      }
    }

    if (matchedCandidate && matchResult) {
      // Merged match
      matchesMerged++;
      matchedCandidate.sources.webSearch.push({
        title: result.title,
        url: result.url,
        domain: result.domain,
        snippet: result.description,
        provider: result.provider,
      });

      // Backfill missing fields if empty on candidate
      if (!matchedCandidate.website && isUsableOfficialWebsite(result.url)) {
        matchedCandidate.website = normalizeUrl(result.url);
      }
      if (!matchedCandidate.phone && result.phoneNumber) {
        matchedCandidate.phone = result.phoneNumber;
      }
      if (!matchedCandidate.category && result.businessType) {
        matchedCandidate.category = result.businessType;
      }
      if (matchedCandidate.entityMatch.method === 'none') {
        matchedCandidate.entityMatch = matchResult;
      }
    } else {
      // Correction 2 Hard Invariant: Web-only candidates MUST have coordinates and sources.googleMaps undefined
      const webCandidate: ResearchCandidate = {
        name: result.title,
        location: result.address || '',
        website: isUsableOfficialWebsite(result.url) ? normalizeUrl(result.url) : '',
        phone: result.phoneNumber || '',
        coordinates: undefined, // Invariant: never inferred/copied
        rating: result.rating,
        ratingCount: result.ratingCount,
        category: result.businessType,
        sources: {
          googleMaps: undefined, // Invariant: strictly undefined for web-only
          webSearch: [
            {
              title: result.title,
              url: result.url,
              domain: result.domain,
              snippet: result.description,
              provider: result.provider,
            },
          ],
        },
        entityMatch: {
          matched: false,
          confidence: 0,
          method: 'none',
        },
        classification: {
          status: decision.classification === 'business' ? 'usable' : 'ambiguous',
          type: decision.classification,
          confidence: decision.confidence,
          reason: decision.reason,
        },
      };

      candidates.push(webCandidate);
    }
  }

  return { candidates, matchesMerged };
}

// ============================================================================
// Backward Compatibility Flattener (Pure Projection)
// ============================================================================

/**
 * ResearchCandidate[] is the single source of truth for this pipeline stage.
 * This function produces a derived, read-only compatibility view for legacy
 * downstream steps via pure serialization/projection.
 * DO NOT re-run business logic, entity resolution, or validation here.
 * Never mutate `candidates` independently of `researchCandidates` — this will cause silent drift.
 */
export function toUnifiedCandidates(
  candidates: ResearchCandidate[],
  places: SerperPlaceResult[] = []
): UnifiedSearchResult[] {
  // Index Places by placeId/cid or title for fallback field preservation
  const placesMap = new Map<string, SerperPlaceResult>();
  for (const p of places) {
    if (p.placeId) placesMap.set(p.placeId, p);
    if (p.cid) placesMap.set(p.cid, p);
    placesMap.set(p.title.toLowerCase().trim(), p);
  }

  return candidates.map((c, index) => {
    const isMaps = Boolean(c.sources.googleMaps?.found);
    const matchedPlace = isMaps
      ? (c.sources.googleMaps?.placeId && placesMap.get(c.sources.googleMaps.placeId)) ||
        placesMap.get(c.name.toLowerCase().trim())
      : undefined;

    if (isMaps) {
      const hasOfficialUrl = Boolean(c.website && c.website.trim().length > 0);
      const placeUrl = hasOfficialUrl
        ? normalizeUrl(c.website)
        : matchedPlace?.cid
        ? `https://maps.google.com/?cid=${matchedPlace.cid}`
        : c.sources.googleMaps?.placeId
        ? `https://www.google.com/maps/place/?q=place_id:${c.sources.googleMaps.placeId}`
        : `google_maps:${encodeURIComponent(c.name)}`;

      const domain = hasOfficialUrl ? extractDomain(placeUrl) : 'maps.google.com';

      return {
        rank: index + 1,
        title: c.name,
        url: placeUrl,
        originalUrl: c.website || placeUrl,
        domain,
        description: `${c.category || 'Business'} in ${c.location || 'Nepal'}. Phone: ${c.phone || 'N/A'}. Rating: ${c.rating ? `${c.rating} (${c.ratingCount || 0} reviews)` : 'N/A'}`,
        extraSnippets: c.location ? [c.location] : [],
        provider: 'serper_places',
        source: 'google_maps',
        latitude: c.coordinates?.lat,
        longitude: c.coordinates?.lng,
        phoneNumber: c.phone || undefined,
        address: c.location || undefined,
        rating: c.rating,
        ratingCount: c.ratingCount,
        placeId: c.sources.googleMaps?.placeId,
        businessType: c.category,
      };
    }

    // Web-only candidate
    const firstWeb = c.sources.webSearch[0];
    const webUrl = c.website || firstWeb?.url || '';
    const webDomain = extractDomain(webUrl) || firstWeb?.domain || '';

    return {
      rank: index + 1,
      title: c.name,
      url: webUrl,
      originalUrl: webUrl,
      domain: webDomain,
      description: firstWeb?.snippet || `${c.category || 'Business'} in ${c.location || 'Nepal'}`,
      extraSnippets: c.location ? [c.location] : [],
      provider: firstWeb?.provider || 'search_fallback',
      source: 'web_search',
      latitude: undefined,
      longitude: undefined,
      phoneNumber: c.phone || undefined,
      address: c.location || undefined,
      rating: c.rating,
      ratingCount: c.ratingCount,
      placeId: undefined,
      businessType: c.category,
    };
  });
}
