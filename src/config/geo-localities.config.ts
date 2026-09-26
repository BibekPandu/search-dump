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
    administrativeExtent: 'Chandragiri Ward 11 (Satungal, Gurjudhara, Naikap border)',
    aliases: [
      'satungal',
      'chandragiri-11',
      'chandragiri-13',
      'chandragiri 11',
      'chandragiri 13',
      'gurjudhara',
      'naikap',
    ],
  },
  thankot: {
    canonicalName: 'thankot',
    centroid: { lat: 27.6944, lng: 85.2340 },
    maxRadiusKm: 2.5,
    administrativeExtent: 'Thankot / Chandragiri Wards 1-4',
    aliases: ['thankot'],
  },
  balambu: {
    canonicalName: 'balambu',
    centroid: { lat: 27.6950, lng: 85.2440 },
    maxRadiusKm: 1.5,
    administrativeExtent: 'Balambu / Chandragiri Ward 12',
    aliases: ['balambu', 'chandragiri-12', 'chandragiri 12'],
  },
  anamnagar: {
    canonicalName: 'anamnagar',
    // Centroid: Anamnagar / Singha Durbar North-East / Ghattekulo border (KMC Ward 29)
    centroid: { lat: 27.6928, lng: 85.3284 },
    maxRadiusKm: 2.0,
    administrativeExtent: 'KMC Ward 29 (Anamnagar, Singha Durbar East, Ghattekulo border)',
    aliases: [
      'anamnagar',
      'anamnagar kathmandu',
      'kathmandu-29',
      'kathmandu 29',
      'kmc-29',
      'kmc 29',
    ],
  },
  kirtipur: {
    canonicalName: 'kirtipur',
    // Centroid: Kirtipur Municipality Center / TU Gate area
    centroid: { lat: 27.678, lng: 85.277 },
    maxRadiusKm: 3.0,
    administrativeExtent: 'Kirtipur Wards 1–10 (Panga, Nayabazar, Chobhar, Tyangla Phant, Chhugaun, Rarahill)',
    aliases: ['kirtipur', 'panga', 'chobhar', 'nayabazar kirtipur', 'tyangla phant', 'chhugaun', 'rarahill', '44618'],
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
  baneshwor: {
    canonicalName: 'baneshwor',
    // Centroid: New Baneshwor Chowk / Shankhamul area (KMC Wards 10, 31)
    centroid: { lat: 27.6915, lng: 85.342 },
    maxRadiusKm: 3.0,
    administrativeExtent: 'KMC Wards 10, 31 (New Baneshwor, Old Baneshwor, Shankhamul, Aloknagar, Thapagaun, Minbhawan)',
    aliases: [
      'baneshwor',
      'new baneshwor',
      'old baneshwor',
      'shankhamul',
      'aloknagar',
      'thapagaun',
      'minbhawan',
    ],
  },
  putalisadak: {
    canonicalName: 'putalisadak',
    // Centroid: Putalisadak / Dillibazar border, central Kathmandu
    centroid: { lat: 27.7055, lng: 85.3234 },
    maxRadiusKm: 2.0,
    administrativeExtent: 'Putalisadak, Dillibazar, Kathmandu Metropolitan City Ward 28/29',
    aliases: ['putalisadak', 'putalisadak kathmandu', 'dillibazar'],
  },
  thamel: {
    canonicalName: 'thamel',
    centroid: { lat: 27.7154, lng: 85.3123 },
    maxRadiusKm: 2.0,
    administrativeExtent: 'Thamel, Chhetrapati, Paknajol, Jyatha, Kaldhara',
    aliases: ['thamel', 'chhetrapati', 'paknajol', 'jyatha', 'kaldhara'],
  },
  chabahil: {
    canonicalName: 'chabahil',
    centroid: { lat: 27.7172, lng: 85.3486 },
    maxRadiusKm: 3.0,
    administrativeExtent: 'Chabahil, Bouddha, Kapan, Maharajgunj border',
    aliases: ['chabahil', 'bouddha', 'kapan', 'maharajgunj'],
  },
  koteshwor: {
    canonicalName: 'koteshwor',
    centroid: { lat: 27.6775, lng: 85.3512 },
    maxRadiusKm: 2.5,
    administrativeExtent: 'Koteshwor, Jadibuti, Balkumari border',
    aliases: ['koteshwor', 'jadibuti', 'balkumari'],
  },
  kalanki: {
    canonicalName: 'kalanki',
    centroid: { lat: 27.6937, lng: 85.2818 },
    maxRadiusKm: 2.5,
    administrativeExtent: 'Kalanki, Balkhu, Kuleshwor, Rabibhawan',
    aliases: ['kalanki', 'balkhu', 'kuleshwor', 'rabibhawan'],
  },
  bhaktapur: {
    canonicalName: 'bhaktapur',
    centroid: { lat: 27.671, lng: 85.4298 },
    maxRadiusKm: 5.0,
    administrativeExtent: 'Bhaktapur District (Suryabinayak, Thimi, Sallaghari, Kamalbinayak, Dadhikot, Radhe Radhe)',
    aliases: [
      'bhaktapur',
      'suryabinayak',
      'thimi',
      'madhyapur thimi',
      'sallaghari',
      'kamalbinayak',
      'byasi',
      'dadhikot',
      'radhe radhe',
    ],
  },
  lalitpur: {
    canonicalName: 'lalitpur',
    centroid: { lat: 27.6667, lng: 85.3167 },
    maxRadiusKm: 5.0,
    administrativeExtent: 'Lalitpur District (Patan, Kumaripati, Jawalakhel, Pulchowk, Lagankhel, Kupondole, Sanepa, Gwarko, Satdobato, Imadol)',
    aliases: [
      'lalitpur',
      'patan',
      'kumaripati',
      'jawalakhel',
      'pulchowk',
      'lagankhel',
      'kupondole',
      'sanepa',
      'gwarko',
      'satdobato',
      'imadol',
      'mahalaxmi',
      'godawari',
    ],
  },
  pokhara: {
    canonicalName: 'pokhara',
    centroid: { lat: 28.2096, lng: 83.9856 },
    maxRadiusKm: 8.0,
    administrativeExtent: 'Pokhara / Kaski District',
    aliases: ['pokhara', 'lakeside', 'mahendrapool', 'prithvi chowk', 'kaski', 'lamachaur'],
  },
  chitwan: {
    canonicalName: 'chitwan',
    centroid: { lat: 27.6833, lng: 84.4333 },
    maxRadiusKm: 12.0,
    administrativeExtent: 'Chitwan District (Bharatpur, Narayanghat, Sauraha)',
    aliases: ['chitwan', 'bharatpur', 'narayanghat', 'sauraha', 'ratnanagar'],
  },
  butwal: {
    canonicalName: 'butwal',
    centroid: { lat: 27.7, lng: 83.45 },
    maxRadiusKm: 10.0,
    administrativeExtent: 'Rupandehi District (Butwal, Bhalwari, Bhairahawa)',
    aliases: ['butwal', 'bhalwari', 'rupandehi', 'bhairahawa', 'manigram'],
  },
  banepa: {
    canonicalName: 'banepa',
    centroid: { lat: 27.63, lng: 85.52 },
    maxRadiusKm: 6.0,
    administrativeExtent: 'Kavre District (Banepa, Dhulikhel, Panauti)',
    aliases: ['banepa', 'dhulikhel', 'panauti', 'kavre'],
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
