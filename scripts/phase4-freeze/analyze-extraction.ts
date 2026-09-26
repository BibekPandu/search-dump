/**
 * Phase 4.0 -- Export + dependency freeze for the extraction facade split.
 *
 * Emits docs/phase0/artifacts/phase4-extraction-inventory.json:
 *   exports      : every exported symbol, its kind, and declaration line
 *   moduleState  : mutable module-level bindings that must stay co-located
 *   regexes      : RegExp literals, flagged global (stateful) vs not
 *
 * Read-only analysis: never mutates source.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TARGET = path.join(ROOT, 'src', 'services', 'business-extractor.service.ts');
const OUT_DIR = path.join(ROOT, 'docs', 'phase0', 'artifacts');
const OUT_FILE = path.join(OUT_DIR, 'phase4-extraction-inventory.json');

const src = fs.readFileSync(TARGET, 'utf8');
const lines = src.split(/\r?\n/);

const lineOf = (index: number): number => src.slice(0, index).split(/\r?\n/).length;

type ExportRec = { name: string; kind: string; line: number };
const exportsRec: ExportRec[] = [];
const push = (name: string, kind: string, line: number): void => {
  exportsRec.push({ name, kind, line });
};

// 1) Top-level declarations.
const declRe =
  /^export\s+(?:declare\s+)?(?:default\s+)?(async\s+function\*?|function\*?|const|let|var|class|type|interface|enum|abstract\s+class)\s+([A-Za-z0-9_$]+)/;

lines.forEach((text, i) => {
  const m = declRe.exec(text);
  if (m) push(m[2], m[1].replace(/\s+/g, ' '), i + 1);
});

// 2) `export { A, B as C, type D }` in single- and multi-line form.
const braceRe = /export\s+(type\s+)?\{([^}]*)\}/g;
let bm: RegExpExecArray | null;
while ((bm = braceRe.exec(src)) !== null) {
  const isTypeGroup = Boolean(bm[1]);
  const at = lineOf(bm.index);
  for (const raw of bm[2].split(',')) {
    const part = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!part) continue;
    const alias = part.split(/\s+as\s+/);
    const name = (alias[1] ?? alias[0]).replace(/^type\s+/, '').trim();
    if (!name) continue;
    push(name, isTypeGroup || /^type\s/.test(part) ? 'type' : 'reexport', at);
  }
}

exportsRec.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));

// 3) Mutable module-level state.
const mutableRes: RegExp[] = [
  /^(?:export\s+)?let\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+)?var\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b/,
];
const moduleState: { name: string; line: number; text: string }[] = [];
lines.forEach((text, i) => {
  for (const re of mutableRes) {
    const m = re.exec(text);
    if (m) moduleState.push({ name: m[1], line: i + 1, text: text.trim() });
  }
});

// 4) RegExp literals, flagged for the global flag (shared .lastIndex hazard).
const regexes: { line: number; text: string; global: boolean }[] = [];
const reLitRe = /=\s*\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+)\/([a-z]*)/g;
let rm: RegExpExecArray | null;
while ((rm = reLitRe.exec(src)) !== null) {
  const at = lineOf(rm.index);
  regexes.push({
    line: at,
    text: (lines[at - 1] ?? '').trim().slice(0, 160),
    global: rm[2].includes('g'),
  });
}

const byKind: Record<string, number> = {};
for (const e of exportsRec) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

const report = {
  generatedFor: path.relative(ROOT, TARGET).replace(/\\/g, '/'),
  lineCount: lines.length,
  exportCount: exportsRec.length,
  byKind,
  exports: exportsRec,
  moduleState,
  regexes,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8');

process.stdout.write(`exports=${report.exportCount} ${JSON.stringify(byKind)}\n`);
process.stdout.write(`moduleState=${moduleState.length} regexes=${regexes.length} global=${regexes.filter((r) => r.global).length}\n`);
process.stdout.write(`wrote ${path.relative(ROOT, OUT_FILE).replace(/\\/g, '/')}\n`);
