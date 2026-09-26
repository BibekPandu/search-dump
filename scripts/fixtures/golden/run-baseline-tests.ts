/**
 * Phase 0 (0.1) — Baseline test catalogue.
 *
 * cspell:ignore ETIMEDOUT
 *
 * Runs every suite referenced by the `test` script in package.json, one suite
 * per child process, and records per-suite pass/fail, duration and output tails.
 * Unlike `npm test` (a `&&` chain that stops at the first failure) this runner
 * executes every suite so pre-existing failures can be classified rather than
 * merely observed.
 *
 * Record-only by design: the artifact is evidence, not a gate. Pass `--strict`
 * to exit 1 when any suite fails. A suite that exceeds the timeout is recorded
 * as `timedOut` and reported separately from a genuine assertion failure.
 *
 * Usage:
 *   npx tsx scripts/fixtures/golden/run-baseline-tests.ts [--out <file.json>] [--timeout-ms 180000]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface SuiteResult {
  suite: string;
  script: string;
  status: 'passed' | 'failed' | 'timedOut';
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

const OUTPUT_TAIL_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 180_000;

function tail(value: string | null | undefined, maxChars = OUTPUT_TAIL_CHARS): string {
  if (!value) return '';
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

/** Extract the suite file list from the `test` script, preserving chain order. */
export function suitesFromPackageJson(cwd = process.cwd()): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const chain = pkg.scripts?.test;
  if (!chain) throw new Error('package.json has no "test" script');

  return chain
    .split('&&')
    .map((command) => command.trim())
    .filter(Boolean)
    .map((command) => {
      const match = /^tsx\s+(.+)$/.exec(command);
      if (!match) throw new Error(`Unsupported test chain entry: ${command}`);
      return match[1].trim();
    });
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const outPath = path.resolve(argValue(args, '--out') ?? 'docs/phase0/artifacts/baseline-test-results.json');
  const timeoutMs = Number(argValue(args, '--timeout-ms') ?? DEFAULT_TIMEOUT_MS);
  const cwd = process.cwd();

  const suites = suitesFromPackageJson(cwd);
  const missing = suites.filter((suite) => !fs.existsSync(path.join(cwd, suite)));

  console.log(`Baseline runner: ${suites.length} suites referenced by "npm test"`);
  if (missing.length) console.log(`Missing suite files: ${missing.join(', ')}`);

  const results: SuiteResult[] = [];
  const startedAt = new Date().toISOString();

  for (const suite of suites) {
    const start = Date.now();
    const run = spawnSync(`npx tsx ${suite}`, {
      cwd,
      shell: true,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    const durationMs = Date.now() - start;
    const timedOut = run.error !== undefined && run.error !== null && (run.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    const exitCode = typeof run.status === 'number' ? run.status : null;

    results.push({
      suite,
      script: 'test',
      status: timedOut ? 'timedOut' : exitCode === 0 ? 'passed' : 'failed',
      exitCode,
      durationMs,
      stdoutTail: tail(run.stdout),
      stderrTail: tail(run.stderr),
    });

    const result = results[results.length - 1];
    console.log(
      `${result.status === 'passed' ? 'PASS' : result.status === 'failed' ? 'FAIL' : 'TIMEOUT'} ${suite} (${durationMs} ms)`
    );
  }

  const passed = results.filter((result) => result.status === 'passed');
  const failed = results.filter((result) => result.status !== 'passed');

  const artifact = {
    phase: '0.1',
    purpose: 'Pre-existing baseline of every suite referenced by package.json#scripts.test',
    startedAt,
    finishedAt: new Date().toISOString(),
    cwd,
    node: process.version,
    timeoutMs,
    totals: {
      suites: results.length,
      passed: passed.length,
      failed: failed.length,
      failedSuites: failed.map((result) => result.suite),
    },
    results,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  console.log(`\nBaseline artifact written: ${outPath}`);
  console.log(`Suites: ${results.length} | passed: ${passed.length} | failed: ${failed.length}`);

  if (args.includes('--strict') && failed.length > 0) process.exit(1);
  if (missing.length > 0 && args.includes('--strict')) process.exit(1);
}

main();
