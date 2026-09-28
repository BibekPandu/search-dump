/**
 * Canonical Website Discovery States & Provenance Schema (Phase 7b)
 *
 * Phase 1 (R5 shim): the canonical definition moved to `src/types/discovery-state.ts`.
 * This module re-exports it so every existing consumer (`search-fallback.service`,
 * `website-discovery-gate.service`, `serper-places.service`,
 * `research-candidate.service`) keeps its import path until Phase 9.
 */
export {
  DISCOVERY_STATES,
  discoveryStateEnum,
  discoveryProvenanceSchema,
  type DiscoveryState,
  type DiscoveryProvenance,
} from '@/types/discovery-state.js';
