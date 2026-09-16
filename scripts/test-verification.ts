import {
  verifyCandidateWebsite,
} from '../src/services/verification.service';
import type { ResearchCandidate } from '../src/mastra/agents/research-agent/schema';
import type { WebsiteEvidence, WebsitePageEvidence } from '../src/mastra/agents/research-agent/verification.schema';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

function makeCandidate(overrides: Partial<ResearchCandidate> = {}): ResearchCandidate {
  return {
    name: 'Himalayan Java Coffee',
    location: 'Tridevi Marg, Thamel, Kathmandu',
    website: 'https://himalayanjava.com',
    phone: '+977-1-4240520',
    coordinates: { lat: 27.7149, lng: 85.3123 },
    rating: 4.5,
    ratingCount: 120,
    category: 'Coffee Shop',
    sources: {
      googleMaps: {
        found: true,
        placeId: 'ChIJ-test1',
        address: 'Tridevi Marg, Thamel, Kathmandu',
        phone: '+977-1-4240520',
        website: 'https://himalayanjava.com',
      },
      webSearch: [],
    },
    entityMatch: { matched: false, confidence: 0, method: 'none' },
    classification: { status: 'usable', type: 'business', confidence: 0.9, reason: 'test' },
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<WebsiteEvidence> = {}): WebsiteEvidence {
  const page: WebsitePageEvidence = {
    url: 'https://himalayanjava.com/',
    content: 'Himalayan Java Coffee in Thamel. Call +977-1-4240520. info@himalayanjava.com',
    favicon: 'https://himalayanjava.com/fav.ico',
    success: true,
    discoverySource: 'homepage',
    pageType: 'home',
  };
  return {
    url: 'https://himalayanjava.com',
    domain: 'himalayanjava.com',
    pages: [page],
    extractedEmails: ['info@himalayanjava.com'],
    extractedPhones: ['+977-1-4240520'],
    extractedMobiles: [],
    extractedSocialLinks: { facebook: 'https://facebook.com/himalayanjava', instagram: '', tiktok: '', other: {} },
    extractedServices: ['Coffee'],
    favicon: 'https://himalayanjava.com/fav.ico',
    rawContentSummary: 'Himalayan Java Coffee in Thamel...',
    ...overrides,
  };
}
function runTests() {
  console.log('===============================================================');
  console.log('🧪 VERIFICATION SERVICE UNIT TESTS (ZERO API)');
  console.log('===============================================================');

  // 1. Verified: name + phone match (and domain).
  console.log('\n--- status: verified (name + phone) ---');
  const verified = verifyCandidateWebsite(makeCandidate(), makeEvidence());
  assert(verified.status === 'verified', `Name + phone match → verified (got ${verified.status})`);
  assert(verified.checks.businessNameFoundOnWebsite === true, 'businessNameFoundOnWebsite true');
  assert(verified.checks.phoneMatchesMaps === true, 'phoneMatchesMaps true');
  assert(verified.checks.websiteIsUsableOfficial === true, 'websiteIsUsableOfficial true');
  assert(verified.overallConfidence > 0.5, `overallConfidence meaningful (${verified.overallConfidence})`);

  // 2. Partial: domain + email only, weak identity alignment.
  console.log('\n--- status: partial (domain + email, no name/phone) ---');
  const partialEvidence = makeEvidence({
    pages: [
      {
        url: 'https://himalayanjava.com/',
        content: 'Welcome to our new website launch. Contact the webmaster for details.',
        favicon: '',
        success: true,
        discoverySource: 'homepage',
        pageType: 'home',
      },
    ],
    extractedEmails: ['webmaster@himalayanjava.com'],
    extractedPhones: [],
    extractedSocialLinks: { facebook: '', instagram: '', tiktok: '', other: {} },
    rawContentSummary: 'Welcome to our new website launch...',
  });
  const partial = verifyCandidateWebsite(makeCandidate(), partialEvidence);
  assert(
    partial.status === 'partial' || partial.status === 'weak',
    `Domain + email only → partial/weak (got ${partial.status})`
  );
  assert(partial.checks.emailFoundOnWebsite === true, 'emailFoundOnWebsite true');

  // 3. Weak: extracted content but no identity alignment.
  console.log('\n--- status: weak (little identity alignment) ---');
  const weakEvidence = makeEvidence({
    pages: [
      {
        url: 'https://himalayanjava.com/',
        content: 'Site under construction. Please check back later.',
        favicon: '',
        success: true,
        discoverySource: 'homepage',
        pageType: 'home',
      },
    ],
    extractedEmails: [],
    extractedPhones: [],
    extractedSocialLinks: { facebook: '', instagram: '', tiktok: '', other: {} },
    rawContentSummary: 'Site under construction.',
  });
  const weak = verifyCandidateWebsite(makeCandidate(), weakEvidence);
  assert(weak.status === 'weak', `Under-construction site → weak (got ${weak.status})`);
  assert(weak.checks.businessNameFoundOnWebsite === false, 'name not found for weak');

  // 4. Failed: no usable website.
  console.log('\n--- status: failed (no usable website) ---');
  const noSite = verifyCandidateWebsite(makeCandidate({ website: 'https://instagram.com/himalayanjava' }), undefined);
  assert(noSite.status === 'failed', `Social website → failed (got ${noSite.status})`);
  assert(noSite.checks.websiteIsUsableOfficial === false, 'websiteIsUsableOfficial false for social URL');

  // 5. Failed: no successful pages.
  console.log('\n--- status: failed (no successful pages) ---');
  const failedPagesEvidence = makeEvidence({
    pages: [
      {
        url: 'https://himalayanjava.com/',
        content: '',
        favicon: '',
        success: false,
        error: 'timeout',
        discoverySource: 'homepage',
        pageType: 'home',
      },
    ],
  });
  const failedPages = verifyCandidateWebsite(makeCandidate(), failedPagesEvidence);
  assert(failedPages.status === 'failed', `No successful pages → failed (got ${failedPages.status})`);

  // 6. Maps phone mismatch → note (insufficient evidence, not mismatch proof).
  console.log('\n--- phone mismatch note semantics ---');
  const mismatchEvidence = makeEvidence({
    pages: [
      {
        url: 'https://himalayanjava.com/',
        content: 'Himalayan Java Coffee. Call 01-5552222. info@himalayanjava.com',
        favicon: '',
        success: true,
        discoverySource: 'homepage',
        pageType: 'home',
      },
    ],
    extractedPhones: ['01-5552222'],
  });
  const mismatch = verifyCandidateWebsite(makeCandidate(), mismatchEvidence);
  assert(mismatch.checks.phoneMatchesMaps === false, 'phoneMatchesMaps false on mismatch');
  assert(
    mismatch.notes.some((n) => n.toLowerCase().includes('insufficient evidence')),
    'Mismatch note says insufficient evidence (not proof of mismatch)'
  );

  // 7. No trivial self-verification: same URL alone can never yield verified.
  console.log('\n--- no trivial self-verification ---');
  const selfOnly = verifyCandidateWebsite(
    makeCandidate({ phone: '', location: '' }),
    makeEvidence({
      pages: [
        {
          url: 'https://himalayanjava.com/',
          content: 'No name match at all here.',
          favicon: '',
          success: true,
          discoverySource: 'homepage',
          pageType: 'home',
        },
      ],
      extractedEmails: [],
      extractedPhones: [],
      extractedSocialLinks: { facebook: '', instagram: '', tiktok: '', other: {} },
    })
  );
  assert(selfOnly.status !== 'verified', `Domain consistency alone never verifies (got ${selfOnly.status})`);

  console.log('\n===============================================================');
  console.log('🎉 VERIFICATION SERVICE UNIT TESTS PASSED (100%)');
  console.log('===============================================================');
}

runTests();