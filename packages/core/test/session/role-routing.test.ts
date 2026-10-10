import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoleProvider } from '../../src/session/role-routing.ts';
import { createTurnProvider } from '../../src/composition/provider.ts';
import { createCallBudget, PriceBook, SHIPPED_PRICE_TABLES } from '../../src/budget/index.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import type { ChatRequest } from '../../src/session/provider.ts';
import { ProviderError } from '../../../providers/src/index.ts';
import type { ChatRequest as WireRequest } from '../../../providers/src/index.ts';
const request = (): ChatRequest => ({ sessionId: 's', agentId: 'a', principal: 'user:v1:test', role: 'summarize', maxOutputTokens: 40, summaries: [], memory: '', messages: [{ role: 'user', text: 'summarize these facts' }], signal: new AbortController().signal });
function fixture() {
  const calls: WireRequest[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'compaction-role-'));
  const budget = createCallBudget({ path: join(dir,'budget.sqlite'), clock: { now: Date.now }, prices: new PriceBook(SHIPPED_PRICE_TABLES) });
  const adapter = { async *stream(req: WireRequest) { calls.push(req); yield { type: 'text_delta' as const, text: 'summary' }; yield { type: 'done' as const, result: { text: 'summary', toolCalls: [], finishReason: 'stop' as const, rawFinishReason: 'stop', usage: { inputTokens: 20, outputTokens: 2 }, meta: {} } }; } };
  const registry = new ToolRegistry(); let approvals = 0;
  const options = { profiles: { default: [{ provider: 'fixture', model: 'gpt-4.1', adapter }], cheap: [{ provider: 'fixture', model: 'gpt-4.1-mini', adapter }] }, profileForClass: () => 'default', registry, budget, approval: { request: async () => { approvals++; return { approved: false }; } }, grants: { get: () => undefined, list: () => [] }, log: () => {}, resultStore: { put: async () => 'result:fixture' } };
  return { calls, budget, options, close() { budget.close(); rmSync(dir,{ recursive:true, force:true }); }, approvals: () => approvals };
}
it('summarize role selects its configured profile through real router and budget, without tools', async () => {
  const f = fixture(); const provider = createSessionRoleProvider(createTurnProvider, f.options, { summarize: 'cheap' }, 40);
  try {
    const chunks = []; for await (const c of provider.stream(request())) chunks.push(c);
    assert.equal(f.calls[0]!.model, 'gpt-4.1-mini'); assert.deepEqual(f.calls[0]!.tools, []); assert.equal(f.calls[0]!.maxTokens, 40); assert.equal(f.approvals(), 0);
    const usage = chunks.find(c => c.type === 'usage'); assert.equal(usage?.type === 'usage' && usage.model, 'fixture/gpt-4.1-mini');
    assert.deepEqual(provider.contextModels?.('read files'), [{ provider: 'fixture', model: 'gpt-4.1' }]);
    f.budget.setLimit({ scope: 'global', id: '', period: 'day', metric: 'tokens', hard: 0 });
    await assert.rejects(async () => { for await (const c of provider.stream(request())) void c; }, { code: 'budget_exceeded' }); assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});
it('unavailable summarize role never silently uses default profile', async () => {
  const f = fixture(); const provider = createSessionRoleProvider(createTurnProvider, f.options, {}, 40);
  try { await assert.rejects(async () => { for await (const c of provider.stream(request())) void c; }, /summary-model-unavailable/); assert.equal(f.calls.length, 0); } finally { f.close(); }
});
it('summarize model id resolves exact provider/model', async () => {
  const f = fixture(); const provider = createSessionRoleProvider(createTurnProvider, f.options, { summarize: 'fixture/gpt-4.1-mini' }, 40);
  try { for await (const c of provider.stream(request())) void c; assert.equal(f.calls[0]!.model, 'gpt-4.1-mini'); } finally { f.close(); }
});

it('summarize cannot cross plan/paid billing without profile opt-in', async () => {
  const f = fixture(); let paidCalls = 0; const events:string[]=[];
  const profiles = { cheap: [{ provider: 'plan', model: 'gpt-4.1-mini', adapter: { async *stream(): AsyncGenerator<never> { throw new ProviderError('network','unavailable'); } } }, { provider: 'paid', model: 'gpt-4.1', adapter: { async *stream(req: WireRequest) { paidCalls++; yield* f.options.profiles.default[0]!.adapter.stream(req); } } }] };
  const provider = createSessionRoleProvider(createTurnProvider, { ...f.options, profiles, onRouterEvent:e=>events.push(e.type), billing: { plan: 'plan', paid: 'paid' }, router: { retry: { maxRetries:0 }, clock: { now: Date.now, sleep: async () => {} } } }, { summarize: 'cheap' }, 40);
  try { await assert.rejects(async () => { for await (const c of provider.stream(request())) void c; }); assert.equal(paidCalls,0); assert.ok(events.includes('provider.cross_billing_refused')); } finally { f.close(); }
});
it('without summarize configuration foreground wire bodies and replies retain existing behavior', async () => {
  const plain = fixture(), wrapped = fixture();
  try {
    const req = request(); delete req.role;
    const collect = async (provider: { stream(req: ChatRequest): AsyncIterable<import('../../src/session/provider.ts').ChatChunk> }) => {
      const chunks = []; for await (const c of provider.stream(req)) chunks.push(c.type === 'usage' ? { type: c.type, inputTokens: c.inputTokens, outputTokens: c.outputTokens } : c); return chunks;
    };
    assert.deepEqual(await collect(createSessionRoleProvider(createTurnProvider,wrapped.options,{},40)),await collect(createTurnProvider(plain.options)));
    assert.deepEqual(wrapped.calls,plain.calls); assert.equal(wrapped.approvals(),plain.approvals());
  } finally { plain.close(); wrapped.close(); }
});
it('an exact summarize model keeps its profile fallback order and measured served model', async () => {
  const f=fixture(); let fallback=0;
  const profiles={cheap:[{provider:'first',model:'gpt-4.1-mini',adapter:{async *stream():AsyncGenerator<never>{throw new ProviderError('network','unavailable');}}},{provider:'second',model:'gpt-4.1',adapter:{async *stream(req:WireRequest){fallback++; yield* f.options.profiles.default[0]!.adapter.stream(req);}}}]};
  const p=createSessionRoleProvider(createTurnProvider,{...f.options,profiles,billing:{first:'paid',second:'paid'},router:{retry:{maxRetries:0},clock:{now:Date.now,sleep:async()=>{}}}},{summarize:'first/gpt-4.1-mini'},40);
  try {let served=''; for await(const c of p.stream(request())) if(c.type==='usage') served=c.model??''; assert.equal(fallback,1); assert.equal(served,'second/gpt-4.1');} finally{f.close();}
});
