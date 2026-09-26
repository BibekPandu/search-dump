/**
 * Phase 0 (0.3) — Offline golden replay for the pure transformation stages.
 *
 * Replays the five pure stages the Phase 0 plan requires:
 *   buildResearchCandidates, sanitizeListingWithEvidence, buildFallbackListing,
 *   classifyNepalPhone, classifySocialProfile
 *
 * Runtime guarantees (enforced, not assumed):
 *   - NO NETWORK: `globalThis.fetch` is replaced by a throwing stub; any call fails the run
 *   - NO MONGO: MONGODB_URI is blanked so mongo.service degrades to "disabled"
 *   - NO WORKFLOW EXECUTION / NO PROVIDER CALLS: only pure exports are invoked
 *   - NO OUTPUT MUTATION: `output/` is snapshotted before and after and must hash-match
 *
 * Usage:
 *   npx tsx scripts/fixtures/golden/replay-golden.ts [--update] [--report <file.md>]
 *
 * `--update` re-locks `expected/replay-expected.json` and `expected/static-tables-lock.json`.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, hashCanonical, semanticDiff, summarizeDiffs } from './compare';
import { diffSnapshots, snapshotTree } from './snapshot-tree';
import { buildResearchCandidates } from '../../../src/services/research-candidate.service';
import { classifyNepalPhone, classifySocialProfile } from '../../../src/services/business-extractor.service';
import {
  buildFallbackListing,
  sanitizeListingWithEvidence,
} from '../../../src/mastra/workflows/research-workflow';
import type { SerperPlaceResult } from '../../../src/services/serper-places.service';
import type { UnifiedSearchResult } from '../../../src/services/search-fallback.service';
import type { ResearchDecision } from '../../../src/mastra/agents/research-agent/schema';
import type { BusinessListing } from '../../../src/mastra/workflows/research-workflow';
import type { VerifiedBusinessEvidence } from '../../../src/mastra/agents/research-agent/verification.schema';
import {
  NEPAL_COUNTRY_CODE,
  NTA_LANDLINE_AREA_CODES,
  NTA_MOBILE_PREFIXES,
} from '../../../src/config/nepal-telecom.config';
import { REGISTERED_LOCALITY_CLUSTERS } from '../../../src/config/geo-localities.config';
import {
  DOCUMENT_PLATFORM_DOMAINS,
  EXTRA_DIRECTORY_DOMAINS,
  SHARED_DIRECTORY_DOMAINS,
} from '../../../src/config/directory-domains.config';
import {
  BROAD_QUERY_PATTERNS,
  CATEGORY_EXPANSION_POLICIES,
  CATEGORY_STEM_MAPPINGS,
} from '../../../src/config/category-expansion.config';
import {
  CATEGORY_GENERIC_TOKENS,
  INDUSTRY_GENERIC_TOKENS,
  NEPAL_LOCALITY_TOKENS,
  UNIVERSAL_STOPWORDS,
} from '../../../src/services/business-extractor.service';

// Lazily-read runtime configuration is neutralized before any stage executes.
process.env.MONGODB_URI = '';
process.env.MONGODB_DB_NAME = '';
process.env.TAVILY_API_KEY = '';
process.env.SERPER_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';
process.env.DISCOVERY_MODE = 'production';

const REPO_ROOT = process.cwd();
const GOLDEN_DIR = 'scripts/fixtures/golden';
const INPUT_FILE = `${GOLDEN_DIR}/input/replay-input.json`;
const EXPECTED_FILE = `${GOLDEN_DIR}/expected/replay-expected.json`;
const LOCK_FILE = `${GOLDEN_DIR}/expected/static-tables-lock.json`;
const OUTPUT_DIR = 'output';

interface ReplayInput {
  provenance: { sources: Array<{ file: string }>; pairBuckets: string[] };
  runStartedAt: string;
  defaultLocation: string;
  buildResearchCandidates: {
    places: SerperPlaceResult[];
    webUsable: Array<{ candidate: UnifiedSearchResult; decision: ResearchDecision }>;
  };
  sanitizePairs: Array<{ bucket: string; listing: BusinessListing; evidence: VerifiedBusinessEvidence }>;
  fallbackCases: Array<{
    label: string;
    candidate: UnifiedSearchResult;
    extractions: Array<{ url: string; content: string; favicon: string; success: boolean }>;
    verifiedEvidence: VerifiedBusinessEvidence[];
    fallbackLocation: string;
    runStartedAt: string;
  }>;
  phoneSamples: string[];
  socialSamples: Array<{
    url: string;
    businessName: string;
    websiteDomain: string;
    origin: 'website_evidence' | 'serp' | 'maps';
  }>;
}

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')) as unknown;
}

function sha256File(relativePath: string): string {
  return createHash('sha256')
    .update(fs.readFileSync(path.join(REPO_ROOT, relativePath)))
    .digest('hex');
}

/** Fails the replay loudly if any stage attempts network I/O. */
function installNetworkGuard(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const target = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
    calls.push(target);
    throw new Error(`Phase 0 replay must not perform network I/O (attempted: ${target})`);
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Order-preserving hash — static tables must be locked byte-for-byte, not re-sorted by value. */
function hashRaw(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(serializeStaticTable(value))).digest('hex');
}

