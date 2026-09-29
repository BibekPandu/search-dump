/**
 * Step-boundary contracts shared by every research-workflow step.
 *
 * Zod strips undeclared fields between steps, so the cache-passthrough
 * fragment and the candidate/extraction schemas must be declared in a
 * module every step imports — never copied per step, where they would
 * drift apart.
 */

import { z } from 'zod';
import { unifiedSearchResultSchema } from '@/services/discovery/search-fallback.service';
import {
  type RunInputConfig
} from '@/services/storage/mongo.service';

// Phase 1 (R5 shim): canonical domain contracts imported from the type layer.
// Consumers may use the `@/types` barrel; the type modules themselves import
// sibling contracts directly (never through the barrel).
import {
  businessListingSchema,
  type BusinessListing
} from '@/types/index.js';

export const candidateSchema = unifiedSearchResultSchema;

export const extractionSchema = z.object({
  url: z.string(),
  content: z.string(),
  favicon: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

/**
 * M1 cache passthrough fragment.
 *
 * Zod objects strip undeclared fields between workflow steps, so every field that
 * must survive from Step 1 (cache decision) to Step 4 (artifacts + run record) is
 * declared in EACH intermediate step's input AND output schema by spreading this
 * fragment. No chain restructuring, no branching API.
 */
export const cachePassthroughSchema = {
  /** True when Step 1 served a stored snapshot instead of running discovery. */
  fromCache: z.boolean().optional(),
  /** Frozen snapshot payload carried to Step 4 on a cache hit. */
  cachedListings: z.array(businessListingSchema).optional(),
  /** Diagnostic: 'hit' | 'miss' | 'skipped_mongo_down' (never conflated). */
  cacheLookupStatus: z.enum(['hit', 'miss', 'skipped_mongo_down']).optional(),
  /** Freshness window in force for this run (days). */
  cachePolicyDays: z.number().optional(),
  /** Run id whose snapshot was served (cache hits only). */
  cacheSourceRunId: z.string().optional(),
  /** True when the caller explicitly bypassed the cache with refresh: true. */
  refreshRequested: z.boolean().optional(),
  /**
   * Run configuration carried through for the runs-history record
   * (reproducibility: which knobs produced / requested this snapshot).
   */
  runConfig: z
    .object({
      maxMapsPages: z.number().optional(),
      maxPages: z.number().optional(),
      websiteDiscoveryMode: z.string().optional(),
      maxWebsiteDiscoveryLookups: z.number().optional(),
      targetCandidates: z.number().optional(),
    })
    .optional(),
};

export type CachePassthroughFields = {
  fromCache?: boolean;
  cachedListings?: BusinessListing[];
  cacheLookupStatus?: 'hit' | 'miss' | 'skipped_mongo_down';
  cachePolicyDays?: number;
  cacheSourceRunId?: string;
  refreshRequested?: boolean;
  runConfig?: RunInputConfig;
};

/** Copies the cache-passthrough fields from one step's input to its output. */
export function takeCachePassthrough(input: unknown): CachePassthroughFields {
  const source = (input ?? {}) as CachePassthroughFields;
  return {
    fromCache: source.fromCache,
    cachedListings: source.cachedListings,
    cacheLookupStatus: source.cacheLookupStatus,
    cachePolicyDays: source.cachePolicyDays,
    cacheSourceRunId: source.cacheSourceRunId,
    refreshRequested: source.refreshRequested,
    runConfig: source.runConfig,
  };
}
