import {
  selectFirstPartyWebsiteUrl,
  MIN_FIRST_PARTY_SCORE,
  type RankedUrl,
} from '@/services/discovery/website-search-ranker.service';
import {
  classifySocialProfile,
  CATEGORY_GENERIC_TOKENS,
  INDUSTRY_GENERIC_TOKENS,
  resolveCategoryKey,
} from '@/services/business-extractor.service';
import {
  DIRECTORY_DOMAINS as CLASSIFIER_DIRECTORY_DOMAINS,
} from '@/services/resolution/candidate-classifier.service';
import {
  DIRECTORY_DOMAINS as RELATIONSHIP_DIRECTORY_DOMAINS,
} from '@/services/resolution/website-relationship.service';

// ============================================================================
// Satungal 5-Category Sweep — Frozen Defect Regression Suite (OFFLINE)
// ============================================================================
// Origin: 2026-09-24 Satungal sweep (SPA, Gym, Barber, Banquet Hall, Parlor).
// Class A: ranker accepted non-business URLs as first-party (host-only rule).
// Class B: social matcher accepted wrong handles on generic-token overlap.
// Structural: stoplist gaps + host-identity + threshold floor.
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

function candidate(url: string, title: string, description = ''): RankedUrl {
  return { url, title, description };
}

const GYM_CTX = ['Gym', 'Fitness Center'];
const BARBER_CTX = ['Barber shop', 'Hair salon'];
const BANQUET_CTX = ['Banquet hall'];
const PARLOR_CTX = ['Beauty salon', 'Parlor'];

function runClassA() {
  console.log('\n--- Class A: Ranker false first-party websites (host-only identity) ---');

  const cases: Array<{
    business: string;
    url: string;
    title: string;
    description: string;
    location: string;
    category: string[];
    label: string;
  }> = [
    {
      business: 'Satungal Complex',
      url: 'https://chaudharygroup.com/cg-dp',
      title: 'CG Digital Payments',
      description: 'Satungal Complex development updates near Kathmandu.',
      location: 'Satungal, Kathmandu',
      category: PARLOR_CTX,
      label: 'A1 chaudharygroup.com for Satungal Complex',
    },
    {
      business: 'Bishnu Devi Community Hall',
      url: 'https://slideshare.net/slideshow/satungal-settlement-study-by-student-of-kathmandu-university/281141132',
      title: 'Satungal settlement study by student of Kathmandu University',
      description: 'Settlement patterns around Bishnu Devi temple and community hall in Satungal.',
      location: 'Satungal, Kathmandu',
      category: BANQUET_CTX,
      label: 'A2 slideshare.net for Bishnu Devi Community Hall',
    },
    {
      business: 'Chandragiri Party Palace',
      url: 'https://eticketnepal.com/venues/chandragiri-party-palace-5',
      title: 'Chandragiri Party Palace - Venue booking',
      description: 'Book Chandragiri Party Palace for events in Kathmandu.',
      location: 'Satungal, Kathmandu',
      category: BANQUET_CTX,
      label: 'A3 eticketnepal.com for Chandragiri Party Palace',
    },
    {
      business: 'Sakura beauty parlour',
      url: 'https://yopoho.com/business/display.php?iid=9604',
      title: 'Sakura beauty parlour listing',
      description: 'Sakura beauty parlour business directory page in Kathmandu.',
      location: 'Satungal, Kathmandu',
      category: PARLOR_CTX,
      label: 'A4 yopoho.com for Sakura beauty parlour',
    },
    {
      business: 'Strength Fitness',
      url: 'https://iconicgymbahal.com/',
      title: 'Iconic Gym Bahal',
      description: 'Strength training gym in Bahal, Kathmandu.',
      location: 'Satungal, Kathmandu',
      category: GYM_CTX,
      label: 'A5 iconicgymbahal.com for Strength Fitness',
    },
  ];

  for (const c of cases) {
    const res = selectFirstPartyWebsiteUrl({
      results: [candidate(c.url, c.title, c.description)],
      businessName: c.business,
      location: c.location,
      categoryContext: c.category,
    });
    assert(res.url === undefined, `${c.label} must NOT be selected (got ${res.url ?? 'none'})`);
  }

  // Legit first-party sites must still be selectable (host contains brand token).
  const legit = selectFirstPartyWebsiteUrl({
    results: [
      candidate('https://ever-vision.edu.np', 'Ever Vision School | Satungal, Kathmandu', 'Official website.'),
      candidate('https://school-directory.example/school/ever-vision-school', 'Ever Vision School Directory'),
    ],
    businessName: 'Ever Vision School',
    location: 'Satungal, Kathmandu',
  });
  assert(legit.url === 'https://ever-vision.edu.np', `Legit site still selected (got ${legit.url ?? 'none'})`);

  const everest = selectFirstPartyWebsiteUrl({
    results: [candidate('https://everest.com.np', 'Everest', 'Kathmandu, Nepal')],
    businessName: 'Everest',
    location: 'Kathmandu',
  });
  assert(everest.url === 'https://everest.com.np', `Single-token host match still selected (got ${everest.url ?? 'none'})`);

  assert(
    MIN_FIRST_PARTY_SCORE >= 33,
    `MIN_FIRST_PARTY_SCORE raised above defect band 16-32 (got ${MIN_FIRST_PARTY_SCORE})`
  );

  // Blocklist coverage for all five Class A domains.
  const blockedDomains = [
    'slideshare.net',
    'eticketnepal.com',
    'yopoho.com',
    'scribd.com',
    'prezi.com',
    'issuu.com',
    'docs.google.com',
    'coursehero.com',
    'studocu.com',
  ];
  for (const d of blockedDomains) {
    assert(
      CLASSIFIER_DIRECTORY_DOMAINS.has(d) && RELATIONSHIP_DIRECTORY_DOMAINS.has(d),
      `Directory blocklist contains ${d}`
    );
  }
}

