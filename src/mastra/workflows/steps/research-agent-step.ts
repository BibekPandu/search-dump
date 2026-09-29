/**
 * Step 1 — discovery / cache decision.
 *
 * Serves a stored snapshot when one is fresh, otherwise runs discovery.
 * Emits the cache-passthrough fields every later step carries forward.
 */

import { createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  beginRun,
  logRunStep,
  startTimer
} from '@/services/observability/run-log.service';
import {
  researchReportSchema,
  researchCandidateSchema
} from '@/mastra/agents/research-agent/schema';
import {
  buildCacheKeys,
  getLastMongoState,
  lookupFreshRun
} from '@/services/storage/mongo.service';
import { describeLookupMaxAgeDays } from '@/config/freshness.config';

import {
  candidateSchema,
  cachePassthroughSchema
} from '@/mastra/workflows/workflow-contracts';

import { runResearchDiscovery } from '@/services/discovery/research-discovery.service';
export { runResearchDiscovery };

export const researchAgentStep = createStep({
  id: 'research-agent-step',
  inputSchema: z.object({
    query: z.string(),
    /**
     * Run locality. REQUIRED in practice: the canonical identity is
     * `name:<nameKey>|<locationKey>`, and an empty location yields the
     * `unknown-location` suffix, which creates duplicate identities instead
     * of overwriting existing records. Non-empty after trim.
     */
    location: z.string().min(1, 'location must be a non-empty locality').trim(),
    autoApprove: z.boolean().default(true),
    agentId: z.string().optional(),
    targetCandidates: z.number().optional(),
    maxMapsPages: z.number().optional(),
    maxPages: z.number().optional(),
    websiteDiscoveryMode: z.enum(['production', 'benchmark']).optional(),
    maxWebsiteDiscoveryLookups: z.number().optional(),
    // Phase 2 passthrough: Tavily deep-verification cap (consumed by Step 2).
    maxDeepVerifyCandidates: z.number().optional(),
    // M1 cache control (declared here or Zod strips them at the step boundary).
    refresh: z.boolean().optional(),
    maxCacheAgeDays: z.number().optional(),
  }),
  outputSchema: z.object({
    candidates: z.array(candidateSchema),
    researchCandidates: z.array(researchCandidateSchema),
    query: z.string(),
    location: z.string().optional(),
    autoApprove: z.boolean().default(true),
    agentId: z.string().optional(),
    researchReport: researchReportSchema.optional(),
    maxDeepVerifyCandidates: z.number().optional(),
    ...cachePassthroughSchema,
  }),
  execute: async ({ inputData, mastra }) => {
    const runId = beginRun();
    const elapsed = startTimer();
    // ------------------------------------------------------------------
    // M1 cache-first guard (Step 1).
    // Same (query, location) inside the freshness window → serve the stored
    // snapshot and skip ALL three cost centres: Maps/web discovery, Tavily
    // extraction, and supervisor synthesis.
    // ------------------------------------------------------------------
    const refreshRequested = Boolean(inputData.refresh);
    const policy = describeLookupMaxAgeDays(inputData.query);
    const maxCacheAgeDays =
      typeof inputData.maxCacheAgeDays === 'number' && inputData.maxCacheAgeDays >= 0
        ? inputData.maxCacheAgeDays
        : policy.days;

    if (refreshRequested) {
      console.log('[cache] bypass — refresh: true (full pipeline re-run requested)');
    } else if (inputData.query) {
      const keys = buildCacheKeys(inputData.query, inputData.location);
      console.log(
        `[cache] lookup — {${keys.queryKey} | ${keys.locationKey || '-'}} within ${maxCacheAgeDays}d (${policy.source})`
      );
      const hit = await lookupFreshRun(inputData.query, inputData.location, maxCacheAgeDays);
      if (hit) {
        logRunStep(runId, 1, 'ok', elapsed(), {
          cache: 'hit',
          candidates: 0,
          listings: hit.listings.length,
          sourceRunId: hit.runId,
        });
        return {
          candidates: [],
          researchCandidates: [],
          query: inputData.query,
          location: inputData.location,
          autoApprove: inputData.autoApprove,
          agentId: inputData.agentId,
          researchReport: undefined,
          maxDeepVerifyCandidates: inputData.maxDeepVerifyCandidates,
          fromCache: true as const,
          cachedListings: hit.listings,
          cacheLookupStatus: 'hit' as const,
          cachePolicyDays: maxCacheAgeDays,
          cacheSourceRunId: hit.runId,
          refreshRequested: false,
          runConfig: {
            maxMapsPages: inputData.maxMapsPages,
            maxPages: inputData.maxPages,
            websiteDiscoveryMode: inputData.websiteDiscoveryMode,
            maxWebsiteDiscoveryLookups: inputData.maxWebsiteDiscoveryLookups,
            targetCandidates: inputData.targetCandidates,
            maxCacheAgeDays,
          },
        };
      }
    }

    const result = await runResearchDiscovery(inputData, mastra);
    const cacheStatus =
      refreshRequested || getLastMongoState() === 'connected'
        ? ('miss' as const)
        : ('skipped_mongo_down' as const);
    logRunStep(runId, 1, 'ok', elapsed(), {
      cache: cacheStatus,
      candidates: result.candidates?.length ?? 0,
      researchCandidates: result.researchCandidates?.length ?? 0,
      mongo: getLastMongoState(),
    });
    return {
      ...result,
      maxDeepVerifyCandidates: inputData.maxDeepVerifyCandidates,
      fromCache: false,
      // FIX-3: a miss because the store was unreachable is NOT the same as a
      // miss because nothing fresh was stored — never conflate them.
      cacheLookupStatus: cacheStatus,
      cachePolicyDays: maxCacheAgeDays,
      refreshRequested,
      runConfig: {
        maxMapsPages: inputData.maxMapsPages,
        maxPages: inputData.maxPages,
        websiteDiscoveryMode: inputData.websiteDiscoveryMode,
        maxWebsiteDiscoveryLookups: inputData.maxWebsiteDiscoveryLookups,
        targetCandidates: inputData.targetCandidates,
        maxCacheAgeDays,
      },
    };
  },
});

// Backward compatibility export
export const broadDiscoveryStep = researchAgentStep;
