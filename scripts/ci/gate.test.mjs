import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate, selections } from './gate.mjs';

const flags = (extra = {}) => ({ proceed: 'true', rust: 'false', 'ts-core': 'false', web: 'false', python: 'false',
  documents: 'false', workflows: 'false', 'engine-pin': 'false', 'docs-only': 'true', ...extra });
function needs(outputs, results = {}) {
  return { changes: { result: 'success', outputs }, ...Object.fromEntries(
    Object.entries(selections(outputs)).map(([job, required]) => [job, { result: results[job] ?? (required ? 'success' : 'skipped') }])) };
}

test('docs-only runs only docs/hygiene and deliberately omits every expensive job', () => {
  const selected = selections(flags());
  assert.deepEqual(Object.entries(selected).filter(([, v]) => v).map(([k]) => k), ['docs-hygiene']);
  assert.deepEqual(evaluateGate(needs(flags())), []);
});

test('the full matrix requires every listed job and accepts only complete success', () => {
  const outputs = flags({ rust: 'true', 'ts-core': 'true', web: 'true', python: 'true', documents: 'true', workflows: 'true', 'docs-only': 'false' });
  assert(Object.values(selections(outputs)).every(Boolean));
  assert.deepEqual(evaluateGate(needs(outputs)), []);
  for (const job of Object.keys(selections(outputs))) for (const result of ['failure', 'cancelled', 'skipped', '', undefined]) {
    const input = needs(outputs);
    input[job] = result === undefined ? undefined : { result };
    assert(evaluateGate(input).length > 0, `${job}:${result}`);
  }
});

test('failure or cancellation is never accepted even for an omitted job', () => {
  for (const job of Object.keys(selections(flags()))) for (const result of ['failure', 'cancelled']) {
    assert(evaluateGate(needs(flags(), { [job]: result })).length > 0, `${job}:${result}`);
  }
});

test('missing and malformed plan outputs fail closed', () => {
  for (const key of Object.keys(flags())) for (const value of ['', undefined, true, 'TRUE', '1']) {
    const outputs = flags({ [key]: value });
    assert(evaluateGate({ changes: { result: 'success', outputs } }).length > 0, `${key}:${value}`);
  }
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) assert(evaluateGate({ changes: { result, outputs: flags() } }).length > 0);
});

test('a non-macOS label no-op needs successful changes plus deliberate skips', () => {
  const outputs = flags({ proceed: 'false' });
  assert(Object.values(selections(outputs)).every(value => !value));
  assert.deepEqual(evaluateGate(needs(outputs)), []);
  assert(evaluateGate(needs(outputs, { unit: 'cancelled' })).length > 0);
});

test('web-only requires browser build, all shards, manifest gate and hygiene, no Rust unit matrix', () => {
  assert.deepEqual(Object.entries(selections(flags({ web: 'true', 'docs-only': 'false' }))).filter(([, v]) => v).map(([k]) => k).sort(),
    ['docs-hygiene', 'web-browser', 'web-browser-build', 'web-browser-shard']);
});

test('an added job cannot silently bypass the gate', () => {
  const input = needs(flags());
  input['new-check'] = { result: 'failure' };
  assert(evaluateGate(input).some(error => error.includes('new-check')));
});

test('Core shards and their exact-partition gate are required only for selected TypeScript suites', () => {
  for (const selected of [false, true]) {
    const outputs = flags({ 'ts-core': String(selected), 'docs-only': String(!selected) });
    for (const job of ['core-unit-shard', 'core-unit']) {
      assert.equal(selections(outputs)[job], selected, job);
      if (selected) for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
        const input = needs(outputs);
        input[job] = result === undefined ? undefined : { result };
        assert(evaluateGate(input).some(error => error.includes(job)), `${job}:${result}`);
      }
    }
  }
});
