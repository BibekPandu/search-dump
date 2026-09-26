/**
 * Phase 0 (0.8) — package.json script-target validator.
 *
 * Every `tsx <file>` reference in package.json must point at a file that exists.
 * Run before and after the Phase 0.8 cleanup to prove the missing-target count
 * goes from 3 to 0.
 *
 * Usage:
 *   npx tsx scripts/fixtures/golden/check-scripts.ts [--json <file>]
 */
import fs from 'node:fs';
import path from 'node:path';

interface ScriptReport {
  totalScripts: number;
  commands: number;
  missing: Array<{ script: string; target: string }>;
  valid: string[];
}

const REPO_ROOT = process.cwd();

function inspect(): ScriptReport {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  const missing: ScriptReport['missing'] = [];
  const valid: string[] = [];
  let commands = 0;

  for (const [name, command] of Object.entries(scripts)) {
    for (const step of command.split('&&')) {
      const trimmed = step.trim();
      if (!trimmed) continue;
      commands += 1;
      const match = /^tsx\s+(.+)$/.exec(trimmed);
      if (!match) continue;
      const target = match[1].trim();
      if (fs.existsSync(path.join(REPO_ROOT, target))) valid.push(`${name}: ${target}`);
      else missing.push({ script: name, target });
    }
  }

  return { totalScripts: Object.keys(scripts).length, commands, missing, valid };
}

function main(): void {
  const report = inspect();
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--json');
  if (outIndex >= 0 && args[outIndex + 1]) {
    const target = path.resolve(REPO_ROOT, args[outIndex + 1]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  console.log(`scripts: ${report.totalScripts}`);
  console.log(`chain commands: ${report.commands}`);
  console.log(`valid tsx targets: ${report.valid.length}`);
  console.log(`missing tsx targets: ${report.missing.length}`);
  for (const entry of report.missing) console.log(`  MISSING ${entry.script} -> ${entry.target}`);
  process.exit(report.missing.length === 0 ? 0 : 1);
}

main();