function runClassB() {
  console.log('\n--- Class B: Social matcher generic-token overlap ---');

  // Defect D-3.1: Santosh Hair cutting must NOT get arjunhaircuttingsaloon.
  const santosh = classifySocialProfile(
    'https://facebook.com/arjunhaircuttingsaloon',
    undefined,
    'Santosh Hair cutting',
    undefined,
    BARBER_CTX
  );
  assert(
    santosh.status !== 'accepted',
    `B1 Santosh Hair cutting rejects arjunhaircuttingsaloon (got ${santosh.status})`
  );

  // Defect D-2.3: Active Fitness Gym must NOT get active3fitnessclub.
  const active = classifySocialProfile(
    'https://facebook.com/active3fitnessclub',
    undefined,
    'Active Fitness Gym',
    undefined,
    GYM_CTX
  );
  assert(
    active.status !== 'accepted',
    `B2 Active Fitness Gym rejects active3fitnessclub (got ${active.status})`
  );

  // Stoplist presence (prevention for future categories).
  const beauty = new Set(CATEGORY_GENERIC_TOKENS.beauty);
  for (const tok of ['cutting', 'saloon', 'barber', 'barbershop', 'haircut', 'shave']) {
    assert(beauty.has(tok), `beauty stoplist contains "${tok}"`);
  }
  const fitness = new Set(CATEGORY_GENERIC_TOKENS.fitness);
  for (const tok of ['active', 'station']) {
    assert(fitness.has(tok), `fitness stoplist contains "${tok}"`);
  }
  assert(INDUSTRY_GENERIC_TOKENS.has('active'), 'INDUSTRY_GENERIC_TOKENS contains "active"');
  assert(INDUSTRY_GENERIC_TOKENS.has('station'), 'INDUSTRY_GENERIC_TOKENS contains "station"');

  // Category resolution for banquet/venue (prevents Trishakti-style regressions).
  assert(resolveCategoryKey('Banquet hall') === 'venue', 'Banquet hall resolves to venue category');
  assert(resolveCategoryKey('Barber shop') === 'beauty', 'Barber shop resolves to beauty');
  assert(resolveCategoryKey('Gym') === 'fitness', 'Gym resolves to fitness');
}

