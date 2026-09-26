/**
 * Phase 1 (R5 shim): canonical schemas moved to `src/types/research-candidate.ts`.
 * Re-exported here until Phase 9 so `candidate-classifier.service`,
 * `candidate-validation.service`, `research-candidate.service`,
 * `maps-discovery.service`, `verification.service` and existing scripts keep
 * their import path.
 */
export {
  candidateTypeEnum,
  stoppedReasonEnum,
  researchDecisionSchema,
  excludedSummaryItemSchema,
  discoveryProvenanceSchema,
  researchCandidateSchema,
  discoveryMetricsSchema,
  researchReportSchema,
  type CandidateType,
  type StoppedReason,
  type ResearchDecision,
  type ExcludedSummaryItem,
  type DiscoveryProvenance,
  type ResearchCandidate,
  type DiscoveryMetrics,
  type ResearchReport,
} from '@/types/research-candidate.js';
