/**
 * Phase 8i Telemetry Service
 *
 * Tracks diagnostic and gate rejection counters across pipeline stages:
 * - streetNameCollisionsCaught: Street-name false positives blocked (e.g. Chandragiri Galli)
 * - conflictingLocalityExclusions: Candidates excluded via conflicting locality or geocoding boundary
 * - tieredCorroborationRejections: Websites rejected via 0-token or uncorroborated single-token rules
 * - directorySubdomainPenalties: Third-party directory subdomains detected via eTLD+1
 * - templateFingerprintMatches: Demo/theme placeholder profiles stripped
 * - socialUrlsCanonicalized: Social profile URLs stripped of non-canonical subpaths
 * - webOnlyAmbiguousExclusions: [Phase 8k] Web-only candidates excluded by ambiguous geo gate
 * - unattributedOnlyListings: [Phase 8k] Listings where all contacts were unattributed
 */

export interface Phase8iTelemetry {
  streetNameCollisionsCaught: number;
  conflictingLocalityExclusions: number;
  tieredCorroborationRejections: number;
  directorySubdomainPenalties: number;
  templateFingerprintMatches: number;
  socialUrlsCanonicalized: number;
  /** Phase 8k Component 1: Web-only candidates excluded by ambiguous geo gate */
  webOnlyAmbiguousExclusions: number;
  /** Phase 8k Component 3: Listings where all non-Maps contacts were unattributed */
  unattributedOnlyListings: number;
}

const telemetryState: Phase8iTelemetry = {
  streetNameCollisionsCaught: 0,
  conflictingLocalityExclusions: 0,
  tieredCorroborationRejections: 0,
  directorySubdomainPenalties: 0,
  templateFingerprintMatches: 0,
  socialUrlsCanonicalized: 0,
  webOnlyAmbiguousExclusions: 0,
  unattributedOnlyListings: 0,
};

export function incrementTelemetry(key: keyof Phase8iTelemetry, amount = 1): void {
  if (key in telemetryState) {
    telemetryState[key] += amount;
  }
}

export function getTelemetry(): Phase8iTelemetry {
  return { ...telemetryState };
}

export function resetTelemetry(): void {
  telemetryState.streetNameCollisionsCaught = 0;
  telemetryState.conflictingLocalityExclusions = 0;
  telemetryState.tieredCorroborationRejections = 0;
  telemetryState.directorySubdomainPenalties = 0;
  telemetryState.templateFingerprintMatches = 0;
  telemetryState.socialUrlsCanonicalized = 0;
  telemetryState.webOnlyAmbiguousExclusions = 0;
  telemetryState.unattributedOnlyListings = 0;
}
