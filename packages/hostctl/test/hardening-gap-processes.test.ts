// Gap-fix tests for hostctl process sessions: a descendant that keeps stdout open, wrapper commands, rm flags and PATH.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostctl, type Hostctl, type Options, type RunContext } from '../src/index.ts';
import { configure } from '../src/config.ts';
import { files } from '../src/files.ts';
import { processes } from '../src/processes.ts';

const posix = process.platform !== 'win32';
const root0 = await realpath(tmpdir());
const ctx: RunContext = { agentId: 'fixture-agent', principal: 'fixture-owner', sessionId: 's1', signal: new AbortController().signal };
let root: string, home: string; const hosts: Hostctl[] = [];
beforeEach(async () => { root = await realpath(await mkdtemp(join(root0, 'hc-gap-root-'))); home = await realpath(await mkdtemp(join(root0, 'hc-gap-home-'))); });
afterEach(async () => { vi.useRealTimers(); for (const h of hosts.splice(0)) await h.close(); for (const d of [root, home]) await rm(d, { recursive: true, force: true }); });
const make = (o: Partial<Options> = {}): Hostctl => { const h = createHostctl({ home, baseEnv: {}, roots: [{ id: 'fixture', path: root }], audit: () => {}, ...o }); hosts.push(h); return h; };
const call = (h: Hostctl, name: string, args: object = {}) => h.invoke(`hostctl.${name}`, args, ctx) as Promise<{ ok: boolean; value?: any; error?: { code: string; hint: string } }>;
const node = (script: string) => ({ program: process.execPath, args: ['-e', script] });

const sleepers = 'setInterval(() => {}, 1000)';
/** The leader starts a grandchild in its own session that inherits stdout: only the grandchild keeps the pipe open. */
const daemon = (leaderStays: boolean) => `const { spawn } = require("child_process"); const g = spawn(process.execPath, ["-e", ${JSON.stringify(sleepers)}], { detached: true, stdio: ["ignore", "inherit", "inherit"] }); g.unref(); console.log("grandchild " + g.pid);${leaderStays ? ` ${sleepers}` : ''}`;
const pidOf = (output: string) => Number(/grandchild (\d+)/.exec(output)![1]);
const reap = (pid: number) => { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } };

describe('a descendant that keeps stdout open does not keep the job running', () => {
  it.skipIf(!posix)('the time limit marks the job finished and returns TIMEOUT, although a detached grandchild holds the pipe', async () => {
    const h = make({ config: { exec: { timeoutMs: 3000 } } }); let pid = 0;
    try {
      const started = Date.now();
      const r = await call(h, 'proc.exec', { ...node(daemon(true)), cwd: root });
      expect(r.ok).toBe(false); expect(r.error!.code).toBe('TIMEOUT'); expect(Date.now() - started).toBeLessThan(8000);
      const job = (await call(h, 'proc.list')).value.processes[0]; pid = pidOf(job.output);
      expect(job.running).toBe(false); expect(job.timedOut).toBe(true);
    } finally { reap(pid); }
  }, 30_000);

  it.skipIf(!posix)('the leader exiting on its own marks the job finished with its exit code, although a detached grandchild holds the pipe', async () => {
    const h = make({ config: { exec: { timeoutMs: 20000 } } }); let pid = 0;
    try {
      const started = Date.now();
      const r = await call(h, 'proc.exec', { ...node(daemon(false)), cwd: root });
      expect(r.ok, JSON.stringify(r)).toBe(true); expect(Date.now() - started).toBeLessThan(8000);
      pid = pidOf(r.value.output); expect(r.value.running).toBe(false); expect(r.value.exitCode).toBe(0); expect(r.value.timedOut).toBe(false);
    } finally { reap(pid); }
  }, 30_000);

  it.skipIf(!posix)('finished jobs do not count against the limit of 32 running processes', async () => {
    const h = make({ config: { exec: { timeoutMs: 20000 } } }); const pids: number[] = [];
    try {
      for (let i = 0; i < 34; i++) { const r = await call(h, 'proc.exec', { ...node(daemon(false)), cwd: root }); expect(r.ok, `${i}: ${JSON.stringify(r)}`).toBe(true); pids.push(pidOf(r.value.output)); }
    } finally { pids.forEach(reap); }
  }, 120_000);

  it('a leader that has exited but whose pipes never close is finished after a short drain, with the output it wrote', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as any; child.pid = 4242; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = vi.fn(() => true);
    const stop = vi.fn(async () => {});
    const canon = files([{ id: 'fixture', path: root }], [], configure(), async () => {}, home, {}).canon;
    const run = processes(configure(), canon, { spawn: (() => child) as never, killTree: stop as never, baseEnv: {} });
    const started = await run.run('start', { program: 'fixture', cwd: root }, ctx) as any;
    child.stdout.write('hello'); await vi.advanceTimersByTimeAsync(0);
    child.emit('exit', 0, null);
    expect((await run.run('read_output', { id: started.id }, ctx) as any).running).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await run.run('read_output', { id: started.id }, ctx)).toMatchObject({ running: false, exitCode: 0, output: 'hello' });
    expect(child.stdout.destroyed && child.stderr.destroyed && child.stdin.destroyed).toBe(true);
    if (posix) expect(stop).toHaveBeenCalledWith(child);
  });
});

