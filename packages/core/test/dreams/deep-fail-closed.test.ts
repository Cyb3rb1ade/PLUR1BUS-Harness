import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCandidateSource, itemsFromEngineList } from '../../src/dreams/producer.ts';
import { evaluateFallback } from '../../src/dreams/candidates.ts';
import { harness, useTempDirs, T0, DAY } from './helpers.ts';

const dirs = useTempDirs('p1b-deep-closed-');
const current = { memoryId: 'm1', content: 'durable private fact', partition: 'agent-private', recalls: 4, uniqueQueries: 3 };
const jobs = ['consolidate-daily', 'auto-accept-stale', 'gc-run'];

describe('A3 independent maintenance and fail-closed promotion', () => {
  it('runs all three maintenance jobs even with an empty producer result', async () => {
    const h = harness(dirs, { over: { candidates: createCandidateSource({ list: () => [] }) } });
    h.captures('alpha', 3);
    const result = await h.sched.runPhase('alpha', 'deep', { trigger: 'manual' });
    assert.equal(result.outcome, 'completed');
    assert.deepEqual(h.engine.calls.map((c) => c.job), jobs);
    assert.equal(result.counts.promoted, 0);
  });

  it('keeps a qualified candidate shortlisted when the pinned contract has no promotion API', async () => {
    const h = harness(dirs, { over: { candidates: createCandidateSource({ list: () => [current] }) } });
    h.captures('alpha', 3);
    const result = await h.sched.runPhase('alpha', 'deep', { trigger: 'manual' });
    assert.equal(result.outcome, 'completed');
    assert.equal(result.counts.rejected, 0);
    assert.equal(result.counts.promotionUnavailable, 1);
    assert.equal(h.store.listCandidates('alpha', 'promoted').length, 0);
  });

  it('does not reconstruct a source id from a qualified legacy ledger card', async () => {
    let submitted = false;
    const { memoryId: _id, ...noId } = current;
    const h = harness(dirs, { over: { candidates: {
      pull: () => [noId], promote: async (agentId) => { submitted = true; return { agentId, items: [] }; },
    } } });
    h.captures('alpha', 3);
    await h.sched.runPhase('alpha', 'deep', { trigger: 'manual' });
    assert.equal(submitted, false);
    assert.equal(h.store.listCandidates('alpha', 'promoted').length, 0);
  });

  it('leaves the ledger shortlisted while awaiting confirmation and records the explicit source id', async () => {
    const h = harness(dirs);
    h.sched = h.make({ candidates: {
      pull: () => [current],
      promote: async (agentId, ids) => {
        assert.deepEqual(ids, ['m1']);
        assert.deepEqual(h.engine.calls.map((c) => c.job), jobs);
        assert.equal(h.store.listCandidates('alpha', 'promoted').length, 0);
        return { agentId, items: [{ id: 'm1', outcome: 'promoted', reason: 'integrated' }] };
      },
    } });
    h.captures('alpha', 3);
    assert.equal((await h.sched.runPhase('alpha', 'deep', { trigger: 'manual' })).counts.promoted, 1);
  });

  it('finishes maintenance and reports a failed candidate read on a truncated corpus', async () => {
    const h = harness(dirs, { over: { candidates: createCandidateSource({
      list: () => itemsFromEngineList({ items: [], truncated: true }),
    }) } });
    h.captures('alpha', 3);
    const result = await h.sched.runPhase('alpha', 'deep', { trigger: 'manual' });
    assert.equal(result.outcome, 'failed');
    assert.match(result.error!.message, /truncated/);
    assert.deepEqual(h.engine.calls.map((c) => c.job), jobs);
    assert.equal(h.store.listCandidates('alpha', 'promoted').length, 0);
  });

  it('does not advance the ledger after cancellation during Engine promotion', async () => {
    const abort = new AbortController();
    const h = harness(dirs, { over: { candidates: {
      pull: () => [current],
      promote: async (agentId) => {
        abort.abort();
        return { agentId, items: [{ id: 'm1', outcome: 'promoted', reason: 'integrated' }] };
      },
    } } });
    h.captures('alpha', 3);
    assert.equal((await h.sched.runPhase('alpha', 'deep', { trigger: 'manual', signal: abort.signal })).outcome, 'aborted');
    assert.equal(h.store.listCandidates('alpha', 'promoted').length, 0);
  });
});

describe('A3 source statistics and fallback signal integrity', () => {
  for (const items of [
    [{ id: 'm1', recalls: -1, distinctQueries: 3, lastRecalledAt: null }],
    [{ id: 'other', recalls: 4, distinctQueries: 3, lastRecalledAt: null }],
    [1, 2].map(() => ({ id: 'm1', recalls: 4, distinctQueries: 3, lastRecalledAt: null })),
  ]) it(`refuses malformed or out-of-request persistent statistics: ${JSON.stringify(items)}`, async () => {
    const producer = createCandidateSource({ list: () => [current], stats: async (agentId) => ({ agentId, items }) });
    await assert.rejects(async () => producer.pull('alpha'), /invalid Engine recall statistics/);
  });

  it('does not preserve list-supplied counters when the authoritative stats response omits that id', async () => {
    const producer = createCandidateSource({ list: () => [current], stats: async (agentId) => ({ agentId, items: [] }) });
    const [item] = await producer.pull('alpha');
    assert.equal(item?.recalls, undefined);
    assert.equal(item?.uniqueQueries, undefined);
  });

  it('refuses recall statistics from another agent', async () => {
    const producer = createCandidateSource({ list: () => [current], stats: async () => ({ agentId: 'other', items: [] }) });
    await assert.rejects(async () => producer.pull('alpha'), /invalid Engine recall statistics agent/);
  });

  it('counts repetitions only across distinct private source cards, not duplicate ids or shared copies', () => {
    const card = (id: string, scope = 'agent-private') => ({ id, text: 'same', scope, createdAt: T0 - 2 * DAY });
    const duplicate = itemsFromEngineList({ truncated: false, items: [card('m1'), card('m1'), card('shared', 'workspace')] });
    assert.equal(duplicate[0]?.repetitions, undefined);
    const distinct = itemsFromEngineList({ truncated: false, items: [card('m1'), card('m2')] });
    assert.equal(distinct[0]?.repetitions, 2);
    assert.equal(evaluateFallback(distinct[0]!, T0).eligible, true);
  });

  it('never substitutes search score, missing age or future timestamps for fallback evidence', () => {
    for (const item of [{ score: 1 }, { importance: 1 }, { createdAt: T0 + DAY, importance: 1 }, { createdAt: T0 - 100, repetitions: 10 }]) {
      assert.equal(evaluateFallback(item, T0).eligible, false);
    }
    assert.equal(evaluateFallback({ createdAt: T0 - 2 * DAY, importance: 0.8 }, T0).eligible, true);
    assert.equal(evaluateFallback({ createdAt: T0 - 2 * DAY, repetitions: 2 }, T0).eligible, true);
  });
});
