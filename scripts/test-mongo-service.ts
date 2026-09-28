import 'dotenv/config';
import {
  BUSINESSES_COLLECTION,
  RUNS_COLLECTION,
  buildCacheKeys,
  canonicalKeyFor,
  closeMongo,
  getMongo,
  lookupFreshRun,
  normalizeKeyPart,
  pingMongo,
  saveRunRecord,
  toGeoPoint,
  toMongoDoc,
  upsertBusinesses,
  type RunRecordDocument,
} from '@/services/storage/mongo.service';
import {
  CACHE_MAX_AGE_OVERRIDE_ENV,
  DEFAULT_MAX_AGE_DAYS,
  MAX_AGE_DAYS_BY_CATEGORY,
  describeLookupMaxAgeDays,
  lookupMaxAgeDays,
} from '@/config/freshness.config';
import { normalizePhoneDigits } from '@/services/resolution/entity-resolution.service';
import { REGISTERED_LOCALITY_CLUSTERS } from '@/config/geo-localities.config';
import type { BusinessListing } from '@/mastra/workflows/research-workflow';

/**
 * M1 storage + cache-lookup test suite.
 *
 * Unit tests always run (no database, no network, no API keys).
 * Live tests run against MONGODB_DB_NAME=business_directory_test so production
 * data is never touched, and SKIP cleanly (exit 0) when MongoDB is unreachable.
 */

const TEST_DB_NAME = 'business_directory_test';
process.env.MONGODB_DB_NAME = TEST_DB_NAME;