describe('wrapper commands do not hide shells or recursive removal of the root', () => {
  const spawned = () => vi.fn(() => { const child = new EventEmitter() as any; child.pid = 4242; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.stdin.on('finish', () => child.emit('close', 0)); child.kill = vi.fn(() => { child.emit('close', null, 'SIGKILL'); return true; }); return child; });
  const harness = (shellAllowed = false) => { const spawn = spawned(); return { spawn, h: make({ spawn: spawn as never, killTree: (async (c: any) => { c.kill(); }) as never, config: { shell: { allowed: shellAllowed, default: 'bash' } } }) }; };
  const refused: [string, string[]][] = [
    ['env', ['bash', '-c', 'id']], ['/usr/bin/env', ['FOO=1', 'sh', '-c', 'id']], ['env', ['-i', 'FOO=1', 'zsh']], ['env', ['-u', 'FOO', 'bash']], ['env', ['-S', 'bash -c id']], ['env', ['--', 'bash']],
    ['xargs', ['bash', '-c', 'id']], ['xargs', ['-n', '1', '-I', '{}', 'sh', '-c', '{}']], ['timeout', ['5', 'bash']], ['timeout', ['-s', 'KILL', '-k', '2', '5', 'sh']], ['timeout', ['--foreground', '5', 'dash']],
    ['nice', ['bash']], ['nice', ['-n', '10', 'sh']], ['nice', ['-10', 'bash']], ['nohup', ['bash']], ['nohup', ['pwsh', '-Command', 'x']], ['busybox', ['sh', '-c', 'id']], ['busybox', ['ash']],
    ['env', ['nice', 'timeout', '5', 'xargs', 'env', 'bash']], ['stdbuf', ['-oL', 'bash']], ['setsid', ['bash']], ['command', ['bash']], ['ionice', ['-c', '3', 'bash']], ['chroot', ['/', 'bash']], ['taskset', ['-c', '0', 'bash']],
    ['env', ['ksh']], ['env', ['wsl.exe', 'ls']], ['env', ['CMD.EXE', '/c', 'dir']],
    // recursive removal of the root behind a wrapper, with flags split in any way
    ['env', ['rm', '-rf', '/']], ['env', ['rm', '-r', '-f', '/']], ['env', ['rm', '-fr', '/']], ['env', ['rm', '-f', '-r', '/']], ['xargs', ['rm', '-r', '-f', '/']], ['timeout', ['5', 'rm', '-rf', '/']],
    ['nice', ['-n', '5', 'rm', '-r', '/']], ['nohup', ['rm', '--recursive', '--force', '/']], ['busybox', ['rm', '-r', '-f', '/']], ['env', ['rm', '--recur', '/']], ['env', ['rm', '-R', '/', '--no-preserve-root']],
    ['rm', ['-r', '-f', '/']], ['rm', ['-f', '-R', '/']], ['rm', ['-r', '-v', '-f', '/']], ['rm', ['-r', '/*']], ['rm', ['-rf', '//']], ['rm', ['-rf', '/.']], ['rm', ['-rf', '/..']], ['rm', ['-r', '-f', '--', '/']],
    ['rm', ['-rf', '/home/../..']], ['rm', ['-r', '-f', 'C:\\']], ['rm.exe', ['-r', '-f', 'C:/']], ['/bin/rm', ['-r', '-f', '/']], ['env', ['/bin/rm', '-r', '-f', '/']],
  ];
  it.each(refused)('refuses %s %j without spawning', async (program, args) => {
    const { spawn, h } = harness(); const r = await call(h, 'proc.exec', { program, args, cwd: root });
    expect(r.ok, JSON.stringify(r)).toBe(false); expect(r.error!.code).toBe('DENIED'); expect(spawn).not.toHaveBeenCalled();
  });

  const allowed: [string, string[]][] = [
    ['env', ['FOO=1', 'node', '--version']], ['env', ['-i', 'node', '--version']], ['env', ['-u', 'FOO', 'node', '-e', '1']], ['env', []], ['timeout', ['5', 'node', '--version']], ['timeout', ['-s', 'KILL', '5', 'node', '-v']],
    ['nice', ['-n', '10', 'node', '--version']], ['nohup', ['node', '--version']], ['xargs', ['-n', '1', 'echo']], ['xargs', ['echo', 'bashful']], ['busybox', ['ls', '-l']],
    ['rm', ['-rf', 'build']], ['rm', ['-r', '-f', './build']], ['rm', ['-f', '/tmp/x']], ['rm', ['/']], ['rm', ['-r', '-f', '/home/user/project']], ['rm', ['-rf', '--', '-weird']],
    ['env', ['rm', '-r', '-f', 'build']], ['timeout', ['5', 'rm', '-rf', 'out']], ['echo', ['rm', '-r', '-f', '/x']], ['node', ['-e', '1', '--', 'rm', '-r', '-f', '/']],
  ];
  it.each(allowed)('still runs %s %j', async (program, args) => {
    const { spawn, h } = harness(); const r = await call(h, 'proc.start', { program, args, cwd: root });
    expect(r.ok, JSON.stringify(r)).toBe(true); expect(spawn).toHaveBeenCalledTimes(1); expect((spawn.mock.calls[0] as unknown as [string])[0]).toBe(program);
  });

  it('refuses a split-flag recursive removal of the root through proc.shell as well, and still runs a bounded removal', async () => {
    const { spawn, h } = harness(true);
    for (const command of ['rm -r -f /', 'echo hi; rm -f -r /', 'true && rm -r -f -- /', 'env rm -r -f /', 'cd /tmp\nrm -r -f /*', '"rm" -r -f "/"', "FOO=1 rm -r -f '/'", 'ls | xargs rm -r -f /'])
      expect((await call(h, 'proc.shell', { command, cwd: root })).error?.code, command).toBe('DENIED');
    expect(spawn).not.toHaveBeenCalled();
    for (const command of ['rm -r -f build', 'echo "rm -r -f /x"', 'ls -r /', 'rm -f /tmp/x && ls -r /']) { expect((await call(h, 'proc.shell', { command, cwd: root })).ok, command).toBe(true); }
  });
});

