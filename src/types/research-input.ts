export interface RunResearchDiscoveryInput {
  query: string;
  location?: string;
  autoApprove?: boolean;
  agentId?: string;
  targetCandidates?: number;
  maxPages?: number;
  maxMapsPages?: number;
  /**
   * Phase 7a Task 2: website discovery budget mode.
   * 'benchmark' = every eligible candidate (hard-capped per run),
   * 'production' = default 10 lookups per run.
   * Precedence: this input > env DISCOVERY_MODE > 'production'.
   */
  websiteDiscoveryMode?: string;
  /**
   * Phase 7a Task 2: explicit per-run lookup budget override.
   * Still clamped by the hard ceiling and by the eligible candidate count.
   * Independent of targetCandidates.
   */
  maxWebsiteDiscoveryLookups?: number;
  /**
   * M1: explicit cache bypass. When true the Step 1 cache-first guard is skipped
   * and a full pipeline run executes, then the fresh snapshot replaces the cache.
   */
  refresh?: boolean;
  /**
   * M1: override the freshness window for this run (days). Precedence:
   * this input > env CACHE_MAX_AGE_DAYS > category policy > default 30.
   */
  maxCacheAgeDays?: number;
}
