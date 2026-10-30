import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaults } from '@plur1bus/config-schema';
import type { HarnessConfig } from '@plur1bus/config-schema';
import { createCollab } from '../../src/collab/service.ts';
import { composedAgentRunner } from '../../src/composition/collaboration.ts';
import { alsAgentScopePort, scopeFor } from '../../src/collab/index.ts';
import type { AgentRunInput } from '../../src/collab/runner.ts';
import { collaborationTools, type CollaborationTools } from '../../src/tools/collaboration.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { ToolDispatcher } from '../../src/tools/dispatcher.ts';
import type { Principal } from '../../src/rbac/types.ts';
import { returnFromText } from '../../src/collab/handoff.ts';
import type { ChatChunk, ChatProvider, ChatRequest } from '../../src/session/provider.ts';
import { engineTurnMemory } from '../../src/session/memory-port.ts';
import { collabMemory } from '../../src/memory-exposure/index.ts';
import { deriveUserPrincipal } from '../../src/identity/principals.ts';
import { turnRequest, useTempDirs } from '../composition/helpers.ts';
import { rig } from '../approvals/service-helpers.ts';
import { tempDir } from '../helpers/temp-dir.ts';

const tmp = useTempDirs('collab-exposure-');
const owner: Principal = { kind: 'person', userId: 'christian', role: 'owner' };
const memberWith = (right?: 'use' | 'manage'): Principal => ({ kind: 'person', userId: 'mia', role: 'member', ...(right ? { agentRights: { callee: right } } : {}) });

/** A fake engine that answers like the real ACL: agent-private and workspace for the agent, the user scope only with `user`. */
function engineFixture() {
  const recalls: { agentId: string; user: string | undefined; query: string }[] = [];
  const captures: { agentId: string; user: string | undefined; sessionKey?: string; runId?: string; messages: { role: string; content: string }[] }[] = [];
  const who = (user: string) => user === deriveUserPrincipal('christian') ? 'CHRISTIAN' : user === deriveUserPrincipal('mia') ? 'MIA' : 'SOMEONE';
  let fail = false;
  const engine: any = {
    async recall({ principal, query }: any) {
      recalls.push({ agentId: principal.agentId, user: principal.user, query });
      if (fail) throw new Error('engine down');
      const texts = [`MARK-AP-${principal.agentId}`, `MARK-WS-${principal.agentId}`, ...(principal.user ? [`MARK-USER-${who(principal.user)}`] : [])];
      return { blocks: texts.map(text => ({ name: 'memories', text, chars: text.length, droppable: false })), capChars: Infinity, degraded: null };
    },
    capture({ principal, agentId, sessionKey, runId, messages }: any) { captures.push({ agentId, user: principal.user, sessionKey, runId, messages }); return { id: 'capture', done: Promise.resolve({ stored: 1, skipped: 0 }) }; },
  };
  return { engine, recalls, captures, failRecall: () => { fail = true; } };
}

function setup(exposure?: NonNullable<HarnessConfig['agents'][string]['memoryExposure']>) {
  const eng = engineFixture();
  const cfg = defaults();
  cfg.agents.callee = exposure ? { memoryExposure: exposure } : {};
  const logs: { msg: string; fields: any }[] = [];
  const logger: any = { info: (msg: string, fields: any) => logs.push({ msg, fields }), warn: (msg: string, fields: any) => logs.push({ msg, fields }) };
  const memory = engineTurnMemory({ engine: eng.engine, config: () => cfg, agents: { workspaceOf: () => tempDir('collab-exposure-ws-'), has: () => true } as any, logger, captureSignal: new AbortController().signal, isStopping: () => false });
  const exposureMemory = collabMemory({ memory, config: () => cfg, logger });
  const seen: ChatRequest[] = [];
  const provider: ChatProvider = { id: 'peer', async *stream(req) { seen.push(req); yield { type: 'delta', text: 'Use a stable sort.' } as ChatChunk; yield { type: 'usage', inputTokens: 3, outputTokens: 4 } as ChatChunk; } };
  const runner = composedAgentRunner(provider, alsAgentScopePort(), tmp.make(), [], exposureMemory);
  const consult = (principal: Principal | undefined = owner, over: Partial<AgentRunInput> = {}, withOrigin = true) => alsAgentScopePort().run(scopeFor('callee', 'proj-1'), () => runner.run({
    agentId: 'callee', question: 'Which sort should I use?', context: '', signal: new AbortController().signal, sessionId: 'sess-1', ...(principal ? { principal } : {}),
    ...(withOrigin ? { origin: { fromAgent: 'asker', traceId: 'trace-1', spanId: 'span-1' } } : {}), ...over,
  }));
  return { ...eng, logs, seen, consult, idle: () => exposureMemory.idle() };
}

