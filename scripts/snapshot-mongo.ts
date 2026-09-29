import { MongoClient } from 'mongodb';
import * as dotenv from 'dotenv';

// dotenv v17 prints a random tip banner to stdout on load; that banner would
// poison any redirected snapshot diff, so silence it here.
dotenv.config({ quiet: true });

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const client = new MongoClient(uri);

/**
 * `--keys` mode: print only the sorted canonicalKey set, one per line, to
 * stdout. Safe to redirect into a file for the additions-only identity gate:
 * any extra line (logs, banners, counts) would corrupt the diff, so this mode
 * prints nothing else and exits non-zero if the snapshot cannot be taken.
 */
async function keysOnly(): Promise<void> {
  try {
    await client.connect();
    const db = client.db('business_directory');
    const keys = await db.collection('businesses').distinct('canonicalKey');
    const sorted = keys
      .filter((k): k is string => typeof k === 'string' && k.length > 0)
      .sort((a, b) => a.localeCompare(b));
    process.stdout.write(sorted.length ? sorted.join('\n') + '\n' : '');
  } catch (err) {
    console.error('snapshot-mongo --keys failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function snapshot() {
  await client.connect();
  const db = client.db('business_directory');
  const count = await db.collection('businesses').countDocuments({});

  const acceptedSocialsAgg = await db.collection('businesses').aggregate([
    { $match: { 'otherDetails.classifiedSocialProfiles.status': 'accepted' } },
    { $group: { _id: null, count: { $sum: 1 } } }
  ]).toArray();

  const countWithAccepted = acceptedSocialsAgg[0]?.count || 0;
  console.log('Accepted classified profiles in businesses count:', countWithAccepted);

  const sampleDoc = await db.collection('businesses').findOne({});
  console.log('Sample keys in MongoDB business doc:', Object.keys(sampleDoc || {}));
  console.log('Sample social fields:', {
    socials: (sampleDoc as any)?.socials,
    socialLinks: (sampleDoc as any)?.socialLinks,
    classifiedSocialProfiles: (sampleDoc as any)?.otherDetails?.classifiedSocialProfiles,
  });

  const withFb = await db.collection('businesses').countDocuments({
    'socialLinks.facebook': { $exists: true, $ne: '' }
  });
  const withAnySocial = await db.collection('businesses').countDocuments({
    $or: [
      { 'socialLinks.facebook': { $exists: true, $ne: '' } },
      { 'socialLinks.instagram': { $exists: true, $ne: '' } },
      { 'socialLinks.tiktok': { $exists: true, $ne: '' } },
      { 'socialLinks.other': { $exists: true, $ne: {} } },
    ]
  });

  const runsCount = await db.collection('runs').countDocuments({});

  console.log('=== ACCURATE BASELINE SNAPSHOT (BEFORE RUN) ===');
  console.log('Total businesses in MongoDB:', count);
  console.log('Businesses with socialLinks.facebook populated:', withFb);
  console.log('Businesses with >=1 socialLink populated:', withAnySocial);
  console.log('Total runs in MongoDB:', runsCount);

  await client.close();
}

if (process.argv.includes('--keys')) {
  void keysOnly();
} else {
  snapshot().catch(console.error);
}
