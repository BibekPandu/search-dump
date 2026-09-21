// ============================================================================
// Multi-Dimensional Confidence Model (Task 5)
// ============================================================================
// Deterministic, pure functions. No dependencies on Mastra, agents,
// filesystem, or any workflow context. Only ConfidenceInputs → ConfidenceBreakdown.
// ============================================================================

// ── Tunable policy constants ────────────────────────────────────────────────

/**
 * Maps-only fallback baseline for contact dimension.
 *
 * Used when isMapsCandidate is true but hasWebsiteEvidence is false.
 * This prevents the overall confidence from collapsing when website
 * and contact dimensions are unavailable, while still discounting them.
 *
 * Tuning note: 0.5 is a v1 policy choice. Task 7 benchmark evaluation
 * should determine if this value is appropriate.
 */
export const MAPS_ONLY_FALLBACK_BASELINE = 0.5;

// ── ConfidenceInputs — signals fed into the model ──

export interface ConfidenceInputs {
  // Maps signals
  isMapsCandidate: boolean;
  mapsPhone?: string;
  rating?: number;
  ratingCount?: number;
  placeId?: string;
  gpsCoordinates?: { latitude?: number; longitude?: number; lat?: number; lng?: number };
  address?: string;

  // Website evidence (explicit — avoids fragile inference)
  hasWebsiteEvidence: boolean;
  verificationConfidence?: number; // verificationResult.overallConfidence
  verificationChecks?: {
    phoneMatchesMaps: boolean;
    emailFoundOnWebsite: boolean;
    addressOrLocationFoundOnWebsite: boolean;
  };
  websiteRelationship?: string; // 'first_party' | 'directory' | ...

  // Contact
  phonesCount?: number;
  mobilesCount?: number;

  // Final listing contents — authoritative projection of accepted evidence
  // Ownership note: For Phase 1, ownership is enforced upstream by the sanitizer /
  // website-relationship logic. The confidence layer trusts accepted final listing fields.
  finalEmails?: string[];
  finalWebsites?: string[];
  finalPhones?: string[];
  finalMobiles?: string[];

  // Conflict
  conflictType?: string;
}

// ── ConfidenceBreakdown — model output ──

export interface ConfidenceBreakdown {
  mapsIdentityConfidence: number;
  websiteEvidenceConfidence: number;
  contactConfidence: number;
  overallConfidence: number;
  conflictPenalty: number;
  conflictType?: string;
  evidenceSummary: {
    mapsVerified: boolean;
    websiteVerified: boolean;
    phoneVerified: boolean;
    emailVerified: boolean;
    ratingCount?: number;
    relationshipType?: string;
  };
}

// ── Dimension A: Maps Identity Confidence ───────────────────────────────────

export function computeMapsConfidence(inputs: ConfidenceInputs): number {
  if (!inputs.isMapsCandidate) return 0;
  let score = 0.8;
  const rc = inputs.ratingCount ?? 0;
  if (rc >= 200) score += 0.15;
  else if (rc >= 50) score += 0.1;
  if (inputs.placeId) score += 0.05;
  if (inputs.gpsCoordinates) score += 0.05;
  if (inputs.address) score += 0.05;
  return Math.round(Math.min(score, 1.0) * 100) / 100;
}

// ── Dimension B: Website Evidence Confidence ────────────────────────────────

const RELATIONSHIP_MULTIPLIERS: Record<string, number> = {
  first_party: 1.0,
  corporate_parent: 0.9,
  related_entity: 0.7,
  directory: 0.3,
  marketplace: 0.2,
  service_platform: 0.25,
  unverified: 0.1,
  unrelated: 0.05,
};

export function computeWebsiteEvidenceConfidence(inputs: ConfidenceInputs): number {
  if (!inputs.hasWebsiteEvidence) return 0;
  const base = inputs.verificationConfidence ?? 0;
  const multiplier = RELATIONSHIP_MULTIPLIERS[inputs.websiteRelationship ?? ''] ?? 0.1;
  return Math.round(Math.min(base * multiplier, 1.0) * 100) / 100;
}

// ── Dimension C: Contact Confidence ─────────────────────────────────────────

export function computeContactConfidence(inputs: ConfidenceInputs): number {
  const checks = inputs.verificationChecks;
  const isMapsCandidate = inputs.isMapsCandidate;
  const hasMapsPhone = Boolean(inputs.mapsPhone || (isMapsCandidate && ((inputs.phonesCount ?? 0) + (inputs.mobilesCount ?? 0) > 0)));

  let score = 0;
  if (checks?.phoneMatchesMaps || (isMapsCandidate && hasMapsPhone && !inputs.hasWebsiteEvidence)) {
    score += 0.4;
  }
  if (checks?.emailFoundOnWebsite) score += 0.3;
  if (checks?.addressOrLocationFoundOnWebsite) score += 0.2;
  // Total unique phone identity count (guaranteed unique by Task 4)
  const totalPhones = (inputs.phonesCount ?? 0) + (inputs.mobilesCount ?? 0);
  if (totalPhones >= 2) score += 0.1;
  return Math.round(Math.min(score, 1.0) * 100) / 100;
}

