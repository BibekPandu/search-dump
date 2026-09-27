/**
 * Phase 4 — mechanical slicer.
 *
 * Splits `src/services/business-extractor.service.ts` into the modules declared
 * in `./ownership.ts`, copying every declaration body BYTE-EXACTLY (R1) and
 * emitting only the imports each module actually references (tsconfig has
 * `noUnusedLocals: true`).
 *
 * Run:  npx tsx scripts/phase4-slicing/slice.ts --dry-run   # report only
 *       npx tsx scripts/phase4-slicing/slice.ts              # write files
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RANKS, ASSIGNMENT, OWNER_OF, MODULES, type Rank } from './ownership';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_REL = 'src/services/business-extractor.service.ts';
const DEPS_REL = 'docs/phase0/artifacts/phase4-symbol-deps.json';

interface Decl {
  name: string;
  kind: string;
  isExported: boolean;
  isAsync: boolean;
  startLine: number;
  endLine: number;
  mutable: boolean;
  refs: string[];
}

/** Identifiers imported by the original monolith, split by type-only-ness. */
const EXTERNALS: ReadonlyArray<{ spec: string; typeOnly: boolean; names: string[] }> = [
  {
    spec: '@/services/discovery/search-fallback.service',
    typeOnly: false,
    names: ['extractDomain'],
  },
  {
    spec: '@/types/verification.js',
    typeOnly: true,
    names: ['WebsitePageEvidence', 'WebsiteEvidence', 'PhoneEvidenceRecord'],
  },
  {
    spec: '@/config/nepal-telecom.config',
    typeOnly: false,
    names: ['NTA_MOBILE_PREFIXES', 'NTA_LANDLINE_AREA_CODES'],
  },
  {
    spec: '@/types/contact.js',
    typeOnly: true,
    names: ['ContactRole', 'ContactOwner', 'ContactChannel', 'ClassifiedContact'],
  },
  { spec: '@/types/social.js', typeOnly: true, names: ['ClassifiedSocialProfile'] },
  { spec: '@/services/telemetry.service', typeOnly: false, names: ['incrementTelemetry'] },
];

const typeOnlyKind = (kind: string): boolean => kind === 'type' || kind === 'interface';

function loadDecls(): Decl[] {
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, DEPS_REL), 'utf8')) as {
    declarations: Decl[];
  };
  return json.declarations;
}

/**
 * Walk backwards over a declaration's start line to pick up an attached JSDoc /
 * line-comment block, stopping at the first blank line so that standalone
 * section banners are never swallowed.
 */
function commentStart(lines: string[], startLine: number): number {
  let i = startLine - 1; // 1-based startLine -> 0-based index of the line above
  let sawComment = false;
  while (i >= 0) {
    const t = lines[i].trim();
    if (t === '') break;
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.endsWith('*/')) {
      i -= 1;
      sawComment = true;
      continue;
    }
    break;
  }
  return sawComment ? i + 1 : startLine - 1;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const used = (text: string, name: string): boolean =>
  new RegExp(`(?:^|[^\\w$.]|\\.\\.\\.)${esc(name)}(?!\\w)`).test(text);

/** Line ending used by the original file; preserved on every write. */
const detectEol = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

/** Every declaration with its attached comment block, in source order. */
function sliceDecls(lines: string[], decls: Decl[]): Array<{ decl: Decl; text: string }> {
  return decls
    .slice()
    .sort((a, b) => a.startLine - b.startLine)
    .map((decl) => {
      const cStart = commentStart(lines, decl.startLine);
      const declLines = lines.slice(cStart, decl.endLine);
      const declLineIdxInSlice = decl.startLine - 1 - cStart;
      const declLine = declLines[declLineIdxInSlice];
      if (declLine && !/^export\b/.test(declLine.trim())) {
        declLines[declLineIdxInSlice] = declLine.replace(
          /^(\s*)(const|let|var|function|async function|interface|type|enum|class)\b/,
          '$1export $2'
        );
      }
      return {
        decl,
        text: declLines.join('\n').replace(/\s+$/, ''),
      };
    });
}

const DECLS = loadDecls();
const KIND_OF: ReadonlyMap<string, string> = new Map(DECLS.map((d) => [d.name, d.kind]));
const declsFor = (rank: Rank): Decl[] => DECLS.filter((d) => OWNER_OF.get(d.name) === rank);

interface ImportLine {
  readonly spec: string;
  readonly typeOnly: boolean;
  readonly names: string[];
}

/**
 * Exact import set for a module body. `tsconfig` sets `noUnusedLocals: true`, so
 * this must be precise: every referenced symbol, and nothing else.
 */
