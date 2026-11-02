/** Production runner/service/dispatcher lifetimes with deterministic task timers. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaults } from '@plur1bus/config-schema';
import { createCollab } from '../../src/collab/service.ts';
import { providerRunner } from '../../src/collab/runner.ts';
import { composedAgentRunner } from '../../src/composition/collaboration.ts';
import { alsAgentScopePort } from '../../src/collab/scope.ts';
import { SessionStore } from '../../src/session/store.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { ToolDispatcher } from '../../src/tools/dispatcher.ts';
import { collaborationTools } from '../../src/tools/collaboration.ts';
import type { ChatProvider, ChatRequest } from '../../src/session/provider.ts';
import { owner } from './helpers.ts';
import { scriptedAdapter, turnFixture, useTempDirs } from '../composition/helpers.ts';

const tmp = useTempDirs('tm1-progress-');
class Time {
  now = Date.now();
  entries = new Set<{ at: number; callback(): void }>();
  timers = { set: (callback: () => void, ms: number) => { const entry = { at: this.now + ms, callback }; this.entries.add(entry); return () => this.entries.delete(entry); } };
  advance(ms: number) { this.now += ms; for (const entry of [...this.entries]) if (entry.at <= this.now && this.entries.delete(entry)) entry.callback(); }
}

for (const composed of [false, true]) test(`${composed ? 'composed' : 'provider'} runner: text-free tool rounds reset the actual service stall timer`, async () => {
  const time = new Time(), limits = defaults().collaboration.limits;
  const stall = limits.taskClasses.consult.stallTimeMs;
  const provider: ChatProvider = { id: 'tool-progress', async *stream() {
    for (let i = 0; i < 3; i++) {
      yield { type: 'tool.call', id: `${i}`, name: 'file.read', args: {} };
      time.advance(stall - 1);
      yield { type: 'tool.result', id: `${i}`, output: 'read' };
      time.advance(stall - 1);
    }
    yield { type: 'delta', text: 'complete' };
  } };
  // Task wall time is longer than the six progress intervals.
  limits.taskClasses.consult.wallTimeMs = stall * 10;
  const scope = alsAgentScopePort();
  const collab = createCollab({ path: ':memory:', clock: () => time.now, timers: time.timers, limits: () => limits, runner: composed ? composedAgentRunner(provider, scope, tmp.make()) : providerRunner(provider, scope) });
  tmp.onCleanup(() => collab.shutdown());
  const project = collab.createProject(owner(), { name: 'Progress' });
  for (const a of ['lead', 'peer']) collab.addAgent(owner(), project.id, a);
  const out = await collab.consult({ principal: owner(), projectId: project.id, fromAgent: 'lead', toAgent: 'peer', question: 'inspect', context: '' });
  assert.equal(out.status, 'done'); assert.equal(out.text, 'complete'); assert.equal(time.entries.size, 0);
});

for (const composed of [false, true]) test(`${composed ? 'composed' : 'provider'} runner: private reasoning progress from the real provider prevents a stall`, async () => {
  const time = new Time(), limits = defaults().collaboration.limits;
  const stall = limits.taskClasses.consult.stallTimeMs;
  limits.taskClasses.consult.wallTimeMs = stall * 10;
  const script = scriptedAdapter([{ text: 'complete' }]);
  const provider = turnFixture({ async *stream(...args) {
    for (let i = 0; i < 4; i++) { yield { type: 'reasoning_delta', text: 'PRIVATE_REASONING' }; time.advance(stall - 1); }
    yield* script.adapter.stream(...args);
  } }, {}, tmp.make());
  tmp.onCleanup(provider.close);
  const scope = alsAgentScopePort();
  const sessions = new SessionStore({ path: ':memory:' }); tmp.onCleanup(() => sessions.close());
  const collab = createCollab({ path: ':memory:', clock: () => time.now, timers: time.timers, limits: () => limits, sessions: () => sessions, runner: composed ? composedAgentRunner(provider.provider, scope, tmp.make()) : providerRunner(provider.provider, scope) });
  tmp.onCleanup(() => collab.shutdown());
  const project = collab.createProject(owner(), { name: 'Reasoning' });
  for (const a of ['lead', 'peer']) collab.addAgent(owner(), project.id, a);
  const out = await collab.consult({ principal: owner(), projectId: project.id, fromAgent: 'lead', toAgent: 'peer', question: 'think', context: '' });
  assert.equal(out.status, 'done'); assert.equal(out.text, 'complete');
  const replay = collab.replay(owner(), out.traceId, out.provenance.spanId);
  assert.ok(!JSON.stringify(replay).includes('PRIVATE_REASONING'));
});

for (const wait of [true, false]) for (const abortBehavior of ['hang', 'throw'] as const) test(`deadline through dispatcher/service/composed provider: wait=${wait}, abort=${abortBehavior}`, async () => {
  const time = new Time(), started = Promise.withResolvers<void>();
  const sessions = new SessionStore({ path: ':memory:' }); tmp.onCleanup(() => sessions.close());
  const provider: ChatProvider = { id: 'partial-work', async *stream(req) {
    if (req.messages[0]?.text.startsWith('Acceptance check')) {
      const h = JSON.parse(req.peerResults![0]!.text).handoff;
      yield { type: 'delta', text: JSON.stringify({ schema: 'plur1bus.ack/1', inReplyTo: h.id, objective: h.objective, status: 'ok', blockingQuestions: [] }) }; return;
    }
    yield { type: 'delta', text: 'first file inspected' };
    started.resolve();
    if (abortBehavior === 'hang') await new Promise(() => {});
    else { await new Promise<void>(resolve => req.signal.addEventListener('abort', () => resolve(), { once: true })); req.signal.throwIfAborted(); }
  } };
  const limits = defaults().collaboration.limits;
  limits.taskClasses['code-large'].stallTimeMs = limits.taskClasses['code-large'].wallTimeMs;
  const collab = createCollab({ path: ':memory:', clock: () => time.now, timers: time.timers, limits: () => limits, sessions: () => sessions, runner: composedAgentRunner(provider, alsAgentScopePort(), tmp.make()) });
  tmp.onCleanup(() => collab.shutdown());
  const project = collab.createProject(owner(), { name: 'Deadline' });
  for (const a of ['lead', 'peer']) collab.addAgent(owner(), project.id, a);
  const request: ChatRequest = { sessionId: 'root', turnId: 'turn', agentId: 'lead', projectId: project.id, summaries: [], memory: '', messages: [], signal: new AbortController().signal };
  const registry = new ToolRegistry();
  for (const tool of collaborationTools({ collab, enabled: () => true, principal: () => owner(), authority: { approvals: { get: () => undefined }, grants: { get: () => undefined }, audit() {}, now: () => time.now } }, request)) registry.register(tool);
  const dispatcher = new ToolDispatcher({ registry, timers: time.timers, clock: { now: () => time.now }, approvals: { async request() { throw new Error('unexpected approval'); } }, grants: { get: () => undefined, list: () => [] } });
  const call = dispatcher.call({ id: 'launch', name: 'delegate_task', args: { projectId: project.id, toAgent: 'peer', objective: 'inspect', taskClass: 'code-large', wait } }, { agentId: 'lead', principal: owner().userId, sessionId: 'root', turnId: 'turn', surface: 1, signal: request.signal });
  await started.promise;
  const trace = collab.listTraces(owner(), project.id)[0]!;
  const before = collab.replay(owner(), trace.traceId, trace.spans[0]!.spanId);
  const contract = before.events.find(e => e.data.handoff)!.data.handoff as { budget: { deadline: string } };
  const expectedLifetime = wait ? 299_000 : 7_200_000;
  assert.equal(Date.parse(contract.budget.deadline) - time.now, expectedLifetime);
  time.advance(expectedLifetime - 1);
  assert.equal(collab.getTrace(owner(), trace.traceId).spans[0]!.status, 'running');
  time.advance(1);
  const delivery = await call;
  assert.equal(delivery.isError, false, JSON.stringify(delivery));
  const joined = await request.delegations!.finish();
  if (wait) {
    assert.match(JSON.stringify(delivery), /first file inspected/);
    assert.match(JSON.stringify(delivery), /partial/);
    assert.deepEqual(joined, [], 'the blocking result must not be delivered twice');
  } else {
    assert.equal(joined.length, 1);
    assert.equal(joined[0]!.result!.status, 'partial');
    assert.match(joined[0]!.result!.summary, /first file inspected/);
  }
  assert.deepEqual(await request.delegations!.finish(), [], 'joining again never repeats a result');
  const replay = collab.replay(owner(), trace.traceId, trace.spans[0]!.spanId);
  assert.equal(replay.events.filter(e => e.type === 'tool.result' && e.data.status === 'partial').length, 1);
  assert.equal(replay.events.filter(e => e.type === 'turn.failed').length, 1);
  assert.match(JSON.stringify(replay.events.find(e => e.data.status === 'partial')), /first file inspected/);
  assert.equal(time.entries.size, 0);
});

test('composed acknowledgement and return repair text each keep the task alive without replacing work progress', async () => {
  const time = new Time(), limits = defaults().collaboration.limits;
  limits.taskClasses['code-small'] = { rounds: 100, wallTimeMs: 10000, stallTimeMs: 1000 };
  let phase = 0;
  const provider: ChatProvider = { id: 'ack-repair', async *stream(req) {
    let text: string;
    if (phase++ === 0) {
      const h = JSON.parse(req.peerResults![0]!.text).handoff;
      text = JSON.stringify({ schema: 'plur1bus.ack/1', inReplyTo: h.id, objective: h.objective, status: 'ok', blockingQuestions: [] });
    } else if (phase === 2) text = JSON.stringify({ schema: 'plur1bus.return/1', inReplyTo: 'wrong-binding' });
    else {
      const { returnFromText } = await import('../../src/collab/handoff.ts');
      const h = JSON.parse(req.peerResults![0]!.text).handoff;
      text = JSON.stringify(returnFromText(h, 'repaired evidence', { tokens: 1, toolCalls: 0, durationMs: 1 }));
    }
    for (let i = 0; i < text.length; i += Math.ceil(text.length / 3)) {
      yield { type: 'delta', text: text.slice(i, i + Math.ceil(text.length / 3)) };
      time.advance(600);
    }
  } };
  const collab = createCollab({ path: ':memory:', clock: () => time.now, timers: time.timers, limits: () => limits, runner: composedAgentRunner(provider, alsAgentScopePort(), tmp.make()) });
  tmp.onCleanup(() => collab.shutdown());
  const project = collab.createProject(owner(), { name: 'Ack repair' });
  for (const a of ['lead', 'peer']) collab.addAgent(owner(), project.id, a);
  const request: ChatRequest = { sessionId: 'root', turnId: 'turn', agentId: 'lead', summaries: [], memory: '', messages: [], signal: new AbortController().signal };
  const tool = collaborationTools({ collab, enabled: () => true, principal: () => owner(), authority: { approvals: { get: () => undefined }, grants: { get: () => undefined }, audit() {}, now: () => time.now } }, request).find(t => t.name === 'delegate_task')!;
  const out = await tool.execute({ projectId: project.id, toAgent: 'peer', objective: 'inspect' }, { agentId: 'lead', principal: owner().userId, signal: request.signal });
  assert.match(JSON.stringify(out), /repaired evidence/); assert.equal(phase, 3);
  assert.equal(collab.listTraces(owner(), project.id)[0]!.spans[0]!.status, 'succeeded');
});

for (const composed of [false, true]) for (const wait of [true, false]) for (const stalled of [false, true]) test(`${composed ? 'composed' : 'provider'} runner: depth-two progress during ${wait ? 'blocking consult' : 'await_delegations'}, stalled=${stalled}`, async () => {
  const time = new Time(), limits = defaults().collaboration.limits;
  limits.taskClasses.consult = { rounds: 100, wallTimeMs: 10_000, stallTimeMs: 1_000 };
  let config: Parameters<typeof collaborationTools>[0], projectId: string;
  let waits = 0, childProgress = 0;
  const provider: ChatProvider = { id: 'nested-progress', async *stream(request) {
    if (request.agentId === 'parent') {
      const definitions = collaborationTools(config, request);
      const context = { agentId: 'parent', principal: owner().userId, signal: request.signal };
      yield { type: 'delta', text: 'parent evidence; ' };
      yield { type: 'tool.call', id: 'nested', name: 'consult_agent', args: {} };
      const result = await definitions.find(tool => tool.name === 'consult_agent')!.execute({ projectId, toAgent: 'child', objective: 'inspect slowly', wait }, context);
      if (!wait) {
        waits++;
        await definitions.find(tool => tool.name === 'await_delegations')!.execute({ taskIds: [(result as { taskId: string }).taskId], timeoutMs: 5000 }, context);
      }
      request.signal.throwIfAborted();
      yield { type: 'delta', text: 'parent completed with child evidence' };
    } else {
      for (let i = 0; i < 4; i++) {
        // Let the parent enter its real tool wait before advancing the service clock.
        await new Promise<void>(resolve => setImmediate(resolve));
        time.advance(900);
        request.signal.throwIfAborted();
        childProgress++;
        yield { type: 'delta', text: 'child evidence' };
      }
      if (stalled) {
        await new Promise<void>(resolve => setImmediate(resolve));
        time.advance(1_000);
        request.signal.throwIfAborted();
      }
    }
  } };
  const scope = alsAgentScopePort();
  const collab = createCollab({ path: ':memory:', clock: () => time.now, timers: time.timers, limits: () => limits, runner: composed ? composedAgentRunner(provider, scope, tmp.make()) : providerRunner(provider, scope) });
  tmp.onCleanup(() => collab.shutdown());
  projectId = collab.createProject(owner(), { name: 'Nested progress' }).id;
  for (const agent of ['lead', 'parent', 'child']) collab.addAgent(owner(), projectId, agent);
  config = { collab, enabled: () => true, principal: () => owner(), authority: { approvals: { get: () => undefined }, grants: { get: () => undefined }, audit() {}, now: () => time.now } };
  const request: ChatRequest = { sessionId: 'root', turnId: 'turn', agentId: 'lead', projectId, summaries: [], memory: '', messages: [], signal: new AbortController().signal };
  const tool = collaborationTools(config, request).find(tool => tool.name === 'consult_agent')!;
  const result = await tool.execute({ projectId, toAgent: 'parent', objective: 'inspect with a helper' }, { agentId: 'lead', principal: owner().userId, signal: request.signal });
  assert.equal((result as { result: { status: string } }).result.status, stalled ? 'partial' : 'done_with_concerns');
  assert.match(JSON.stringify(result), stalled ? /parent evidence/ : /parent completed with child evidence/);
  assert.equal(childProgress, 4);
  assert.equal(waits, wait ? 0 : 1);
  assert.deepEqual(await request.delegations!.finish(), []);
  const trace = collab.listTraces(owner(), projectId)[0]!;
  const parent = trace.spans.find(span => span.agentId === 'parent')!;
  const child = trace.spans.find(span => span.agentId === 'child')!;
  assert.equal(child.parentSpanId, parent.spanId);
  assert.deepEqual([parent.status, child.status], stalled ? ['partial', 'partial'] : ['succeeded', 'succeeded']);
  assert.equal(time.entries.size, 0);
});
