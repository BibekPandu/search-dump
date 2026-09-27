import {
  runWebsiteDiscoveryGate,
  selectPhoneFromOwnDomain,
  type DiscoveryLookupResult,
} from '@/services/discovery/website-discovery-gate.service';
import { isUsableOfficialWebsite } from '@/services/resolution/entity-resolution.service';
import { selectFirstPartyWebsiteUrl } from '@/services/discovery/website-search-ranker.service';
import type { SerperPlaceResult } from '@/services/external/serper-places.service';

// ============================================================================
// Phase 7a Task 4.5 — Snippet Phone Attribution Guard (OFFLINE, ZERO API)
// ============================================================================
// The Task 1 forensic finding: research-workflow.ts used to take
// `allSnippetPhones[0]` from ANY result's snippet — directories included — which
// is the phone-mismatch bug. The guard now attributes a snippet phone ONLY from
// the business's OWN domain (the ranked first-party selection, or the Maps
// website when no discovery was needed), and only when that domain is itself an
// acceptable official domain.
//
// Acceptance:
//   [ ] A directory snippet containing a phone cannot contaminate phone fields
//   [ ] No attributable domain → no snippet phone at all
//   [ ] Own-domain phone wins over directory phones (provenance recorded)
//   [ ] Existing Maps phone is never overwritten
//   [ ] Duplicates inherit the attributed phone
//   [ ] Callers that do not pass selectPhone behave exactly as before

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

function makePlace(id: string, overrides: Partial<SerperPlaceResult> = {}): SerperPlaceResult {
  return {
    position: 1,
    title: `Business ${id}`,
    address: 'Satungal, Kathmandu',
    rating: 4.5,
    ratingCount: 100,
    category: 'School',
    phoneNumber: undefined,
    placeId: id,
    ...overrides,
  };
}

/** The exact composition the workflow uses: usability gate + own-domain guard. */
function workflowStyleSelectPhone(
  place: SerperPlaceResult,
  results: Array<{ url: string; title?: string; description?: string; extraSnippets?: string[] }>,
  businessDomain: string | undefined
): string | undefined {
  if (!businessDomain) return undefined;
  if (!isUsableOfficialWebsite(`https://${businessDomain}`, place.title, place.category || place.type)) {
    return undefined;
  }
  return selectPhoneFromOwnDomain(results, businessDomain);
}

/** The workflow's website selector: Task 4 ranker + isUsableOfficialWebsite hard gate. */
function rankerSelector(
  place: SerperPlaceResult,
  results: Array<{ url: string; title?: string; description?: string; extraSnippets?: string[] }>
): { url?: string; reason?: string } | undefined {
  const selection = selectFirstPartyWebsiteUrl({
    results,
    businessName: place.title,
    location: place.address,
    isUsable: (c) =>
      isUsableOfficialWebsite(c.url, place.title, place.category || place.type, c.title),
  });
  return { url: selection.url, reason: selection.reason };
}

function result(
  url: string,
  title: string,
  description: string,
  extraSnippets: string[] = []
): { url: string; title: string; description: string; extraSnippets: string[] } {
  return { url, title, description, extraSnippets };
}

