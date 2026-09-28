import * as fs from 'fs';
import * as path from 'path';
import { MongoClient } from 'mongodb';
import * as dotenv from 'dotenv';
dotenv.config();

const BASELINE_DIR = 'output/history/2026-09-28T08-23-20-717Z-dental-clinics-in-kathmandu';
const HISTORY_ROOT = 'output/history';

async function main() {
  // 1. Identify the latest run directory
  const historyEntries = fs.readdirSync(HISTORY_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.includes('dental-clinics-in-kathmandu') && d.name !== path.basename(BASELINE_DIR))
    .map(d => d.name)
    .sort();

  if (historyEntries.length === 0) {
    console.error('❌ No new run directory found in', HISTORY_ROOT);
    process.exit(1);
  }

  const latestRunName = historyEntries[historyEntries.length - 1];
  const latestRunDir = path.join(HISTORY_ROOT, latestRunName);
  console.log(`Comparing baseline [${BASELINE_DIR}] vs latest [${latestRunDir}]...\n`);

  // 2. Load summary reports
  const baselineSummary = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, 'summary-report.json'), 'utf8'));
  const latestSummary = JSON.parse(fs.readFileSync(path.join(latestRunDir, 'summary-report.json'), 'utf8'));

  // 3. Load final listings
  const baselineListings = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, '3-final-listings.json'), 'utf8'));
  const latestListings = JSON.parse(fs.readFileSync(path.join(latestRunDir, '3-final-listings.json'), 'utf8'));

  // 5. MongoDB state
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('business_directory');
  const mongoTotal = await db.collection('businesses').countDocuments({});
  const mongoFb = await db.collection('businesses').countDocuments({ 'socialLinks.facebook': { $exists: true, $ne: '' } });
  const mongoAnySocial = await db.collection('businesses').countDocuments({
    $or: [
      { 'socialLinks.facebook': { $exists: true, $ne: '' } },
      { 'socialLinks.instagram': { $exists: true, $ne: '' } },
      { 'socialLinks.tiktok': { $exists: true, $ne: '' } },
      { 'socialLinks.other': { $exists: true, $ne: {} } },
    ]
  });
  const mongoRuns = await db.collection('runs').countDocuments({});
  await client.close();

  console.log('================================================================');
  console.log('📊 RUN SUMMARY COMPARISON');
  console.log('================================================================');
  console.table({
    'Metric': {
      'Discovered Candidates': `${baselineSummary.discovered} -> ${latestSummary.discovered}`,
      'Accepted Candidates': `${baselineSummary.accepted} -> ${latestSummary.accepted}`,
      'Finalized Listings': `${baselineSummary.finalized} -> ${latestSummary.finalized}`,
      'Persisted to Mongo': `${baselineSummary.persisted} -> ${latestSummary.persisted}`,
      'Deduplicated (Auto-merged)': `${baselineSummary.reasonCounts?.deduplicated ?? 0} -> ${latestSummary.reasonCounts?.deduplicated ?? 0}`,
      'Contacts: withPhone': `${baselineSummary.contactsFound?.withPhone} -> ${latestSummary.contactsFound?.withPhone}`,
      'Contacts: withEmail': `${baselineSummary.contactsFound?.withEmail} -> ${latestSummary.contactsFound?.withEmail}`,
      'Contacts: withWebsite': `${baselineSummary.contactsFound?.withWebsite} -> ${latestSummary.contactsFound?.withWebsite}`,
      'Contacts: withSocialLinks': `${baselineSummary.contactsFound?.withSocialLinks} -> ${latestSummary.contactsFound?.withSocialLinks}`,
    }
  });

  // Calculate detailed social profile counts in listings
  function getSocialStats(listings: any[]) {
    let fbCount = 0;
    let igCount = 0;
    let ttCount = 0;
    let totalAcceptedProfiles = 0;
    for (const l of listings) {
      const fb = l.socialLinks?.facebook || l.socials?.facebook;
      const ig = l.socialLinks?.instagram || l.socials?.instagram;
      const tt = l.socialLinks?.tiktok || l.socials?.tiktok;
      if (fb) fbCount++;
      if (ig) igCount++;
      if (tt) ttCount++;
      const profiles = l.otherDetails?.classifiedSocialProfiles || l.classifiedSocialProfiles || [];
      const accepted = profiles.filter((p: any) => p.status === 'accepted');
      totalAcceptedProfiles += accepted.length;
    }
    return { fbCount, igCount, ttCount, totalAcceptedProfiles };
  }

  const baseStats = getSocialStats(baselineListings);
  const lateStats = getSocialStats(latestListings);

  console.log('\n================================================================');
  console.log('🌐 SOCIAL COVERAGE METRICS');
  console.log('================================================================');
  console.log(`Facebook Coverage:       ${baseStats.fbCount} / ${baselineListings.length} -> ${lateStats.fbCount} / ${latestListings.length}`);
  console.log(`Instagram Coverage:      ${baseStats.igCount} / ${baselineListings.length} -> ${lateStats.igCount} / ${latestListings.length}`);
  console.log(`TikTok Coverage:         ${baseStats.ttCount} / ${baselineListings.length} -> ${lateStats.ttCount} / ${latestListings.length}`);
  console.log(`Total Accepted Profiles: ${baseStats.totalAcceptedProfiles} -> ${lateStats.totalAcceptedProfiles}`);

  console.log('\n================================================================');
  console.log('🍃 MONGODB AGGREGATE STATE');
  console.log('================================================================');
  console.log(`Total Businesses in DB:  25 -> ${mongoTotal}`);
  console.log(`Businesses with FB:      16 -> ${mongoFb}`);
  console.log(`Businesses with Social:  17 -> ${mongoAnySocial}`);
  console.log(`Runs in DB:              1  -> ${mongoRuns}`);

  // Inspect 7 Key Targets
  const targetTerms = [
    { key: 'agrim', label: 'Agrim Dental' },
    { key: 'united', label: 'United Dental Care' },
    { key: 'big smile', label: 'Big Smile Dental' },
    { key: 'zenith', label: 'Zenith Dental' },
    { key: 'oral', label: 'DentaLife Oral Concern' },
    { key: 'carefirst', label: 'Carefirst Dental' },
    { key: 'golden', label: 'Golden Dental' },
  ];

  console.log('\n================================================================');
  console.log('🎯 7 TARGET BUSINESSES DEEP DIVE');
  console.log('================================================================');
  for (const t of targetTerms) {
    const baseMatch = baselineListings.find((l: any) => l.name?.toLowerCase().includes(t.key));
    const lateMatch = latestListings.find((l: any) => l.name?.toLowerCase().includes(t.key));

    const baseSocials = baseMatch?.socialLinks || baseMatch?.socials || {};
    const lateSocials = lateMatch?.socialLinks || lateMatch?.socials || {};
    const lateProfiles = lateMatch?.otherDetails?.classifiedSocialProfiles || lateMatch?.classifiedSocialProfiles || [];

    console.log(`\n### ${t.label} (${lateMatch?.name || baseMatch?.name || 'Not Found'})`);
    console.log(`  Baseline Socials: ${JSON.stringify(baseSocials)}`);
    console.log(`  Latest Socials:   ${JSON.stringify(lateSocials)}`);
    if (lateProfiles.length > 0) {
      console.log('  Classified Profiles in Latest:');
      for (const p of lateProfiles) {
        console.log(`    - [${p.platform}] ${p.url} (${p.status}, origin: ${p.origin}${p.rejectionReason ? ', reason: ' + p.rejectionReason : ''})`);
      }
    } else {
      console.log('  Classified Profiles: none');
    }
  }

  // Check false merge guard
  const autoMerged = latestSummary.reasonCounts?.deduplicated ?? 0;
  console.log('\n================================================================');
  console.log(`🛡️ FALSE MERGE GUARD STATUS: ${autoMerged <= 4 ? 'PASSED ✅' : 'FAILED ❌'} (Auto-merged: ${autoMerged}, ceiling: 4)`);
  console.log(`🛡️ MINIMUM LISTING TARGET:   ${latestSummary.finalized >= 25 ? 'PASSED ✅' : 'FAILED ❌'} (Finalized: ${latestSummary.finalized}, target: 25)`);
  console.log('================================================================');
}

main().catch(console.error);
