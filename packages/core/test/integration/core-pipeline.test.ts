import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '@plur1bus/config-schema';
import { createCore } from '../../src/core.ts';
import { flatTestInternals } from '../helpers/flat-embedder.ts';
import { connect } from '../helpers/connect.ts';
import { wireFixture } from './wire-fixture.ts';
import type { ProviderDefinition } from '../../src/composition/auth.ts';
import { createIdentityService } from '../../src/identity/service.ts';
import { createRecallScopeProvider } from '../../src/identity/recall.ts';
import { deriveUserPrincipal } from '../../src/identity/principals.ts';
import { engineTurnMemory } from '../../src/session/memory-port.ts';
import { createLogger } from '../../src/logger.ts';
import { createAgentRegistry } from '../../src/agents.ts';
import { layout } from '../../src/paths.ts';
import type { Engine, RecallResult } from '@cyb3rb1ade/plur1bus-memory/types/engine.js';

const caller = { channel: 'cli' as const, accountId: 'fixture-host', userId: 'fixture-user' };
export const definition = (wire: ProviderDefinition['wireFormat'], model: string): ProviderDefinition => ({ wireFormat: wire, defaultModel: model, entries: [], profile: { id: 'fixture', display_name: 'Fixture', kind: 'api_key', capabilities: ['chat'], auth_header_scheme: wire === 'anthropic_messages' || wire === 'gemini' ? 'x-api-key: {token}' : 'Authorization: Bearer {token}', base_url: 'https://fixture.invalid/v1', secret_ref: 'fixture.key', policy_status: 'allowed', policy_source: 'synthetic', policy_checked: '2026-10-08' } });
for (const wire of ['chat_completions', 'anthropic_messages', 'codex_responses', 'gemini'] as const) test(`${wire}: real Core → auth secret lease → router → real file tool → usage/audit/logs/capture`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'turn-core-')); const cfg = defaults(); cfg.agents.bernd = {}; cfg.engine.duplicateThreshold = 1.01;
  await writeFile(join(home, 'config.json'), JSON.stringify(cfg));
  const fixture = wireFixture(wire, [{ call: { name: 'file_read', args: { path: join(home, 'agents', 'bernd', 'workspace', 'fixture.txt') } } }, { text: 'fixture done' }]);
  const previous = { allow: process.env.PLUR1BUS_ALLOW_TEST_INTERNALS, keyring: process.env.PLUR1BUS_SECRETS_KEYRING };
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = '1'; process.env.PLUR1BUS_SECRETS_KEYRING = 'memory';
  const core = createCore({ home, testInternals: flatTestInternals(), composition: { definitions: { fixture: definition(wire, wire === 'anthropic_messages' ? 'claude-sonnet-4-5' : 'gpt-4.1') }, fetch: fixture.fetch } });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await core.start(); await writeFile(join(home, 'agents', 'bernd', 'workspace', 'fixture.txt'), 'fixture content');
    client = await connect({ address: core.address, token: core.token });
    await client.call('secret.set', { name: 'fixture.key', value: 'synthetic-fixture-value' });
    const { session } = await client.call<any>('session.create', { caller, agentId: 'bernd' });
    const outcome = await client.call<any>('session.submit', { caller, sessionId: session.id, text: 'read file fixture.txt', wait: true });
    assert.deepEqual({ state: outcome.state, reply: outcome.reply }, { state: 'completed', reply: 'fixture done' }); assert.equal(fixture.calls, 2);
    assert.match(JSON.stringify(fixture.bodies[1]), /fixture content/);
    const log = await readFile(join(home, 'logs', 'core.log'), 'utf8');
    const stages = log.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(r => r.msg === 'turn.stage');
    for (const stage of ['recall', 'context', 'identity', 'triage', 'capability-index', 'prompt', 'budget', 'provider', 'tool-dispatch', 'result-cap', 'usage', 'capture']) assert.ok(stages.some(r => r.stage === stage && r.phase === 'end'), stage);
    assert.equal(new Set(stages.map(r => r.trace_id)).size, 1);
    const audit = await readFile(join(home, 'logs', 'audit.log'), 'utf8'); assert.match(audit, /policy.decision/); assert.match(audit, /policy.outcome/); assert.ok(!log.includes('synthetic-fixture-value'));
  } finally { await client?.close(); await core.stop(); await rm(home, { recursive: true, force: true }); for (const [key, old] of [['PLUR1BUS_ALLOW_TEST_INTERNALS', previous.allow], ['PLUR1BUS_SECRETS_KEYRING', previous.keyring]] as const) if (old === undefined) delete process.env[key]; else process.env[key] = old; }
});

