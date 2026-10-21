import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify } from './changes.mjs';
import { selections, evaluateGate, UNGATED } from './gate.mjs';

// Execute the narrow boolean expression subset used at the actual job boundaries.
function condition(expression, outputs) {
  const replaced = expression.replaceAll('always()', 'true').replace(/needs\.changes\.outputs\.([\w-]+)/g,
    (_, key) => { assert(key in outputs, key); return JSON.stringify(outputs[key]); });
  assert.match(replaced, /^[\s()"'a-z=|&]+$/);
  return Function(`return (${replaced});`)();
}

const workflow = () => readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const jobBlocks = yaml => Object.fromEntries(yaml.slice(yaml.indexOf('\njobs:\n')).split(/(?=^  [a-z][\w-]*:\n)/m).slice(1)
  .map(block => [/^  ([\w-]+):/.exec(block)[1], block]));
// A job's block also carries the comment lines written above the next job; they are not steps.
const stepsOf = block => block.slice(block.indexOf('\n    steps:\n')).replace(/(?:^  #.*\n)+$/m, '');

test('every workflow job is either in the gate or deliberately ungated, and job conditions match the skip policy', () => {
  const jobs = jobBlocks(workflow());
  const gated = Object.keys(selections({})).sort();
  assert.deepEqual(Object.keys(jobs).filter(k => !['changes', 'ci-gate'].includes(k)).sort(), [...gated, ...UNGATED].sort());
  const dependencies = /^    needs: \[([^\]]+)\]/m.exec(jobs['ci-gate'])[1].split(',').map(s => s.trim()).sort();
  assert.deepEqual(dependencies, ['changes', ...gated].sort());
  for (const files of [['docs/a.md'], ['packages/web/src/app.tsx'], ['crates/x/src/lib.rs'],
    ['packages/core/src/core.ts'], ['crates/plur1bus/tests/fixtures/fake-api.mjs'], ['clients/python/client.py'], ['packages/rpc-schema/schema/rpc.schema.json'],
    ['docs/errors.md'], ['.github/workflows/ci.yml'], ['pnpm-lock.yaml']]) {
    const outputs = Object.fromEntries(Object.entries({ proceed: true, macos: true, ...classify({ event: 'pull_request', files }) }).map(([k, v]) => [k, String(v)]));
    const expected = selections(outputs);
    const needs = { changes: { result: 'success', outputs } };
    for (const job of gated) {
      const scheduled = condition(/^    if: (.*)$/m.exec(jobs[job])[1], outputs);
      assert.equal(scheduled, expected[job], `${files}:${job}`);
      needs[job] = { result: scheduled ? 'success' : 'skipped' };
    }
    assert.deepEqual(evaluateGate(needs), []);
  }
});

test('the ungated jobs can neither delay nor fail the gate', () => {
  const jobs = jobBlocks(workflow());
  const gateNeeds = /^    needs: \[([^\]]+)\]/m.exec(jobs['ci-gate'])[1];
  for (const job of UNGATED) assert(!new RegExp(`\\b${job}\\b`).test(gateNeeds), job);
  // A failing leg of an ungated job must not change the verdict, and a failing gated job must.
  const outputs = Object.fromEntries(Object.entries({ proceed: true, macos: true, ...classify({ event: 'push', files: [] }) }).map(([k, v]) => [k, String(v)]));
  const needs = { changes: { result: 'success', outputs }, ...Object.fromEntries(Object.keys(selections(outputs)).map(job => [job, { result: 'success' }])) };
  assert.deepEqual(evaluateGate(needs), []);
  assert(evaluateGate({ ...needs, unit: { result: 'failure' } }).length > 0);
  assert(evaluateGate({ ...needs, 'unit-os': { result: 'failure' } }).some(e => e.includes('unrecognized job: unit-os')),
    'an ungated job in needs is a contract error, never a silent pass');
});

test('unit-os preserves every unit step while Ubuntu runs Core only in its measured shards', () => {
  const jobs = jobBlocks(workflow());
  const coreSplit = '          # The Core files run exactly once in core-unit-shard; every other package stays here.\n' +
    '          node scripts/run-ts-tests.mjs --filter=!@plur1bus/core\n';
  assert.ok(stepsOf(jobs.unit).includes(coreSplit));
  assert.ok(stepsOf(jobs['unit-os']).includes('          pnpm test\n'));
  assert.equal(stepsOf(jobs['unit-os']), stepsOf(jobs.unit).replace(coreSplit, '          pnpm test\n'));
  assert.match(jobs['core-unit-shard'], /pnpm --filter @plur1bus\/core test/);
  assert.match(jobs['core-unit'], /core-unit-shard/);
  const field = (block, re) => re.exec(block)[0];
  assert.equal(field(jobs['unit-os'], /^    if: .*$/m), field(jobs.unit, /^    if: .*$/m));
  assert.equal(field(jobs['unit-os'], /^    timeout-minutes: .*$/m), field(jobs.unit, /^    timeout-minutes: .*$/m));
  const matrix = block => /^        os: \[([^\]]+)\]/m.exec(block)[1].split(',').map(x => x.trim());
  assert.deepEqual(matrix(jobs.unit), ['ubuntu-24.04']);
  assert.deepEqual(matrix(jobs['unit-os']), ['macos-15', 'windows-2025']);
  // The check names stay `unit (ubuntu-24.04)`, `unit (macos-15)`, `unit (windows-2025)`.
  assert.match(jobs['unit-os'], /^    name: unit \(\$\{\{ matrix\.os \}\}\)$/m);
});

test('a label run for another label cannot report a check named ci-gate', () => {
  const yaml = workflow();
  const gate = jobBlocks(yaml)['ci-gate'];
  const expression = /^    name: \$\{\{ (.*) \}\}$/m.exec(gate)[1];
  const nameFor = (action, label) => {
    const replaced = expression.replace('github.event.action', JSON.stringify(action)).replace('github.event.label.name', JSON.stringify(label));
    assert.match(replaced, /^[\s()"'\w:=!|&-]+$/);
    return Function(`return (${replaced});`)();
  };
  assert.equal(nameFor('opened', ''), 'ci-gate');
  assert.equal(nameFor('synchronize', ''), 'ci-gate');
  assert.equal(nameFor('', ''), 'ci-gate'); // push, schedule, workflow_dispatch
  assert.equal(nameFor('labeled', 'ci:macos'), 'ci-gate'); // a real run: every job runs, nothing else is the gate for it
  assert.notEqual(nameFor('labeled', 'documentation'), 'ci-gate');
  assert.notEqual(nameFor('labeled', ''), 'ci-gate');
  // The same predicate decides the no-op concurrency group, so the no-op run never cancels the real one.
  const predicate = "github.event.action == 'labeled' && github.event.label.name != 'ci:macos'";
  assert(/^concurrency:\n  group: .*$/m.test(yaml) && yaml.slice(yaml.indexOf('\nconcurrency:'), yaml.indexOf('\njobs:')).includes(predicate));
  assert(gate.includes(predicate));
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
