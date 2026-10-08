import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCallBudget, PriceBook, SHIPPED_PRICE_TABLES, type CallBudgetEvent } from '../../src/budget/index.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { createTurnProvider } from '../../src/composition/provider.ts';
import type { StreamingAdapter, ChatRequest as WireRequest } from '../../../providers/src/index.ts';
import type { ChatRequest, ChatChunk } from '../../src/session/provider.ts';

const usage = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 95 };
const result = (text = 'done', tools: { id: string; name: string; arguments: Record<string, string>; argumentsRaw: string }[] = []) => ({ text, toolCalls: tools, finishReason: tools.length ? 'tool_calls' as const : 'stop' as const, rawFinishReason: 'stop', usage, meta: {} });
const req = (): ChatRequest => ({ sessionId: 's1', turnId: 't1', agentId: 'a1', principal: 'user:v2:' + 'a'.repeat(64), summaries: [], memory: 'recalled fact', messages: [{ role: 'user', text: 'read file' }], signal: new AbortController().signal });
async function fixture(adapter: StreamingAdapter, extra: Partial<Parameters<typeof createTurnProvider>[0]> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'turn-composition-'));
  const budgetEvents: CallBudgetEvent[] = [];
  const budget = createCallBudget({ path: join(home, 'budget.sqlite'), clock: { now: Date.now }, prices: new PriceBook(SHIPPED_PRICE_TABLES), emitter: { emit: e => budgetEvents.push(e) } });
  const logs: Record<string, unknown>[] = [];
  const registry = new ToolRegistry();
  const provider = createTurnProvider({ registry, budget, profiles: { default: [{ provider: 'fixture', model: 'gpt-4.1', adapter }] }, approval: { request: async () => ({ approved: false }) }, grants: { get: () => undefined, list: () => [] }, log: (r) => logs.push({ ...r }), resultStore: { put: async () => 'result:1' }, ...extra });
  return { provider, budget, budgetEvents, registry, logs, home, close: async () => { budget.close(); await rm(home, { recursive: true, force: true }); } };
}
async function collect(provider: ReturnType<typeof createTurnProvider>, request = req()) { const chunks: ChatChunk[] = []; for await (const c of provider.stream(request)) chunks.push(c); return chunks; }

test('chat traverses triage, index, prompt, pre-call budget, streaming and usage settlement', async () => {
  let seen: WireRequest | undefined;
  const f = await fixture({ async *stream(r) { seen = r; yield { type: 'text_delta', text: 'done' }; yield { type: 'done', result: result() }; } });
  try {
    const chunks = await collect(f.provider);
    assert.equal(chunks.find(c => c.type === 'delta')?.text, 'done');
    assert.ok(seen?.messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('recalled fact')));
    for (const stage of ['identity', 'triage', 'capability-index', 'prompt', 'budget', 'provider', 'usage']) assert.ok(f.logs.some(r => r.stage === stage && r.phase === 'end'), stage);
  } finally { await f.close(); }
});

test('tool result is delivered to a second provider call only after D109 execution', async () => {
  let calls = 0, executions = 0;
  const f = await fixture({ async *stream(r) { calls++; if (calls === 1) yield { type: 'done', result: result('', [{ id: 'c1', name: 'file.read', arguments: { path: 'fixture' }, argumentsRaw: '{"path":"fixture"}' }]) }; else { assert.ok(r.messages.some(m => m.role === 'tool' && m.content.includes('file bytes'))); yield { type: 'text_delta', text: 'done' }; yield { type: 'done', result: result() }; } } });
  f.registry.register({ name: 'file.read', description: 'Read file bytes', inputSchema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] }, capability: 'fs.read', effect: 'read', risk: 'low', classify: () => ({ flags: { outsideRoots: false } }), execute: async () => { executions++; return 'file bytes'; } });
  try { await collect(f.provider); assert.equal(calls, 2); assert.equal(executions, 1); } finally { await f.close(); }
});

test('budget denial happens before adapter invocation and remains typed', async () => {
  let calls = 0;
  const f = await fixture({ async *stream() { calls++; yield { type: 'done', result: result() }; } });
  f.budget.setLimit({ scope: 'global', id: '', period: 'day', metric: 'tokens', hard: 0 });
  try { await assert.rejects(() => collect(f.provider), { code: 'budget_exceeded' }); assert.equal(calls, 0); } finally { await f.close(); }
});

import { createChatCompletionsAdapter, createAnthropicAdapter, createResponsesAdapter, createGeminiAdapter, ProviderError } from '../../../providers/src/index.ts';
import { wireFixture, type Wire } from './wire-fixture.ts';
import { providerFetch } from '../../src/composition/http.ts';
import { rig, tick, lastNonce } from '../approvals/service-helpers.ts';
import { createPolicyAudit } from '../../src/policy/audit.ts';
import { composeTools } from '../../src/composition/tools.ts';
import { memoryAuditSink } from '../../src/rbac/audit.ts';
import { OutputStore } from '../../../media/src/index.ts';
import { createPromptBuilder } from '../../src/prompt/index.ts';

