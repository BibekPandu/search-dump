/**
 * MongoDB Storage Service — M1
 * Last reviewed: 2026-09-25
 * Source: M1 storage + cache lookup plan v3 (corrections C1-C10, review fixes FIX-1..FIX-5)
 *
 * Responsibilities (and NON-responsibilities):
 *   1. Persist merged business identity into `businesses` (normal path only).
 *   2. Persist every run's exact snapshot into `runs` (normal AND cache-hit paths).
 *   3. Serve the Step 1 cache-first guard via `lookupFreshRun`.
 *   It does NOT touch Mastra's LibSQL store (mastra.db), and it never throws into
 *   the pipeline: MongoDB absent, unreachable, or empty degrades to a cache miss
 *   and a full pipeline run.
 *
 * Identity contract (correction C4):
 *   canonicalKey = `name:<normalizeNameKey(name)>|<locationKey>`.
 *   `listing.location` is a STREET ADDRESS in real output (e.g.
 *   "M7P2+87G, Satungal-Matatirtha Rd, Chandragiri, …"), never a locality, so the
 *   locality must come from the RUN's location. Rationale is the codebase's own
 *   identity principle: a false non-match is safer than a false merge
 *   (entity-resolution.service.ts:171-176).
 *
 * Write contract (Amendment 1 + 2):
 *   $set         replace-latest scalars/objects, guarded against empty clobbering
 *   $addToSet    accumulate phones/mobiles/emails/websites + derived digits/domains
 *                + sourceRunIds (fixes silent array clobbering)
 *   $setOnInsert canonicalKey, firstSeenAt, createdAt — bookkeeping is NEVER in
 *                $set, otherwise MongoDB errors: cannot update 'firstSeenAt' at
 *                the same time
 */
import 'dotenv/config';
import { MongoClient, type AnyBulkWriteOperation, type Db, type Document } from 'mongodb';
import {
  normalizeNameKey,
  normalizePhoneDigits,
  domainFromUrlOrHost,
} from './entity-resolution.service';
import { extractCanonicalLocality } from './geocoding.service';
import { DEFAULT_MAX_AGE_DAYS, normalizeQueryKeyPart } from '../config/freshness.config';
import type { BusinessListing } from '../mastra/workflows/research-workflow';

// ============================================================================
// Constants & Types
// ============================================================================

export const BUSINESSES_COLLECTION = 'businesses';
export const RUNS_COLLECTION = 'runs';
export const DEFAULT_DB_NAME = 'business_directory';

/** Statuses whose snapshots the cache-first guard is allowed to serve. */
export const CACHEABLE_RUN_STATUSES = ['success', 'empty'] as const;

/**
 * Run-record statuses. 'empty' means: the pipeline completed honestly and found
 * zero listings (e.g. SPA & Sauna in Satungal). It is cacheable, which is what
 * makes repeat empty queries free instead of a full re-run.
 */
export type RunRecordStatus = 'success' | 'empty' | 'failed' | 'cache-hit';

export type MongoConnectionState = 'unknown' | 'connected' | 'disabled' | 'unreachable';

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

export interface UpsertContext {
  query: string;
  location?: string;
  runId: string;
  completedAt: Date;
  /** Normal path only. A cache hit must never move lastVerifiedAt. */
  markVerified?: boolean;
}

export interface UpsertResult {
  total: number;
  inserted: number;
  modified: number;
  matched: number;
  skipped: number;
  reason?: string;
  perCandidateStatus?: Map<string, 'persisted' | 'upsert_failed'>;
}

export interface LookupHit {
  runId: string;
  completedAt: Date;
  status: RunRecordStatus;
  listingCount: number;
  listings: BusinessListing[];
}

export interface MongoDocParts {
  filter: Document;
  set: Document;
  addToSet: Document;
  setOnInsert: Document;
}

/**
 * Mongo schema for the `runs` collection. `_id` is the run-session id (a string),
 * declared explicitly because the driver otherwise infers `_id: ObjectId` and
 * rejects string-keyed filters/upserts.
 */
export type RunRecordDocument = Document & { _id: string };

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

// ============================================================================
// Pure helpers (unit-testable without a live database)
// ============================================================================

/** Collapses whitespace + case so dirty stored values still match. */
export function normalizeKeyPart(value?: string | null): string {
  return normalizeQueryKeyPart(value);
}