function runClassBPositives() {
  console.log('\n--- Class B positives (no regression on correct attaches) ---');

  const positives: Array<{ name: string; url: string; ctx: string[]; label: string }> = [
    {
      name: 'Matshya Narayan Recreation Center',
      url: 'https://facebook.com/matshyanarayanrecreationcenter',
      ctx: GYM_CTX,
      label: 'P1 Matshya Narayan FB',
    },
    {
      name: 'B&L Fitness Station',
      url: 'https://facebook.com/p/BL-Fitness-Station-100073038555501',
      ctx: GYM_CTX,
      label: 'P2 B&L Fitness Station FB',
    },
    {
      name: 'Kohinoor Fitness',
      url: 'https://facebook.com/p/Kohinoor-Fitness-61556361374966',
      ctx: GYM_CTX,
      label: 'P3 Kohinoor Fitness FB',
    },
    {
      name: 'White Durbar Party Palace',
      url: 'https://facebook.com/WhiteDurbarPartyPalace',
      ctx: BANQUET_CTX,
      label: 'P4 White Durbar Party Palace FB',
    },
    {
      name: 'Trishakti Banquet',
      url: 'https://facebook.com/trishaktipartypalacewow',
      ctx: BANQUET_CTX,
      label: 'P5 Trishakti Banquet FB',
    },
    {
      name: 'Aagan Reception',
      url: 'https://facebook.com/p/Aagan-Reception-61573995579445',
      ctx: BANQUET_CTX,
      label: 'P6 Aagan Reception FB',
    },
    {
      name: 'Chandragiri Party Palace',
      url: 'https://facebook.com/chandragiripartypalace',
      ctx: BANQUET_CTX,
      label: 'P7 Chandragiri Party Palace FB (exact-name path)',
    },
    {
      name: 'Beauty Shine Makeup Studio with Spa',
      url: 'https://facebook.com/beautyshinemakeupstudioandspacenter',
      ctx: PARLOR_CTX,
      label: 'P8 Beauty Shine FB',
    },
    {
      name: 'Power Speed Gym & Fitness',
      url: 'https://facebook.com/p/PoweR-SpeeD-GYM-Fitness-100066647353553',
      ctx: GYM_CTX,
      label: 'P9 Power Speed Gym FB',
    },
    {
      name: 'Ever Vision School',
      url: 'https://facebook.com/EverVisionNepal/mentions',
      ctx: ['School'],
      label: 'P10 Ever Vision FB',
    },
  ];

  for (const p of positives) {
    const res = classifySocialProfile(p.url, undefined, p.name, undefined, p.ctx);
    assert(res.status === 'accepted', `${p.label} accepted (got ${res.status}: ${res.rejectionReason})`);
  }

  // Correct rejections from the sweep must remain rejected.
  const negatives: Array<{ name: string; url: string; ctx: string[]; label: string }> = [
    {
      name: 'The Lost Pluto Barber',
      url: 'https://instagram.com/barberclub.nepal',
      ctx: BARBER_CTX,
      label: 'N1 Lost Pluto rejects barberclub.nepal',
    },
    {
      name: 'Hamro Banquet',
      url: 'https://facebook.com/aagan.reception.841069',
      ctx: BANQUET_CTX,
      label: 'N2 Hamro Banquet rejects Aagan page',
    },
    {
      name: 'Strength Fitness',
      url: 'https://facebook.com/epicfitnessnepal',
      ctx: GYM_CTX,
      label: 'N3 Strength Fitness rejects epicfitnessnepal',
    },
    {
      name: 'PG Unisex Salon',
      url: 'https://instagram.com/g2royalunisexsalon',
      ctx: PARLOR_CTX,
      label: 'N4 PG Unisex Salon rejects g2royalunisexsalon',
    },
  ];

  for (const n of negatives) {
    const res = classifySocialProfile(n.url, undefined, n.name, undefined, n.ctx);
    assert(res.status !== 'accepted', `${n.label} (got ${res.status})`);
  }

  // D29 numeric Facebook ID path must not become BUSINESS_NAME_MISMATCH.
  const numericFb = classifySocialProfile(
    'https://facebook.com/100057654781298',
    'facebook',
    'ETERNITY FITNESS',
    undefined,
    GYM_CTX,
    'serp'
  );
  assert(
    numericFb.rejectionReason !== 'BUSINESS_NAME_MISMATCH',
    `P11 ETERNITY numeric FB not BUSINESS_NAME_MISMATCH (got ${numericFb.rejectionReason})`
  );
}

function runStructural() {
  console.log('\n--- Structural / prevention invariants ---');

  // New-category readiness: every PRIORITY map value has a stoplist entry.
  // (resolveCategoryKey only returns keys present in CATEGORY_GENERIC_TOKENS.)
  const resolvable = [
    'beauty',
    'fitness',
    'venue',
    'dental',
    'medical',
    'education',
    'hospitality',
    'legal',
    'retail',
    'hardware',
    'driving',
    'furniture',
    'services',
  ];
  for (const key of resolvable) {
    const tokens = CATEGORY_GENERIC_TOKENS[key];
    assert(
      Array.isArray(tokens) && tokens.length >= 5,
      `CATEGORY_GENERIC_TOKENS["${key}"] is populated (${tokens?.length ?? 0} tokens)`
    );
  }

  // Host-only rule reason trail: SERP-text-only match must be marked ineligible.
  const textOnly = selectFirstPartyWebsiteUrl({
    results: [
      candidate(
        'https://unrelated-corp.example/about',
        'Random page',
        'Mentions Satungal Complex redevelopment plans in Kathmandu valley.'
      ),
    ],
    businessName: 'Satungal Complex',
    location: 'Satungal, Kathmandu',
    categoryContext: PARLOR_CTX,
  });
  assert(textOnly.url === undefined, 'SERP-text-only brand mention does not qualify');
}

function main() {
  console.log('================================================================');
  console.log('🧪 SATUNGAL SWEEP DEFECT REGRESSION SUITE');
  console.log('================================================================');

  runClassA();
  runClassB();
  runClassBPositives();
  runStructural();

  console.log('\n================================================================');
  console.log(`TOTAL: ${passed} PASS, ${failed} FAIL`);
  console.log('================================================================');
  if (failed > 0) process.exit(1);
}

main();
