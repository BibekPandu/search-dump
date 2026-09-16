import { z } from 'zod';
import { researchCandidateSchema } from './schema';
import { classifiedContactSchema } from './contact.schema';

// ============================================================================
// Tier 2.5 — Verified Business Evidence Schemas (additive)
// ============================================================================
// These schemas define the "Verify & Extract" layer contract between
// ResearchCandidate (identity source) and BusinessListing (final presentation).
// They are ADDITIVE: Phase 1 schemas (researchCandidateSchema,
// researchReportSchema, businessListingSchema) are untouched.

/**
 * Zod schema for a single PhoneEvidence record.
 * Invalid candidates are stored here only (never in phones/mobiles arrays).
 */
export const phoneEvidenceSchema = z.object({
  raw: z.string(),
  canonicalDigits: z.string(),
  display: z.string(),
  type: z.enum(['mobile', 'landline', 'international', 'invalid']),
  source: z.enum(['markdown', 'rawHtml', 'href']),
  pageUrl: z.string(),
  reason: z.string().optional(),
});

/**
 * A single extracted website page for one candidate.
 */
export const websitePageEvidenceSchema = z.object({
  url: z.string(),
  content: z.string().default(''),
  favicon: z.string().default(''),
  success: z.boolean().default(false),
  error: z.string().optional(),
  /**
   * How this page was discovered:
   * - 'homepage'      — the candidate homepage (always first)
   * - 'internal_link' — a real same-domain link discovered on the homepage
   * - 'fallback_guess'— a guessed common path used ONLY when real discovery failed
   */
  discoverySource: z
    .enum(['homepage', 'internal_link', 'fallback_guess'])
    .default('homepage'),
  pageType: z
    .enum(['home', 'contact', 'about', 'services', 'location', 'team', 'menu', 'other'])
    .default('other'),
  rawHtml: z.string().optional(),
});

/**
 * Deterministically extracted + verified evidence gathered from one official
 * website across its selected pages. Contains ONLY deterministic, evidence-backed
 * facts — never LLM-generated values.
 */
export const websiteEvidenceSchema = z.object({
  /** Official website base URL (candidate.website). */
  url: z.string(),
  domain: z.string().default(''),
  pages: z.array(websitePageEvidenceSchema).default([]),
  extractedEmails: z.array(z.string()).default([]),
  /** Display-form phone strings preserved; matching uses normalized digits. */
  extractedPhones: z.array(z.string()).default([]),
  extractedMobiles: z.array(z.string()).default([]),
  /**
   * Full forensic evidence for every phone candidate encountered.
   * Valid phones appear here AND in extractedPhones/extractedMobiles.
   * Invalid candidates appear ONLY here (never in the public arrays).
   * Optional — absent from older serialized records.
   */
  extractedPhoneEvidence: z.array(phoneEvidenceSchema).optional(),
  /** Full semantic role and ownership classification for extracted contacts. */
  extractedClassifiedContacts: z.array(classifiedContactSchema).optional(),
  extractedSocialLinks: z
    .object({
      facebook: z.string().default(''),
      instagram: z.string().default(''),
      tiktok: z.string().default(''),
      other: z.record(z.string(), z.string()).default({}),
    })
    .default({ facebook: '', instagram: '', tiktok: '', other: {} }),
  extractedServices: z.array(z.string()).default([]),
  extractedHours: z.string().optional(),
  favicon: z.string().default(''),
  /** Tiny context-only summary of the raw content (capped). Never a data source. */
  rawContentSummary: z.string().optional(),
});

/**
 * Boolean evidence checks comparing the ResearchCandidate identity against the
 * extracted website evidence. NOTE: these checks are about whether the WEBSITE
 * supports the candidate's identity — each is a real signal.
 */
export const verificationChecksSchema = z.object({
  /** candidate.website passes isUsableOfficialWebsite (social/directory rejected). */
  websiteIsUsableOfficial: z.boolean(),
  /**
   * Website domain equals candidate website domain. This is a CONSISTENCY check
   * only — because the evidence URL derives from candidate.website it can NEVER
   * by itself prove verification. It exists to catch structural mismatches.
   */
  websiteDomainMatchesCandidate: z.boolean(),
  /** Significant candidate name tokens appear/align in the website content. */
  businessNameFoundOnWebsite: z.boolean(),
  /** Candidate (Maps) phone matches an extracted website phone when both exist. */
  phoneMatchesMaps: z.boolean(),
  /** Candidate location/address tokens appear in website content when available. */
  addressOrLocationFoundOnWebsite: z.boolean(),
  /** Non-placeholder email(s) were extracted from official website pages. */
  emailFoundOnWebsite: z.boolean(),
  /** Social links were found on official website pages (link extraction only). */
  socialLinksFoundOnWebsite: z.boolean(),
});

/**
 * Verification outcome with a meaningful status + boolean checks, NOT just a
 * loose confidence number.
 *
 * Semantics of status:
 * - 'verified': multiple independent strong signals (e.g. name + phone OR
 *   name + address + official domain)
 * - 'partial':  some useful evidence but not enough for strong verification
 * - 'weak':     website extracted but little identity alignment
 * - 'failed':   no usable website or extraction failure
 *
 * IMPORTANT: a 'failed' or 'weak' result means "insufficient deterministic
 * evidence," NOT proof that the website belongs to a different business.
 */
