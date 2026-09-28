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
  'OPAQUE_CHANNEL_ID',
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

export const socialOriginEnum = z.enum([
  'website_html',
  'schema_org_sameAs',
  'maps_booking_link',
  'maps_owner',
  'phase0_discovery',
  'serp',
  'website_evidence',
]);
export type SocialOrigin = z.infer<typeof socialOriginEnum>;

export const classifiedSocialProfileSchema = z.object({
  url: z.string(),
  canonicalUrl: z.string().optional(),
  platform: z.enum(['facebook', 'instagram', 'tiktok', 'twitter', 'youtube', 'linkedin', 'other']),
  handle: z.string(),
  profileType: socialProfileTypeEnum,
  owner: socialOwnerEnum,
  status: socialStatusEnum,
  confidence: z.number().default(1.0),
  rejectionReason: socialRejectionReasonEnum.default('NONE'),
  distinctiveTokensFound: z.array(z.string()).default([]),
  origin: z.string().optional(),
});
export type ClassifiedSocialProfile = z.infer<typeof classifiedSocialProfileSchema>;

