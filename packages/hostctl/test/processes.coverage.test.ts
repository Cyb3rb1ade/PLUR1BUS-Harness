import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as realSpawn } from 'node:child_process';
import { processes, killTree, type RunContext } from '../src/processes.ts';
import { files } from '../src/files.ts';
import { configure, type ConfigInput } from '../src/config.ts';
import { HostctlError } from '../src/errors.ts';

let root: string, home: string;
const UUID = /^[a-f0-9-]{36}$/;

/** A fake child process: EventEmitter plus PassThrough stdio. `kill()` closes it synchronously, like a signalled child. */
function fakeChild() {
  const child = new EventEmitter() as any;
  child.pid = 4242; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = vi.fn(() => { child.emit('close', null, 'SIGKILL'); return true; });
  return child;
}
/** A child that closes with code 0 when its stdin is ended, as a program that reads its input and exits would. */
function exitOnStdinEnd() {
  const child = fakeChild();
  child.stdin.on('finish', () => child.emit('close', 0));
  return child;
}
/** Writes to one of a fake child's output streams and resolves after the process layer has consumed the chunk. */
async function emitOn(stream: PassThrough, text: string) {
  const consumed = new Promise<void>(resolve => stream.once('data', () => resolve()));
  stream.write(text);
  await consumed;
}

