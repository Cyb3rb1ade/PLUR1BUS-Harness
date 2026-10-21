import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify } from './changes.mjs';
import { selections, evaluateGate } from './gate.mjs';

// Execute the narrow boolean expression subset used at the actual job boundaries.
function condition(expression, outputs) {
  const replaced = expression.replaceAll('always()', 'true').replace(/needs\.changes\.outputs\.([\w-]+)/g,
    (_, key) => { assert(key in outputs, key); return JSON.stringify(outputs[key]); });
  assert.match(replaced, /^[\s()"'a-z=|&]+$/);
  return Function(`return (${replaced});`)();
}

test('every workflow job is in the gate and actual job conditions match its skip policy', () => {
  const yaml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const blocks = yaml.slice(yaml.indexOf('\njobs:\n')).split(/(?=^  [a-z][\w-]*:\n)/m).slice(1);
  const jobs = Object.fromEntries(blocks.map(block => [/^  ([\w-]+):/.exec(block)[1], block]));
  const known = Object.keys(selections({})).sort();
  assert.deepEqual(Object.keys(jobs).filter(k => !['changes', 'ci-gate'].includes(k)).sort(), known);
  const dependencies = /^    needs: \[([^\]]+)\]/m.exec(jobs['ci-gate'])[1].split(',').map(s => s.trim()).sort();
  assert.deepEqual(dependencies, ['changes', ...known].sort());
  for (const files of [['docs/a.md'], ['packages/web/src/app.tsx'], ['crates/x/src/lib.rs'],
    ['packages/core/src/core.ts'], ['clients/python/client.py'], ['packages/rpc-schema/schema/rpc.schema.json'],
    ['.github/workflows/ci.yml'], ['pnpm-lock.yaml']]) {
    const outputs = Object.fromEntries(Object.entries({ proceed: true, ...classify({ event: 'pull_request', files }) }).map(([k, v]) => [k, String(v)]));
    const expected = selections(outputs);
    const needs = { changes: { result: 'success', outputs } };
    for (const job of known) {
      const scheduled = condition(/^    if: (.*)$/m.exec(jobs[job])[1], outputs);
      assert.equal(scheduled, expected[job], `${files}:${job}`);
      needs[job] = { result: scheduled ? 'success' : 'skipped' };
    }
    assert.deepEqual(evaluateGate(needs), []);
  }
});

test('every executable CI job has a bounded timeout, including the Core shard and its gate', () => {
  const yaml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobs = yaml.slice(yaml.indexOf('\njobs:\n')).split(/(?=^  [a-z][\w-]*:\n)/m).slice(1);
  for (const job of jobs) {
    const name = /^  ([\w-]+):/.exec(job)[1];
    const timeout = /^    timeout-minutes: (.+)$/m.exec(job)?.[1];
    assert.ok(timeout, `${name}: explicit job timeout required`);
    const minutes = timeout.startsWith('${{') ? [...timeout.matchAll(/(?:&&|\|\|)\s*(\d+)/g)].map(m => Number(m[1])) : [Number(timeout)];
    assert.ok(minutes.length > 0 && minutes.every(n => Number.isInteger(n) && n >= 1 && n <= 120), `${name}: unreasonable job budget ${timeout}`);
  }
});