/**
 * Sets and Maps are used for membership tables; `JSON.stringify` would collapse them to
 * `{}`, so they are materialized deterministically (sorted) before hashing.
 */
function serializeStaticTable(value: unknown): unknown {
  if (value instanceof Set) return [...value].map(String).sort();
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, entry]) => [String(key), entry] as [string, unknown])
      .sort((a, b) => a[0].localeCompare(b[0]));
  }
  return value;
}

function tableSize(value: unknown): number {
  if (value instanceof Set || value instanceof Map) return value.size;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') return value.length;
  return Object.keys(value as object).length;
}

interface StaticTableLock {
  capturedAt: string;
  tables: Array<{
    id: string;
    sourceFile: string;
    sourceSha256: string;
    tableSha256: string;
    size: number;
  }>;
}

/** Immutable reference tables: telecom prefixes, token vocabulary, geo registry, directory domains. */
function buildStaticTableLock(): StaticTableLock {
  const tables: Array<{ id: string; value: unknown; sourceFile: string }> = [
    { id: 'NEPAL_COUNTRY_CODE', value: NEPAL_COUNTRY_CODE, sourceFile: 'src/config/nepal-telecom.config.ts' },
    { id: 'NTA_MOBILE_PREFIXES', value: NTA_MOBILE_PREFIXES, sourceFile: 'src/config/nepal-telecom.config.ts' },
    {
      id: 'NTA_LANDLINE_AREA_CODES',
      value: NTA_LANDLINE_AREA_CODES,
      sourceFile: 'src/config/nepal-telecom.config.ts',
    },
    {
      id: 'REGISTERED_LOCALITY_CLUSTERS',
      value: REGISTERED_LOCALITY_CLUSTERS,
      sourceFile: 'src/config/geo-localities.config.ts',
    },
    {
      id: 'DOCUMENT_PLATFORM_DOMAINS',
      value: DOCUMENT_PLATFORM_DOMAINS,
      sourceFile: 'src/config/directory-domains.config.ts',
    },
    {
      id: 'EXTRA_DIRECTORY_DOMAINS',
      value: EXTRA_DIRECTORY_DOMAINS,
      sourceFile: 'src/config/directory-domains.config.ts',
    },
    {
      id: 'SHARED_DIRECTORY_DOMAINS',
      value: SHARED_DIRECTORY_DOMAINS,
      sourceFile: 'src/config/directory-domains.config.ts',
    },
    {
      id: 'CATEGORY_EXPANSION_POLICIES',
      value: CATEGORY_EXPANSION_POLICIES,
      sourceFile: 'src/config/category-expansion.config.ts',
    },
    {
      id: 'CATEGORY_STEM_MAPPINGS',
      value: CATEGORY_STEM_MAPPINGS,
      sourceFile: 'src/config/category-expansion.config.ts',
    },
    {
      id: 'BROAD_QUERY_PATTERNS',
      value: BROAD_QUERY_PATTERNS,
      sourceFile: 'src/config/category-expansion.config.ts',
    },
    {
      id: 'UNIVERSAL_STOPWORDS',
      value: UNIVERSAL_STOPWORDS,
      sourceFile: 'src/services/business-extractor.service.ts',
    },
    {
      id: 'INDUSTRY_GENERIC_TOKENS',
      value: INDUSTRY_GENERIC_TOKENS,
      sourceFile: 'src/services/business-extractor.service.ts',
    },
    {
      id: 'NEPAL_LOCALITY_TOKENS',
      value: NEPAL_LOCALITY_TOKENS,
      sourceFile: 'src/services/business-extractor.service.ts',
    },
    {
      id: 'CATEGORY_GENERIC_TOKENS',
      value: CATEGORY_GENERIC_TOKENS,
      sourceFile: 'src/services/business-extractor.service.ts',
    },
  ];

  return {
    capturedAt: new Date().toISOString(),
    tables: tables.map(({ id, value, sourceFile }) => ({
      id,
      sourceFile,
      sourceSha256: sha256File(sourceFile),
      tableSha256: hashRaw(value),
      size: tableSize(value),
    })),
  };
}

