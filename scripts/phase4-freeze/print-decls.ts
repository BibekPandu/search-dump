import * as fs from 'node:fs';
const g = JSON.parse(fs.readFileSync('docs/phase0/artifacts/phase4-symbol-deps.json', 'utf8')) as {
  declarations: { name: string; kind: string; isExported: boolean; startLine: number }[];
};
const d = g.declarations;
const out = [
  `total=${d.length} exported=${d.filter((x) => x.isExported).length} private=${d.filter((x) => !x.isExported).length}`,
  ...d.map((x) => `${x.isExported ? 'E' : 'p'} ${String(x.startLine).padStart(5)} ${x.kind.padEnd(10)} ${x.name}`),
].join('\n');
fs.writeFileSync('.phase4-decls.txt', out);
process.stdout.write(out);
