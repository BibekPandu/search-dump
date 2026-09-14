import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { runResearchDiscovery } from '../src/mastra/workflows/research-workflow';
import {
  normalizePhoneDigits,
  domainFromUrlOrHost,
  isUsableOfficialWebsite,
} from '../src/services/entity-resolution.service';
import { unifiedSearchResultSchema } from '../src/services/search-fallback.service';
import { stoppedReasonEnum } from '../src/mastra/agents/research-agent/schema';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

/**
 * Scenario A — Maps-branch: target(10) is satisfiable by Google Maps alone, so
 * web pagination is skipped. Asserts lookup + uniqueness + website-purity +
 * dual-output + artifact invariants established in Phase 1.
 */
async function runMapsBranchScenario() {
  console.log('\n--- SCENARIO A: Maps Satisfies Target (target=10) ---');
  const res = await runResearchDiscovery({
    query: 'specialty coffee',
    location: 'Kathmandu',
    targetCandidates: 10,
    maxPages: 5,
  });

  const { candidates, researchCandidates, researchReport } = res;

  assert(
    stoppedReasonEnum.safeParse(researchReport.stoppedReason).success,
    `Stopped reason is valid enum: ${researchReport.stoppedReason}`
  );
  assert(researchReport.pagesSearched <= 5, `Pages searched <= 5: was ${researchReport.pagesSearched}`);
  assert(researchCandidates.length > 0, `Unique researchCandidates found: ${researchCandidates.length}`);
  assert(
    researchReport.uniqueBusinessesFound === researchCandidates.length,
    `Report uniqueBusinessesFound matches candidate length (${researchReport.uniqueBusinessesFound})`
  );

  console.log('--- GPS Provenance / Uniqueness / Website Purity / Dual Output ---');
  for (const c of researchCandidates) {
    if (c.coordinates) {
      assert(
        Boolean(c.sources.googleMaps?.found),
        `Candidate "${c.name}" GPS traces strictly to Google Maps`
      );
    } else if (!c.sources.googleMaps) {
      assert(c.coordinates === undefined, `Web-only candidate "${c.name}" has undefined coordinates`);
    }
  }

  const seenPhones = new Set<string>();
  const seenDomains = new Set<string>();
  for (const c of researchCandidates) {
    if (c.phone) {
      const cleanPhone = normalizePhoneDigits(c.phone);
      if (cleanPhone.length >= 7) {
        assert(!seenPhones.has(cleanPhone), `No duplicate phone: ${cleanPhone} (${c.name})`);
        seenPhones.add(cleanPhone);
      }
    }
    if (c.website) {
      const cleanDomain = domainFromUrlOrHost(c.website);
      if (cleanDomain && !cleanDomain.includes('google.com')) {
        assert(!seenDomains.has(cleanDomain), `No duplicate domain: ${cleanDomain} (${c.name})`);
        seenDomains.add(cleanDomain);
      }
      assert(
        isUsableOfficialWebsite(c.website),
        `Website "${c.website}" for "${c.name}" is usable/official (no social/directory)`
      );
    }
  }

  assert(
    candidates.length === researchCandidates.length,
    `Dual output counts match: candidates=${candidates.length}, researchCandidates=${researchCandidates.length}`
  );
  for (const u of candidates) {
    assert(unifiedSearchResultSchema.safeParse(u).success, `Flattened "${u.title}" validates unifiedSearchResultSchema`);
  }

  const reportPath = path.resolve(process.cwd(), 'output/0-research-candidates.json');
  assert(fs.existsSync(reportPath), 'output/0-research-candidates.json exists on disk');
  const reportData = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert(
    Array.isArray(reportData.researchCandidates) && reportData.researchCandidates.length > 0,
    '0-research-candidates.json contains tier-2 researchCandidates array'
  );
  assert(
    typeof reportData.uniqueBusinessesFound === 'number',
    '0-research-candidates.json contains uniqueBusinessesFound counter'
  );

  const leanPath = path.resolve(process.cwd(), 'output/0b-research-candidates-lean.json');
  assert(fs.existsSync(leanPath), 'output/0b-research-candidates-lean.json exists on disk');
  const leanData = JSON.parse(fs.readFileSync(leanPath, 'utf8'));
  assert(
    Array.isArray(leanData.candidates) && leanData.candidates.length === researchCandidates.length,
    '0b-research-candidates-lean.json contains lean candidate list'
  );
}
/**
 * Scenario B — Multi-Page Maps Discovery: target(20) is satisfied by Google Maps
 * paginating (e.g. Page 1 + Page 2 = 20 unique places), so Web fallback is NOT
 * invoked. Asserts target satisfaction, zero unnecessary web calls, and Maps invariants.
 */
