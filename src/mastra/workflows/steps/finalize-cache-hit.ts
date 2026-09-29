/**
 * M1 cache-hit finalization (used by supervisor-synthesis-step).
 *
 * Owns the artifact + run-record writes for a served snapshot.
 */

import {
  saveStageOutput,
  saveSummaryReport,
  endRunSession
} from '@/services/storage/output-storage.service';
import { getApiCallCounters } from '@/services/observability/run-log.service';
import {
  type ResearchReport
} from '@/mastra/agents/research-agent/schema';
import {
  getMongoHealth,
  saveRunRecord,
  type RunInputConfig
} from '@/services/storage/mongo.service';
import {
  type VerifiedBusinessEvidence
} from '@/mastra/agents/research-agent/verification.schema';

import {
  type BusinessListing
} from '@/types/index.js';

/**
 * M1 cache-hit finalization.
 *
 * Writes this run's artifacts from the frozen snapshot and appends a 'cache-hit'
 * run record so "this query was served from cache N times" stays answerable.
 *
 * Deliberately does NOT call upsertBusinesses: nothing was re-verified on a cache
 * hit, so lastVerifiedAt must never claim verification that never happened.
 */
export async function finalizeCacheHit(params: {
  listings: BusinessListing[];
  query: string;
  location?: string;
  runId: string;
  sourceRunId?: string;
  cachePolicyDays?: number;
  runConfig?: RunInputConfig;
  researchReport?: ResearchReport;
  verifiedEvidence?: VerifiedBusinessEvidence[];
}): Promise<{
  listings: BusinessListing[];
  researchReport?: ResearchReport;
  verifiedEvidence?: VerifiedBusinessEvidence[];
}> {
  const { listings, query, location, runId, sourceRunId } = params;
  const completedAt = new Date();

  console.log(
    `[Workflow:Step3] Cache hit — serving ${listings.length} listing(s) from run ${sourceRunId ?? 'unknown'} (0 LLM calls, 0 search calls)`
  );

  saveStageOutput('final-listings', '3-final-listings.json', listings, query);
  saveStageOutput('results', 'results.json', listings, query);

  saveSummaryReport({
    query,
    location,
    totalBusinesses: listings.length,
    conflictsDetected: 0,
    sources: { googleMaps: 0, webSearch: 0, officialWebsitesCrawled: 0 },
    contactsFound: {
      withPhone: listings.filter(
        (l) => (l.phones?.length ?? 0) > 0 || (l.mobiles?.length ?? 0) > 0
      ).length,
      withEmail: listings.filter((l) => (l.emails?.length ?? 0) > 0).length,
      withWebsite: listings.filter((l) => (l.websites?.length ?? 0) > 0).length,
      withSocialLinks: listings.filter((l) => {
        const s = l.socialLinks;
        return Boolean(
          s && (s.facebook || s.tiktok || s.instagram || (s.other && Object.keys(s.other).length > 0))
        );
      }).length,
    },
    status: listings.length > 0 ? 'success' : 'empty',
    synthesisMethod: 'Cache hit — served from stored runs snapshot (no synthesis executed)',
    cacheLookupStatus: 'hit',
    telemetry: {
      /** Cache-hit runs must show zero outbound spend — this is the proof. */
      apiCallCounters: getApiCallCounters(),
      mongoHealth: getMongoHealth(),
    },
    notes: [
      sourceRunId ? `Served from run ${sourceRunId}` : 'Served from stored snapshot',
      `Freshness window: ${params.cachePolicyDays ?? 'default'}d`,
      'No API calls made: discovery, extraction and synthesis were all skipped',
    ],
  });

  await saveRunRecord({
    runId,
    query,
    location,
    status: 'cache-hit',
    listings,
    servedFromCache: true,
    refreshRequested: false,
    inputConfig: { ...(params.runConfig ?? {}), maxCacheAgeDays: params.cachePolicyDays },
    completedAt,
  });

  endRunSession();

  console.log(`\n================ CACHED LISTINGS (${listings.length}) ================`);
  console.log(JSON.stringify(listings, null, 2));
  console.log('=========================================================\n');

  return {
    listings,
    researchReport: params.researchReport,
    verifiedEvidence: params.verifiedEvidence,
  };
}
