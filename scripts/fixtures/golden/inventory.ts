/**
 * Phase 0 (0.2) — Dependency & export inventory generator.
 *
 * Deterministic, regex-based inventory of every internal import edge plus a
 * per-file export inventory. Freezes the pre-refactor coupling baseline:
 *   - cross-service sibling imports
 *   - service -> Mastra boundary crossings (the coupling behind the
 *     `mongo.service` <-> `research-workflow` cycle)
 *   - dynamic `import(...)` call sites
 *   - export inventory for a target module (default: business-extractor.service)
 *
 * Usage:
 *   npx tsx scripts/fixtures/golden/inventory.ts [--out-json <file>] [--out-md <file>]
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ImportEdge {
  from: string;
  specifier: string;
  kind: 'static' | 'dynamic';
  resolved: string | null;
}

export type ExportKind =
  | 'function'
  | 'const'
  | 'type'
  | 'interface'
  | 'class'
  | 'enum'
  | 're-export'
  | 'default';

export interface ExportEntry {
  name: string;
  kind: ExportKind;
  line: number;
}

const REPO_ROOT = process.cwd();
const EXPORT_TARGET = 'src/services/business-extractor.service.ts';

function rel(abs: string): string {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

function listTsFiles(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(child);
    }
  };
  walk(abs);
  return found.sort();
}

/** Resolve a relative specifier to a repo-relative `.ts` path (null when external/unresolved). */
export function resolveSpecifier(fromAbs: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromAbs), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : `${base}.ts`,
    path.join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return rel(candidate);
  }
  return null;
}

