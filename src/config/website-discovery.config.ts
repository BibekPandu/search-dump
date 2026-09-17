/**
 * Website Discovery Budget Policy — Version 1
 * Last reviewed: 2026-09-16
 * Source: Phase 7a Task 2 (Ever Vision Satungal forensic trace — research-workflow.ts:310-318)
 *
 * Scope contract:
 *   This policy governs ONLY how many Google Maps candidates that lack a website
 *   are permitted a targeted web lookup during Phase 0 discovery.
 *   It does NOT decide whether a candidate is evaluated (Phase 7a Task 3) and it
 *   does NOT cap deep extraction (research-workflow.ts:920-936 — explicitly out
 *   of scope for Phase 7a; that existing control is preserved unchanged).
 *
 * Historical note (Task 1 forensic finding):
 *   The production call site previously derived its budget from `targetCandidates`
 *   (`Math.max(targetCandidates, 10)`), silently coupling discovery cost to the
 *   candidate target with no observability, while `rankWebsiteLookupTargets`
 *   carried a `limit = 3` default that was never used in production. This module
 *   replaces both: the budget is explicit, mode-driven, per run, and reported.
 */

export type WebsiteDiscoveryMode = 'production' | 'benchmark';

/** Modes accepted by input or env. Anything else falls back to 'production'. */
export const VALID_WEBSITE_DISCOVERY_MODES: readonly WebsiteDiscoveryMode[] = ['production', 'benchmark'];

/** Default budget for production mode — PER RUN, not per candidate. */
export const PRODUCTION_DEFAULT_WEBSITE_DISCOVERY_LOOKUPS = 10;

/**
 * Hard ceiling applied in EVERY mode (including benchmark and explicit caps).
 * PER RUN, not per candidate. One lookup may consume up to 2 search queries
 * (Phase 7a Task 5), so worst-case query volume is ceiling * 2.
 */
export const ABSOLUTE_MAX_WEBSITE_DISCOVERY_LOOKUPS = 50;

export interface ResolveWebsiteDiscoveryBudgetParams {
  /** Number of candidates eligible for a lookup (placesNeedingEnrichment.length). */
  eligibleCount: number;
  /** Explicit per-run override (workflow input). Takes precedence over mode defaults. */
  explicitCap?: number;
  /** Caller-supplied mode (workflow input). Falls back to DISCOVERY_MODE, then 'production'. */
  mode?: string;
  /** Injectable env for deterministic offline tests. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export interface WebsiteDiscoveryBudget {
  mode: WebsiteDiscoveryMode;
  /** Number of candidate lookups permitted for this run (already clamped). */
  lookupBudget: number;
  /** Eligible candidate count AFTER clamping analysis (>= 0). */
  eligibleCount: number;
  /** Hard ceiling in force for this run. */
  ceiling: number;
  /** True when an explicit input cap was accepted and drove the budget. */
  usedExplicitCap: boolean;
  /** Deterministic provenance string for logs + discovery telemetry (Task 8). */
  reason: string;
}

export interface WebsiteDiscoveryModeResolution {
  mode: WebsiteDiscoveryMode;
  /** Where the mode came from: 'input' | 'env:DISCOVERY_MODE' | 'default' (+ fallback notes). */
  source: string;
  /** Set when a caller/env value was supplied but rejected as invalid. */
  invalidRequested?: string;
}

/**
 * Resolves the discovery mode deterministically.
 * Precedence: explicit input > env DISCOVERY_MODE > 'production' (safe default).
 * An invalid value never throws — it degrades to 'production' and is reported.
 */
export function resolveWebsiteDiscoveryMode(
  requested?: string,
  env: Record<string, string | undefined> = process.env
): WebsiteDiscoveryModeResolution {
  const candidates: Array<{ value: string | undefined; source: string }> = [
    { value: requested, source: 'input' },
    { value: env.DISCOVERY_MODE, source: 'env:DISCOVERY_MODE' },
  ];

  for (const candidate of candidates) {
    if (candidate.value === undefined || candidate.value === null) continue;
    const trimmed = String(candidate.value).trim();
    if (trimmed.length === 0) continue;

    const normalized = trimmed.toLowerCase();
    if ((VALID_WEBSITE_DISCOVERY_MODES as readonly string[]).includes(normalized)) {
      return { mode: normalized as WebsiteDiscoveryMode, source: candidate.source };
    }

    // Invalid mode: deterministic degradation to the safe default.
    return {
      mode: 'production',
      source: `${candidate.source} invalid -> production`,
      invalidRequested: trimmed,
    };
  }

  return { mode: 'production', source: 'default' };
}

