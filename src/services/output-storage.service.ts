import fs from 'fs';
import path from 'path';
import { getProjectRootDir } from './db.service';

function slugify(text: string, maxLen: number = 50): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen);
}

export interface RunSession {
  runId: string;
  query: string;
  location?: string;
  startedAt: string;
}

let activeSession: RunSession | null = null;

export function getOutputDir(): string {
  const rootDir = getProjectRootDir();
  const out = path.join(rootDir, 'output');
  const latest = path.join(out, 'latest');
  const history = path.join(out, 'history');
  if (!fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });
  if (!fs.existsSync(latest)) fs.mkdirSync(latest, { recursive: true });
  if (!fs.existsSync(history)) fs.mkdirSync(history, { recursive: true });
  return out;
}

/**
 * Initializes a new Run Session context so that all stages of this search
 * execution are co-located in one single history directory (e.g. output/history/2026-09-11T...-slug/).
 */
export function startRunSession(
  query: string,
  location?: string,
  options?: { outputRoot?: string }
): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = slugify(query) || 'search';
  const runId = `${ts}-${slug}`;

  activeSession = {
    runId,
    query,
    location,
    startedAt: new Date().toISOString(),
  };

  const outputDir = options?.outputRoot || getOutputDir();
  const runDir = path.join(outputDir, 'history', runId);
  if (!fs.existsSync(runDir)) {
    fs.mkdirSync(runDir, { recursive: true });
  }

  return runId;
}

/**
 * Returns the current active run session ID, or automatically starts one.
 */
export function getRunSessionId(query?: string, location?: string): string {
  if (activeSession) {
    return activeSession.runId;
  }
  return startRunSession(query || 'search', location);
}

/**
 * Returns the current active session data if any.
 */
export function getActiveRunSession(): RunSession | null {
  return activeSession;
}

/**
 * Clears the active run session.
 */
export function endRunSession(): void {
  activeSession = null;
}

export interface SaveStageOutputOptions {
  runId?: string;
  skipLatest?: boolean;
  skipHistory?: boolean;
  skipRootMirror?: boolean;
  outputRoot?: string;
}

/**
 * Saves a stage output file using the Dual-Folder Architecture:
 * 1. Root mirror: output/${filename} (ensures 100% backward compatibility with test suites).
 * 2. History archive: output/history/${runId}/${filename} (all stages grouped into ONE folder).
 * 3. Latest consumer: output/latest/businesses.json (when saving final listings).
 */
export function saveStageOutput(
  stage: string,
  filename: string,
  data: unknown,
  query?: string,
  options?: SaveStageOutputOptions
): void {
  try {
    const outputDir = options?.outputRoot || getOutputDir();
    const runId = options?.runId || (activeSession?.runId ?? (query ? getRunSessionId(query) : undefined));

    if (options?.outputRoot) {
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const latestDir = path.join(outputDir, 'latest');
      if (!fs.existsSync(latestDir)) fs.mkdirSync(latestDir, { recursive: true });
      const historyDir = path.join(outputDir, 'history');
      if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });
    }

    const displayDir = options?.outputRoot ? path.basename(options.outputRoot) : 'output';

    // 1. Root mirror (backward compatibility)
    if (!options?.skipRootMirror) {
      const latestPath = path.join(outputDir, filename);
      fs.writeFileSync(latestPath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`[Storage] Saved ${filename} to ${displayDir}/`);
    }

    // 2. Co-located History run folder
    if (runId && !options?.skipHistory) {
      const runDir = path.join(outputDir, 'history', runId);
      if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, filename), JSON.stringify(data, null, 2), 'utf-8');
      console.log(`[Storage] Archived ${filename} to ${displayDir}/history/${runId}/`);
    }

    // 3. Human/client latest folder
    if (!options?.skipLatest) {
      const latestDir = path.join(outputDir, 'latest');
      if (filename === '3-final-listings.json' || filename === 'results.json') {
        fs.writeFileSync(path.join(latestDir, 'businesses.json'), JSON.stringify(data, null, 2), 'utf-8');
        console.log(`[Storage] Copied ${filename} to ${displayDir}/latest/businesses.json`);
      } else if (filename === 'entity-conflicts.json') {
        fs.writeFileSync(path.join(latestDir, 'entity-conflicts.json'), JSON.stringify(data, null, 2), 'utf-8');
        console.log(`[Storage] Copied ${filename} to ${displayDir}/latest/entity-conflicts.json`);
      }
    }
  } catch (err) {
    console.error(`[Storage] Failed to save ${filename}:`, err);
  }
}

export interface RunSummaryData {
  query: string;
  location?: string;
  timestamp?: string;
  totalBusinesses: number;
  requestedTarget?: number;
  discovered?: number;
  accepted?: number;
  finalized?: number;
  persisted?: number;
  shortfall?: number;
  reasonCounts?: Record<string, number>;
  conflictsDetected?: number;
  executionTimeMs?: number;
  sources?: {
    googleMaps?: number;
    webSearch?: number;
    officialWebsitesCrawled?: number;
  };
  contactsFound?: {
    withPhone?: number;
    withEmail?: number;
    withWebsite?: number;
    withSocialLinks?: number;
  };
  status?: 'success' | 'partial' | 'failed' | 'empty';
  synthesisMethod?: string;
  /**
   * M1 cache diagnostic — deliberately never conflated:
   *   'hit'                → snapshot served from `runs`, zero API calls
   *   'miss'               → lookup ran, nothing fresh was stored
   *   'skipped_mongo_down' → lookup could not run (no URI / unreachable server)
   */
  cacheLookupStatus?: 'hit' | 'miss' | 'skipped_mongo_down';
  telemetry?: Record<string, unknown>;
  notes?: string[];
}

/**
 * Saves a high-level, human-readable summary report to:
 * - output/latest/summary-report.json
 * - output/history/${runId}/summary-report.json
 */
export function saveSummaryReport(
  summary: RunSummaryData,
  runId?: string,
  options?: { outputRoot?: string }
): void {
  try {
    const outputDir = options?.outputRoot || getOutputDir();
    const activeRunId = runId || getRunSessionId(summary.query, summary.location);
    const latestDir = path.join(outputDir, 'latest');
    const historyDir = path.join(outputDir, 'history', activeRunId);

    if (options?.outputRoot) {
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      if (!fs.existsSync(latestDir)) fs.mkdirSync(latestDir, { recursive: true });
      if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });
    }

    const fullSummary = {
      ...summary,
      // Summary timestamp represents the write-event time when the report is finalized to disk
      timestamp: summary.timestamp || new Date().toISOString(),
      files: {
        businesses: 'output/latest/businesses.json',
        summaryReport: 'output/latest/summary-report.json',
        historyRunArchive: `output/history/${activeRunId}/`,
        entityConflicts: 'output/latest/entity-conflicts.json',
      },
    };

    fs.writeFileSync(path.join(latestDir, 'summary-report.json'), JSON.stringify(fullSummary, null, 2), 'utf-8');
    console.log('[Storage] Saved summary-report.json to output/latest/');

    if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, 'summary-report.json'), JSON.stringify(fullSummary, null, 2), 'utf-8');
    console.log(`[Storage] Archived summary-report.json to output/history/${activeRunId}/`);
  } catch (err) {
    console.error('[Storage] Failed to save summary report:', err);
  }
}
