import {
  normalizePhoneDigits,
  normalizeNameKey,
  domainFromUrlOrHost,
  tokenJaccard,
  resolveEntityPair,
  isUsableOfficialWebsite,
  detectBusinessCategory,
  detectWebsiteCategory,
  hasCategoryConflict,
  rankWebsiteLookupTargets,
} from '../src/services/entity-resolution.service';
import {
  buildResearchCandidates,
  toUnifiedCandidates,
} from '../src/services/research-candidate.service';
import { unifiedSearchResultSchema, type UnifiedSearchResult } from '../src/services/search-fallback.service';
import type { SerperPlaceResult } from '../src/services/serper-places.service';
import type { ResearchDecision } from '../src/mastra/agents/research-agent/schema';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

async function runTests() {
  console.log('===============================================================');
  console.log('🧪 RUNNING ZERO-API UNIT TESTS FOR ENTITY RESOLUTION & BUILDER');
  console.log('===============================================================\n');

  // --------------------------------------------------------------------------
  // 1. Phone Normalization (Nepal-aware)
  // --------------------------------------------------------------------------
  console.log('--- 1. Phone Normalization ---');
  assert(normalizePhoneDigits('+977-1-4240520') === '14240520', 'Landline with +977 prefix');
  assert(normalizePhoneDigits('01 4240520') === '14240520', 'Landline with trunk 01 prefix');
  assert(normalizePhoneDigits('97714240520') === '14240520', 'Landline with raw 977 prefix');
  assert(normalizePhoneDigits('+977 9829221456') === '9829221456', 'Mobile with +977 prefix');
  assert(normalizePhoneDigits('982-9469962') === '9829469962', 'Mobile with dashes');
  assert(normalizePhoneDigits('') === '', 'Empty phone string');

  // --------------------------------------------------------------------------
  // 2. Name Normalization & Token Jaccard
  // --------------------------------------------------------------------------
  console.log('\n--- 2. Name Normalization & Similarity ---');
  const name1 = normalizeNameKey('Himalayan Java Coffee Pvt. Ltd.');
  const name2 = normalizeNameKey('Himalayan Java Coffee');
  assert(name1 === 'himalayan java coffee', 'Strip legal tokens (pvt, ltd) but preserve venue word "coffee"');
  assert(name2 === 'himalayan java coffee', 'Clean name match');
  assert(tokenJaccard(name1, name2) === 1.0, 'Token Jaccard identical on normalized names');

  // --------------------------------------------------------------------------
  // 3. Domain & URL Validation
  // --------------------------------------------------------------------------
  console.log('\n--- 3. Domain Extraction & Website Validation ---');
  assert(domainFromUrlOrHost('https://www.himalayanjava.com/contact/') === 'himalayanjava.com', 'Domain from full URL');
  assert(domainFromUrlOrHost('himalayanjava.com') === 'himalayanjava.com', 'Domain from bare host');
  assert(isUsableOfficialWebsite('https://himalayanarabicabeans.com/') === true, 'Accept official domain');
  assert(isUsableOfficialWebsite('https://instagram.com/thethirdspace.np') === false, 'Reject Instagram social URL');
  assert(isUsableOfficialWebsite('https://facebook.com/himalayanjava') === false, 'Reject Facebook social URL');
  assert(isUsableOfficialWebsite('https://booking.com/hotel/np/kathmandu.html') === false, 'Reject Booking aggregator URL');
  assert(isUsableOfficialWebsite('https://maps.google.com/?cid=12345') === false, 'Reject Google Maps URL');
  assert(isUsableOfficialWebsite('') === false, 'Reject empty URL');

  // --------------------------------------------------------------------------
  // 3b. v1.1: Category-Conflict Website Verification (Bihani-style mismatch)
  // --------------------------------------------------------------------------
  console.log('\n--- 3b. Category-Conflict Website Verification ---');

  // Test 1: Travel agency must NOT be assigned a hotel website (the Bihani failure).
  assert(
    !isUsableOfficialWebsite('https://bihanihotel.com/', 'Bihani Nepal Tours & Travel', 'Travel Agency', 'Bihani Hotel & Lodge'),
    'Reject: travel agency assigned hotel website (category conflict)'
  );

  // Test 2: Restaurant must NOT be assigned a hotel website.
  assert(
    !isUsableOfficialWebsite('https://himalayanhotel.com/', 'Himalayan Coffee Restaurant', 'Restaurant', 'Himalayan Hotel'),
    'Reject: restaurant assigned hotel website (category conflict)'
  );

  // Test 3: Travel agency SHOULD get a travel website.
  assert(
    isUsableOfficialWebsite('https://bihanitours.com/', 'Bihani Nepal Tours & Travel', 'Travel Agency', 'Bihani Tours & Travel'),
    'Accept: travel agency assigned travel website'
  );

  // Test 4: Hotel SHOULD get a hotel website.
  assert(
    isUsableOfficialWebsite('https://bihanihotel.com/', 'Bihani Hotel & Lodge', 'Hotel', 'Bihani Hotel & Lodge'),
    'Accept: hotel assigned hotel website'
  );

  // Test 5: Unknown-category business passes untouched (no false rejections).
  assert(
    isUsableOfficialWebsite('https://bihaniheritage.com/', 'Bihani Heritage Pvt Ltd'),
    'Accept: unknown-category business (no category, no conflict)'
  );

  // Detectors.
  assert(detectBusinessCategory('Bihani Tours & Travel') === 'travel', 'Detect travel from business name');
  assert(detectBusinessCategory('Himalayan Hotel & Lodge') === 'hotel', 'Detect hotel from business name');
  assert(detectBusinessCategory('Kathmandu Coffee Restaurant') === 'restaurant', 'Detect restaurant from business name');
  assert(detectWebsiteCategory('bihanihotel.com') === 'hotel', 'Detect hotel from glued domain token');
  assert(detectWebsiteCategory('bihanitours.com') === 'travel', 'Detect travel from glued domain token');

  // Conflict matrix (explicit, symmetric).
  assert(hasCategoryConflict('travel', 'hotel') === true, 'travel <-> hotel conflict');
  assert(hasCategoryConflict('hotel', 'travel') === true, 'hotel <-> travel conflict');
  assert(hasCategoryConflict('travel', 'travel') === false, 'Same category -> no conflict');
  assert(hasCategoryConflict('travel', 'restaurant') === false, 'travel <-> restaurant no conflict');
  assert(hasCategoryConflict('restaurant', 'hotel') === true, 'restaurant <-> hotel conflict');
  assert(hasCategoryConflict(null, 'hotel') === false, 'Unknown business category never conflicts');

  // Word-boundary vs mixed-signal guard: "Holiday Inn" is a hotel but 'holiday'
  // is a travel keyword — mixed signals must stay undetectable (no conflict).
  assert(detectBusinessCategory('Holiday Inn Kathmandu') === null, 'Mixed hotel+holiday signals -> undetectable (no false conflict)');

  // --------------------------------------------------------------------------
  // 4. Deterministic Entity Resolution Cascade & Safeguard 3 Veto
  // --------------------------------------------------------------------------
  console.log('\n--- 4. Entity Resolution Rules & Safeguard 3 Veto ---');
  
  // Phone rule
  const matchPhone = resolveEntityPair(
    { name: 'Cafe Alpha', phone: '+977-1-4240520' },
    { name: 'Alpha Coffee', phone: '01 4240520' }
  );
  assert(matchPhone.matched && matchPhone.method === 'phone' && matchPhone.confidence === 1.0, 'Rule 1: Phone match');

  // Domain rule
  const matchDomain = resolveEntityPair(
    { name: 'Himalayan Java', website: 'https://himalayanjava.com' },
    { name: 'Himalayan Java Thamel', website: 'https://www.himalayanjava.com/contact' }
  );
  assert(matchDomain.matched && matchDomain.method === 'domain' && matchDomain.confidence === 1.0, 'Rule 2: Domain match');

  // Social domain rejection in domain rule
  const matchSocial = resolveEntityPair(
    { name: 'Cafe One', website: 'https://instagram.com/cafeone' },
    { name: 'Cafe Two', website: 'https://instagram.com/cafetwo' }
  );
  assert(!matchSocial.matched || matchSocial.method !== 'domain', 'Social domains never trigger domain match');

  // Safeguard 3: Conflicting-Identity Veto Test
  console.log('Testing Safeguard 3: Conflicting-Identity Veto...');
  const conflictingPair = resolveEntityPair(
    {
      name: 'Kathmandu Dental Clinic',
      phone: '01-4441111',
      website: 'https://kathmandudental.com',
      address: 'Thamel, Kathmandu',
    },
    {
      name: 'Kathmandu Dental Care',
      phone: '01-5552222',
      website: 'https://kmdentalcare.com',
      address: 'Thamel, Kathmandu',
    }
  );
  assert(
    conflictingPair.matched === false && conflictingPair.method === 'none',
    'Safeguard 3: Conflicting phone and conflicting domain veto soft name/address match'
  );

  // Soft name + address match (when no conflicting hard identifiers).
  // Names must be genuinely similar (identical distinguishing name) since venue
  // words like "Coffee"/"Cafe" are preserved by F3.
  const softMatch = resolveEntityPair(
    { name: 'Third Space Specialty Coffee', address: 'Jhamsikhel, Lalitpur' },
    { name: 'Third Space Specialty Coffee', address: 'Jhamsikhel Ward 3, Lalitpur' }
  );
  assert(softMatch.matched && softMatch.method === 'name_address', 'Rule 3: Soft name + address match succeeds when no conflict');

  // F3 regression: distinct venue-type words must NOT collapse into a merge.
  // "Sunrise Cafe" and "Sunrise Hotel" are potentially different businesses and
  // must remain separate candidates (method 'none' = insufficient evidence).
  const venueWordPair = resolveEntityPair(
    { name: 'Sunrise Cafe', address: 'Thamel, Kathmandu' },
    { name: 'Sunrise Hotel', address: 'Thamel, Kathmandu' }
  );
  assert(
    venueWordPair.matched === false && venueWordPair.method === 'none',
    'F3: "Sunrise Cafe" vs "Sunrise Hotel" do NOT merge (venue word preserved)'
  );

  // Correction 1: Evidentiary semantics
  const distinctPair = resolveEntityPair(
    { name: 'Red Mud Coffee', address: 'Thapathali' },
    { name: 'Himalayan Java', address: 'Durbar Marg' }
  );
  assert(
    distinctPair.matched === false && distinctPair.method === 'none',
    'Correction 1: Non-matching pair returns method none (insufficient evidence to merge)'
  );

  // --------------------------------------------------------------------------
  // 5. Website Lookup Ranking
  // --------------------------------------------------------------------------
  console.log('\n--- 5. Website Lookup Targets Ranking ---');
  const samplePlaces: SerperPlaceResult[] = [
    { position: 1, title: 'Place A', rating: 4.5, ratingCount: 200, phoneNumber: '014240520', address: 'Kathmandu' },
    { position: 2, title: 'Place B', rating: 3.0, ratingCount: 10 },
    { position: 3, title: 'Place C', rating: 4.8, ratingCount: 500, phoneNumber: '014240521', address: 'Patan' },
    { position: 4, title: 'Place D', rating: 4.0, ratingCount: 50, address: 'Bhaktapur' },
  ];
  const rankedTargets = rankWebsiteLookupTargets(samplePlaces, 2);
  assert(rankedTargets.length === 2, 'Capped at limit 2');
  assert(rankedTargets[0].title === 'Place C', 'Highest evidence place ranked #1');
  assert(rankedTargets[1].title === 'Place A', 'Second highest evidence place ranked #2');

  // --------------------------------------------------------------------------
  // 6. Correction 4 & Safeguards: Candidate Builder Integration
  // --------------------------------------------------------------------------
  console.log('\n--- 6. Candidate Builder & Invariant Checks ---');

  const placesFixture: SerperPlaceResult[] = [
    {
      position: 1,
      title: 'Himalayan Java Coffee',
      address: 'Tridevi Marg, Thamel, Kathmandu',
      phoneNumber: '+977 1-4240520',
      website: 'https://himalayanjava.com',
      latitude: 27.7149,
      longitude: 85.3123,
      rating: 4.5,
      ratingCount: 1200,
      category: 'Coffee shop',
      placeId: 'ChIJhimalayan1',
    },
    // Duplicate Maps place (Intra-Maps deduplication test)
    {
      position: 2,
      title: 'Himalayan Java (Thamel Branch)',
      address: 'Thamel, Kathmandu',
      phoneNumber: '01-4240520', // Same normalized phone!
      website: 'https://instagram.com/himalayanjava', // Unusable website
      latitude: 27.7148,
      longitude: 85.3122,
      rating: 4.4,
      ratingCount: 300,
      category: 'Cafe',
      placeId: 'ChIJhimalayan2',
    },
  ];

  const webUsableFixture: Array<{ candidate: UnifiedSearchResult; decision: ResearchDecision }> = [
    // Web result matching Place 1 by domain & phone
    {
      candidate: {
        rank: 1,
        title: 'Himalayan Java - Official Coffee Chain in Nepal',
        url: 'https://himalayanjava.com/about-us',
        originalUrl: 'https://himalayanjava.com/about-us',
        domain: 'himalayanjava.com',
        description: 'Specialty coffee roasted locally in Nepal.',
        extraSnippets: ['Kathmandu'],
        provider: 'serper',
        phoneNumber: '01-4240520',
      },
      decision: {
        url: 'https://himalayanjava.com/about-us',
        domain: 'himalayanjava.com',
        title: 'Himalayan Java',
        classification: 'business',
        confidence: 1.0,
        reason: 'Brand website',
        source: 'deterministic',
      },
    },
    // Distinct Web-Only candidate (Correction 2 invariant test)
    {
      candidate: {
        rank: 2,
        title: 'Karma Coffee Nepal',
        url: 'https://karmacoffee.com.np/',
        originalUrl: 'https://karmacoffee.com.np/',
        domain: 'karmacoffee.com.np',
        description: 'Artisanal coffee and beans in Patan.',
        extraSnippets: ['Patan'],
        provider: 'duckduckgo',
        phoneNumber: '9841234567',
        address: 'Patan, Lalitpur',
        businessType: 'Coffee roaster',
      },
      decision: {
        url: 'https://karmacoffee.com.np/',
        domain: 'karmacoffee.com.np',
        title: 'Karma Coffee Nepal',
        classification: 'business',
        confidence: 0.9,
        reason: 'Direct roaster site',
        source: 'deterministic',
      },
    },
  ];

  const buildRes = buildResearchCandidates({
    places: placesFixture,
    webUsable: webUsableFixture,
  });

  // Verify Intra-Maps Deduplication:
  // The 2 Maps rows share the same phone -> dedupeByEntity merges them into 1 canonical candidate
  assert(
    buildRes.candidates.length === 2,
    `Unique candidates post-merge: expected 2 (1 Maps canonical + 1 Web distinct), got ${buildRes.candidates.length}`
  );
  assert(buildRes.matchesMerged === 1, `Matches merged count: expected 1, got ${buildRes.matchesMerged}`);

  const mapsCandidate = buildRes.candidates.find((c) => c.sources.googleMaps?.found);
  assert(Boolean(mapsCandidate), 'Maps candidate present');
  assert(mapsCandidate?.website === 'https://himalayanjava.com/', 'Canonical Maps candidate selected official website');
  assert(mapsCandidate?.coordinates?.lat === 27.7149, 'GPS lat preserved from Maps place');
  assert(mapsCandidate?.coordinates?.lng === 85.3123, 'GPS lng preserved from Maps place');
  assert(mapsCandidate?.sources.webSearch.length === 1, 'Web evidence merged into Maps candidate sources.webSearch');

  // Correction 2 Hard Invariant Test: Web-Only Candidate
  console.log('Testing Correction 2: Web-Only Candidate Invariants...');
  const webCandidate = buildRes.candidates.find((c) => c.name === 'Karma Coffee Nepal');
  assert(Boolean(webCandidate), 'Web-only candidate created');
  assert(webCandidate?.coordinates === undefined, 'Correction 2 Invariant: web-only coordinates are strictly undefined');
  assert(webCandidate?.sources.googleMaps === undefined, 'Correction 2 Invariant: web-only sources.googleMaps is strictly undefined');
  assert(webCandidate?.website === 'https://karmacoffee.com.np/', 'Web candidate website populated');
  assert(webCandidate?.phone === '9841234567', 'Web candidate phone preserved');

  // --------------------------------------------------------------------------
  // 7. Backward Compatibility Flattener (toUnifiedCandidates)
  // --------------------------------------------------------------------------
  console.log('\n--- 7. Compatibility Flattener (toUnifiedCandidates) ---');
  const unified = toUnifiedCandidates(buildRes.candidates, placesFixture);
  assert(unified.length === 2, 'Flattener returns same count of candidates');
  assert(unified[0].rank === 1 && unified[1].rank === 2, 'Dense ranks assigned (1, 2)');

  // Validate against unifiedSearchResultSchema
  for (const u of unified) {
    const parseRes = unifiedSearchResultSchema.safeParse(u);
    assert(parseRes.success, `Candidate "${u.title}" validates against unifiedSearchResultSchema`);
  }

  // Maps row shape checks
  assert(unified[0].source === 'google_maps', 'Maps candidate has source google_maps');
  assert(unified[0].provider === 'serper_places', 'Maps candidate has provider serper_places');
  assert(unified[0].latitude === 27.7149, 'Maps candidate has latitude');
  assert(unified[0].placeId === 'ChIJhimalayan1', 'Maps candidate has placeId');

  // Web row shape checks
  assert(unified[1].source === 'web_search', 'Web candidate has source web_search');
  assert(unified[1].latitude === undefined, 'Web candidate has undefined latitude');
  assert(unified[1].longitude === undefined, 'Web candidate has undefined longitude');

  console.log('\n===============================================================');
  console.log('🎉 ALL ENTITY RESOLUTION & BUILDER UNIT TESTS PASSED (100%)');
  console.log('===============================================================');
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
