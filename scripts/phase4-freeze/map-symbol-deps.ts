/**
 * Phase 4.0 — Symbol dependency mapper.
 *
 * The repo ships TypeScript 7.0.2 (native shim) which does not expose the
 * compiler API, so this performs a line-based structural parse of the single
 * extractor module to recover:
 *   - every top-level declaration (exported AND private)
 *   - the line range each declaration owns
 *   - which other top-level symbols each declaration references
 *   - which module-level mutable containers each declaration touches
 *
 * Reference detection is deliberately an OVER-approximation (a bare identifier
 * match counts even for non-reference positions). For cycle analysis, missing
 * a real edge is the dangerous direction, so over-reporting is the safe bias.
 * Every reported edge is verified by hand before being acted on.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TARGET = path.join(ROOT, 'src', 'services', 'business-extractor.service.ts');
const OUT = path.join(ROOT, 'docs', 'phase0', 'artifacts', 'phase4-symbol-deps.json');

const lines = fs.readFileSync(TARGET, 'utf8').split(/\r?\n/);

const HEADER = /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const CLOSER = /^\}|\];$|^\];$|^\}\);$|^\}\);?$|^\};?$|^\}\)[\];,]?$/;
const MUTABLE_CONTAINER = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(new\s+(?:Set|Map)\b|\[|\{)/;

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

const headers: { kind: string; name: string; isExported: boolean; isAsync: boolean; line: number }[] = [];
const mutables = new Set<string>();

lines.forEach((text, i) => {
  if (text.length === 0 || text.startsWith(' ') || text.startsWith('\t') || text.startsWith('*')) return;

  const m = HEADER.exec(text);
  if (m) {
    headers.push({
      kind: m[1],
      name: m[2],
      isExported: /^export\b/.test(text),
      isAsync: /\basync\s+function\b/.test(text),
      line: i + 1,
    });
  }

  const mm = MUTABLE_CONTAINER.exec(text);
  if (mm) mutables.add(mm[1]);
});

/** Locate the line that closes a top-level declaration body. */
function findEnd(startIdx: number, nextHeaderLine: number): number {
  for (let i = startIdx + 1; i < nextHeaderLine - 1; i += 1) {
    const t = lines[i];
    if (t.length === 0) continue;
    if (t.startsWith(' ') || t.startsWith('\t') || t.startsWith('*') || t.startsWith('//')) continue;
    if (CLOSER.test(t)) return i + 1;
  }
  return nextHeaderLine - 1;
}

const decls: Decl[] = headers.map((h, i) => {
  const nextLine = i + 1 < headers.length ? headers[i + 1].line : lines.length + 1;
  const endLine = findEnd(h.line, nextLine);
  const body = lines.slice(h.line - 1, endLine).join('\n');

  const refs = new Set<string>();
  for (const other of headers) {
    if (other.name === h.name) continue;
    if (new RegExp(`(^|[^\\w$.])${other.name}\\b`).test(body)) refs.add(other.name);
  }

  return {
    name: h.name,
    kind: h.kind,
    isExported: h.isExported,
    isAsync: h.isAsync,
    startLine: h.line,
    endLine,
    mutable: mutables.has(h.name),
    refs: [...refs],
  };
});

const nameSet = new Set(decls.map((d) => d.name));

/** Edges between symbols, restricted to references that are themselves real declarations. */
const edges = decls
  .map((d) => ({ from: d.name, to: d.refs.filter((r) => nameSet.has(r)) }))
  .filter((e) => e.to.length > 0);

const payload = {
  generatedAt: new Date().toISOString(),
  target: 'src/services/business-extractor.service.ts',
  totalLines: lines.length,
  declarationCount: decls.length,
  exportedCount: decls.filter((d) => d.isExported).length,
  privateCount: decls.filter((d) => !d.isExported).length,
  mutableContainers: [...mutables],
  declarations: decls,
  edges,
};

fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');

process.stdout.write(`target            : ${payload.target}\n`);
process.stdout.write(`total lines       : ${payload.totalLines}\n`);
process.stdout.write(`declarations      : ${payload.declarationCount}\n`);
process.stdout.write(`exported          : ${payload.exportedCount}\n`);
process.stdout.write(`private           : ${payload.privateCount}\n`);
process.stdout.write(`mutable containers: ${payload.mutableContainers.length}\n`);
process.stdout.write(`edges             : ${edges.length}\n`);
process.stdout.write(`artifact          : ${path.relative(ROOT, OUT)}\n`);
