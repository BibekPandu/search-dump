import * as fs from 'fs';
import * as path from 'path';

// Canonical locations of all services
const serviceToCanonical: Record<string, string> = {
  // external
  'openrouter.service': '@/services/external/openrouter.service',
  'unorouter.service': '@/services/external/unorouter.service',
  'serper-places.service': '@/services/external/serper-places.service',
  'serper-search.service': '@/services/external/serper-search.service',
  'tavily-extract.service': '@/services/external/tavily-extract.service',
  // discovery
  'maps-discovery.service': '@/services/discovery/maps-discovery.service',
  'website-discovery.service': '@/services/discovery/website-discovery.service',
  'website-discovery-gate.service': '@/services/discovery/website-discovery-gate.service',
  'website-search-ranker.service': '@/services/discovery/website-search-ranker.service',
  'search-fallback.service': '@/services/discovery/search-fallback.service',
  'url-filter.service': '@/services/discovery/url-filter.service',
  'discovery-state.service': '@/types/discovery-state',
  // resolution
  'entity-resolution.service': '@/services/resolution/entity-resolution.service',
  'geographic-evaluator.service': '@/services/resolution/geographic-evaluator.service',
  'geocoding.service': '@/services/resolution/geocoding.service',
  'candidate-classifier.service': '@/services/resolution/candidate-classifier.service',
  'candidate-validation.service': '@/services/resolution/candidate-validation.service',
  'research-candidate.service': '@/services/resolution/research-candidate.service',
  'verification.service': '@/services/resolution/verification.service',
  'website-relationship.service': '@/services/resolution/website-relationship.service',
  'confidence.service': '@/services/resolution/confidence.service',
  // storage
  'mongo.service': '@/services/storage/mongo.service',
  'output-storage.service': '@/services/storage/output-storage.service',
  'cache.service': '@/services/storage/cache.service',
  'db.service': '@/services/storage/db.service',
  // root
  'business-extractor.service': '@/services/business-extractor.service',
  'telemetry.service': '@/services/telemetry.service',
};

function walk(dir: string): string[] {
  let res: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === 'node_modules' || item.name === '.mastra' || item.name === '.git') continue;
      res = res.concat(walk(full));
    } else if (item.name.endsWith('.ts')) {
      res.push(full);
    }
  }
  return res;
}

const allTsFiles = walk('src').concat(walk('scripts'));

let totalReplacements = 0;

for (const filePath of allTsFiles) {
  // Don't update the 24 legacy shims themselves
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('src/services/') && !normalized.includes('/', 'src/services/'.length)) {
    // legacy shim at src/services/*.ts
    continue;
  }
  if (normalized === 'scripts/update-service-imports.ts' || normalized === 'scripts/generate-phase3-shims.ts') {
    continue;
  }

  let content = fs.readFileSync(filePath, 'utf-8');
  let changed = false;

  for (const [serviceBase, canonicalPath] of Object.entries(serviceToCanonical)) {
    // Regex for:
    // 1) from '@/services/xxx' or from '@/services/xxx.js'
    // 2) from './xxx' or from './xxx.js'
    // 3) from '../../../src/services/xxx'
    // 4) import('./xxx.js') or import('@/services/xxx.js')
    
    // Pattern for from '...' or from "..."
    const importFromRegex = new RegExp(`from\\s+['"](?:@\\/services\\/|\\.\\/|\\.\\.\\/\\.\\.\\/\\.\\.\\/src\\/services\\/)${serviceBase}(?:\\.js)?['"]`, 'g');
    if (importFromRegex.test(content)) {
      content = content.replace(importFromRegex, `from '${canonicalPath}'`);
      changed = true;
      totalReplacements++;
    }

    // Pattern for import('...')
    const dynamicImportRegex = new RegExp(`import\\(\\s*['"](?:@\\/services\\/|\\.\\/|\\.\\.\\/\\.\\.\\/\\.\\.\\/src\\/services\\/)${serviceBase}(?:\\.js)?['"]\\s*\\)`, 'g');
    if (dynamicImportRegex.test(content)) {
      content = content.replace(dynamicImportRegex, `import('${canonicalPath}')`);
      changed = true;
      totalReplacements++;
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

console.log(`Updated imports across codebase. Total replacement operations: ${totalReplacements}`);
