import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, restartClassOf, validate } from '@plur1bus/config-schema';
import { channelBehaviour, BehaviourRateGate, permitsEngineMemory, permitsTool } from '../../src/channels/behaviour-context.ts';
import { resolveBehaviour, channelMessageAllowed } from '../../src/channels/behaviour.ts';
import { channelBehaviourView } from '../../src/rpc/channel-surface.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { ToolDispatcher } from '../../src/tools/dispatcher.ts';
import { engineTurnMemory } from '../../src/session/memory-port.ts';

test('schema accepts sparse profiles, refuses unknown fields and negative budgets; leaves retain live class', () => {
  const cfg = defaults(); cfg.agents.main = { behaviour: { default: { tools: { deny: ['exec'] } }, byChannelKind: { matrix: { memory: { allowedScopes: [] } } } } };
  assert.equal(validate(cfg).ok, true);
  assert.equal(restartClassOf('agents.main.behaviour.byChannelKind.matrix.memory.allowedScopes'), 'live');
  assert.equal(validate({ ...cfg, agents: { main: { behaviour: { fifth: {} } } } }).ok, false);
  assert.equal(validate({ ...cfg, agents: { main: { behaviour: { default: { rateLimits: { repliesPerHour: -1 } } } } } }).ok, false);
});

test('the inspection projection and host resolver compute the same policy without exposing other editable levels', () => {
  const cfg = defaults(); cfg.agents.main = { behaviour: { default: { tools: { deny: ['exec'] } }, byChannelKind: { matrix: { commands: { deny: ['new'] } } } } };
  const view = channelBehaviourView(cfg, 'matrix')!;
  assert.equal(view.editableKey, 'agents.main.behaviour.byChannelKind.matrix');
  assert.deepEqual(view.layer, cfg.agents.main.behaviour!.byChannelKind!.matrix);
  assert.deepEqual(view.group, resolveBehaviour(cfg.agents.main.behaviour!, { channel: 'matrix', chatKind: 'group' }));
  cfg.agents.second = {}; delete cfg.agents.main;
  cfg.agents.third = {}; assert.equal(channelBehaviourView(cfg, 'matrix'), null);
});

test('all adapters use a host policy that overrides legacy always; local commands cannot escape it', () => {
  for (const channel of ['telegram', 'discord', 'matrix', 'slack', 'signal', 'email']) {
    const host = { behaviour: () => resolveBehaviour({ default: { commands: { deny: ['link'] } } }, { channel, chatKind: 'group' }) };
    assert.equal(channelMessageAllowed(host, { channel, chatKind: 'group', addressed: false, text: 'hi' }, 'always'), false);
    assert.equal(channelMessageAllowed(host, { channel, chatKind: 'group', addressed: true, text: '/link code' }, 'always'), false);
    assert.equal(channelMessageAllowed(host, { channel, chatKind: 'group', addressed: true, text: 'hi' }, 'always'), true);
  }
});

test('concurrent turns retain isolated restrictions; dispatcher refuses even with permissive grants', async () => {
  let calls = 0;
  const registry = new ToolRegistry();
  registry.register({ name: 'demo.read', description: 'read', inputSchema: { type: 'object' }, capability: 'sys.read', effect: 'read', risk: 'low', trust: 'first-party', execute: async () => { calls++; return 'ok'; } });
  const dispatcher = new ToolDispatcher({ registry, clock: { now: () => 0 }, approvals: { request: async () => ({ approved: true }) }, grants: { list: () => [], get: () => undefined } });
  const restricted = resolveBehaviour({ default: { tools: { deny: ['demo.*'] } } }, { channel: 'matrix', chatKind: 'direct' }).profile;
  const open = resolveBehaviour({}, { channel: 'telegram', chatKind: 'direct' }).profile;
  const run = (profile: typeof open) => channelBehaviour.run(profile, async () => {
    await Promise.resolve();
    const described = dispatcher.describe();
    const result = await dispatcher.call({ id: 'one', name: 'demo.read', args: {} }, { agentId: 'main', principal: 'person', surface: 3, signal: new AbortController().signal });
    return { described, result };
  });
  const [a, b] = await Promise.all([run(restricted), run(open)]);
  assert.equal(a.described.length, 0); assert.equal(a.result.isError, true);
  assert.equal(b.described.length, 1); assert.equal(b.result.isError, false); assert.equal(calls, 1);
  assert.equal(permitsTool('demo.read', 'sys.read'), true);
});

test('scope restrictions fail closed on the pinned engine; provenance capture records no message text', async () => {
  let engineCalls = 0; const logs: unknown[] = [];
  const memory = engineTurnMemory({ engine: { recall: () => { engineCalls++; }, capture: () => { engineCalls++; } } as never, config: defaults, agents: {} as never, logger: { info: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) } as never, captureSignal: new AbortController().signal, isStopping: () => false });
  const caller = { channel: 'cli' as const, accountId: 'bot', userId: 'person' };
  await channelBehaviour.run(resolveBehaviour({}, { channel: 'matrix', chatKind: 'group' }).profile, async () => {
    assert.equal(permitsEngineMemory(), false);
    const result = await memory.recall({ agentId: 'main', caller, query: 'private body', signal: new AbortController().signal });
    assert.equal(result.degraded?.reason, 'behaviour-scope-unavailable');
    await memory.capture({ agentId: 'main', caller, sessionId: 's', turnId: 't', incognito: false, messages: [{ role: 'user', content: 'private body' }] });
  });
  assert.equal(engineCalls, 0); assert.match(JSON.stringify(logs), /channel.capture.provenance/); assert.doesNotMatch(JSON.stringify(logs), /private body/);
});

test('rate buckets refuse zero and refuse an exhausted principal until the hour ends', () => {
  const gate = new BehaviourRateGate();
  assert.equal(gate.take('a', 0, 0), false);
  assert.equal(gate.take('a', 1, 0), true);
  assert.equal(gate.take('a', 1, 1), false);
  assert.equal(gate.take('b', 1, 1), true);
  assert.equal(gate.take('a', 1, 3_600_000), true);
});

test('authoritative on-mention is never widened by a legacy allowlist', () => {
  const host = { behaviour: () => resolveBehaviour({}, { channel: 'matrix', chatKind: 'group' }) };
  assert.equal(channelMessageAllowed(host, { channel: 'matrix', chatKind: 'group', text: 'hi', addressed: false }, 'allowlist', true), false);
});

test.todo('KNOWN-GAP: engine per-request allowedScopes and searchable provenance-only capture are absent on pin 6868b7b1; restrictive profiles suppress engine memory calls');
