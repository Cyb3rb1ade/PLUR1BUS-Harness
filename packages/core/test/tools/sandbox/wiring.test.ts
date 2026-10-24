import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeTools } from '../../../src/composition/tools.ts';
import { ToolRegistry } from '../../../src/tools/registry.ts';
import { ToolDispatcher } from '../../../src/tools/dispatcher.ts';
import { createPolicyAudit } from '../../../src/policy/audit.ts';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { realTempDir } from '../../helpers/real-temp-dir.ts';
test('production exec refuses when required sandbox launcher is missing', async () => {
  const dir = await realTempDir('d106-wire-'); try {
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
  const dir = await realTempDir('d106-bypass-'); try {
    const signal = new AbortController().signal; const actions: string[] = [];
    const registry = await composeTools({ home: dir, roots: [{ id: 'r', path: dir }], sandbox: { required: false }, audit: { append(v: { action: string }) { actions.push(v.action); } } as never, grants: { list: () => [], get: () => undefined }, exec: { mode: 'allowlist', allowlist: [{ program: process.execPath }] } }, { sessionId: 's', agentId: 'a', principal: 'p', summaries: [], memory: '', messages: [], signal });
    const r = await registry.get('exec.run')!.execute({ program: process.execPath, args: ['-e', 'process.stdout.write("bypass")'], cwd: dir }, { agentId: 'a', principal: 'p', signal }) as { stdout: string; sandboxed: boolean };
    assert.equal(r.stdout, 'bypass'); assert.equal(r.sandboxed, false); assert.ok(actions.includes('sandbox.bypass'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('approval root extension is invocation-only and remains behind the credential deny list', async () => {
  const dir = await realTempDir('d106-once-'); const outside = await realTempDir('d106-out-');
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
  const dir = await realTempDir('d106-audit-'); try {
    const { createSandboxProcessPort } = await import('../../../src/tools/sandbox/ports.ts');
    const port = createSandboxProcessPort({ home: dir, roots: [], deny: [], principal: 'p', sandbox: { required: false }, audit: { append() { throw Error('audit offline'); } } as never });
    assert.throws(() => port.spawn({ program: process.execPath, args: ['-e', 'process.exit(0)'], cwd: dir, env: {} }), /audit offline/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
// hostctl's worker has no sandbox policy yet: the requirement is a precondition of dispatcher.call (D106), so every route below
// goes through the dispatcher (policy, audit, taint) and the composition never wraps or calls the tool's execute itself.
type Line = { action: string; target?: string; detail?: Record<string, unknown> };
async function hostctlRig(sandbox: { required: boolean } | undefined, opts: { auditFails?: boolean } = {}) {
  const dir = await realTempDir('d106-hostctl-');
  const signal = new AbortController().signal; const lines: Line[] = []; const ran: string[] = [];
  const sink = { append(v: Line) { if (opts.auditFails && v.action === 'sandbox.bypass') throw Error('audit offline'); lines.push(v); } };
  const def = (name: string) => ({ name, description: name, inputSchema: { type: 'object' }, capability: 'sys.read', effect: 'read', risk: 'low', trust: 'first-party', classify: () => ({ flags: { outsideRoots: false } }), execute: async () => { lines.push({ action: 'tool.ran', target: name }); ran.push(name); return 'ok'; } });
  const registry = await composeTools({ home: dir, roots: [{ id: 'r', path: dir }], ...(sandbox ? { sandbox } : {}), audit: sink as never, grants: { list: () => [], get: () => undefined }, hostctl: { forRoots: () => ({ definitions: () => [def('hostctl.notify'), def('hostctl.proc.exec'), def('hostctl.fs.stat')] }) } as never }, { sessionId: 's', agentId: 'a', principal: 'p', summaries: [], memory: '', messages: [], signal });
  const dispatcher = new ToolDispatcher({ registry, grants: { list: () => [], get: () => undefined }, approvals: { request: async () => ({ approved: false }) }, clock: { now: Date.now }, audit: createPolicyAudit({ sink: sink as never, clock: { now: Date.now }, host: 'h' }) });
  const ctx = { principal: 'p', agentId: 'a', sessionId: 's', surface: 3 as const, signal };
  return { dir, lines, ran, call: (name: string) => dispatcher.call({ id: name, name, args: {} }, ctx), done: () => rm(dir, { recursive: true, force: true }) };
}
const about = (l: Line, tool: string) => l.target === tool || l.detail?.tool === tool;
const decisions = (lines: Line[], tool: string) => lines.filter(l => l.action === 'policy.decision' && about(l, tool));
test('hostctl process routes are refused through the dispatcher while sandbox.required is on (default and explicit), and the refusal is audited', async () => {
  for (const sandbox of [undefined, { required: true }]) {
    const r = await hostctlRig(sandbox); try {
      for (const name of ['hostctl.notify', 'hostctl.proc.exec']) {
        const out = await r.call(name);
        assert.equal(out.isError, true);
        assert.equal(out.isError && out.error.code, 'tool-denied');
        assert.match(out.isError ? out.error.message : '', /sandbox/);
        assert.equal(decisions(r.lines, name).length, 1, `${name}: the refusal is a recorded policy decision`);
        assert.equal(decisions(r.lines, name)[0]!.detail?.outcome, 'never');
        assert.equal(decisions(r.lines, name)[0]!.detail?.rule, 'sandbox-unavailable');
      }
      assert.deepEqual(r.ran, [], 'no hostctl process route reached its unsandboxed worker');
      assert.ok(!r.lines.some(l => l.action === 'sandbox.bypass'));
      const stat = await r.call('hostctl.fs.stat');
      assert.equal(stat.isError, false, 'routes that launch nothing are unaffected');
      assert.deepEqual(r.ran, ['hostctl.fs.stat']);
    } finally { await r.done(); }
  }
});
test('the composed hostctl tool is not wrapped: the requirement is part of its registration and enforced by dispatcher.call', async () => {
  const dir = await realTempDir('d106-unwrapped-'); try {
    const signal = new AbortController().signal; const execute = async () => 'ok';
    const registry = await composeTools({ home: dir, roots: [{ id: 'r', path: dir }], audit: { append() {} } as never, grants: { list: () => [], get: () => undefined }, hostctl: { forRoots: () => ({ definitions: () => [{ name: 'hostctl.notify', description: 'notify', inputSchema: { type: 'object' }, capability: 'sys.read', effect: 'read', risk: 'low', execute }] }) } as never }, { sessionId: 's', agentId: 'a', principal: 'p', summaries: [], memory: '', messages: [], signal });
    const tool = registry.get('hostctl.notify')!;
    assert.equal(tool.execute, execute, 'no composition-level wrapper calls execute outside the dispatcher');
    assert.equal(tool.processSandbox?.required, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('owner bypass of a hostctl process route runs through the dispatcher: decision, bypass line before the launch, outcome', async () => {
  const r = await hostctlRig({ required: false }); try {
    const out = await r.call('hostctl.proc.exec');
    assert.equal(out.isError, false);
    const order = r.lines.filter(l => about(l, 'hostctl.proc.exec')).map(l => l.action === 'policy.decision' || l.action === 'policy.outcome' ? `${l.action}:${String(l.detail?.outcome)}` : l.action);
    assert.deepEqual(order, ['policy.decision:allowed', 'sandbox.bypass', 'tool.ran', 'policy.outcome:executed']);
    assert.deepEqual(r.lines.find(l => l.action === 'sandbox.bypass')!.detail, { required: false, sandboxed: false });
  } finally { await r.done(); }
});
test('a hostctl bypass that cannot be audited does not launch', async () => {
  const r = await hostctlRig({ required: false }, { auditFails: true }); try {
    const out = await r.call('hostctl.notify');
    assert.equal(out.isError, true);
    assert.equal(out.isError && out.error.code, 'tool-denied');
    assert.deepEqual(r.ran, []);
    assert.equal(r.lines.filter(l => l.action === 'policy.outcome' && about(l, 'hostctl.notify')).length, 1);
  } finally { await r.done(); }
});
test('even a broad approved root cannot edit sandbox configuration or installation binaries', async () => {
  const {mkdir,writeFile}=await import('node:fs/promises');
  const dir=await realTempDir('d106-control-'); try {
    await writeFile(join(dir,'config.json'),'{}'); await mkdir(join(dir,'bin')); await writeFile(join(dir,'bin','launcher'),'fixture');
    const signal=new AbortController().signal;
    const registry=await composeTools({home:dir,roots:[{id:'broad',path:dir}],audit:{append(){}} as never,grants:{list:()=>[],get:()=>undefined}},{sessionId:'s',agentId:'a',principal:'p',summaries:[],memory:'',messages:[],signal});
    for(const path of [join(dir,'config.json'),join(dir,'bin','launcher')]) {
      assert.equal((await registry.get('file.write')!.classify!({path})).flags?.denyListHit,true);
      await assert.rejects(registry.get('file.write')!.execute({path,content:'unsafe',overwrite:true},{signal,principal:'p',agentId:'a'}));
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
