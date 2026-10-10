import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/session/store.ts';
import { TokenMeter, catalogWindow } from '../../src/session/tokens.ts';
import { createLlmSummarizer } from '../../src/session/summarizer.ts';
import { ToolPruner, defaultPrune } from '../../src/session/pruning.ts';
import { Compactor, defaultCompaction } from '../../src/session/compaction.ts';
import { TurnRunner } from '../../src/session/turn-loop.ts';
import { FakeChatProvider } from '../../src/session/provider.ts';
function rig() { const store = new SessionStore({ path: ':memory:' }); return { store, session: store.createSession({ kind: 'direct', agentId: 'a', owner: 'user:v1:test' }) }; }
function toolTurn(store: SessionStore, id: string, name = 'file.read', extra = {}) {
  const { turn } = store.beginTurn(id, 'old task', 2);
  const call = store.appendEvent(turn.id, 'tool.call', { id: turn.id, name, args: { path: 'example' }, ...extra });
  const result = store.appendEvent(turn.id, 'tool.result', { id: turn.id, output: 'data '.repeat(400) });
  store.completeTurn(turn.id, { text: 'finished', tokens: 2 }); return { turn, call, result };
}
function advance(store: SessionStore, id: string, reply = 'next task') { const { turn } = store.beginTurn(id, 'new task', 2); store.completeTurn(turn.id, { text: reply, tokens: 3 }); }
describe('M2 measured context', () => {
  it('reads the exact model window from a fake catalogue', () => {
    const catalog = { read: () => ({ models: [{ provider: 'local', id: 'small', contextWindow: 32000 }, { provider: 'other', id: 'small', contextWindow: 4000 }] }) };
    assert.equal(catalogWindow(catalog, { provider: 'local', model: 'small' }), 32000);
    assert.equal(catalogWindow(catalog, { provider: 'other', model: 'small' }), 4000);
    assert.equal(catalogWindow(catalog, { provider: 'local', model: 'missing' }), undefined);
  });
  it('persists moving calibration per model and prefers measured usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compaction-meter-'));
    try {
      let store = new SessionStore({ path: join(dir, 'sessions.sqlite') }); const meter = new TokenMeter(store);
      meter.observe('local/small', 100, 200); assert.equal(meter.count('local/small', 'x'.repeat(400)), 200);
      meter.observe('local/small', 100, 100); assert.equal(meter.count('local/small', 'x'.repeat(400)), 180);
      assert.equal(meter.count('other/small', 'x'.repeat(400)), 100); assert.equal(meter.count('local/small', 'x'.repeat(400), 17), 17);
      meter.observe('local/small', 0, 0); store.close(); store = new SessionStore({ path: join(dir, 'sessions.sqlite') });
      assert.equal(new TokenMeter(store).count('local/small', 'x'.repeat(400)), 180); store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
describe('M2 summarize role', () => {
  it('stages large segments then merges bounded summaries using only summarize', async () => {
    const calls: { role?: string; tools?: unknown }[] = [];
    const summarizer = createLlmSummarizer({ id: 'fake', async *stream(req) { calls.push(req); yield { type: 'delta', text: 'summary ' + 'x'.repeat(20) }; yield { type: 'usage', inputTokens: 10, outputTokens: 7 }; } }, { sessionId: 's', agentId: 'a', principal: 'p', signal: new AbortController().signal }, 80);
    const text = await summarizer(Array.from({ length: 12 }, (_, seq) => ({ role: 'user' as const, seq, text: 'x'.repeat(160) })), 40);
    assert.ok(calls.length > 2); assert.ok(calls.every(c => c.role === 'summarize' && !c.tools)); assert.ok(text.length <= 160); assert.match(text, /summary/);
  });
  it('budget refusal and absent model fall back to a marked digest referencing originals', async () => {
    for (const absent of [false, true]) {
      const { store, session } = rig(); for (let i = 0; i < 12; i++) { const { turn } = store.beginTurn(session.id, 'question '.repeat(60), 120); store.completeTurn(turn.id, { text: 'answer '.repeat(60), tokens: 120 }); }
      const provider = { id: 'refused', async *stream(): AsyncGenerator<never> { throw Error('budget_exceeded'); } };
      const c = new Compactor(store, defaultCompaction(2000), { summarizer: absent ? undefined : createLlmSummarizer(provider, { sessionId: session.id, agentId: 'a', principal: 'p', signal: new AbortController().signal }) });
      await c.afterTurn(session.id); const summary = store.listSummaries(session.id, 'prepared')[0]!;
      assert.match(summary.text, /summary.*originals/i); assert.ok(summary.tokens <= c.cfg.summaryMaxTokens); assert.ok(summary.fromSeq < summary.toSeq); store.close();
    }
  });
  it('hard limit never invokes an LLM and retains newest message', async () => {
    const { store, session } = rig(); for (let i = 0; i < 20; i++) advance(store, session.id, 'x'.repeat(2000)); const newest = store.beginTurn(session.id, 'q', 1);
    const c = new Compactor(store, defaultCompaction(1000), { summarizer: async () => { throw Error('must not be called'); } }); const view = await c.prepare(session.id);
    assert.ok(view.tokens <= c.hardLimit); assert.ok(view.messages.some(m => m.id === newest.message.id)); store.close();
  });
});
describe('M2 reversible pruning', () => {
  it('batches Laya yes/no, preserves original bytes, restores and pins references', async () => {
    const { store, session } = rig(); const old = toolTurn(store, session.id); const keep = toolTurn(store, session.id); advance(store, session.id);
    const before = JSON.stringify(store.listEvents(session.id)); const events: string[] = [];
    const pruner = new ToolPruner(store, { ...defaultPrune(), keepLastTurns: 1, batchSize: 2 }, { decide: async batch => batch.map(p => ({ ref: p.ref, relevant: p.ref === `event:${keep.call.seq}`, reason: 'task relevance' })), emit: type => events.push(type) });
    assert.equal(await pruner.run(session.id), 1); const view = pruner.view(session.id);
    assert.equal(view.find(p => p.ref === `event:${old.call.seq}`)!.hidden, true);
    assert.equal(view.find(p => p.ref === `event:${keep.call.seq}`)!.text, JSON.stringify({ call: keep.call.data, result: keep.result.data }));
    assert.equal(JSON.stringify(store.listEvents(session.id)), before); assert.ok(pruner.restore(session.id, `event:${old.call.seq}`));
    assert.equal(pruner.view(session.id).find(p => p.ref === `event:${old.call.seq}`)!.hidden, false);
    assert.deepEqual(events, ['compaction.prune.hidden', 'compaction.prune.restored']); assert.equal(await pruner.run(session.id), 0); store.close();
  });
  it('protects recent turns, assistant references and approval/audit entries', async () => {
    const { store, session } = rig(); const ref = toolTurn(store, session.id); toolTurn(store, session.id, 'approval.decide'); toolTurn(store, session.id, 'file.read', { auditRelevant: true }); toolTurn(store, session.id); advance(store, session.id, `use ${ref.turn.id} and event:${ref.result.seq}`);
    const seen: string[] = []; const pruner = new ToolPruner(store, { ...defaultPrune(), keepLastTurns: 2 }, { decide: async batch => { seen.push(...batch.map(p => p.ref)); return batch.map(p => ({ ref: p.ref, relevant: false, reason: 'old' })); } });
    assert.equal(await pruner.run(session.id), 0); assert.deepEqual(seen, []); assert.ok(pruner.view(session.id).every(p => !p.hidden)); store.close();
  });
  it('timeout and invalid/partial responses hide nothing, including late replies', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); const { store, session } = rig(); toolTurn(store, session.id); advance(store, session.id);
    let resolve!: (v: { ref: string; relevant: boolean; reason: string }[]) => void;
    const pruner = new ToolPruner(store, { ...defaultPrune(), keepLastTurns: 1, maxMs: 10 }, { decide: () => new Promise(r => { resolve = r; }) });
    const job = pruner.run(session.id); t.mock.timers.tick(11); assert.equal(await job, 0); resolve([{ ref: 'event:2', relevant: false, reason: 'late' }]); await Promise.resolve();
    assert.ok(pruner.view(session.id).every(p => !p.hidden)); const partial = new ToolPruner(store, { ...defaultPrune(), keepLastTurns: 1 }, { decide: async () => [] }); assert.equal(await partial.run(session.id), 0); store.close();
  });
  it('missing Laya uses age/size heuristic; off hides nothing', async () => {
    const { store, session } = rig(); toolTurn(store, session.id); advance(store, session.id);
    assert.equal(await new ToolPruner(store, { ...defaultPrune(), keepLastTurns: 1, decider: 'off' }).run(session.id), 0);
    assert.equal(await new ToolPruner(store, { ...defaultPrune(), keepLastTurns: 1 }).run(session.id), 1); store.close();
  });
  it('a new reference during the Laya await protects the original', async () => {
    const { store, session } = rig(); const old = toolTurn(store, session.id); advance(store, session.id); let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const pruner = new ToolPruner(store, { ...defaultPrune(), keepLastTurns: 1 }, { decide: async batch => { await gate; return batch.map(p => ({ ref: p.ref, relevant: false, reason: 'old' })); } });
    const job = pruner.run(session.id); advance(store, session.id, `use ${old.turn.id}`); release(); assert.equal(await job, 0); store.close();
  });
  it('post-turn work starts after completion and cannot delay the turn promise', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); const { store, session } = rig(); const compactor = new Compactor(store); let started = false; let release!: () => void;
    compactor.afterTurn = async () => { started = true; await new Promise<void>(r => { release = r; }); return { prepared: false }; };
    const runner = new TurnRunner({ store, compactor, provider: () => new FakeChatProvider(), memory: { recall: async () => ({ text: '', degraded: null }), capture: async () => {}, checkpoint: async () => {} } });
    const out = await runner.submit({ session, caller: { channel: 'cli', accountId: 'local', userId: 'owner' }, text: 'hello' }).done;
    assert.equal(out.state, 'completed'); assert.equal(started, false); t.mock.timers.tick(0); assert.equal(started, true); release(); await runner.idle(); store.close();
  });
});
it('summary tiers merge the previous summary through the fake model and respect calibration', async () => {
  const { store, session } = rig(); const inputs: string[][] = [];
  const c = new Compactor(store, defaultCompaction(1000), { summarizer: async messages => { inputs.push(messages.map(m => m.text)); return 'kept task facts'; } });
  c.configureModel(session.id,'local/small',1000); c.meter.observe('local/small',100,200);
  for (let i = 0; i < 8; i++) advance(store,session.id,'x'.repeat(800));
  await c.afterTurn(session.id); await c.prepare(session.id);
  const previous = store.listSummaries(session.id,'applied')[0]!;
  for (let i = 0; i < 8; i++) advance(store,session.id,'y'.repeat(800));
  await c.afterTurn(session.id);
  const next = store.listSummaries(session.id,'prepared')[0]!;
  assert.ok(inputs.at(-1)!.includes(previous.text)); assert.ok(next.tier > previous.tier); assert.ok(next.tokens <= c.configFor(session.id).summaryMaxTokens);
  await c.prepare(session.id); assert.equal(store.listSummaries(session.id,'applied').length,1); store.close();
});
it('a newly referenced hidden result is visible in the context without rewriting original events', async () => {
  const { store,session } = rig(); const pair = toolTurn(store,session.id); advance(store,session.id);
  const pruner = new ToolPruner(store,{ ...defaultPrune(),keepLastTurns:1 }); await pruner.run(session.id);
  const c = new Compactor(store,defaultCompaction(),{ pruner }); assert.equal(c.view(session.id).hidden.length,1);
  const original = JSON.stringify(store.toolEvents(session.id)); advance(store,session.id,`reuse ${pair.turn.id}`);
  assert.equal(c.view(session.id).hidden.length,0); assert.equal(JSON.stringify(store.toolEvents(session.id)),original); store.close();
});
it('visibility persists over restart and restoration preserves transcript bytes', () => {
  const dir = mkdtempSync(join(tmpdir(),'compaction-visibility-'));
  try {
    let store = new SessionStore({ path: join(dir,'s.sqlite') }); const session = store.createSession({ kind:'direct',agentId:'a',owner:'user:v1:test' }); const pair = toolTurn(store,session.id); advance(store,session.id);
    const before = JSON.stringify({ messages:store.listMessages(session.id), events:store.listEvents(session.id) });
    store.setToolVisibility(session.id,`event:${pair.call.seq}`,true,'old'); store.close(); store = new SessionStore({ path: join(dir,'s.sqlite') });
    const p = new ToolPruner(store,{ ...defaultPrune(),keepLastTurns:1 }); assert.ok(p.view(session.id)[0]!.hidden); p.restore(session.id,`event:${pair.call.seq}`);
    assert.equal(JSON.stringify({ messages:store.listMessages(session.id),events:store.listEvents(session.id) }),before); store.close();
  } finally { rmSync(dir,{ recursive:true,force:true }); }
});
it('fake Laya null budget/unavailable uses heuristic, malformed yes/no retains originals', async () => {
  const { store,session } = rig(); toolTurn(store,session.id); advance(store,session.id);
  const invalid = new ToolPruner(store,{ ...defaultPrune(),keepLastTurns:1 },{ decide: async batch => batch.map(p => ({ ref:p.ref,relevant:'no' as unknown as boolean,reason:'old' })) });
  assert.equal(await invalid.run(session.id),0);
  const absent = new ToolPruner(store,{ ...defaultPrune(),keepLastTurns:1 },{ decide:async () => null }); assert.equal(await absent.run(session.id),1); store.close();
});
it('shutdown discards an in-flight LLM summary and never writes a late digest', async () => {
  const { store,session } = rig(); for (let i=0;i<12;i++) advance(store,session.id,'x'.repeat(1600));
  let release!: () => void; const gate = new Promise<void>(resolve => { release=resolve; });
  const c = new Compactor(store,defaultCompaction(1000),{ summarizer:async () => { await gate; return 'late'; } });
  const job = c.afterTurn(session.id); await Promise.resolve(); c.stop(); release(); assert.deepEqual(await job,{ prepared:false }); assert.equal(store.listSummaries(session.id).length,0); store.close();
});
it('a later batch timeout commits no visibility changes from earlier batches', async t => {
  t.mock.timers.enable({apis:['setTimeout']}); const {store,session}=rig(); toolTurn(store,session.id); toolTurn(store,session.id); advance(store,session.id);
  let batches=0; const second=Promise.withResolvers<void>();
  const p=new ToolPruner(store,{...defaultPrune(),keepLastTurns:1,batchSize:1,maxMs:10},{decide:async batch=>{batches++; if(batches===2){second.resolve(); await new Promise(()=>{});} return batch.map(pair=>({ref:pair.ref,relevant:false,reason:'old'}));}});
  const job=p.run(session.id); await second.promise; t.mock.timers.tick(11); assert.equal(await job,0); assert.ok(p.view(session.id).every(pair=>!pair.hidden)); store.close();
});

it('unpaired calls are not pruning candidates and remain visible in the context', async () => {
  const {store,session}=rig(); const {turn}=store.beginTurn(session.id,'unfinished tool',4); const call=store.appendEvent(turn.id,'tool.call',{id:'pending',name:'file.read',args:{path:'example'}}); store.failTurn(turn.id,'interrupted'); advance(store,session.id);
  const p=new ToolPruner(store,{...defaultPrune(),keepLastTurns:1},{decide:async()=>{throw Error('must not inspect pending calls');}});
  assert.equal(await p.run(session.id),0); const c=new Compactor(store,defaultCompaction(),{pruner:p}); assert.ok(c.view(session.id).messages.some(m=>m.id===`event:${call.seq}`&&m.text.includes('pending'))); store.close();
});