/**
 * Derives the three lookup keys for a run. `locationKey` is the exact normalized
 * location; `localityKey` is the canonical registry form, stored for M2 so
 * widening locality matching never requires re-seeding.
 */
export function buildCacheKeys(query: string, location?: string): CacheKeys {
  const locationKey = normalizeKeyPart(location);
  let localityKey = '';
  try {
    localityKey = normalizeKeyPart(extractCanonicalLocality(location || ''));
  } catch {
    localityKey = '';
  }
  return { queryKey: normalizeKeyPart(query), locationKey, localityKey };
}

/**
 * Deterministic business identity: name + run locality.
 * Returns '' when the name carries no usable identity signal (caller skips it).
 */
export function canonicalKeyFor(listing: BusinessListing, locationKey: string): string {
  const name = typeof listing?.name === 'string' ? listing.name.trim() : '';
  const nameKey = normalizeNameKey(name);
  if (!nameKey) return '';
  return `name:${nameKey}|${locationKey || 'unknown-location'}`;
}

/** MongoDB 2dsphere requires [longitude, latitude]; only emitted when BOTH exist. */
export function toGeoPoint(
  gps?: { latitude?: number; longitude?: number } | null
): [number, number] | null {
  const lat = gps?.latitude;
  const lng = gps?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return [lng, lat];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function nonEmptyStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pushEach(target: Document, field: string, values: string[]): void {
  if (values.length === 0) return;
  target[field] = { $each: values };
}

// ============================================================================
// Document mapping
// ============================================================================

/**
 * Maps one pipeline listing onto MongoDB write parts.
 * Returns null when the listing has no usable identity key (name-only collision
 * guard): such a listing is counted as skipped instead of polluting the store.
 *
 * Field sources verified against real output/latest/businesses.json (correction C3):
 *   address / categories / websiteRelationship / discoveryState live in
 *   `otherDetails`; confidence lives in `metadata`; there is NO top-level
 *   `normalizedName` or `primaryCategory` in businessListingSchema — both are
 *   DERIVED here.
 */
export function toMongoDoc(listing: BusinessListing, ctx: UpsertContext): MongoDocParts | null {
  const { locationKey } = buildCacheKeys(ctx.query, ctx.location);
  const canonicalKey = canonicalKeyFor(listing, locationKey);
  if (!canonicalKey) return null;

  const details: Record<string, unknown> = isRecord(listing.otherDetails) ? listing.otherDetails : {};
  const metadata: Record<string, unknown> = isRecord(listing.metadata) ? listing.metadata : {};

  const name = pickString(listing.name);
  const normalizedName = normalizeNameKey(name);
  const categories = cleanStringArray(details.categories);
  const address = pickString(details.address) || pickString(listing.location);
  const geo = toGeoPoint(listing.gpsCoordinates);
  const phones = cleanStringArray(listing.phones);
  const mobiles = cleanStringArray(listing.mobiles);
  const emails = cleanStringArray(listing.emails);
  const websites = cleanStringArray(listing.websites);
  const links = cleanStringArray(listing.links);

  const socialSource: Record<string, unknown> = isRecord(listing.socialLinks)
    ? listing.socialLinks
    : {};
  const socialLinks = {
    facebook: pickString(socialSource.facebook),
    instagram: pickString(socialSource.instagram),
    tiktok: pickString(socialSource.tiktok),
    other: isRecord(socialSource.other) ? socialSource.other : {},
  };
  const hasSocials = Boolean(
    socialLinks.facebook ||
      socialLinks.instagram ||
      socialLinks.tiktok ||
      Object.keys(socialLinks.other).length > 0
  );

  // ---- $set: replace-latest, guarded so an empty value never clobbers a known one
  const set: Document = { updatedAt: ctx.completedAt };
  const setIfText = (field: string, value: string) => {
    if (value) set[field] = value;
  };
  setIfText('name', name);
  setIfText('normalizedName', normalizedName);
  setIfText('location', pickString(listing.location));
  setIfText('address', address);
  setIfText('businessType', pickString(listing.businessType));
  setIfText('primaryCategory', categories[0] || '');
  setIfText('websiteRelationship', pickString(details.websiteRelationship));
  setIfText('discoveryState', pickString(details.discoveryState));
  setIfText('icon', pickString(listing.icon));
  setIfText('process', pickString(listing.process));
  setIfText('placeId', pickString(listing.placeId));

  if (categories.length > 0) set.categories = categories;
  if (links.length > 0) set.links = links;
  if (geo) set.geo = geo;
  if (hasSocials) set.socialLinks = socialLinks;
  if (Object.keys(details).length > 0) set.details = details;

  if (typeof metadata.confidence === 'number' && Number.isFinite(metadata.confidence)) {
    set.confidence = metadata.confidence;
  }
  if (typeof listing.rating === 'number' && Number.isFinite(listing.rating)) {
    set.rating = listing.rating;
  }
  if (typeof listing.ratingCount === 'number' && Number.isFinite(listing.ratingCount)) {
    set.ratingCount = listing.ratingCount;
  }

  if (ctx.markVerified) {
    set.lastVerifiedAt = ctx.completedAt;
    set.lastSeenRunId = ctx.runId;
  }

  // ---- $addToSet: accumulation (Amendment 1 — fixes array clobbering)
  const addToSet: Document = {};
  pushEach(addToSet, 'phones', phones);
  pushEach(addToSet, 'mobiles', mobiles);
  pushEach(addToSet, 'emails', emails);
  pushEach(addToSet, 'websites', websites);
  pushEach(addToSet, 'phoneDigits', nonEmptyStrings(phones.map((p) => normalizePhoneDigits(p))));
  pushEach(addToSet, 'mobileDigits', nonEmptyStrings(mobiles.map((p) => normalizePhoneDigits(p))));
  pushEach(addToSet, 'domains', nonEmptyStrings(websites.map((w) => domainFromUrlOrHost(w))));
  pushEach(addToSet, 'sourceRunIds', [ctx.runId]);

  // ---- $setOnInsert: identity + bookkeeping (Amendment 2 — never in $set)
  const setOnInsert: Document = {
    canonicalKey,
    firstSeenAt: ctx.completedAt,
    createdAt: ctx.completedAt,
  };

  return { filter: { canonicalKey }, set, addToSet, setOnInsert };
}

// ============================================================================
// Connection management
// Lazy by design: env is read at CONNECT time, so a test can set
// MONGODB_DB_NAME=business_directory_test before importing this module and never
// touch production data (correction C9).
// ============================================================================

let client: MongoClient | null = null;
let db: Db | null = null;
let connectionState: MongoConnectionState = 'unknown';
let loggedDisabled = false;
let loggedUnreachable = false;

export function isMongoConfigured(): boolean {
  return Boolean(process.env.MONGODB_URI?.trim());
}

export function getMongoDbName(): string {
  const name = process.env.MONGODB_DB_NAME?.trim();
  return name || DEFAULT_DB_NAME;
}

export function getLastMongoState(): MongoConnectionState {
  return connectionState;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Connects once per process. Never throws: returns null and logs the reason. */
export async function getMongo(): Promise<Db | null> {
  if (db) return db;
  if (connectionState === 'disabled' || connectionState === 'unreachable') return null;

  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    connectionState = 'disabled';
    if (!loggedDisabled) {
      loggedDisabled = true;
      console.log('[mongo] disabled — MONGODB_URI not set (cache lookup skipped)');
    }
    return null;
  }

  try {
    const next = new MongoClient(uri, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
    await next.connect();
    const nextDb = next.db(getMongoDbName());
    await ensureIndexes(nextDb);
    client = next;
    db = nextDb;
    connectionState = 'connected';
    return db;
  } catch (err) {
    connectionState = 'unreachable';
    if (!loggedUnreachable) {
      loggedUnreachable = true;
      console.warn(`[mongo] unreachable — ${describeError(err)} (cache lookup skipped)`);
    }
    return null;
  }
}

export async function pingMongo(): Promise<boolean> {
  const target = await getMongo();
  if (!target) return false;
  try {
    await target.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function closeMongo(): Promise<void> {
  const previous = client;
  client = null;
  db = null;
  connectionState = 'unknown';
  loggedDisabled = false;
  loggedUnreachable = false;
  if (previous) {
    try {
      await previous.close();
    } catch {
      // best-effort close
    }
  }
}

/** Idempotent. Called from getMongo(); safe to call from tests/scripts too. */
export async function ensureIndexes(target?: Db): Promise<void> {
  const next = target ?? (await getMongo());
  if (!next) return;
  try {
    const businesses = next.collection(BUSINESSES_COLLECTION);
    await businesses.createIndex({ canonicalKey: 1 }, { unique: true, name: 'canonicalKey_unique' });
    await businesses.createIndex({ geo: '2dsphere' }, { name: 'geo_2dsphere' });
    await businesses.createIndex({ phoneDigits: 1 }, { name: 'phoneDigits_asc' });
    await businesses.createIndex({ mobileDigits: 1 }, { name: 'mobileDigits_asc' });
    await businesses.createIndex({ domains: 1 }, { name: 'domains_asc' });
    await businesses.createIndex({ placeId: 1 }, { name: 'placeId_sparse', sparse: true });
    await businesses.createIndex({ lastVerifiedAt: -1 }, { name: 'lastVerifiedAt_desc' });

    const runs = next.collection(RUNS_COLLECTION);
    await runs.createIndex(
      { queryKey: 1, locationKey: 1, completedAt: -1 },
      { name: 'lookup_path_completedAt' }
    );
    await runs.createIndex({ queryKey: 1, locationKey: 1, status: 1 }, { name: 'lookup_path_status' });
    await runs.createIndex({ completedAt: -1 }, { name: 'completedAt_desc' });
  } catch (err) {
    console.warn(`[mongo] index setup failed — ${describeError(err)}`);
  }
}

// ============================================================================
// Write paths
// ============================================================================

/** Canonical keys for a listing set, deduped, empties dropped. Shared with scripts. */
export function collectCanonicalKeys(listings: BusinessListing[], locationKey: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const listing of listings) {
    const key = canonicalKeyFor(listing, locationKey);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Merges final listings into `businesses`. NORMAL PATH ONLY — a cache hit must
 * never call this, because nothing was re-verified and lastVerifiedAt must not move.
 */
export async function upsertBusinesses(
  listings: BusinessListing[],
  ctx: UpsertContext
): Promise<UpsertResult> {
  const total = Array.isArray(listings) ? listings.length : 0;
  const base: UpsertResult = { total, inserted: 0, modified: 0, matched: 0, skipped: 0 };
  if (total === 0) return base;

  const target = await getMongo();
  if (!target) return { ...base, skipped: total, reason: getLastMongoState() };

  const completedAt = ctx.completedAt instanceof Date ? ctx.completedAt : new Date();
  const writeCtx: UpsertContext = { ...ctx, completedAt, markVerified: ctx.markVerified !== false };

  const ops: AnyBulkWriteOperation<Document>[] = [];
  let skipped = 0;
  for (const listing of listings) {
    const parts = toMongoDoc(listing, writeCtx);
    if (!parts) {
      skipped++;
      continue;
    }
    ops.push({
      updateOne: {
        filter: parts.filter,
        update: {
          $set: parts.set,
          ...(Object.keys(parts.addToSet).length > 0 ? { $addToSet: parts.addToSet } : {}),
          $setOnInsert: parts.setOnInsert,
          $inc: { runCount: 1 },
        },
        upsert: true,
      },
    });
  }
  if (skipped > 0) {
    console.warn(`[mongo] skipped ${skipped} listing(s) with no usable identity key`);
  }
  if (ops.length === 0) return { ...base, skipped };

  try {
    const result = await target.collection(BUSINESSES_COLLECTION).bulkWrite(ops, { ordered: false });
    const summary: UpsertResult = {
      total,
      inserted: result.upsertedCount,
      modified: result.modifiedCount,
      matched: result.matchedCount,
      skipped,
    };
    
    const perCandidateStatus = new Map<string, 'persisted' | 'upsert_failed'>();
    // Handle mongodb driver type inconsistencies for getWriteErrors
    const writeErrors = (result as any).getWriteErrors?.() ?? [];
    ops.forEach((op, index) => {
      const filterKey = (op as any).updateOne?.filter?.canonicalKey || `op_${index}`;
      const hasError = writeErrors.some((e: any) => e.index === index);
      perCandidateStatus.set(filterKey, hasError ? 'upsert_failed' : 'persisted');
    });
    
    summary.perCandidateStatus = perCandidateStatus;
    
    console.log(
      `[mongo] upserted ${ops.length} businesses (inserted ${summary.inserted} / modified ${summary.modified}) for run ${ctx.runId}`
    );
    return summary;
  } catch (err) {
    console.warn(`[mongo] upsert failed — ${describeError(err)}`);
    return { ...base, skipped: total, reason: describeError(err) };
  }
}

// ============================================================================
// Cache-first lookup (read path)
// ============================================================================

/**
 * Returns the newest cacheable run snapshot for (query, location) younger than
 * `maxAgeDays`, or null. Never throws: unset URI, unreachable server, or an empty
 * collection all degrade to a miss.
 *
 * 'success' AND 'empty' are both cacheable (review FIX-2): a run that honestly
 * found zero businesses is valid data, and re-running it costs full pipeline money
 * for the same empty answer.
 */
export async function lookupFreshRun(
  query: string,
  location?: string,
  maxAgeDays: number = DEFAULT_MAX_AGE_DAYS
): Promise<LookupHit | null> {
  const { queryKey, locationKey } = buildCacheKeys(query, location);
  if (!queryKey) return null;

  const age = Number.isFinite(maxAgeDays) && maxAgeDays >= 0 ? maxAgeDays : DEFAULT_MAX_AGE_DAYS;
  const cutoff = new Date(Date.now() - age * 86400000);

  const target = await getMongo();
  if (!target) return null;

  try {
    const doc = (await target
      .collection<RunRecordDocument>(RUNS_COLLECTION)
      .findOne(
        {
          queryKey,
          locationKey,
          status: { $in: [...CACHEABLE_RUN_STATUSES] },
          completedAt: { $gt: cutoff },
        },
        { sort: { completedAt: -1 } }
      )) as unknown as MongoRunRecord | null;

    if (!doc) {
      console.log(
        `[cache] miss — no fresh run {${queryKey} | ${locationKey || '-'}} within ${age}d`
      );
      return null;
    }

    const listings = Array.isArray(doc.listings) ? (doc.listings as BusinessListing[]) : [];
    const completedAt =
      doc.completedAt instanceof Date
        ? doc.completedAt
        : new Date(String(doc.completedAt ?? Date.now()));
    const ageDays = Math.max(0, (Date.now() - completedAt.getTime()) / 86400000);

    console.log(
      `[cache] HIT — run ${String(doc._id)} (age ${ageDays.toFixed(2)}d, ${listings.length} listings) → skipping discovery + extraction + synthesis`
    );

    return {
      runId: String(doc._id),
      completedAt,
      status: (doc.status as RunRecordStatus) ?? 'success',
      listingCount: listings.length,
      listings,
    };
  } catch (err) {
    console.warn(`[mongo] lookup failed — ${describeError(err)} (cache lookup skipped)`);
    return null;
  }
}

// ============================================================================
// Run history (every run, both paths)
// ============================================================================

/**
 * Upserts the run record keyed on `_id`, never inserts blindly (review FIX-1):
 * a resumed workflow re-writing the same runId must not crash on a duplicate key.
 * `startedAt` is immutable and only set on insert.
 */
export async function saveRunRecord(record: SaveRunRecordInput): Promise<boolean> {
  const target = await getMongo();
  if (!target) return false;

  const { queryKey, locationKey, localityKey } = buildCacheKeys(record.query, record.location);
  const listings = Array.isArray(record.listings) ? record.listings : [];
  const completedAt = record.completedAt instanceof Date ? record.completedAt : new Date();

  try {
    await target.collection<RunRecordDocument>(RUNS_COLLECTION).updateOne(
      { _id: record.runId },
      {
        $set: {
          query: record.query,
          queryKey,
          location: record.location ?? '',
          locationKey,
          localityKey,
          completedAt,
          status: record.status,
          servedFromCache: Boolean(record.servedFromCache),
          refreshRequested: Boolean(record.refreshRequested),
          inputConfig: record.inputConfig ?? {},
          listingCount: listings.length,
          canonicalKeys: collectCanonicalKeys(listings, locationKey),
          listings,
        },
        $setOnInsert: {
          startedAt: record.startedAt instanceof Date ? record.startedAt : completedAt,
        },
      },
      { upsert: true }
    );
    console.log(
      `[mongo] run record saved ${record.runId} status=${record.status} listings=${listings.length}`
    );
    return true;
  } catch (err) {
    console.warn(`[mongo] run record failed — ${describeError(err)}`);
    return false;
  }
}