/**
 * Resolves the per-run website discovery lookup budget.
 *
 * Rules (Phase 7a Task 2):
 *   1. benchmark mode -> ALL eligible candidates, hard-capped at the ceiling.
 *   2. production mode -> default 10 per run.
 *   3. An explicit input cap takes precedence over mode defaults, but is still
 *      clamped by the ceiling and by the number of eligible candidates.
 *   4. targetCandidates is NOT an input here — the budget is fully decoupled.
 *   5. Never throws: invalid input degrades deterministically and is reported.
 */
export function resolveWebsiteDiscoveryBudget(
  params: ResolveWebsiteDiscoveryBudgetParams
): WebsiteDiscoveryBudget {
  const { eligibleCount, explicitCap, mode: requestedMode, env = process.env } = params;

  const safeEligible =
    typeof eligibleCount === 'number' && Number.isFinite(eligibleCount)
      ? Math.max(0, Math.floor(eligibleCount))
      : 0;

  const modeResolution = resolveWebsiteDiscoveryMode(requestedMode, env);
  const notes: string[] = [`mode=${modeResolution.mode} (${modeResolution.source})`];
  if (modeResolution.invalidRequested) {
    notes.push(`ignored invalid mode "${modeResolution.invalidRequested}"`);
  }

  const modeDesired =
    modeResolution.mode === 'benchmark'
      ? safeEligible
      : PRODUCTION_DEFAULT_WEBSITE_DISCOVERY_LOOKUPS;

  let desired = modeDesired;
  let usedExplicitCap = false;

  if (explicitCap !== undefined) {
    if (typeof explicitCap === 'number' && Number.isFinite(explicitCap) && explicitCap >= 0) {
      desired = Math.floor(explicitCap);
      usedExplicitCap = true;
      notes.push(`explicit cap ${desired} (input) overrides mode default ${modeDesired}`);
    } else {
      notes.push(`ignored invalid explicit cap "${String(explicitCap)}"`);
    }
  }

  let lookupBudget = desired;
  if (lookupBudget > ABSOLUTE_MAX_WEBSITE_DISCOVERY_LOOKUPS) {
    notes.push(`clamped to hard ceiling ${ABSOLUTE_MAX_WEBSITE_DISCOVERY_LOOKUPS} (per run)`);
    lookupBudget = ABSOLUTE_MAX_WEBSITE_DISCOVERY_LOOKUPS;
  }
  if (lookupBudget > safeEligible) {
    notes.push(`clamped to ${safeEligible} eligible candidate(s)`);
    lookupBudget = safeEligible;
  }

  return {
    mode: modeResolution.mode,
    lookupBudget,
    eligibleCount: safeEligible,
    ceiling: ABSOLUTE_MAX_WEBSITE_DISCOVERY_LOOKUPS,
    usedExplicitCap,
    reason: notes.join('; '),
  };
}

/**
 * Formats a budget decision for the existing `[Workflow:Step1]` log style, and
 * reports how many eligible candidates were NOT looked up — the silent-skip class
 * identified by the Task 1 forensic trace. This log line is what makes
 * "not searched" distinguishable from "searched and not found".
 */
export function formatWebsiteDiscoveryBudgetLog(
  budget: WebsiteDiscoveryBudget,
  placesNeedingEnrichment: number
): string {
  const safeEligible =
    typeof placesNeedingEnrichment === 'number' && Number.isFinite(placesNeedingEnrichment)
      ? Math.max(0, Math.floor(placesNeedingEnrichment))
      : 0;
  const notAttempted = Math.max(0, safeEligible - budget.lookupBudget);

  return (
    `Phase 0: website discovery budget = ${budget.lookupBudget}/${safeEligible} eligible ` +
    `(mode: ${budget.mode}, ceiling: ${budget.ceiling}, explicit cap: ${budget.usedExplicitCap}); ` +
    `not attempted: ${notAttempted} (DISCOVERY_NOT_ATTEMPTED_BUDGET) [${budget.reason}]`
  );
}