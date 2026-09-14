import type { ResearchCandidate } from '../mastra/agents/research-agent/schema';
import { searchSerperPlaces, type SerperPlaceResult } from './serper-places.service';
import { buildResearchCandidates } from './research-candidate.service';

// ============================================================================
// Maps Discovery Service — Multi-Page Google Maps Pagination with Safeguards
// ============================================================================
// Philosophy:
//   Google Maps is the primary source of truth for physical businesses,
//   providing verified coordinates, phone numbers, and place IDs.
//   This service paginates Maps within hard bounds until:
//     1. targetCandidates unique businesses are reached (target_reached), OR
//     2. Google Maps runs out of places (maps_exhausted), OR
//     3. 2 consecutive pages yield 0 new unique businesses (stale_limit_reached), OR
//     4. maxMapsPages is hit (max_pages_reached).
//
//   If Maps cannot fulfill targetCandidates, downstream research workflow
//   gracefully transitions to Google Web Search fallback to find the rest.

export type MapsPaginationStopReason =
  | 'target_reached'
  | 'maps_exhausted'
  | 'max_pages_reached'
  | 'stale_limit_reached';

export interface PaginateMapsDiscoveryParams {
  query: string;
  location?: string;
  targetCandidates: number;
  maxMapsPages?: number;
  /** Injectable place fetcher for 0-network offline unit testing. Defaults to searchSerperPlaces. */
  fetchPlaces?: (
    query: string,
    options: { location?: string; page: number }
  ) => Promise<SerperPlaceResult[]>;
}

export interface PaginateMapsDiscoveryResult {
  candidates: ResearchCandidate[];
  rawPlaces: SerperPlaceResult[];
  mapsPagesQueried: number;
  consecutiveStaleMapsPages: number;
  stoppedReason: MapsPaginationStopReason;
}

/**
 * Paginates Google Maps discovery with 4 hard safeguards:
 *   - Safeguard 1 (Maps-first): Satisfies target through Maps before web search.
 *   - Safeguard 2 (Unique count): Evaluates unique ResearchCandidate count, not raw places count.
 *   - Safeguard 3 (Hard page limit): Capped at maxMapsPages (default 5).
 *   - Safeguard 4 (Stale counter): Stops if 2 consecutive pages yield 0 new unique entities.
 */
export async function paginateMapsDiscovery(
  params: PaginateMapsDiscoveryParams
): Promise<PaginateMapsDiscoveryResult> {
  const {
    query,
    location,
    targetCandidates,
    maxMapsPages = 5,
    fetchPlaces = searchSerperPlaces,
  } = params;

  const rawPlaces: SerperPlaceResult[] = [];
  let currentCandidates: ResearchCandidate[] = [];
  let mapsPagesQueried = 0;
  let consecutiveStaleMapsPages = 0;
  let previousMapsUniqueCount = 0;
  let stoppedReason: MapsPaginationStopReason = 'max_pages_reached';

  for (let mapsPage = 1; mapsPage <= maxMapsPages; mapsPage++) {
    mapsPagesQueried = mapsPage;
    const pagePlaces = await fetchPlaces(query, { location, page: mapsPage });

    if (!pagePlaces || pagePlaces.length === 0) {
      console.log(`[MapsDiscovery] Google Maps exhausted at page ${mapsPage} (0 places returned).`);
      stoppedReason = 'maps_exhausted';
      break;
    }

    rawPlaces.push(...pagePlaces);
    const intermediateBuild = buildResearchCandidates({
      places: rawPlaces,
      webUsable: [],
      defaultLocation: location,
    });
    currentCandidates = intermediateBuild.candidates;
    const uniqueMapsCount = currentCandidates.length;

    console.log(
      `[MapsDiscovery] Page ${mapsPage}: +${pagePlaces.length} places fetched (${rawPlaces.length} raw accumulated), ${uniqueMapsCount} unique candidates (target: ${targetCandidates})`
    );

    if (uniqueMapsCount >= targetCandidates) {
      console.log(
        `[MapsDiscovery] Target reached on Maps page ${mapsPage} (${uniqueMapsCount} >= ${targetCandidates} unique businesses).`
      );
      stoppedReason = 'target_reached';
      break;
    }

    // Clean baseline tracking for stale pages
    const madeProgress = uniqueMapsCount > previousMapsUniqueCount;
    if (madeProgress) {
      consecutiveStaleMapsPages = 0;
    } else {
      consecutiveStaleMapsPages++;
      console.log(
        `[MapsDiscovery] Page ${mapsPage} yielded 0 new unique entities (consecutive stale pages: ${consecutiveStaleMapsPages}).`
      );
      if (consecutiveStaleMapsPages >= 2) {
        console.log(`[MapsDiscovery] 2 consecutive Maps pages yielded no new unique entities. Halting Maps pagination.`);
        stoppedReason = 'stale_limit_reached';
        break;
      }
    }

    previousMapsUniqueCount = uniqueMapsCount;
  }

  return {
    candidates: currentCandidates,
    rawPlaces,
    mapsPagesQueried,
    consecutiveStaleMapsPages,
    stoppedReason,
  };
}
