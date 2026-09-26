/**
 * Phase 3 gate: stale legacy-path import scan (R5 / review correction #4).
 *
 * After the Phase 3 regrouping, every legacy `src/services/*.ts` path is a
 * one-line re-export shim that exists only until Phase 9. This script proves
 * that NO production or harness code still routes through those shims:
 * every relative import must resolve to a canonical (sub-directory) module.
 *
 * Also validates the shim manifest against the real filesystem, so the
 * manifest can never drift from what was actually generated (review #7).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = process.cwd().replace(/\\/g, '/');
const MANIFEST_PATH = 'docs/phase0/artifacts/phase3-shims-manifest.json';

interface ShimEntry {
  legacyPath: string;
  canonicalPath: string;
  exportTarget: string;
}

// ---------------------------------------------------------------- helpers
function collectFiles(root: string, out: string[] = []): string[] {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'dist') {
        collectFiles(p, out);
      }
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

function toRepoRel(absolute: string): string {
  return path.resolve(absolute).replace(/\\/g, '/').replace(ROOT + '/', '');
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  const abs = path.resolve(path.dirname(fromFile), spec);
  const candidates = [abs, `${abs}.ts`, `${abs}.tsx`, abs.replace(/\.js$/, '.ts')];
  const hit = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
  return hit ? toRepoRel(hit) : null;
}

// ---------------------------------------------------- manifest consistency
const manifest: ShimEntry[] = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
const shimPaths = new Set(manifest.map((m) => m.legacyPath));
let violations = 0;

for (const entry of manifest) {
  if (!fs.existsSync(entry.legacyPath)) {
    console.error(`FAIL manifest: shim missing on disk -> ${entry.legacyPath}`);
    violations++;
  }
  if (!fs.existsSync(entry.canonicalPath)) {
    console.error(`FAIL manifest: canonical target missing -> ${entry.canonicalPath}`);
    violations++;
  }
  const shimSrc = fs.readFileSync(entry.legacyPath, 'utf-8');
  if (!shimSrc.includes(entry.exportTarget)) {
    console.error(`FAIL manifest: ${entry.legacyPath} does not re-export ${entry.exportTarget}`);
    violations++;
  }
}

// Every real shim on disk must be in the manifest (catch untracked shims).
for (const f of collectFiles('src/services')) {
  const rel = toRepoRel(f);
  const isSubdir = rel.slice('src/services/'.length).includes('/');
  if (isSubdir) continue; // canonical modules live in sub-directories
  const src = fs.readFileSync(f, 'utf-8');
  if (!/^export\s+(\*|\{|type\s*\{)/m.test(src)) continue; // not a re-export shim
  if (!shimPaths.has(rel)) {
    console.error(`FAIL manifest: shim on disk is NOT in the manifest -> ${rel}`);
    violations++;
  }
}

console.log(
  violations === 0
    ? `OK: manifest matches filesystem (${manifest.length} shims verified: exists + re-exports canonical target).`
    : `FAILED: ${violations} manifest inconsistencies.`,
);

// --------------------------------------------------------- stale imports
const files = [...collectFiles('src'), ...collectFiles('scripts'), ...collectFiles('tests')];
const SPEC_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

let stale = 0;
for (const f of files) {
  const rel = toRepoRel(f);
  const src = fs.readFileSync(f, 'utf-8');
  for (const match of src.matchAll(SPEC_RE)) {
    const spec = match[1];
    if (!spec.startsWith('.')) continue; // alias imports are canonical by construction
    const resolved = resolveSpecifier(f, spec);
    if (resolved && shimPaths.has(resolved) && resolved !== rel) {
      console.error(`STALE: ${rel} -> '${spec}' still routes through legacy shim ${resolved}`);
      stale++;
    }
  }
}

if (stale === 0) {
  console.log('OK: no stale relative imports route through legacy shim paths.');
} else {
  console.error(`FAILED: ${stale} stale legacy-path imports remain.`);
  violations += stale;
}

process.exit(violations > 0 ? 1 : 0);
