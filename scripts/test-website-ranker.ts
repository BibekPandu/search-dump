import {
  rankWebsiteSearchResults,
  selectFirstPartyWebsiteUrl,
  distinctiveNameTokens,
  tldTierOf,
  RANK_WEIGHTS,
  type RankedUrl,
} from '@/services/discovery/website-search-ranker.service';

// ============================================================================
// Phase 7a Task 4 — Zero-HTTP Search Result URL Ranker (OFFLINE, ZERO API)
// ============================================================================
// Acceptance criteria verified here:
//   [ ] Candidate URLs ranked deterministically
//   [ ] Strong business/domain alignment outranks directories
//   [ ] Directories/platforms remain detectable
//   [ ] Unrelated results rejected
//   [ ] No LLM / no HTTP needed (function is pure and synchronous)
//   [ ] Ever Vision acceptance case: directory-first SERP still yields the real site
//   [ ] Ambiguity guard: High New Vision must NOT adopt Ever Vision's website

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

function candidate(url: string, title: string, description = ''): RankedUrl {
  return { url, title, description };
}

const EVER_VISION_DIRECTORY = candidate(
  'https://school-directory.example/school/ever-vision-school',
  'Ever Vision School - Satungal, Kathmandu | School Directory',
  'Directory listing of schools in Kathmandu.'
);
const EVER_VISION_OFFICIAL = candidate(
  'https://ever-vision.edu.np',
  'Ever Vision School | Satungal, Kathmandu',
  'Official website of Ever Vision School.'
);

