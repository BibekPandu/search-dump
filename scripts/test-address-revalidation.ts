/**
 * Address-revalidation suite (Sprint 1, commit 4).
 *
 * Covers `revalidateExtractedCandidateAddress` offline and deterministically by
 * injecting `globalThis.fetch` — the dynamic-geocoding escalation inside
 * `evaluateGeographicLocalityWithEscalation` is the only network path, and the
 * stub replaces it wholesale, so a real Nominatim call is structurally
 * impossible during this suite.
 *
 * Fixture coverage mirrors `test-phase8h-defects.ts` lines 118 and 128 (the
 * Shankhamul-reject / Satungal-accept pair) but without live geocoding: those
 * two run against the real geocoder, this suite pins the same decisions with
 * injected coordinates so they cannot regress silently on a machine without
 * network access.
 *
 * Disk-cache isolation: `.cache/geocoding/*.json` entries the scenarios would
 * consult are backed up before and restored after, so this suite neither
 * depends on nor pollutes the shared geocode cache.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { revalidateExtractedCandidateAddress } from '@/services/resolution/candidate-validation.service';
import { getProjectRootDir } from '@/services/storage/db.service';
import type { ResearchCandidate } from '@/mastra/agents/research-agent/schema';

// Registered Satungal cluster centroid (geo-localities.config.ts):
const SATUNGAL_CENTROID = { lat: 27.6912, lng: 85.2445 };
const FAR_AWAY = { lat: 27.75, lng: 85.31 }; // ~9km from Satungal centroid

const REPO_ROOT = getProjectRootDir();
const GEO_CACHE_DIR = path.join(REPO_ROOT, '.cache', 'geocoding');
// Keys geocodeLocality() derives via extractCanonicalLocality + safe-name.
const TOUCHED_CACHE_KEYS = ['42_market_lane', '99_quarry_lane', 'aloknagar'];

const candidate: ResearchCandidate = {
  name: 'Facility Service',
  location: '',
  website: 'https://facilityservice.com.np',
  phone: '',
  sources: { webSearch: [] },
  entityMatch: { matched: false, confidence: 0, method: 'none' },
};

// ---------------------------------------------------------------------------
// Injected fetch: records calls and answers Nominatim queries with canned
// coordinates. Never touches the network — it IS the network layer here.
// ---------------------------------------------------------------------------
let fetchCalls = 0;
const originalFetch = globalThis.fetch;

function cacheFileFor(key: string): string {
  return path.join(GEO_CACHE_DIR, `${key}.json`);
}

// Backup any pre-existing cache files so restore can put them back verbatim.
const cacheBackup = new Map<string, string | null>();

function backupCacheFile(key: string): void {
  const file = cacheFileFor(key);
  cacheBackup.set(key, fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null);
  fs.rmSync(file, { force: true });
}

function restoreCacheFiles(): void {
  for (const [key, content] of cacheBackup) {
    const file = cacheFileFor(key);
    if (content === null) {
      fs.rmSync(file, { force: true });
    } else {
      fs.mkdirSync(GEO_CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, content, 'utf-8');
    }
  }
}

function nominatimBody(lat: number, lon: number): unknown[] {
  return [
    {
      place_id: 1,
      licence: 'injected-for-test',
      lat: String(lat),
      lon: String(lon),
      display_name: 'Injected Fixture, Test',
      boundingbox: ['27.68', '27.70', '85.23', '85.26'],
      address: { suburb: 'Injected Fixture' },
    },
  ];
}

globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  fetchCalls += 1;
  const url = decodeURIComponent(String(input));
  if (url.includes('99 quarry lane')) {
    // Inside scenario: coordinates sit on the Satungal centroid.
    return new Response(
      JSON.stringify(nominatimBody(SATUNGAL_CENTROID.lat, SATUNGAL_CENTROID.lng)),
      { status: 200 }
    );
  }
  // Outside scenarios (42 Market Lane, Aloknagar): far from centroid.
  return new Response(JSON.stringify(nominatimBody(FAR_AWAY.lat, FAR_AWAY.lng)), { status: 200 });
}) as typeof fetch;

// ---------------------------------------------------------------------------
let passed = 0;
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  PASS: ${label}`);
}

async function main(): Promise<void> {
  console.log('=== Address revalidation suite (injected fetch) ===\n');

  for (const key of TOUCHED_CACHE_KEYS) backupCacheFile(key);

  try {
    // 1. Text-match fast path: 'Satungal' in the address -> inside, zero fetch.
    console.log('1. Deterministic text-match (phase8h-defects:128 fixture)');
    await check('Satungal Chowk address accepted without any network call', async () => {
      const before = fetchCalls;
      const result = await revalidateExtractedCandidateAddress(
        candidate,
        'Satungal Chowk, Chandragiri-11, Kathmandu',
        'Satungal'
      );
      assert.equal(result.isValid, true, 'Satungal address must be valid for Satungal query');
      assert.equal(result.localityStatus, 'inside', 'expected inside from text match');
      assert.equal(fetchCalls, before, 'text-match fast path must not geocode');
    });

    // 2. Shankhamul fixture (phase8h-defects:118): rejected as outside.
    console.log('2. Deterministic exclusion (phase8h-defects:118 fixture)');
    await check('Shankhamul/Aloknagar address rejected for Satungal query', async () => {
      const result = await revalidateExtractedCandidateAddress(
        candidate,
        'Aloknagar, Shankhamul, Kathmandu',
        'Satungal'
      );
      assert.equal(result.isValid, false, 'Shankhamul address must be invalid for Satungal query');
      assert.equal(result.localityStatus, 'outside', 'expected outside decision');
    });

    // 3. Missing target: graceful passthrough, never a rejection.
    console.log('3. Missing target location');
    await check('no target -> isValid, ambiguous, no network', async () => {
      const before = fetchCalls;
      const result = await revalidateExtractedCandidateAddress(candidate, 'Anywhere 1', undefined);
      assert.equal(result.isValid, true, 'without a target nothing can be excluded');
      assert.equal(result.localityStatus, 'ambiguous');
      assert.equal(fetchCalls, before, 'no target must short-circuit before geocoding');
    });

    // 4. Escalation inside: ambiguous text + injected near-centroid coords.
    console.log('4. Injected escalation — inside');
    await check('ambiguous address geocodes inside the Satungal radius', async () => {
      const before = fetchCalls;
      const result = await revalidateExtractedCandidateAddress(
        candidate,
        '99 Quarry Lane, Sample Town',
        'Satungal'
      );
      assert.equal(fetchCalls, before + 1, 'escalation must geocode exactly once via the stub');
      assert.equal(result.isValid, true, 'near-centroid coordinates must be accepted');
      assert.equal(result.localityStatus, 'inside');
    });

    // 5. Escalation outside: ambiguous text + injected far coordinates.
    console.log('5. Injected escalation — outside');
    await check('ambiguous address geocodes beyond the Satungal radius', async () => {
      const before = fetchCalls;
      const result = await revalidateExtractedCandidateAddress(
        candidate,
        '42 Market Lane, Sample Town',
        'Satungal'
      );
      assert.equal(fetchCalls, before + 1, 'escalation must geocode exactly once via the stub');
      assert.equal(result.isValid, false, 'far coordinates must be rejected');
      assert.equal(result.localityStatus, 'outside');
    });

    // 6. The stub was the ONLY network layer engaged.
    console.log('6. Offline guarantee');
    await check('every geocode call went through the injected fetch', () => {
      assert.ok(fetchCalls >= 2, `expected stub traffic, saw ${fetchCalls}`);
    });

    console.log(`\n=== ALL ADDRESS REVALIDATION TESTS PASSED (${passed} checks) ===`);
  } finally {
    globalThis.fetch = originalFetch;
    restoreCacheFiles();
  }
}

main().catch((err) => {
  console.error('\n✗ Address revalidation suite FAILED:', err);
  globalThis.fetch = originalFetch;
  restoreCacheFiles();
  process.exit(1);
});

