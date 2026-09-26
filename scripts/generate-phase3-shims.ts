import * as fs from 'fs';
import * as path from 'path';

interface ShimEntry {
  shimFile: string;
  targetRelPath: string;
  exportTarget: string;
}

const mapping: ShimEntry[] = [
  // external
  { shimFile: 'openrouter.service.ts', targetRelPath: 'external/openrouter.service.ts', exportTarget: '@/services/external/openrouter.service' },
  { shimFile: 'unorouter.service.ts', targetRelPath: 'external/unorouter.service.ts', exportTarget: '@/services/external/unorouter.service' },
  { shimFile: 'serper-places.service.ts', targetRelPath: 'external/serper-places.service.ts', exportTarget: '@/services/external/serper-places.service' },
  { shimFile: 'serper-search.service.ts', targetRelPath: 'external/serper-search.service.ts', exportTarget: '@/services/external/serper-search.service' },
  { shimFile: 'tavily-extract.service.ts', targetRelPath: 'external/tavily-extract.service.ts', exportTarget: '@/services/external/tavily-extract.service' },
  // discovery
  { shimFile: 'maps-discovery.service.ts', targetRelPath: 'discovery/maps-discovery.service.ts', exportTarget: '@/services/discovery/maps-discovery.service' },
  { shimFile: 'website-discovery.service.ts', targetRelPath: 'discovery/website-discovery.service.ts', exportTarget: '@/services/discovery/website-discovery.service' },
  { shimFile: 'website-discovery-gate.service.ts', targetRelPath: 'discovery/website-discovery-gate.service.ts', exportTarget: '@/services/discovery/website-discovery-gate.service' },
  { shimFile: 'website-search-ranker.service.ts', targetRelPath: 'discovery/website-search-ranker.service.ts', exportTarget: '@/services/discovery/website-search-ranker.service' },
  { shimFile: 'search-fallback.service.ts', targetRelPath: 'discovery/search-fallback.service.ts', exportTarget: '@/services/discovery/search-fallback.service' },
  { shimFile: 'url-filter.service.ts', targetRelPath: 'discovery/url-filter.service.ts', exportTarget: '@/services/discovery/url-filter.service' },
  // resolution
  { shimFile: 'entity-resolution.service.ts', targetRelPath: 'resolution/entity-resolution.service.ts', exportTarget: '@/services/resolution/entity-resolution.service' },
  { shimFile: 'geographic-evaluator.service.ts', targetRelPath: 'resolution/geographic-evaluator.service.ts', exportTarget: '@/services/resolution/geographic-evaluator.service' },
  { shimFile: 'geocoding.service.ts', targetRelPath: 'resolution/geocoding.service.ts', exportTarget: '@/services/resolution/geocoding.service' },
  { shimFile: 'candidate-classifier.service.ts', targetRelPath: 'resolution/candidate-classifier.service.ts', exportTarget: '@/services/resolution/candidate-classifier.service' },
  { shimFile: 'candidate-validation.service.ts', targetRelPath: 'resolution/candidate-validation.service.ts', exportTarget: '@/services/resolution/candidate-validation.service' },
  { shimFile: 'research-candidate.service.ts', targetRelPath: 'resolution/research-candidate.service.ts', exportTarget: '@/services/resolution/research-candidate.service' },
  { shimFile: 'verification.service.ts', targetRelPath: 'resolution/verification.service.ts', exportTarget: '@/services/resolution/verification.service' },
  { shimFile: 'website-relationship.service.ts', targetRelPath: 'resolution/website-relationship.service.ts', exportTarget: '@/services/resolution/website-relationship.service' },
  { shimFile: 'confidence.service.ts', targetRelPath: 'resolution/confidence.service.ts', exportTarget: '@/services/resolution/confidence.service' },
  // storage
  { shimFile: 'mongo.service.ts', targetRelPath: 'storage/mongo.service.ts', exportTarget: '@/services/storage/mongo.service' },
  { shimFile: 'output-storage.service.ts', targetRelPath: 'storage/output-storage.service.ts', exportTarget: '@/services/storage/output-storage.service' },
  { shimFile: 'cache.service.ts', targetRelPath: 'storage/cache.service.ts', exportTarget: '@/services/storage/cache.service' },
  { shimFile: 'db.service.ts', targetRelPath: 'storage/db.service.ts', exportTarget: '@/services/storage/db.service' },
];

const manifest: Array<{ legacyPath: string; canonicalPath: string; exportTarget: string }> = [];

for (const entry of mapping) {
  const fullShimPath = path.join('src/services', entry.shimFile);
  const shimContent = `/**
 * Backward-compatibility shim (Phase 3 Services Regrouping).
 * Canonical module has moved to ${entry.exportTarget}.
 * Will be removed in Phase 9.
 */
export * from '${entry.exportTarget}';
`;
  fs.writeFileSync(fullShimPath, shimContent, 'utf-8');
  manifest.push({
    legacyPath: `src/services/${entry.shimFile}`,
    canonicalPath: `src/services/${entry.targetRelPath}`,
    exportTarget: entry.exportTarget,
  });
}

// Add discovery-state.service.ts as existing type shim
manifest.push({
  legacyPath: 'src/services/discovery-state.service.ts',
  canonicalPath: 'src/types/discovery-state.ts',
  exportTarget: '@/types/discovery-state',
});

const artifactsDir = 'docs/phase0/artifacts';
if (!fs.existsSync(artifactsDir)) {
  fs.mkdirSync(artifactsDir, { recursive: true });
}

fs.writeFileSync(
  path.join(artifactsDir, 'phase3-shims-manifest.json'),
  JSON.stringify(manifest, null, 2),
  'utf-8'
);

console.log(`Successfully generated ${mapping.length} shims and wrote manifest with ${manifest.length} total entries.`);