describe('the caller cannot choose where programs are looked up', () => {
  const spawned = () => vi.fn(() => { const child = new EventEmitter() as any; child.pid = 4242; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = vi.fn(() => true); return child; });
  it.each(['PATH', 'Path', 'PATHEXT', 'pathext'])('refuses %s in the request env even when the operator allowlists it', async key => {
    const spawn = spawned(); const h = make({ spawn: spawn as never, killTree: (async () => {}) as never, baseEnv: { PATH: '/harness/bin', PATHEXT: '.EXE', Path: 'x', pathext: 'y' }, config: { env: { allow: ['PATH', 'Path', 'PATHEXT', 'pathext', 'LANG'] } } });
    const r = await call(h, 'proc.start', { program: 'git', cwd: root, env: { [key]: root } });
    expect(r.ok).toBe(false); expect(r.error!.code).toBe('DENIED'); expect(spawn).not.toHaveBeenCalled();
  });
  it('keeps the harness PATH from the operator allowlist and other request variables working', async () => {
    const spawn = spawned(); const h = make({ spawn: spawn as never, killTree: (async () => {}) as never, baseEnv: { PATH: '/harness/bin', LANG: 'C' }, config: { env: { allow: ['PATH', 'LANG'] } } });
    expect((await call(h, 'proc.start', { program: 'git', cwd: root, env: { LANG: 'de_DE.UTF-8' } })).ok).toBe(true);
    expect((spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env).toEqual({ PATH: '/harness/bin', LANG: 'de_DE.UTF-8' });
  });
});
