import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { sandboxSpawn, preparePolicy, detectSandbox, seatbeltProfile, type SandboxPolicy } from '../../../src/tools/sandbox/index.ts';
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'd106-'));
  const home = join(dir, 'h'), root = join(dir, 'workspace'), userHome = join(dir, 'u');
  for (const p of [home, root, userHome, join(home, 'run'), join(home, 'state')]) await mkdir(p, { recursive: true });
  const policy: SandboxPolicy = { home, userHome, cwd: root, readRoots: [{ id: 'w', path: root }], writeRoots: [{ id: 'w', path: root }], network: 'none', envAllow: ['PATH', 'PLUR1BUS_HOME', 'NODE_OPTIONS', 'AUTH', 'LANG'], env: { PATH: '/usr/bin:/bin', LANG: 'C', PLUR1BUS_HOME: home, NODE_OPTIONS: '--inspect', AUTH: 'private-value' }, limits: { timeoutMs: 1500, cpuSeconds: 1, memoryBytes: 2 * 1024 ** 3, maxProcesses: 32, maxOutputBytes: 512 }, limitsHelper: fileURLToPath(new URL('../../../../../target/debug/plur1bus-sandbox-limits', import.meta.url)) };
  return { dir, home, root, policy, close: () => rm(dir, { recursive: true, force: true }) };
}
test('detection fails closed for missing helper and unavailable Windows isolation', async () => {
  assert.equal((await detectSandbox('/missing')).available, false);
  assert.equal((await detectSandbox('/missing', 'win32')).strength, 'none');
});
test('policy refuses traversal, changed roots and protected cwd; profile denies names dynamically', async () => {
  const f = await fixture(); try {
    await assert.rejects(preparePolicy({ ...f.policy, cwd: f.root + '/../workspace' }));
    await assert.rejects(preparePolicy({ ...f.policy, readRoots: [{ id: 'w', path: f.root, identity: { dev: '0', ino: '0' } }] }));
    await assert.rejects(preparePolicy({ ...f.policy, cwd: join(f.home, 'run') }));
    const profile = seatbeltProfile(await preparePolicy(f.policy));
    assert.match(profile, /deny default/); assert.match(profile, /run/); assert.match(profile, /regex/); assert.doesNotMatch(profile, /allow process-fork/);
    await assert.rejects(sandboxSpawn(['/bin/echo', 'x'], { ...f.policy, limits: { ...f.policy.limits, timeoutMs: NaN } }));
  } finally { await f.close(); }
});
test('real backend: filesystem, network, environment, output and abort adversarial cases', { timeout: 30000 }, async t => {
  const f = await fixture(); try {
    const d = await detectSandbox(f.policy.limitsHelper);
    if (!d.available) { t.skip(d.reason); return; }
    if (process.platform === 'linux') f.policy.writeRoots = [];
    const probe = await sandboxSpawn(['/bin/echo', 'ready'], f.policy);
    assert.equal(probe.exitCode, 0, JSON.stringify(probe)); assert.match(probe.stdout, /ready/);
    await writeFile(join(f.home, 'run', 'core.token'), 'private-fixture');
    await symlink(join(f.home, 'run', 'core.token'), join(f.root, 'escape'));
    for (const file of [join(f.home, 'run', 'core.token'), join(f.root, 'escape'), f.root + '/../h/run/core.token']) {
      const r = await sandboxSpawn(['/bin/cat', file], f.policy); assert.notEqual(r.exitCode, 0); assert.doesNotMatch(r.stdout, /private-fixture/);
    }
    const env = await sandboxSpawn(['/usr/bin/env'], f.policy); assert.doesNotMatch(env.stdout, /PLUR1BUS|NODE_OPTIONS|AUTH=/);
    const write = await sandboxSpawn(['/usr/bin/touch', join(f.dir, 'outside')], f.policy); assert.notEqual(write.exitCode, 0);
    const server = createServer(s => { s.end('HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok'); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as { port: number }).port;
      const network = await sandboxSpawn(['/usr/bin/curl', '--max-time', '1', `http://127.0.0.1:${port}`], f.policy); assert.notEqual(network.exitCode, 0);
    } finally { await new Promise<void>(r => server.close(() => r())); }
    await writeFile(join(f.root, '.env'), 'private-fixture');
    const credential = await sandboxSpawn(['/bin/cat', join(f.root, '.env')], f.policy); assert.doesNotMatch(credential.stdout, /private-fixture/);
    if (process.platform === 'darwin') {
      const inside = await sandboxSpawn(['/usr/bin/touch', join(f.root, 'inside')], f.policy); assert.equal(inside.exitCode, 0);
      const fork = await sandboxSpawn(['/usr/bin/perl', '-e', 'defined(fork()) ? exit(1) : exit(0)'], f.policy); assert.equal(fork.exitCode, 0);
      const memory = await sandboxSpawn(['/usr/bin/perl', '-e', '$x = "x" x (512*1024*1024); sleep 10'], { ...f.policy, limits: { ...f.policy.limits, memoryBytes: 64*1024*1024, timeoutMs: 5000 } });
      assert.notEqual(memory.exitCode, 0); assert.equal(memory.timedOut, false);
    }
    const bounded = await sandboxSpawn(['/usr/bin/yes'], f.policy); assert.ok(bounded.stdoutTruncated); assert.ok(Buffer.byteLength(bounded.stdout) <= 512); assert.ok(bounded.timedOut || bounded.signal);
    const ac = new AbortController(); setTimeout(() => ac.abort(), 100);
    const cancelled = await sandboxSpawn(['/bin/sleep', '10'], f.policy, { signal: ac.signal }); assert.equal(cancelled.aborted, true);
    const egress = await sandboxSpawn(['/bin/echo', 'ok'], { ...f.policy, network: 'egress' }); assert.equal(egress.sandbox.network, 'none'); assert.equal(egress.sandbox.warnings.length, 1);
  } finally { await f.close(); }
});
