import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alive, coreEnv, killCore, killPid, selectCoreImpl, windowsHomePids } from './helpers.ts';
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

// P4-02, mode S: PLUR1BUS_CORE_IMPL=ts|rust. `ts` is the current behaviour and the default. `rust` must fail with a clear
// error until the front door exists; it must never fall back to `ts`.
test('PLUR1BUS_CORE_IMPL defaults to ts and accepts ts explicitly', () => {
  assert.equal(selectCoreImpl({}), 'ts');
  assert.equal(selectCoreImpl({ PLUR1BUS_CORE_IMPL: '' }), 'ts');
  assert.equal(selectCoreImpl({ PLUR1BUS_CORE_IMPL: 'ts' }), 'ts');
});

test('PLUR1BUS_CORE_IMPL rejects unknown values', () => {
  assert.throws(() => selectCoreImpl({ PLUR1BUS_CORE_IMPL: 'node' }), /PLUR1BUS_CORE_IMPL must be "ts" or "rust"/);
});

test('PLUR1BUS_CORE_IMPL=rust fails clearly when plur1bus-core is not built, and never falls back to ts', () => {
  assert.throws(() => selectCoreImpl({ PLUR1BUS_CORE_IMPL: 'rust' }, () => false), /plur1bus-core not built \(P4-03\/P4-10\)/);
  // Even with a binary present, the supervisor does not start it before P4-10: still an error, not the ts core.
  assert.throws(() => selectCoreImpl({ PLUR1BUS_CORE_IMPL: 'rust' }, () => true), /front door is not wired into the supervisor yet \(P4-10\)/);
});

test('every core start goes through the selection', () => {
  const saved = process.env.PLUR1BUS_CORE_IMPL;
  try {
    process.env.PLUR1BUS_CORE_IMPL = 'rust';
    assert.throws(() => coreEnv(), /plur1bus-core/);
    process.env.PLUR1BUS_CORE_IMPL = 'ts';
    assert.equal(coreEnv().PLUR1BUS_ALLOW_TEST_INTERNALS, '1');
  } finally {
    if (saved === undefined) delete process.env.PLUR1BUS_CORE_IMPL; else process.env.PLUR1BUS_CORE_IMPL = saved;
  }
});
