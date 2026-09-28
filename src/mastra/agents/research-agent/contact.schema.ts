/**
 * Phase 1 (R5 shim): canonical schema moved to `src/types/contact.ts`.
 * Re-exported here until Phase 9 so `business-extractor.service`,
 * `entity-resolution.service` and existing scripts keep their import path.
 */
export {
  contactRoleEnum,
  contactOwnerEnum,
  contactChannelEnum,
  classifiedContactSchema,
  branchRecordSchema,
  type ContactRole,
  type ContactOwner,
  type ContactChannel,
  type ClassifiedContact,
  type BranchRecord,
  type BranchAttributionState,
  type BranchAttributionResult,
} from '@/types/contact.js';