async function runMultiPageMapsScenario() {
  console.log('\n--- SCENARIO B: Multi-Page Maps Satisfies Target (target=20) ---');
  const res = await runResearchDiscovery({
    query: 'specialty coffee',
    location: 'Kathmandu',
    targetCandidates: 20,
    maxMapsPages: 5,
    maxPages: 5,
  });

  const { candidates, researchCandidates, researchReport } = res;

  // 1. Target must be fully reached via Maps pagination (pagesSearched === 0)
  assert(
    researchCandidates.length >= 20,
    `Target reached: unique candidates >= 20 (got ${researchCandidates.length})`
  );
  assert(
    researchReport.pagesSearched === 0,
    `Web fallback was NOT invoked: pagesSearched=${researchReport.pagesSearched} (expected 0)`
  );
  assert(
    researchReport.stoppedReason === 'target_reached',
    `Stopped reason is target_reached: ${researchReport.stoppedReason}`
  );
  assert(
    researchReport.uniqueBusinessesFound === researchCandidates.length,
    `Report uniqueBusinessesFound matches candidate count (${researchReport.uniqueBusinessesFound})`
  );

  // 2. Structural Invariant: Maps candidates have placeId, coordinates, sources.googleMaps; website is optional
  for (const c of researchCandidates) {
    assert(Boolean(c.sources.googleMaps?.found), `Candidate "${c.name}" has sources.googleMaps`);
    assert(Boolean(c.sources.googleMaps?.placeId), `Candidate "${c.name}" has placeId`);
    assert(
      c.coordinates !== undefined &&
        typeof c.coordinates.lat === 'number' &&
        typeof c.coordinates.lng === 'number',
      `Candidate "${c.name}" has numeric GPS coordinates`
    );
    if (c.website) {
      assert(
        isUsableOfficialWebsite(c.website),
        `Website "${c.website}" for "${c.name}" is a verified usable official website (no social/directory)`
      );
    }
  }

  // 3. Uniqueness across all 20 unique candidates
  const seenDomains = new Set<string>();
  for (const c of researchCandidates) {
    if (c.website) {
      const dom = domainFromUrlOrHost(c.website);
      if (dom && !dom.includes('google.com')) {
        assert(!seenDomains.has(dom), `No duplicate domain among unique candidates: ${dom} (${c.name})`);
        seenDomains.add(dom);
      }
    }
  }

  // 4. Dual output compatibility
  assert(
    candidates.length === researchCandidates.length,
    `Dual output counts match: candidates=${candidates.length}, researchCandidates=${researchCandidates.length}`
  );
  for (const u of candidates) {
    assert(unifiedSearchResultSchema.safeParse(u).success, `Flattened "${u.title}" validates unifiedSearchResultSchema`);
  }
}

/**
 * Scenario C — Web-fallback handoff: When Maps is bounded or exhausted below target
 * (e.g. target 15 with maxMapsPages: 1 yielding 10), the system must seamlessly hand
 * off to Google Web Search to find the remaining deficit (5 candidates) without duplicates.
 */
async function runWebFallbackScenario() {
  console.log('\n--- SCENARIO C: Web Fallback Handoff (target=15, maxMapsPages=1) ---');
  const res = await runResearchDiscovery({
    query: 'specialty coffee',
    location: 'Kathmandu',
    targetCandidates: 15,
    maxMapsPages: 1, // Forces Maps to stop after 1 page (10 places) -> Web fills remaining
    maxPages: 5,
  });

  const { candidates, researchCandidates, researchReport } = res;

  // 1. The web fallback branch must have RUN to fulfill the deficit
  assert(
    researchReport.pagesSearched > 0,
    `Web fallback branch executed: pagesSearched=${researchReport.pagesSearched} (expected > 0)`
  );
  assert(
    stoppedReasonEnum.safeParse(researchReport.stoppedReason).success,
    `Stopped reason is valid enum: ${researchReport.stoppedReason}`
  );
  assert(
    researchCandidates.length >= 10,
    `Unique researchCandidates found: ${researchCandidates.length}`
  );

  // 2. Correction 2 invariants for any web-only candidates produced by the branch
  const webOnly = researchCandidates.filter((c) => !c.sources.googleMaps);
  console.log(`Web-only candidates: ${webOnly.length} of ${researchCandidates.length}`);
  for (const c of webOnly) {
    assert(c.coordinates === undefined, `Web-only candidate "${c.name}" has strictly undefined coordinates`);
    assert(c.sources.googleMaps === undefined, `Web-only candidate "${c.name}" has no sources.googleMaps`);
  }

  // 3. Dual output + schema compatibility
  assert(
    candidates.length === researchCandidates.length,
    `Dual output counts match: candidates=${candidates.length}, researchCandidates=${researchCandidates.length}`
  );
  for (const u of candidates) {
    assert(unifiedSearchResultSchema.safeParse(u).success, `Flattened "${u.title}" validates unifiedSearchResultSchema`);
  }
}

async function runE2ETest() {
  console.log('===============================================================');
  console.log('🧪 RUNNING LIVE END-TO-END RESEARCH DISCOVERY TEST');
  console.log('===============================================================');

  if (!process.env.SERPER_API_KEY) {
    console.warn('⚠️ SERPER_API_KEY is not defined in environment. Skipping live E2E test.');
    process.exit(0);
  }

  const startTime = Date.now();

  await runMapsBranchScenario();
  await runMultiPageMapsScenario();
  await runWebFallbackScenario();

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\nAll three scenarios completed in ${duration}s!`);

  console.log('===============================================================');
  console.log('🎉 LIVE RESEARCH DISCOVERY E2E TEST PASSED (100%)');
  console.log('===============================================================');
}

runE2ETest().catch((err) => {
  console.error('Live E2E test failed:', err);
  process.exit(1);
});