const fileTool = (execute: () => Promise<unknown> = async () => 'file bytes') => ({ name: 'file.read', description: 'Read file', inputSchema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] }, capability: 'fs.read', effect: 'read' as const, risk: 'low' as const, classify: () => ({ flags: { outsideRoots: false } }), execute });
function wireAdapter(wire: Wire, fetch: typeof globalThis.fetch) {
  const transport = providerFetch({ decide: async () => { throw new Error('DNS forbidden'); } }, wire, fetch);
  if (wire === 'anthropic_messages') return createAnthropicAdapter({ credentials: { apiKey: () => 'synthetic' }, fetch: transport });
  if (wire === 'codex_responses') return createResponsesAdapter({ credentials: { authorization: () => 'Bearer synthetic' }, fetch: transport });
  if (wire === 'gemini') return createGeminiAdapter({ credentials: { apiKey: () => 'synthetic' }, fetch: transport });
  return createChatCompletionsAdapter({ baseUrl: 'https://fixture.invalid/v1', credentials: { authorization: () => 'Bearer synthetic' }, fetch: transport });
}
for (const wire of ['chat_completions', 'anthropic_messages', 'codex_responses', 'gemini'] as const) {
  const family = wire === 'anthropic_messages' ? 'anthropic' : wire === 'codex_responses' ? 'openai-responses' : wire === 'gemini' ? 'gemini' : 'openai-chat';
  test(`${wire}: real wire adapter → policy allowed file.read → second model response`, async () => {
    const w = wireFixture(wire, [{ call: { name: 'file_read', args: { path: 'fixture' } } }, { text: 'all done' }]);
    const f = await fixture(wireAdapter(wire, w.fetch), { family: { fixture: family } });
    f.registry.register(fileTool());
    try { const chunks = await collect(f.provider); assert.equal(chunks.filter(c => c.type === 'delta').map(c => c.text).join(''), 'all done'); assert.equal(w.calls, 2); assert.match(JSON.stringify(w.bodies[1]), /file bytes/); } finally { await f.close(); }
  });
  for (const success of [true, false]) test(`${wire}: invalid arguments → one repair → ${success ? 'success' : 'tool-call-invalid'}`, async () => {
    let runs = 0;
    const w = wireFixture(wire, [{ call: { name: 'file_read', args: { path: 7 } } }, { call: { name: 'file_read', args: { path: success ? 'fixed' : 9 } } }, { text: 'repaired' }]);
    const f = await fixture(wireAdapter(wire, w.fetch), { family: { fixture: family } });
    f.registry.register(fileTool(async () => { runs++; return 'file bytes'; }));
    try { if (success) { await collect(f.provider); assert.equal(w.calls, 3); assert.equal(runs, 1); } else { await assert.rejects(() => collect(f.provider), { code: 'tool-call-invalid' }); assert.equal(w.calls, 2); assert.equal(runs, 0); } } finally { await f.close(); }
  });
}

test('approval.requested parks, approval.decide resumes and consumes its actual once grant', async () => {
  const r = await rig(); let runs = 0, calls = 0;
  const adapter: StreamingAdapter = { async *stream() { yield { type: 'done', result: calls++ === 0 ? result('', [{ id: 'c1', name: 'file.read', arguments: { path: 'outside' }, argumentsRaw: '{"path":"outside"}' }]) : result() }; } };
  const f = await fixture(adapter, { approval: r.service, grants: r.stores.grants, grantUse: r.stores.grants, audit: createPolicyAudit({ sink: r.audit, clock: r.clock }) });
  f.registry.register({ ...fileTool(async () => { runs++; return 'approved'; }), classify: () => ({ flags: { outsideRoots: true } }) });
  try {
    const running = collect(f.provider); for (let i = 0; i < 50 && !r.events.some(e => e.name === 'approval.requested'); i++) await tick();
    const { id, nonce } = lastNonce(r); assert.equal(runs, 0); assert.equal(calls, 1);
    const decision = r.service.decide({ requestId: id, nonce, person: req().principal!, surface: 2, decision: 'approve' }); assert.equal(decision.ok, true);
    await running; assert.equal(runs, 1); assert.ok(r.audit.events.some(e => e.action === 'approval.consumed'));
  } finally { r.service.dispose(); r.stores.close(); await f.close(); }
});

test('never policy and headless without a standing grant refuse before execution', async () => {
  for (const headless of [false, true]) {
    let runs = 0;
    const f = await fixture({ async *stream() { yield { type: 'done', result: result('', [{ id: 'c1', name: 'file.read', arguments: { path: 'fixture' }, argumentsRaw: '{"path":"fixture"}' }]) }; } }, { policyContext: () => headless ? { headless: { jobId: 'j1' } } : { toolsDeny: ['fs.read'] } });
    f.registry.register({ ...fileTool(async () => { runs++; return ''; }), classify: () => ({ flags: { outsideRoots: true } }) });
    try { await assert.rejects(() => collect(f.provider), { code: 'tool-denied' }); assert.equal(runs, 0); } finally { await f.close(); }
  }
});

test('rate_limit falls back; auth never invokes the next provider', async () => {
  for (const kind of ['rate_limit', 'auth'] as const) {
    let second = 0;
    const primary: StreamingAdapter = { async *stream() { throw new ProviderError(kind, 'synthetic', { retryable: false }); } };
    const fallback: StreamingAdapter = { async *stream() { second++; yield { type: 'text_delta', text: 'fallback' }; yield { type: 'done', result: result() }; } };
    const f = await fixture(primary, { profiles: { default: [{ provider: 'first', model: 'gpt-4.1', adapter: primary }, { provider: 'second', model: 'gpt-4.1', adapter: fallback }] }, router: { retry: { maxRetries: 0 } } });
    try { if (kind === 'auth') { await assert.rejects(() => collect(f.provider), { kind: 'auth' }); assert.equal(second, 0); } else { await collect(f.provider); assert.equal(second, 1); } } finally { await f.close(); }
  }
});

