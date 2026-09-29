/**
 * Entity resolution facade.
 *
 * The implementation lives in three focused modules; this path stays the
 * single import site for the rest of the codebase (and for the compat
 * re-export in `services/entity-resolution.service.ts`).
 *
 *   entity-normalizers.ts  identity keys (pure, leaf)
 *   entity-matching.ts     pair matching, dedupe, website ranking
 *   entity-conflicts.ts    conflict detection, merging, attribution
 */
export * from './entity-normalizers';
export * from './entity-matching';
export * from './entity-conflicts';
