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
function findEnd(startLine: number, nextHeaderLine: number): number {
  let openBraces = 0;
  let openParens = 0;
  let openBrackets = 0;
  let inString: string | null = null;
  let inRegex = false;
  let inBlockComment = false;
  let sawOpen = false;
  let lastNonWs = '';

  for (let lineNum = startLine; lineNum < nextHeaderLine; lineNum++) {
    const line = lines[lineNum - 1];
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      const nextCh = line[col + 1];

      if (inBlockComment) {
        if (ch === '*' && nextCh === '/') {
          inBlockComment = false;
          col++;
        }
        continue;
      }
      if (inString) {
        if (ch === '\\') {
          col++;
        } else if (ch === inString) {
          inString = null;
        }
        continue;
      }
      if (inRegex) {
        if (ch === '\\') {
          col++;
        } else if (ch === '/') {
          inRegex = false;
          lastNonWs = '/';
        }
        continue;
      }

      if (ch === '/' && nextCh === '/') {
        break;
      }
      if (ch === '/' && nextCh === '*') {
        inBlockComment = true;
        col++;
        continue;
      }

      if (ch === "'" || ch === '"' || ch === '`') {
        inString = ch;
        lastNonWs = ch;
        continue;
      }

      if (ch === '/') {
        const isRegexStart = /^[=(:,\[!&|?~;]/.test(lastNonWs) || lastNonWs === '' || /(?:return|case|typeof)$/.test(line.slice(0, col).trim());
        if (isRegexStart) {
          inRegex = true;
          continue;
        }
      }

      if (ch === '{') { openBraces++; sawOpen = true; }
      else if (ch === '}') { openBraces--; }
      else if (ch === '(') { openParens++; sawOpen = true; }
      else if (ch === ')') { openParens--; }
      else if (ch === '[') { openBrackets++; sawOpen = true; }
      else if (ch === ']') { openBrackets--; }

      if (!/\s/.test(ch)) {
        lastNonWs = ch;
      }
    }

    if (sawOpen && openBraces === 0 && openParens === 0 && openBrackets === 0) {
      return lineNum;
    }
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