test('abort during stream closes the adapter and settles the partial call at an estimate (no pending reservation)', async () => {
  const abort = new AbortController(); let closed = false;
  const f = await fixture({ async *stream() { try { yield { type: 'text_delta', text: 'partial' }; abort.abort(new Error('cancel')); yield { type: 'text_delta', text: 'unreachable' }; } finally { closed = true; } } });
  try {
    await assert.rejects(() => collect(f.provider, { ...req(), signal: abort.signal })); assert.equal(closed, true);
    assert.deepEqual(f.budget.pendingReservations(), { live: 0, expired: 0 });
    const reserved = f.budgetEvents.find(e => e.type === 'reserve'), settled = f.budgetEvents.find(e => e.type === 'settle');
    assert.ok(reserved && settled && reserved.type === 'reserve' && settled.type === 'settle');
    assert.equal(settled.reservationId, reserved.reservationId);
    // Estimated input plus the streamed 'partial' (7 chars → 2 tokens); never the 4096-token output reservation.
    assert.ok(settled.tokens > 2 && settled.tokens < reserved.tokens, `estimate ${settled.tokens} of ${reserved.tokens}`);
    assert.equal(f.budget.reservation(settled.reservationId)?.state, 'settled');
    assert.ok(!f.budgetEvents.some(e => e.type === 'release'));
  } finally { await f.close(); }
});

test('MCP bridge and media output store register in the same policy dispatcher', async () => {
  const home = await mkdtemp(join(tmpdir(), 'turn-media-')); const audit = memoryAuditSink(); let mcpCalls = 0;
  const request = req();
  const registry = await composeTools({ home, roots: [], grants: { get: () => undefined, list: () => [] }, audit,
    mcp: { servers: ['fixture'], port: { listTools: async () => [{ name: 'echo', description: 'Echo fixture', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }], callTool: async (_server, _name, _args, caller) => { assert.equal(caller.principal, request.principal); mcpCalls++; return { content: [{ type: 'text', text: 'MCP ok' }] } as never; } } },
    media: { store: new OutputStore(join(home, 'outputs')), adapter: { id: 'fixture', capabilities: () => ({ generate: true, edit: false, inpaint: false }), generate: async () => ({ files: [{ bytes: new Uint8Array([1, 2, 3]), format: 'png' }], metadata: { adapter: 'fixture', model: 'synthetic', durationMs: 1 } }), edit: async () => { throw new Error('not used'); } } },
  }, request);
  for (const name of ['mcp.fixture.echo', 'image.generate']) {
    let calls = 0;
    const f = await fixture({ async *stream() { const args = name === 'image.generate' ? { prompt: 'synthetic image' } : {}; yield { type: 'done', result: calls++ === 0 ? result('', [{ id: 'c1', name, arguments: args, argumentsRaw: JSON.stringify(args) }]) : result() }; } }, { registry, policyContext: () => ({ overrides: { 'net.submit': 'allowed' } }) });
    // Money operations retain an approval even with the local override.
    const r = await rig();
    const provider = createTurnProvider({ registry, budget: f.budget, profiles: { default: [{ provider: 'fixture', model: 'gpt-4.1', adapter: { async *stream() { const args = name === 'image.generate' ? { prompt: 'synthetic image' } : {}; yield { type: 'done', result: calls++ === 0 ? result('', [{ id: 'c1', name, arguments: args, argumentsRaw: JSON.stringify(args) }]) : result() }; } } }] }, approval: { request: async ask => { const pending = r.service.request(ask); await tick(); const { id, nonce } = lastNonce(r); const decided = r.service.decide({ requestId: id, nonce, person: request.principal!, surface: 3, decision: 'approve' }); assert.equal(decided.ok, true); return pending; }, begin: (answer, ask) => r.service.begin(answer, ask) }, grants: r.stores.grants, grantUse: r.stores.grants, log: () => {}, resultStore: { put: async () => 'result:1' }, topK: 128 });
    try { const chunks = await collect(provider); assert.ok(chunks.some(c => c.type === 'tool.result' && (name.startsWith('mcp.') ? c.output.includes('MCP ok') : c.output.includes('synthetic')))); } finally { r.service.dispose(); r.stores.close(); await f.close(); }
  }
  assert.equal(mcpCalls, 1); await rm(home, { recursive: true, force: true });
});