test('a consult turn recalls the asked agent\'s memory for the person who asked, through the turn memory port', async () => {
  const f = setup();
  const out = await f.consult();
  assert.equal(out.text, 'Use a stable sort.');
  assert.equal(f.recalls.length, 1);
  assert.equal(f.recalls[0]!.agentId, 'callee');
  assert.equal(f.recalls[0]!.user, deriveUserPrincipal('christian'));
  assert.match(f.recalls[0]!.query, /Which sort should I use\?/);
  const req = f.seen[0]!;
  for (const marker of ['MARK-AP-callee', 'MARK-WS-callee', 'MARK-USER-CHRISTIAN']) assert.match(req.memory, new RegExp(marker));
  assert.doesNotMatch(req.memory, /MARK-USER-MIA/);
  assert.deepEqual(req.summaries, [], 'summaries are the session\'s compaction summaries; a collab hop has none');
  assert.equal(req.principal, 'christian');
});

test('another person gets their own user scope, never the owner\'s', async () => {
  const f = setup();
  await f.consult(memberWith('manage'));
  assert.match(f.seen[0]!.memory, /MARK-USER-MIA/);
  assert.doesNotMatch(f.seen[0]!.memory, /CHRISTIAN/);
});

test('agent-private memory appears only for a principal who holds manage', async () => {
  const withManage = setup(); await withManage.consult(memberWith('manage'));
  assert.match(withManage.seen[0]!.memory, /MARK-AP-callee/);
  for (const right of ['use', undefined] as const) {
    const f = setup(); await f.consult(memberWith(right));
    assert.doesNotMatch(f.seen[0]!.memory, /MARK-AP/, `right ${right}`);
    assert.equal(f.seen[0]!.memory, '');
    assert.equal(f.recalls.length, 0, 'the engine cannot hide agent-private alone, so it is not asked');
  }
});

test('every recall switch works on its own', async () => {
  const user = setup({ collab: { recall: { user: false } } }); await user.consult();
  assert.equal(user.recalls.length, 1); assert.equal(user.recalls[0]!.user, undefined);
  assert.doesNotMatch(user.seen[0]!.memory, /MARK-USER/); assert.match(user.seen[0]!.memory, /MARK-AP-callee/); assert.match(user.seen[0]!.memory, /MARK-WS-callee/);
  for (const scope of ['workspace', 'agentPrivate'] as const) {
    const f = setup({ collab: { recall: { [scope]: false } } }); await f.consult();
    assert.equal(f.recalls.length, 0, scope); assert.equal(f.seen[0]!.memory, '', scope);
    assert.ok(f.logs.some(l => l.fields?.reason === 'scope-not-enforceable'), 'the refusal is logged with its reason');
  }
});

test('capture stores the exchange once, as the asked agent, for the asking person, with origin collab and the asking agent', async () => {
  const f = setup();
  await f.consult();
  await f.idle();
  assert.equal(f.captures.length, 1);
  const c = f.captures[0]!;
  assert.equal(c.agentId, 'callee'); assert.equal(c.user, deriveUserPrincipal('christian'));
  assert.equal(c.sessionKey, 'session:sess-1');
  assert.equal(c.runId, f.seen.at(-1)!.turnId, 'the card\'s source turn is the turn the provider ran');
  assert.deepEqual(c.messages.map(m => m.role), ['user', 'assistant']);
  assert.match(c.messages[0]!.content, /collab/); assert.match(c.messages[0]!.content, /asker/); assert.match(c.messages[0]!.content, /Which sort should I use\?/);
  assert.equal(c.messages[1]!.content, 'Use a stable sort.');
  const done = f.logs.find(l => l.msg === 'session capture done');
  assert.equal(done?.fields.origin, 'collab'); assert.equal(done?.fields.fromAgent, 'asker'); assert.equal(done?.fields.traceId, 'trace-1'); assert.equal(done?.fields.spanId, 'span-1');
});

test('capture off: recall still runs, nothing is captured', async () => {
  const f = setup({ collab: { capture: false } });
  await f.consult(); await f.idle();
  assert.equal(f.captures.length, 0);
  assert.match(f.seen[0]!.memory, /MARK-AP-callee/);
});

test('recall off for every scope: capture still runs', async () => {
  const f = setup({ collab: { recall: { workspace: false, user: false, agentPrivate: false } } });
  await f.consult(); await f.idle();
  assert.equal(f.recalls.length, 0); assert.equal(f.captures.length, 1);
});

test('without a known asking agent nothing is captured, and a failing recall never fails the turn', async () => {
  const f = setup();
  await f.consult(owner, {}, false); await f.idle();
  assert.equal(f.captures.length, 0);
  f.failRecall();
  const out = await f.consult();
  assert.equal(out.text, 'Use a stable sort.');
  assert.equal(f.seen.at(-1)!.memory, '');
});

