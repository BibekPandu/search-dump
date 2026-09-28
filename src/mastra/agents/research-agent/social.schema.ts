/**
 * Phase 1 (R5 shim): canonical schema moved to `src/types/social.ts`.
 * Re-exported here until Phase 9 so `business-extractor.service` and existing
 * scripts keep their import path.
 */
export {
  socialProfileTypeEnum,
  socialOwnerEnum,
  socialRejectionReasonEnum,
  socialStatusEnum,
  classifiedSocialProfileSchema,
  type SocialProfileType,
  type SocialOwner,
  type SocialRejectionReason,
  type SocialStatus,
  type ClassifiedSocialProfile,
} from '@/types/social.js';