let failures = 0;
let skips = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function skip(name: string): void {
  skips++;
  console.log(`  ⏭️  ${name}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function makeListing(overrides: Partial<BusinessListing> = {}): BusinessListing {
  return {
    name: 'Everest Vision Opticals',
    location: 'M7P2+87G, Satungal-Matatirtha Rd, Chandragiri, Bagmati Province 44600, Nepal',
    emails: [],
    phones: [],
    mobiles: [],
    websites: [],
    icon: '',
    socialLinks: { facebook: '', tiktok: '', instagram: '', other: {} },
    otherDetails: {},
    metadata: { source: 'google_maps', extractedAt: new Date().toISOString(), confidence: 0 },
    process: 'Verified via Google Maps Places (Direct fallback)',
    links: [],
    ...overrides,
  } as BusinessListing;
}

// ============================================================================
// Unit tests (always run)
// ============================================================================

function runUnitTests(): void {
  section('--- 1. Cache key normalization (real dirty stored values) ---');
  check(
    "normalizeKeyPart('\\nSatungal, Kathmandu\\n') -> clean",
    normalizeKeyPart('\nSatungal, Kathmandu\n') === 'satungal, kathmandu'
  );
  check("normalizeKeyPart('Banquet Hall\\n') -> clean", normalizeKeyPart('Banquet Hall\n') === 'banquet hall');
  check("normalizeKeyPart('SPA & Sauna') case-folds", normalizeKeyPart('SPA & Sauna') === 'spa & sauna');
  check('normalizeKeyPart collapses inner whitespace', normalizeKeyPart('  Gym   Center ') === 'gym center');
  check('normalizeKeyPart(undefined) is empty', normalizeKeyPart(undefined) === '');

  const dirty = buildCacheKeys('Barber', '\nSatungal, Kathmandu\n');
  const clean = buildCacheKeys('Barber', 'Satungal, Kathmandu');
  check(
    'dirty and clean locations produce the SAME locationKey',
    dirty.locationKey === clean.locationKey,
    `${dirty.locationKey} vs ${clean.locationKey}`
  );
  check('locationKey is normalized', dirty.locationKey === 'satungal, kathmandu');
  check('localityKey is populated for M2', dirty.localityKey.length > 0, dirty.localityKey);

  section('--- 2. canonicalKey identity (C4: name + run locality) ---');
  const satungal = buildCacheKeys('Barber', 'Satungal, Kathmandu').locationKey;
  const pokhara = buildCacheKeys('Barber', 'Pokhara').locationKey;
  const keyA = canonicalKeyFor(makeListing({ name: 'Barber Club' }), satungal);
  const keyB = canonicalKeyFor(makeListing({ name: '  BARBER   club ' }), satungal);
  const keyC = canonicalKeyFor(makeListing({ name: 'Barber Club' }), pokhara);
  check('same name + same locality -> identical key', keyA === keyB, `${keyA} vs ${keyB}`);
  check('same name + DIFFERENT locality -> DIFFERENT key', keyA !== keyC, `${keyA} vs ${keyC}`);
  check(
    'key is deterministic across calls',
    keyA === canonicalKeyFor(makeListing({ name: 'Barber Club' }), satungal)
  );
  check(
    'legal tokens are stripped (Pvt Ltd)',
    canonicalKeyFor(makeListing({ name: 'Everest Vision Pvt Ltd' }), satungal) ===
      canonicalKeyFor(makeListing({ name: 'Everest Vision' }), satungal)
  );
  check('empty name -> empty key (caller skips)', canonicalKeyFor(makeListing({ name: '   ' }), satungal) === '');
  check('key embeds the locationKey', keyA.endsWith(`|${satungal}`), keyA);

  section('--- 3. Phone canonicalization (Nepali variants) ---');
  check(
    "'+977-01-4311600' == '01-4311600'",
    normalizePhoneDigits('+977-01-4311600') === normalizePhoneDigits('01-4311600')
  );
  check("'01-4311600' -> '14311600'", normalizePhoneDigits('01-4311600') === '14311600');
  check("'+977-985-1201603' -> '9851201603'", normalizePhoneDigits('+977-985-1201603') === '9851201603');

  section('--- 4. geo mapping ([lng, lat] order, both coords required) ---');
  check(
    'geo is [longitude, latitude]',
    JSON.stringify(toGeoPoint({ latitude: 27.6912, longitude: 85.2445 })) === '[85.2445,27.6912]'
  );
  check('missing longitude -> null', toGeoPoint({ latitude: 27.6912 }) === null);
  check('missing latitude -> null', toGeoPoint({ longitude: 85.2445 }) === null);
  check('absent gpsCoordinates -> null', toGeoPoint(undefined) === null);
  check('out-of-range latitude -> null', toGeoPoint({ latitude: 127.6, longitude: 85.2 }) === null);
}

// ============================================================================
// Unit tests, part 2 — mapping separation + freshness policy
// ============================================================================

function runMappingTests(): void {
  section('--- 5. Document mapping + $set/$addToSet/$setOnInsert separation (Amendments 1 & 2) ---');
  const ctx = {
    query: 'Barber',
    location: '\nSatungal, Kathmandu\n',
    runId: 'run-1',
    completedAt: new Date('2026-09-24T09:24:21.855Z'),
    markVerified: true,
  };
  const parts = toMongoDoc(
    makeListing({
      phones: ['+977-01-4311600'],
      emails: ['info@everestvision.com.np'],
      websites: ['https://everestvision.com.np/'],
      gpsCoordinates: { latitude: 27.6872531, longitude: 85.2518564 },
      rating: 4.8,
      ratingCount: 42,
      businessType: 'Optician',
      placeId: '17540895154546494724',
      otherDetails: {
        address: 'Satungal Chowk',
        categories: ['Optician', 'Eye care'],
        websiteRelationship: 'first_party',
        discoveryState: 'DISCOVERY_FOUND_FIRST_PARTY',
        hours: '9-6',
      },
      metadata: { source: 'google_maps', extractedAt: '2026-09-24T09:00:00.000Z', confidence: 0.82 },
    }),
    ctx
  );

  check('toMongoDoc returns write parts', Boolean(parts));
  if (!parts) return;

  const set = parts.set as Record<string, unknown>;
  const addToSet = parts.addToSet as Record<string, unknown>;
  const setOnInsert = parts.setOnInsert as Record<string, unknown>;

  check('$set.address comes from otherDetails.address', set.address === 'Satungal Chowk');
  check(
    '$set.categories comes from otherDetails.categories',
    JSON.stringify(set.categories) === '["Optician","Eye care"]'
  );
  check('$set.primaryCategory is derived from categories[0]', set.primaryCategory === 'Optician');
  check('$set.confidence comes from metadata.confidence', set.confidence === 0.82);
  check('$set.websiteRelationship comes from otherDetails', set.websiteRelationship === 'first_party');
  check('$set.discoveryState comes from otherDetails', set.discoveryState === 'DISCOVERY_FOUND_FIRST_PARTY');
  check(
    '$set.normalizedName is derived (not a listing field)',
    typeof set.normalizedName === 'string' && (set.normalizedName as string).length > 0
  );
  check('$set.geo is [lng, lat]', JSON.stringify(set.geo) === '[85.2518564,27.6872531]');
  check('$set.lastVerifiedAt present on the verified path', set.lastVerifiedAt instanceof Date);
  check(
    '$set carries placeId/rating/ratingCount/businessType',
    set.placeId === '17540895154546494724' &&
      set.rating === 4.8 &&
      set.ratingCount === 42 &&
      set.businessType === 'Optician'
  );
  check(
    'bookkeeping fields are NOT in $set (Amendment 2)',
    !('firstSeenAt' in set) && !('createdAt' in set) && !('canonicalKey' in set)
  );
  check(
    '$setOnInsert carries canonicalKey/firstSeenAt/createdAt',
    'canonicalKey' in setOnInsert && 'firstSeenAt' in setOnInsert && 'createdAt' in setOnInsert
  );
  check(
    '$addToSet accumulates phones/emails/websites/sourceRunIds',
    'phones' in addToSet && 'emails' in addToSet && 'websites' in addToSet && 'sourceRunIds' in addToSet
  );
  check(
    '$addToSet carries canonical phoneDigits',
    JSON.stringify(addToSet.phoneDigits) === '{"$each":["14311600"]}',
    JSON.stringify(addToSet.phoneDigits)
  );
  check(
    '$addToSet carries website domains',
    JSON.stringify(addToSet.domains) === '{"$each":["everestvision.com.np"]}',
    JSON.stringify(addToSet.domains)
  );
  check(
    '$set NEVER carries contact arrays (they accumulate)',
    !('phones' in set) && !('emails' in set) && !('websites' in set) && !('sourceRunIds' in set)
  );
  check(
    'empty clobber guard: no address written when unknown',
    toMongoDoc(makeListing({ otherDetails: {}, location: '' }), ctx)?.set.address === undefined
  );
  check(
    'cache-hit mapping never sets lastVerifiedAt',
    toMongoDoc(makeListing(), { ...ctx, markVerified: false })?.set.lastVerifiedAt === undefined
  );

  section('--- 6. Freshness policy ---');
  check('barber policy = 30d', lookupMaxAgeDays('Barber') === 30);
  check('restaurant policy = 14d', lookupMaxAgeDays('Restaurants') === 14);
  check('policy source is reported', describeLookupMaxAgeDays('Barber').source === 'policy:barber');
  check(
    'substring match ("Lawyers in Satungal, Kathmandu")',
    describeLookupMaxAgeDays('Lawyers in Satungal, Kathmandu').days === 90
  );
  check('unknown query falls back to default', describeLookupMaxAgeDays('Zorbing').days === DEFAULT_MAX_AGE_DAYS);
  check('env override wins over policy', lookupMaxAgeDays('Barber', { [CACHE_MAX_AGE_OVERRIDE_ENV]: '7' }) === 7);
  check('invalid env override is ignored', lookupMaxAgeDays('Barber', { [CACHE_MAX_AGE_OVERRIDE_ENV]: 'abc' }) === 30);
  check(
    'dirty query still matches its policy',
    lookupMaxAgeDays('Banquet Hall\n') === MAX_AGE_DAYS_BY_CATEGORY['banquet hall']
  );
}

// ============================================================================
// Live tests (skipped cleanly when MongoDB is unavailable)
// ============================================================================

async function runLiveTests(): Promise<void> {
  section(`--- 7. Live MongoDB tests (database: ${TEST_DB_NAME}) ---`);

  if (!(await pingMongo())) {
    skip('live tests skipped — MongoDB unreachable or MONGODB_URI unset');
    return;
  }
  const db = await getMongo();
  if (!db) {
    skip('live tests skipped — connection unavailable');
    return;
  }

  console.log(`  (connected to ${TEST_DB_NAME}; scratch collections cleared)`);
  await db.collection(BUSINESSES_COLLECTION).deleteMany({});
  await db.collection(RUNS_COLLECTION).deleteMany({});

  const locationKey = buildCacheKeys('Barber', 'Satungal, Kathmandu').locationKey;
  const now = Date.now();
  const accRun1 = new Date(now - 2 * 3600_000);
  const accRun2 = new Date(now - 3600_000);
  const staleAt = new Date(now - 40 * 86400_000);
  const key = canonicalKeyFor(makeListing(), locationKey);

  section('--- 7a. Amendment 1: contact arrays ACCUMULATE (never clobbered) ---');
  await upsertBusinesses(
    [makeListing({ phones: ['+977-01-4311600'], websites: ['https://everestvision.com.np/'] })],
    {
      query: 'Barber',
      location: 'Satungal, Kathmandu',
      runId: 'test-run-1',
      completedAt: accRun1,
      markVerified: true,
    }
  );
  await upsertBusinesses(
    [makeListing({ phones: ['01-4311600'], websites: ['https://www.everestvision.com.np/contact'] })],
    {
      query: 'Barber',
      // dirty location on the SECOND write: normalization must land on the same doc
      location: '\nSatungal, Kathmandu\n',
      runId: 'test-run-2',
      completedAt: accRun2,
      markVerified: true,
    }
  );

  const doc = await db.collection(BUSINESSES_COLLECTION).findOne({ canonicalKey: key });
  check('business document created', Boolean(doc));
  if (doc) {
    const phones = (doc.phones as string[]) ?? [];
    const digits = (doc.phoneDigits as string[]) ?? [];
    const websites = (doc.websites as string[]) ?? [];
    const sourceRunIds = (doc.sourceRunIds as string[]) ?? [];

    check('phones accumulated A then B -> 2 entries (Amendment 1 proof)', phones.length === 2, JSON.stringify(phones));
    check('phoneDigits deduped to one canonical value', digits.length === 1 && digits[0] === '14311600', JSON.stringify(digits));
    check('websites accumulated to 2 raw variants', websites.length === 2, JSON.stringify(websites));
    check('domains derived (>=1)', ((doc.domains as string[]) ?? []).length >= 1, JSON.stringify(doc.domains));
    check(
      'firstSeenAt frozen at the FIRST insert (Amendment 2 proof)',
      new Date(doc.firstSeenAt as Date).getTime() === accRun1.getTime(),
      `${new Date(doc.firstSeenAt as Date).toISOString()} vs ${accRun1.toISOString()}`
    );
    check('lastVerifiedAt advanced to the newest run', new Date(doc.lastVerifiedAt as Date).getTime() === accRun2.getTime());
    check(
      'sourceRunIds accumulated both runs',
      sourceRunIds.includes('test-run-1') && sourceRunIds.includes('test-run-2'),
      JSON.stringify(sourceRunIds)
    );
    check('runCount incremented to 2', doc.runCount === 2, String(doc.runCount));
    check(
      'only ONE document for the key (no duplicate)',
      (await db.collection(BUSINESSES_COLLECTION).countDocuments({ canonicalKey: key })) === 1
    );
  }

  section('--- 7b. saveRunRecord is an UPSERT on _id (FIX-1: resume-safe) ---');
  await saveRunRecord({
    runId: 'test-run-recent',
    query: 'Barber',
    location: 'Satungal, Kathmandu',
    status: 'success',
    listings: [makeListing()],
    completedAt: accRun2,
    startedAt: accRun2,
  });
  await saveRunRecord({
    runId: 'test-run-recent',
    query: 'Barber',
    location: 'Satungal, Kathmandu',
    status: 'success',
    listings: [],
    completedAt: accRun2,
    startedAt: new Date(now - 5 * 3600_000),
  });
  const recent = await db.collection<RunRecordDocument>(RUNS_COLLECTION).findOne({ _id: 'test-run-recent' });
  check(
    'same _id written twice -> 1 document (no duplicate key crash)',
    (await db.collection<RunRecordDocument>(RUNS_COLLECTION).countDocuments({ _id: 'test-run-recent' })) === 1
  );
  check('second write won (listingCount recomputed)', recent?.listingCount === 0, String(recent?.listingCount));
  check(
    'startedAt is immutable (only set on insert)',
    recent ? new Date(recent.startedAt as Date).getTime() === accRun2.getTime() : false,
    recent ? new Date(recent.startedAt as Date).toISOString() : 'missing'
  );

  section('--- 7c. lookupFreshRun: hit / miss / empty / locality separation ---');
  await saveRunRecord({
    runId: 'test-run-stale',
    query: 'Barber',
    location: 'Satungal, Kathmandu',
    status: 'success',
    listings: [makeListing()],
    completedAt: staleAt,
  });
  await saveRunRecord({
    runId: 'test-run-empty',
    query: 'Zorbing',
    location: 'Satungal, Kathmandu',
    status: 'empty',
    listings: [],
    completedAt: accRun2,
  });

  const hit = await lookupFreshRun('Barber', 'Satungal, Kathmandu', 30);
  check('fresh run is served (30d window)', Boolean(hit), 'expected a hit');
  check(
    'dirty location key still hits the stored run',
    Boolean(await lookupFreshRun('Barber', '\nSatungal, Kathmandu\n', 30))
  );
  check(
    'maxAgeDays=0 -> MISS (nothing newer than now)',
    (await lookupFreshRun('Barber', 'Satungal, Kathmandu', 0)) === null
  );
  const emptyHit = await lookupFreshRun('Zorbing', 'Satungal, Kathmandu', 30);
  check(
    'empty result IS cacheable (FIX-2)',
    Boolean(emptyHit) && emptyHit?.listingCount === 0,
    JSON.stringify(emptyHit?.listingCount)
  );
  check('unknown query -> MISS', (await lookupFreshRun('Dentists', 'Satungal, Kathmandu', 30)) === null);
  check('same query, different locality -> MISS (C4)', (await lookupFreshRun('Barber', 'Pokhara', 30)) === null);
  check('empty query -> null (guard)', (await lookupFreshRun('   ', 'Satungal, Kathmandu', 30)) === null);

  section('--- 7d. $near on the registry centroid ([lng, lat]) ---');
  const satungalCluster = REGISTERED_LOCALITY_CLUSTERS.satungal;
  await upsertBusinesses(
    [
      makeListing({
        name: 'Satungal Geo Fixture',
        gpsCoordinates: {
          latitude: satungalCluster.centroid.lat,
          longitude: satungalCluster.centroid.lng,
        },
      }),
    ],
    { query: 'Barber', location: 'Satungal, Kathmandu', runId: 'test-run-geo', completedAt: accRun2 }
  );
  const nearby = await db
    .collection(BUSINESSES_COLLECTION)
    .find({
      geo: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [satungalCluster.centroid.lng, satungalCluster.centroid.lat],
          },
          $maxDistance: satungalCluster.maxRadiusKm * 1000,
        },
      },
    })
    .toArray();
  check('$near returns the Satungal fixture', nearby.length >= 1, `nearby=${nearby.length}`);
  check(
    'geo stored as [lng, lat]',
    nearby.some(
      (d) =>
        Array.isArray(d.geo) &&
        (d.geo as number[])[0] === satungalCluster.centroid.lng &&
        (d.geo as number[])[1] === satungalCluster.centroid.lat
    )
  );

  section('--- 7e. Indexes ---');
  const businessIndexes = (await db.collection(BUSINESSES_COLLECTION).indexes()).map((i) => i.name);
  const runIndexes = (await db.collection(RUNS_COLLECTION).indexes()).map((i) => i.name);
  check('businesses: unique canonicalKey index', businessIndexes.includes('canonicalKey_unique'));
  check('businesses: 2dsphere geo index', businessIndexes.includes('geo_2dsphere'));
  check('runs: lookup path index', runIndexes.includes('lookup_path_completedAt'));

  // Leave no scratch data behind (the suite must be idempotent).
  await db.collection(BUSINESSES_COLLECTION).deleteMany({});
  await db.collection(RUNS_COLLECTION).deleteMany({});
  console.log('  (scratch collections cleared)');
}

async function main(): Promise<void> {
  console.log('===============================================================');
  console.log('🧪 M1 MONGODB STORAGE + CACHE LOOKUP TEST SUITE');
  console.log('===============================================================');

  runUnitTests();
  runMappingTests();
  await runLiveTests();

  console.log('\n=== RESULT ===');
  if (failures === 0) {
    console.log(`✅ ALL CHECKS PASSED${skips > 0 ? ` (${skips} group(s) skipped)` : ''}`);
  } else {
    console.log(`❌ ${failures} CHECK(S) FAILED`);
  }

  await closeMongo();
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('💥 Test suite failed:', err);
  process.exit(1);
});
