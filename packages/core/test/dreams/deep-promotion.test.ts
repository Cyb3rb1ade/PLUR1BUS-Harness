import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCandidateSource, itemsFromEngineList } from '../../src/dreams/producer.ts';
import type { MemoryCard } from '@cyb3rb1ade/plur1bus-memory/types/engine.js';
import type { CandidatePromotionResult } from '../../src/dreams/types.ts';
import { harness, useTempDirs, T0, DAY } from './helpers.ts';

const dirs = useTempDirs('p1b-deep-promotion-');
const card = (id: string, text = id): Pick<MemoryCard, 'id' | 'text' | 'scope' | 'createdAt'> => ({ id, text, scope: 'agent-private', createdAt: T0 - 2 * DAY });
const stats = (id: string) => ({ id, recalls: 4, distinctQueries: 3, lastRecalledAt: T0 - 100 });

function source(o: { stats?: boolean; repeated?: boolean; receipt?: 'promoted' | 'skipped' | 'missing' | 'foreign' | 'already-promoted'; throws?: boolean } = {}) {
  return createCandidateSource({
    list: () => itemsFromEngineList({ truncated: false, items: o.repeated ? [card('memory-1', 'repeated fact'), card('memory-2', 'repeated fact')] : [card('memory-1')] }),
    ...(o.stats === false ? {} : { stats: async (agentId: string, ids: readonly string[]) => ({ agentId, items: ids.map(stats) }) }),
    promote: async (agentId: string, ids: readonly string[]): Promise<CandidatePromotionResult> => {
      if (o.throws) throw new Error('promotion unavailable');
      return { agentId: o.receipt === 'foreign' ? 'other' : agentId, items: o.receipt === 'missing' ? [] : ids.map((id) => ({ id, outcome: o.receipt === 'skipped' || o.receipt === 'already-promoted' ? 'skipped' : 'promoted', reason: o.receipt === 'already-promoted' ? 'already-promoted' : o.receipt === 'skipped' ? 'cap-reached' : 'integrated' })) };
    },
  });
}

describe('A3 real producer with Engine 1.17 contract fixture', () => {
  it('joins persistent recall statistics by the actual private memory id', async () => {
    const [item] = await source().pull('alpha');
    assert.equal(item?.memoryId, 'memory-1');
    assert.equal(item?.recalls, 4);
    assert.equal(item?.uniqueQueries, 3);
    assert.equal(item?.lastRecalledAt, T0 - 100);
    assert.equal(item?.createdAt, T0 - 2 * DAY);
  });

  it('runs all deep maintenance jobs when no candidate passes the recall gate', async () => {
    const h = harness(dirs, { over: { candidates: source({ stats: false, repeated: true }) } });
    h.captures('alpha', 3);
    const result = await h.sched.runPhase('alpha', 'deep', { trigger: 'manual' });
    assert.equal(result.outcome, 'completed');
    assert.deepEqual(h.engine.calls.map((c) => c.job), ['consolidate-daily', 'auto-accept-stale', 'gc-run']);
    assert.equal(h.store.listCandidates('alpha', 'promoted').length, 0);
    const decision = h.store.listCandidates('alpha')[0]!.decision as { fallback?: { eligible: boolean }; promote: boolean };
    assert.equal(decision.fallback?.eligible, true, 'records age and distinct source repetition without changing promotion eligibility');
    assert.equal(decision.promote, false);
  });

  it('promotes exact public-list cards without similarity scores only after a same-source Engine receipt', async () => {
    const h = harness(dirs, { over: { candidates: source() } });
    h.captures('alpha', 3);
    const result = await h.sched.runPhase('alpha', 'deep', { trigger: 'manual' });
    assert.equal(result.outcome, 'completed');
    assert.equal(result.counts.promoted, 1);
    assert.equal(h.store.listCandidates('alpha', 'promoted')[0]!.score, null, 'public since-listing has no similarity score; observed recall/query evidence suffices');
    const decision = h.store.listCandidates('alpha', 'promoted')[0]!.decision as { engine: { id: string; outcome: string } };
    assert.deepEqual({ id: decision.engine.id, outcome: decision.engine.outcome }, { id: 'memory-1', outcome: 'promoted' });
  });

  for (const receipt of ['skipped', 'missing', 'foreign'] as const) it(`does not promote on a ${receipt} Engine receipt`, async () => {
    const h = harness(dirs, { over: { candidates: source({ receipt }) } });
    h.captures('alpha', 3);
    const result = await h.sched.runPhase('alpha', 'deep', { trigger: 'manual' });
    assert.equal(result.counts.rejected, 0, 'the receipt closes promotion even when utility gates passed');
    assert.equal(h.store.listCandidates('alpha')[0]!.recalls, 4);
    assert.deepEqual(h.engine.calls.map((c) => c.job), ['consolidate-daily', 'auto-accept-stale', 'gc-run']);
    assert.equal(h.store.listCandidates('alpha', 'promoted').length, 0);
  });

  it('reconciles an already-promoted durable Engine receipt after a previous crash', async () => {
    const h = harness(dirs, { over: { candidates: source({ receipt: 'already-promoted' }) } });
    h.captures('alpha', 3);
    const result = await h.sched.runPhase('alpha', 'deep', { trigger: 'manual' });
    assert.equal(result.counts.promoted, 1);
    const decision = h.store.listCandidates('alpha', 'promoted')[0]!.decision as { engine: { reason: string } };
    assert.equal(decision.engine.reason, 'already-promoted');
  });

  it('keeps candidates unpromoted when Engine promotion throws, after maintenance ran', async () => {
    const h = harness(dirs, { over: { candidates: source({ throws: true }) } });
    h.captures('alpha', 3);
    const result = await h.sched.runPhase('alpha', 'deep', { trigger: 'manual' });
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(h.engine.calls.map((c) => c.job), ['consolidate-daily', 'auto-accept-stale', 'gc-run']);
    assert.equal(h.store.listCandidates('alpha', 'promoted').length, 0);
  });
});
