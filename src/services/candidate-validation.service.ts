/**
 * candidate-validation.service.ts
 *
 * Phase 8g: Component 0 — Unified Candidate Validation Service
 *
 * Provides a single, pure, invariant validation gauntlet that ALL candidates
 * (Google Maps, Web Fallback, SERP Discoveries) must pass through before
 * deep extraction, contact attribution, and consensus synthesis.
 */

import {
  evaluateGeographicLocality,
  evaluateGeographicLocalityWithEscalation,
  type GeographicDecision,
} from './geographic-evaluator.service';
import type { LocalityClusterConfig } from '../config/geo-localities.config.js';
import type { ResearchCandidate } from '../mastra/agents/research-agent/schema';
import { incrementTelemetry } from './telemetry.service';

export interface CandidateValidationContext {
  targetQuery: string;
  targetLocation?: string;
  categoryIntent?: unknown;
  dynamicCluster?: LocalityClusterConfig | null;
  /**
   * Phase 8k Component 1 — Geo Anchoring & Web-Only Locality Gate.
   * Set to `true` when this candidate came from Google Maps (Serper Places API).
   * Maps candidates have GPS coordinates and are subject to Haversine distance gate.
   * Web-only candidates (isMapsAnchor = false or undefined) must have geo status
   * === 'inside' to pass the eligibility gate. 'ambiguous' is excluded for web-only.
   */
  isMapsAnchor?: boolean;
}

export interface CandidateValidationResult {
  status: 'accepted' | 'excluded' | 'ambiguous';
  localityStatus: 'inside' | 'outside' | 'ambiguous';
  localityAmbiguous: boolean;
  reason: string;
  exclusionReason?: string;
  candidate: ResearchCandidate;
}

/**
 * Maps artifacts that are not real businesses (e.g. "Stretching equipment (Open)").
 * Cheap deterministic guard so they never become candidates.
 */
