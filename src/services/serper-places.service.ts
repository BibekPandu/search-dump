import { getCached, setCache } from './cache.service';

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
  phoneNumber?: string;
  website?: string;
  cid?: string;
  placeId?: string;
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

  console.log(`[SerperPlaces] Querying Google Maps Places for: "${queryUsed}" (page: ${page}, gl: ${country}, hl: ${language})`);

  try {
    const response = await fetch('https://google.serper.dev/places', {
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
      phoneNumber: p.phoneNumber,
      website: p.website,
      cid: p.cid,
      placeId: p.placeId,
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
