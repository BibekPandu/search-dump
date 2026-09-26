import * as fs from 'fs';
import { execSync } from 'child_process';

const movedFiles = [
  // external
  { oldRel: 'src/services/openrouter.service.ts', newRel: 'src/services/external/openrouter.service.ts' },
  { oldRel: 'src/services/unorouter.service.ts', newRel: 'src/services/external/unorouter.service.ts' },
  { oldRel: 'src/services/serper-places.service.ts', newRel: 'src/services/external/serper-places.service.ts' },
  { oldRel: 'src/services/serper-search.service.ts', newRel: 'src/services/external/serper-search.service.ts' },
  { oldRel: 'src/services/tavily-extract.service.ts', newRel: 'src/services/external/tavily-extract.service.ts' },
  // discovery
  { oldRel: 'src/services/maps-discovery.service.ts', newRel: 'src/services/discovery/maps-discovery.service.ts' },
  { oldRel: 'src/services/website-discovery.service.ts', newRel: 'src/services/discovery/website-discovery.service.ts' },
  { oldRel: 'src/services/website-discovery-gate.service.ts', newRel: 'src/services/discovery/website-discovery-gate.service.ts' },
  { oldRel: 'src/services/website-search-ranker.service.ts', newRel: 'src/services/discovery/website-search-ranker.service.ts' },
  { oldRel: 'src/services/search-fallback.service.ts', newRel: 'src/services/discovery/search-fallback.service.ts' },
  { oldRel: 'src/services/url-filter.service.ts', newRel: 'src/services/discovery/url-filter.service.ts' },
  // resolution
  { oldRel: 'src/services/entity-resolution.service.ts', newRel: 'src/services/resolution/entity-resolution.service.ts' },
  { oldRel: 'src/services/geographic-evaluator.service.ts', newRel: 'src/services/resolution/geographic-evaluator.service.ts' },
  { oldRel: 'src/services/geocoding.service.ts', newRel: 'src/services/resolution/geocoding.service.ts' },
  { oldRel: 'src/services/candidate-classifier.service.ts', newRel: 'src/services/resolution/candidate-classifier.service.ts' },
  { oldRel: 'src/services/candidate-validation.service.ts', newRel: 'src/services/resolution/candidate-validation.service.ts' },
  { oldRel: 'src/services/research-candidate.service.ts', newRel: 'src/services/resolution/research-candidate.service.ts' },
  { oldRel: 'src/services/verification.service.ts', newRel: 'src/services/resolution/verification.service.ts' },
  { oldRel: 'src/services/website-relationship.service.ts', newRel: 'src/services/resolution/website-relationship.service.ts' },
  { oldRel: 'src/services/confidence.service.ts', newRel: 'src/services/resolution/confidence.service.ts' },
  // storage
  { oldRel: 'src/services/mongo.service.ts', newRel: 'src/services/storage/mongo.service.ts' },
  { oldRel: 'src/services/output-storage.service.ts', newRel: 'src/services/storage/output-storage.service.ts' },
  { oldRel: 'src/services/cache.service.ts', newRel: 'src/services/storage/cache.service.ts' },
  { oldRel: 'src/services/db.service.ts', newRel: 'src/services/storage/db.service.ts' },
];

/**
 * Strips module-boundary statements (imports, re-exports) and normalizes
 * dynamic import() specifiers, leaving only the executable module body.
 * This is the R1 / body-preservation comparison surface.
 */
function stripImportsAndExports(code: string): string {
  // Normalize CRLF
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  const bodyLines: string[] = [];
  let inMultiLineModuleStmt = false;

  // `export const/let/var/function/class/interface/type/enum/...` are BODY
  // declarations and must be preserved verbatim. Only bare re-export
  // statements (`export {`, `export type {`, `export *`) are module boundary.
  const isValueOrTypeDeclaration = (t: string) =>
    /^export\s+(declare\s+)?(abstract\s+)?(async\s+)?(const|let|var|function|class|interface|type|enum|namespace|default)\b/.test(t);

  const isModuleStmtStart = (t: string) => {
    if (isValueOrTypeDeclaration(t)) return false;
    if (/^import\s*\(/.test(t)) return false; // dynamic import() expression
    return /^import\b/.test(t) || /^export\b/.test(t);
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (inMultiLineModuleStmt) {
      // Terminate at the closing `} from '...';` (or bare `};`) of the block.
      if (/^}\s*from\s*['"][^'"]*['"]\s*;?$/.test(trimmed) || /^}\s*;$/.test(trimmed)) {
        inMultiLineModuleStmt = false;
      }
      continue;
    }

    if (isModuleStmtStart(trimmed)) {
      // Single-line forms: `import ... from 'x';` / `export ... from 'x';`
      // Multi-line forms open with `import {` / `export {` and no specifier yet.
      const hasSpecifier = /from\s*['"]/.test(trimmed);
      if (!hasSpecifier) {
        inMultiLineModuleStmt = true;
      }
      continue;
    }

    // dynamic import replacement normalize:
    // e.g. await import('./geocoding.service.js') vs await import('@/services/resolution/geocoding.service')
    const normalizedLine = line.replace(/import\(['"][^'"]+['"]\)/g, 'DYNAMIC_IMPORT_PLACEHOLDER');
    bodyLines.push(normalizedLine);
  }

  return bodyLines.join('\n').trim();
}

let violations = 0;

for (const { oldRel, newRel } of movedFiles) {
  // Get HEAD content of oldRel
  const headContent = execSync(`git show HEAD:${oldRel}`, { encoding: 'utf-8' });
  const currentContent = fs.readFileSync(newRel, 'utf-8');

  const headBody = stripImportsAndExports(headContent);
  const currentBody = stripImportsAndExports(currentContent);

  if (headBody !== currentBody) {
    console.error(`VIOLATION: Body changed in ${newRel}`);
    violations++;
  } else {
    console.log(`OK: Body perfectly preserved in ${newRel}`);
  }
}

if (violations > 0) {
  console.error(`FAILED: ${violations} files had body modifications!`);
  process.exit(1);
} else {
  console.log(`SUCCESS: All ${movedFiles.length} moved files have identical function bodies, logic, and schemas!`);
}
