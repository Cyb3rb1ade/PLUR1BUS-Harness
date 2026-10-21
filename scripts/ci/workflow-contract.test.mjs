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
    ['packages/core/src/core.ts'], ['crates/plur1bus/tests/fixtures/fake-api.mjs'], ['clients/python/client.py'], ['packages/rpc-schema/schema/rpc.schema.json'],
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

test('docs-hygiene uses the verified pnpm v6 commit', () => {
  const yaml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const block = yaml.split('  docs-hygiene:\n')[1].split(/\n  [a-z][\w-]*:\n/)[0];
  assert.match(block, /pnpm\/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6/);
});

// #621's added macOS browser job used a renamed planning dependency. Catch this even when YAML merges cleanly.
function unknownNeeds(yaml) {
  const declared = new Set([...yaml.matchAll(/^  ([a-z][\w-]*):$/gm)].map(match => match[1]));
  return [...yaml.matchAll(/needs\.([\w-]+)\./g)].map(match => match[1]).filter(name => !declared.has(name));
}
test('workflow dependency references resolve, including a regression for the #621 planning-job rename', () => {
  const yaml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.deepEqual(unknownNeeds(yaml), []);
  const macosJob = "  web-browser-macos:\n    needs: plan\n    if: needs.plan.outputs.proceed == 'true' && needs.plan.outputs.macos == 'true'\n";
  assert.deepEqual(unknownNeeds(yaml + macosJob), ['plan', 'plan']);
  assert.deepEqual(unknownNeeds(yaml + macosJob.replaceAll('needs: plan', 'needs: changes').replaceAll('needs.plan.', 'needs.changes.')), []);
});
