import * as fs from 'fs';
import * as path from 'path';
import {
  type LocalityClusterConfig,
  findRegisteredLocalityCluster,
  normalizeLocalityString,
} from '../config/geo-localities.config.js';
import { calculateHaversineDistanceKm } from './geographic-evaluator.service.js';

export interface NominatimGeocodeResult {
  place_id: number;
  licence: string;
  lat: string;
  lon: string;
  category: string;
  type: string;
  place_rank: number;
  importance: number;
  addresstype: string;
  name: string;
  display_name: string;
  boundingbox?: [string, string, string, string]; // [lat_min, lat_max, lon_min, lon_max]
  address?: Record<string, string>;
}

const memoryGeocodeCache = new Map<string, LocalityClusterConfig>();
const CACHE_DIR = path.resolve(process.cwd(), '.cache', 'geocoding');

function ensureCacheDir(): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
  } catch (err) {
    console.warn(`[Geocoding] Could not create cache directory: ${err}`);
  }
}

function getCacheFilePath(key: string): string {
  const safeKey = key.replace(/[^a-z0-9_-]/gi, '_');
  return path.join(CACHE_DIR, `${safeKey}.json`);
}

function loadFromDiskCache(normalizedQuery: string): LocalityClusterConfig | null {
  try {
    const filePath = getCacheFilePath(normalizedQuery);
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      const cluster = JSON.parse(data) as LocalityClusterConfig;
      if (cluster && cluster.centroid && typeof cluster.maxRadiusKm === 'number') {
        memoryGeocodeCache.set(normalizedQuery, cluster);
        return cluster;
      }
    }
  } catch (err) {
    console.warn(`[Geocoding] Failed reading disk cache for '${normalizedQuery}': ${err}`);
  }
  return null;
}

