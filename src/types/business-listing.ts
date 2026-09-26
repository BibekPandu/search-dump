import { z } from 'zod';
import { classifiedContactSchema, branchRecordSchema } from './contact.js';
import { confidenceBreakdownSchema } from './verification.js';
import { discoveryProvenanceSchema, discoveryStateEnum } from './discovery-state.js';

export const businessListingSchema = z.object({
  name: z.string().default('Unknown Name'),
  location: z.string().default(''),
  emails: z.array(z.string()).default([]),
  phones: z.array(z.string()).default([]),
  mobiles: z.array(z.string()).default([]),
  websites: z.array(z.string()).default([]),
  icon: z.string().default(''),
  socialLinks: z
    .object({
      facebook: z.string().default(''),
      tiktok: z.string().default(''),
      instagram: z.string().default(''),
      other: z.record(z.string(), z.string()).default({}),
    })
    .default({
      facebook: '',
      tiktok: '',
      instagram: '',
      other: {},
    }),
  otherDetails: z
    .object({
      branches: z.array(branchRecordSchema).optional(),
      classifiedContacts: z.array(classifiedContactSchema).optional(),
      websiteRelationship: z.string().optional(),
      discoveryState: discoveryStateEnum.optional(),
      reconciliationReason: z.string().optional(),
      discoveryProvenance: discoveryProvenanceSchema.optional(),
      categories: z.array(z.string()).optional(),
      hours: z.string().optional(),
      priceRange: z.string().optional(),
      businessDescription: z.string().optional(),
      thumbnailUrl: z.string().optional(),
      bookingLinks: z.any().optional(),
    })
    .passthrough()
    .default({}),
  metadata: z
    .object({
      source: z.string().default('web'),
      extractedAt: z.string().default(() => new Date().toISOString()),
      runStartedAt: z.string().optional(),
      confidence: z.number().default(0),
      confidenceBreakdown: confidenceBreakdownSchema.optional(),
    })
    .passthrough(),
  process: z.string().default('Verified via Google + Web search'),
  links: z.array(z.string()).default([]),
  gpsCoordinates: z
    .object({
      latitude: z.number().optional(),
      longitude: z.number().optional(),
    })
    .optional(),
  rating: z.number().optional(),
  ratingCount: z.number().optional(),
  businessType: z.string().optional(),
  placeId: z.string().optional(),
});

export type BusinessListing = z.infer<typeof businessListingSchema>;
