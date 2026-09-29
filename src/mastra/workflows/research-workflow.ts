import { createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { researchReportSchema } from '@/mastra/agents/research-agent/schema';
import { verifiedBusinessEvidenceSchema } from '@/mastra/agents/research-agent/verification.schema';

// Phase 1 (R5 shim): canonical domain contracts imported from the type layer.
// Consumers may use the `@/types` barrel; the type modules themselves import
// sibling contracts directly (never through the barrel).
import {
  businessListingSchema,
  ledgerStatusEnum,
  type BusinessListing,
  type LedgerStatus,
  type RunResearchDiscoveryInput,
} from '@/types/index.js';
import { researchAgentStep, broadDiscoveryStep } from '@/mastra/workflows/steps/research-agent-step';
import { humanReviewStep } from '@/mastra/workflows/steps/human-review-step';
import { deepExtractionStep } from '@/mastra/workflows/steps/deep-extraction-step';
import { supervisorSynthesisStep } from '@/mastra/workflows/steps/supervisor-synthesis-step';

// Phase 1 (R5 shim): re-exported for backward compatibility until Phase 9.
export {
  businessListingSchema,
  ledgerStatusEnum,
  type BusinessListing,
  type LedgerStatus,
  type RunResearchDiscoveryInput,
};

import { runResearchDiscovery } from '@/services/discovery/research-discovery.service';
export { runResearchDiscovery };
import { buildSupervisorPrompt } from './research-prompts';
export { buildSupervisorPrompt };

import {
  buildCandidateLedgerId,
  candidateMatchesListing,
} from '@/services/storage/candidate-ledger.service';
export { buildCandidateLedgerId, candidateMatchesListing };

import { buildFallbackListing } from '@/services/resolution/fallback-listing.service';
export { buildFallbackListing };

import {
  applyTargetCandidatesCap,
  normalizeListingPhones,
} from '@/services/resolution/cascade-policy.service';
export { applyTargetCandidatesCap, normalizeListingPhones };

import {
  matchListingToEvidence,
  sanitizeListingWithEvidence,
} from '@/services/resolution/listing-sanitizer.service';
export { matchListingToEvidence, sanitizeListingWithEvidence };

export {
  researchAgentStep,
  broadDiscoveryStep,
  humanReviewStep,
  deepExtractionStep,
  supervisorSynthesisStep,
};

export const researchWorkflow = createWorkflow({
  id: 'research-workflow',
  inputSchema: z.object({
    query: z.string().describe('The search query (e.g. "hotels in Kathmandu")'),
    location: z
      .string()
      .min(1, 'location must be a non-empty locality')
      .trim()
      .describe('Run locality. Required: an empty value writes unknown-location identity keys.'),
    autoApprove: z.boolean().default(true).describe('Skip human review step for headless execution'),
    agentId: z.string().optional().default('gemma-supervisor-agent').describe('Agent to use for synthesis'),
    targetCandidates: z.number().optional().describe('Target number of usable candidates'),
    maxMapsPages: z.number().optional().describe('Maximum Google Maps pages to query (default 5)'),
    maxPages: z.number().optional().describe('Maximum search pages to query'),
    websiteDiscoveryMode: z
      .enum(['production', 'benchmark'])
      .optional()
      .describe('Website discovery budget mode: benchmark = all eligible (hard-capped per run), production = 10 per run (default)'),
    maxWebsiteDiscoveryLookups: z
      .number()
      .optional()
      .describe('Explicit per-run website discovery lookup budget (clamped by the hard ceiling; independent of targetCandidates)'),
    maxDeepVerifyCandidates: z
      .number()
      .optional()
      .describe('Maximum candidates to deep-verify with Tavily (defaults to max(targetCandidates, 10) or 10)'),
    refresh: z
      .boolean()
      .optional()
      .describe('M1: bypass the cache for this run (force a full pipeline re-run, then replace the stored snapshot)'),
    maxCacheAgeDays: z
      .number()
      .optional()
      .describe('M1: freshness window in days for the cache-first guard (input > env CACHE_MAX_AGE_DAYS > category policy > 30)'),
  }),
  outputSchema: z.object({
    listings: z.array(businessListingSchema),
    researchReport: researchReportSchema.optional(),
    verifiedEvidence: z.array(verifiedBusinessEvidenceSchema).optional(),
  }),
})
  .then(researchAgentStep)
  .then(humanReviewStep)
  .then(deepExtractionStep)
  .then(supervisorSynthesisStep)
  .commit();