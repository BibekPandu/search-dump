import type { BusinessListing } from './business-listing.js';

export interface RunInputConfig {
  maxMapsPages?: number;
  maxPages?: number;
  websiteDiscoveryMode?: string;
  maxWebsiteDiscoveryLookups?: number;
  targetCandidates?: number;
  maxCacheAgeDays?: number;
}

export interface MongoRunRecord {
  _id: string;
  query: string;
  queryKey: string;
  location: string;
  locationKey: string;
  localityKey: string;
  completedAt: Date;
  status: RunRecordStatus;
  servedFromCache: boolean;
  refreshRequested: boolean;
  inputConfig: RunInputConfig;
  listingCount: number;
  canonicalKeys: string[];
  listings: BusinessListing[];
}

export type RunRecordStatus = 'success' | 'empty' | 'failed' | 'cache-hit';

export interface CacheKeys {
  queryKey: string;
  locationKey: string;
  localityKey: string;
}

/**
 * Caller-facing input for `saveRunRecord`. Deliberately decoupled from the stored
 * document shape: keys, counts and canonical keys are DERIVED inside the service so
 * a caller can never write an inconsistent run record.
 */
export interface SaveRunRecordInput {
  /** Mongo `_id` of the run record (the run-session id). */
  runId: string;
  query: string;
  location?: string;
  status: RunRecordStatus;
  listings: BusinessListing[];
  servedFromCache?: boolean;
  refreshRequested?: boolean;
  inputConfig?: RunInputConfig;
  completedAt?: Date;
  /** Immutable run origin, written only on insert. Defaults to completedAt. */
  startedAt?: Date;
}
