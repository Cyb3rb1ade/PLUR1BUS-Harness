import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHostctl, SPECS, type Audit, type Hostctl, type RunContext } from '../src/index.ts';
import * as native from '../src/native.ts';
import { HostctlError } from '../src/errors.ts';

// The OS opener must never run from a test: `open` would launch a browser or a document viewer.
vi.mock('../src/native.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../src/native.ts')>();
  return { ...real, open: vi.fn(async () => {}) };
});
// Native desktop tools (clipboard, notifications) are replaced by fakes registered per test.
const fakeTools = vi.hoisted(() => ({} as Record<string, unknown>));
vi.mock('../../core/src/host-tools/index.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../../core/src/host-tools/index.ts')>();
  return { ...real, getHostTool: (name: string) => fakeTools[name] };
});

let root: string, outside: string, home: string;
let host: Hostctl;
let audit: Audit[];
const ctx: RunContext = { agentId: 'agent-fixture', principal: 'owner-fixture', sessionId: 's1', signal: new AbortController().signal };
const call = (name: string, args: unknown = {}, context: RunContext = ctx) => host.invoke(`hostctl.${name}`, args, context);
const codeOf = (result: { ok: boolean; error?: { code: string } }) => (result.ok ? 'OK' : result.error!.code);

/** A fake child process with PassThrough stdio; `kill()` closes it synchronously. */
function fakeChild() {
  const child = new EventEmitter() as any;
  child.pid = 4242; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = vi.fn(() => { child.emit('close', null, 'SIGKILL'); return true; });
  return child;
}

