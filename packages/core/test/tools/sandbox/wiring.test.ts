import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeTools } from '../../../src/composition/tools.ts';
import { ToolRegistry } from '../../../src/tools/registry.ts';
import { ToolDispatcher } from '../../../src/tools/dispatcher.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('production exec refuses when required sandbox launcher is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'd106-wire-')); try {
    const signal = new AbortController().signal;
    const registry = await composeTools({ home: dir, roots: [{ id: 'r', path: dir }], audit: { append() {} } as never, grants: { list: () => [], get: () => undefined }, exec: { mode: 'allowlist', allowlist: [{ program: '/bin/echo' }] } }, { sessionId: 's', agentId: 'a', principal: 'p', summaries: [], memory: '', messages: [], signal });
    await assert.rejects(registry.get('exec.run')!.execute({ program: '/bin/echo', args: ['unexpected'], cwd: dir }, { agentId: 'a', principal: 'p', signal }), /sandbox|tool-failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('external result taints only this turn and suspends standing external grant', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'web.fetch', description: 'web', inputSchema: { type: 'object' }, capability: 'net.fetch', effect: 'read', risk: 'low', trust: 'first-party', execute: async () => 'foreign content' });
  registry.register({ name: 'external.send', description: 'send', inputSchema: { type: 'object' }, capability: 'net.publish', effect: 'external', risk: 'high', trust: 'first-party', classify: () => ({ flags: { outsideRoots: false } }), execute: async () => 'sent' });
  const now = Date.now();
  const grant = { id: 'g', person: 'p', agent: 'a', capability: 'net.publish', scope: 'always' as const, createdAt: now, expiresAt: now + 100000, lastUsedAt: now, lastReviewedAt: now, effect: 'external' as const, surface: 3 as const, match: { kind: 'capability' as const } };
  let asks = 0;
  const dispatcher = new ToolDispatcher({ registry, grants: { list: () => [grant], get: () => grant }, grantUse: { markUsed() {}, consumeOnce: () => true }, approvals: { request: async () => { asks++; return { approved: false }; } }, clock: { now: () => now } });
  const ctx = { principal: 'p', agentId: 'a', sessionId: 's', turnId: 'turn', surface: 2 as const, signal: new AbortController().signal };
  assert.equal((await dispatcher.call({ id: '1', name: 'external.send', args: {} }, ctx)).isError, false);
  await dispatcher.call({ id: '2', name: 'web.fetch', args: {} }, ctx);
  assert.equal((await dispatcher.call({ id: '3', name: 'external.send', args: {} }, ctx)).isError, true);
  assert.equal(asks, 1);
  assert.equal((await dispatcher.call({ id: '4', name: 'external.send', args: {} }, { ...ctx, turnId: 'next' })).isError, false);
});
test('owner bypass is explicit, audited before spawn, and marked in the result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'd106-bypass-')); try {
    const signal = new AbortController().signal; const actions: string[] = [];
    const registry = await composeTools({ home: dir, roots: [{ id: 'r', path: dir }], sandbox: { required: false }, audit: { append(v: { action: string }) { actions.push(v.action); } } as never, grants: { list: () => [], get: () => undefined }, exec: { mode: 'allowlist', allowlist: [{ program: process.execPath }] } }, { sessionId: 's', agentId: 'a', principal: 'p', summaries: [], memory: '', messages: [], signal });
    const r = await registry.get('exec.run')!.execute({ program: process.execPath, args: ['-e', 'process.stdout.write("bypass")'], cwd: dir }, { agentId: 'a', principal: 'p', signal }) as { stdout: string; sandboxed: boolean };
    assert.equal(r.stdout, 'bypass'); assert.equal(r.sandboxed, false); assert.ok(actions.includes('sandbox.bypass'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('approval root extension is invocation-only and remains behind the credential deny list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'd106-once-')); const outside = await mkdtemp(join(tmpdir(), 'd106-out-'));
  try {
    const signal = new AbortController().signal, roots = [{ id: 'r', path: dir }];
    const registry = await composeTools({ home: dir, roots, sandbox: { required: false }, audit: { append() {} } as never, grants: { list: () => [], get: () => undefined }, exec: { mode: 'allowlist', allowlist: [{ program: process.execPath }] } }, { sessionId: 's', agentId: 'a', principal: 'p', summaries: [], memory: '', messages: [], signal });
    const tool = registry.get('exec.run')!;
    const args = { program: process.execPath, args: ['-e', 'process.stdout.write("once")'], cwd: outside };
    const classified = await tool.classify!(args);
    assert.equal(classified.flags?.outsideRoots, true);
    const result = await tool.execute(args, { signal, principal: 'p', agentId: 'a', classified }) as { stdout: string };
    assert.equal(result.stdout, 'once');
    await assert.rejects(tool.execute(args, { signal, principal: 'p', agentId: 'a' }));
    assert.equal(roots.length, 1);
    await assert.rejects(tool.classify!({ ...args, cwd: join(dir, 'state') }) as Promise<unknown>);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
test('audit failure prevents explicit bypass execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'd106-audit-')); try {
    const { createSandboxProcessPort } = await import('../../../src/tools/sandbox/ports.ts');
    const port = createSandboxProcessPort({ home: dir, roots: [], deny: [], principal: 'p', sandbox: { required: false }, audit: { append() { throw Error('audit offline'); } } as never });
    assert.throws(() => port.spawn({ program: process.execPath, args: ['-e', 'process.exit(0)'], cwd: dir, env: {} }), /audit offline/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
