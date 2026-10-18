import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFanoutEval, FANOUT_CASES } from '../packages/core/src/collab/fanout-eval.ts';
const dir = await mkdtemp(join(tmpdir(), 'm5-eval-report-'));
try {
  const rows = await runFanoutEval(dir);
  const metrics = Object.fromEntries(['single', 'peer'].map(mode => { const selected = rows.filter(r => r.mode === mode); return [mode, { correct: selected.filter(r => r.correct).length, cases: selected.length, settledTokens: selected.reduce((n,r) => n+r.settledTokens,0), modelCalls: selected.reduce((n,r) => n+r.modelCalls,0) }]; }));
  const report = { version: 'plur1bus.m5-fanout-eval/1', kind: 'deterministic-fixture-replay', interpretation: 'Routing and equal-budget regression only; no live-model quality advantage established. Fan-out remains off.', tokenBudgetPerCaseAndMode: 8192, fixtures: FANOUT_CASES, metrics, rows };
  const text = JSON.stringify(report, null, 2) + '\n';
  const output = new URL('../docs/evals/m5-fanout.json', import.meta.url);
  if (process.argv.includes('--check')) { if (await readFile(output, 'utf8') !== text) throw Error('M5 evaluation report differs'); }
  else { await mkdir(new URL('../docs/evals/', import.meta.url), { recursive: true }); await writeFile(output, text); }
  process.stdout.write(JSON.stringify(metrics) + '\n');
} finally { await rm(dir, { recursive: true, force: true }); }