export function isNonBusinessArtifactName(name?: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (/\(open\)\s*$/i.test(trimmed)) return true;
  if (/^(stretching equipment|exercise equipment|treadmill|dumbbell|weight bench)\b/i.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Validates any candidate (Maps or Web) through the 4-stage validation pipeline:
 * 0. Non-business artifact name guard
 * 1. Country & TLD Guard (reject foreign ccTLDs unless explicitly requested)
 * 2. Geographic Locality (inside -> pass, outside -> exclude, ambiguous -> flag for Step 2)
 * 3. Ground-truth address integrity (remove query string stamping)
 * 4. Directory/aggregator domain filtering
 */
export function validateCandidate(
  candidate: ResearchCandidate,
  context: CandidateValidationContext
): CandidateValidationResult {
  const { targetLocation, targetQuery, dynamicCluster } = context;

  // Stage 0: Non-business artifact name guard (Maps data quality)
  const artifactName = candidate.name || (candidate as { title?: string }).title || '';
  if (isNonBusinessArtifactName(artifactName)) {
    return {
      status: 'excluded',
      localityStatus: 'outside',
      localityAmbiguous: false,
      reason: `Non-business artifact name rejected: "${artifactName}"`,
      exclusionReason: 'NON_BUSINESS_ARTIFACT',
      candidate,
    };
  }

  // Stage 1: Country & TLD Guard
  const url = candidate.website || (candidate as any).url || '';
  if (url) {
    try {
      const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
      const host = parsed.hostname.toLowerCase();
      // Block non-Nepal foreign ccTLDs if Nepal is the default target context
      const foreignCcTlds = ['.in', '.co.in', '.ae', '.cn', '.pk', '.bd', '.uk', '.co.uk'];
      const hasForeignTld = foreignCcTlds.some((tld) => host.endsWith(tld));
      const queryMentionsCountry = /(?:india|uae|dubai|china|pakistan|bangladesh|uk|britain)/i.test(
        targetQuery || ''
      );

      if (hasForeignTld && !queryMentionsCountry) {
        return {
          status: 'excluded',
          localityStatus: 'outside',
          localityAmbiguous: false,
          reason: `Country Guard: Foreign domain ${host} rejected for domestic query`,
          exclusionReason: `COUNTRY_MISMATCH:${host}`,
          candidate,
        };
      }
    } catch {}
  }

  // Stage 2: Geographic Locality Evaluation
  if (targetLocation && targetLocation.trim().length > 0) {
    const geoInput = {
      title: candidate.name || (candidate as any).title || '',
      address: candidate.location || (candidate as any).address || (candidate as any).snippet || '',
      latitude: candidate.coordinates?.lat || (candidate as any).latitude,
      longitude: candidate.coordinates?.lng || (candidate as any).longitude,
    };

    const geoDecision: GeographicDecision = evaluateGeographicLocality(
      geoInput,
      targetLocation,
      dynamicCluster
    );

    if (geoDecision.status === 'outside') {
      return {
        status: 'excluded',
        localityStatus: 'outside',
        localityAmbiguous: false,
        reason: `Geographic Exclusion: ${geoDecision.reason}`,
        exclusionReason: `GEOGRAPHY_OUTSIDE:${geoDecision.reason}`,
        candidate,
      };
    }

    if (geoDecision.status === 'ambiguous') {
      // Phase 8k Component 1 — Web-Only Locality Gate:
      // Web-only candidates (no Maps anchor GPS) that are geo-ambiguous MUST be excluded.
      // They have no coordinates and no verified locality match; letting them through causes D1/D6.
      // Maps anchor candidates are retained as 'ambiguous' to allow downstream corroboration.
      const hasGps = Boolean(
        candidate.coordinates?.lat !== undefined && candidate.coordinates?.lng !== undefined
      );
      const isMapsAnchor = context.isMapsAnchor === true || hasGps;

      if (!isMapsAnchor) {
        // Web-only ambiguous: exclude as unproven locality
        incrementTelemetry('webOnlyAmbiguousExclusions');
        return {
          status: 'excluded',
          localityStatus: 'ambiguous',
          localityAmbiguous: true,
          reason: `Web-Only Locality Gate: Candidate has no GPS coordinates and no confirmed locality match for '${targetLocation}'. Excluded: ${geoDecision.reason}`,
          exclusionReason: `WEB_ONLY_UNPROVEN_LOCALITY:${geoDecision.reason}`,
          candidate,
        };
      }

      // Maps-anchored ambiguous: retain for downstream corroboration
      return {
        status: 'ambiguous',
        localityStatus: 'ambiguous',
        localityAmbiguous: true,
        reason: `Geographic Ambiguity (Maps anchor retained): ${geoDecision.reason}`,
        candidate: {
          ...candidate,
          // Guarantee: location is NEVER stamped with the query string
          location: candidate.location && candidate.location !== targetLocation ? candidate.location : '',
        },
      };
    }
  }

  // Stage 3: Ground-Truth Address Formatting
  let sanitizedLocation = candidate.location || (candidate as any).address || '';
  if (targetLocation && sanitizedLocation.toLowerCase().trim() === targetLocation.toLowerCase().trim()) {
    // If the candidate's address is literally just the user query string, leave it blank
    // so downstream extraction can populate ground truth.
    sanitizedLocation = '';
  }

  return {
    status: 'accepted',
    localityStatus: 'inside',
    localityAmbiguous: false,
    reason: 'Passed candidate validation pipeline',
    candidate: {
      ...candidate,
      location: sanitizedLocation,
    },
  };
}

export interface ExtractedAddressRevalidationResult {
  isValid: boolean;
  localityStatus: 'inside' | 'outside' | 'ambiguous';
  reason: string;
  sanitizedAddress: string;
}

/**
 * Phase 8h (W2-03) & Phase 8i (GEO-02): Re-validates the candidate's actual extracted address from Step 2 against the target location.
 * Directly reuses Group B geocoding and evaluateGeographicLocalityWithEscalation() as single source of truth.
 */
export async function revalidateExtractedCandidateAddress(
  candidate: ResearchCandidate,
  extractedAddress: string,
  targetLocation?: string,
  dynamicCluster?: LocalityClusterConfig | null
): Promise<ExtractedAddressRevalidationResult> {
  if (!targetLocation || !targetLocation.trim() || !extractedAddress || !extractedAddress.trim()) {
    return {
      isValid: true,
      localityStatus: 'ambiguous',
      reason: 'No address or target location available for re-check',
      sanitizedAddress: extractedAddress || '',
    };
  }

  const geoInput = {
    title: candidate.name,
    address: extractedAddress,
    latitude: candidate.coordinates?.lat,
    longitude: candidate.coordinates?.lng,
  };

  const geoDecision = await evaluateGeographicLocalityWithEscalation(
    geoInput,
    targetLocation,
    dynamicCluster
  );

  if (geoDecision.status === 'outside') {
    return {
      isValid: false,
      localityStatus: 'outside',
      reason: `Step 2 Address Re-check Exclusion: ${geoDecision.reason}`,
      sanitizedAddress: extractedAddress,
    };
  }

  return {
    isValid: true,
    localityStatus: geoDecision.status,
    reason: geoDecision.reason,
    sanitizedAddress: extractedAddress,
  };
}