function computeImports(body: string, rank: Rank): ImportLine[] {
  const self = new Set(ASSIGNMENT[rank]);
  const out: ImportLine[] = [];

  for (const ext of EXTERNALS) {
    const names = ext.names.filter((n) => used(body, n));
    if (names.length) out.push({ spec: ext.spec, typeOnly: ext.typeOnly, names });
  }

  for (const lower of RANKS.slice(0, RANKS.indexOf(rank)) as readonly Rank[]) {
    const value: string[] = [];
    const types: string[] = [];
    for (const name of ASSIGNMENT[lower]) {
      if (self.has(name) || !used(body, name)) continue;
      (typeOnlyKind(KIND_OF.get(name) ?? 'const') ? types : value).push(name);
    }
    if (value.length) out.push({ spec: MODULES[lower].specifier, typeOnly: false, names: value });
    if (types.length) out.push({ spec: MODULES[lower].specifier, typeOnly: true, names: types });
  }

  return out;
}

const renderImports = (imports: ImportLine[]): string =>
  imports
    .map((i) => `${i.typeOnly ? 'import type' : 'import'} { ${i.names.join(', ')} } from '${i.spec}';`)
    .join('\n');

/** Lines outside every declaration slice that still contain code (must be empty). */
function coverageReport(lines: string[]): string[] {
  const covered = new Set<number>();
  for (const d of DECLS) {
    for (let i = commentStart(lines, d.startLine); i < d.endLine; i += 1) covered.add(i);
  }
  const strays: string[] = [];
  let inImport = false;
  lines.forEach((raw, idx) => {
    if (covered.has(idx)) return;
    const t = raw.trim();
    if (t.startsWith('import ') || t.startsWith('import{') || t === 'import') {
      if (t.endsWith(';') || (t.includes(' from ') && t.includes("'"))) {
        inImport = false;
        return;
      }
      inImport = true;
      return;
    }
    if (inImport) {
      if (t.endsWith(';') || (t.includes(' from ') && t.includes("'"))) {
        inImport = false;
      }
      return;
    }
    if (t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    strays.push(`  ${idx + 1}: ${t}`);
  });
  return strays;
}

function buildModule(rank: Rank, lines: string[], eol: string): string {
  const spec = MODULES[rank];
  const body = sliceDecls(lines, declsFor(rank))
    .map((s) => s.text)
    .join('\n\n');
  const header = [
    '/**',
    ` * ${spec.summary}`,
    ' *',
    ' * Phase 4 split of `src/services/business-extractor.service.ts`. Every declaration',
    ' * below is copied byte-exact from the monolith; only the import block is new.',
    ' */',
  ].join('\n');
  return [header, '', renderImports(computeImports(body, rank)), '', body].join(eol) + eol;
}

function buildFacade(eol: string): string {
  const header = [
    '/**',
    ' * Backward-compatible facade over the Phase 4 extraction modules.',
    ' *',
    ' * This file contains no logic. Every symbol previously declared here now lives in',
    ' * a single-responsibility module under `services/extraction/` (or `config/`) and is',
    ' * re-exported unchanged: the 69 export names and their runtime kinds are identical',
    ' * to the pre-split module. Do not add declarations here — add them to the owning',
    ' * module so this facade stays a pure re-export surface.',
    ' */',
  ].join('\n');
  const reexports = RANKS.map((r) => `export * from '${MODULES[r].specifier}';`);
  return [header, '', ...reexports].join(eol) + eol;
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const abs = path.join(ROOT, SOURCE_REL);
  const source = fs.readFileSync(abs, 'utf8');
  const eol = detectEol(source);
  const lines = source.split(/\r?\n/);

  const strays = coverageReport(lines);
  if (strays.length) {
    process.stdout.write(`FAIL: ${strays.length} code line(s) outside any declaration slice:\n`);
    process.stdout.write(`${strays.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  const unassigned = DECLS.filter((d) => !OWNER_OF.has(d.name));
  if (unassigned.length) {
    process.stdout.write(`FAIL: unassigned symbols: ${unassigned.map((d) => d.name).join(', ')}\n`);
    process.exitCode = 1;
    return;
  }

  for (const rank of RANKS) {
    const spec = MODULES[rank];
    const content = buildModule(rank, lines, eol);
    const declCount = declsFor(rank).length;
    process.stdout.write(
      `${dryRun ? 'would write' : 'wrote'} ${spec.file} (${declCount} decls, ${content.split(eol).length} lines)\n`,
    );
    if (!dryRun) {
      fs.mkdirSync(path.dirname(path.join(ROOT, spec.file)), { recursive: true });
      fs.writeFileSync(path.join(ROOT, spec.file), content, 'utf8');
    }
  }

  const facade = buildFacade(eol);
  process.stdout.write(`${dryRun ? 'would write' : 'wrote'} ${SOURCE_REL} (facade, 69 re-exports)\n`);
  if (!dryRun) fs.writeFileSync(abs, facade, 'utf8');
}

main();

