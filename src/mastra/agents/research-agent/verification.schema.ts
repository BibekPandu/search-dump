/**
 * Phase 1 (R5 shim): canonical schemas moved to `src/types/verification.ts`.
 * Re-exported here until Phase 9 so `verification.service`,
 * `website-relationship.service`, `business-extractor.service` and existing
 * scripts keep their import path.
 */
export {
  phoneEvidenceSchema,
  websitePageEvidenceSchema,
  websiteEvidenceSchema,
  verificationChecksSchema,
  verificationResultSchema,
  confidenceBreakdownSchema,
  websiteRelationshipEnum,
  websiteLifecycleEnum,
  sourceHealthEnum,
  verifiedBusinessEvidenceSchema,
  type ConfidenceBreakdownSchema,
  type WebsiteRelationship,
  type WebsiteLifecycle,
  type SourceHealth,
  type WebsitePageEvidence,
  type WebsiteEvidence,
  type VerificationChecks,
  type VerificationResult,
  type VerifiedBusinessEvidence,
  type PhoneEvidenceRecord,
} from '@/types/verification.js';
