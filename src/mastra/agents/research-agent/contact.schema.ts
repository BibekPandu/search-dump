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

/**
 * Phase 8k Component 3 — Four-tier branch attribution state machine.
 *
 * Attribution order (highest priority first):
 *  1. `target_branch`   — GPS + address match for the queried locality.
 *                         Contact belongs to the branch at the searched location.
 *  2. `general_business` — National hotline, head office, or intra-district contact.
 *                          Included in top-level phones/mobiles, NOT in branches[].
 *  3. `branch_contact`   — Foreign-district contact (Haversine distance > R from target).
 *                          Included in branches[] with locality name.
 *  4. `unattributed`     — Could not determine branch ownership from evidence.
 *                          Never placed in top-level contacts or branches[].
 *                          Audit-logged only. Listing ships with phones: [] if all contacts are unattributed.
 */
export type BranchAttributionState =
  | 'target_branch'
  | 'general_business'
  | 'branch_contact'
  | 'unattributed';

/** Result returned by attributeMultiBranchContacts() for each classified contact. */
export interface BranchAttributionResult {
  contact: ClassifiedContact;
  attribution: BranchAttributionState;
  /** The locality name/label when attribution === 'branch_contact' */
  branchLabel?: string;
  /** Distance from target center in km when GPS available */
  distanceKm?: number;
  /** Why this attribution was chosen */
  reason: string;
}
