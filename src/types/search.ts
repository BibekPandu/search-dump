import { z } from 'zod';
import { discoveryProvenanceSchema, discoveryStateEnum } from './discovery-state.js';

// ============================================================================
// Single Source of Truth Zod Schemas & Inferred Types
// ============================================================================

export const unifiedSearchResultSchema = z.object({
  /** 1-based position in the final deduplicated list. Dense & page-offset (e.g. Page 2 = 11-20 for numResults=10). */
  rank: z.number().default(0),
  title: z.string(),
  /** Normalized URL (tracking params stripped, www. stripped, hash stripped, params sorted). Dedupe key + downstream URL. */
  url: z.string(),
  /** Raw URL exactly as returned by upstream provider. Internal evidence/debugging only — never render to LLM prompts. */
  originalUrl: z.string().default(''),
  /** Hostname lowercased with leading "www." stripped (e.g. "himalayanjava.com"). Empty string if unparseable. */
  domain: z.string().default(''),
  description: z.string(),
  extraSnippets: z.array(z.string()),
  /** Upstream provider that produced this result: 'serper' | 'duckduckgo' | 'serper_places'. */
  provider: z.string(),
  /** Optional Google Maps location metadata */
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  phoneNumber: z.string().optional(),
  address: z.string().optional(),
  rating: z.number().optional(),
  ratingCount: z.number().optional(),
  placeId: z.string().optional(),
  source: z.string().optional(),
  businessType: z.string().optional(),
  discoveryState: discoveryStateEnum.optional(),
  discoveryProvenance: discoveryProvenanceSchema.optional(),
});

export const searchMetadataSchema = z.object({
  /** Head of the fallback chain. Always 'serper' today. */
  requestedProvider: z.string(),
  /** Provider whose results were returned; 'none' if all failed; 'error' on catastrophic exception. */
  actualProvider: z.string(),
  /** True when primary provider did not produce the final results. */
  fallbackUsed: z.boolean(),
  /** Why fallback occurred. null when primary succeeded. */
  fallbackReason: z.string().nullable(),
  /** Every provider attempted in order, including failed or zero-result attempts. */
  attemptedProviders: z.array(z.string()),
  /** Wall-clock ms for the whole searchWithFallback call. */
  latencyMs: z.number(),
  /** Wall-clock ms per provider attempt, failures included. Captured at the provider call site. */
  providerLatencyMs: z.record(z.string(), z.number()),
  /** Raw results dropped by URL deduplication. */
  duplicatesRemoved: z.number(),
  /** provider -> 'config' | 'timeout' | 'http_4xx' | 'http_5xx' | 'network' | 'parse' | 'pagination_unsupported' | 'unknown'. */
  errorClassifications: z.record(z.string(), z.string()),
  /** ISO timestamp when the search was executed. */
  searchedAt: z.string(),
});

export const searchResponseSchema = z.object({
  /** Base query passed by caller. */
  query: z.string(),
  /** Optional location constraint passed by caller. */
  location: z.string().optional(),
  /** The exact query string executed (location appended when missing). */
  queryUsed: z.string(),
  /** Requested page number (1-based). */
  page: z.number(),
  /** Equal to results.length; kept top-level for easy access. */
  resultsCount: z.number(),
  /** Pagination metadata. hasNextPage is provider-confirmed where supported, otherwise a bounded heuristic. */
  pagination: z.object({
    currentPage: z.number(),
    hasNextPage: z.boolean(),
    nextPage: z.number().nullable(),
  }),
  searchMetadata: searchMetadataSchema,
  results: z.array(unifiedSearchResultSchema),
});

export type UnifiedSearchResult = z.infer<typeof unifiedSearchResultSchema>;
export type SearchMetadata = z.infer<typeof searchMetadataSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
