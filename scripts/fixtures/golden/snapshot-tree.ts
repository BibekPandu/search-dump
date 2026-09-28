/**
 * Phase 0 (R4) — Test-output isolation tooling.
 *
 * Produces a deterministic, content-addressed snapshot of a directory tree
 * (relative path + byte size + sha256) so the Phase 0 plan can empirically
 * prove that running the test suites never mutates `output/latest`,
 * `output/history` or the runtime `.cache` directory.
 *
 * Usage:
 *   npx tsx scripts/fixtures/golden/snapshot-tree.ts <dir> [--out <file.json>]
 *
 * The snapshot is written as JSON to stdout when `--out` is omitted. Exit code
 * is always 0 for a successful snapshot; `--compare <a.json> <b.json>` diffs two
 * snapshots and exits 1 when they differ.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SnapshotEntry {
  /** Path relative to the snapshot root, always with POSIX separators. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface TreeSnapshot {
  root: string;
  capturedAt: string;
  fileCount: number;
  totalBytes: number;
  files: SnapshotEntry[];
}

export interface SnapshotDiff {
  identical: boolean;
  added: string[];
  removed: string[];
  changed: string[];
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

/** Recursively snapshot every regular file below `root` (missing root = empty tree). */
export function snapshotTree(root: string): TreeSnapshot {
  const files: SnapshotEntry[] = [];

  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const contents = fs.readFileSync(abs);
      files.push({
        path: toPosix(path.relative(root, abs)),
        bytes: contents.byteLength,
        sha256: createHash('sha256').update(contents).digest('hex'),
      });
    }
  };

  if (fs.existsSync(root)) walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    root: path.resolve(root),
    capturedAt: new Date().toISOString(),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

/** Compare two snapshots by relative path + content hash. */
export function diffSnapshots(before: TreeSnapshot, after: TreeSnapshot): SnapshotDiff {
  const beforeMap = new Map(before.files.map((file) => [file.path, file.sha256]));
  const afterMap = new Map(after.files.map((file) => [file.path, file.sha256]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [file, hash] of afterMap) {
    const previous = beforeMap.get(file);
    if (previous === undefined) added.push(file);
    else if (previous !== hash) changed.push(file);
  }
  for (const file of beforeMap.keys()) {
    if (!afterMap.has(file)) removed.push(file);
  }

  added.sort();
  removed.sort();
  changed.sort();

  return {
    identical: added.length === 0 && removed.length === 0 && changed.length === 0,
    added,
    removed,
    changed,
  };
}

/** Human-readable one-block summary used by the Phase 0 report. */
export function summarizeDiff(diff: SnapshotDiff): string {
  if (diff.identical) return 'identical: no added, removed or changed files';
  return [
    `added=${diff.added.length}`,
    `removed=${diff.removed.length}`,
    `changed=${diff.changed.length}`,
    diff.added.length ? `  + ${diff.added.join('\n  + ')}` : '',
    diff.removed.length ? `  - ${diff.removed.join('\n  - ')}` : '',
    diff.changed.length ? `  ~ ${diff.changed.join('\n  ~ ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function writeSnapshot(target: string, snapshot: TreeSnapshot): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

function readSnapshot(target: string): TreeSnapshot {
  return JSON.parse(fs.readFileSync(target, 'utf8')) as TreeSnapshot;
}

function main(): void {
  const args = process.argv.slice(2);

  if (args[0] === '--compare') {
    const before = readSnapshot(args[1]);
    const after = readSnapshot(args[2]);
    const diff = diffSnapshots(before, after);
    console.log(summarizeDiff(diff));
    process.exit(diff.identical ? 0 : 1);
  }

  const root = args[0];
  if (!root) {
    console.error(
      'Usage: npx tsx scripts/fixtures/golden/snapshot-tree.ts <dir> [--out <file.json>]'
    );
    process.exit(2);
  }

  const snapshot = snapshotTree(root);
  const outIndex = args.indexOf('--out');
  if (outIndex >= 0 && args[outIndex + 1]) {
    writeSnapshot(args[outIndex + 1], snapshot);
    console.log(
      `snapshot written: ${path.resolve(args[outIndex + 1])} (${snapshot.fileCount} files, ${snapshot.totalBytes} bytes)`
    );
    return;
  }

  console.log(JSON.stringify(snapshot, null, 2));
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) main();
