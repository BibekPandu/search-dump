/**
 * Geographic Locality Knowledge Base & Registry
 *
 * Defines canonical localities, administrative centroid coordinates (OSM/Google Maps verified),
 * maximum decision boundary radii, and ward-level aliases.
 *
 * Ward-level precision is strictly enforced for administrative clusters (e.g. Chandragiri Wards 11-13
 * for Satungal) to prevent municipality-wide false accepts across distant non-contiguous wards.
 */

export interface LocalityClusterConfig {
  canonicalName: string;
  centroid: { lat: number; lng: number };
  maxRadiusKm: number;
  administrativeExtent: string;
  aliases: string[];
}

export const REGISTERED_LOCALITY_CLUSTERS: Record<string, LocalityClusterConfig> = {
  satungal: {
    canonicalName: 'satungal',
    // Centroid: Satungal Chowk / Chandragiri Ward 11 Office (OpenStreetMap Node / Serper Places)
    centroid: { lat: 27.6912, lng: 85.2445 },
    maxRadiusKm: 3.5,
    administrativeExtent: 'Chandragiri Wards 11, 12, 13 (Satungal, Gurjudhara, Naikap border)',
    aliases: [
      'satungal',
      'chandragiri-11',
      'chandragiri-12',
      'chandragiri-13',
      'chandragiri 11',
      'chandragiri 12',
      'chandragiri 13',
      'gurjudhara',
      'naikap',
    ],
  },
  kirtipur: {
    canonicalName: 'kirtipur',
    // Centroid: Kirtipur Municipality Center / TU Gate area
    centroid: { lat: 27.678, lng: 85.277 },
    maxRadiusKm: 3.0,
    administrativeExtent: 'Kirtipur Wards 1–10 (Panga, Nayabazar, Chobhar, Tyangla Phant)',
    aliases: ['kirtipur', 'panga', 'chobhar', 'nayabazar kirtipur', 'tyangla phant'],
  },
  sinamangal: {
    canonicalName: 'sinamangal',
    // Centroid: Sinamangal Bridge / Airport Gate (KMC Ward 9)
    centroid: { lat: 27.6975, lng: 85.3565 },
    maxRadiusKm: 2.5,
    administrativeExtent: 'KMC Ward 9 (Sinamangal, Tinkune, Gaushala border)',
    // Note: 'old baneshwor' excluded to prevent broad false accepts across Baneshwor
    aliases: ['sinamangal', 'airport', 'tinkune', 'gaushala'],
  },
};

/**
 * Normalizes a raw location query string into searchable locality tokens.
 */
export function normalizeLocalityString(rawLocation: string): string {
  if (!rawLocation) return '';
  return rawLocation
    .toLowerCase()
    .replace(/[,\-_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Finds a matching registered locality cluster from a query string or candidate address.
 */
export function findRegisteredLocalityCluster(locationQuery: string): LocalityClusterConfig | null {
  const normalized = normalizeLocalityString(locationQuery);
  if (!normalized) return null;

  for (const [key, cluster] of Object.entries(REGISTERED_LOCALITY_CLUSTERS)) {
    if (normalized.includes(key)) {
      return cluster;
    }
    for (const alias of cluster.aliases) {
      if (normalized.includes(alias)) {
        return cluster;
      }
    }
  }

  return null;
}
