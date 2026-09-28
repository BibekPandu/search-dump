/**
 * Phase 0 (R2) — Semantic golden canonicalization + diff.
 *
 * Canonicalizes stable business data before diffing so that replay comparisons
 * are semantic rather than byte-literal:
 *   - volatile metadata is stripped (timestamps, ids, run bookkeeping)
 *   - lists are sorted by business-meaningful keys
 *   - URLs are normalized with the production `normalizeUrl` rules
 *   - floats (confidence scores, distances) are rounded to 4 decimals
 *
 * CLI:
 *   npx tsx scripts/fixtures/golden/compare.ts <a.json> <b.json> [--max-diffs 20]
 * Exit code 1 when the two documents differ semantically.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeUrl } from '@/services/discovery/search-fallback.service';

/** Keys whose values are run-scoped bookkeeping and never semantically meaningful. */
export const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  'runId',
  '_id',
  'createdAt',
  'updatedAt',
  'extractedAt',
  'runStartedAt',
  'startedAt',
  'finishedAt',
  'timestamp',
  'searchedAt',
  'firstSeenAt',
  'lastSeenAt',
  'lastCheckedAt',
  'sourceRunIds',
  'generatedAt',
  'capturedAt',
]);

const URL_LIKE = /^https?:\/\//i;
const FLOAT_PRECISION = 4;

function roundFloat(value: number): number {
  const factor = 10 ** FLOAT_PRECISION;
  return Math.round(value * factor) / factor;
}

function canonicalizeString(value: string): string {
  const trimmed = value.trim();
  if (URL_LIKE.test(trimmed)) return normalizeUrl(trimmed);
  return value;
}

/** Comparator key for deterministic list ordering (listings, contacts, branches, socials). */
function sortKeyFor(item: unknown): string {
  if (item === null || typeof item !== 'object') return JSON.stringify(item) ?? '';
  const record = item as Record<string, unknown>;

  const name = typeof record.name === 'string' ? record.name : '';
  if (name) {
    const locality =
      typeof record.location === 'string'
        ? record.location
        : typeof record.address === 'string'
          ? record.address
          : '';
    return `name:${name.toLowerCase()}|${locality.toLowerCase()}`;
  }

  const value = typeof record.value === 'string' ? record.value : '';
  if (value) {
    const type = typeof record.type === 'string' ? record.type : '';
    return `contact:${value.toLowerCase()}|${type}`;
  }

  const platform = typeof record.platform === 'string' ? record.platform : '';
  const handle = typeof record.handle === 'string' ? record.handle : '';
  if (platform || handle) return `social:${platform.toLowerCase()}|${handle.toLowerCase()}`;

  const url = typeof record.url === 'string' ? record.url : '';
  if (url) return `url:${url.toLowerCase()}`;

  return JSON.stringify(record) ?? '';
}

export function canonicalize(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? roundFloat(value) : value;
  if (typeof value === 'string') return canonicalizeString(value);
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item) ?? null);
    return items.sort((a, b) => sortKeyFor(a).localeCompare(sortKeyFor(b)));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      const canonical = canonicalize((value as Record<string, unknown>)[key]);
      // Mirrors JSON.stringify semantics: an absent key and an `undefined` value are the
      // same thing, so canonical output survives a write/read round-trip unchanged.
      if (canonical === undefined) continue;
      out[key] = canonical;
    }
    return out;
  }
  return value;
}

/** Stable stringify (object keys are already sorted by `canonicalize`). */
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2);
}

export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJsonString(value)).digest('hex');
}

export interface DiffEntry {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before: unknown;
  after: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function semanticDiff(before: unknown, after: unknown, basePath = '$'): DiffEntry[] {
  const diffs: DiffEntry[] = [];
  walk(canonicalize(before), canonicalize(after), basePath, diffs);
  return diffs;
}

function walk(before: unknown, after: unknown, currentPath: string, diffs: DiffEntry[]): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of Object.keys(before)) {
      if (!(key in after)) {
        diffs.push({
          path: `${currentPath}.${key}`,
          kind: 'removed',
          before: before[key],
          after: undefined,
        });
        continue;
      }
      walk(before[key], after[key], `${currentPath}.${key}`, diffs);
    }
    for (const key of Object.keys(after)) {
      if (!(key in before)) {
        diffs.push({ path: `${currentPath}.${key}`, kind: 'added', before: undefined, after: after[key] });
      }
    }
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      diffs.push({
        path: `${currentPath}.length`,
        kind: 'changed',
        before: before.length,
        after: after.length,
      });
    }
    const max = Math.max(before.length, after.length);
    for (let index = 0; index < max; index += 1) {
      walk(before[index], after[index], `${currentPath}[${index}]`, diffs);
    }
    return;
  }

  if (JSON.stringify(before) !== JSON.stringify(after)) {
    diffs.push({ path: currentPath, kind: 'changed', before, after });
  }
}

export function summarizeDiffs(diffs: DiffEntry[], maxEntries = 20): string {
  if (diffs.length === 0) return 'no semantic differences';
  const lines = [`${diffs.length} semantic difference(s):`];
  for (const diff of diffs.slice(0, maxEntries)) {
    lines.push(
      `  [${diff.kind}] ${diff.path}\n    before: ${JSON.stringify(diff.before)}\n    after:  ${JSON.stringify(diff.after)}`
    );
  }
  if (diffs.length > maxEntries) lines.push(`  ... ${diffs.length - maxEntries} more`);
  return lines.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  let maxDiffs = 20;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--max-diffs') {
      maxDiffs = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (args[index].startsWith('--')) continue;
    positional.push(args[index]);
  }
  const [aPath, bPath] = positional;

  if (!aPath || !bPath) {
    console.error('Usage: npx tsx scripts/fixtures/golden/compare.ts <a.json> <b.json> [--max-diffs N]');
    process.exit(2);
  }

  const before = JSON.parse(fs.readFileSync(path.resolve(aPath), 'utf8')) as unknown;
  const after = JSON.parse(fs.readFileSync(path.resolve(bPath), 'utf8')) as unknown;

  const diffs = semanticDiff(before, after);
  console.log(summarizeDiffs(diffs, maxDiffs));
  if (diffs.length === 0) console.log(`sha256(canonical) = ${hashCanonical(before)}`);
  process.exit(diffs.length === 0 ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) main();

