/**
 * Cache-path regression suite.
 *
 * Guards the invariant that no filesystem path in the geocoding cache is
 * anchored on `process.cwd()`. A cwd-anchored cache writes next to the
 * process, so a run started from a different working directory created
 * `src/mastra/public/.cache/geocoding/kathmandu.json` — a stray directory
 * that then had to be documented as a "known limitation".
 *
 * Fully offline and deterministic: no network, no MongoDB. It exercises
 * directory resolution and the cache write path only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGeocodeCacheDir } from '@/services/resolution/geocoding.service';
import { getProjectRootDir } from '@/services/storage/db.service';

const REPO_ROOT = getProjectRootDir();
const STRAY_DIR = path.join(REPO_ROOT, 'src', 'mastra', 'public', '.cache');

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  PASS: ${label}`);
}

console.log('=== Geocoding cache-path regression suite ===\n');

// ---------------------------------------------------------------------------
// 1. The resolver is anchored on the project root, not the working directory.
// ---------------------------------------------------------------------------
console.log('1. Resolver is anchored on the project root');

check('project root contains package.json', () => {
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, 'package.json')),
    `expected a package.json at the resolved root ${REPO_ROOT}`
  );
});

check('getGeocodeCacheDir() === <project root>/.cache/geocoding', () => {
  const expected = path.join(REPO_ROOT, '.cache', 'geocoding');
  assert.equal(
    path.resolve(getGeocodeCacheDir()),
    path.resolve(expected),
    `cache dir must be root-anchored, got ${getGeocodeCacheDir()}`
  );
});

check('cache dir is inside the project root, not the cwd', () => {
  const resolved = path.resolve(getGeocodeCacheDir());
  assert.ok(
    resolved.startsWith(path.resolve(REPO_ROOT) + path.sep),
    `cache dir ${resolved} escaped the project root ${REPO_ROOT}`
  );
});

// ---------------------------------------------------------------------------
// 2. Resolution is independent of the working directory.
// ---------------------------------------------------------------------------
console.log('\n2. Resolution is independent of process.cwd()');

const beforeChdir = path.resolve(getGeocodeCacheDir());
const originalCwd = process.cwd();

check('cache dir unchanged after chdir to an external directory', () => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-cwd-probe-'));
  try {
    process.chdir(external);
    assert.notEqual(
      process.cwd(),
      originalCwd,
      'chdir did not take effect; the test would prove nothing'
    );
    const afterChdir = path.resolve(getGeocodeCacheDir());
    assert.equal(
      afterChdir,
      beforeChdir,
      `cache dir changed with the working directory: ${beforeChdir} -> ${afterChdir}`
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(external, { recursive: true, force: true });
  }
});

check('getProjectRootDir() unchanged after chdir', () => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'root-cwd-probe-'));
  const before = getProjectRootDir();
  try {
    process.chdir(external);
    assert.equal(getProjectRootDir(), before, 'project root moved with the working directory');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(external, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. The cache write path never creates a stray directory.
// ---------------------------------------------------------------------------
console.log('\n3. Cache write path creates no stray directory');

check('src/mastra/public/.cache does not exist before writing', () => {
  assert.equal(
    fs.existsSync(STRAY_DIR),
    false,
    `stray directory present before the write: ${STRAY_DIR}`
  );
});

check('writing through the resolver does not create the stray directory', () => {
  const dir = getGeocodeCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, 'cwd-regression-probe.json');
  fs.writeFileSync(probe, JSON.stringify({ probe: true }), 'utf8');
  try {
    assert.ok(fs.existsSync(probe), 'probe file was not written where expected');
    assert.equal(
      fs.existsSync(STRAY_DIR),
      false,
      `writing the cache created a stray directory: ${STRAY_DIR}`
    );
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

check('no .cache directory anywhere under src/mastra/public', () => {
  const publicDir = path.join(REPO_ROOT, 'src', 'mastra', 'public');
  if (!fs.existsSync(publicDir)) return; // never created — nothing to scan.
  const walk = (dir: string): string[] => {
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.cache') found.push(full);
        found.push(...walk(full));
      }
    }
    return found;
  };
  assert.deepEqual(walk(publicDir), [], `stray .cache directories found: ${walk(publicDir)}`);
});

console.log(`\n=== All ${passed} geocoding cache-path assertions passed ===`);
