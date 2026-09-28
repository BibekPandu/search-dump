import { MongoClient } from 'mongodb';
import * as dotenv from 'dotenv';
dotenv.config();

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const client = new MongoClient(uri);

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

snapshot().catch(console.error);