test('cache breakpoints are stable across turns and construction; synthetic cache reads exceed B5 from turn 3', async () => {
  const prompts: ReturnType<ReturnType<typeof createPromptBuilder>['render']>[] = [];
  const w = wireFixture('anthropic_messages', [{ text: 'done', inputTokens: 1000, cacheRead: 950 }]);
  const adapter = wireAdapter('anthropic_messages', w.fetch);
  const f = await fixture(adapter, { profiles: { default: [{ provider: 'fixture', model: 'claude-sonnet-4-5', adapter }] }, family: { fixture: 'anthropic' }, system: ['stable instructions '.repeat(600)], onPrompt: p => prompts.push(p) });
  try {
    for (let i = 1; i <= 3; i++) await collect(f.provider, { ...req(), turnId: `t${i}` });
    assert.deepEqual(prompts[0]!.prefixHashes, prompts[1]!.prefixHashes);
    assert.ok(f.provider.telemetry.summary('a1', 'claude-sonnet-4-5', 's1')!.hitRatio >= .9);
    const system = w.bodies[0]!.system as Record<string, unknown>[];
    assert.ok(system.some(b => b.cache_control));
    const messages = w.bodies[0]!.messages as { content: Record<string, unknown>[] }[];
    assert.ok(!messages.at(-1)!.content.at(-1)!.cache_control, 'recall tail must not be cached');
    const input = { agentId: 'a1', model: 'claude-sonnet-4-5', sessionId: 's1', tools: [], system: ['stable instructions '.repeat(600)], memory: 'recalled fact', conversation: [{ role: 'user' as const, text: 'read file' }] };
    assert.deepEqual(createPromptBuilder().render(input).zoneHashes, createPromptBuilder().render(input).zoneHashes);
  } finally { await f.close(); }
});

for (const wire of ['chat_completions', 'anthropic_messages', 'codex_responses', 'gemini'] as const) {
  const family = wire === 'anthropic_messages' ? 'anthropic' : wire === 'codex_responses' ? 'openai-responses' : wire === 'gemini' ? 'gemini' : 'openai-chat';
  test(`${wire}: plain chat and stable cache prefix across three turns`, async () => {
    const prompts: ReturnType<ReturnType<typeof createPromptBuilder>['render']>[] = [];
    const w = wireFixture(wire, [{ text: 'chat done', inputTokens: 1000, cacheRead: 950 }]); const adapter = wireAdapter(wire, w.fetch);
    const f = await fixture(adapter, { profiles: { default: [{ provider: 'fixture', model: wire === 'anthropic_messages' ? 'claude-sonnet-4-5' : 'gpt-4.1', adapter }] }, family: { fixture: family }, onPrompt: p => prompts.push(p) });
    try { for (let i = 1; i <= 3; i++) { const chunks = await collect(f.provider, { ...req(), turnId: `t${i}` }); assert.equal(chunks.filter(c => c.type === 'delta').map(c => c.text).join(''), 'chat done'); } assert.deepEqual(prompts[0]!.prefixHashes, prompts[1]!.prefixHashes); assert.ok(f.provider.telemetry.summary('a1', prompts[0]!.model, 's1')!.hitRatio >= .9); } finally { await f.close(); }
  });
  test(`${wire}: approval parks and resumes a single execution`, async () => {
    const r = await rig(); let runs = 0; const w = wireFixture(wire, [{ call: { name: 'file_read', args: { path: 'outside' } } }, { text: 'approved' }]);
    const f = await fixture(wireAdapter(wire, w.fetch), { family: { fixture: family }, approval: r.service, grants: r.stores.grants, grantUse: r.stores.grants });
    f.registry.register({ ...fileTool(async () => { runs++; return 'approved bytes'; }), classify: () => ({ flags: { outsideRoots: true } }) });
    try { const pending = collect(f.provider); for (let i = 0; i < 50 && !r.events.some(e => e.name === 'approval.requested'); i++) await tick(); const { id, nonce } = lastNonce(r); assert.equal(runs, 0); assert.equal(w.calls, 1); assert.equal(r.service.decide({ requestId: id, nonce, person: req().principal!, surface: 2, decision: 'approve' }).ok, true); await pending; assert.equal(runs, 1); assert.equal(w.calls, 2); } finally { r.service.dispose(); r.stores.close(); await f.close(); }
  });
  test(`${wire}: never denies before execution`, async () => {
    let runs = 0; const w = wireFixture(wire, [{ call: { name: 'file_read', args: { path: 'fixture' } } }]);
    const f = await fixture(wireAdapter(wire, w.fetch), { family: { fixture: family }, policyContext: () => ({ toolsDeny: ['fs.read'] }) }); f.registry.register(fileTool(async () => { runs++; return ''; }));
    try { await assert.rejects(() => collect(f.provider), { code: 'tool-denied' }); assert.equal(runs, 0); } finally { await f.close(); }
  });
  test(`${wire}: budget refusal prevents even the HTTP fixture call`, async () => {
    const w = wireFixture(wire, [{ text: 'forbidden' }]); const f = await fixture(wireAdapter(wire, w.fetch), { family: { fixture: family } }); f.budget.setLimit({ scope: 'global', id: '', period: 'day', metric: 'tokens', hard: 0 });
    try { await assert.rejects(() => collect(f.provider), { code: 'budget_exceeded' }); assert.equal(w.calls, 0); } finally { await f.close(); }
  });
  for (const status of [429, 401]) test(`${wire}: HTTP ${status} ${status === 429 ? 'falls back' : 'does not fall back'}`, async () => {
    const first = wireFixture(wire, [{ status }]), second = wireFixture(wire, [{ text: 'fallback done' }]);
    const a = wireAdapter(wire, first.fetch), b = wireAdapter(wire, second.fetch);
    const f = await fixture(a, { profiles: { default: [{ provider: 'first', model: 'gpt-4.1', adapter: a }, { provider: 'second', model: 'gpt-4.1', adapter: b }] }, family: { first: family, second: family }, router: { retry: { maxRetries: 0 } } });
    try { if (status === 401) { await assert.rejects(() => collect(f.provider), { kind: 'auth' }); assert.equal(second.calls, 0); } else { await collect(f.provider); assert.equal(second.calls, 1); } assert.equal(first.calls, 1); } finally { await f.close(); }
  });
  test(`${wire}: abort during a real adapter stream closes its generator`, async () => {
    const w = wireFixture(wire, [{ text: 'partial' }]); const base = wireAdapter(wire, w.fetch); const abort = new AbortController(); let closed = false;
    const f = await fixture({ async *stream(request, options) { try { for await (const event of base.stream(request, options)) { yield event; if (event.type === 'text_delta') abort.abort(new Error('cancel')); } } finally { closed = true; } } }, { family: { fixture: family } });
    try { await assert.rejects(() => collect(f.provider, { ...req(), signal: abort.signal })); assert.equal(closed, true); } finally { await f.close(); }
  });
}

