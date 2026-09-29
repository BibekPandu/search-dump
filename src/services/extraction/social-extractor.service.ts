/**
 * Social extraction facade.
 *
 * The implementation lives in five pipeline stages; this path stays the
 * single import site for the rest of the codebase (and for the barrel
 * re-exports in `extraction/index.ts` and `business-extractor.service.ts`).
 *
 *   social-url.ts          handle parsing + URL canonicalization (leaf)
 *   social-validation.ts   structural profile validation
 *   social-classify.ts     classification + ownership decisions
 *   social-ownership.ts    ownership queries + batch classification
 *   social-links.ts        structured link extraction
 */
export * from './social-url';
export * from './social-validation';
export * from './social-classify';
export * from './social-ownership';
export * from './social-links';
