import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Compactor, defaultCompaction, estimateTokens } from '../../src/session/compaction.ts';
import { SessionStore } from '../../src/session/store.ts';
import { ToolPruner, defaultPrune } from '../../src/session/pruning.ts';

const OWNER = 'user:v1:o';
const MODEL = 'local/small';

function rig() {
  const store = new SessionStore({ path: ':memory:' });
  const session = store.createSession({ kind: 'direct', agentId: 'a', owner: OWNER });
  return { store, sessionId: session.id };
}

function turn(store: SessionStore, sessionId: string, question: string, answer: string) {
  const { turn: t } = store.beginTurn(sessionId, question, estimateTokens(question));
  store.completeTurn(t.id, { text: answer, tokens: estimateTokens(answer) });
  return t;
}

function toolTurn(store: SessionStore, sessionId: string) {
  const { turn: t } = store.beginTurn(sessionId, 'read the file', 4);
  const call = store.appendEvent(t.id, 'tool.call', { id: t.id, name: 'file.read', args: { path: 'example' } });
  store.appendEvent(t.id, 'tool.result', { id: t.id, output: 'data '.repeat(400) });
  store.completeTurn(t.id, { text: 'finished', tokens: 2 });
  return { turn: t, call };
}

function advance(store: SessionStore, sessionId: string) {
  const { turn: t } = store.beginTurn(sessionId, 'new task', 2);
  store.completeTurn(t.id, { text: 'next task', tokens: 3 });
}

describe('compaction measured tokens', () => {
  it('the context view counts a recorded measured usage for a message instead of the estimate', () => {
    const { store, sessionId } = rig();
    const q = turn(store, sessionId, 'q'.repeat(400), 'a'.repeat(200));
    const user = store.listMessages(sessionId).find(m => m.turnId === q.id && m.role === 'user')!;
    const c = new Compactor(store, defaultCompaction(1000));
    c.configureModel(sessionId, MODEL);
    assert.equal(c.view(sessionId).tokens, 100 + 50);
    store.recordMessageUsage(user.id, MODEL, 7);
    const view = c.view(sessionId);
    assert.equal(view.tokens, 7 + 50);
    assert.equal(view.messages.find(m => m.id === user.id)!.text, 'q'.repeat(400));
    store.close();
  });

  it('a measured overflow triggers the hard swap even when the character estimate is small', async () => {
    const { store, sessionId } = rig();
    const first = turn(store, sessionId, 'old question', 'old answer');
    turn(store, sessionId, 'new question', 'new answer');
    const oldUser = store.listMessages(sessionId).find(m => m.turnId === first.id && m.role === 'user')!;
    store.recordMessageUsage(oldUser.id, MODEL, 5000);
    const c = new Compactor(store, defaultCompaction(1000));
    c.configureModel(sessionId, MODEL);
    const v = await c.prepare(sessionId);
    assert.equal(v.compaction.swapped, true);
    assert.ok((v.compaction.tokensBefore ?? 0) >= 5000);
    assert.ok(v.tokens <= c.hardLimit);
    assert.equal(store.listSummaries(sessionId, 'applied').length, 1);
    store.close();
  });
});

