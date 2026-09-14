import fs from 'fs';
import path from 'path';
import {
  startRunSession,
  getRunSessionId,
  getActiveRunSession,
  endRunSession,
  saveStageOutput,
  saveSummaryReport,
  getOutputDir,
} from '../src/services/output-storage.service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

async function runTests() {
  console.log('===============================================================');
  console.log('🧪 TESTING DUAL-FOLDER OUTPUT ARCHITECTURE & RUN CO-LOCATION');
  console.log('===============================================================\n');

  const outputDir = getOutputDir();
  console.log(`Base Output Directory: ${outputDir}`);

  // --- TEST 1: Run Session Context Management ---
  console.log('--- TEST 1: Run Session Context Management ---');
  endRunSession();
  assert(getActiveRunSession() === null, 'Active session is initially null');

  const runId = startRunSession('Specialty Coffee', 'Kathmandu');
  assert(typeof runId === 'string' && runId.includes('specialty-coffee'), 'startRunSession returned valid runId slug');

  const active = getActiveRunSession();
  assert(active !== null, 'Active session is populated');
  assert(active?.query === 'Specialty Coffee', 'Active session preserves query');
  assert(active?.location === 'Kathmandu', 'Active session preserves location');

  const retrievedRunId = getRunSessionId();
  assert(retrievedRunId === runId, 'getRunSessionId returns identical active runId');

  // --- TEST 2: Multi-Stage Co-location in Single History Run Directory ---
  console.log('\n--- TEST 2: Multi-Stage Co-location in History Folder ---');
  saveStageOutput('research-agent', '0-test-report.json', { report: 'ok' }, 'Specialty Coffee');
  saveStageOutput('deep-extract', '2-test-extractions.json', [{ url: 'test' }], 'Specialty Coffee');
  saveStageOutput('final-listings', '3-final-listings.json', [{ name: 'Test Roastery', location: 'Kathmandu' }], 'Specialty Coffee');

  const historyRunDir = path.join(outputDir, 'history', runId);
  assert(fs.existsSync(historyRunDir), `History run directory exists: output/history/${runId}/`);

  const historyFiles = fs.readdirSync(historyRunDir);
  console.log(`Files co-located inside output/history/${runId}/:`, historyFiles);
  assert(historyFiles.includes('0-test-report.json'), 'Stage 0 co-located in history run folder');
  assert(historyFiles.includes('2-test-extractions.json'), 'Stage 2 co-located in history run folder');
  assert(historyFiles.includes('3-final-listings.json'), 'Stage 3 co-located in history run folder');
  assert(historyFiles.length >= 3, 'All stages preserved in the SAME single history directory (NO FRAGMENTATION)');

  // --- TEST 3: Root Mirror Backward Compatibility ---
  console.log('\n--- TEST 3: Root Mirror Backward Compatibility ---');
  const rootMirror0 = path.join(outputDir, '0-test-report.json');
  const rootMirror3 = path.join(outputDir, '3-final-listings.json');
  assert(fs.existsSync(rootMirror0), 'Root mirror 0-test-report.json exists');
  assert(fs.existsSync(rootMirror3), 'Root mirror 3-final-listings.json exists');

  // --- TEST 4: Latest Consumer Files (businesses.json) ---
  console.log('\n--- TEST 4: Latest Consumer Folder (businesses.json) ---');
  const latestBusinessesPath = path.join(outputDir, 'latest', 'businesses.json');
  assert(fs.existsSync(latestBusinessesPath), 'output/latest/businesses.json exists');

  const businessesData = JSON.parse(fs.readFileSync(latestBusinessesPath, 'utf-8'));
  assert(Array.isArray(businessesData), 'businesses.json contains an array');
  assert(businessesData.length === 1 && businessesData[0].name === 'Test Roastery', 'businesses.json matches final listings');

  // --- TEST 5: Executive Summary Report (summary-report.json) ---
  console.log('\n--- TEST 5: Executive Summary Report (summary-report.json) ---');
  saveSummaryReport({
    query: 'Specialty Coffee',
    location: 'Kathmandu',
    totalBusinesses: 1,
    executionTimeMs: 4200,
    sources: {
      googleMaps: 1,
      webSearch: 0,
      officialWebsitesCrawled: 1,
    },
    contactsFound: {
      withPhone: 1,
      withEmail: 1,
      withWebsite: 1,
      withSocialLinks: 1,
    },
    status: 'success',
    synthesisMethod: 'UnoRouter AI Consensus Tribunal',
  });

  const latestSummaryPath = path.join(outputDir, 'latest', 'summary-report.json');
  assert(fs.existsSync(latestSummaryPath), 'output/latest/summary-report.json exists');

  const historySummaryPath = path.join(historyRunDir, 'summary-report.json');
  assert(fs.existsSync(historySummaryPath), `output/history/${runId}/summary-report.json exists`);

  const summaryData = JSON.parse(fs.readFileSync(latestSummaryPath, 'utf-8'));
  console.log('Generated Summary Report:', JSON.stringify(summaryData, null, 2));
  assert(summaryData.query === 'Specialty Coffee', 'Summary preserves query');
  assert(summaryData.totalBusinesses === 1, 'Summary preserves total businesses');
  assert(summaryData.contactsFound?.withPhone === 1, 'Summary preserves contact breakdown');
  assert(Boolean(summaryData.files?.businesses), 'Summary includes relative path to businesses.json');
  assert(Boolean(summaryData.files?.historyRunArchive), 'Summary includes relative path to history archive');

  // Clean up test-only artifacts
  try {
    if (fs.existsSync(rootMirror0)) fs.unlinkSync(rootMirror0);
    if (fs.existsSync(path.join(historyRunDir, '0-test-report.json'))) fs.unlinkSync(path.join(historyRunDir, '0-test-report.json'));
    if (fs.existsSync(path.join(historyRunDir, '2-test-extractions.json'))) fs.unlinkSync(path.join(historyRunDir, '2-test-extractions.json'));
  } catch {}

  endRunSession();
  assert(getActiveRunSession() === null, 'Session cleanly terminated at end of execution');

  console.log('\n===============================================================');
  console.log('🎉 ALL DUAL-FOLDER OUTPUT & RUN CO-LOCATION TESTS PASSED (100%)');
  console.log('===============================================================');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
