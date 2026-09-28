import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { findRegisteredLocalityCluster } from '@/config/geo-localities.config.js';
import { geocodeLocality } from '@/services/resolution/geocoding.service';
import { paginateMapsDiscovery } from '@/services/discovery/maps-discovery.service';

const cacheDir = path.resolve(process.cwd(), '.cache', 'geocoding');
const putalisadakCache = path.join(cacheDir, 'putalisadak.json');

async function runM2aTests() {
  console.log('=== Running M2A Locality and Maps Tests ===\n');

  const registered = findRegisteredLocalityCluster('Putalisadak, Kathmandu');
  assert(registered, 'Putalisadak should be registered');
  assert(Math.abs(registered.centroid.lat - 27.7055) < 0.001, 'Putalisadak latitude should be Kathmandu');
  assert(Math.abs(registered.centroid.lng - 85.3234) < 0.001, 'Putalisadak longitude should be Kathmandu');

  fs.mkdirSync(cacheDir, { recursive: true });
  const originalCache = fs.existsSync(putalisadakCache)
    ? fs.readFileSync(putalisadakCache, 'utf8')
    : undefined;

  try {
    fs.writeFileSync(
      putalisadakCache,
      JSON.stringify({
        canonicalName: 'putalisadak',
        centroid: { lat: 27.6553907, lng: 83.4610794 },
        maxRadiusKm: 2,
        administrativeExtent: 'Tilottama, Rupandehi',
        aliases: ['putalisadak'],
      }),
      'utf8'
    );

    const resolved = await geocodeLocality('Putalisadak, Kathmandu', { disableNetwork: true });
    assert(resolved, 'Putalisadak should resolve without network');
    assert(Math.abs(resolved.centroid.lat - 27.7055) < 0.001, 'Stale cache latitude must not win');
    assert(Math.abs(resolved.centroid.lng - 85.3234) < 0.001, 'Stale cache longitude must not win');

    const cachedRecord = JSON.parse(fs.readFileSync(putalisadakCache, 'utf8')) as {
      centroid: { lat: number; lng: number };
      maxRadiusKm: number;
      aliases: string[];
    };
    assert(Math.abs(cachedRecord.centroid.lng - 85.3234) < 0.001, 'Cache should be repaired');
    assert(cachedRecord.maxRadiusKm > 0, 'Cache should store a radius');
    assert(cachedRecord.aliases.includes('putalisadak'), 'Cache should store aliases');
  } finally {
    if (originalCache === undefined) {
      fs.rmSync(putalisadakCache, { force: true });
    } else {
      fs.writeFileSync(putalisadakCache, originalCache, 'utf8');
    }
  }

  let receivedLocation: string | undefined;
  const mapsResult = await paginateMapsDiscovery({
    query: 'consultancy',
    location: 'Putalisadak, Kathmandu',
    targetCandidates: 1,
    maxMapsPages: 1,
    fetchPlaces: async (_query, options) => {
      receivedLocation = options.location;
      return [
        {
          position: 1,
          title: 'Example Consultancy',
          address: 'Putalisadak, Kathmandu',
          placeId: 'm2a-example-place',
          latitude: 27.7055,
          longitude: 85.3234,
          category: 'Educational consultant',
        },
      ];
    },
  });

  assert.strictEqual(receivedLocation, 'Putalisadak, Kathmandu');
  assert.strictEqual(mapsResult.candidates.length, 1);

  console.log('M2A tests passed.');
}

runM2aTests().catch((error) => {
  console.error('M2A test failure:', error);
  process.exit(1);
});
