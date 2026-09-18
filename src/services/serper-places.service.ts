import { getCached, setCache } from './cache.service';
import type { DiscoveryState, DiscoveryProvenance } from './discovery-state.service';

export interface SerperPlaceResult {
  position: number;
  title: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  rating?: number;
  ratingCount?: number;
  category?: string;
  type?: string;
  types?: string[];
  phoneNumber?: string;
  website?: string;
  cid?: string;
  placeId?: string;
  priceLevel?: string;
  openingHours?: Record<string, string> | string;
  description?: string;
  thumbnailUrl?: string;
  bookingLinks?: any;
  /**
   * Phase 7a Task 3 / Phase 7b Task 10: explicit website discovery outcome for this Maps candidate.
   * See src/services/website-discovery-gate.service.ts.
   */
  discoveryState?: DiscoveryState;
  /**
   * Phase 7b Task 9: full discovery provenance propagated from the discovery gate.
   */
  discoveryProvenance?: DiscoveryProvenance;
}

const CACHE_PROVIDER = 'serper-places';

export async function searchSerperPlaces(
  query: string,
  options: { location?: string; country?: string; language?: string; page?: number } = {}
): Promise<SerperPlaceResult[]> {
  const { location, country = 'np', language = 'en', page = 1 } = options;
  const apiKey = process.env.SERPER_API_KEY;

  if (!apiKey) {
    console.warn('[SerperPlaces] SERPER_API_KEY missing in .env - returning empty places');
    return [];
  }

  const queryUsed =
    location && !query.toLowerCase().includes(location.toLowerCase())
      ? `${query} ${location}`
      : query;

  const cacheKey = `${queryUsed}_${country}_${language}_p${page}`;
  const cached = getCached<SerperPlaceResult[]>(cacheKey, CACHE_PROVIDER);
  if (cached) {
    console.log(`[SerperPlaces] Cache hit for "${queryUsed}" (page: ${page}, ${cached.length} places)`);
    return cached;
  }

  console.log(`[SerperPlaces] Querying Google Maps via /maps for: "${queryUsed}" (page: ${page}, gl: ${country}, hl: ${language})`);

  try {
    // Primary: Google Maps direct scraper endpoint (/maps) with full phone and detail support
    let response = await fetch('https://google.serper.dev/maps', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: queryUsed,
        gl: country,
        hl: language,
        page,
      }),
    });

    // Fallback: If /maps fails or returns empty on deep pagination, try legacy /places
    if (!response.ok && page > 1) {
      console.warn(`[SerperPlaces] /maps API status ${response.status} on page ${page}, trying /places fallback`);
      response = await fetch('https://google.serper.dev/places', {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: queryUsed,
          gl: country,
          hl: language,
          page,
        }),
      });
    }

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[SerperPlaces] API error ${response.status}: ${errText}`);
      return [];
    }

    const data = await response.json();
    const rawPlaces = Array.isArray(data.places) ? data.places : [];

    const places: SerperPlaceResult[] = rawPlaces.map((p: any, idx: number) => ({
      position: typeof p.position === 'number' ? p.position : idx + 1,
      title: p.title || 'Unknown Business',
      address: p.address,
      latitude: typeof p.latitude === 'number' ? p.latitude : undefined,
      longitude: typeof p.longitude === 'number' ? p.longitude : undefined,
      rating: typeof p.rating === 'number' ? p.rating : undefined,
      ratingCount: typeof p.ratingCount === 'number' ? p.ratingCount : undefined,
      category: p.category || p.type,
      type: p.type || p.category,
      types: Array.isArray(p.types) ? p.types : (p.category ? [p.category] : []),
      phoneNumber: p.phoneNumber || p.phone,
      website: p.website,
      cid: p.cid,
      placeId: p.placeId,
      priceLevel: p.priceLevel || p.priceRange,
      openingHours: p.openingHours || p.hours,
      description: p.description,
      thumbnailUrl: p.thumbnailUrl,
      bookingLinks: p.bookingLinks,
    }));

    console.log(`[SerperPlaces] Found ${places.length} Google Maps places for "${queryUsed}"`);

    if (places.length > 0) {
      setCache(cacheKey, CACHE_PROVIDER, places);
    }

    return places;
  } catch (error) {
    console.error('[SerperPlaces] Failed to query Google Maps places:', error);
    return [];
  }
}

/**
 * Single-place targeted lookup on Google Maps via /maps.
 * Used to backfill phone numbers or exact place details when initial batch scan lacked phone.
 */
export async function lookupSerperMapsPlace(
  query: string,
  options: { country?: string; language?: string } = {}
): Promise<SerperPlaceResult | null> {
  const { country = 'np', language = 'en' } = options;
  const apiKey = process.env.SERPER_API_KEY;

  if (!apiKey || !query || query.trim().length === 0) {
    return null;
  }

  const cacheKey = `single_${query.trim()}_${country}_${language}`;
  const cached = getCached<SerperPlaceResult>(cacheKey, CACHE_PROVIDER);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch('https://google.serper.dev/maps', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query.trim(),
        gl: country,
        hl: language,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const rawPlaces = Array.isArray(data.places) ? data.places : [];
    if (rawPlaces.length === 0) {
      return null;
    }

    const p = rawPlaces[0];
    const place: SerperPlaceResult = {
      position: 1,
      title: p.title || query,
      address: p.address,
      latitude: typeof p.latitude === 'number' ? p.latitude : undefined,
      longitude: typeof p.longitude === 'number' ? p.longitude : undefined,
      rating: typeof p.rating === 'number' ? p.rating : undefined,
      ratingCount: typeof p.ratingCount === 'number' ? p.ratingCount : undefined,
      category: p.category || p.type,
      type: p.type || p.category,
      types: Array.isArray(p.types) ? p.types : (p.category ? [p.category] : []),
      phoneNumber: p.phoneNumber || p.phone,
      website: p.website,
      cid: p.cid,
      placeId: p.placeId,
      priceLevel: p.priceLevel || p.priceRange,
      openingHours: p.openingHours || p.hours,
      description: p.description,
      thumbnailUrl: p.thumbnailUrl,
      bookingLinks: p.bookingLinks,
    };

    setCache(cacheKey, CACHE_PROVIDER, place);
    return place;
  } catch (err) {
    console.warn(`[SerperPlaces] Single-place lookup failed for "${query}":`, err);
    return null;
  }
}

/**
 * Bounded phone backfill helper: for places lacking phone numbers after initial batch Maps discovery,
 * queries /maps with the exact place name + locality to recover Maps phone numbers.
 */
export async function backfillMissingMapsPhones(
  places: SerperPlaceResult[],
  location?: string,
  maxBackfills = 20
): Promise<number> {
  const missing = places.filter((p) => !p.phoneNumber || p.phoneNumber.trim().length === 0);
  if (missing.length === 0) {
    return 0;
  }

  const toBackfill = missing.slice(0, maxBackfills);
  console.log(`[SerperPlaces] Backfilling missing phones for ${toBackfill.length}/${missing.length} places...`);

  let recovered = 0;
  for (const place of toBackfill) {
    const query = `${place.title} ${place.address || location || ''}`.trim();
    const detail = await lookupSerperMapsPlace(query);
    if (detail?.phoneNumber) {
      place.phoneNumber = detail.phoneNumber;
      if (!place.address && detail.address) place.address = detail.address;
      if (!place.website && detail.website) place.website = detail.website;
      recovered++;
    }
  }

  console.log(`[SerperPlaces] Backfill complete: recovered ${recovered}/${toBackfill.length} missing phones.`);
  return recovered;
}

