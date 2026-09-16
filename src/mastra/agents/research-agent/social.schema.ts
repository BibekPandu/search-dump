import { z } from 'zod';

export const socialProfileTypeEnum = z.enum([
  'business_page',
  'personal_profile',
  'group',
  'post',
  'unknown',
]);
export type SocialProfileType = z.infer<typeof socialProfileTypeEnum>;

export const socialOwnerEnum = z.enum([
  'business',
  'person',
  'vendor',
  'platform',
  'unknown',
]);
export type SocialOwner = z.infer<typeof socialOwnerEnum>;

export const socialRejectionReasonEnum = z.enum([
  'NONE',
  'PERSONAL_PROFILE',
  'VENDOR_PROFILE',
  'PLATFORM_PROFILE',
  'DIRECTORY_PROFILE',
  'BUSINESS_NAME_MISMATCH',
  'RESERVED_PATH',
  'NOT_A_REAL_PROFILE',
  'UNSUPPORTED',
  'INSUFFICIENT_EVIDENCE',
]);
export type SocialRejectionReason = z.infer<typeof socialRejectionReasonEnum>;

export const socialStatusEnum = z.enum([
  'accepted',
  'rejected',
  'unknown',
]);
export type SocialStatus = z.infer<typeof socialStatusEnum>;

export const classifiedSocialProfileSchema = z.object({
  url: z.string(),
  platform: z.enum(['facebook', 'instagram', 'tiktok', 'twitter', 'youtube', 'linkedin', 'other']),
  handle: z.string(),
  profileType: socialProfileTypeEnum,
  owner: socialOwnerEnum,
  status: socialStatusEnum,
  confidence: z.number().default(1.0),
  rejectionReason: socialRejectionReasonEnum.default('NONE'),
  distinctiveTokensFound: z.array(z.string()).default([]),
});
export type ClassifiedSocialProfile = z.infer<typeof classifiedSocialProfileSchema>;