for (const wire of ['chat_completions', 'anthropic_messages', 'codex_responses', 'gemini'] as const) for (const operation of ['mcp', 'media'] as const) test(`${wire}: ${operation} bridge executes through approval and returns a durable result`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'wire-tools-')); const r = await rig(); let runs = 0;
  const request = { ...req(), authenticatedPerson: 'local-owner' };
  const call = operation === 'mcp' ? { name: 'mcp_fixture_echo', args: {} } : { name: 'image_generate', args: { prompt: 'synthetic image' } };
  const w = wireFixture(wire, [{ call }, { text: 'tool done' }]);
  const family = wire === 'anthropic_messages' ? 'anthropic' : wire === 'codex_responses' ? 'openai-responses' : wire === 'gemini' ? 'gemini' : 'openai-chat';
  const store = new OutputStore(join(home, 'outputs'));
  const f = await fixture(wireAdapter(wire, w.fetch), { family: { fixture: family }, topK: 128,
    toolsForTurn: req => composeTools({ home, roots: [], budget: f.budget, grants: r.stores.grants, audit: r.audit,
      mcp: { servers: ['fixture'], port: { listTools: async (_server, caller) => { assert.equal(caller.principal, request.principal); return [{ name: 'echo', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }]; }, callTool: async (_server, _tool, _args, caller) => { assert.equal(caller.principal, request.principal); runs++; return { content: [{ type: 'text', text: 'MCP wire ok' }] } as never; } } },
      media: { store, adapter: { id: 'fixture', capabilities: () => ({ generate: true, edit: false, inpaint: false }), generate: async () => { runs++; return { files: [{ bytes: new Uint8Array([1, 2, 3]), format: 'png' }], metadata: { adapter: 'fixture', model: 'synthetic', durationMs: 1 } }; }, edit: async () => { throw new Error('unused'); } } },
    }, req),
    approval: { async request(ask) { const pending = r.service.request(ask); await tick(); const { id, nonce } = lastNonce(r); assert.equal(ask.principal, 'local-owner'); assert.equal(r.service.decide({ requestId: id, nonce, person: 'local-owner', surface: 3, decision: 'approve' }).ok, true); return pending; }, begin: (answer, ask) => r.service.begin(answer, ask) }, grants: r.stores.grants, grantUse: r.stores.grants,
  });
  try { const chunks = await collect(f.provider, request); assert.equal(runs, 1); assert.equal(w.calls, 2); const output = chunks.find(c => c.type === 'tool.result'); assert.ok(output && output.type === 'tool.result'); if (operation === 'mcp') assert.match(output.output, /MCP wire ok/); else { const manifest = JSON.parse(output.output).value; assert.ok(await store.get(manifest.id)); } assert.ok(f.logs.some(r => r.stage === 'tool-dispatch' && r.phase === 'end')); } finally { r.service.dispose(); r.stores.close(); await f.close(); await rm(home, { recursive: true, force: true }); }
});

test('fallback changes prompt cache profile and usage model to the actual candidate', async () => {
  const prompts: string[] = [], usageModels: string[] = [];
  const first: StreamingAdapter = { async *stream() { throw new ProviderError('rate_limit', 'synthetic', { retryable: false }); } };
  const w = wireFixture('anthropic_messages', [{ text: 'fallback', inputTokens: 1000, cacheRead: 950 }]);
  const second = wireAdapter('anthropic_messages', w.fetch);
  const f = await fixture(first, { maxTokens: 32, router: { retry: { maxRetries: 0 } }, profiles: { default: [{ provider: 'first', model: 'gpt-4.1', adapter: first }, { provider: 'second', model: 'claude-sonnet-4-5', adapter: second }] }, family: { first: 'openai-chat', second: 'anthropic' }, system: ['stable '.repeat(3000)], onPrompt: p => prompts.push(p.model), onUsage: u => usageModels.push(u.model) });
  try { await collect(f.provider); assert.equal(prompts.at(-1), 'claude-sonnet-4-5'); assert.deepEqual(usageModels, ['claude-sonnet-4-5']); assert.ok((w.bodies[0]!.system as Record<string, unknown>[]).some(b => b.cache_control)); } finally { await f.close(); }
});

// ---- PR #293 review fixes ----
import { homedir } from 'node:os';
import { AuthError } from '../../src/auth/errors.ts';
import { approvalPolicyContext } from '../../src/composition/index.ts';
import { billingClassOf } from '../../src/composition/auth.ts';
import type { TurnRouterEvent } from '../../src/composition/provider.ts';