// ── Conflict Penalty ────────────────────────────────────────────────────────

const CONFLICT_PENALTIES: Record<string, number> = {
  NO_CONFLICT: 1.0,
  SHARED_OFFICE: 0.9,
  RELATED_BRAND: 0.85,
  POSSIBLY_SAME_ENTITY: 0.75,
  DUPLICATE_MAPS_LISTING: 0.65,
};

export function computeConflictPenalty(conflictType?: string): number {
  return CONFLICT_PENALTIES[conflictType ?? 'NO_CONFLICT'] ?? 1.0;
}

// ── Overall Confidence ──────────────────────────────────────────────────────

export function computeOverallConfidence(
  maps: number,
  website: number,
  contact: number,
  penalty: number,
  isMapsOnly: boolean
): number {
  let raw: number;
  if (isMapsOnly) {
    // Maps-only: Maps identity carries full weight, website=0, contact=0.
    // MAPS_ONLY_FALLBACK_BASELINE prevents the overall confidence from
    // collapsing to zero when website evidence is simply absent.
    raw = maps * 0.65 + 0.35 * MAPS_ONLY_FALLBACK_BASELINE;
  } else {
    raw = maps * 0.3 + website * 0.35 + contact * 0.35;
  }
  return Math.round(Math.min(raw * penalty, 1.0) * 100) / 100;
}

// ── Main Entry Point ────────────────────────────────────────────────────────

export function computeConfidenceBreakdown(inputs: ConfidenceInputs): ConfidenceBreakdown {
  const mapsConf = computeMapsConfidence(inputs);
  const websiteConf = computeWebsiteEvidenceConfidence(inputs);
  const contactConf = computeContactConfidence(inputs);
  const penalty = computeConflictPenalty(inputs.conflictType);
  const isMapsOnly = inputs.isMapsCandidate && !inputs.hasWebsiteEvidence;
  const overall = computeOverallConfidence(
    mapsConf,
    websiteConf,
    contactConf,
    penalty,
    isMapsOnly
  );

  return {
    mapsIdentityConfidence: Math.round(mapsConf * 100) / 100,
    websiteEvidenceConfidence: Math.round(websiteConf * 100) / 100,
    contactConfidence: Math.round(contactConf * 100) / 100,
    overallConfidence: Math.round(overall * 100) / 100,
    conflictPenalty: penalty,
    conflictType: inputs.conflictType,
    evidenceSummary: {
      mapsVerified: inputs.isMapsCandidate,
      websiteVerified:
        (inputs.finalWebsites?.length ?? 0) > 0 &&
        inputs.hasWebsiteEvidence &&
        (inputs.verificationConfidence ?? 0) > 0,
      phoneVerified:
        ((inputs.finalPhones !== undefined ? inputs.finalPhones.length : (inputs.phonesCount ?? 0)) +
         (inputs.finalMobiles !== undefined ? inputs.finalMobiles.length : (inputs.mobilesCount ?? 0))) > 0 &&
        ((inputs.verificationChecks?.phoneMatchesMaps ?? false) ||
         (inputs.isMapsCandidate && ((inputs.phonesCount ?? 0) > 0 || (inputs.mobilesCount ?? 0) > 0 || Boolean(inputs.mapsPhone)))),
      emailVerified:
        (inputs.finalEmails?.length ?? 0) > 0 &&
        (inputs.verificationChecks?.emailFoundOnWebsite ?? false),
      ratingCount: inputs.ratingCount,
      relationshipType: inputs.websiteRelationship,
    },
  };
}

// ── Integrity Validation ────────────────────────────────────────────────────

/**
 * Validates confidence values and the metadata.confidence === overallConfidence invariant.
 *
 * @param breakdown - The computed confidence breakdown
 * @param metadataConfidence - The value stored in listing.metadata.confidence (optional)
 * @returns { valid, errors }
 */
export function validateConfidenceIntegrity(
  breakdown: ConfidenceBreakdown,
  metadataConfidence?: number
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const dimensions: Array<[string, number]> = [
    ['mapsIdentityConfidence', breakdown.mapsIdentityConfidence],
    ['websiteEvidenceConfidence', breakdown.websiteEvidenceConfidence],
    ['contactConfidence', breakdown.contactConfidence],
    ['overallConfidence', breakdown.overallConfidence],
    ['conflictPenalty', breakdown.conflictPenalty],
  ];

  for (const [name, value] of dimensions) {
    if (typeof value !== 'number' || isNaN(value)) {
      errors.push(`${name} is not a number`);
    } else if (value < 0 || value > 1) {
      errors.push(`${name} = ${value} outside [0, 1]`);
    }
  }

  // Check metadata.confidence === overallConfidence
  if (
    metadataConfidence !== undefined &&
    Math.abs(metadataConfidence - breakdown.overallConfidence) > 0.001
  ) {
    errors.push(
      `metadata.confidence (${metadataConfidence}) !== breakdown.overallConfidence (${breakdown.overallConfidence})`
    );
  }

  return { valid: errors.length === 0, errors };
}
