import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { alive, coreBin, coreEnv, engineBin, killCore, killPid, selectCoreImpl, selectEngineImpl, selectEngineIn, windowsHomePids } from './helpers.ts';
import { modelCacheSnapshot } from './model-cache-diagnostics.ts';

test('model-cache diagnostics count partial bytes without exposing names or following nested aliases', () => {
  const root = mkdtempSync(join(tmpdir(), 'p1b-cache-diagnostic-'));
  try {
    const cache = join(root, 'cache');
    const home = join(root, 'home');
    const outside = join(root, 'private-outside');
    for (const dir of [cache, home, outside]) mkdirSync(dir);
    symlinkSync(cache, join(home, 'models'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(outside, join(cache, 'nested-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(cache, 'private-complete-name'), Buffer.alloc(11));
    writeFileSync(join(cache, 'private-download.part-123-test'), Buffer.alloc(7));
    writeFileSync(join(outside, 'private-external-name'), Buffer.alloc(10_000));
    const result = modelCacheSnapshot(home);
    assert.deepEqual(result, { files: 2, bytes: 18, partialFiles: 1, partialBytes: 7, truncated: false, unavailable: false });
    assert.doesNotMatch(JSON.stringify(result), /private|cache-diagnostic|models|123/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('model-cache diagnostics stop at a fixed entry budget and report missing caches without paths', () => {
  const home = mkdtempSync(join(tmpdir(), 'p1b-cache-diagnostic-'));
  try {
    assert.deepEqual(modelCacheSnapshot(home), { files: 0, bytes: 0, partialFiles: 0, partialBytes: 0, truncated: false, unavailable: true });
    const cache = join(home, 'models'); mkdirSync(cache);
    for (let i = 0; i < 300; i += 1) writeFileSync(join(cache, `entry-${i}`), 'x');
    const result = modelCacheSnapshot(home);
    assert.equal(result.truncated, true);
    assert.equal(result.unavailable, false);
    assert.ok(result.files > 0 && result.files <= 256);
    assert.equal(result.bytes, result.files);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Windows reaper selects only the complete home argument, including spaces and regex characters', () => {
  const h = 'C:\\temp\\home (test).1';
  const row = (ProcessId: number, CommandLine: string | null) => ({ ProcessId, CommandLine });
  assert.deepEqual(windowsHomePids([
    row(1001, `node core.js --home "${h}" --test-internals flat-embedder`),
    row(1002, `plur1bus --home "${h}" supervise`),
    row(1003, `node core.js --home "${h}-other"`),
    row(1004, `node core.js --other "${h}"`),
    row(1005, null),
    row(process.pid, `node --home "${h}"`),
  ], h), [1001, 1002]);
  assert.deepEqual(windowsHomePids([row(1006, 'node --home C:\\temp\\h')], 'C:\\temp\\h'), [1006]);
});

for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
  test(`killCore ${signal} terminates the announced runtime when a wrapper has a different pid`, { timeout: 20_000 }, async () => {
    // Windows `core run` waits in a Rust wrapper; unlike POSIX exec, its pid is
    // different from the Node core's ready.pid. Reproduce that topology on every OS.
    const wrapper = spawn(process.execPath, ['--input-type=module', '-e', `
      import { spawn } from 'node:child_process';
      const runtime = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(runtime.pid);
      runtime.on('exit', () => process.exit());
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    const [line] = await once(wrapper.stdout!, 'data');
    const runtimePid = Number(String(line).trim());
    assert.ok(Number.isSafeInteger(runtimePid) && runtimePid > 0);
    try {
      assert.notEqual(runtimePid, wrapper.pid);
      assert.ok(alive(runtimePid));
      await killCore({ child: wrapper, ready: { ready: true, address: 'fixture', pid: runtimePid }, readyMs: 0, stderr: () => '' }, signal);
      assert.equal(alive(runtimePid), false, 'the core runtime must be down before degraded recall is tested');
      assert.ok(wrapper.exitCode !== null || wrapper.signalCode !== null, 'the launcher must also be reaped');
    } finally {
      // The red regression leaves the runtime alive; clean it up even on failure.
      await killPid(runtimePid, 'SIGKILL');
      if (wrapper.exitCode === null && wrapper.signalCode === null) {
        const exited = once(wrapper, 'exit');
        wrapper.kill('SIGKILL');
        await exited;
      }
    }
  });
}

test('killCore reaps a directly started runtime with the same pid', { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const [line] = await once(child.stdout!, 'data');
  const runtimePid = Number(String(line).trim());
  assert.equal(runtimePid, child.pid);
  try {
    await killCore({ child, ready: { ready: true, address: 'fixture', pid: runtimePid }, readyMs: 0, stderr: () => '' }, 'SIGKILL');
    assert.equal(alive(runtimePid), false);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
});

// P4-02, mode S: PLUR1BUS_CORE_IMPL=ts|rust. `ts` is the current behaviour and the default. `rust` (P4-10) runs the front
// door and fails with a clear error when its binary is missing; it never falls back to `ts`.
test('PLUR1BUS_CORE_IMPL defaults to ts and accepts ts explicitly', () => {
  assert.equal(selectCoreImpl({}), 'ts');
  assert.equal(selectCoreImpl({ PLUR1BUS_CORE_IMPL: '' }), 'ts');
  assert.equal(selectCoreImpl({ PLUR1BUS_CORE_IMPL: 'ts' }), 'ts');
});

test('PLUR1BUS_CORE_IMPL rejects unknown values', () => {
  assert.throws(() => selectCoreImpl({ PLUR1BUS_CORE_IMPL: 'node' }), /PLUR1BUS_CORE_IMPL must be "ts" or "rust"/);
});

test('PLUR1BUS_CORE_IMPL=rust fails clearly when plur1bus-core is not built, never falls back to ts, and runs the front door when it is', () => {
  assert.throws(() => selectCoreImpl({ PLUR1BUS_CORE_IMPL: 'rust' }, () => false), /plur1bus-core not built \(P4-03\/P4-10\)/);
  assert.equal(selectCoreImpl({ PLUR1BUS_CORE_IMPL: 'rust' }, () => true), 'rust');
  assert.equal(coreBin({ PLUR1BUS_CORE_BIN: '/x/plur1bus-core' }), resolve('/x/plur1bus-core'));
});


test('every core start goes through the selection', () => {
  const saved = { impl: process.env.PLUR1BUS_CORE_IMPL, bin: process.env.PLUR1BUS_CORE_BIN };
  const dir = mkdtempSync(join(tmpdir(), 'p1b-core-bin-'));
  try {
    process.env.PLUR1BUS_CORE_IMPL = 'rust';
    process.env.PLUR1BUS_CORE_BIN = join(dir, 'missing');
    assert.throws(() => coreEnv(), /plur1bus-core/);
    process.env.PLUR1BUS_CORE_BIN = join(dir, 'plur1bus-core');
    writeFileSync(process.env.PLUR1BUS_CORE_BIN, '');
    const env = coreEnv();
    assert.equal(env.PLUR1BUS_CORE_IMPL, 'rust', 'the CLI and the supervisor run the front door');
    assert.equal(env.PLUR1BUS_CORE_BIN, join(dir, 'plur1bus-core'));
    process.env.PLUR1BUS_CORE_IMPL = 'ts';
    assert.equal(coreEnv().PLUR1BUS_ALLOW_TEST_INTERNALS, '1');
  } finally {
    for (const [k, v] of [['PLUR1BUS_CORE_IMPL', saved.impl], ['PLUR1BUS_CORE_BIN', saved.bin]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PLUR1BUS_ENGINE_IMPL defaults to node, accepts node explicitly and rejects unknown values', () => {
  assert.equal(selectEngineImpl({}), 'node');
  assert.equal(selectEngineImpl({ PLUR1BUS_ENGINE_IMPL: '' }), 'node');
  assert.equal(selectEngineImpl({ PLUR1BUS_ENGINE_IMPL: 'node' }), 'node');
  assert.throws(() => selectEngineImpl({ PLUR1BUS_ENGINE_IMPL: 'ts' }), /PLUR1BUS_ENGINE_IMPL must be "node" or "rust"/);
});

test('PLUR1BUS_ENGINE_IMPL=rust fails clearly without the binary and never falls back to node', () => {
  assert.throws(() => selectEngineImpl({ PLUR1BUS_ENGINE_IMPL: 'rust' }, () => false), /plur1bus-engine not built/);
  assert.equal(selectEngineImpl({ PLUR1BUS_ENGINE_IMPL: 'rust' }, () => true), 'rust');
  assert.equal(engineBin({ PLUR1BUS_ENGINE_BIN: '/opt/x/plur1bus-engine' }), resolve('/opt/x/plur1bus-engine'));
});

test('selecting the engine in a home is a no-op for node and for a home that already chose rust', () => {
  const h = mkdtempSync(join(tmpdir(), 'p1b-engine-impl-'));
  try {
    selectEngineIn(h, 'node');
    assert.equal(existsSync(join(h, 'config.json')), false);
    // A home that already chose the Rust engine is left byte-identical (no CLI call; the CLI path runs in the suites).
    const chosen = JSON.stringify({ schemaVersion: 1, engine: { implementation: 'rust', neo: { enabled: false } } });
    writeFileSync(join(h, 'config.json'), chosen);
    selectEngineIn(h, 'rust');
    assert.equal(readFileSync(join(h, 'config.json'), 'utf8'), chosen);
  } finally { rmSync(h, { recursive: true, force: true }); }
});
