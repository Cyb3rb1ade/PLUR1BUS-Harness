import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LearnStore } from '../../src/dreams/learn/store.ts';
import { aggregate } from '../../src/dreams/learn/aggregation.ts';
const DAY = 86400000, target = { scope: 'agent' as const, owner: 'owner', agentId: 'agent' };
function rig() {
  const store = new LearnStore(':memory:'), run = store.begin(target, { from: 0, to: DAY }, 0);
  const f = aggregate([{ kind: 'knowledge', change: 'add', contentKey: 'language-go', text: 'Uses Go', evidence: [{ sessionId: 'original', turnId: 'turn', source: 'message', sourceId: 'message', day: '1970-01-01', trust: 'person', agentId: 'agent', owner: 'owner' }] }], target, run.id, 1)[0]!;
  f.modelClasses = ['small', 'large']; store.publish(run, [f], DAY); store.decide(f.id, 'owner', 'accepted', DAY, { operation: 'memory.importText.apply', runId: 'receipt' });
  return { store, f, observe(count: number, from: number, to: number, recurred = false, truncated = false) {
    const next = store.begin(target, { from, to }, to); next.truncated = truncated; store.publish(next, [], to);
    store.observe(next, Array.from({ length: count }, (_, i) => ({ sessionId: `future-${i}`, at: 2 * DAY, signals: recurred && i === 0 ? [{ findingId: f.id, at: 2 * DAY }] : [] })));
    return store.prediction(f.id)!;
  } };
}
test('LQ2 both ten distinct sessions and fourteen days are required; overlapping runs do not double count', () => {
  const r = rig();
  try {
    assert.equal(r.observe(10, DAY, 5 * DAY).status, 'insufficient-data');
    assert.equal(r.observe(10, 4 * DAY, 15 * DAY).status, 'confirmed');
    assert.equal(r.store.prediction(r.f.id)!.sessions, 10);
    assert.equal(r.store.predictionSummary('owner', ['small', 'large']).confirmationRate, 1);
    assert.equal(r.store.finding(r.f.id)!.status, 'accepted'); assert.equal(r.store.decisions(r.f.runId).length, 1);
  } finally { r.store.close(); }
});
test('LQ2 recurrence proposes manual retirement and retains rollback receipt without a mutation', () => {
  const r = rig();
  try {
    const p = r.observe(10, DAY, 15 * DAY, true);
    assert.equal(p.status, 'not-confirmed'); assert.equal(p.retireProposed, true); assert.equal(p.recurrences, 1);
    assert.equal(r.store.decisions(r.f.runId)[0]!.receipt.runId, 'receipt');
    assert.equal(r.store.finding(r.f.id)!.status, 'accepted');
  } finally { r.store.close(); }
});
test('LQ2 too few sessions, capped runs and missing time coverage never confirm a prediction', () => {
  for (const [count, from, truncated] of [[9, DAY, false], [10, DAY, true], [10, 2 * DAY, false]] as const) {
    const r = rig();
    try { const p = r.observe(count, from, 20 * DAY, false, truncated); assert.equal(p.status, 'insufficient-data'); assert.equal(p.retireProposed, false); }
    finally { r.store.close(); }
  }
});

test('LQ2 erased observation sessions invalidate confirmation and remove private references', () => {
  const r = rig();
  try {
    assert.equal(r.observe(10, DAY, 15 * DAY).status, 'confirmed');
    r.store.reconcile({ now: 16 * DAY, checkpointDays: 7, erased: new Set(['future-0']), validTarget: () => true, validEvidence: () => true });
    assert.equal(r.store.prediction(r.f.id)!.status, 'insufficient-data'); assert.equal(r.store.prediction(r.f.id)!.sessions, 9);
  } finally { r.store.close(); }
});