function build(extra: Partial<Parameters<typeof createHostctl>[0]> = {}) {
  return createHostctl({
    home, baseEnv: {}, roots: [{ id: 'fixture', path: root }], audit: e => { audit.push(e); }, ...extra,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hostctl-index-'));
  outside = await mkdtemp(join(tmpdir(), 'hostctl-index-outside-'));
  home = await mkdtemp(join(tmpdir(), 'hostctl-index-home-'));
  audit = [];
  host = build();
  for (const key of Object.keys(fakeTools)) delete fakeTools[key];
  vi.mocked(native.open).mockClear();
  vi.mocked(native.open).mockImplementation(async () => {});
});
afterEach(async () => {
  await host.close();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('argument handling and dispatch', () => {
  it('accepts names with or without the hostctl prefix', async () => {
    await writeFile(join(root, 'a.txt'), 'abc');
    expect(await host.invoke('fs.stat', { path: 'a.txt' }, ctx)).toMatchObject({ ok: true, value: { size: 3 } });
    expect(await host.invoke('hostctl.fs.stat', { path: 'a.txt' }, ctx)).toMatchObject({ ok: true });
  });

  it('rejects an unregistered operation and audits it with its code', async () => {
    expect(await call('nope.tool')).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', hint: 'Choose a registered hostctl tool.' } });
    expect(audit.map(e => [e.phase, e.code])).toEqual([['begin', 'START'], ['end', 'INVALID_ARGUMENT']]);
  });

  it.each([
    ['null', null],
    ['array', ['path']],
    ['string', 'path'],
    ['number', 7],
  ])('treats %s arguments as an empty object', async (_label, raw) => {
    expect(await call('sys.info', raw)).toMatchObject({ ok: true });
    expect(await call('fs.stat', raw)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', hint: 'path is required.' } });
  });

  it('reports the first missing required argument', async () => {
    expect(await call('fs.write', { path: 'x' })).toMatchObject({ ok: false, error: { hint: 'content is required.' } });
    expect(await call('fs.write', {})).toMatchObject({ ok: false, error: { hint: 'path is required.' } });
  });

  it('refuses unknown arguments and does not perform the operation', async () => {
    expect(await call('fs.write', { path: 'sneaky.txt', content: 'x', mode: 'x' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', hint: 'Unknown argument: mode.' } });
    expect(await call('fs.stat', { path: 'sneaky.txt' })).toMatchObject({ ok: false });
  });

  it('returns ABORTED when the run signal is already aborted', async () => {
    const ac = new AbortController(); ac.abort();
    expect(await call('sys.info', {}, { ...ctx, signal: ac.signal })).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
  });

  // UNKLAR: Wenn die Operation erfolgreich war, das End-Audit aber fehlschlägt: soll das Ergebnis trotzdem ok:true sein,
  // oder ist ok:false (IO_ERROR) gewollt, obwohl die Datei bereits geschrieben wurde?
  it.skip('UNKLAR: reports a failing end-audit after a successful write as IO_ERROR', async () => {
    await host.close();
    host = build({ audit: e => { if (e.phase === 'end') throw new Error('audit sink down'); } });
    expect(await call('fs.write', { path: 'audited.txt', content: 'x' })).toMatchObject({ ok: false, error: { code: 'IO_ERROR' } });
  });
});

describe('audit events', () => {
  it('emits begin and end events with agent, principal, session and every path argument', async () => {
    await writeFile(join(root, 'src.txt'), 'x');
    await call('fs.copy', { path: 'src.txt', destination: 'dst.txt' });
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ operation: 'hostctl.fs.copy', phase: 'begin', agentId: 'agent-fixture', principal: 'owner-fixture', sessionId: 's1', code: 'START', paths: ['src.txt', 'dst.txt'] });
    expect(audit[1]).toMatchObject({ phase: 'end', code: 'OK' });
  });

  it('omits sessionId when the context has none', async () => {
    await call('sys.info', {}, { agentId: 'a', principal: 'p', signal: new AbortController().signal });
    expect(audit.every(e => !('sessionId' in e))).toBe(true);
  });

  it('records a process id and pid from the started process, never its output', async () => {
    const child = fakeChild();
    host = build({ spawn: (() => child) as never, killTree: async (c: any) => { c.kill(); } });
    const started = await call('proc.start', { program: 'fixture', cwd: root }) as { ok: true; value: { id: string } };
    expect(started.ok).toBe(true);
    const end = audit.find(e => e.phase === 'end')!;
    expect(end).toMatchObject({ code: 'OK', processId: started.value.id, pid: 4242 });
  });

  it('records the pid argument of proc.kill_foreign at begin when it is a valid foreign pid', async () => {
    host = build({ killForeign: vi.fn() });
    await call('proc.kill_foreign', { pid: 99999 });
    expect(audit[0]).toMatchObject({ phase: 'begin', pid: 99999 });
    expect(audit[0]).not.toHaveProperty('processId');
  });

  it('does not record a pid of 1 or below', async () => {
    host = build({ killForeign: vi.fn() });
    await call('proc.kill_foreign', { pid: 1 });
    expect(audit[0]).not.toHaveProperty('pid');
  });
});

describe('sys.info', () => {
  it('returns OS, CPU, memory, root capacity and network address shapes only', async () => {
    const result = await call('sys.info');
    expect(result).toMatchObject({ ok: true });
    const value = (result as { value: Record<string, any> }).value;
    expect(Object.keys(value).sort()).toEqual(['arch', 'cpu', 'disks', 'memory', 'network', 'os', 'release']);
    expect(value.cpu.count).toBeGreaterThanOrEqual(1);
    expect(value.memory.total).toBeGreaterThan(0);
    expect(value.disks).toEqual([expect.objectContaining({ rootId: 'fixture', total: expect.any(Number), free: expect.any(Number) })]);
    expect(Array.isArray(value.network)).toBe(true);
    for (const iface of value.network) expect(Object.keys(iface).sort()).toEqual(['addresses', 'name']);
  });

  it('marks a root whose path cannot be read as unavailable instead of failing', async () => {
    host = build({ roots: [{ id: 'gone', path: join(root, 'does-not-exist') }] });
    const value = (await call('sys.info') as { value: { disks: unknown[] } }).value;
    expect(value.disks).toEqual([{ rootId: 'gone', unavailable: true }]);
  });
});

describe('app.open', () => {
  it('opens a credential-free HTTP(S) URL in normalized form', async () => {
    expect(await call('app.open', { target: 'HTTPS://Example.invalid/path?q=1' })).toEqual({ ok: true, value: { opened: true } });
    expect(native.open).toHaveBeenCalledWith('https://example.invalid/path?q=1', expect.any(AbortSignal));
  });

  it.each([
    ['username in URL', 'https://user@example.invalid/'],
    ['password in URL', 'https://user:pw@example.invalid/'],
    ['empty username with password', 'https://:pw@example.invalid/'],
  ])('refuses a URL with %s', async (_label, target) => {
    expect(await call('app.open', { target })).toMatchObject({ ok: false, error: { code: 'DENIED', hint: 'Use a URL without credentials.' } });
    expect(native.open).not.toHaveBeenCalled();
  });

  it('opens a root-contained local file by its canonical path', async () => {
    await writeFile(join(root, 'doc résumé 🙂.txt'), 'x');
    expect(await call('app.open', { target: 'doc résumé 🙂.txt' })).toMatchObject({ ok: true });
    expect(native.open).toHaveBeenCalledWith(join(await realpath(root), 'doc résumé 🙂.txt'), expect.any(AbortSignal));
  });

  it('refuses a local file outside the roots, a credential file and a symlink to one', async () => {
    await writeFile(join(outside, 'elsewhere.txt'), 'x');
    await writeFile(join(root, '.env'), 'x');
    expect(await call('app.open', { target: join(outside, 'elsewhere.txt') })).toMatchObject({ ok: false, error: { code: 'OUTSIDE_ROOT' } });
    expect(await call('app.open', { target: '.env' })).toMatchObject({ ok: false, error: { code: 'DENIED' } });
    if (process.platform !== 'win32') {
      await symlink(join(outside, 'elsewhere.txt'), join(root, 'escape.txt'));
      expect(await call('app.open', { target: 'escape.txt' })).toMatchObject({ ok: false });
    }
    expect(native.open).not.toHaveBeenCalled();
  });

  // BUG: app.open übergibt nicht existierende Pfade und Nicht-URL-Strings (javascript:, file:) als Pfad an den OS-Opener – siehe docs/testing/coverage-2026-10-wave2.md#bugs-app-open-nonexistent-target
  it.skip('BUG: refuses a javascript: string without opening anything', async () => {
    expect(await call('app.open', { target: 'javascript:alert(1)' })).toMatchObject({ ok: false });
    expect(native.open).not.toHaveBeenCalled();
  });
  // BUG: app.open übergibt nicht existierende Pfade und Nicht-URL-Strings (javascript:, file:) als Pfad an den OS-Opener – siehe docs/testing/coverage-2026-10-wave2.md#bugs-app-open-nonexistent-target
  it.skip('BUG: refuses a file: URL without opening anything', async () => {
    expect(await call('app.open', { target: 'file:///etc/hosts' })).toMatchObject({ ok: false });
    expect(native.open).not.toHaveBeenCalled();
  });
  // BUG: app.open übergibt nicht existierende Pfade und Nicht-URL-Strings (javascript:, file:) als Pfad an den OS-Opener – siehe docs/testing/coverage-2026-10-wave2.md#bugs-app-open-nonexistent-target
  it.skip('BUG: refuses a missing file in the root without opening anything', async () => {
    expect(await call('app.open', { target: 'missing.txt' })).toMatchObject({ ok: false });
    expect(native.open).not.toHaveBeenCalled();
  });

  it('requires a target argument', async () => {
    expect(await call('app.open', {})).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });

  it('passes a native opener failure through with its code', async () => {
    vi.mocked(native.open).mockRejectedValueOnce(new HostctlError('UNAVAILABLE', 'Install the native desktop helper or use an available desktop session.'));
    expect(await call('app.open', { target: 'https://example.invalid/' })).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    vi.mocked(native.open).mockRejectedValueOnce(new Error('spawn EPERM'));
    expect(await call('app.open', { target: 'https://example.invalid/' })).toMatchObject({ ok: false, error: { code: 'IO_ERROR' } });
  });
});

describe('native tools and the process-kill seam', () => {
  it('reports UNAVAILABLE for a native operation with no registered tool', async () => {
    expect(await call('clipboard.read')).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE', hint: 'Native operation unavailable.' } });
  });

  it('runs a registered native tool with the bounds from configuration and the run signal', async () => {
    const run = vi.fn(async (args: unknown, context: any) => ({ args, timeoutMs: context.timeoutMs, maxOutputBytes: context.maxOutputBytes, signal: context.signal }));
    fakeTools.notify = { run };
    const s = new AbortController().signal;
    const result = await call('notify', { title: 'Fixture', body: 'Body' }, { ...ctx, signal: s }) as { ok: true; value: any };
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ args: { title: 'Fixture', body: 'Body' }, timeoutMs: 30000, maxOutputBytes: 65536 });
    expect(result.value.signal).toBe(s);
  });

  it('uses a supplied host context as the base of the native tool context', async () => {
    const run = vi.fn(async (_args: unknown, context: any) => ({ platform: context.platform }));
    fakeTools.notify = { run };
    await host.close();
    host = build({ host: { platform: 'linux' } as never });
    expect(await call('notify', { title: 'Fixture' })).toEqual({ ok: true, value: { platform: 'linux' } });
  });

  it('passes a native tool error through with its code', async () => {
    fakeTools['clipboard.write'] = { run: async () => { throw new HostctlError('IO_ERROR', 'Native helper failed; check desktop permissions and target support.'); } };
    expect(await call('clipboard.write', { text: 'x' })).toMatchObject({ ok: false, error: { code: 'IO_ERROR' } });
  });

  it('requires the text argument for clipboard.write', async () => {
    expect(await call('clipboard.write', {})).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', hint: 'text is required.' } });
  });

  it.each([
    ['the operating system process 1', 1],
    ['this process itself', process.pid],
    ['zero', 0],
    ['a negative pid', -5],
    ['a fractional pid', 2.5],
    ['a string pid', '5'],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('refuses kill_foreign for %s', async (_label, pid) => {
    const killForeign = vi.fn();
    host = build({ killForeign });
    expect(await call('proc.kill_foreign', { pid })).toMatchObject({ ok: false, error: { code: 'DENIED' } });
    expect(killForeign).not.toHaveBeenCalled();
  });

  it('signals the smallest foreign pid through the injected seam only', async () => {
    const killForeign = vi.fn();
    host = build({ killForeign });
    expect(await call('proc.kill_foreign', { pid: 2 })).toEqual({ ok: true, value: { signalled: true } });
    expect(killForeign).toHaveBeenCalledExactlyOnceWith(2);
  });
});

describe('definitions()', () => {
  it('lists every operation as a first-party tool with a closed input schema', () => {
    const defs = host.definitions();
    expect(defs.map(d => d.name).sort()).toEqual(Object.keys(SPECS).map(op => `hostctl.${op}`).sort());
    for (const def of defs) {
      expect(def.trust).toBe('first-party');
      expect(def.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      for (const key of (def.inputSchema as { required: string[] }).required) expect(Object.keys((def.inputSchema as { properties: object }).properties)).toContain(key);
    }
  });

  it('marks clipboard.write as a local write and clipboard.read as a read of the same capability', () => {
    const byName = new Map(host.definitions().map(d => [d.name, d]));
    expect(byName.get('hostctl.clipboard.write')).toMatchObject({ effect: 'local-write', capability: 'clipboard.read' });
    expect(byName.get('hostctl.clipboard.read')).toMatchObject({ capability: 'clipboard.read' });
  });

  it('derives limits from configuration and caps them at the documented maxima', async () => {
    const byName = (h: Hostctl, name: string) => h.definitions().find(d => d.name === name)!;
    expect(byName(host, 'hostctl.sys.info').limits).toEqual({ timeoutMs: 31000, maxResultBytes: 135168 });
    await host.close();
    host = build({ config: { exec: { timeoutMs: 300000 }, output: { maxBytes: 1048576 } } });
    expect(byName(host, 'hostctl.sys.info').limits).toEqual({ timeoutMs: 300000, maxResultBytes: 1048576 });
  });

  it('exposes no tools when hostctl is disabled', async () => {
    await host.close();
    host = build({ config: { enabled: false } });
    expect(host.definitions()).toEqual([]);
  });

  it('classify reports in-root targets, access mode and refuses outside or credential targets', async () => {
    await writeFile(join(root, 'inside.txt'), 'x');
    const byName = new Map(host.definitions().map(d => [d.name, d]));
    const readInside = await byName.get('hostctl.fs.read')!.classify!({ path: 'inside.txt' });
    expect(readInside).toEqual({ flags: { outsideRoots: false }, targets: [join(await realpath(root), 'inside.txt')], access: 'read' });
    const writeInside = await byName.get('hostctl.fs.write')!.classify!({ path: 'new-name.txt', content: 'x' });
    expect(writeInside).toMatchObject({ flags: { outsideRoots: false }, access: 'write' });
    expect(await byName.get('hostctl.fs.read')!.classify!({ path: join(outside, 'x') })).toEqual({ flags: { outsideRoots: true, denyListHit: true }, targets: [] });
    expect(await byName.get('hostctl.fs.read')!.classify!({ path: '.env' })).toEqual({ flags: { outsideRoots: true, denyListHit: true }, targets: [] });
  });

  it('classify keeps web targets out of the path check for app.open', async () => {
    const appOpen = host.definitions().find(d => d.name === 'hostctl.app.open')!;
    expect(await appOpen.classify!({ target: 'https://example.invalid/' })).toMatchObject({ flags: { outsideRoots: false }, targets: [] });
    expect(await appOpen.classify!({ target: join(outside, 'x') })).toEqual({ flags: { outsideRoots: true, denyListHit: true } });
  });

  it('classify handles a request without path arguments', async () => {
    const list = host.definitions().find(d => d.name === 'hostctl.sys.info')!;
    expect(await list.classify!({})).toMatchObject({ flags: { outsideRoots: false }, targets: [] });
  });
});

describe('lifecycle', () => {
  it('refuses operations after close and keeps close idempotent', async () => {
    await host.close();
    expect(await call('sys.info')).toMatchObject({ ok: false, error: { code: 'DENIED' } });
    await expect(host.close()).resolves.toBeUndefined();
  });

  it('endSession on an instance without processes resolves', async () => {
    await expect(host.endSession('nobody')).resolves.toBeUndefined();
  });

  it('resolves a symlinked directory that stays inside the root', async () => {
    if (process.platform === 'win32') return;
    await mkdir(join(root, 'real'));
    await writeFile(join(root, 'real', 'file.txt'), 'data');
    await symlink(join(root, 'real'), join(root, 'alias'));
    expect(await call('fs.stat', { path: 'alias/file.txt' })).toMatchObject({ ok: true });
  });
});