test('identity adapter resolves v2 plus two linked v1 scopes; captures only canonical v2', async () => {
  const home = await mkdtemp(join(tmpdir(), 'turn-scope-')); const cfg = defaults(); cfg.agents.bernd = {};
  const identity = createIdentityService({ dbPath: join(home, 'identity.sqlite'), clock: Date.now, audit: () => {} });
  const actor = { user: 'owner', host: 'host', kind: 'person' as const, role: 'owner' as const };
  const human = identity.createHuman({ displayName: 'fixture human' }, actor);
  const a = identity.link({ humanId: human.id, identity: caller }, actor);
  const b = identity.link({ humanId: human.id, identity: { channel: 'telegram', accountId: 'bot', userId: 'user' } }, actor);
  const logger = createLogger({ file: join(home, 'logs', 'scope.log'), level: 'info', role: 'scope' }); const agents = createAgentRegistry({ config: () => cfg }, layout(home), logger); agents.scaffold('bernd');
  const reads: string[] = [], writes: string[] = [];
  const engine = { async recall(q: { principal: { user: string } }) { reads.push(q.principal.user); return { blocks: [{ name: q.principal.user, text: q.principal.user === a.v1Principal ? 'fact from cli' : q.principal.user === b.v1Principal ? 'fact from linked channel' : 'canonical fact', chars: 30, droppable: false }], capChars: Infinity, degraded: null } as RecallResult; }, capture(t: { principal: { user: string } }) { writes.push(t.principal.user); return { id: 'capture', done: Promise.resolve({ stored: 1, skipped: 0 }) }; } } as unknown as Engine;
  const memory = engineTurnMemory({ engine, config: () => cfg, agents, logger, captureSignal: new AbortController().signal, isStopping: () => false, identity, scope: createRecallScopeProvider(identity) });
  try {
    const recalled = await memory.recall({ agentId: 'bernd', caller, query: 'facts', signal: new AbortController().signal });
    assert.match(recalled.text, /fact from cli/); assert.match(recalled.text, /fact from linked channel/);
    assert.deepEqual(new Set(reads), new Set([deriveUserPrincipal(human.id), a.v1Principal, b.v1Principal]));
    await memory.capture({ agentId: 'bernd', caller, sessionId: 's1', turnId: 't1', messages: [], incognito: false }); assert.deepEqual(writes, [deriveUserPrincipal(human.id)]);
  } finally { identity.close(); await logger.close(); await rm(home, { recursive: true, force: true }); }
});

import { SessionStore } from '../../src/session/store.ts';
import { composedAgentRunner } from '../../src/composition/collaboration.ts';
import { alsAgentScopePort, runWithAgentScope, scopeFor } from '../../src/collab/scope.ts';
import { createMcpRegistry } from '../../src/mcp/index.ts';
import { stdioDef, capturingLogger, NODE, waitDead } from '../mcp/helpers/util.ts';
import { composeTools } from '../../src/composition/tools.ts';
import { memoryAuditSink } from '../../src/rbac/audit.ts';
import { createTurnProvider } from '../../src/composition/provider.ts';
import { createCallBudget, PriceBook, SHIPPED_PRICE_TABLES } from '../../src/budget/index.ts';
import { rig, tick, lastNonce } from '../approvals/service-helpers.ts';

