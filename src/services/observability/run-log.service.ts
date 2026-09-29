/**
 * Structured per-step run logging.
 *
 * The pipeline is long, asynchronous and mostly silent: a run that takes
 * four minutes emits dozens of ad-hoc lines and no single place that says
 * which step it is in or how long that step took. When a run is slow or
 * fails, the only signal is inference from log ordering.
 *
 * `logRunStep` emits one searchable line per step boundary in a fixed shape:
 *
 *   [run <id>] step=2 status=ok cache=miss candidates=42 duration=8123ms
 *
 * The shape is deliberately `key=value` so a log line can be searched with a
 * plain text search, and `duration` is always last so a reader's eye lands on
 * it.
 */

export type StepStatus = 'ok' | 'error' | 'skipped';

/** Values are stringified; strings containing whitespace are quoted. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return /\s/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

export function logRunStep(
  runId: string,
  step: number | string,
  status: StepStatus,
  durationMs: number,
  extra: Record<string, unknown> = {}
): void {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(extra)) {
    const rendered = formatValue(value);
    if (rendered !== '') fields.push(`${key}=${rendered}`);
  }
  const duration = Math.max(0, Math.round(durationMs));
  const line = [`[run ${runId}]`, `step=${step}`, `status=${status}`, ...fields, `duration=${duration}ms`]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  console.log(line);
}

/**
 * Run-scoped id shared by every step of one pipeline run.
 *
 * Mastra does not expose a run id to `execute()`, so the id is created when
 * Step 1 begins and reused by Steps 2-4. A process that runs the pipeline
 * more than once (the benchmark scripts do) gets a fresh id per run because
 * `beginRun()` is called at the top of Step 1.
 */
let currentRunId: string | null = null;
let runCounter = 0;

export function beginRun(): string {
  runCounter += 1;
  currentRunId = `r${Date.now().toString(36)}${runCounter.toString(36)}`;
  return currentRunId;
}

export function getCurrentRunId(): string {
  if (currentRunId === null) return beginRun();
  return currentRunId;
}

export type ApiCallCounter = {
  /** Outbound HTTP calls actually made (cache hits excluded). */
  calls: number;
  /** Reads served from a local/disk cache instead of the network. */
  cacheHits: number;
  /** Calls that failed after exhausting retries. */
  failures: number;
};

export type ApiCallCounters = Readonly<Record<string, ApiCallCounter>>;

function blank(): ApiCallCounter {
  return { calls: 0, cacheHits: 0, failures: 0 };
}

const counters = new Map<string, ApiCallCounter>();

function slot(key: string): ApiCallCounter {
  let entry = counters.get(key);
  if (!entry) {
    entry = blank();
    counters.set(key, entry);
  }
  return entry;
}

/** Record an outbound call to a named external dependency. */
export function recordApiCall(key: string): void {
  slot(key).calls += 1;
}

/** Record a read served from cache rather than the network. */
export function recordApiCacheHit(key: string): void {
  slot(key).cacheHits += 1;
}

/** Record a call that ultimately failed. */
export function recordApiFailure(key: string): void {
  slot(key).failures += 1;
}

/**
 * Snapshot of every counter recorded so far.
 *
 * Returned as a plain object so it can be serialized into the run summary
 * without pulling module state into the artifact.
 */
export function getApiCallCounters(): ApiCallCounters {
  const out: Record<string, ApiCallCounter> = {};
  for (const [key, value] of counters) {
    out[key] = { ...value };
  }
  return out;
}

export function resetApiCallCounters(): void {
  counters.clear();
}

/** Canonical counter keys, so callers cannot drift on spelling. */
export const API_CALL_KEYS = {
  serperPlaces: 'serper-places',
  serperSearch: 'serper-search',
  duckDuckGo: 'duckduckgo-fallback',
  tavilyExtract: 'tavily-extract',
  searchCache: 'search-cache',
  geocodeCache: 'geocode-cache',
} as const;

/**
 * Monotonic clock helper so a step body can be timed without repeating Date.now() calls.
 */
export function startTimer(): () => number {
  const startedAt = Date.now();
  return () => Date.now() - startedAt;
}
