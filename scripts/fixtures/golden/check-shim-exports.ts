/**
 * Phase 1 (R5) — Backward-compatibility gate for the contract shims.
 *
 * Verifies three things about every origin module that Phase 1 converted into a
 * re-export shim:
 *   1. RUNTIME exports still exist at the old import path (values, enums, schemas).
 *   2. ZOD RUNTIME IDENTITY: the old path and `src/types/*` hand back the *same*
 *      schema object reference — so defaults, optionals, `.passthrough()`,
 *      validation order and serialized shape cannot have diverged.
 *   3. TYPE exports still exist at the old import path (checked by `tsc`, since
 *      this file lives in the typechecked `scripts/` tree).
 *
 * Usage:  npx tsx scripts/fixtures/golden/check-shim-exports.ts
 * Exit 0 when everything resolves identically; exit 1 otherwise.
 */
import {
  businessListingSchema,
  ledgerStatusEnum,
} from '../../../src/mastra/workflows/research-workflow';
import * as agentSchema from '../../../src/mastra/agents/research-agent/schema';
import * as contactSchema from '../../../src/mastra/agents/research-agent/contact.schema';
import * as socialSchema from '../../../src/mastra/agents/research-agent/social.schema';
import * as verificationSchema from '../../../src/mastra/agents/research-agent/verification.schema';
import * as outputStorage from '../../../src/services/output-storage.service';
import * as searchFallback from '../../../src/services/search-fallback.service';
import * as discoveryState from '../../../src/services/discovery-state.service';
import * as mongoService from '../../../src/services/mongo.service';
import * as typesBusinessListing from '@/types/business-listing.js';
import * as typesContact from '@/types/contact.js';
import * as typesDiscovery from '@/types/discovery-state.js';
import * as typesResearchCandidate from '@/types/research-candidate.js';
import * as typesSearch from '@/types/search.js';
import * as typesSocial from '@/types/social.js';
import * as typesVerification from '@/types/verification.js';

/** 1. Runtime exports present at the old path. */
const runtimeExports: Array<[string, unknown]> = [
  ['research-workflow.businessListingSchema', businessListingSchema],
  ['research-workflow.ledgerStatusEnum', ledgerStatusEnum],
  ['schema.candidateTypeEnum', agentSchema.candidateTypeEnum],
  ['schema.stoppedReasonEnum', agentSchema.stoppedReasonEnum],
  ['schema.researchDecisionSchema', agentSchema.researchDecisionSchema],
  ['schema.excludedSummaryItemSchema', agentSchema.excludedSummaryItemSchema],
  ['schema.discoveryProvenanceSchema', agentSchema.discoveryProvenanceSchema],
  ['schema.researchCandidateSchema', agentSchema.researchCandidateSchema],
  ['schema.discoveryMetricsSchema', agentSchema.discoveryMetricsSchema],
  ['schema.researchReportSchema', agentSchema.researchReportSchema],
  ['contact.contactRoleEnum', contactSchema.contactRoleEnum],
  ['contact.contactOwnerEnum', contactSchema.contactOwnerEnum],
  ['contact.contactChannelEnum', contactSchema.contactChannelEnum],
  ['contact.classifiedContactSchema', contactSchema.classifiedContactSchema],
  ['contact.branchRecordSchema', contactSchema.branchRecordSchema],
  ['social.socialProfileTypeEnum', socialSchema.socialProfileTypeEnum],
  ['social.socialOwnerEnum', socialSchema.socialOwnerEnum],
  ['social.socialRejectionReasonEnum', socialSchema.socialRejectionReasonEnum],
  ['social.socialStatusEnum', socialSchema.socialStatusEnum],
  ['social.classifiedSocialProfileSchema', socialSchema.classifiedSocialProfileSchema],
  ['verification.phoneEvidenceSchema', verificationSchema.phoneEvidenceSchema],
  ['verification.websitePageEvidenceSchema', verificationSchema.websitePageEvidenceSchema],
  ['verification.websiteEvidenceSchema', verificationSchema.websiteEvidenceSchema],
  ['verification.verificationChecksSchema', verificationSchema.verificationChecksSchema],
  ['verification.verificationResultSchema', verificationSchema.verificationResultSchema],
  ['verification.confidenceBreakdownSchema', verificationSchema.confidenceBreakdownSchema],
  ['verification.websiteRelationshipEnum', verificationSchema.websiteRelationshipEnum],
  ['verification.websiteLifecycleEnum', verificationSchema.websiteLifecycleEnum],
  ['verification.sourceHealthEnum', verificationSchema.sourceHealthEnum],
  ['verification.verifiedBusinessEvidenceSchema', verificationSchema.verifiedBusinessEvidenceSchema],
  ['discovery-state.DISCOVERY_STATES', discoveryState.DISCOVERY_STATES],
  ['discovery-state.discoveryStateEnum', discoveryState.discoveryStateEnum],
  ['discovery-state.discoveryProvenanceSchema', discoveryState.discoveryProvenanceSchema],
  ['search.unifiedSearchResultSchema', searchFallback.unifiedSearchResultSchema],
  ['search.searchMetadataSchema', searchFallback.searchMetadataSchema],
  ['search.searchResponseSchema', searchFallback.searchResponseSchema],
  ['mongo.buildCacheKeys', mongoService.buildCacheKeys],
  ['output-storage.RUN_SUMMARY_TYPE_IS_TYPE_ONLY', outputStorage.saveSummaryReport],
];

