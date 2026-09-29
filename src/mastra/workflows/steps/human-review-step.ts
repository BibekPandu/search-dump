/**
 * Step 2 — human review gate (no-op under autoApprove).
 */

import { createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  getCurrentRunId,
  logRunStep,
  startTimer
} from '@/services/observability/run-log.service';
import {
  researchReportSchema,
  researchCandidateSchema
} from '@/mastra/agents/research-agent/schema';

import {
  candidateSchema,
  cachePassthroughSchema,
  takeCachePassthrough
} from '@/mastra/workflows/workflow-contracts';

export const humanReviewStep = createStep({
  id: 'human-review-step',
  inputSchema: z.object({
    candidates: z.array(candidateSchema),
    researchCandidates: z.array(researchCandidateSchema).optional(),
    query: z.string(),
    location: z.string().optional(),
    autoApprove: z.boolean().default(true),
    agentId: z.string().optional(),
    researchReport: researchReportSchema.optional(),
    maxDeepVerifyCandidates: z.number().optional(),
    ...cachePassthroughSchema,
  }),
  outputSchema: z.object({
    candidates: z.array(candidateSchema),
    researchCandidates: z.array(researchCandidateSchema).optional(),
    query: z.string(),
    location: z.string().optional(),
    autoApprove: z.boolean().default(true),
    agentId: z.string().optional(),
    researchReport: researchReportSchema.optional(),
    maxDeepVerifyCandidates: z.number().optional(),
    ...cachePassthroughSchema,
  }),
  execute: async ({ inputData, suspend, resumeData }) => {
    const runId = getCurrentRunId();
    const elapsed = startTimer();
    // M1: a cache hit carries no candidates to review — never suspend for one.
    if (inputData.fromCache) {
      console.log('[Workflow:HITL] Cache hit — skipping human review step (no discovery happened)');
      logRunStep(runId, 2, 'skipped', elapsed(), { reason: 'cache_hit', candidates: 0 });
      return {
        candidates: inputData.candidates,
        researchCandidates: inputData.researchCandidates,
        query: inputData.query,
        location: inputData.location,
        autoApprove: inputData.autoApprove,
        agentId: inputData.agentId,
        researchReport: inputData.researchReport,
        maxDeepVerifyCandidates: inputData.maxDeepVerifyCandidates,
        ...takeCachePassthrough(inputData),
      };
    }

    if (inputData.autoApprove) {
      console.log(`[Workflow:HITL] Auto-approved ${inputData.candidates.length} candidates (headless mode)`);
      logRunStep(runId, 2, 'ok', elapsed(), {
        mode: 'auto_approved',
        candidates: inputData.candidates.length,
      });
      return {
        candidates: inputData.candidates,
        researchCandidates: inputData.researchCandidates,
        query: inputData.query,
        location: inputData.location,
        autoApprove: inputData.autoApprove,
        agentId: inputData.agentId,
        researchReport: inputData.researchReport,
        maxDeepVerifyCandidates: inputData.maxDeepVerifyCandidates,
        ...takeCachePassthrough(inputData),
      };
    }

    if (!resumeData) {
      console.log(`[Workflow:HITL] Pausing for human review of ${inputData.candidates.length} candidates`);
      return (await suspend({
        message: 'Please review and approve the discovered URLs before scraping.',
        foundCount: inputData.candidates.length,
        candidates: inputData.candidates.slice(0, 5).map((c) => ({
          title: c.title,
          url: c.url,
        })),
      })) as any;
    }

    const data = resumeData as { approved?: boolean; filteredUrls?: string[] };
    if (data.approved === false) {
      throw new Error('Pipeline was halted by user review.');
    }

    let approvedCandidates = inputData.candidates;
    if (Array.isArray(data.filteredUrls) && data.filteredUrls.length > 0) {
      approvedCandidates = inputData.candidates.filter((c) =>
        data.filteredUrls!.includes(c.url)
      );
    }

    console.log(`[Workflow:HITL] Resumed with ${approvedCandidates.length} approved candidates`);
    logRunStep(runId, 2, 'ok', elapsed(), {
      mode: 'resumed',
      candidates: approvedCandidates.length,
      filtered: inputData.candidates.length - approvedCandidates.length,
    });

    return {
      candidates: approvedCandidates,
      researchCandidates: inputData.researchCandidates,
      query: inputData.query,
      location: inputData.location,
      autoApprove: inputData.autoApprove,
      agentId: inputData.agentId,
      researchReport: inputData.researchReport,
      maxDeepVerifyCandidates: inputData.maxDeepVerifyCandidates,
      ...takeCachePassthrough(inputData),
    };
  },
});
