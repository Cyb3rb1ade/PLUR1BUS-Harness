import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createHostctl, type Hostctl, type RunContext } from '../src/index.ts';

let root: string, outside: string, host: Hostctl;
const ctx: RunContext = { agentId: 'fixture-agent', principal: 'fixture-owner', sessionId: 's1', signal: new AbortController().signal };
const audit: unknown[] = [];
const call = (name: string, args: object = {}, context = ctx) => host.invoke(`hostctl.${name}`, args, context);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hostctl-')); outside = await mkdtemp(join(tmpdir(), 'outside-'));
  audit.length = 0;
  host = createHostctl({ home: join(root, 'fixture-home'), baseEnv: {}, roots: [{ id: 'fixture', path: root }], audit: e => { audit.push(e); }, trash: async path => { await mkdir(join(root, '.fake-trash'), { recursive: true }); await import('node:fs/promises').then(fs => fs.rename(path, join(root, '.fake-trash', 'trashed'))); } });
});
afterEach(async () => { await host.close(); vi.useRealTimers(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });

describe('files and roots', () => {
  it('rejects traversal, credential deny paths, UNC and symlink escapes', async () => {
    await writeFile(join(outside, 'secret'), 'private');
    await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await call('fs.read', { path: join(root, 'link/secret') })).toMatchObject({ ok: false, error: { code: 'OUTSIDE_ROOT' } });
    expect(await call('fs.read', { path: '../outside/secret' })).toMatchObject({ ok: false });
    expect(await call('fs.read', { path: '\\\\server\\share\\secret' })).toMatchObject({ ok: false });
    await writeFile(join(root, '.env'), 'private');
    expect(await call('fs.read', { path: '.env' })).toMatchObject({ ok: false, error: { code: 'DENIED' } });
  });
  it('writes atomically, appends, edits exactly once and preserves original on abort', async () => {
    expect(await call('fs.write', { path: 'a', content: 'hello' })).toMatchObject({ ok: true });
    await call('fs.append', { path: 'a', content: ' world' });
    await call('fs.edit', { path: 'a', oldText: 'world', newText: 'person' });
    expect(await readFile(join(root, 'a'), 'utf8')).toBe('hello person');
    const ac = new AbortController(); ac.abort();
    expect(await call('fs.write', { path: 'a', content: 'lost' }, { ...ctx, signal: ac.signal })).toMatchObject({ ok: false });
    expect(await readFile(join(root, 'a'), 'utf8')).toBe('hello person');
    await writeFile(join(root, 'a'), 'twice twice');
    expect(await call('fs.edit', { path: 'a', oldText: 'twice', newText: 'x' })).toMatchObject({ ok: false, error: { code: 'NOT_UNIQUE' } });
    expect((await readdir(root)).some(n => n.includes('.tmp'))).toBe(false);
  });
  it('bounds and detects binary reads, supports offsets and recursive bounded search', async () => {
    await writeFile(join(root, 'bin'), Buffer.from([0, 1, 2]));
    expect(await call('fs.read', { path: 'bin' })).toMatchObject({ ok: false, error: { code: 'BINARY' } });
    await writeFile(join(root, 'large'), Buffer.alloc(65537, 65));
    expect(await call('fs.read', { path: 'large' })).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
    expect(await call('fs.read', { path: 'large', offset: 1, length: 3 })).toMatchObject({ ok: true, value: { content: 'AAA' } });
    await mkdir(join(root, 'dir')); await writeFile(join(root, 'dir/notes.txt'), 'needle');
    expect(await call('fs.search', { path: '.', query: 'needle', mode: 'content' })).toMatchObject({ ok: true, value: { matches: [{ path: 'dir/notes.txt' }] } });
    expect(await call('fs.list', { path: '.', depth: 0, limit: 1 })).toMatchObject({ ok: true, value: { truncated: true } });
  });
  it('copies, moves, stats and sends files to a Trash backend', async () => {
    await call('fs.mkdir', { path: 'dir' }); await call('fs.write', { path: 'dir/a', content: 'data' });
    await call('fs.copy', { path: 'dir/a', destination: 'dir/b' }); await call('fs.move', { path: 'dir/b', destination: 'dir/c' });
    expect(await call('fs.stat', { path: 'dir/c' })).toMatchObject({ ok: true, value: { size: 4 } });
    expect(await call('fs.trash', { path: 'dir/c' })).toMatchObject({ ok: true });
    expect(await readFile(join(root, '.fake-trash/trashed'), 'utf8')).toBe('data');
  });
  it.skipIf(process.platform !== 'win32')('rejects Windows junction escape and reserved names', async () => {
    await symlink(outside, join(root, 'junction'), 'junction');
    expect(await call('fs.list', { path: 'junction' })).toMatchObject({ ok: false });
    for (const path of ['NUL', 'con.txt', 'a:stream', 'name.']) expect(await call('fs.write', { path, content: 'x' })).toMatchObject({ ok: false });
  });
});