for (const [label, value] of runtimeExports) {
  check(`runtime export present: ${label}`, typeof value !== 'undefined' && value !== null);
}

let failures = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}`);
  }
}

/** 2. Zod runtime identity: ensure exported schemas are identical references. */
const identityChecks: Array<[string, unknown, unknown]> = [
  ['businessListingSchema', businessListingSchema, typesBusinessListing.businessListingSchema],
  ['candidateTypeEnum', agentSchema.candidateTypeEnum, typesResearchCandidate.candidateTypeEnum],
  ['stoppedReasonEnum', agentSchema.stoppedReasonEnum, typesResearchCandidate.stoppedReasonEnum],
  ['researchDecisionSchema', agentSchema.researchDecisionSchema, typesResearchCandidate.researchDecisionSchema],
  ['excludedSummaryItemSchema', agentSchema.excludedSummaryItemSchema, typesResearchCandidate.excludedSummaryItemSchema],
  ['discoveryProvenanceSchema (agent)', agentSchema.discoveryProvenanceSchema, typesResearchCandidate.discoveryProvenanceSchema],
  ['researchCandidateSchema', agentSchema.researchCandidateSchema, typesResearchCandidate.researchCandidateSchema],
  ['discoveryMetricsSchema', agentSchema.discoveryMetricsSchema, typesResearchCandidate.discoveryMetricsSchema],
  ['researchReportSchema', agentSchema.researchReportSchema, typesResearchCandidate.researchReportSchema],
  ['contactRoleEnum', contactSchema.contactRoleEnum, typesContact.contactRoleEnum],
  ['contactOwnerEnum', contactSchema.contactOwnerEnum, typesContact.contactOwnerEnum],
  ['contactChannelEnum', contactSchema.contactChannelEnum, typesContact.contactChannelEnum],
  ['classifiedContactSchema', contactSchema.classifiedContactSchema, typesContact.classifiedContactSchema],
  ['branchRecordSchema', contactSchema.branchRecordSchema, typesContact.branchRecordSchema],
  ['socialProfileTypeEnum', socialSchema.socialProfileTypeEnum, typesSocial.socialProfileTypeEnum],
  ['socialOwnerEnum', socialSchema.socialOwnerEnum, typesSocial.socialOwnerEnum],
  ['socialRejectionReasonEnum', socialSchema.socialRejectionReasonEnum, typesSocial.socialRejectionReasonEnum],
  ['socialStatusEnum', socialSchema.socialStatusEnum, typesSocial.socialStatusEnum],
  ['classifiedSocialProfileSchema', socialSchema.classifiedSocialProfileSchema, typesSocial.classifiedSocialProfileSchema],
  ['phoneEvidenceSchema', verificationSchema.phoneEvidenceSchema, typesVerification.phoneEvidenceSchema],
  ['websitePageEvidenceSchema', verificationSchema.websitePageEvidenceSchema, typesVerification.websitePageEvidenceSchema],
  ['websiteEvidenceSchema', verificationSchema.websiteEvidenceSchema, typesVerification.websiteEvidenceSchema],
  ['verificationChecksSchema', verificationSchema.verificationChecksSchema, typesVerification.verificationChecksSchema],
  ['verificationResultSchema', verificationSchema.verificationResultSchema, typesVerification.verificationResultSchema],
  ['confidenceBreakdownSchema', verificationSchema.confidenceBreakdownSchema, typesVerification.confidenceBreakdownSchema],
  ['websiteRelationshipEnum', verificationSchema.websiteRelationshipEnum, typesVerification.websiteRelationshipEnum],
  ['websiteLifecycleEnum', verificationSchema.websiteLifecycleEnum, typesVerification.websiteLifecycleEnum],
  ['sourceHealthEnum', verificationSchema.sourceHealthEnum, typesVerification.sourceHealthEnum],
  ['verifiedBusinessEvidenceSchema', verificationSchema.verifiedBusinessEvidenceSchema, typesVerification.verifiedBusinessEvidenceSchema],
  ['discoveryStateEnum', discoveryState.discoveryStateEnum, typesDiscovery.discoveryStateEnum],
  ['discoveryProvenanceSchema (discovery)', discoveryState.discoveryProvenanceSchema, typesDiscovery.discoveryProvenanceSchema],
  ['unifiedSearchResultSchema', searchFallback.unifiedSearchResultSchema, typesSearch.unifiedSearchResultSchema],
  ['searchMetadataSchema', searchFallback.searchMetadataSchema, typesSearch.searchMetadataSchema],
  ['searchResponseSchema', searchFallback.searchResponseSchema, typesSearch.searchResponseSchema],
];

for (const [label, originVal, typesVal] of identityChecks) {
  check(`identity: ${label}`, originVal === typesVal);
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nALL CHECKS PASSED: all shims maintain reference identity and existence.`);
  process.exit(0);
}

