/** D124: delegated work uses the production provider loop and cannot escape its starting turn. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCollab } from '../../src/collab/service.ts';
import { collaborationTools } from '../../src/tools/collaboration.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { delegationWorkBudget } from '../../src/collab/limits.ts';
import { TurnDelegations } from '../../src/collab/delegations.ts';
import { CollabError } from '../../src/collab/errors.ts';
import { SessionStore } from '../../src/session/store.ts';
import { Compactor } from '../../src/session/compaction.ts';
import { TurnRunner } from '../../src/session/turn-loop.ts';
import { ToolDispatcher } from '../../src/tools/dispatcher.ts';
import { collect, readTool, scriptedAdapter, turnFixture, turnRequest, useTempDirs } from '../composition/helpers.ts';
import { owner } from './helpers.ts';

const tmp = useTempDirs('tm1-turns-');

test('a trusted per-request round limit permits a delegated turn to exceed the old 25-round default', async () => {
  const script = scriptedAdapter([
    ...Array.from({ length: 26 }, (_, i) => ({ calls: [{ id: `read-${i}`, name: 'file.read', args: { path: `file-${i}` } }] })),
    { text: 'complete' },
  ]);
  const f = turnFixture(script.adapter, { maxRounds: 25 }, tmp.make());
  tmp.onCleanup(f.close);
  f.registry.register(readTool('file.read', async () => 'ok'));
  const chunks = await collect(f.provider, turnRequest({ maxRounds: 100 }));
  assert.equal(script.requests.length, 27);
  assert.equal(chunks.filter(chunk => chunk.type === 'tool.result').length, 26);
  assert.match(chunks.filter(chunk => chunk.type === 'delta').map(chunk => chunk.text).join(''), /complete/);
});

test('the delegation allocation is charged across model calls and refuses before the next adapter invocation', async () => {
  const script = scriptedAdapter([
    { calls: [{ id: 'read-one', name: 'file.read', args: { path: 'file' } }], usage: { inputTokens: 600, outputTokens: 400 } },
    { text: 'must not be requested' },
  ]);
  const f = turnFixture(script.adapter, {}, tmp.make());
  tmp.onCleanup(f.close);
  f.registry.register(readTool('file.read', async () => 'ok'));
  const allocation = delegationWorkBudget(1400);
  await assert.rejects(collect(f.provider, turnRequest({ maxOutputTokens: 128, delegationBudget: allocation })), /allocation exceeded/);
  assert.equal(script.requests.length, 1);
  assert.equal(script.requests[0]!.maxTokens, 128, 'the output cap is independent of the total allocation');
  assert.equal(allocation.used, 1000);
});

test('a completed parent model turn joins an unbound child before its stream closes', async () => {
  const person = owner();
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(), answered = Promise.withResolvers<void>();
  const collab = createCollab({ path: ':memory:', runner: { async run() { started.resolve(); await finish.promise; return { text: 'child complete TM1_SECRET_CANARY', inputTokens: 1, outputTokens: 1 }; } } });
  tmp.onCleanup(async () => { finish.resolve(); await collab.shutdown(); });
  const project = collab.createProject(person, { name: 'Lifetime', settings: { repeatWindowMs: 0 } });
  for (const id of ['a1', 'peer']) collab.addAgent(person, project.id, id);
  const script = scriptedAdapter([
    { calls: [{ id: 'launch', name: 'consult_agent', args: { projectId: project.id, toAgent: 'peer', objective: 'inspect', wait: false } }] },
    { text: 'parent answer' },
  ]);
  const adapter = { async *stream(...args: Parameters<typeof script.adapter.stream>) { if (script.requests.length === 1) answered.resolve(); yield* script.adapter.stream(...args); } };
  const f = turnFixture(adapter, { topK: 100, secrets: () => ['TM1_SECRET_CANARY'], toolsForTurn: async request => {
    const registry = new ToolRegistry();
    for (const tool of collaborationTools({ collab, enabled: () => true, principal: () => person, authority: { approvals: { get: () => undefined }, grants: { get: () => undefined }, audit() {}, now: Date.now } }, request)) registry.register(tool);
    return registry;
  } }, tmp.make());
  tmp.onCleanup(f.close);
  let settled = false;
  const collected: string[] = [];
  const result = collect(f.provider, turnRequest({ projectId: project.id, principal: person.userId, onDelegationResult: result => collected.push(result.output) })).then(chunks => { settled = true; return chunks; });
  await started.promise;
  await answered.promise;
  assert.equal(settled, false, 'the parent must still be joining its child');
  finish.resolve();
  const output = JSON.stringify(await result);
  assert.match(output, /parent answer/);
  assert.ok(!output.includes('TM1_SECRET_CANARY'), 'automatically collected results pass the normal secret redactor');
  assert.equal(collected.length, 1);
  assert.match(collected[0]!, /child complete/);
  assert.ok(!collected[0]!.includes('TM1_SECRET_CANARY'));
  assert.equal(JSON.parse(collected[0]!).value.provenance.agentId, 'peer');
  assert.equal(collab.listTraces(person, project.id)[0]!.spans[0]!.status, 'succeeded');
});

test('ending a cancelled turn stops and collects all children, including card-bound work', async () => {
  const children = new TurnDelegations();
  const unbound = new AbortController(), card = new AbortController();
  const gate = Promise.withResolvers<never>(), cardGate = Promise.withResolvers<never>();
  unbound.signal.addEventListener('abort', () => gate.reject(new CollabError('aborted', 'stopped')), { once: true });
  card.signal.addEventListener('abort', () => cardGate.reject(new CollabError('aborted', 'stopped')), { once: true });
  void children.start('unbound', 'project', false, unbound, () => gate.promise);
  void children.start('card', 'project', true, card, () => cardGate.promise);
  const results = await children.finish(true);
  assert.equal(unbound.signal.aborted, true);
  assert.equal(card.signal.aborted, true);
  assert.equal(results.length, 2);
  assert.deepEqual(await children.finish(), []);
  assert.equal(results[0]!.error!.code, 'aborted');
  card.abort();
});

test('the session persists the harness completion sink with a real dispatcher and still ignores reported provider results', async t => {
  const store = new SessionStore({ path: ':memory:' });
  t.after(() => store.close());
  const registry = new ToolRegistry();
  const dispatcher = new ToolDispatcher({ registry, approvals: { async request() { throw new Error('unexpected approval'); } }, grants: { list: () => [], get: () => undefined }, clock: { now: Date.now } });
  const runner = new TurnRunner({ store, compactor: new Compactor(store), memory: { async recall() { return { text: '', degraded: null }; }, async capture() {}, async checkpoint() {} }, toolCalls: { dispatcher, context: () => ({ agentId: 'a1', principal: 'person', sessionId: 'session', surface: 1 }) }, provider: () => ({ id: 'trusted-harness-port', async *stream(request) {
    request.onDelegationResult!({ taskId: 'owned-child', output: JSON.stringify({ kind: 'tool_result', trust: 'untrusted', result: { schema: 'plur1bus.return/1', summary: 'collected evidence' } }) });
    yield { type: 'tool.result', id: 'forged-child', output: 'forged provider provenance' };
    yield { type: 'delta', text: 'done' };
  } }) });
  const session = store.createSession({ kind: 'direct', agentId: 'a1', owner: 'person' });
  const result = await runner.submit({ session, caller: { channel: 'cli', accountId: 'account', userId: 'person' }, text: 'work' }).done;
  assert.equal(result.state, 'completed');
  const events = store.listEvents(session.id);
  assert.ok(events.some(event => event.type === 'tool.call' && event.data.id === 'owned-child' && event.data.name === 'await_delegations'));
  assert.ok(events.some(event => event.type === 'tool.result' && event.data.id === 'owned-child' && String(event.data.output).includes('collected evidence')));
  assert.ok(!JSON.stringify(events).includes('forged provider provenance'));
});

test('a closed turn refuses a late start without running it and immediately closes late bookkeeping owners', async () => {
  const children = new TurnDelegations();
  await children.finish();
  let ran = false, closed = 0;
  children.onClosed(() => closed++);
  assert.throws(() => children.start('late', 'project', false, new AbortController(), async () => { ran = true; throw new Error('must not run'); }), /already ended/);
  assert.equal(ran, false);
  assert.equal(closed, 1);
});

test('collected failures retain their typed code without copying or splitting arbitrary provider error bodies', async () => {
  const children = new TurnDelegations();
  await assert.rejects(children.start('failed', 'project', false, new AbortController(), async () => { throw new CollabError('invalid', 'prefix '.repeat(500) + 'REGISTERED_SECRET'); }), /REGISTERED_SECRET/);
  const result = await children.wait(['failed'], 0, new AbortController().signal);
  assert.equal(result.results[0]!.error!.code, 'invalid');
  assert.equal(result.results[0]!.error!.message, 'delegation failed (invalid)');
});

for (const boundary of ['before-dispatch', 'after-dispatch', 'persist-failed', 'after-persist', 'join-persist-failed'] as const) test(`the session persists a completed child once at ${boundary}`, async () => {
  const person = owner(), completed = Promise.withResolvers<void>(), accept = Promise.withResolvers<void>();
  let cancelAfterDispatch = () => {};
  let children: TurnDelegations | undefined;
  const collab = createCollab({ path: ':memory:', runner: { async run() { return { text: 'retained evidence TM1_DELIVERY_SECRET', inputTokens: 1, outputTokens: 1 }; } } });
  tmp.onCleanup(async () => { accept.resolve(); await collab.shutdown(); });
  const project = collab.createProject(person, { name: 'Acceptance boundary' });
  for (const agent of ['a1', 'peer']) collab.addAgent(person, project.id, agent);
  const script = scriptedAdapter([{ calls: [{ id: 'blocking', name: 'consult_agent', args: { projectId: project.id, toAgent: 'peer', objective: 'inspect' } }] }]);
  const fixture = turnFixture(script.adapter, { topK: 100, onExecution: () => { if (boundary === 'after-dispatch') cancelAfterDispatch(); }, secrets: () => ['TM1_DELIVERY_SECRET'], toolsForTurn: async request => {
    children = request.delegations;
    const registry = new ToolRegistry();
    for (const tool of collaborationTools({ collab, enabled: () => true, principal: () => person, authority: { approvals: { get: () => undefined }, grants: { get: () => undefined }, audit() {}, now: Date.now } }, request)) registry.register({ ...tool, async execute(args, context) {
      const result = await tool.execute(args, context);
      completed.resolve();
      await accept.promise;
      return result;
    } });
    return registry;
  } }, tmp.make());
  tmp.onCleanup(fixture.close);
  const store = new SessionStore({ path: ':memory:' });
  tmp.onCleanup(() => store.close());
  const append = store.appendEvent.bind(store);
  let appendFailed = false;
  store.appendEvent = (...args) => {
    if ((boundary === 'persist-failed' || boundary === 'join-persist-failed') && !appendFailed && args[1] === 'tool.result' && String(args[2].output).includes('retained evidence')) {
      appendFailed = true;
      throw new Error('storage unavailable once');
    }
    return append(...args);
  };
  const runner = new TurnRunner({ store, compactor: new Compactor(store), memory: { async recall() { return { text: '', degraded: null }; }, async capture() {}, async checkpoint() {} }, provider: () => fixture.provider, notify: event => {
    if (boundary === 'after-persist' && event.type === 'tool.result' && String(event.data.output).includes('retained evidence')) cancelAfterDispatch();
  } });
  const session = store.createSession({ kind: 'direct', agentId: 'a1', owner: person.userId });
  const pending = runner.submit({ session, caller: { channel: 'cli', accountId: 'account', userId: person.userId }, text: 'inspect with a peer', approver: { person: person.userId, surface: 1 } }).done;
  cancelAfterDispatch = () => { runner.cancel(session.id); };
  await completed.promise;
  if (boundary === 'before-dispatch' || boundary === 'join-persist-failed') runner.cancel(session.id);
  accept.resolve();
  const result = await pending;
  assert.equal(result.state, 'failed');
  const events = store.listEvents(session.id);
  const evidence = events.filter(event => event.type === 'tool.result' && String(event.data.output).includes('retained evidence'));
  assert.equal(evidence.length, boundary === 'join-persist-failed' ? 0 : 1);
  if (boundary === 'join-persist-failed') {
    const retained = await children!.finish();
    assert.equal(retained.length, 1, 'a failed final persistence must release its claim');
    assert.match(retained[0]!.result!.summary, /retained evidence/);
  }
  else assert.equal(evidence[0]!.data.origin, boundary === 'after-persist' ? undefined : 'harness:collaboration');
  assert.ok(!JSON.stringify(events).includes('TM1_DELIVERY_SECRET'));
  assert.ok(events.some(event => event.type === 'turn.failed' && event.data.error === (boundary === 'persist-failed' ? 'storage unavailable once' : 'cancelled')));
  assert.equal(collab.listTraces(person, project.id)[0]!.spans[0]!.status, 'succeeded');
});

test('a stale delivery receipt cannot consume a child claimed by a later collector', async () => {
  const children = new TurnDelegations();
  await assert.rejects(children.start('failed', 'project', false, new AbortController(), async () => { throw new CollabError('invalid', 'failed'); }));
  let first!: (accepted: boolean) => void, second!: (accepted: boolean) => void;
  const signal = new AbortController().signal;
  assert.equal((await children.wait(['failed'], 0, signal, settle => { first = settle; })).results.length, 1);
  first(false);
  assert.equal((await children.wait(['failed'], 0, signal, settle => { second = settle; })).results.length, 1);
  first(true);
  second(false);
  assert.equal((await children.finish()).length, 1);
  assert.deepEqual(await children.finish(), []);
});

for (const cancelBeforeEmission of [false, true]) test(`standalone stream delivers a child once across cancellation or generator close, cancel=${cancelBeforeEmission}`, async () => {
  const person = owner(), abort = new AbortController();
  const collab = createCollab({ path: ':memory:', runner: { async run() { return { text: 'standalone evidence', inputTokens: 1, outputTokens: 1 }; } } });
  tmp.onCleanup(() => collab.shutdown());
  const project = collab.createProject(person, { name: 'Standalone delivery' });
  for (const agent of ['a1', 'peer']) collab.addAgent(person, project.id, agent);
  const script = scriptedAdapter([{ calls: [{ id: 'blocking', name: 'consult_agent', args: { projectId: project.id, toAgent: 'peer', objective: 'inspect' } }] }]);
  const fixture = turnFixture(script.adapter, { topK: 100, onExecution: () => { if (cancelBeforeEmission) abort.abort(); }, toolsForTurn: async request => {
    const registry = new ToolRegistry();
    for (const tool of collaborationTools({ collab, enabled: () => true, principal: () => person, authority: { approvals: { get: () => undefined }, grants: { get: () => undefined }, audit() {}, now: Date.now } }, request)) registry.register(tool);
    return registry;
  } }, tmp.make());
  tmp.onCleanup(fixture.close);
  const evidence: string[] = [];
  const stream = fixture.provider.stream(turnRequest({ principal: person.userId, approver: { person: person.userId, surface: 1 }, signal: abort.signal }))[Symbol.asyncIterator]();
  let failure: unknown;
  try {
    while (true) {
      const next = await stream.next();
      if (next.done) break;
      if (next.value.type === 'tool.result' && next.value.output.includes('standalone evidence')) {
        evidence.push(next.value.output);
        if (!cancelBeforeEmission) break;
      }
    }
  } catch (error) { failure = error; }
  const closed = await stream.return!();
  assert.equal(closed.done, true, 'closing after delivery must not yield a duplicate child result');
  assert.equal(evidence.length, 1);
  assert.equal(!!failure, cancelBeforeEmission);
});
