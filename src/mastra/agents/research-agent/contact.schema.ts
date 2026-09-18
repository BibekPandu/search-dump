import { z } from 'zod';

// ============================================================================
// Contact Semantics & Extraction Precision Schemas (Phase 2)
// ============================================================================

export const contactRoleEnum = z.enum([
  'primary_business',
  'branch_contact',
  'staff_person',
  'unknown',
]);

export const contactOwnerEnum = z.enum([
  'business',
  'branch',
  'person',
  'platform',
  'vendor', // Reserved for Phase 3 (social profile vendor filtering)
  'unknown',
]);

export const contactChannelEnum = z.enum(['call', 'whatsapp', 'viber']);

export const classifiedContactSchema = z.object({
  value: z.string(),
  canonicalDigits: z.string().optional(),
  type: z.enum(['phone', 'email']),
  phoneType: z.enum(['mobile', 'landline', 'international', 'invalid']).optional(),
  role: contactRoleEnum.default('unknown'),
  owner: contactOwnerEnum.default('unknown'),
  channels: z.array(contactChannelEnum).default([]),
  context: z.string().optional(),
  blockId: z.string().optional(),
  pageUrl: z.string().optional(),
  pagesSeenOn: z.array(z.string()).optional(),
  associatedPerson: z.string().optional(),
  associatedJobTitle: z.string().optional(),
});

/**
 * Consumer-facing lightweight branch summary.
 * Full rich channel metadata remains accessible in otherDetails.classifiedContacts.
 */
export const branchRecordSchema = z.object({
  name: z.string(),
  address: z.string().optional(),
  phones: z.array(z.string()).default([]),
  mobiles: z.array(z.string()).default([]),
  emails: z.array(z.string()).default([]),
  sourceUrl: z.string().optional(),
});

export type ContactRole = z.infer<typeof contactRoleEnum>;
export type ContactOwner = z.infer<typeof contactOwnerEnum>;
export type ContactChannel = z.infer<typeof contactChannelEnum>;
export type ClassifiedContact = z.infer<typeof classifiedContactSchema>;
export type BranchRecord = z.infer<typeof branchRecordSchema>;