interface Harness {
  run: ReturnType<typeof processes>;
  spawn: ReturnType<typeof vi.fn>;
  killTree: ReturnType<typeof vi.fn>;
  children: any[];
  spawned: Promise<void>;
}
/** Builds a processes() instance over a real canonical root with an injected spawn and killTree. */
function harness(input: ConfigInput = {}, baseEnv: NodeJS.ProcessEnv = { PATH: '/fixture/bin' }, factory: () => any = fakeChild): Harness {
  const children: any[] = [];
  let announce!: () => void;
  const spawned = new Promise<void>(resolve => { announce = resolve; });
  const spawn = vi.fn((..._args: any[]) => { const child = factory(); children.push(child); announce(); return child; });
  const killTree = vi.fn(async (child: any) => { child.kill(); });
  const canon = files([{ id: 'fixture', path: root }], [], configure(input), async () => {}, home, {}).canon;
  const run = processes(configure(input), canon, { spawn: spawn as never, killTree: killTree as never, baseEnv });
  return { run, spawn, killTree, children, spawned };
}
const ctxOf = (over: Partial<RunContext> = {}): RunContext => ({ agentId: 'agent-fixture', principal: 'owner-fixture', sessionId: 's1', signal: new AbortController().signal, ...over });
/** An owner context without a harness session (exactOptionalPropertyTypes forbids sessionId: undefined). */
const ctxWithoutSession = (): RunContext => ({ agentId: 'agent-fixture', principal: 'owner-fixture', signal: new AbortController().signal });
const codeOf = async (p: Promise<unknown>) => { try { await p; return undefined; } catch (e) { return e instanceof HostctlError ? e.code : (e as Error).name; } };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hostctl-processes-'));
  home = await mkdtemp(join(tmpdir(), 'hostctl-processes-home-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('start, read and stdin', () => {
  it('starts an argv process and reports its opaque owned id and running state', async () => {
    const h = harness();
    const started = await h.run.run('start', { program: 'fixture', args: ['a', 'b'], cwd: root }, ctxOf()) as any;
    expect(started).toMatchObject({ pid: 4242, output: '', truncated: false, timedOut: false, running: true, exitCode: null });
    expect(started.id).toMatch(UUID);
    expect(h.spawn.mock.calls[0]![0]).toBe('fixture');
    expect(h.spawn.mock.calls[0]![1]).toEqual(['a', 'b']);
    expect(h.spawn.mock.calls[0]![2]).toMatchObject({ shell: false, env: { PATH: '/fixture/bin' } });
  });

  it('returns buffered stdout and stderr through read_output', async () => {
    const h = harness();
    const { id } = await h.run.run('start', { program: 'fixture', cwd: root }, ctxOf()) as any;
    await emitOn(h.children[0].stdout, 'out ');
    await emitOn(h.children[0].stderr, 'err');
    const read = await h.run.run('read_output', { id }, ctxOf()) as any;
    expect(read.output).toBe('out err');
  });

  it('caps retained output at output.maxBytes and marks it truncated', async () => {
    const h = harness({ output: { maxBytes: 32 } });
    const { id } = await h.run.run('start', { program: 'fixture', cwd: root }, ctxOf()) as any;
    await emitOn(h.children[0].stdout, 'a'.repeat(32));
    expect(await h.run.run('read_output', { id }, ctxOf())).toMatchObject({ truncated: false, output: 'a'.repeat(32) });
    await emitOn(h.children[0].stdout, 'b');
    const capped = await h.run.run('read_output', { id }, ctxOf()) as any;
    expect(capped.truncated).toBe(true);
    expect(capped.output.endsWith('\n[OUTPUT TRUNCATED]')).toBe(true);
  });

  it('writes Unicode stdin, reports bytes written and closes stdin on eof', async () => {
    const h = harness();
    const { id } = await h.run.run('start', { program: 'fixture', cwd: root }, ctxOf()) as any;
    let received = ''; const finished = new Promise<void>(resolve => h.children[0].stdin.once('finish', resolve));
    h.children[0].stdin.on('data', (b: Buffer) => { received += b.toString('utf8'); });
    expect(await h.run.run('write_stdin', { id, text: 'héllo 🙂', eof: true }, ctxOf())).toEqual({ written: Buffer.byteLength('héllo 🙂') });
    await finished;
    expect(received).toBe('héllo 🙂');
  });

  it('refuses stdin larger than output.maxBytes by bytes, not characters', async () => {
    const h = harness({ output: { maxBytes: 32 } });
    const { id } = await h.run.run('start', { program: 'fixture', cwd: root }, ctxOf()) as any;
    expect(await codeOf(h.run.run('write_stdin', { id, text: 'é'.repeat(17) }, ctxOf()))).toBe('TOO_LARGE');
    expect(await codeOf(h.run.run('write_stdin', { id, text: 'x'.repeat(33) }, ctxOf()))).toBe('TOO_LARGE');
  });

  it('rejects stdin text that is missing, contains NUL or is not well-formed', async () => {
    const h = harness();
    const { id } = await h.run.run('start', { program: 'fixture', cwd: root }, ctxOf()) as any;
    expect(await codeOf(h.run.run('write_stdin', { id }, ctxOf()))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(h.run.run('write_stdin', { id, text: 'a\0b' }, ctxOf()))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(h.run.run('write_stdin', { id, text: '\uD800' }, ctxOf()))).toBe('INVALID_ARGUMENT');
  });

  it('records exit code and stops accepting stdin once the process has closed', async () => {
    const h = harness();
    const { id } = await h.run.run('start', { program: 'fixture', cwd: root }, ctxOf()) as any;
    h.children[0].emit('close', 3);
    expect(await h.run.run('read_output', { id }, ctxOf())).toMatchObject({ running: false, exitCode: 3 });
    expect(await codeOf(h.run.run('write_stdin', { id, text: 'late' }, ctxOf()))).toBe('DENIED');
  });

  it('records -1 as the exit code when the process emits an error', async () => {
    const h = harness();
    const { id } = await h.run.run('start', { program: 'fixture', cwd: root }, ctxOf()) as any;
    h.children[0].emit('error', new Error('spawn failed'));
    expect(await h.run.run('read_output', { id }, ctxOf())).toMatchObject({ running: false, exitCode: -1 });
  });
});

