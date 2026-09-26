// ============================================================================
// Canonical domain type layer (Phase 1). Public convenience barrel — canonical
// type modules import siblings directly (./x.js), never through this barrel.
// ============================================================================
export * from './business-listing.js';
export * from './contact.js';
export * from './discovery-state.js';
export * from './ledger.js';
export * from './research-candidate.js';
export * from './research-input.js';
export * from './run-summary.js';
export * from './runs.js';
export * from './search.js';
export * from './social.js';
export * from './verification.js';

// `DiscoveryProvenance` is re-exported by both `./discovery-state.js` (canonical)
// and `./research-candidate.js` (compat re-export). Pin the canonical source here
// to resolve star-export ambiguity (TS2308) for barrel consumers.
export { discoveryProvenanceSchema } from './discovery-state.js';
export type { DiscoveryProvenance } from './discovery-state.js';
