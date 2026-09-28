import { z } from 'zod';

// ============================================================================
// Canonical Website Discovery States & Provenance Schema (Phase 7b)
// ============================================================================
// Standalone zero-dependency schema module to prevent ESM initialization cycles
// between website-discovery-gate.service, entity-resolution.service, and
// search-fallback.service.

export const DISCOVERY_STATES = [
  /** Google Maps already supplied a website. Discovery is unnecessary. */
  'MAPS_HAS_WEBSITE',
  /** Discovered an official first-party website for this Maps candidate. */
  'DISCOVERY_FOUND_FIRST_PARTY',
  /** Search succeeded but every result was a directory, aggregator, or social. */
  'DISCOVERY_FOUND_ONLY_THIRD_PARTY',
  /** Search succeeded but returned zero usable candidates after all passes. */
  'DISCOVERY_EXHAUSTED_NO_FIRST_PARTY',
  /** Not evaluated via live search due to budget constraints. */
  'DISCOVERY_NOT_ATTEMPTED_BUDGET',
] as const;

export type DiscoveryState = (typeof DISCOVERY_STATES)[number];

export const discoveryStateEnum = z.enum(DISCOVERY_STATES);

export const discoveryProvenanceSchema = z.object({
  queries: z.array(z.string()).default([]),
  /** URLs reviewed from SERP results (capped at top 20 per candidate). */
  candidateUrlsReviewed: z.array(z.string()).default([]),
  selectedUrl: z.string().optional(),
  selectionReason: z.string().optional(),
  secondChanceAttempted: z.boolean().default(false),
  phoneSourceDomain: z.string().optional(),
  discoveredSocials: z
    .object({
      facebook: z.string().optional(),
      instagram: z.string().optional(),
      tiktok: z.string().optional(),
      linkedin: z.string().optional(),
      other: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

/** Full discovery provenance record carried through candidate -> evidence -> listing. */
export type DiscoveryProvenance = z.infer<typeof discoveryProvenanceSchema>;