function saveToDiskCache(normalizedQuery: string, cluster: LocalityClusterConfig): void {
  try {
    ensureCacheDir();
    const filePath = getCacheFilePath(normalizedQuery);
    fs.writeFileSync(filePath, JSON.stringify(cluster, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`[Geocoding] Failed saving disk cache for '${normalizedQuery}': ${err}`);
  }
}

/**
 * Computes the maximum distance from centroid to any of the 4 corners of the bounding box.
 */
export function calculateBoundingBoxRadiusKm(
  centroid: { lat: number; lng: number },
  boundingbox?: [string, string, string, string]
): number {
  if (!boundingbox || boundingbox.length < 4) {
    return 2.5; // Default fallback radius
  }

  const latMin = parseFloat(boundingbox[0]);
  const latMax = parseFloat(boundingbox[1]);
  const lonMin = parseFloat(boundingbox[2]);
  const lonMax = parseFloat(boundingbox[3]);

  if (isNaN(latMin) || isNaN(latMax) || isNaN(lonMin) || isNaN(lonMax)) {
    return 2.5;
  }

  const corners = [
    { lat: latMin, lng: lonMin },
    { lat: latMin, lng: lonMax },
    { lat: latMax, lng: lonMin },
    { lat: latMax, lng: lonMax },
  ];

  let maxDistance = 0;
  for (const corner of corners) {
    const dist = calculateHaversineDistanceKm(centroid.lat, centroid.lng, corner.lat, corner.lng);
    if (dist > maxDistance) {
      maxDistance = dist;
    }
  }

  return maxDistance;
}

/**
 * Common broad administrative districts, provinces, and country names in Nepal
 * that frequently appear as qualifiers after a specific locality.
 */
export const BROAD_REGIONS = new Set([
  'nepal',
  'kathmandu',
  'lalitpur',
  'bhaktapur',
  'kaski',
  'pokhara',
  'chitwan',
  'morang',
  'jhapa',
  'rupandehi',
  'bagmati',
  'gandaki',
  'lumbini',
  'koshi',
  'madhesh',
  'karnali',
  'sudurpashchim',
]);

/**
 * Extracts the canonical locality from compound location strings
 * (e.g. "Tokha, Kathmandu" -> "Tokha", "tokha kathmandu" -> "tokha").
 * This ensures that varying caller phrasings map to the same cache key
 * and Nominatim geocode polygon.
 */
export function extractCanonicalLocality(rawLocation: string): string {
  if (!rawLocation) return '';
  const trimmed = rawLocation.trim();

  // 1. Comma-separated: "Tokha, Kathmandu" or "Tokha, Kathmandu, Nepal"
  if (trimmed.includes(',')) {
    const segments = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    if (segments.length > 0) {
      const primary = segments[0];
      const remainderTokens = segments
        .slice(1)
        .join(' ')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const isOnlyBroadRegions =
        remainderTokens.length > 0 &&
        remainderTokens.every((t) => BROAD_REGIONS.has(t));
      if (isOnlyBroadRegions && primary.length >= 2) {
        return primary;
      }
      if (primary.length >= 3) {
        return primary;
      }
    }
  }

  // 2. Space-separated suffix: "tokha kathmandu" -> "tokha"
  const tokens = trimmed.split(/\s+/);
  if (tokens.length >= 2) {
    const lastLower = tokens[tokens.length - 1].toLowerCase();
    if (BROAD_REGIONS.has(lastLower)) {
      const candidate = tokens.slice(0, -1).join(' ').trim();
      if (candidate.length >= 3) {
        return candidate;
      }
    }
  }

  return trimmed;
}

/**
 * Dynamically geocodes a locality query string using OpenStreetMap Nominatim API,
 * with disk caching and static registry fallbacks.
 *
 * Applies the clamped dynamic radius formula:
 *   radiusKm = Math.min(Math.max(bboxRadius * 1.25, 2.0), 8.0)
 */
export async function geocodeLocality(
  locationQuery: string,
  options?: { timeoutMs?: number; disableNetwork?: boolean }
): Promise<LocalityClusterConfig | null> {
  const canonical = extractCanonicalLocality(locationQuery);
  const normalized = normalizeLocalityString(canonical);
  if (!normalized) return null;

  // Trusted registry entries must win over stale disk or memory cache data.
  const staticMatch = findRegisteredLocalityCluster(normalized);
  if (staticMatch) {
    memoryGeocodeCache.set(normalized, staticMatch);
    saveToDiskCache(normalized, staticMatch);
    return staticMatch;
  }

  // 1. Check in-memory cache
  if (memoryGeocodeCache.has(normalized)) {
    return memoryGeocodeCache.get(normalized)!;
  }

  // 2. Check disk cache
  const cached = loadFromDiskCache(normalized);
  if (cached) {
    return cached;
  }

  if (options?.disableNetwork) {
    return null;
  }

  // 4. Hit Nominatim OSM API
  try {
    const query = `${normalized}, Nepal`;
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      query
    )}&format=jsonv2&addressdetails=1&limit=1`;

    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs ?? 5000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'AgenticSearch/1.0 (Nepal Localities Benchmark; contact@agenticsearch.local)',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[Geocoding] Nominatim returned HTTP ${response.status} for '${normalized}'`);
      return null;
    }

    const data = (await response.json()) as NominatimGeocodeResult[];
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    const first = data[0];
    const lat = parseFloat(first.lat);
    const lng = parseFloat(first.lon);

    if (isNaN(lat) || isNaN(lng)) {
      return null;
    }

    const centroid = { lat, lng };
    const rawBboxRadius = calculateBoundingBoxRadiusKm(centroid, first.boundingbox);

    // Clamped dynamic radius formula: floor 2.0 km, ceil 8.0 km, 1.25x padding multiplier
    const maxRadiusKm = Math.round(Math.min(Math.max(rawBboxRadius * 1.25, 2.0), 8.0) * 10) / 10;

    // Build administrative aliases from display_name and address components
    const aliasesSet = new Set<string>();
    aliasesSet.add(normalized);
    aliasesSet.add(normalizeLocalityString(locationQuery));
    if (first.name) aliasesSet.add(normalizeLocalityString(first.name));

    if (first.address) {
      for (const [addrKey, val] of Object.entries(first.address)) {
        // Exclude broad parent administrative fields (municipality, county, state, country)
        // when building aliases for a specific sub-locality or ward
        if (['municipality', 'county', 'state_district', 'state', 'country', 'country_code'].includes(addrKey)) {
          continue;
        }
        if (typeof val === 'string' && val.length > 2 && val.length < 30) {
          const normVal = normalizeLocalityString(val);
          if (
            normVal &&
            !['nepal', 'bagmati', 'gandaki', 'district', 'municipality', 'province'].includes(normVal) &&
            !normVal.includes('municipality')
          ) {
            aliasesSet.add(normVal);
          }
        }
      }
    }

    const cluster: LocalityClusterConfig = {
      canonicalName: normalized,
      centroid,
      maxRadiusKm,
      administrativeExtent: first.display_name,
      aliases: Array.from(aliasesSet),
    };

    memoryGeocodeCache.set(normalized, cluster);
    saveToDiskCache(normalized, cluster);
    console.log(
      `[Geocoding] Geocoded '${normalized}' -> (${centroid.lat}, ${centroid.lng}), radius: ${maxRadiusKm}km`
    );
    return cluster;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.warn(`[Geocoding] Nominatim request timed out for '${normalized}'`);
    } else {
      console.warn(`[Geocoding] Network error geocoding '${normalized}': ${err.message || err}`);
    }
    return null;
  }
}
export { normalizeLocalityString };