export function extractImports(source: string, fromAbs: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const seen = new Set<string>();

  const push = (specifier: string, kind: 'static' | 'dynamic', index: number): void => {
    const key = `${kind}:${specifier}:${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      from: rel(fromAbs),
      specifier,
      kind,
      resolved: resolveSpecifier(fromAbs, specifier),
    });
  };

  const patterns: Array<{ regex: RegExp; kind: 'static' | 'dynamic' }> = [
    { regex: /\bfrom\s*['"]([^'"\n]+)['"]/g, kind: 'static' },
    { regex: /^\s*import\s*['"]([^'"\n]+)['"]/gm, kind: 'static' },
    { regex: /import\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, kind: 'dynamic' },
  ];

  for (const { regex, kind } of patterns) {
    for (const match of source.matchAll(regex)) push(match[1], kind, match.index ?? 0);
  }

  return edges.sort((a, b) => a.from.localeCompare(b.from) || a.specifier.localeCompare(b.specifier));
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

export function extractExports(source: string): ExportEntry[] {
  const entries: ExportEntry[] = [];
  const declarationPatterns: Array<{ regex: RegExp; kind: ExportKind }> = [
    { regex: /^export\s+(?:async\s+)?function\s+(\w+)/gm, kind: 'function' },
    { regex: /^export\s+const\s+(\w+)/gm, kind: 'const' },
    { regex: /^export\s+let\s+(\w+)/gm, kind: 'const' },
    { regex: /^export\s+type\s+(\w+)\s*=/gm, kind: 'type' },
    { regex: /^export\s+interface\s+(\w+)/gm, kind: 'interface' },
    { regex: /^export\s+class\s+(\w+)/gm, kind: 'class' },
    { regex: /^export\s+enum\s+(\w+)/gm, kind: 'enum' },
    { regex: /^export\s+default\b/gm, kind: 'default' },
  ];

  for (const { regex, kind } of declarationPatterns) {
    for (const match of source.matchAll(regex)) {
      entries.push({
        name: kind === 'default' ? 'default' : match[1],
        kind,
        line: lineOf(source, match.index ?? 0),
      });
    }
  }

  for (const match of source.matchAll(/^export\s*\{([\s\S]*?)\}\s*(?:from\s*['"][^'"]+['"])?;/gm)) {
    for (const rawName of match[1].split(',')) {
      const name = rawName.trim().split(/\s+as\s+/).pop()?.trim();
      if (!name || name.startsWith('type ') || name.startsWith('//')) continue;
      entries.push({ name, kind: 're-export', line: lineOf(source, match.index ?? 0) });
    }
  }

  return entries.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

export function layerOf(file: string): 'config' | 'services' | 'mastra' | 'scripts' | 'other' {
  if (file.startsWith('src/config/')) return 'config';
  if (file.startsWith('src/services/')) return 'services';
  if (file.startsWith('src/mastra/')) return 'mastra';
  if (file.startsWith('scripts/')) return 'scripts';
  return 'other';
}

function moduleName(file: string): string {
  return path.basename(file).replace(/\.ts$/, '');
}

function countByKind(entries: ExportEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  return counts;
}

function main(): void {
  const args = process.argv.slice(2);
  const argValue = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  const files = [...listTsFiles('src'), ...listTsFiles('scripts')];
  const allEdges: ImportEdge[] = [];
  const exportsByFile: Record<string, ExportEntry[]> = {};

  for (const abs of files) {
    const source = fs.readFileSync(abs, 'utf8');
    allEdges.push(...extractImports(source, abs));
    exportsByFile[rel(abs)] = extractExports(source);
  }

  const internalEdges = allEdges.filter((edge) => edge.resolved !== null);
  const dynamicImports = allEdges.filter((edge) => edge.kind === 'dynamic');
  const unresolvedRelative = allEdges.filter(
    (edge) => edge.specifier.startsWith('.') && edge.resolved === null
  );

  const crossServiceSiblings = internalEdges.filter(
    (edge) =>
      layerOf(edge.from) === 'services' &&
      layerOf(edge.resolved as string) === 'services' &&
      edge.from !== edge.resolved
  );

  const servicesToMastra = internalEdges.filter(
    (edge) => layerOf(edge.from) === 'services' && layerOf(edge.resolved as string) === 'mastra'
  );

  const mastraToServices = internalEdges.filter(
    (edge) => layerOf(edge.from) === 'mastra' && layerOf(edge.resolved as string) === 'services'
  );

  const externals = [
    ...new Set(allEdges.filter((edge) => edge.resolved === null).map((edge) => edge.specifier)),
  ].sort();

  const inventory = {
    phase: '0.2',
    generatedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    totals: {
      filesScanned: files.length,
      importEdges: allEdges.length,
      internalEdges: internalEdges.length,
      externalSpecifiers: externals.length,
      crossServiceSiblingImports: crossServiceSiblings.length,
      servicesToMastraImports: servicesToMastra.length,
      mastraToServicesImports: mastraToServices.length,
      dynamicImportSites: dynamicImports.length,
      unresolvedRelativeSpecifiers: unresolvedRelative.length,
    },
    crossServiceSiblingImports: crossServiceSiblings.map((edge) => ({
      from: edge.from,
      to: edge.resolved,
      module: moduleName(edge.resolved as string),
      specifier: edge.specifier,
    })),
    servicesToMastraImports: servicesToMastra.map((edge) => ({
      from: edge.from,
      to: edge.resolved,
      specifier: edge.specifier,
    })),
    mastraToServicesImports: mastraToServices.map((edge) => ({
      from: edge.from,
      to: edge.resolved,
      specifier: edge.specifier,
    })),
    dynamicImportSites: dynamicImports.map((edge) => ({
      from: edge.from,
      specifier: edge.specifier,
      resolved: edge.resolved,
    })),
    unresolvedRelativeSpecifiers: unresolvedRelative.map((edge) => ({
      from: edge.from,
      specifier: edge.specifier,
    })),
    externalSpecifiers: externals,
    exportInventory: {
      target: EXPORT_TARGET,
      counts: countByKind(exportsByFile[EXPORT_TARGET] ?? []),
      entries: exportsByFile[EXPORT_TARGET] ?? [],
    },
  };

  const outJson = argValue('--out-json');
  const outMd = argValue('--out-md');

  if (outJson) {
    fs.mkdirSync(path.dirname(path.resolve(outJson)), { recursive: true });
    fs.writeFileSync(path.resolve(outJson), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  }
  if (outMd) {
    fs.mkdirSync(path.dirname(path.resolve(outMd)), { recursive: true });
    fs.writeFileSync(path.resolve(outMd), renderMarkdown(inventory), 'utf8');
  }

  console.log(JSON.stringify(inventory.totals, null, 2));
  console.log(`export inventory (${EXPORT_TARGET}): ${inventory.exportInventory.entries.length} exports`);
  if (outJson) console.log(`json -> ${path.resolve(outJson)}`);
  if (outMd) console.log(`md   -> ${path.resolve(outMd)}`);
}

interface InventoryLike {
  generatedAt: string;
  totals: Record<string, number>;
  crossServiceSiblingImports: Array<{ from: string; to: string | null; specifier: string }>;
  servicesToMastraImports: Array<{ from: string; to: string | null; specifier: string }>;
  mastraToServicesImports: Array<{ from: string; to: string | null; specifier: string }>;
  dynamicImportSites: Array<{ from: string; specifier: string; resolved: string | null }>;
  unresolvedRelativeSpecifiers: Array<{ from: string; specifier: string }>;
  exportInventory: { target: string; counts: Record<string, number>; entries: ExportEntry[] };
}

function renderMarkdown(inventory: InventoryLike): string {
  const lines: string[] = [];
  lines.push('# Generated Dependency & Export Inventory (Phase 0.2)');
  lines.push('');
  lines.push(`Generated: ${inventory.generatedAt}`);
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('| --- | --- |');
  for (const [key, value] of Object.entries(inventory.totals)) lines.push(`| ${key} | ${value} |`);
  lines.push('');
  lines.push('## Cross-service sibling imports (`src/services/*` -> `src/services/*`)');
  lines.push('');
  for (const edge of inventory.crossServiceSiblingImports) lines.push(`- \`${edge.from}\` -> \`${edge.to}\``);
  lines.push('');
  lines.push('## Service -> Mastra boundary crossings');
  lines.push('');
  for (const edge of inventory.servicesToMastraImports) lines.push(`- \`${edge.from}\` -> \`${edge.to}\``);
  lines.push('');
  lines.push('## Mastra -> service imports');
  lines.push('');
  for (const edge of inventory.mastraToServicesImports) lines.push(`- \`${edge.from}\` -> \`${edge.to}\``);
  lines.push('');
  lines.push('## Dynamic `import()` call sites');
  lines.push('');
  if (inventory.dynamicImportSites.length === 0) lines.push('- none');
  for (const site of inventory.dynamicImportSites) {
    lines.push(`- \`${site.from}\` -> \`${site.specifier}\` (resolved: ${site.resolved ?? 'external'})`);
  }
  lines.push('');
  lines.push('## Unresolved relative specifiers');
  lines.push('');
  if (inventory.unresolvedRelativeSpecifiers.length === 0) lines.push('- none');
  for (const item of inventory.unresolvedRelativeSpecifiers) {
    lines.push(`- \`${item.from}\` -> \`${item.specifier}\``);
  }
  lines.push('');
  lines.push(`## Export inventory — \`${inventory.exportInventory.target}\``);
  lines.push('');
  lines.push('| Kind | Count |');
  lines.push('| --- | --- |');
  for (const [kind, count] of Object.entries(inventory.exportInventory.counts)) {
    lines.push(`| ${kind} | ${count} |`);
  }
  lines.push('');
  lines.push('| Line | Kind | Name |');
  lines.push('| --- | --- | --- |');
  for (const entry of inventory.exportInventory.entries) {
    lines.push(`| ${entry.line} | ${entry.kind} | \`${entry.name}\` |`);
  }
  lines.push('');
  return lines.join('\n');
}

main();