const okAdapter = (text = 'ok'): StreamingAdapter => ({ async *stream() { yield { type: 'text_delta', text }; yield { type: 'done', result: result(text) }; } });
const toolOnce = (name: string, args: () => Record<string, unknown>): StreamingAdapter => {
  // First round of every turn asks for the tool; the round after a tool result answers.
  return { async *stream(r) { const a = args(); yield { type: 'done', result: r.messages.some(m => m.role === 'tool') ? result() : result('', [{ id: 'c1', name, arguments: a as Record<string, string>, argumentsRaw: JSON.stringify(a) }]) }; } };
};

test('finding 1: lease failure, egress refusal and HTTP 401 before the first byte release the reservation; a later healthy call is admitted', async () => {
  const failing: Record<string, StreamingAdapter> = {
    lease: createChatCompletionsAdapter({ baseUrl: 'https://fixture.invalid/v1', credentials: { authorization: () => { throw new AuthError('no_credential', 'nothing stored'); } }, fetch: wireFixture('chat_completions', [{ text: 'never' }]).fetch }),
    egress: createChatCompletionsAdapter({ baseUrl: 'https://fixture.invalid/v1', credentials: { authorization: () => 'Bearer synthetic' }, fetch: providerFetch({ decide: async () => ({ allowed: false }) } as never, 'chat_completions') }),
    'http-401': wireAdapter('chat_completions', wireFixture('chat_completions', [{ status: 401 }]).fetch),
  };
  for (const [name, bad] of Object.entries(failing)) {
    let healthy = false;
    const adapter: StreamingAdapter = { async *stream(r, o) { if (healthy) yield* okAdapter().stream(r, o); else yield* bad.stream(r, o); } };
    const f = await fixture(adapter);
    // One reservation (~4.4k tokens with the 4096-token output cap) fits under this ceiling; a leaked second one would not.
    f.budget.setLimit({ scope: 'global', id: '', period: 'day', metric: 'tokens', hard: 6000 });
    try {
      for (const turnId of ['t1', 't2']) await assert.rejects(() => collect(f.provider, { ...req(), turnId }), Error, name);
      assert.deepEqual(f.budget.pendingReservations(), { live: 0, expired: 0 }, name);
      assert.equal(f.budgetEvents.filter(e => e.type === 'release').length, 2, name);
      healthy = true;
      const chunks = await collect(f.provider, { ...req(), turnId: 't3' });
      assert.equal(chunks.find(c => c.type === 'delta')?.text, 'ok', name);
    } finally { await f.close(); }
  }
});

test('finding 1: a media generate failure releases its reservation; an aborted generation settles the requested quantity', async () => {
  const home = await mkdtemp(join(tmpdir(), 'turn-media-budget-')); const events: CallBudgetEvent[] = [];
  const budget = createCallBudget({ path: join(home, 'budget.sqlite'), clock: { now: Date.now }, prices: new PriceBook(SHIPPED_PRICE_TABLES), emitter: { emit: e => events.push(e) } });
  try {
    const registry = await composeTools({ home, roots: [], budget, grants: { get: () => undefined, list: () => [] }, audit: memoryAuditSink(),
      media: { store: new OutputStore(join(home, 'outputs')), adapter: { id: 'fixture', capabilities: () => ({ generate: true, edit: false, inpaint: false }), generate: async () => { throw new Error('synthetic provider failure'); }, edit: async () => { throw new Error('unused'); } } } }, req());
    const tool = registry.get('image.generate')!;
    await assert.rejects(() => tool.execute({ prompt: 'synthetic' }, { signal: new AbortController().signal, agentId: 'a1', principal: req().principal! }), /synthetic provider failure/);
    assert.deepEqual(budget.pendingReservations(), { live: 0, expired: 0 });
    assert.equal(events.filter(e => e.type === 'release').length, 1);
    const abort = new AbortController(); abort.abort(new Error('cancel'));
    await assert.rejects(() => tool.execute({ prompt: 'synthetic' }, { signal: abort.signal, agentId: 'a1', principal: req().principal! }));
    assert.deepEqual(budget.pendingReservations(), { live: 0, expired: 0 });
    assert.equal(events.filter(e => e.type === 'settle').length, 1);
  } finally { budget.close(); await rm(home, { recursive: true, force: true }); }
});

test('finding 2: a denied action re-emitted next turn is repeat-denied without a prompt; the prompt cap refuses the 11th prompt', async () => {
  const r = await rig(); let prompts = 0; let path = 'outside-0';
  const f = await fixture(toolOnce('file.read', () => ({ path })), { approval: { async request(ask) { prompts++; const pending = r.service.request(ask); await tick(); const { id, nonce } = lastNonce(r); assert.equal(r.service.decide({ requestId: id, nonce, person: req().principal!, surface: 2, decision: 'deny' }).ok, true); return pending; }, begin: (answer, ask) => r.service.begin(answer, ask) },
    grants: r.stores.grants, grantUse: r.stores.grants, audit: createPolicyAudit({ sink: r.audit, clock: r.clock }), policyContext: approvalPolicyContext({ current: () => ({ service: r.service }) as never }) });
  f.registry.register({ ...fileTool(), classify: () => ({ flags: { outsideRoots: true } }) });
  const rules = () => r.audit.events.filter(e => e.action === 'policy.decision').map(e => String(e.detail.rule));
  try {
    await assert.rejects(() => collect(f.provider, { ...req(), turnId: 't0' }), { code: 'tool-not-approved' });
    assert.equal(prompts, 1);
    await assert.rejects(() => collect(f.provider, { ...req(), turnId: 't0b' }), { code: 'tool-denied' });
    assert.equal(prompts, 1, 'repeat-denied never prompts');
    assert.ok(rules().includes('fatigue:repeat-denied'), rules().join());
    for (let i = 1; i < 10; i++) { path = `outside-${i}`; await assert.rejects(() => collect(f.provider, { ...req(), turnId: `t${i}` }), { code: 'tool-not-approved' }); }
    assert.equal(prompts, 10);
    path = 'outside-10';
    await assert.rejects(() => collect(f.provider, { ...req(), turnId: 't10' }), { code: 'tool-denied' });
    assert.equal(prompts, 10, 'over the cap = refused, not prompted');
    assert.ok(rules().includes('fatigue:prompt-cap'), rules().join());
  } finally { r.service.dispose(); r.stores.close(); await f.close(); }
});

