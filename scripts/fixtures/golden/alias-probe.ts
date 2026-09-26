/**
 * Phase 0 (0.5) — path-alias resolution probe (temporary spike artifact).
 *
 * Compiled by `tsc -p tsconfig.json` because tsconfig includes the scripts tree,
 * executed by `tsx`, and therefore proves alias resolution in two of the three
 * environments the Phase 0 plan requires.
 */
import { NTA_MOBILE_PREFIXES } from '@/config/nepal-telecom.config';
import { classifyNepalPhone } from '@/services/business-extractor.service';

const probe = classifyNepalPhone('+977 985-1180403');

console.log(
  `alias-probe(tsx/tsc): prefixes=${NTA_MOBILE_PREFIXES.length} type=${probe.type} digits=${probe.digits}`
);
