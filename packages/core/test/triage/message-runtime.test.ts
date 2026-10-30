import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MessageTriage } from '../../src/triage/runtime.ts';
import { triage, loadClassProfiles, type TriageDecision } from '../../src/triage/index.ts';
import { evaluateMessages, type MessageEvalCase } from '../../src/triage/message-eval.ts';
import { collect, turnFixture, scriptedAdapter, turnRequest, useTempDirs, readTool } from '../composition/helpers.ts';
import { createSessionRoleProvider } from '../../src/session/role-routing.ts';
import { createTurnProvider } from '../../src/composition/provider.ts';
const dirs = useTempDirs('d105-');
const signal = () => new AbortController().signal;
const message = 'Review security architecture';
const decision = (): TriageDecision => triage(message);
test('one decision per message; task class and effort remain fixed until an explicit boundary', async () => {
  const runtime = new MessageTriage(); let calls = 0;
  const classify = async () => { calls++; return decision(); };
  const first = await runtime.decide(message, 'A', async () => { const d = decision(); d.tasks[0]!.modelClass = { small: 1, medium: 0, large: 0, frontier: 0 }; return d; }, { signal: signal(), task: { id: 'task1', atBoundary: true } }); assert.equal(first.modelClass, 'small');
  const middle = await runtime.decide(message, 'A', classify, { signal: signal(), task: { id: 'task1', atBoundary: false } }); assert.equal(middle.modelClass, 'small');
  const next = await runtime.decide(message, 'A', classify, { signal: signal(), task: { id: 'task2', atBoundary: true } }); assert.equal(next.modelClass, 'large'); assert.equal(calls, 2);
});
test('timeout and malformed decisions fall back to rule triage; turn cancellation still aborts', async () => {
  const runtime = new MessageTriage(); let fallback = 0;
  const result = await runtime.decide(message, 'A', () => new Promise(() => {}), { signal: signal(), timeoutMs: 5, onFallback: () => fallback++ }); assert(result.fallback && !result.coreOnly); assert.equal(fallback, 1);
  assert.deepEqual(result.decision, decision()); assert.equal(result.modelClass, 'large'); assert.equal(result.effort, 'high');
  const malformed = await runtime.decide(message, 'A', async () => ({ schema: 'bad' }) as never, { signal: signal() });
  assert(malformed.fallback && !malformed.coreOnly); assert.deepEqual(malformed.decision, decision());
  const controller = new AbortController(); controller.abort(); await assert.rejects(runtime.decide(message, 'A', async () => decision(), { signal: controller.signal }));
});
test('a chat decision keeps core capabilities available and rule fallback preserves task boundaries', async () => {
  const runtime = new MessageTriage();
  const chat = await runtime.decide('Hello!', 'chat', async () => triage('Hello!'), { signal: signal() });
  assert.equal(chat.coreOnly, false); assert.equal(chat.decision.shape, 'chat'); assert.equal(chat.fallback, false);
  const first = await runtime.decide(message, 'task', async () => { const d = decision(); d.tasks[0]!.modelClass = { small: 1, medium: 0, large: 0, frontier: 0 }; d.tasks[0]!.effort = 'low'; return d; }, { signal: signal(), task: { id: 'one', atBoundary: true } });
  assert.equal(first.modelClass, 'small');
  const fallback = await runtime.decide(message, 'task', async () => { throw Error('offline'); }, { signal: signal(), task: { id: 'one', atBoundary: false } });
  assert.equal(fallback.modelClass, 'small'); assert.equal(fallback.effort, 'low'); assert.equal(fallback.coreOnly, false);
});
test('provider fallback preserves admitted tools and the agent default when the class profile is unavailable', async () => {
  const wire = scriptedAdapter([{ text: 'answer' }]); const home = dirs.make();
  const f = turnFixture(wire.adapter, { requireTriage: true, classifyMessage: async () => { throw Error('offline'); }, profileForClass: () => 'forbidden', profileForAgent: () => 'default' }, home);
  f.registry.register(readTool('private.tool', async () => 'secret'));
  try { await collect(f.provider); assert.deepEqual(wire.requests[0]!.tools!.map(tool => tool.name), ['private_tool']); assert(f.logs.some(r => r.stage === 'triage-fallback')); } finally { f.close(); }
});
test('class profiles reload at task boundaries without switching an active task', async () => {
  const home = dirs.make(), path = join(home, 'classes.json'); writeFileSync(path, JSON.stringify({ large: 'large' }));
  const a = scriptedAdapter([{ text: 'A' }]), b = scriptedAdapter([{ text: 'B' }]);
  const f = turnFixture(a.adapter, { requireTriage: true, classifyMessage: async () => decision(), profileForClass: c => loadClassProfiles(path)[c as 'large'], profiles: { default: [{ provider: 'fixture', model: 'gpt-4.1', adapter: a.adapter }], large: [{ provider: 'fixture', model: 'gpt-4.1', adapter: a.adapter }], other: [{ provider: 'fixture', model: 'gpt-4.1-mini', adapter: b.adapter }] } }, home);
  try {
    await collect(f.provider, turnRequest({ messages: [{ role: 'user', text: message }], taskBoundary: { id: 'one', atBoundary: true } })); writeFileSync(path, JSON.stringify({ large: 'other' }));
    await collect(f.provider, turnRequest({ messages: [{ role: 'user', text: message }], taskBoundary: { id: 'one', atBoundary: false } })); assert.equal(a.requests.length, 2); assert.equal(b.requests.length, 0);
    await collect(f.provider, turnRequest({ messages: [{ role: 'user', text: message }], taskBoundary: { id: 'two', atBoundary: true } })); assert.equal(b.requests.length, 1);
  } finally { f.close(); }
});
test('recorded baseline reaches independent 60+ message gold gates; wrong classifier fails', async () => {
  const rows = JSON.parse(readFileSync(new URL('../fixtures/triage-message/gold.json', import.meta.url), 'utf8')) as MessageEvalCase[];
  const replay = JSON.parse(readFileSync(new URL('../fixtures/triage-message/recordings.json', import.meta.url), 'utf8')) as { decisions: Record<string, TriageDecision> };
  assert(new Set(rows.map(r => r.message)).size >= 60);
  const good = await evaluateMessages(rows, async row => replay.decisions[row.id]!); assert(good.passed, JSON.stringify(good));
  const bad = await evaluateMessages(rows, async () => ({ schema: 'plur1bus.triage/1', shape: 'chat', tasks: [] })); assert(!bad.passed); assert.equal(bad.underProvisioning, 1);
});
test('live decision evaluation is opt-in and requires a separately supplied model port', { skip: process.env.PLUR1BUS_LIVE_TRIAGE_EVAL !== '1' }, async () => {
  const modulePath = process.env.PLUR1BUS_TRIAGE_CLASSIFIER_MODULE; assert(modulePath, 'explicit classifier module required');
  const { classify } = await import(modulePath); const rows = JSON.parse(readFileSync(new URL('../fixtures/triage-message/gold.json', import.meta.url), 'utf8')) as MessageEvalCase[];
  const report = await evaluateMessages(rows, row => classify(row.message)); assert(report.passed, JSON.stringify(report));
});
test('configured decision role invokes router once per message with no tools and keeps budget accounting', async () => {
  const home = dirs.make(); const mainWire = scriptedAdapter([{ text: 'answer' }]); const decisionWire = scriptedAdapter([{ text: JSON.stringify(decision()) }]);
  const f = turnFixture(mainWire.adapter, {}, home);
  const profiles = { default: [{ provider: 'fixture', model: 'gpt-4.1', adapter: mainWire.adapter }], cheap: [{ provider: 'fixture', model: 'gpt-4.1-mini', adapter: decisionWire.adapter }] };
  const provider = createSessionRoleProvider(createTurnProvider, { registry: f.registry, budget: f.budget, profiles, requireTriage: true, profileForClass: () => 'default', approval: { request: async () => ({ approved: false }) }, grants: { list: () => [], get: () => undefined }, log: () => {}, resultStore: { put: async () => 'ref' } }, { decision: 'cheap' }, 100);
  try {
    provider.contextModels?.(message); assert.equal(decisionWire.requests.length, 0);
    const output = await collect(provider, turnRequest({ messages: [{ role: 'user', text: message }] }));
    assert.equal(decisionWire.requests.length, 1); assert.deepEqual(decisionWire.requests[0]!.tools, []); assert.equal(mainWire.requests.length, 1);
    const usage = output.find(c => c.type === 'usage'); assert.equal(usage?.type === 'usage' && usage.measurements?.length, 2);
  } finally { f.close(); }
});
