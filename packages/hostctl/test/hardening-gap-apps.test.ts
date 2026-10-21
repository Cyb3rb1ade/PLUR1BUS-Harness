// Gap-fix tests for hostctl app.open (no executables), its audit trail and fs.trash with nested roots.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostctl, SPECS, type Audit, type Hostctl, type Options, type RunContext } from '../src/index.ts';
import * as native from '../src/native.ts';

// The OS opener must never run from a test.
vi.mock('../src/native.ts', async importOriginal => ({ ...(await importOriginal<typeof import('../src/native.ts')>()), open: vi.fn(async () => {}) }));

const posix = process.platform !== 'win32';
const root0 = await realpath(tmpdir());
const ctx: RunContext = { agentId: 'fixture-agent', principal: 'fixture-owner', sessionId: 's1', signal: new AbortController().signal };
let root: string, home: string, audit: Audit[]; const hosts: Hostctl[] = [];
beforeEach(async () => { root = await realpath(await mkdtemp(join(root0, 'hc-apps-root-'))); home = await realpath(await mkdtemp(join(root0, 'hc-apps-home-'))); audit = []; vi.mocked(native.open).mockClear(); });
afterEach(async () => { for (const h of hosts.splice(0)) await h.close(); for (const d of [root, home]) await rm(d, { recursive: true, force: true }); });
const make = (o: Partial<Options> = {}): Hostctl => { const h = createHostctl({ home, baseEnv: {}, roots: [{ id: 'fixture', path: root }], audit: e => { audit.push(e); }, ...o }); hosts.push(h); return h; };
const call = (h: Hostctl, name: string, args: object = {}) => h.invoke(`hostctl.${name}`, args, ctx) as Promise<{ ok: boolean; value?: any; error?: { code: string; hint: string } }>;

describe('app.open does not launch programs', () => {
  it.each(['setup.exe', 'run.bat', 'RUN.CMD', 'run.ps1', 'x.msi', 'x.vbs', 'x.js', 'x.hta', 'run.command', 'x.desktop', 'tool.AppImage', 'x.pkg', 'x.jar', 'x.com', 'x.scr', 'x.reg'])('refuses %s without calling the OS opener', async name => {
    await writeFile(join(root, name), 'echo hi'); const h = make();
    const r = await call(h, 'app.open', { target: name });
    expect(r.ok, JSON.stringify(r)).toBe(false); expect(r.error!.code).toBe('DENIED'); expect(r.error!.hint).toContain('proc.');
    expect(native.open).not.toHaveBeenCalled();
  });
  it('refuses an application bundle directory', async () => {
    await mkdir(join(root, 'Evil.app')); const h = make();
    for (const target of ['Evil.app', 'Evil.app/', join(root, 'Evil.APP')]) expect((await call(h, 'app.open', { target })).error?.code, target).toBe('DENIED');
    expect(native.open).not.toHaveBeenCalled();
  });
  it('refuses a name that only becomes an executable through a symlink', async () => {
    if (!posix) return;
    await writeFile(join(root, 'real.sh'), '#!/bin/sh\n'); await chmod(join(root, 'real.sh'), 0o755);
    const { symlink } = await import('node:fs/promises'); await symlink(join(root, 'real.sh'), join(root, 'innocent.txt'));
    expect((await call(make(), 'app.open', { target: 'innocent.txt' })).ok).toBe(false);
    expect(native.open).not.toHaveBeenCalled();
  });
  it.skipIf(!posix)('refuses a file with an execute bit whatever its name, also when only the group or others may execute', async () => {
    for (const [name, mode] of [['script', 0o755], ['plain.txt', 0o700], ['group', 0o610], ['other', 0o601]] as const) { await writeFile(join(root, name), '#!/bin/sh\n'); await chmod(join(root, name), mode); }
    const h = make();
    for (const name of ['script', 'plain.txt', 'group', 'other']) expect((await call(h, 'app.open', { target: name })).error?.code, name).toBe('DENIED');
    expect(native.open).not.toHaveBeenCalled();
  });
  it('still opens documents, directories and URLs', async () => {
    await writeFile(join(root, 'notes.txt'), 'x'); await chmod(join(root, 'notes.txt'), 0o644); await writeFile(join(root, 'readme.md'), 'x'); await mkdir(join(root, 'folder')); const h = make();
    for (const target of ['notes.txt', 'readme.md', 'folder', 'https://example.invalid/a']) expect((await call(h, 'app.open', { target })).ok, target).toBe(true);
    expect(native.open).toHaveBeenCalledTimes(4);
  });
});

describe('the audit trail names the app.open target', () => {
  it('records a local target in paths, and keeps URLs out of them', async () => {
    await writeFile(join(root, 'notes.txt'), 'x'); const h = make();
    await call(h, 'app.open', { target: 'notes.txt' }); await call(h, 'app.open', { target: 'https://example.invalid/a?token=x' });
    expect(audit.filter(e => e.phase === 'begin').map(e => e.paths)).toEqual([['notes.txt'], []]);
    expect(JSON.stringify(audit)).not.toContain('example.invalid');
  });
  it('records a refused executable target as well', async () => {
    await writeFile(join(root, 'run.bat'), 'x'); await call(make(), 'app.open', { target: 'run.bat' });
    expect(audit.map(e => [e.phase, e.code, e.paths])).toEqual([['begin', 'START', ['run.bat']], ['end', 'DENIED', ['run.bat']]]);
  });
  it('declares apps.launch for app.open, an approval-class capability', () => { expect(SPECS['app.open']!.capability).toBe('apps.launch'); });
});

describe('fs.trash with nested roots', () => {
  const nested = async () => {
    await mkdir(join(root, 'proj/deep'), { recursive: true }); await mkdir(join(root, 'proj/other'), { recursive: true }); await writeFile(join(root, 'proj/other/a.txt'), 'x'); await writeFile(join(root, 'proj/b.txt'), 'x');
    const trash = vi.fn(async () => {});
    return { trash, h: make({ roots: [{ id: 'outer', path: root }, { id: 'inner', path: join(root, 'proj/deep') }], trash }) };
  };
  it('refuses to trash a folder that contains another configured root', async () => {
    const { trash, h } = await nested();
    for (const path of ['proj', join(root, 'proj'), 'proj/']) { const r = await call(h, 'fs.trash', { path }); expect(r.ok, path).toBe(false); expect(r.error!.code, path).toBe('DENIED'); }
    expect(trash).not.toHaveBeenCalled();
  });
  it('refuses to trash or move a nested root itself, whichever root the path resolves under', async () => {
    const { trash, h } = await nested();
    expect((await call(h, 'fs.trash', { path: join(root, 'proj/deep') })).error?.code).toBe('DENIED');
    expect((await call(h, 'fs.trash', { path: 'proj/deep' })).error?.code).toBe('DENIED');
    expect(trash).not.toHaveBeenCalled();
  });
  it('still trashes unrelated folders and files below the roots', async () => {
    const { trash, h } = await nested();
    expect((await call(h, 'fs.trash', { path: 'proj/other' })).ok).toBe(true); expect((await call(h, 'fs.trash', { path: 'proj/b.txt' })).ok).toBe(true);
    expect(trash).toHaveBeenCalledTimes(2);
  });
});