describe('exec, timeouts and cancellation', () => {
  it('exec waits for completion, closes stdin and returns the output and exit code', async () => {
    const h = harness({}, { PATH: '/fixture/bin' }, exitOnStdinEnd);
    const pending = h.run.run('exec', { program: 'fixture', cwd: root }, ctxOf());
    await h.spawned;
    await emitOn(h.children[0].stdout, 'done');
    expect(await pending).toMatchObject({ output: 'done', running: false, exitCode: 0 });
  });

  it('exec fails with TIMEOUT when the process outlives timeoutMs', async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.run.run('exec', { program: 'fixture', cwd: root, timeoutMs: 100 }, ctxOf());
    const outcome = codeOf(pending);
    await h.spawned;
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toBe('TIMEOUT');
    expect(h.killTree).toHaveBeenCalledOnce();
  });

  it('start marks a timed-out job and terminates it, without failing the start call', async () => {
    vi.useFakeTimers();
    const h = harness();
    const { id } = await h.run.run('start', { program: 'fixture', cwd: root, timeoutMs: 50 }, ctxOf()) as any;
    await h.spawned;
    await vi.advanceTimersByTimeAsync(50);
    expect(await h.run.run('read_output', { id }, ctxOf())).toMatchObject({ timedOut: true, running: false });
    expect(h.killTree).toHaveBeenCalledOnce();
  });

  it('kill terminates a running job once and reports it as stopped', async () => {
    const h = harness();
    const { id } = await h.run.run('start', { program: 'fixture', cwd: root }, ctxOf()) as any;
    expect(await h.run.run('kill', { id }, ctxOf())).toMatchObject({ running: false });
    expect(h.killTree).toHaveBeenCalledOnce();
    expect(h.killTree.mock.calls[0]![0]).toBe(h.children[0]);
  });

  it('aborting the run signal terminates the job it belongs to', async () => {
    const h = harness();
    const ac = new AbortController();
    const { id } = await h.run.run('start', { program: 'fixture', cwd: root }, ctxOf({ signal: ac.signal })) as any;
    ac.abort();
    expect(h.killTree).toHaveBeenCalledOnce();
    expect(await h.run.run('read_output', { id }, ctxOf())).toMatchObject({ running: false });
  });

  it('refuses to start when the run signal is already aborted', async () => {
    const h = harness();
    const ac = new AbortController(); ac.abort();
    expect(await codeOf(h.run.run('start', { program: 'fixture', cwd: root }, ctxOf({ signal: ac.signal })))).toBe('AbortError');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('rejects an unknown operation for an owned id as INVALID_ARGUMENT', async () => {
    const h = harness();
    const { id } = await h.run.run('start', { program: 'fixture', cwd: root }, ctxOf()) as any;
    expect(await codeOf(h.run.run('bogus', { id }, ctxOf()))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(h.run.run('bogus', { id: '00000000-0000-4000-8000-000000000000' }, ctxOf()))).toBe('DENIED');
  });
});

describe('ownership, listing and session cleanup', () => {
  it('lists and reads only processes owned by the same agent, person and session', async () => {
    const h = harness();
    const { id } = await h.run.run('start', { program: 'fixture', cwd: root }, ctxOf()) as any;
    expect((await h.run.run('list', {}, ctxOf()) as any).processes.map((p: any) => p.id)).toEqual([id]);
    expect((await h.run.run('list', {}, ctxOf({ principal: 'other-person' })) as any).processes).toEqual([]);
    expect((await h.run.run('list', {}, ctxOf({ agentId: 'other-agent' })) as any).processes).toEqual([]);
    expect(await codeOf(h.run.run('read_output', { id }, ctxOf({ principal: 'other-person' })))).toBe('DENIED');
    expect(await codeOf(h.run.run('kill', { id }, ctxOf({ sessionId: 's2' })))).toBe('DENIED');
  });

  it('requires a harness session to start a process', async () => {
    const h = harness();
    expect(await codeOf(h.run.run('start', { program: 'fixture', cwd: root }, ctxWithoutSession()))).toBe('DENIED');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('endSession terminates and forgets only the jobs of that session', async () => {
    const h = harness();
    const first = await h.run.run('start', { program: 'fixture', cwd: root }, ctxOf()) as any;
    const second = await h.run.run('start', { program: 'fixture', cwd: root }, ctxOf({ sessionId: 's2' })) as any;
    await h.run.endSession('s1');
    expect(h.children[0].kill).toHaveBeenCalledOnce();
    expect(h.children[1].kill).not.toHaveBeenCalled();
    expect(await codeOf(h.run.run('read_output', { id: first.id }, ctxOf()))).toBe('DENIED');
    expect(await h.run.run('read_output', { id: second.id }, ctxOf({ sessionId: 's2' }))).toMatchObject({ running: true });
  });

  it('close terminates every running job and forgets all of them', async () => {
    const h = harness();
    const { id } = await h.run.run('start', { program: 'fixture', cwd: root }, ctxOf()) as any;
    await h.run.close();
    expect(h.killTree).toHaveBeenCalledOnce();
    expect(await codeOf(h.run.run('read_output', { id }, ctxOf()))).toBe('DENIED');
  });

  it('refuses a 33rd concurrently running process per pool', async () => {
    const h = harness();
    for (let i = 0; i < 32; i++) await h.run.run('start', { program: 'fixture', cwd: root }, ctxOf());
    expect(h.spawn).toHaveBeenCalledTimes(32);
    expect(await codeOf(h.run.run('start', { program: 'fixture', cwd: root }, ctxOf()))).toBe('TOO_LARGE');
    expect(h.spawn).toHaveBeenCalledTimes(32);
  });
});

describe('argument and program validation', () => {
  it.each([
    ['bash', 'DENIED'], ['/usr/bin/zsh', 'DENIED'], ['sh', 'DENIED'], ['PowerShell.exe', 'DENIED'], ['cmd', 'DENIED'],
  ])('refuses shell interpreter %s on exec and points to proc.shell', async (program, code) => {
    const h = harness();
    expect(await codeOf(h.run.run('start', { program, cwd: root }, ctxOf()))).toBe(code);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('does not treat a name that only starts with a shell name as an interpreter', async () => {
    const h = harness();
    await h.run.run('start', { program: 'bashful', cwd: root }, ctxOf());
    expect(h.spawn.mock.calls[0]![0]).toBe('bashful');
  });

  it.each([
    ['args not an array', { args: 'x' }],
    ['args with a number', { args: ['a', 1] }],
    ['args with NUL', { args: ['a\0b'] }],
    ['program with NUL', { program: 'fix\0ture' }],
    ['env as an array', { env: ['PATH'] }],
    ['env as null', { env: null }],
    ['env value as number', { env: { PATH: 1 } }],
    ['env value with NUL', { env: { PATH: 'a\0b' } }],
    ['timeoutMs zero', { timeoutMs: 0 }],
    ['timeoutMs negative', { timeoutMs: -5 }],
    ['timeoutMs above the configured maximum', { timeoutMs: 30001 }],
    ['timeoutMs fractional', { timeoutMs: 1.5 }],
  ])('rejects %s as INVALID_ARGUMENT', async (_label, extra) => {
    const h = harness({ exec: { timeoutMs: 30000 } });
    expect(await codeOf(h.run.run('start', { program: 'fixture', cwd: root, ...extra }, ctxOf()))).toBe('INVALID_ARGUMENT');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('refuses environment keys that are not allowlisted, blocked by name, or credential-shaped', async () => {
    const h = harness({ env: { allow: ['PATH', 'NODE_OPTIONS', 'API_TOKEN'] } });
    for (const key of ['FOO', 'NODE_OPTIONS', 'API_TOKEN']) {
      expect(await codeOf(h.run.run('start', { program: 'fixture', cwd: root, env: { [key]: 'x' } }, ctxOf()))).toBe('DENIED');
    }
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('copies only allowlisted, present, non-blocked base variables into the child', async () => {
    const h = harness({ env: { allow: ['PATH', 'LANG', 'API_TOKEN', 'NODE_OPTIONS', 'MISSING'] } },
      { PATH: '/fixture/bin', LANG: 'C', API_TOKEN: 'never', NODE_OPTIONS: '--never', UNLISTED: 'no' });
    await h.run.run('start', { program: 'fixture', cwd: root, env: { LANG: 'de_DE.UTF-8' } }, ctxOf());
    expect(h.spawn.mock.calls[0]![2].env).toEqual({ PATH: '/fixture/bin', LANG: 'de_DE.UTF-8' });
  });

  it('accepts a program whose name merely contains a denied word and benign command lines', async () => {
    const h = harness();
    for (const program of ['clang-format', 'formatter', 'node', 'diskpart-ish']) {
      await h.run.run('start', { program, args: ['--version'], cwd: root }, ctxOf());
    }
    expect(h.spawn).toHaveBeenCalledTimes(4);
  });
});

describe('dangerous commands and deny patterns', () => {
  const dangerous: [string, string[]][] = [
    ['sudo', ['ls']], ['doas', []], ['pkexec', ['true']], ['runas', ['/user:x', 'cmd']],
    ['format', ['C:']], ['format.com', ['C:']], ['diskpart', []], ['mkfs.ext4', ['/dev/sda']],
    ['reg', ['delete', 'HKCU\\Software\\x']], ['reg.exe', ['load', 'x']],
    ['echo', ['HKEY_LOCAL_MACHINE']], ['echo', ['\\\\.\\C:']],
    ['rm', ['-rf', '/']], ['rm', ['--recursive', '/']], ['rm', ['-r', 'C:\\']], ['rm.exe', ['-Rf', '/']],
  ];
  it.each(dangerous)('refuses %s %j without spawning', async (program, args) => {
    const h = harness();
    expect(await codeOf(h.run.run('start', { program, args, cwd: root }, ctxOf()))).toBe('DENIED');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('applies denyPatterns case-insensitively to the whole command line', async () => {
    const h = harness({ denyPatterns: ['curl evil'] });
    expect(await codeOf(h.run.run('start', { program: 'CURL', args: ['EVIL.example'], cwd: root }, ctxOf()))).toBe('DENIED');
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

describe('shell execution', () => {
  it('refuses proc.shell while shell.allowed is false', async () => {
    const h = harness();
    expect(await codeOf(h.run.run('shell', { command: 'echo hi', cwd: root }, ctxOf()))).toBe('DENIED');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('runs the configured bash command as -c with shell disabled in spawn options', async () => {
    const h = harness({ shell: { allowed: true, default: 'bash' } }, undefined, exitOnStdinEnd);
    expect(await h.run.run('shell', { command: 'echo "héllo"', cwd: root }, ctxOf())).toMatchObject({ running: false, exitCode: 0 });
    expect(h.spawn.mock.calls[0]!.slice(0, 2)).toEqual(['bash', ['-c', 'echo "héllo"']]);
    expect(h.spawn.mock.calls[0]![2]).toMatchObject({ shell: false });
  });

  it('passes -NoProfile -NonInteractive -Command to pwsh', async () => {
    const h = harness({ shell: { allowed: true, default: 'pwsh' } }, undefined, exitOnStdinEnd);
    await h.run.run('shell', { command: 'Get-Date', cwd: root }, ctxOf());
    expect(h.spawn.mock.calls[0]!.slice(0, 2)).toEqual(['pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Date']]);
  });

  it('still applies the dangerous-command gate to proc.shell', async () => {
    const h = harness({ shell: { allowed: true, default: 'bash' } });
    expect(await codeOf(h.run.run('shell', { command: 'sudo reboot', cwd: root }, ctxOf()))).toBe('DENIED');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('rejects a shell command that is missing or contains NUL', async () => {
    const h = harness({ shell: { allowed: true, default: 'bash' } });
    expect(await codeOf(h.run.run('shell', { cwd: root }, ctxOf()))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(h.run.run('shell', { command: 'a\0b', cwd: root }, ctxOf()))).toBe('INVALID_ARGUMENT');
  });
});

describe('killTree', () => {
  it('returns without signalling when the child has no pid', async () => {
    await expect(killTree({ pid: undefined } as any)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('terminates a real detached child group with SIGKILL and tolerates an already-exited group', async () => {
    const child = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', shell: false });
    const signalled = new Promise<NodeJS.Signals | null>(resolve => child.once('close', (_code, sig) => resolve(sig)));
    await killTree(child);
    expect(await signalled).toBe('SIGKILL');
    await expect(killTree(child)).resolves.toBeUndefined();
  });
});