test('remembered prompt snapshot survives reopening; incognito never stores a snapshot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'turn-snapshot-')); const file = join(home, 'sessions.sqlite');
  let store = new SessionStore({ path: file });
  try {
    const session = store.createSession({ kind: 'direct', agentId: 'bernd', owner: 'fixture' });
    assert.equal(store.freezePromptSnapshot(session.id, 'frozen'), 'frozen'); store.close(); store = new SessionStore({ path: file });
    assert.equal(store.freezePromptSnapshot(session.id, 'live recall changed'), 'frozen');
    const incognito = store.createSession({ kind: 'direct', agentId: 'bernd', owner: 'fixture', memoryMode: 'incognito' });
    assert.equal(store.freezePromptSnapshot(incognito.id, 'first'), 'first'); assert.equal(store.freezePromptSnapshot(incognito.id, 'second'), 'second');
  } finally { store.close(); await rm(home, { recursive: true, force: true }); }
});

test('composed subagent runner requires scope and principal, caps at 2000 tokens, and keeps the full return privately', async () => {
  const home = await mkdtemp(join(tmpdir(), 'turn-subagent-'));
  const runner = composedAgentRunner({ id: 'fixture', async *stream(request) { assert.deepEqual(request.toolView, []); assert.equal(request.projectId, 'p1'); assert.equal(request.principal, 'fixture-owner'); yield { type: 'delta', text: 'x'.repeat(9000) }; yield { type: 'usage', inputTokens: 1, outputTokens: 2250 }; } }, alsAgentScopePort(), home);
  const input = { agentId: 'bernd', question: 'q', context: '', signal: new AbortController().signal, principal: { userId: 'fixture-owner', kind: 'person' as const, role: 'owner' as const } };
  try {
    await assert.rejects(() => runner.run(input), { code: 'no-scope' });
    const output = await runWithAgentScope(scopeFor('bernd', 'p1'), () => runner.run(input));
    assert.ok(Buffer.byteLength(output.text) <= 2000); assert.match(output.text, /subagent-result:/);
    const id = /subagent-result:([a-f0-9-]+)/.exec(output.text)![1]!;
    const stored = JSON.parse(await readFile(join(home, 'state', 'subagent-results', `${id}.json`), 'utf8')); assert.equal(stored.value.length, 9000); assert.equal(stored.principal, 'fixture-owner');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('actual MCP registry → stdio fake server → composition bridge → D109 → model continuation; shutdown reaps server', { timeout: 30000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'turn-mcp-')); const audit = memoryAuditSink();
  const mcp = createMcpRegistry({ logger: capturingLogger(), policy: { allowedCommands: [NODE] } });
  mcp.register(stdioDef()); const permissions = await rig();
  const budget = createCallBudget({ path: join(home, 'budget.sqlite'), clock: { now: Date.now }, prices: new PriceBook(SHIPPED_PRICE_TABLES) });
  let calls = 0, pid: number | null = null;
  const request = { sessionId: 's1', turnId: 't1', principal: 'fixture-owner', agentId: 'bernd', summaries: [], memory: '', messages: [{ role: 'user' as const, text: 'echo via MCP' }], signal: new AbortController().signal };
  try {
    const registry = await composeTools({ home, roots: [], grants: permissions.stores.grants, audit, mcp: { port: mcp, servers: ['fixture'] } }, request);
    pid = mcp.status('fixture', 'bernd').pid;
    const provider = createTurnProvider({ registry, budget, topK: 128, profiles: { default: [{ provider: 'fixture', model: 'gpt-4.1', adapter: { async *stream() { yield { type: 'done', result: calls++ === 0 ? { text: '', toolCalls: [{ id: 'c1', name: 'mcp.fixture.echo', arguments: { text: 'fixture echo' }, argumentsRaw: '{"text":"fixture echo"}' }], finishReason: 'tool_calls', rawFinishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 1 }, meta: {} } : { text: 'done', toolCalls: [], finishReason: 'stop', rawFinishReason: 'stop', usage: { inputTokens: 10, outputTokens: 1 }, meta: {} } }; } } }] }, approval: { async request(ask) { const pending = permissions.service.request(ask); await tick(); const { id, nonce } = lastNonce(permissions); assert.equal(permissions.service.decide({ requestId: id, nonce, person: 'fixture-owner', surface: 2, decision: 'approve' }).ok, true); return pending; }, begin: (answer, ask) => permissions.service.begin(answer, ask) }, grants: permissions.stores.grants, grantUse: permissions.stores.grants, log: () => {}, resultStore: { put: async () => 'result:1' } });
    const chunks = []; for await (const chunk of provider.stream(request)) chunks.push(chunk);
    assert.ok(chunks.some(c => c.type === 'tool.result' && c.output.includes('fixture echo'))); assert.equal(calls, 2);
  } finally { await mcp.shutdown(); if (pid) assert.ok(await waitDead(pid)); permissions.service.dispose(); permissions.stores.close(); budget.close(); await rm(home, { recursive: true, force: true }); }
});