async function runTests() {
  console.log('===============================================================');
  console.log('🧪 SNIPPET PHONE ATTRIBUTION GUARD TESTS (ZERO API)');
  console.log('===============================================================\n');

  // --- 1. Domain-scoping helper: no domain, no phone ---
  console.log('--- 1. selectPhoneFromOwnDomain: scoping policy ---');
  const directoryOnlyResults = [
    result('https://school-directory.example/a', 'School A directory', 'Call 01-1111111'),
  ];
  assert(
    selectPhoneFromOwnDomain(directoryOnlyResults, undefined) === undefined,
    'No attributable domain → no phone (policy guard)'
  );
  assert(
    selectPhoneFromOwnDomain(directoryOnlyResults, 'ever-vision.edu.np') === undefined,
    'Results outside the business domain contribute no phone'
  );
  const ownDomainResults = [
    result('https://ever-vision.edu.np/contact', 'Contact us', 'Phone: 01-4470777'),
    result('https://school-directory.example/a', 'School A directory', 'Call 01-1111111'),
  ];
  assert(
    selectPhoneFromOwnDomain(ownDomainResults, 'ever-vision.edu.np') === '01-4470777',
    'Own-domain snippet phone is attributed; the directory phone is ignored'
  );

  // --- 2. Deterministic first-phone order ---
  console.log('\n--- 2. Deterministic first-phone order ---');
  const multiPhone = selectPhoneFromOwnDomain(
    [
      result('https://ever-vision.edu.np', 'Ever Vision School', 'Tel 01-4470777'),
      result('https://ever-vision.edu.np/admissions', 'Admissions', 'Mobile 9841234567'),
    ],
    'ever-vision.edu.np'
  );
  assert(multiPhone === '01-4470777', 'First own-domain phone wins (landline before mobile)');

  // --- 3. CORE CONTAMINATION KILL: directory-only SERP with phones ---
  console.log('\n--- 3. Directory snippets with phones cannot contaminate ---');
  const noFirstParty = makePlace('np1', { title: 'Ever Vision School' });
  const summary3 = await runWebsiteDiscoveryGate({
    places: [noFirstParty],
    lookupBudget: 5,
    selectFirstPartyUrl: rankerSelector,
    selectPhone: (p) => workflowStyleSelectPhone(p.place, p.results, p.businessDomain),
    lookup: async (): Promise<DiscoveryLookupResult> => ({
      queries: ['Ever Vision School Satungal'],
      results: [
        result(
          'https://school-directory.example/school/ever-vision-school',
          'Ever Vision School | Satungal, Kathmandu',
          'Admissions open. Call 01-1111111 today.'
        ),
        result(
          'https://local-listings.example/listings/ever-vision-school',
          'Ever Vision School contact',
          'Phone 01-2222222'
        ),
      ],
    }),
  });
  assert(
    noFirstParty.discoveryState === 'DISCOVERY_FOUND_ONLY_THIRD_PARTY',
    `Directory-only SERP records the third-party state (got ${noFirstParty.discoveryState})`
  );
  assert(
    !noFirstParty.phoneNumber,
    'NO phone attributed from directory snippets (the Task 1 phone-mismatch bug is dead)'
  );
  assert(
    summary3.records[0].phone === undefined && summary3.records[0].phoneSourceDomain === undefined,
    'Provenance records that no phone was attributed'
  );

  // --- 4. First-party found: own-domain phone wins over directory phone ---
  console.log('\n--- 4. Own-domain attribution with provenance ---');
  const firstParty = makePlace('fp1', { title: 'Ever Vision School' });
  const summary4 = await runWebsiteDiscoveryGate({
    places: [firstParty],
    lookupBudget: 5,
    selectFirstPartyUrl: rankerSelector,
    selectPhone: (p) => workflowStyleSelectPhone(p.place, p.results, p.businessDomain),
    lookup: async (): Promise<DiscoveryLookupResult> => ({
      queries: ['Ever Vision School Satungal'],
      results: [
        result(
          'https://school-directory.example/school/ever-vision-school',
          'Ever Vision School directory page',
          'Call the directory desk: 01-1111111'
        ),
        result(
          'https://ever-vision.edu.np/contact',
          'Ever Vision School | Satungal, Kathmandu',
          'Contact the school office: 01-4470777'
        ),
      ],
    }),
  });
  assert(
    firstParty.website === 'https://ever-vision.edu.np/contact',
    'Ranker selected the first-party contact page'
  );
  assert(
    firstParty.phoneNumber === '01-4470777',
    `Phone attributed from the OWN domain (got ${firstParty.phoneNumber})`
  );
  assert(
    summary4.records[0].phone === '01-4470777' &&
      summary4.records[0].phoneSourceDomain === 'ever-vision.edu.np',
    'Provenance records the phone AND its originating domain'
  );
  assert(
    summary4.records[0].state === 'DISCOVERY_FOUND_FIRST_PARTY',
    'State remains first-party discovery'
  );

  // --- 5. First-party found but own-domain snippet has NO phone ---
  console.log('\n--- 5. No own-domain phone → nothing attributed ---');
  const noOwnPhone = makePlace('nop1', { title: 'Ever Vision School' });
  const summary5 = await runWebsiteDiscoveryGate({
    places: [noOwnPhone],
    lookupBudget: 5,
    selectFirstPartyUrl: rankerSelector,
    selectPhone: (p) => workflowStyleSelectPhone(p.place, p.results, p.businessDomain),
    lookup: async (): Promise<DiscoveryLookupResult> => ({
      queries: ['Ever Vision School Satungal'],
      results: [
        result(
          'https://school-directory.example/school/ever-vision-school',
          'Ever Vision School directory page',
          'Directory hotline: 01-1111111'
        ),
        result(
          'https://ever-vision.edu.np',
          'Ever Vision School | Satungal, Kathmandu',
          'Welcome to our campus in Satungal.'
        ),
      ],
    }),
  });
  assert(noOwnPhone.website === 'https://ever-vision.edu.np', 'First-party site still attached');
  assert(
    !noOwnPhone.phoneNumber,
    'Directory hotline NOT attributed when the own-domain snippet has no phone'
  );
  assert(summary5.records[0].phone === undefined, 'Provenance records no attribution');

  // --- 6. Maps-website place: phone attributed from ITS OWN domain ---
  console.log('\n--- 6. Maps-website place (generalized rule) ---');
  const mapsWebsite = makePlace('mw1', {
    title: 'Ever Vision School',
    website: 'https://ever-vision.edu.np',
  });
  let lookups6 = 0;
  const summary6 = await runWebsiteDiscoveryGate({
    places: [mapsWebsite],
    lookupBudget: 5,
    selectFirstPartyUrl: rankerSelector,
    selectPhone: (p) => workflowStyleSelectPhone(p.place, p.results, p.businessDomain),
    lookup: async (): Promise<DiscoveryLookupResult> => {
      lookups6++;
      return {
        queries: ['Ever Vision School Satungal'],
        results: [
          result(
            'https://ever-vision.edu.np/contact',
            'Ever Vision School contact',
            'School office: 01-4470777'
          ),
          result(
            'https://school-directory.example/school/ever-vision-school',
            'Directory listing',
            'Directory desk: 01-1111111'
          ),
        ],
      };
    },
  });
  assert(lookups6 === 1, 'Phone-enrichment lookup still runs for Maps-website places');
  assert(
    mapsWebsite.phoneNumber === '01-4470777',
    `Phone attributed from the Maps website's OWN domain (got ${mapsWebsite.phoneNumber})`
  );
  assert(
    mapsWebsite.discoveryState === 'MAPS_HAS_WEBSITE' &&
      mapsWebsite.website === 'https://ever-vision.edu.np',
    'State and website unchanged by phone attribution'
  );
  assert(
    summary6.records[0].phoneSourceDomain === 'ever-vision.edu.np',
    'Attribution domain provenance recorded'
  );

  // --- 7. Social Maps website is NOT an attribution target ---
  console.log('\n--- 7. Social Maps website rejected as phone source ---');
  const socialMaps = makePlace('sm1', {
    title: 'Ever Vision School',
    website: 'https://facebook.com/ever-vision-school',
  });
  await runWebsiteDiscoveryGate({
    places: [socialMaps],
    lookupBudget: 5,
    selectFirstPartyUrl: rankerSelector,
    selectPhone: (p) => workflowStyleSelectPhone(p.place, p.results, p.businessDomain),
    lookup: async (): Promise<DiscoveryLookupResult> => ({
      queries: ['Ever Vision School Satungal'],
      results: [
        result(
          'https://facebook.com/ever-vision-school',
          'Ever Vision School - Facebook',
          'Message us or call 9841234567'
        ),
      ],
    }),
  });
  assert(
    !socialMaps.phoneNumber,
    'A Maps-provided social URL cannot become a phone source (isUsable guard)'
  );

  // --- 8. Existing Maps phone is never overwritten ---
  console.log('\n--- 8. Maps phone stays authoritative ---');
  const withMapsPhone = makePlace('mp1', {
    title: 'Ever Vision School',
    website: 'https://ever-vision.edu.np',
    phoneNumber: '01-9999999',
  });
  const summary8 = await runWebsiteDiscoveryGate({
    places: [withMapsPhone],
    lookupBudget: 5,
    selectFirstPartyUrl: rankerSelector,
    selectPhone: (p) => workflowStyleSelectPhone(p.place, p.results, p.businessDomain),
    lookup: async (): Promise<DiscoveryLookupResult> => ({
      queries: ['Ever Vision School Satungal'],
      results: [result('https://ever-vision.edu.np/contact', 'Contact', 'Office: 01-4470777')],
    }),
  });
  assert(
    withMapsPhone.phoneNumber === '01-9999999',
    'Snippet phone never overwrites an existing Maps phone'
  );
  assert(
    summary8.records[0].phone === '01-4470777',
    'The snippet phone is still recorded as provenance (not applied)'
  );

  // --- 9. Duplicates inherit the attributed phone ---
  console.log('\n--- 9. Duplicate inheritance ---');
  const duplicatePair = [
    makePlace('dup9', { title: 'Ever Vision School' }),
    makePlace('dup9', { title: 'Ever Vision School', address: 'Satungal' }),
  ];
  let lookups9 = 0;
  const summary9 = await runWebsiteDiscoveryGate({
    places: duplicatePair,
    lookupBudget: 5,
    selectFirstPartyUrl: rankerSelector,
    selectPhone: (p) => workflowStyleSelectPhone(p.place, p.results, p.businessDomain),
    lookup: async (): Promise<DiscoveryLookupResult> => {
      lookups9++;
      return {
        queries: ['Ever Vision School Satungal'],
        results: [result('https://ever-vision.edu.np', 'Ever Vision School', 'Office: 01-4470777')],
      };
    },
  });
  assert(lookups9 === 1, 'One lookup for the duplicate pair');
  assert(
    duplicatePair.every((p) => p.phoneNumber === '01-4470777'),
    'Both duplicate objects inherit the attributed phone'
  );
  assert(summary9.records[0].duplicatesMerged === 1, 'Duplicate merge recorded');

  // --- 10. Back-compat: no selectPhone → legacy behaviour (no attribution) ---
  console.log('\n--- 10. Callers without selectPhone are unaffected ---');
  const legacy = makePlace('lg1', { title: 'Ever Vision School' });
  const summary10 = await runWebsiteDiscoveryGate({
    places: [legacy],
    lookupBudget: 5,
    selectFirstPartyUrl: rankerSelector,
    lookup: async (): Promise<DiscoveryLookupResult> => ({
      queries: ['Ever Vision School Satungal'],
      results: [result('https://ever-vision.edu.np', 'Ever Vision School', 'Office: 01-4470777')],
    }),
  });
  assert(legacy.website === 'https://ever-vision.edu.np', 'Website discovery unchanged');
  assert(!legacy.phoneNumber, 'No selectPhone → NO snippet phones at all (fail-safe default)');
  assert(summary10.records[0].phone === undefined, 'No attribution recorded');

  console.log('\n===============================================================');
  console.log('🎉 SNIPPET PHONE ATTRIBUTION GUARD TESTS PASSED (100%)');
  console.log('===============================================================');
}

try {
  runTests();
} catch (err) {
  console.error('Test failed:', err);
  process.exit(1);
}