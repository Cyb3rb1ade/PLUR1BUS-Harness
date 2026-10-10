import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHostctlPool } from '../src/pool.ts';
import type { RunContext } from '../src/index.ts';

let root: string, home: string;
const roots = (path: string) => [{ id: 'fixture', path }];
const ctxOf = (sessionId: string): RunContext => ({ agentId: 'agent-fixture', principal: 'owner-fixture', sessionId, signal: new AbortController().signal });

/** A fake child process; `kill()` closes it synchronously, as a signalled child would. */
function fakeChild() {
  const child = new EventEmitter() as any;
  child.pid = 4242; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = vi.fn(() => { child.emit('close', null, 'SIGKILL'); return true; });
  return child;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hostctl-pool-'));
  home = await mkdtemp(join(tmpdir(), 'hostctl-pool-home-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function pool(extra: Record<string, unknown> = {}) {
  const children: any[] = [];
  const spawn = vi.fn((..._args: any[]) => { const child = fakeChild(); children.push(child); return child; });
  const killTree = vi.fn(async (child: any) => { child.kill(); });
  const audit = vi.fn();
  const p = createHostctlPool({ home, baseEnv: { PATH: '/fixture/bin' }, audit, spawn: spawn as never, killTree: killTree as never, ...extra } as never);
  return { p, spawn, killTree, audit, children };
}

describe('forRoots caching', () => {
  it('returns the same runtime for identical roots and deny lists', () => {
    const { p } = pool();
    const first = p.forRoots(roots(root), []);
    expect(p.forRoots(roots(root), [])).toBe(first);
  });

  it('returns a different runtime when the roots differ', () => {
    const { p } = pool();
    expect(p.forRoots(roots(root), [])).not.toBe(p.forRoots(roots(join(root, 'other')), []));
  });

  it('returns a different runtime when the deny list differs', () => {
    const { p } = pool();
    expect(p.forRoots(roots(root), [])).not.toBe(p.forRoots(roots(root), [{ name: 'fixture-deny' }] as never));
  });

  it('keeps Unicode root ids and paths as distinct keys', () => {
    const { p } = pool();
    const a = p.forRoots([{ id: 'fixture-ünï', path: root }], []);
    const b = p.forRoots([{ id: 'fixture-🙂', path: root }], []);
    expect(a).not.toBe(b);
    expect(p.forRoots([{ id: 'fixture-ünï', path: root }], [])).toBe(a);
  });

  it('passes the pool options into every runtime it creates', () => {
    const { p } = pool({ config: { enabled: false } });
    expect(p.forRoots(roots(root), []).definitions()).toEqual([]);
  });

  it('gives each runtime its own roots, not the roots of another runtime', async () => {
    const { p } = pool();
    const inside = p.forRoots(roots(root), []);
    const elsewhere = p.forRoots(roots(join(root, 'nested-root-that-does-not-exist')), []);
    expect(await inside.invoke('hostctl.sys.info', {}, ctxOf('s1'))).toMatchObject({ ok: true });
    const disks = (await elsewhere.invoke('hostctl.sys.info', {}, ctxOf('s1')) as { value: { disks: unknown[] } }).value.disks;
    expect(disks).toEqual([{ rootId: 'fixture', unavailable: true }]);
  });
});

describe('endSession and close', () => {
  it('endSession on an empty pool resolves', async () => {
    const { p } = pool();
    await expect(p.endSession('nobody')).resolves.toBeUndefined();
  });

  it('endSession terminates processes of that session in every runtime, and leaves other sessions alone', async () => {
    const { p, children } = pool();
    const a = p.forRoots(roots(root), []);
    const b = p.forRoots(roots(join(root, 'second')), []);
    await mkdirFixture(join(root, 'second'));
    expect(await a.invoke('hostctl.proc.start', { program: 'fixture', cwd: root }, ctxOf('s1'))).toMatchObject({ ok: true });
    expect(await b.invoke('hostctl.proc.start', { program: 'fixture', cwd: join(root, 'second') }, ctxOf('s1'))).toMatchObject({ ok: true });
    expect(await a.invoke('hostctl.proc.start', { program: 'fixture', cwd: root }, ctxOf('s2'))).toMatchObject({ ok: true });
    expect(children).toHaveLength(3);
    await p.endSession('s1');
    expect(children[0].kill).toHaveBeenCalledOnce();
    expect(children[1].kill).toHaveBeenCalledOnce();
    expect(children[2].kill).not.toHaveBeenCalled();
  });

  it('close shuts down every runtime and clears the pool, so the next forRoots creates a new runtime', async () => {
    const { p, children } = pool();
    const before = p.forRoots(roots(root), []);
    expect(await before.invoke('hostctl.proc.start', { program: 'fixture', cwd: root }, ctxOf('s1'))).toMatchObject({ ok: true });
    await p.close();
    expect(children[0].kill).toHaveBeenCalledOnce();
    expect(await before.invoke('hostctl.sys.info', {}, ctxOf('s1'))).toMatchObject({ ok: false, error: { code: 'DENIED' } });
    const after = p.forRoots(roots(root), []);
    expect(after).not.toBe(before);
    expect(await after.invoke('hostctl.sys.info', {}, ctxOf('s1'))).toMatchObject({ ok: true });
  });

  it('close on an empty pool resolves', async () => {
    const { p } = pool();
    await expect(p.close()).resolves.toBeUndefined();
  });
});

async function mkdirFixture(path: string) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path, { recursive: true });
}
