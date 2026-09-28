/**
 * Backward-compatible facade over the Phase 4 extraction modules.
 *
 * This file contains no logic. Every symbol previously declared here now lives in
 * a single-responsibility module under `services/extraction/` (or `config/`) and is
 * re-exported unchanged: the 69 export names and their runtime kinds are identical
 * to the pre-split module. Do not add declarations here — add them to the owning
 * module so this facade stays a pure re-export surface.
 */

export * from '@/config/token-vocabulary.config';
export * from '@/services/extraction/category-token.service';
export * from '@/services/extraction/extraction-regex';
export * from '@/services/extraction/page-type.service';
export * from '@/services/extraction/content-normalization.service';
export * from '@/services/extraction/contact-extractor.service';
export * from '@/services/extraction/social-extractor.service';
export * from '@/services/extraction/phone-extractor.service';
export * from '@/services/extraction/branch-extractor.service';
export * from '@/services/extraction/page-extractor.service';