function writeJsonFile(relativePath: string, value: unknown): void {
  const abs = path.join(REPO_ROOT, relativePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

type StageOutputs = Record<string, unknown>;

interface LockedExpectation {
  capturedAt: string;
  fixture: string;
  fixtureSha256: string;
  stageHashes: Record<string, string>;
  stages: StageOutputs;
}

function main(): void {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const reportIndex = args.indexOf('--report');
  const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : undefined;

  const input = readJson(INPUT_FILE) as ReplayInput;
  const outputBefore = snapshotTree(path.join(REPO_ROOT, OUTPUT_DIR));
  const network = installNetworkGuard();

  let rawOutputs: StageOutputs;
  try {
    rawOutputs = runStages(input);
  } finally {
    network.restore();
  }

  const stages: StageOutputs = {};
  for (const [name, value] of Object.entries(rawOutputs)) stages[name] = canonicalize(value);

  const outputDiff = diffSnapshots(outputBefore, snapshotTree(path.join(REPO_ROOT, OUTPUT_DIR)));
  const staticLock = buildStaticTableLock();
  const lines: string[] = ['# Phase 0.3 — Offline golden replay report', ''];

  if (network.calls.length > 0) lines.push(`NETWORK CALLS ATTEMPTED: ${network.calls.join(', ')}`);
  else lines.push('network guard: 0 fetch calls attempted');
  lines.push(`output isolation: ${outputDiff.identical ? 'output/ unchanged' : 'OUTPUT MUTATED'}`);
  lines.push('');

  if (update) {
    const expectation: LockedExpectation = {
      capturedAt: new Date().toISOString(),
      fixture: INPUT_FILE,
      fixtureSha256: sha256File(INPUT_FILE),
      stageHashes: Object.fromEntries(Object.entries(stages).map(([name, value]) => [name, hashCanonical(value)])),
      stages,
    };
    writeJsonFile(EXPECTED_FILE, expectation);
    writeJsonFile(LOCK_FILE, staticLock);
    lines.push(`locked: ${EXPECTED_FILE}`);
    for (const [name, hash] of Object.entries(expectation.stageHashes)) {
      lines.push(`- ${name}: ${hash}`);
    }
    lines.push(`locked: ${LOCK_FILE} (${staticLock.tables.length} tables)`);
  } else {
    const expected = readJson(EXPECTED_FILE) as LockedExpectation;
    const lockedStatic = readJson(LOCK_FILE) as StaticTableLock;
    let differences = 0;

    for (const [name, value] of Object.entries(stages)) {
      const expectedStage = expected.stages[name];
      const diffs = semanticDiff(expectedStage, value);
      if (diffs.length === 0) {
        lines.push(`PASS ${name} (sha256 ${hashCanonical(value).slice(0, 16)})`);
      } else {
        differences += diffs.length;
        lines.push(`FAIL ${name}:`);
        lines.push(summarizeDiffs(diffs, 10));
      }
    }

    for (const table of staticLock.tables) {
      const locked = lockedStatic.tables.find((entry) => entry.id === table.id);
      const ok = locked !== undefined && locked.tableSha256 === table.tableSha256 && locked.sourceSha256 === table.sourceSha256;
      if (!ok) differences += 1;
      lines.push(
        `${ok ? 'PASS' : 'FAIL'} static-table ${table.id} (${table.size} entries, sha256 ${table.tableSha256.slice(0, 16)})`
      );
    }

    lines.push('');
    lines.push(`fixture sha256: ${sha256File(INPUT_FILE)}`);
    lines.push(`total semantic differences: ${differences}`);

    if (network.calls.length > 0) differences += 1;
    if (!outputDiff.identical) differences += 1;

    if (reportPath) writeJsonFileSafe(reportPath, `${lines.join('\n')}\n`);
    console.log(lines.join('\n'));
    process.exit(differences === 0 ? 0 : 1);
  }

  if (reportPath) writeJsonFileSafe(reportPath, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}

/** Write a text artifact (md/txt) creating parent directories as needed. */
function writeJsonFileSafe(relativePath: string, contents: string): void {
  const abs = path.resolve(REPO_ROOT, relativePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, 'utf8');
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) main();



/** Execute the five pure stages against the frozen fixture. */
function runStages(input: ReplayInput): StageOutputs {
  return {
    buildResearchCandidates: buildResearchCandidates({
      places: input.buildResearchCandidates.places,
      webUsable: input.buildResearchCandidates.webUsable,
      defaultLocation: input.defaultLocation,
    }),
    classifyNepalPhone: input.phoneSamples.map((raw) => ({
      raw,
      classified: classifyNepalPhone(raw),
    })),
    classifySocialProfile: input.socialSamples.map((sample) => ({
      sample,
      classified: classifySocialProfile(
        sample.url,
        undefined,
        sample.businessName,
        sample.websiteDomain,
        undefined,
        sample.origin
      ),
    })),
    sanitizeListingWithEvidence: input.sanitizePairs.map((pair) => ({
      bucket: pair.bucket,
      listing: sanitizeListingWithEvidence(pair.listing, pair.evidence),
    })),
    buildFallbackListing: input.fallbackCases.map((fallbackCase) => ({
      label: fallbackCase.label,
      listing: buildFallbackListing(
        fallbackCase.candidate,
        fallbackCase.extractions,
        fallbackCase.verifiedEvidence,
        fallbackCase.fallbackLocation,
        fallbackCase.runStartedAt
      ),
    })),
  };
}