test('real RPC approval uses authenticated person and resumes exactly once', { timeout: 30000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'turn-approval-')); const cfg = defaults(); cfg.agents.bernd = {};
  await writeFile(join(home, 'config.json'), JSON.stringify(cfg));
  let executed = 0, rounds = 0;
  const core = createCore({ home, testInternals: flatTestInternals(), composition: { providers: { profiles: { default: [{ provider: 'fixture', model: 'gpt-4.1', adapter: { async *stream() {
    yield { type: 'done', result: rounds++ === 0 ? { text: '', toolCalls: [{ id: 'c1', name: 'fixture_write', arguments: {}, argumentsRaw: '{}' }], finishReason: 'tool_calls', rawFinishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 1 }, meta: {} } : { text: 'approved write done', toolCalls: [], finishReason: 'stop', rawFinishReason: 'stop', usage: { inputTokens: 10, outputTokens: 1 }, meta: {} } };
  } } }] } }, tools: { extra: [{ name: 'fixture.write', description: 'write fixture', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, capability: 'fs.write', effect: 'local-write', risk: 'low', trust: 'first-party', classify: () => ({ flags: { outsideRoots: true } }), execute: async () => { executed++; return 'written'; } }] } } });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  const previous = process.env.PLUR1BUS_SECRETS_KEYRING, gate = process.env.PLUR1BUS_ALLOW_TEST_INTERNALS;
  process.env.PLUR1BUS_SECRETS_KEYRING = 'memory'; process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = '1';
  try {
    await core.start(); client = await connect({ address: core.address, token: core.token });
    const { session } = await client.call<any>('session.create', { caller, agentId: 'bernd' });
    const submitted = await client.call<any>('session.submit', { caller, sessionId: session.id, text: 'write fixture', wait: false });
    let request: any;
    for (let i = 0; i < 200 && !request; i++) { request = (await client.call<any>('approval.list', {})).approvals[0]; if (!request) await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.ok(request, 'authenticated local owner sees the pending request'); assert.equal(executed, 0);
    await client.call('approval.decide', { id: request.id, decision: 'approve', scope: 'once' });
    let state: any;
    for (let i = 0; i < 200; i++) { state = await client.call<any>('session.events', { caller, sessionId: session.id }); if (!state.running) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(state.running, false); assert.equal(executed, 1); assert.ok(state.events.some((e: any) => e.turnId === submitted.turnId && e.type === 'turn.completed'));
    assert.equal((await client.call<any>('approval.get', { id: request.id })).status, 'used');
  } finally { await client?.close(); await core.stop(); await rm(home, { recursive: true, force: true }); if (previous === undefined) delete process.env.PLUR1BUS_SECRETS_KEYRING; else process.env.PLUR1BUS_SECRETS_KEYRING = previous; if (gate === undefined) delete process.env.PLUR1BUS_ALLOW_TEST_INTERNALS; else process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = gate; }
});
