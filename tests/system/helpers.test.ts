import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { alive, killCore, killPid, windowsHomePids } from './helpers.ts';

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