test('finding 3: router retry/fallback/skipped events reach the sink with their turn; fallbacks are charged inside authorize', async () => {
  const rateLimited = (): StreamingAdapter => ({ async *stream() { throw new ProviderError('rate_limit', 'synthetic', { retryable: true }); } });
  for (const failing of [3, 4]) {
    const events: (TurnRouterEvent & { turnId: string })[] = [];
    // A priced model, so each retry reserves its real estimate rather than the whole class cap of an unpriced call.
    const model = 'claude-haiku-4-5-20251001';
    const profiles = { default: [...Array.from({ length: failing }, (_, i) => ({ provider: `p${i}`, model, adapter: rateLimited() })), { provider: 'good', model, adapter: okAdapter() }] };
    const f = await fixture(okAdapter(), { profiles, maxTokens: 32, router: { retry: { maxRetries: 0 } }, onRouterEvent: (e, t) => events.push({ ...e, turnId: t.turnId }) });
    try {
      if (failing === 3) {
        // rate_limit allows three retry attempts per turn: the three fallbacks use them up exactly.
        await collect(f.provider);
        assert.equal(events.filter(e => e.type === 'provider.fallback').length, 3);
      } else {
        // The fourth fallback is charged at its own authorization (attempt 5), not deferred to a later call.
        await assert.rejects(() => collect(f.provider), { code: 'retry_budget_exceeded' });
        assert.ok(events.some(e => e.type === 'provider.skipped'));
      }
      assert.ok(events.length > 0 && events.every(e => e.turnId === 't1'));
      assert.deepEqual(f.budget.pendingReservations(), { live: 0, expired: 0 });
    } finally { await f.close(); }
  }
  const events: TurnRouterEvent[] = []; let first = true;
  const flaky: StreamingAdapter = { async *stream(r, o) { if (first) { first = false; throw new ProviderError('overloaded', 'synthetic', { retryable: true }); } yield* okAdapter().stream(r, o); } };
  const f = await fixture(flaky, { maxTokens: 32, router: { retry: { maxRetries: 1, baseMs: 1, maxMs: 1 } }, onRouterEvent: e => events.push(e) });
  try { await collect(f.provider); assert.ok(events.some(e => e.type === 'provider.retry' && e.reason === 'overloaded')); } finally { await f.close(); }
});

test('finding 3: a fallback across plan/paid billing is refused with an event unless the profile allows it', async () => {
  assert.deepEqual([billingClassOf({ billingPath: 'chatgpt_plan', profile: undefined as never }), billingClassOf({ profile: { kind: 'api_key' } as never }), billingClassOf({ profile: { kind: 'external_cli' } as never })], ['plan', 'paid', 'plan']);
  for (const allow of [false, true]) {
    let paidCalls = 0; const events: TurnRouterEvent[] = [];
    const plan: StreamingAdapter = { async *stream() { throw new ProviderError('rate_limit', 'synthetic', { retryable: false }); } };
    const paid: StreamingAdapter = { async *stream(r, o) { paidCalls++; yield* okAdapter().stream(r, o); } };
    const f = await fixture(plan, { profiles: { default: [{ provider: 'plan', model: 'gpt-4.1', adapter: plan }, { provider: 'paid', model: 'gpt-4.1', adapter: paid }] }, billing: { plan: 'plan', paid: 'paid' }, allowCrossBilling: name => allow && name === 'default', router: { retry: { maxRetries: 0 } }, onRouterEvent: e => events.push(e) });
    try {
      if (allow) { await collect(f.provider); assert.equal(paidCalls, 1); assert.ok(!events.some(e => e.type === 'provider.cross_billing_refused')); }
      else {
        await assert.rejects(() => collect(f.provider)); assert.equal(paidCalls, 0);
        const refused = events.find(e => e.type === 'provider.cross_billing_refused');
        assert.ok(refused && refused.type === 'provider.cross_billing_refused'); assert.deepEqual([refused.from.billing, refused.to.billing], ['plan', 'paid']);
      }
      assert.deepEqual(f.budget.pendingReservations(), { live: 0, expired: 0 });
    } finally { await f.close(); }
  }
});