it('audit is an allowlist of metadata, never file contents or environment values', async () => {
  await call('fs.write', { path: 'a', content: 'private payload 123' }); await call('fs.read', { path: 'a' });
  expect(audit.length).toBeGreaterThanOrEqual(4);
  expect(JSON.stringify(audit)).not.toContain('private payload');
  expect(JSON.stringify(audit)).toContain('hostctl.fs.write');
});
it('disabled configuration and unavailable audit fail closed', async () => {
  await host.close(); host = createHostctl({ home: join(root, 'fixture-home'), baseEnv: {}, roots: [{ id: 'fixture', path: root }], config: { enabled: false }, audit: () => {} });
  expect(await call('sys.info')).toMatchObject({ ok: false, error: { code: 'DENIED' } });
  await host.close(); host = createHostctl({ home: join(root, 'fixture-home'), baseEnv: {}, roots: [{ id: 'fixture', path: root }], audit: () => { throw Error('unavailable'); } });
  expect(await call('fs.write', { path: 'a', content: 'x' })).toMatchObject({ ok: false, error: { code: 'DENIED' } });
  expect(await readdir(root)).toEqual([]);
});

function fakeChild() {
  const child = new EventEmitter() as any;
  child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = vi.fn(() => { child.emit('close', null, 'SIGKILL'); return true; });
  return child;
}
it('process timeout, truncation, env allowlist and session ownership use fake timers', async () => {
  vi.useFakeTimers(); const child = fakeChild(), spawn = vi.fn((..._args: any[]) => child);
  await host.close(); host = createHostctl({ home: join(root, 'fixture-home'), roots: [{ id: 'fixture', path: root }], audit: () => {}, spawn, killTree: async c => { c.kill(); }, config: { exec: { timeoutMs: 100 }, output: { maxBytes: 32 }, env: { allow: ['PATH'] } }, baseEnv: { PATH: '/fixture/bin', API_TOKEN: 'never' } });
  const result = await call('proc.start', { program: 'fixture', args: [], cwd: root });
  expect(result.ok).toBe(true); if (!result.ok) return;
  const id = (result.value as any).id;
  expect(spawn.mock.calls[0]![2]).toMatchObject({ shell: false, env: { PATH: '/fixture/bin' } });
  child.stdout.write('a'.repeat(200));
  expect(await call('proc.read_output', { id })).toMatchObject({ ok: true, value: { truncated: true } });
  expect(await call('proc.read_output', { id }, { ...ctx, sessionId: 'foreign' })).toMatchObject({ ok: false, error: { code: 'DENIED' } });
  await vi.advanceTimersByTimeAsync(100);
  expect(await call('proc.read_output', { id })).toMatchObject({ ok: true, value: { timedOut: true } });
  expect(child.kill).toHaveBeenCalled();
  expect(await call('proc.start', { program: 'fixture', cwd: root, env: { API_TOKEN: 'never' } })).toMatchObject({ ok: false, error: { code: 'DENIED' } });
});
it('denies dangerous commands, disabled shell and foreign process kill', async () => {
  expect(await call('proc.exec', { program: 'rm', args: ['-rf', '/'], cwd: root })).toMatchObject({ ok: false, error: { code: 'DENIED' } });
  expect(await call('proc.shell', { command: 'echo hello', cwd: root })).toMatchObject({ ok: false, error: { code: 'DENIED' } });
  expect(await call('proc.kill', { id: 'not-owned' })).toMatchObject({ ok: false, error: { code: 'DENIED' } });
});
it('owned process sessions support stdin, exit and cleanup without affecting another session', async () => {
  const children: any[] = [];
  const spawn = vi.fn((..._args: any[]) => { const child = fakeChild(); children.push(child); return child; });
  await host.close(); host = createHostctl({ home: join(root, 'fixture-home'), baseEnv: {}, roots: [{ id: 'r', path: root }], audit: () => {}, spawn, killTree: async c => { c.kill(); } });
  const first = await call('proc.start', { program: 'fixture', cwd: root }); const second = await call('proc.start', { program: 'fixture', cwd: root }, { ...ctx, sessionId: 's2' });
  expect(first.ok && second.ok).toBe(true); if (!first.ok || !second.ok) return;
  const id = (first.value as any).id; let input = ''; children[0].stdin.on('data', (b: Buffer) => { input += b.toString(); });
  expect(await call('proc.write_stdin', { id, text: 'fixture input', eof: true })).toMatchObject({ ok: true }); expect(input).toBe('fixture input');
  await host.endSession('s1'); expect(children[0].kill).toHaveBeenCalledOnce(); expect(children[1].kill).not.toHaveBeenCalled();
  expect(await call('proc.read_output', { id })).toMatchObject({ ok: false, error: { code: 'DENIED' } });
  children[1].emit('close', 0); expect(await call('proc.list', {}, { ...ctx, sessionId: 's2' })).toMatchObject({ ok: true, value: { processes: [{ running: false, exitCode: 0 }] } });
  await host.close(); expect(await call('sys.info')).toMatchObject({ ok: false, error: { code: 'DENIED' } });
});
it('refuses the configured root itself as a Trash or move source', async () => {
  expect(await call('fs.trash', { path: root })).toMatchObject({ ok: false, error: { code: 'DENIED' } });
  expect(await call('fs.move', { path: root, destination: 'elsewhere' })).toMatchObject({ ok: false, error: { code: 'DENIED' } });
});
it('cancellation after staging leaves the original intact and removes temporary files', async () => {
  await writeFile(join(root, 'original'), 'keep me'); const ac = new AbortController();
  await host.close(); host = createHostctl({ home: join(root, 'fixture-home'), baseEnv: {}, roots: [{ id: 'r', path: root }], audit: () => {}, afterStage: async () => { ac.abort(); } });
  expect(await call('fs.write', { path: 'original', content: 'do not publish' }, { ...ctx, signal: ac.signal })).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
  expect(await readFile(join(root, 'original'), 'utf8')).toBe('keep me'); expect(await readdir(root)).toEqual(['original']);
});
it('audit redacts secret-shaped path segments', async () => {
  const token = 'ghp_' + 'a'.repeat(40); await call('fs.write', { path: `fixture-${token}`, content: 'not logged' });
  expect(JSON.stringify(audit)).not.toContain(token);
});
it('denies environment credential variants and symbolic aliases to them', async () => {
  await writeFile(join(root, '.env.production'), 'synthetic credential');
  if (process.platform !== 'win32') await symlink(join(root, '.env.production'), join(root, 'alias'));
  expect(await call('fs.read', { path: '.env.production' })).toMatchObject({ ok: false, error: { code: 'DENIED' } });
  if (process.platform !== 'win32') expect(await call('fs.read', { path: 'alias' })).toMatchObject({ ok: false, error: { code: 'DENIED' } });
});
it('exec runs a real local argv child with filtered environment and captures exit/output', async () => {
  expect(await call('proc.exec', { program: process.execPath, args: ['-e', 'process.stdout.write("fixture:" + (process.env.HOSTCTL_SECRET_TOKEN || "absent")); process.exitCode = 7'], cwd: root })).toMatchObject({ ok: true, value: { output: 'fixture:absent', exitCode: 7, running: false } });
});
