import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostctl } from '../src/index.ts';
import { createHostctlPool } from '../src/pool.ts';
import { ToolRegistry } from '../../core/src/tools/registry.ts';
import { ToolDispatcher, type DispatchContext } from '../../core/src/tools/dispatcher.ts';
import { CAPABILITIES, decide, type Grant } from '../../core/src/policy/index.ts';
import { SessionStore } from '../../core/src/session/store.ts';
import { composeTools } from '../../core/src/composition/tools.ts';
const noGrants = { list: () => [] as Grant[], get: () => undefined };
const ctx: DispatchContext = { agentId: 'agent', principal: 'person', sessionId: 's', surface: 3, signal: new AbortController().signal };
const clock = { now: () => 1000 };
describe('unchanged D109 gate', () => {
  for (const id of ['hostctl.fs.trash', 'hostctl.proc.session.read', 'hostctl.proc.session.write', 'hostctl.proc.kill_foreign']) {
    it(`${id} is registered and obeys default, deny and explicit override`, () => {
      const cap = CAPABILITIES.get(id)!; expect(cap).toBeDefined();
      const call = { tool: 'hostctl.fixture', capability: id, effect: cap.intrinsicEffect, actionHash: 'fixture', flags: { outsideRoots: false, denyListHit: false } };
      const context = { principal: { person: 'person' }, subject: { kind: 'agent' as const, agentId: 'agent' }, surface: 3 as const };
      expect(decide(call, context, { grants: noGrants, clock }).kind).toBe(id.endsWith('.read') ? 'allow' : 'ask');
      expect(decide(call, { ...context, toolsDeny: [id] }, { grants: noGrants, clock }).kind).toBe('deny');
      expect(decide(call, { ...context, overrides: { [id]: 'approval' } }, { grants: noGrants, clock }).kind).toBe('ask');
      expect(decide({ ...call, flags: { ...call.flags, denyListHit: true } }, context, { grants: noGrants, clock }).kind).toBe('deny');
    });
  }
  it('fake approval denies foreign kill; approved call executes exactly once and read runs without asking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hostctl-policy-')); const killForeign = vi.fn(); const audit: unknown[] = [];
    const h = createHostctl({ home: join(root, 'fixture-home'), baseEnv: {}, roots: [{ id: 'r', path: root }], audit: e => audit.push(e), killForeign });
    try {
      const registry = new ToolRegistry(); for (const t of h.definitions()) registry.register(t);
      const request = vi.fn(async () => ({ approved: false }));
      const d = new ToolDispatcher({ registry, approvals: { request }, grants: noGrants, clock });
      const read = await d.call({ id: 'read', name: 'hostctl.sys.info', args: {} }, ctx); expect(read.isError).toBe(false); expect(request).not.toHaveBeenCalled();
      const denied = await d.call({ id: 'deny', name: 'hostctl.proc.kill_foreign', args: { pid: 123456 } }, ctx);
      expect(denied.isError).toBe(true); expect(killForeign).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledOnce();
      // Production approval provides a recorded begin binding; exercise that seam here.
      const approved = new ToolDispatcher({ registry, grants: noGrants, clock, approvals: { request: async () => ({ approved: true, requestId: 'fixture' }), begin: () => true } });
      const result = await approved.call({ id: 'yes', name: 'hostctl.proc.kill_foreign', args: { pid: 123456 } }, ctx);
      expect(result.isError).toBe(false); expect(killForeign).toHaveBeenCalledOnce();
      const outside = await d.call({ id: 'outside', name: 'hostctl.fs.write', args: { path: '../escape', content: 'secret' } }, ctx);
      expect(outside.isError).toBe(true); expect(await readdir(root)).toEqual([]); expect(JSON.stringify(audit)).not.toContain('secret');
    } finally { await h.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('composition registers the local tools additively and disabled config removes them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hostctl-composition-')); const pool = createHostctlPool({ home: join(root, 'fixture-home'), baseEnv: {}, audit: () => {} });
    const options = { home: root, roots: [{ id: 'r', path: join(root, 'workspace') }], audit: { append: () => {} }, grants: noGrants, hostctl: pool };
    try {
      const registry = await composeTools(options, { ...ctx, principal: 'person' } as any);
      expect(registry.get('hostctl.fs.read')?.capability).toBe('fs.read'); expect(registry.get('exec.run')).toBeDefined();
      expect(registry.get('hostctl.clipboard.write')?.capability).toBe('clipboard.read');
      const disabled = createHostctl({ home: join(root, 'fixture-home'), baseEnv: {}, roots: options.roots, audit: () => {}, config: { enabled: false } }); expect(disabled.definitions()).toEqual([]); await disabled.close();
    } finally { await pool.close(); await rm(root, { recursive: true, force: true }); }
  });
});
it('archive observer sees only committed archive/replacement; unsubscribe works', () => {
  const store = new SessionStore({ path: ':memory:', clock: () => 100 }); const events: string[] = [];
  const unsubscribe = store.onArchived(id => { expect(store.getSession(id)?.archivedAt).toBe(100); events.push(id); });
  try {
    const s = store.createSession({ kind: 'channel', agentId: 'a', owner: 'o', chatKey: 'fixture' });
    expect(() => store.createSession({ kind: 'channel', agentId: 'a', owner: 'o', chatKey: 'fixture' })).toThrow(); expect(events).toEqual([]);
    const next = store.createSession({ kind: 'channel', agentId: 'a', owner: 'o', chatKey: 'fixture', replaceActive: true }); expect(events).toEqual([s.id]);
    store.archiveSession(next.id); store.archiveSession(next.id); expect(events).toEqual([s.id, next.id]); unsubscribe();
    const direct = store.createSession({ kind: 'direct', agentId: 'a', owner: 'o' }); store.archiveSession(direct.id); expect(events).toHaveLength(2);
  } finally { store.close(); }
});
it('an observer failure cannot turn a committed archive into a failed session operation', () => {
  const store = new SessionStore({ path: ':memory:' }); store.onArchived(() => { throw Error('fixture observer'); });
  try { const s = store.createSession({ kind: 'direct', agentId: 'a', owner: 'o' }); expect(() => store.archiveSession(s.id)).not.toThrow(); expect(store.getSession(s.id)?.archivedAt).not.toBeNull(); }
  finally { store.close(); }
});
