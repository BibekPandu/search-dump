import { z } from 'zod';
import { unifiedSearchResultSchema } from '../../../services/search-fallback.service';

export const candidateTypeEnum = z.enum([
  'business',
  'aggregator',
  'directory',
  'article',
  'social',
  'irrelevant',
]);

export const stoppedReasonEnum = z.enum([
  'target_reached',
  'no_more_pages',
  'no_new_results',
  'max_pages_reached',
  'no_usable_results',
]);

export const researchDecisionSchema = z.object({
  url: z.string(),
  domain: z.string(),
  title: z.string(),
  classification: candidateTypeEnum,
  confidence: z.number(),
  reason: z.string(),
  source: z.enum(['deterministic', 'llm']),
});

export const excludedSummaryItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  domain: z.string(),
  classification: candidateTypeEnum,
  reason: z.string(),
});

export const researchCandidateSchema = z.object({
  name: z.string(),
  location: z.string().default(''),
  website: z.string().default(''),
  phone: z.string().default(''),
  coordinates: z
    .object({
      lat: z.number().optional(),
      lng: z.number().optional(),
    })
    .optional(),
  rating: z.number().optional(),
  ratingCount: z.number().optional(),
  category: z.string().optional(),
  // Safeguard 1: Lean source provenance only, no raw provider blobs
  sources: z.object({
    googleMaps: z
      .object({
        found: z.boolean(),
        placeId: z.string().optional(),
        address: z.string().optional(),
        phone: z.string().optional(),
        website: z.string().optional(),
      })
      .optional(),
    webSearch: z
      .array(
        z.object({
          title: z.string(),
          url: z.string(),
          domain: z.string(),
          snippet: z.string(),
          provider: z.string().optional(),
        })
      )
      .default([]),
  }),
  entityMatch: z
    .object({
      matched: z.boolean(),
      confidence: z.number(),
      method: z.enum(['phone', 'domain', 'name_address', 'none']),
      reason: z.string().optional(),
    })
    .default({ matched: false, confidence: 0, method: 'none' }),
  classification: z
    .object({
      status: z.enum(['usable', 'excluded', 'ambiguous']).default('usable'),
      type: z.string().default('business'),
      confidence: z.number().default(0.5),
      reason: z.string().default(''),
    })
    .optional(),
});

export const discoveryMetricsSchema = z.object({
  categoryIntent: z.string(),
  isBroadQuery: z.boolean(),
  queriesGenerated: z.number(),
  expandedQueriesGenerated: z.number(),
  rawCandidates: z.number(),
  exactQueryCandidates: z.number(),
  expandedQueryCandidates: z.number(),
  relevantCandidates: z.number(),
  irrelevantCandidates: z.number(),
  ambiguousCandidates: z.number(),
  uniqueEntities: z.number(),
});

export const researchReportSchema = z.object({
  query: z.string(),
  location: z.string().optional(),
  pagesSearched: z.number(),
  targetCandidates: z.number(),
  candidatesFound: z.number(),
  usableCount: z.number(),
  excludedCount: z.number(),
  ambiguousCount: z.number(),
  stoppedReason: stoppedReasonEnum,
  candidates: z.array(unifiedSearchResultSchema),
  excludedSummary: z.array(excludedSummaryItemSchema),
  decisions: z.array(researchDecisionSchema),
  // Additive fields for Tier 2 representation (Task 5)
  uniqueBusinessesFound: z.number().optional(),
  matchesMerged: z.number().optional(),
  researchCandidates: z.array(researchCandidateSchema).optional(),
  discoveryMetrics: discoveryMetricsSchema.optional(),
});

export type CandidateType = z.infer<typeof candidateTypeEnum>;
export type StoppedReason = z.infer<typeof stoppedReasonEnum>;
export type ResearchDecision = z.infer<typeof researchDecisionSchema>;
export type ExcludedSummaryItem = z.infer<typeof excludedSummaryItemSchema>;
export type ResearchCandidate = z.infer<typeof researchCandidateSchema>;
export type DiscoveryMetrics = z.infer<typeof discoveryMetricsSchema>;
export type ResearchReport = z.infer<typeof researchReportSchema>;
