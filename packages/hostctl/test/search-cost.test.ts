// What a content or name search costs is counted, not timed: every path canonicalisation (each one resolves the deny-list and
// the roots again, dozens of file-system calls) and every process start. A wall-clock bound only fails on the slow runner
// (Windows spent 36 s on 1500 files against a 30 s limit); a count fails on every platform the moment the algorithm degrades.
// Content search tests texts it has already read, in this process: no child process may start for it, not even when ripgrep is on the PATH
// (`which` below says it is, so a regression that spawns one again is counted here and refused by the spawn stand-in).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostctl, type Hostctl, type RunContext } from '../src/index.ts';

const cost = vi.hoisted(() => ({ spawns: 0, canon: 0 }));
vi.mock('../../core/src/host-tools/index.ts', async importOriginal => ({ ...(await importOriginal<typeof import('../../core/src/host-tools/index.ts')>()), which: async () => '/fixture/bin/rg' }));
vi.mock('../../core/src/policy/paths-index.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../../core/src/policy/paths-index.ts')>();
  return { ...real, canonicalisePath: (...a: Parameters<typeof real.canonicalisePath>) => { cost.canon++; return real.canonicalisePath(...a); } };
});
vi.mock('node:child_process', async importOriginal => ({ ...(await importOriginal<typeof import('node:child_process')>()), spawn: () => { cost.spawns++; throw new Error('a search must not start a process'); } }));

const N = 1500, FEW = 100;
const ctx: RunContext = { agentId: 'fixture-agent', principal: 'fixture-owner', sessionId: 's1', signal: new AbortController().signal };
let root: string, home: string, host: Hostctl;
const reset = () => { cost.spawns = 0; cost.canon = 0; };
const search = (args: object) => host.invoke('hostctl.fs.search', args, ctx) as Promise<{ ok: boolean; value?: { matches: { path: string }[]; truncated: boolean; backend: string }; error?: { code: string } }>;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'hc-cost-root-'))); home = await realpath(await mkdtemp(join(tmpdir(), 'hc-cost-home-')));
  await mkdir(join(root, 'many')); await Promise.all(Array.from({ length: N }, (_, i) => writeFile(join(root, 'many', `n${i}.txt`), `needle ${i}`)));
  await mkdir(join(root, 'few')); await Promise.all(Array.from({ length: FEW }, (_, i) => writeFile(join(root, 'few', `f${i}.txt`), `hay ${i}`)));
  host = createHostctl({ home, baseEnv: {}, roots: [{ id: 'fixture', path: root }], audit: () => {}, config: { search: { maxResults: 100 } } });
});
afterAll(async () => { await host.close(); await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });

describe('a search costs what it returns, not what it could scan', () => {
  it('content search that fills its 100 results out of 1500 matching files starts no process and canonicalises a few hundred paths', async () => {
    reset(); const r = await search({ path: 'many', query: 'needle', mode: 'content', depth: 4, limit: 100 });
    expect(r.ok, JSON.stringify(r)).toBe(true); expect(r.value!.backend).toBe('bounded-js');
    const sorted = Array.from({ length: N }, (_, i) => `n${i}.txt`).sort();
    expect(r.value!.matches.map(m => m.path)).toEqual(sorted.slice(0, 100)); expect(r.value!.truncated).toBe(true);
    // Before: one rg per file read (101 starts) and a canonicalisation of all 1000 listed entries before the first file was read (about 1250 in all).
    expect(cost.spawns, 'process starts').toBe(0);
    expect(cost.canon, 'canonicalisations').toBeLessThanOrEqual(400);
  }, 60_000);

  it('a content search nothing matches reads every file once and starts no process', async () => {
    reset(); const r = await search({ path: 'few', query: 'absent-literal', mode: 'content', depth: 4, limit: 100 });
    expect(r.ok, JSON.stringify(r)).toBe(true); expect(r.value!.matches).toEqual([]); expect(r.value!.truncated).toBe(false); // everything was listed and read
    expect(cost.spawns, 'process starts').toBe(0); // before: one per file, 100
    expect(cost.canon, 'canonicalisations').toBeLessThanOrEqual(2 * FEW + 20); // one per listed entry, one per file read, nothing quadratic
    reset(); const hit = await search({ path: 'few', query: 'hay 9', mode: 'content', depth: 4, limit: 100 });
    expect(hit.value!.matches.map(m => m.path)).toEqual(['f9.txt', ...Array.from({ length: 10 }, (_, i) => `f9${i}.txt`)]); expect(hit.value!.truncated).toBe(false);
  }, 120_000);

  it('a name search stops listing as soon as its results are full', async () => {
    reset(); const r = await search({ path: 'many', query: 'n', mode: 'name', depth: 4, limit: 5 });
    expect(r.ok, JSON.stringify(r)).toBe(true); expect(r.value!.matches).toHaveLength(5); expect(r.value!.truncated).toBe(true);
    expect(cost.spawns).toBe(0); expect(cost.canon, 'canonicalisations').toBeLessThanOrEqual(40);
  }, 60_000);
});