// delegate_task: ack, work and the repair stream all see the recall; the engine is asked once.
async function delegateFixture(t: import('node:test').TestContext, exposure?: NonNullable<HarnessConfig['agents'][string]['memoryExposure']>) {
  const r = await rig();
  const eng = engineFixture();
  const cfg = defaults(); cfg.agents.b1 = exposure ? { memoryExposure: exposure } : {};
  const logger: any = { info() {}, warn() {} };
  const memory = engineTurnMemory({ engine: eng.engine, config: () => cfg, agents: { workspaceOf: () => tempDir('collab-exposure-ws-'), has: () => true } as any, logger, captureSignal: new AbortController().signal, isStopping: () => false });
  const exposureMemory = collabMemory({ memory, config: () => cfg, logger });
  const requests: ChatRequest[] = [];
  const provider: ChatProvider = { id: 'return-fixture', async *stream(req) {
    requests.push(req); const h = JSON.parse(req.peerResults![0]!.text).handoff;
    const prompt = req.messages.at(-1)!.text;
    if (prompt.startsWith('Acceptance check')) yield { type: 'delta', text: JSON.stringify({ schema: 'plur1bus.ack/1', inReplyTo: h.id, objective: h.objective, status: 'ok', blockingQuestions: [] }) };
    else if (prompt.startsWith('Repair your previous return')) yield { type: 'delta', text: JSON.stringify(returnFromText(h, 'repaired peer report', { tokens: 2, toolCalls: 1, durationMs: 1 })) };
    else yield { type: 'delta', text: JSON.stringify({ schema: 'plur1bus.return/1', id: 'bad-return', inReplyTo: 'wrong-reply' }) };
    yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
  } };
  const collab = createCollab({ path: ':memory:', runner: composedAgentRunner(provider, alsAgentScopePort(), tmp.make(), [], exposureMemory) });
  const project = collab.createProject(owner, { name: 'P', settings: { repeatWindowMs: 0 } });
  for (const a of ['a1', 'b1']) collab.addAgent(owner, project.id, a);
  const o: CollaborationTools = { collab, enabled: () => true, principal: () => owner, authority: { approvals: r.stores.approvals, grants: r.stores.grants, audit() {}, now: Date.now } };
  const req = turnRequest({ principal: owner.userId, approver: { person: owner.userId, surface: 1 }, projectId: project.id });
  const registry = new ToolRegistry(); for (const def of collaborationTools(o, req)) registry.register(def);
  const dispatcher = new ToolDispatcher({ registry, approvals: { async request() { throw new Error('unexpected approval'); } }, grants: { list: () => [], get: () => undefined }, clock: { now: Date.now } });
  const call = (name: string, args: object = {}) => dispatcher.call({ id: `call_${Math.random()}`, name, args: { projectId: project.id, ...args } }, { agentId: 'a1', principal: owner.userId, sessionId: req.sessionId, turnId: req.turnId!, surface: 1, signal: new AbortController().signal });
  t.after(async () => { await collab.shutdown(); r.service.dispose(); r.stores.close(); });
  return { call, requests, idle: () => exposureMemory.idle(), ...eng };
}

test('delegate_task: ack, work and the return-repair stream all carry the recall; the engine is asked once', async t => {
  const f = await delegateFixture(t);
  const result = await f.call('delegate_task', { toAgent: 'b1', objective: 'Return a checked report' });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(f.requests.length, 3, 'ack, work, repair');
  for (const req of f.requests) {
    assert.equal(req.agentId, 'b1');
    for (const marker of ['MARK-AP-b1', 'MARK-WS-b1', 'MARK-USER-CHRISTIAN']) assert.match(req.memory, new RegExp(marker));
  }
  assert.equal(f.recalls.length, 1);
  assert.match(f.recalls[0]!.query, /Return a checked report/);
  assert.equal(f.requests[2]!.sessionId, f.requests[1]!.sessionId);
  assert.deepEqual(f.requests[2]!.toolView, []);
});

test('delegate_task: capture records the asking agent a1 and the return summary; switches apply as for consult', async t => {
  const f = await delegateFixture(t);
  await f.call('delegate_task', { toAgent: 'b1', objective: 'Return a checked report' });
  await f.idle();
  assert.equal(f.captures.length, 1);
  const c = f.captures[0]!;
  assert.equal(c.agentId, 'b1'); assert.match(c.messages[0]!.content, /a1/); assert.match(c.messages[0]!.content, /Return a checked report/);
  assert.match(c.messages[1]!.content, /repaired peer report/);
});

test('delegate_task: capture off and a workspace switch that is off', async t => {
  const noCapture = await delegateFixture(t, { collab: { capture: false } });
  await noCapture.call('delegate_task', { toAgent: 'b1', objective: 'Return a checked report' }); await noCapture.idle();
  assert.equal(noCapture.captures.length, 0); assert.match(noCapture.requests[1]!.memory, /MARK-AP-b1/);
  const noWorkspace = await delegateFixture(t, { collab: { recall: { workspace: false } } });
  await noWorkspace.call('delegate_task', { toAgent: 'b1', objective: 'Return a checked report' });
  assert.equal(noWorkspace.recalls.length, 0);
  for (const req of noWorkspace.requests) assert.equal(req.memory, '');
});