function runTests() {
  console.log('===============================================================');
  console.log('🧪 WEBSITE SEARCH RESULT RANKER TESTS (ZERO HTTP, ZERO LLM)');
  console.log('===============================================================\n');

  // --- 1. Ever Vision acceptance case ---
  console.log('--- 1. Ever Vision: directory-first SERP still selects the real site ---');
  const everVision = selectFirstPartyWebsiteUrl({
    results: [EVER_VISION_DIRECTORY, EVER_VISION_OFFICIAL],
    businessName: 'Ever Vision School',
    location: 'Satungal, Kathmandu',
  });
  assert(
    everVision.url === 'https://ever-vision.edu.np',
    `Selected the real website despite a directory ranking first (got ${everVision.url})`
  );
  assert(
    everVision.ranked[0].url === 'https://ever-vision.edu.np',
    'First-party site is ranked above the directory'
  );
  assert(
    everVision.ranked[1].thirdParty === true,
    'The directory candidate is still detected as third-party'
  );
  assert(everVision.reason.includes('ever-vision.edu.np'), 'Selection reason names the chosen domain');

  // --- 2. Ambiguity guard (strict-majority rule) ---
  console.log('\n--- 2. Ambiguity guard: wrong school website must be rejected ---');
  const ambiguous = selectFirstPartyWebsiteUrl({
    results: [EVER_VISION_OFFICIAL],
    businessName: 'High New Vision School',
    location: 'Kathmandu',
  });
  assert(
    ambiguous.url === undefined,
    `"High New Vision School" did NOT adopt Ever Vision's website (got ${ambiguous.url})`
  );
  assert(
    ambiguous.ranked[0].eligible === false,
    'The 2-of-4 token overlap was rejected by the strict-majority rule'
  );
  assert(
    distinctiveNameTokens('High New Vision School').length === 3,
    'High New Vision School yields 3 distinctive tokens (high, new, vision)'
  );
  assert(
    distinctiveNameTokens('Ever Vision School').length === 2,
    'Ever Vision School yields 2 distinctive tokens (ever, vision)'
  );

  // --- 3. Directory-only results produce NO website ---
  console.log('\n--- 3. Directory-only SERP → no website attached ---');
  const directoryOnly = selectFirstPartyWebsiteUrl({
    results: [EVER_VISION_DIRECTORY],
    businessName: 'Ever Vision School',
    location: 'Satungal',
  });
  assert(directoryOnly.url === undefined, 'Directory-only results attach no website');
  assert(
    directoryOnly.reason.includes('third-party'),
    `Reason explains the third-party-only outcome (got "${directoryOnly.reason}")`
  );

  // --- 4. TLD tiering: .edu.np > .com.np > .com ---
  console.log('\n--- 4. TLD tier preference ---');
  const tldRanking = rankWebsiteSearchResults({
    results: [
      candidate('https://annapurna.com', 'Annapurna Cafe, Pokhara'),
      candidate('https://annapurna.com.np', 'Annapurna Cafe, Pokhara'),
      candidate('https://annapurna.edu.np', 'Annapurna Cafe, Pokhara'),
    ],
    businessName: 'Annapurna Cafe',
    location: 'Pokhara',
  });
  assert(tldRanking[0].url === 'https://annapurna.edu.np', '.edu.np ranks first');
  assert(tldRanking[1].url === 'https://annapurna.com.np', '.com.np ranks second');
  assert(tldRanking[2].url === 'https://annapurna.com', '.com ranks last of the three');
  assert(
    tldTierOf('x.edu.np') === 'best' && tldTierOf('x.com') === 'generic',
    'TLD tier helper agrees with the ordering'
  );

  // --- 5. Directory penalty outranks the maximum TLD bonus (risk mitigation #3) ---
  console.log('\n--- 5. Directory penalty beats the best TLD ---');
  assert(
    Math.abs(RANK_WEIGHTS.thirdPartyPenalty) > RANK_WEIGHTS.tldBest,
    `|thirdPartyPenalty| (${RANK_WEIGHTS.thirdPartyPenalty}) > tldBest (${RANK_WEIGHTS.tldBest})`
  );
  const penaltyProof = selectFirstPartyWebsiteUrl({
    results: [
      candidate(
        'https://pokhara-school-directory.edu.np/school/annapurna-cafe',
        'Annapurna Cafe, Pokhara'
      ),
      candidate('https://annapurnacafe.com', 'Annapurna Cafe, Pokhara'),
    ],
    businessName: 'Annapurna Cafe',
    location: 'Pokhara',
  });
  assert(
    penaltyProof.url === 'https://annapurnacafe.com',
    'A .com first-party site beats a directory sitting on .edu.np'
  );

  // --- 6. Single-token names need a location match (Residual 2 fallback) ---
  console.log('\n--- 6. Single-token name fallback ---');
  const singleTokenOk = selectFirstPartyWebsiteUrl({
    results: [candidate('https://everest.com.np', 'Everest', 'Kathmandu, Nepal')],
    businessName: 'Everest',
    location: 'Kathmandu',
  });
  assert(
    singleTokenOk.url === 'https://everest.com.np',
    'Single-token name with a matching location IS selected'
  );
  const singleTokenBad = selectFirstPartyWebsiteUrl({
    results: [candidate('https://nepalbusinessportal.com', 'Everest', 'Bhaktapur, Nepal')],
    businessName: 'Everest',
    location: 'Kathmandu',
  });
  assert(
    singleTokenBad.url === undefined,
    'Single-token name WITHOUT a location match or domain corroboration is rejected'
  );

  // --- 7. Unrelated / article results rejected ---
  console.log('\n--- 7. Unrelated results rejected ---');
  const unrelated = selectFirstPartyWebsiteUrl({
    results: [
      candidate(
        'https://newsportal.example/news/2024/education-rankings',
        'Nepal education rankings 2024',
        'A news article about schools.'
      ),
      candidate('https://facebook.com/ever-vision-school', 'Ever Vision School page'),
    ],
    businessName: 'Ever Vision School',
    location: 'Satungal',
  });
  assert(unrelated.url === undefined, 'News article and social page attach no first-party website');
  assert(
    unrelated.ranked.some((c) => c.eligible === false),
    'The article candidate is rejected by the name-eligibility rule'
  );
  assert(
    unrelated.ranked.some((c) => c.thirdParty === true),
    'The social page is caught by third-party domain detection'
  );
  assert(
    unrelated.ranked.some((c) => c.reasons.some((r) => r.startsWith('ineligible:'))),
    'Rejection reasons are recorded (explanation for Task 8)'
  );

  // --- 8. Deep/article path loses to the homepage ---
  console.log('\n--- 8. Homepage beats a deep article page ---');
  const pathRanking = selectFirstPartyWebsiteUrl({
    results: [
      candidate(
        'https://littlestars.edu.np/news/2024/little-stars-school-quiz',
        'Little Stars School quiz 2024'
      ),
      candidate('https://littlestars.edu.np', 'Little Stars School | Lalitpur'),
    ],
    businessName: 'Little Stars School',
    location: 'Lalitpur',
  });
  assert(
    pathRanking.url === 'https://littlestars.edu.np',
    'Homepage selected over the deeper article URL on the same domain'
  );

  // --- 9. Injected usability gate is respected ---
  console.log('\n--- 9. Injected hard gate cannot be overridden by scoring ---');
  const gated = selectFirstPartyWebsiteUrl({
    results: [
      candidate('https://ever-vision.edu.np', 'Ever Vision School | Satungal'),
      candidate('https://ever-vision.com.np', 'Ever Vision School | Satungal'),
    ],
    businessName: 'Ever Vision School',
    location: 'Satungal',
    isUsable: (c) => c.url !== 'https://ever-vision.edu.np',
  });
  assert(
    gated.url === 'https://ever-vision.com.np',
    'A gate-rejected URL is never selected even if it would score highest'
  );
  assert(
    gated.ranked.some(
      (c) =>
        c.url === 'https://ever-vision.edu.np' &&
        c.reasons.some((r) => r.includes('usability gate'))
    ),
    'Gate rejection is recorded in the candidate reasons'
  );

  // --- 10. Determinism, purity and stability ---
  console.log('\n--- 10. Determinism and purity ---');
  const input = {
    results: [EVER_VISION_DIRECTORY, EVER_VISION_OFFICIAL],
    businessName: 'Ever Vision School',
    location: 'Satungal, Kathmandu',
  };
  const firstPass = JSON.stringify(rankWebsiteSearchResults(input));
  const secondPass = JSON.stringify(rankWebsiteSearchResults(input));
  assert(firstPass === secondPass, 'Identical input produces byte-identical ranking output');

  const tie = rankWebsiteSearchResults({
    results: [
      candidate('https://alpha-optics.com.np', 'Alpha Optics, Kathmandu'),
      candidate('https://beta-optics.com.np', 'Alpha Optics, Kathmandu'),
    ],
    businessName: 'Alpha Optics',
    location: 'Kathmandu',
  });
  assert(
    tie[0].url === 'https://alpha-optics.com.np',
    'Equal scores break ties by original search position (stable ordering)'
  );

  const syncResult = rankWebsiteSearchResults(input);
  assert(
    Array.isArray(syncResult) &&
      typeof (syncResult as unknown as Promise<unknown>).then !== 'function',
    'Ranker is synchronous/pure — performs no HTTP (no promise returned)'
  );
  assert(
    syncResult.every((c) => c.reasons.length > 0),
    'Every ranked candidate carries a scoring trail'
  );

  console.log('\n===============================================================');
  console.log('🎉 WEBSITE SEARCH RESULT RANKER TESTS PASSED (100%)');
  console.log('===============================================================');
}

try {
  runTests();
} catch (err) {
  console.error('Test failed:', err);
  process.exit(1);
}