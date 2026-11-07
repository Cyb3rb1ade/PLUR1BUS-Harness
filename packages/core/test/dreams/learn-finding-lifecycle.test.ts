import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from '../../src/dreams/learn/aggregation.ts';
import { LearnStore } from '../../src/dreams/learn/store.ts';
import { calibration } from '../../src/dreams/learn/calibration.ts';
import type { LearnRun, Target } from '../../src/dreams/learn/types.ts';
const target: Target = { scope: 'agent', owner: 'owner', agentId: 'agent' };
function candidate(run: LearnRun, day: number, sourceId = `message-${day}`) {
  const f = aggregate([{ kind: 'knowledge', change: 'add', contentKey: 'project-language', text: 'The project uses Go.', evidence: [{
    sessionId: `session-${day}`, turnId: `turn-${day}`, sourceId, source: 'message', trust: 'person',
    day: `2026-11-${String(day).padStart(2, '0')}`, agentId: 'agent', owner: 'owner',
  }] }], target, run.id, 1)[0]!;
  f.models = ['fixture/small']; f.modelClasses = ['small']; f.desiredTier = 'A'; return f;
}
test('M2: stable target/content identity absorbs new evidence into one pending finding', () => {
  const store = new LearnStore(':memory:');
  try {
    const first = store.begin(target, { from: 1, to: 2 }, 1), second = store.begin(target, { from: 2, to: 3 }, 2);
    const a = candidate(first, 1), b = candidate(second, 2);
    assert.equal(a.id, b.id);
    store.publish(first, [a], 1); store.publish(second, [b], 2);
    const f = store.finding(a.id)!;
    assert.equal(f.evidence.length, 2); assert.equal(f.prevalence.sessions, 2); assert.equal(f.revision, 1);
    assert.equal(store.targetFindings(target).length, 1);
    assert.notEqual(aggregate([a], { ...target, agentId: 'other' }, 'run', 1)[0]!.id, a.id);
  } finally { store.close(); }
});
test('M2: rejection reopens only for new later-day evidence, links history and counts once in precision', () => {
  const store = new LearnStore(':memory:');
  try {
    const first = store.begin(target, { from: 1, to: 2 }, 1), a = candidate(first, 1);
    store.publish(first, [a], 1); store.decide(a.id, 'owner', 'rejected', 2, {});
    for (const [from, day, source] of [[2, 1, 'message-1'], [3, 1, 'another-same-day']] as const) {
      const run = store.begin(target, { from, to: from + 1 }, 3);
      store.publish(run, [candidate(run, day, source)], 3);
      assert.equal(run.findings, 0); assert.equal(store.finding(a.id)?.status, 'rejected');
    }
    const later = store.begin(target, { from: 4, to: 5 }, 4);
    store.publish(later, [candidate(later, 2)], 4);
    const reopened = store.finding(a.id)!;
    assert.equal(reopened.status, 'pending'); assert.equal(reopened.revision, 2);
    assert.equal(reopened.previousDecision?.outcome, 'rejected'); assert.equal(reopened.previousDecision?.revision, 1);
    store.decide(a.id, 'owner', 'accepted', 5, { operation: 'fixture' });
    assert.equal(store.decisions(later.id).length, 2);
    assert.equal(calibration(store, target, ['small']).A.decided, 1);
    const repeat = store.begin(target, { from: 5, to: 6 }, 5);
    store.publish(repeat, [candidate(repeat, 3)], 5);
    assert.equal(repeat.findings, 0); assert.equal(store.finding(a.id)?.status, 'accepted');
  } finally { store.close(); }
});
