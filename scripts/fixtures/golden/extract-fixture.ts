/**
 * Phase 0 (0.3) — Golden fixture extractor (one-time, provenance-recording).
 *
 * Derives a small, deterministic replay fixture from real run artifacts so the
 * pure transformation stages can be replayed offline forever without needing a
 * 30 MB history archive. Source provenance (run id, file sha256, byte size and
 * every reduction applied) is recorded inside the fixture itself.
 *
 * Reductions applied to raw run data:
 *   - `websiteEvidence.pages[].rawHtml` removed (never used by the pure stages)
 *   - page `content` truncated to PAGE_CONTENT_LIMIT characters
 *   - at most PLACES_LIMIT places, WEB_LIMIT web results, PAIRS_LIMIT evidence pairs
 *
 * Usage:
 *   npx tsx scripts/fixtures/golden/extract-fixture.ts
 *
 * cspell:ignore ciceducationhub geocoding kiecdraft globaleye bebe
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const EVIDENCE_RUN = 'output/history/2026-09-25T11-49-07-627Z-consultancy';
const BROAD_RUN = 'output/history/2026-09-25T07-48-18-469Z-consultancy';
const OUT_DIR = 'scripts/fixtures/golden/input';
const PAGE_CONTENT_LIMIT = 2000;
const PLACES_LIMIT = 8;
const WEB_LIMIT = 4;
const PAIRS_LIMIT = 3;

interface LooseRecord {
  [key: string]: unknown;
}

function readJson(relativePath: string): LooseRecord {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')) as LooseRecord;
}

function sha256File(relativePath: string): { sha256: string; bytes: number } {
  const buffer = fs.readFileSync(path.join(REPO_ROOT, relativePath));
  return { sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.byteLength };
}

/** Minimal shapes for the run artifacts consumed here (only fields the fixture needs). */
interface Page {
  url: string;
  content?: string;
  favicon?: string;
  success?: boolean;
  discoverySource?: string;
  pageType?: string;
  rawHtml?: string;
}

interface WebsiteEvidence {
  url?: string;
  domain?: string;
  pages?: Page[];
  [key: string]: unknown;
}

interface EvidenceRecord {
  candidate: { name?: string; website?: string; [key: string]: unknown };
  websiteEvidence?: WebsiteEvidence;
  [key: string]: unknown;
}

interface Listing {
  name: string;
  websites?: string[];
  [key: string]: unknown;
}

interface Candidate {
  rank?: number;
  title?: string;
  url?: string;
  domain?: string;
  provider?: string;
  source?: string;
  placeId?: string;
  phoneNumber?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  rating?: number;
  ratingCount?: number;
  businessType?: string;
  description?: string;
  thumbnailUrl?: string;
  hours?: unknown;
  [key: string]: unknown;
}