describe('compaction hide, do not delete', () => {
  it('hiding a stale tool output deletes nothing: the transcript is byte-identical and the view shows only a pointer', async () => {
    const { store, sessionId } = rig();
    toolTurn(store, sessionId);
    advance(store, sessionId);
    const before = JSON.stringify({ events: store.listEvents(sessionId), messages: store.listMessages(sessionId) });
    const pruner = new ToolPruner(store, { ...defaultPrune(), keepLastTurns: 1 }, {
      decide: async batch => batch.map(p => ({ ref: p.ref, relevant: false, reason: 'old' })),
    });
    assert.equal(await pruner.run(sessionId), 1);
    const c = new Compactor(store, defaultCompaction(), { pruner });
    const view = c.view(sessionId);
    assert.equal(view.hidden.length, 1);
    assert.equal(view.hidden[0]!.reason, 'old');
    const shown = view.messages.find(m => m.role === 'tool')!;
    assert.match(shown.text, /^\[tool output hidden; originals event:\d+/);
    assert.ok(!shown.text.includes('data data'), 'the hidden output must not reach the context');
    assert.equal(JSON.stringify({ events: store.listEvents(sessionId), messages: store.listMessages(sessionId) }), before);
    store.close();
  });

  it('restoring a hidden output brings its text back into the view once, without rewriting the transcript', async () => {
    const { store, sessionId } = rig();
    const pair = toolTurn(store, sessionId);
    advance(store, sessionId);
    const pruner = new ToolPruner(store, { ...defaultPrune(), keepLastTurns: 1 }, {
      decide: async batch => batch.map(p => ({ ref: p.ref, relevant: false, reason: 'old' })),
    });
    await pruner.run(sessionId);
    const ref = `event:${pair.call.seq}`;
    const before = JSON.stringify(store.listEvents(sessionId));
    assert.equal(pruner.restore(sessionId, ref), true);
    assert.equal(pruner.restore(sessionId, ref), false, 'a second restore has nothing to undo');
    assert.equal(pruner.restore(sessionId, 'event:99999'), false);
    const c = new Compactor(store, defaultCompaction(), { pruner });
    const view = c.view(sessionId);
    assert.equal(view.hidden.length, 0);
    assert.ok(view.messages.some(m => m.text.includes('data data')), 'the restored output is back in the context');
    assert.equal(JSON.stringify(store.listEvents(sessionId)), before);
    store.close();
  });

  it('a swap moves summarized messages out of the view and deletes no message from the transcript', async () => {
    const { store, sessionId } = rig();
    for (let i = 0; i < 12; i++) turn(store, sessionId, `q${i} ${'x'.repeat(800)}`, `a${i} ${'y'.repeat(800)}`);
    const ids = store.listMessages(sessionId).map(m => m.id);
    const c = new Compactor(store, defaultCompaction(1000));
    const v = await c.prepare(sessionId);
    assert.equal(v.compaction.swapped, true);
    assert.deepEqual(store.listMessages(sessionId).map(m => m.id), ids);
    const [applied] = store.listSummaries(sessionId, 'applied');
    assert.ok(applied);
    assert.ok(v.messages.every(m => m.seq > applied.toSeq), 'summarized messages are out of the view');
    assert.ok(applied.text.includes('originals messages'), 'the summary points at the transcript');
    store.close();
  });
});

describe('compaction without summarize configuration', () => {
  it('no summarizer wired: the soft-threshold summary is the deterministic digest, one line per message', async () => {
    const { store, sessionId } = rig();
    for (let i = 0; i < 12; i++) turn(store, sessionId, `q${i} ${'x'.repeat(800)}`, `a${i} ${'y'.repeat(800)}`);
    const c = new Compactor(store, defaultCompaction(2000));
    assert.equal((await c.afterTurn(sessionId)).prepared, true);
    const [prepared] = store.listSummaries(sessionId, 'prepared');
    assert.ok(prepared);
    assert.match(prepared.text, /^\[summary; originals messages \d+-\d+ in transcript\]\n/);
    assert.match(prepared.text, /user#\d+: q\d+ x/);
    assert.match(prepared.text, /assistant#\d+: a\d+ y/);
    store.close();
  });

  it("summarizer 'digest' never calls a wired summarizer", async () => {
    const { store, sessionId } = rig();
    for (let i = 0; i < 12; i++) turn(store, sessionId, `q${i} ${'x'.repeat(800)}`, `a${i} ${'y'.repeat(800)}`);
    let called = 0;
    const c = new Compactor(store, { ...defaultCompaction(2000), summarizer: 'digest' }, {
      summarizer: async () => { called++; return 'MODEL OUTPUT'; },
    });
    assert.equal((await c.afterTurn(sessionId)).prepared, true);
    assert.equal(called, 0);
    assert.ok(!store.listSummaries(sessionId, 'prepared')[0]!.text.includes('MODEL OUTPUT'));
    store.close();
  });

  it('configureModel without a window keeps the global bounds unchanged', () => {
    const { store, sessionId } = rig();
    const c = new Compactor(store, defaultCompaction(8192));
    c.configureModel(sessionId, MODEL);
    assert.deepEqual(c.configFor(sessionId), c.cfg);
    store.close();
  });

  it('configureModel with a small window clamps the summary and message bounds to that window', () => {
    const { store, sessionId } = rig();
    const c = new Compactor(store, defaultCompaction(8192));
    c.configureModel(sessionId, MODEL, 1000);
    assert.equal(c.configFor(sessionId).windowTokens, 1000);
    assert.equal(c.configFor(sessionId).summaryMaxTokens, 150);
    assert.equal(c.configFor(sessionId).maxMessageTokens, 100);
    assert.equal(c.hardLimit, Math.floor(8192 * 0.88), 'the global limits are untouched for other sessions');
    store.close();
  });

  it('invalid compaction configuration is refused at construction', () => {
    const { store } = rig();
    const base = defaultCompaction(1000);
    const bad = [
      { ...base, windowTokens: 0 },
      { ...base, softRatio: 0.9, hardRatio: 0.88 },
      { ...base, hardRatio: 1 },
      { ...base, maxMessageTokens: -1 },
      { ...base, summaryMaxTokens: 1.5 },
    ];
    for (const cfg of bad) assert.throws(() => new Compactor(store, cfg), /invalid compaction config/);
    store.close();
  });
});
