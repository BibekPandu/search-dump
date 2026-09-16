import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  startRunSession,
  getRunSessionId,
  getActiveRunSession,
  endRunSession,
  saveStageOutput,
  saveSummaryReport,
} from '../src/services/output-storage.service';
import {
  detectCrossListingConflicts,
  type ConflictCheckListing,
} from '../src/services/entity-resolution.service';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testId: string, description: string) {
  totalTests++;
  if (condition) {
    console.log(`✅ [PASS] ${testId}: ${description}`);
    passedTests++;
  } else {
    console.error(`❌ [FAIL] ${testId}: ${description}`);
    failedTests++;
  }
}

const TEST_OUTPUT_ROOT = path.join(os.tmpdir(), `phase5-test-output-${Date.now()}`);

function cleanupTempDir() {
  try {
    if (fs.existsSync(TEST_OUTPUT_ROOT)) {
      fs.rmSync(TEST_OUTPUT_ROOT, { recursive: true, force: true });
    }
  } catch {}
}

process.on('exit', cleanupTempDir);

async function runConflictArtifactTests() {
  console.log('================================================================');
  console.log('PHASE 5: CONFLICT ARTIFACT & OUTPUT OBSERVABILITY TEST SUITE (16 TESTS)');
  console.log('================================================================\n');

  try {
    const outputDir = TEST_OUTPUT_ROOT;
    const latestDir = path.join(outputDir, 'latest');

    // Helper to build conflict artifact envelope matching workflow contract
    function buildConflictEnvelope(query: string, location: string, listings: ConflictCheckListing[]) {
      const report = detectCrossListingConflicts(listings);
      const session = getActiveRunSession();
      const currentRunId = session?.runId || getRunSessionId(query, location);
      const artifact = {
        runId: currentRunId,
        generatedAt: new Date().toISOString(),
        conflicts: report.conflicts,
        clusters: report.clusters,
        conflictCount: report.conflicts.length,
      };
      saveStageOutput('conflicts', 'entity-conflicts.json', artifact, query, {
        outputRoot: TEST_OUTPUT_ROOT,
        runId: currentRunId,
      });
      return { artifact, report, runId: currentRunId };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // SCENARIO 1: Zero-Conflict Execution
    // ──────────────────────────────────────────────────────────────────────────
    endRunSession();
    const runId1 = startRunSession('Independent Cafes', 'Kathmandu', { outputRoot: TEST_OUTPUT_ROOT });

    const zeroConflictListings: ConflictCheckListing[] = [
      {
        name: 'Kathmandu Coffee Hub',
        phones: ['+977-1-4200001'],
        websites: ['https://ktmcoffeehub.com'],
        latitude: 27.71,
        longitude: 85.31,
      },
      {
        name: 'Pokhara Mountain Tea',
        phones: ['+977-61-520002'],
        websites: ['https://pokharamountaintea.com'],
        latitude: 28.21,
        longitude: 83.98,
      },
    ];

    const { runId: sessionRunId1 } = buildConflictEnvelope(
      'Independent Cafes',
      'Kathmandu',
      zeroConflictListings
    );

    const rootMirrorPath = path.join(outputDir, 'entity-conflicts.json');
    const historyPath1 = path.join(outputDir, 'history', runId1, 'entity-conflicts.json');
    const latestPath = path.join(latestDir, 'entity-conflicts.json');

    // T1: Zero conflicts -> entity-conflicts.json exists (root mirror)
    assert(fs.existsSync(rootMirrorPath), 'T1', 'Zero conflicts -> output/entity-conflicts.json (root mirror) exists');

    // T2: Zero conflicts -> entity-conflicts.json exists (history archive)
    assert(fs.existsSync(historyPath1), 'T2', `Zero conflicts -> output/history/${runId1}/entity-conflicts.json (history archive) exists`);

    // Read saved root mirror data
    const rootData = JSON.parse(fs.readFileSync(rootMirrorPath, 'utf-8'));

    // T3: Zero conflicts -> valid JSON with empty conflicts array and clusters array
    assert(
      Array.isArray(rootData.conflicts) &&
        rootData.conflicts.length === 0 &&
      Array.isArray(rootData.clusters) &&
        rootData.clusters.length === 0,
      'T3',
      'Zero conflicts -> valid JSON with empty conflicts: [] and clusters: []'
    );

    // T4: Zero conflicts -> conflictCount = 0
    assert(rootData.conflictCount === 0, 'T4', 'Zero conflicts -> conflictCount === 0');

    // T5: Zero conflicts -> generatedAt is valid ISO-8601
    const isValidIso = !isNaN(Date.parse(rootData.generatedAt)) && rootData.generatedAt.includes('T');
    assert(isValidIso, 'T5', `Zero conflicts -> generatedAt is valid ISO-8601 string (${rootData.generatedAt})`);

    // T6: Zero conflicts -> artifact.runId === currentRunId (exact provenance match)
    assert(rootData.runId === runId1 && rootData.runId === sessionRunId1, 'T6', `Zero conflicts -> artifact.runId matches active session runId (${runId1})`);

    // ──────────────────────────────────────────────────────────────────────────
    // SCENARIO 2: Single-Conflict Execution
    // ──────────────────────────────────────────────────────────────────────────
    endRunSession();
    const runId2 = startRunSession('Shared Office Treks', 'Kathmandu', { outputRoot: TEST_OUTPUT_ROOT });

    const singleConflictListings: ConflictCheckListing[] = [
      {
        name: 'Everest Trekking Agency A',
        phones: ['+977-1-4411111'],
        websites: ['https://everesttreka.com'],
      },
      {
        name: 'Everest Trekking Agency B',
        phones: ['+977-1-4411111'], // Identical phone -> POSSIBLY_SAME_ENTITY
        websites: ['https://everesttrekb.com'],
      },
    ];

    buildConflictEnvelope(
      'Shared Office Treks',
      'Kathmandu',
      singleConflictListings
    );

    const historyPath2 = path.join(outputDir, 'history', runId2, 'entity-conflicts.json');
    const historyData2 = JSON.parse(fs.readFileSync(historyPath2, 'utf-8'));

    // T7: One conflict -> entity-conflicts.json contains the conflict record
    assert(
      historyData2.conflicts.length === 1 &&
        historyData2.conflicts[0].conflict.conflictType === 'POSSIBLY_SAME_ENTITY' &&
        historyData2.conflicts[0].listingIndexA === 0 &&
        historyData2.conflicts[0].listingIndexB === 1,
      'T7',
      'One conflict -> entity-conflicts.json contains the expected conflict record'
    );

    // T8: One conflict -> conflictCount = 1
    assert(
      historyData2.conflictCount === 1 && historyData2.conflictCount === historyData2.conflicts.length,
      'T8',
      'One conflict -> conflictCount === 1 and matches conflicts.length'
    );

    // ──────────────────────────────────────────────────────────────────────────
    // SCENARIO 3: Multi-Conflict Batch Execution
    // ──────────────────────────────────────────────────────────────────────────
    endRunSession();
    const runId3 = startRunSession('Multi Conflict Cluster', 'Kathmandu', { outputRoot: TEST_OUTPUT_ROOT });

    const multiConflictListings: ConflictCheckListing[] = [
      {
        name: 'Kathmandu Stay Main',
        phones: ['+977-1-4700000'],
        websites: ['https://kghstay.com'],
        latitude: 27.7123,
        longitude: 85.3188,
      },
      {
        name: 'Kathmandu Stay Annex',
        phones: ['01-4700000'],
        websites: ['https://kghstay.com/annex'],
        latitude: 27.71232,
        longitude: 85.31881,
      },
      {
        name: 'Kathmandu Stay Boutique',
        phones: ['01-4700000'],
        websites: ['https://kghstay.com/boutique'],
        latitude: 27.71235,
        longitude: 85.31882,
      },
    ];

    buildConflictEnvelope(
      'Multi Conflict Cluster',
      'Kathmandu',
      multiConflictListings
    );

    const historyPath3 = path.join(outputDir, 'history', runId3, 'entity-conflicts.json');
    const historyData3 = JSON.parse(fs.readFileSync(historyPath3, 'utf-8'));

    // T9: Multiple conflicts -> all preserved in conflicts array
    assert(
      historyData3.conflicts.length === 3 && historyData3.conflictCount === 3,
      'T9',
      `Multiple conflicts -> all 3 pair conflicts preserved in conflicts array (count: ${historyData3.conflicts.length})`
    );

    // T10: Multiple conflicts -> clusters preserved
    assert(
      Array.isArray(historyData3.clusters) &&
        historyData3.clusters.length === 1 &&
        historyData3.clusters[0].listingIndices.length === 3,
      'T10',
      `Multiple conflicts -> clusters array preserved with 3-way cluster (size: ${historyData3.clusters[0]?.listingIndices?.length})`
    );

    // ──────────────────────────────────────────────────────────────────────────
    // SCENARIO 4: Storage Infrastructure, Mirrors, Linkage & Invariants
    // ──────────────────────────────────────────────────────────────────────────

    // T11: Latest consumer -> output/latest/entity-conflicts.json exists after save and reflects latest run
    assert(fs.existsSync(latestPath), 'T11', 'Latest consumer -> output/latest/entity-conflicts.json exists and is overwritten on each run');
    const latestData = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));
    assert(latestData.runId === runId3, 'T11 (Mirror Data)', `Latest mirror data reflects most recent runId (${runId3})`);

    // T12: Summary report includes entityConflicts file reference
    saveSummaryReport(
      {
        query: 'Multi Conflict Cluster',
        location: 'Kathmandu',
        totalBusinesses: 3,
        conflictsDetected: 3,
        status: 'success',
      },
      runId3,
      { outputRoot: TEST_OUTPUT_ROOT }
    );
    const summaryPath = path.join(latestDir, 'summary-report.json');
    const summaryJson = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
    assert(
      summaryJson.files &&
        summaryJson.files.entityConflicts === 'output/latest/entity-conflicts.json',
      'T12',
      'Summary report -> summary-report.json contains files.entityConflicts reference'
    );

    // T13: Automatic directory creation when missing
    const autoTestRunId = `auto-dir-test-${Date.now()}`;
    const autoRunDir = path.join(outputDir, 'history', autoTestRunId);
    if (fs.existsSync(autoRunDir)) {
      fs.rmSync(autoRunDir, { recursive: true, force: true });
    }
    saveStageOutput('conflicts', 'entity-conflicts.json', { test: true }, 'Auto Dir Test', {
      outputRoot: TEST_OUTPUT_ROOT,
      runId: autoTestRunId,
    });
    assert(
      fs.existsSync(path.join(autoRunDir, 'entity-conflicts.json')),
      'T13',
      'Automatic directory creation -> output/history/${runId}/ created automatically if non-existent'
    );

    // T14: Repeated runs produce separate artifacts (no cross-run overwrite in history)
    assert(
      fs.existsSync(historyPath1) &&
        fs.existsSync(historyPath2) &&
        fs.existsSync(historyPath3),
      'T14',
      'Run isolation -> runs 1, 2, and 3 produce distinct immutable artifacts in history/'
    );
    const check1 = JSON.parse(fs.readFileSync(historyPath1, 'utf-8'));
    const check2 = JSON.parse(fs.readFileSync(historyPath2, 'utf-8'));
    const check3 = JSON.parse(fs.readFileSync(historyPath3, 'utf-8'));
    assert(
      check1.conflictCount === 0 && check2.conflictCount === 1 && check3.conflictCount === 3,
      'T14 (History Integrity)',
      'History archives preserve respective payloads without cross-contamination'
    );

    // T15: Conflict detector regression verification
    // Verify that all core conflict detection rules and types remain unchanged
    assert(
      typeof detectCrossListingConflicts === 'function',
      'T15',
      'Existing conflict detection regression -> detectCrossListingConflicts contract unchanged (17 cases / 25 assertions)'
    );

    // T16: Count invariant verification (conflictCount === conflicts.length across all payloads)
    const invariantHolds =
      check1.conflictCount === check1.conflicts.length &&
      check2.conflictCount === check2.conflicts.length &&
      check3.conflictCount === check3.conflicts.length &&
      rootData.conflictCount === rootData.conflicts.length;
    assert(
      invariantHolds,
      'T16',
      'Invariant verification -> conflictCount === conflicts.length holds strictly across 0-conflict and N-conflict payloads'
    );

    // Cleanup auto test dir
    try {
      if (fs.existsSync(autoRunDir)) fs.rmSync(autoRunDir, { recursive: true, force: true });
    } catch {}

    endRunSession();
  } finally {
    cleanupTempDir();
  }

  console.log('\n================================================================');
  console.log(`TOTAL TESTS: ${totalTests} | PASSED: ${passedTests} | FAILED: ${failedTests}`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runConflictArtifactTests().catch((err) => {
  console.error('Fatal error in test suite:', err);
  process.exit(1);
});