function domainOf(url: string | undefined): string {
  try {
    return new URL(url ?? '').hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Strip `rawHtml` and truncate page content — the pure stages never need the full DOM. */
function truncateEvidence(evidence: EvidenceRecord): EvidenceRecord {
  const web = evidence.websiteEvidence;
  if (!web) return evidence;
  const pages = (web.pages ?? []).map((page) => ({
    url: page.url,
    content: (page.content ?? '').slice(0, PAGE_CONTENT_LIMIT),
    favicon: page.favicon ?? '',
    success: page.success ?? false,
    discoverySource: page.discoverySource,
    pageType: page.pageType,
  }));
  return { ...evidence, websiteEvidence: { ...web, pages } };
}

interface PickPair {
  bucket: string;
  listing: Listing;
  evidence: EvidenceRecord;
}

/** One pair per evidence class: verified first-party, transient failure, unverified-with-content. */
function pickPairs(evidence: EvidenceRecord[], listings: Listing[]): PickPair[] {
  const byName = new Map<string, Listing>(listings.map((listing) => [listing.name, listing]));
  const buckets: Array<{ name: string; test: (record: EvidenceRecord) => boolean }> = [
    {
      name: 'verified_first_party_with_content',
      test: (record) => record.sourceHealth === 'verified' && record.websiteRelationship === 'first_party',
    },
    { name: 'transient_failure_no_pages', test: (record) => record.sourceHealth === 'transient_failure' },
    {
      name: 'unverified_with_content',
      test: (record) =>
        record.websiteRelationship === 'unverified' && (record.websiteEvidence?.pages?.length ?? 0) > 0,
    },
  ];

  const pairs: PickPair[] = [];
  const used = new Set<number>();
  for (const bucket of buckets) {
    const index = evidence.findIndex(
      (record, position) =>
        !used.has(position) && bucket.test(record) && byName.has(record.candidate?.name ?? '')
    );
    if (index < 0) continue;
    used.add(index);
    const selected = evidence[index];
    pairs.push({
      bucket: bucket.name,
      listing: byName.get(selected.candidate.name as string) as Listing,
      evidence: truncateEvidence(selected),
    });
    if (pairs.length === PAIRS_LIMIT) break;
  }
  return pairs;
}

function toPlace(candidate: Candidate, index: number): Record<string, unknown> {
  return {
    position: candidate.rank ?? index + 1,
    title: candidate.title,
    address: candidate.address,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    rating: candidate.rating,
    ratingCount: candidate.ratingCount,
    category: candidate.businessType,
    phoneNumber: candidate.phoneNumber,
    website: candidate.url,
    placeId: candidate.placeId,
    description: candidate.description,
    thumbnailUrl: candidate.thumbnailUrl,
    openingHours: candidate.hours,
  };
}

const PHONE_SAMPLES = [
  '+977 985-1180403',
  '9851180403',
  '+977-985-1180403',
  '9802330366',
  '+977 980-2338788',
  '+977-984-1778666',
  '+977-980-2347644',
  '+977-980-2336911',
  '+977-01-5332834',
  '01-5332834',
  '+977 1-5971526',
  '1-5368547',
  '+977 061591171',
  '+977 023 591640',
  '9779779851234567',
  '+977 (01) 4567890',
  '27.382262',
  '85.309623',
  '984177866',
  '12345',
  '12345678901234567',
  '+1 415 555 2671',
  '977-9851180403',
  '',
];

/** Social profile shapes: accepted business pages plus every rejection class. */
const SOCIAL_SAMPLES = [
  {
    url: 'https://www.tiktok.com/@globaleyeeducation',
    businessName: 'Global Eye Education Consultancy',
    websiteDomain: 'globaleye.edu.np',
    origin: 'website_evidence',
  },
  {
    url: 'https://www.facebook.com/globaleyeeducation',
    businessName: 'Global Eye Education Consultancy',
    websiteDomain: 'globaleye.edu.np',
    origin: 'website_evidence',
  },
  {
    url: 'https://www.instagram.com/globaleye.consultancy',
    businessName: 'Global Eye Education Consultancy',
    websiteDomain: 'globaleye.edu.np',
    origin: 'website_evidence',
  },
  {
    url: 'https://www.linkedin.com/company/global-eye-education',
    businessName: 'Global Eye Education Consultancy',
    websiteDomain: 'globaleye.edu.np',
    origin: 'website_evidence',
  },
  {
    url: 'https://facebook.com/ciceducationhub',
    businessName: 'CIC Education Hub',
    websiteDomain: 'ciceducationhub.com',
    origin: 'website_evidence',
  },
  {
    url: 'https://www.facebook.com/tr?id=1395564971716732&ev=PageView',
    businessName: 'Global Eye Education Consultancy',
    websiteDomain: 'globaleye.edu.np',
    origin: 'website_evidence',
  },
  {
    url: 'https://facebook.com/john.doe.12345',
    businessName: 'CIC Education Hub',
    websiteDomain: 'ciceducationhub.com',
    origin: 'serp',
  },
  {
    url: 'https://instagram.com/explore',
    businessName: 'CIC Education Hub',
    websiteDomain: 'ciceducationhub.com',
    origin: 'serp',
  },
  {
    url: 'https://facebook.com/pages/create',
    businessName: 'CIC Education Hub',
    websiteDomain: 'ciceducationhub.com',
    origin: 'serp',
  },
  {
    url: 'https://facebook.com/',
    businessName: 'CIC Education Hub',
    websiteDomain: 'ciceducationhub.com',
    origin: 'serp',
  },
  {
    url: '',
    businessName: 'CIC Education Hub',
    websiteDomain: 'ciceducationhub.com',
    origin: 'serp',
  },
];

function writeJson(relativePath: string, value: unknown): void {
  const abs = path.join(REPO_ROOT, relativePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  console.log(`written: ${relativePath}`);
}

function main(): void {
  const evidenceFile = `${EVIDENCE_RUN}/2b-verified-evidence.json`;
  const listingsFile = `${EVIDENCE_RUN}/3-final-listings.json`;
  const candidatesFile = `${EVIDENCE_RUN}/0-research-candidates.json`;
  const broadFile = `${BROAD_RUN}/1-broad-search.json`;

  const evidence = (readJson(evidenceFile).verifiedEvidence ?? []) as unknown as EvidenceRecord[];
  const listings = readJson(listingsFile) as unknown as Listing[];
  const candidates = (readJson(candidatesFile).candidates ?? []) as unknown as Candidate[];
  const broadResults = (readJson(broadFile).results ?? []) as unknown as Candidate[];

  const places = candidates.slice(0, PLACES_LIMIT).map(toPlace);
  const placeDomains = new Set(candidates.map((candidate) => candidate.domain ?? '').filter(Boolean));
  const webUsable = broadResults
    .filter((result) => placeDomains.has(result.domain ?? ''))
    .slice(0, WEB_LIMIT)
    .map((result) => ({
      candidate: result,
      decision: {
        url: result.url,
        domain: result.domain,
        title: result.title,
        classification: 'business',
        confidence: 1,
        reason: 'Golden fixture: deterministic acceptance of a Maps-corroborated web result',
        source: 'deterministic',
      },
    }));

  const pairs = pickPairs(evidence, listings);
  const fallbackCases = pairs
    .map((pair) => {
      const domain = domainOf(pair.evidence.candidate.website);
      const candidate = candidates.find((c) => (c.domain ?? '') === domain);
      const pages = pair.evidence.websiteEvidence?.pages ?? [];
      return {
        label: `${pair.bucket}:${pair.listing.name}`,
        candidate,
        extractions: pages.map((page) => ({
          url: page.url,
          content: page.content ?? '',
          favicon: page.favicon ?? '',
          success: page.success ?? false,
        })),
        verifiedEvidence: [pair.evidence],
        fallbackLocation: 'Kathmandu',
        runStartedAt: '1970-01-01T00:00:00.000Z',
      };
    })
    .filter((fallbackCase) => Boolean(fallbackCase.candidate))
    .slice(0, 2);

  const sources = [evidenceFile, listingsFile, candidatesFile, broadFile].map((file) => ({
    file,
    ...sha256File(file),
  }));
  const generatedAt = new Date().toISOString();

  writeJson(`${OUT_DIR}/replay-input.json`, {
    phase: '0.3',
    purpose:
      'Semantic golden replay input for pure transformation stages (no network, no Mongo, no workflow execution)',
    provenance: {
      generatedAt,
      generator: 'scripts/fixtures/golden/extract-fixture.ts',
      sources,
      reductions: [
        `places limited to the first ${PLACES_LIMIT} Maps candidates`,
        `web results limited to ${WEB_LIMIT} Maps-corroborated results`,
        'websiteEvidence.pages[].rawHtml removed',
        `websiteEvidence.pages[].content truncated to ${PAGE_CONTENT_LIMIT} characters`,
        'runStartedAt pinned to 1970-01-01T00:00:00.000Z',
      ],
      pairBuckets: pairs.map((pair) => `${pair.bucket}:${pair.listing.name}`),
    },
    runStartedAt: '1970-01-01T00:00:00.000Z',
    defaultLocation: 'Kathmandu',
    buildResearchCandidates: { places, webUsable },
    sanitizePairs: pairs.map((pair) => ({ bucket: pair.bucket, listing: pair.listing, evidence: pair.evidence })),
    fallbackCases,
    phoneSamples: PHONE_SAMPLES,
    socialSamples: SOCIAL_SAMPLES,
  });

  const royalSource = 'scripts/fixtures/royal-cleaning-fixture.json';
  const royalTarget = `${OUT_DIR}/royal-cleaning-fixture.json`;
  fs.mkdirSync(path.join(REPO_ROOT, OUT_DIR), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, royalSource), path.join(REPO_ROOT, royalTarget));

  writeJson(`${OUT_DIR}/source-manifest.json`, {
    generatedAt,
    sources,
    copied: [{ from: royalSource, to: royalTarget, ...sha256File(royalTarget) }],
  });

  console.log(
    `fixture summary: places=${places.length} webUsable=${webUsable.length} pairs=${pairs.length} fallbackCases=${fallbackCases.length} phoneSamples=${PHONE_SAMPLES.length} socialSamples=${SOCIAL_SAMPLES.length}`
  );
}

main();