export const verificationResultSchema = z.object({
  status: z.enum(['verified', 'partial', 'weak', 'failed']),
  overallConfidence: z.number(),
  checks: verificationChecksSchema,
  notes: z.array(z.string()).default([]),
});

/**
 * Multi-dimensional confidence breakdown for a business listing.
 *
 * Computed deterministically from Maps signals, website evidence,
 * contact verification, and entity conflict data.
 *
 * Each dimension is grounded in observable signals — no LLM guessing.
 *
 * IMPORTANT: `metadata.confidence` must always equal
 * `confidenceBreakdown.overallConfidence`. This invariant is
 * enforced by validateConfidenceIntegrity() at the end of Phase 4.
 */
export const confidenceBreakdownSchema = z.object({
  mapsIdentityConfidence: z.number().min(0).max(1).default(0),

  /**
   * Website evidence confidence: how well the website supports the
   * candidate's identity (name, phone, address, email alignment).
   *
   * NOT a pure "ownership" signal — that comes from relationship
   * classification. This measures verification quality of the website
   * content, adjusted by relationship type.
   */
  websiteEvidenceConfidence: z.number().min(0).max(1).default(0),

  contactConfidence: z.number().min(0).max(1).default(0),

  /**
   * Final grounded confidence after conflict penalty.
   * MUST equal metadata.confidence — always.
   */
  overallConfidence: z.number().min(0).max(1).default(0),

  /**
   * Multiplicative penalty from entity conflict detection.
   *
   * IMPORTANT: This penalty represents confidence in this listing as an
   * independently resolved business entity — NOT business quality.
   * A DUPLICATE_MAPS_LISTING (0.65) penalty means "our entity resolution
   * has serious ambiguity about whether this is a distinct entity",
   * not "this business is bad".
   */
  conflictPenalty: z.number().min(0).max(1).default(1.0),
  conflictType: z.string().optional(),

  evidenceSummary: z
    .object({
      mapsVerified: z.boolean().default(false),
      websiteVerified: z.boolean().default(false),
      phoneVerified: z.boolean().default(false),
      emailVerified: z.boolean().default(false),
      ratingCount: z.number().optional(),
      relationshipType: z.string().optional(),
    })
    .optional(),
});

export type ConfidenceBreakdownSchema = z.infer<typeof confidenceBreakdownSchema>;

/**
 * Relationship classification between business candidate identity and website domain.
 */
export const websiteRelationshipEnum = z.enum([
  'first_party',        // Domain & name align — enriches contacts
  'corporate_parent',   // Corporate group domain — enriches cautiously
  'related_entity',     // Shared brand — preserved, NOT merged
  'directory',          // Directory/listing — NEVER contacts
  'marketplace',        // Marketplace — NEVER contacts
  'service_platform',   // Platform (Wix, GoDaddy) — NEVER contacts
  'unrelated',          // Different company — rejected
  'unverified',         // Insufficient evidence — preserves Maps identity
]);

export type WebsiteRelationship = z.infer<typeof websiteRelationshipEnum>;

/**
 * Lifecycle stages for website processing:
 * - 'discovered': Candidate website URL found (initial unextracted state)
 * - 'usable': Extracted and passed structural / domain validity checks
 * - 'identity_confirmed': Verified to corroborate candidate business identity
 * - 'first_party_owned': Identity confirmed AND strictly first_party relationship
 */
export const websiteLifecycleEnum = z.enum([
  'discovered',
  'usable',
  'identity_confirmed',
  'first_party_owned',
]);

export type WebsiteLifecycle = z.infer<typeof websiteLifecycleEnum>;

/**
 * The VerifiedBusinessEvidence record: the ResearchCandidate identity paired
 * with the verified website evidence and the verification outcome.
 * - candidate   = identity source (phase 1)
 * - websiteEvidence = evidence source (phase 2) — absent for no-website /
 *   cap-skipped candidates
 * - verification = how strongly the website corroborates the candidate
 * - websiteRelationship = relationship classification between candidate & domain
 * - websiteLifecycle = processing lifecycle stage of the website
 */
export const verifiedBusinessEvidenceSchema = z.object({
  candidate: researchCandidateSchema,
  websiteEvidence: websiteEvidenceSchema.optional(),
  verification: verificationResultSchema,
  websiteRelationship: websiteRelationshipEnum.optional().default('unverified'),
  websiteLifecycle: websiteLifecycleEnum.optional().default('discovered'),
});

export type WebsitePageEvidence = z.infer<typeof websitePageEvidenceSchema>;
export type WebsiteEvidence = z.infer<typeof websiteEvidenceSchema>;
export type VerificationChecks = z.infer<typeof verificationChecksSchema>;
export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type VerifiedBusinessEvidence = z.infer<typeof verifiedBusinessEvidenceSchema>;
export type PhoneEvidenceRecord = z.infer<typeof phoneEvidenceSchema>;