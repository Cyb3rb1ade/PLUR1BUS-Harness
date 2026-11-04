import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coreTestConcurrency } from './core-test-concurrency.mjs';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('only explicitly opted-in Core uses bounded file parallelism', () => {
  const facts = { packageName: '@plur1bus/core', cpus: 8, memoryBytes: 16 * 1024 ** 3 };
  assert.equal(coreTestConcurrency(facts), 1);
  assert.equal(coreTestConcurrency({ ...facts, mode: '' }), 1);
  assert.equal(coreTestConcurrency({ ...facts, mode: 'bounded' }), 2);
  assert.equal(coreTestConcurrency({ ...facts, mode: 'bounded', packageName: '@plur1bus/api' }), 1);
  assert.throws(() => coreTestConcurrency({ ...facts, mode: 'unlimited' }), /must be bounded/);
});

test('Core concurrency respects CPU, memory and the absolute two-process ceiling', () => {
  for (const [cpus, gib, expected] of [[1, 16, 1], [4, 7, 1], [4, 8, 1], [4, 11, 1], [4, 12, 2], [8, 16, 2], [64, 512, 2]]) {
    assert.equal(coreTestConcurrency({ mode: 'bounded', packageName: '@plur1bus/core', cpus, memoryBytes: gib * 1024 ** 3 }), expected);
  }
  for (const cpus of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => coreTestConcurrency({
    mode: 'bounded', packageName: '@plur1bus/core', cpus, memoryBytes: 16 * 1024 ** 3 }), /resource inventory/);
});

test('the actual package runner executes every file and propagates failures in serial and bounded modes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-concurrency-'));
  try {
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@plur1bus/core', type: 'module' }));
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, 'test', i + '.test.ts'),
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('probe-" + i + "',()=>assert.notEqual(process.env.CORE_PROBE_FAILURE,'" + i + "'));\n");
    for (const mode of ['', 'bounded']) for (const failure of ['', '1']) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../test-package.mjs', import.meta.url))], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NODE_TEST_CONTEXT: undefined, PLUR1BUS_TEST_SHARD: undefined,
          PLUR1BUS_CORE_TEST_CONCURRENCY: mode, CORE_PROBE_FAILURE: failure },
      });
      assert.equal(result.status, failure ? 1 : 0, result.stdout + result.stderr);
      for (let i = 0; i < 3; i++) assert.ok(result.stdout.includes('probe-' + i), 'every file must execute: ' + result.stdout + result.stderr);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
