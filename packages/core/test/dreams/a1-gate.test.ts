// RE-D167 (T6 fix 1): the dreams use A1 recall statistics and promotion only behind the engine's flags, read per run.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContext, MemoryCard, Principal } from '@cyb3rb1ade/plur1bus-memory/types/engine.js';
import { a1CandidateMemory, createCandidateSource, itemsFromEngineList } from '../../src/dreams/producer.ts';
import { harness, useTempDirs, T0, DAY } from './helpers.ts';

const dirs = useTempDirs('p1b-dreams-a1-gate-');
const card = (id: string): Pick<MemoryCard, 'id' | 'text' | 'scope' | 'createdAt'> => ({ id, text: id, scope: 'agent-private', createdAt: T0 - 2 * DAY });
const principal = { agentId: 'alpha' } as Principal;
const context: AgentContext = { origin: 'system', background: false };

/** An engine as the Core sees it: `capabilities` is the last known handshake, the A1 methods always exist (as on EngineClient). */
function engine(flags: { recallStats?: boolean; knowledgePromotion?: boolean }) {
  const calls = { stats: 0, promote: 0 };
  const capabilities: Record<string, boolean> = { memoryLink: true, ...flags };
  const memory = {
    async stats(ids: readonly string[] | undefined) { calls.stats++; return { agentId: 'alpha', items: (ids ?? []).map((id) => ({ id, recalls: 4, distinctQueries: 3, lastRecalledAt: T0 - 100 })) }; },
    async promote(request: { ids: readonly string[] }) { calls.promote++; return { agentId: 'alpha', items: request.ids.map((id) => ({ id, outcome: 'promoted' as const, reason: 'integrated' })) }; },
  };
  const ports = a1CandidateMemory({ capabilities }, memory, () => ({ principal, context }),
    () => itemsFromEngineList({ truncated: false, items: [card('memory-1')] }));
  return { calls, capabilities, ports };
}

async function deepRun(e: ReturnType<typeof engine>, h = harness(dirs, { over: { candidates: createCandidateSource(e.ports) } })) {
  h.captures('alpha', 3);
  return { h, result: await h.sched.runPhase('alpha', 'deep', { trigger: 'manual' }) };
}

describe('A1 dream ports behind the engine flags (RE-D167)', () => {
  it('the RX flags use recall statistics, never call promote and count the promotion as unavailable', async () => {
    const e = engine({ recallStats: true, knowledgePromotion: false });
    const { result } = await deepRun(e);
    assert.equal(result.outcome, 'completed');
    assert.ok(e.calls.stats > 0, 'stats is read');
    assert.equal(e.calls.promote, 0, 'promote never reaches the engine');
    assert.equal(result.counts.promotionUnavailable, 1);
  });

  it('without recallStats the statistics are not read, although the method exists', async () => {
    const e = engine({ knowledgePromotion: false });
    await deepRun(e);
    assert.equal(e.calls.stats, 0);
    assert.equal(e.calls.promote, 0);
  });

  it('a flag that appears between two runs is used by the next run without a Core restart', async () => {
    const e = engine({});
    const h = harness(dirs, { over: { candidates: createCandidateSource(e.ports) } });
    await deepRun(e, h);
    assert.equal(e.calls.stats, 0);
    e.capabilities.recallStats = true;
    await h.advance(DAY);
    await deepRun(e, h);
    assert.ok(e.calls.stats > 0, 'the second run reads statistics');
  });

  it('knowledgePromotion opens promote; a flag that disappears closes it again for the next run', async () => {
    const e = engine({ recallStats: true, knowledgePromotion: true });
    const source = createCandidateSource(e.ports);
    assert.equal(typeof source.promote, 'function');
    await source.promote!('alpha', ['memory-1']);
    assert.equal(e.calls.promote, 1);
    e.capabilities.knowledgePromotion = false;
    assert.equal(source.promote, undefined);
    assert.equal(e.ports.promote, undefined);
  });
});
