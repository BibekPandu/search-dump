import { z } from 'zod';

export const ledgerStatusEnum = z.enum([
  'persisted',
  'synthesis_omission',
  'verification_failed',
  'zero_actionable_fields',
  'geography_rejected',
  'provider_exhausted',
  'deduplicated',
  'category_rejected',
  'budget_skipped',
  'upsert_failed',
]);

export type LedgerStatus = z.infer<typeof ledgerStatusEnum>;
