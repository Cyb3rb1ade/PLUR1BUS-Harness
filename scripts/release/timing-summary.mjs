import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
if (!dir) throw new Error('timing directory required');
mkdirSync(dir, { recursive: true });
const totals = new Map();
for (const name of readdirSync(dir).filter(n => /^\d+\.json$/.test(n))) {
  for (const [file, ms] of JSON.parse(readFileSync(join(dir, name)))) totals.set(file, (totals.get(file) ?? 0) + ms);
}
const rows = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 20);
const report = ['Top 20 test files (top-level test/suite duration, ms)', ...rows.map(([name, ms]) => `${ms.toFixed(1)}\t${name}`)].join('\n') + '\n';
writeFileSync(join(dir, 'top-20.txt'), report); console.log(report);
if (!rows.length) console.warn('No completed test-file timings (setup failure or timeout before the first file).');