test('finding 6: the dispatcher and the approval record carry the connection surface, not a constant', async () => {
  for (const [approver, expected] of [[{ person: 'local-owner', surface: 2 as const }, 2], [{ person: 'local-owner', surface: 3 as const }, 3], [undefined, 0]] as const) {
    const r = await rig(); let seen: number | undefined;
    const f = await fixture(toolOnce('file.read', () => ({ path: 'outside' })), { approval: { async request(ask) { const pending = r.service.request(ask); await tick(); const e = [...r.events].reverse().find(x => x.name === 'approval.requested')!; seen = e.payload.approval.originSurface; const { id, nonce } = lastNonce(r); r.service.decide({ requestId: id, nonce, person: ask.principal, surface: 3, decision: 'approve' }); return pending; }, begin: (answer, ask) => r.service.begin(answer, ask) }, grants: r.stores.grants, grantUse: r.stores.grants });
    f.registry.register({ ...fileTool(), classify: () => ({ flags: { outsideRoots: true } }) });
    try { await collect(f.provider, { ...req(), ...(approver ? { approver } : {}) }); assert.equal(seen, expected); } finally { r.service.dispose(); r.stores.close(); await f.close(); }
  }
});

test('finding 7: a non-person can chat; a call that needs approval is refused with a typed error and nobody is prompted', async () => {
  const approver = { person: null, surface: 0 as const };
  const chat = await fixture(okAdapter('hello'));
  try { const chunks = await collect(chat.provider, { ...req(), approver }); assert.equal(chunks.find(c => c.type === 'delta')?.text, 'hello'); } finally { await chat.close(); }
  let prompted = 0, runs = 0;
  const f = await fixture(toolOnce('file.read', () => ({ path: 'outside' })), { approval: { async request() { prompted++; return { approved: true }; } } });
  f.registry.register({ ...fileTool(async () => { runs++; return ''; }), classify: () => ({ flags: { outsideRoots: true } }) });
  try { await assert.rejects(() => collect(f.provider, { ...req(), approver }), { code: 'approval-requires-person' }); assert.equal(prompted, 0); assert.equal(runs, 0); } finally { await f.close(); }
});

test('finding 8: a budget refusal in the repair round stops the turn before any repair call reaches the provider', async () => {
  let calls = 0, runs = 0;
  const f = await fixture({ async *stream() { calls++; f.budget.setLimit({ scope: 'global', id: '', period: 'day', metric: 'tokens', hard: 0 }); yield { type: 'done', result: result('', [{ id: 'c1', name: 'file.read', arguments: { path: 7 } as never, argumentsRaw: '{"path":7}' }]) }; } });
  f.registry.register(fileTool(async () => { runs++; return ''; }));
  try { await assert.rejects(() => collect(f.provider), { code: 'budget_exceeded' }); assert.equal(calls, 1); assert.equal(runs, 0); assert.deepEqual(f.budget.pendingReservations(), { live: 0, expired: 0 }); } finally { await f.close(); }
});

test('finding 8: composeTools fs deny-list refuses ~/.ssh/id_ed25519 through the turn dispatcher', async () => {
  const home = await mkdtemp(join(tmpdir(), 'turn-deny-')); const audit = memoryAuditSink(); const target = join(homedir(), '.ssh', 'id_ed25519');
  const registry = await composeTools({ home, roots: [{ id: 'a1', path: home }], grants: { get: () => undefined, list: () => [] }, audit }, req());
  const classified = await registry.get('file.read')!.classify!({ path: target });
  assert.equal(classified.flags?.denyListHit, true);
  const policy = memoryAuditSink();
  const f = await fixture(toolOnce('file.read', () => ({ path: target })), { registry, topK: 128, audit: createPolicyAudit({ sink: policy, clock: { now: Date.now } }), approval: { async request() { throw new Error('a deny-list hit is never asked'); } } });
  try { await assert.rejects(() => collect(f.provider), { code: 'tool-denied' }); assert.ok(policy.events.some(e => e.action === 'policy.decision' && JSON.stringify(e.detail).includes('deny-list'))); } finally { await f.close(); await rm(home, { recursive: true, force: true }); }
});

test('finding 8: exec.run through composition runs an allowlisted program after D109 approval', async () => {
  const home = await mkdtemp(join(tmpdir(), 'turn-exec-')); const r = await rig();
  const registry = await composeTools({ home, roots: [{ id: 'a1', path: home }], grants: r.stores.grants, audit: memoryAuditSink(), exec: { mode: 'allowlist', allowlist: [{ program: process.execPath }], envAllow: ['PATH'] } }, req());
  const f = await fixture(toolOnce('exec.run', () => ({ program: process.execPath, args: ['-e', 'console.log("exec via composition")'], cwd: home })), { registry, topK: 128, grants: r.stores.grants, grantUse: r.stores.grants,
    approval: { async request(ask) { const pending = r.service.request(ask); await tick(); const { id, nonce } = lastNonce(r); assert.equal(r.service.decide({ requestId: id, nonce, person: req().principal!, surface: 3, decision: 'approve' }).ok, true); return pending; }, begin: (answer, ask) => r.service.begin(answer, ask) } });
  try {
    const chunks = await collect(f.provider, { ...req(), approver: { person: req().principal!, surface: 3 } });
    const out = chunks.find(c => c.type === 'tool.result'); assert.ok(out && out.type === 'tool.result'); assert.match(out.output, /exec via composition/);
  } finally { r.service.dispose(); r.stores.close(); await f.close(); await rm(home, { recursive: true, force: true }); }
});
