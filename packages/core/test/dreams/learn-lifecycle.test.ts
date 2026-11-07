import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LearnStore } from '../../src/dreams/learn/store.ts';
import { aggregate } from '../../src/dreams/learn/aggregation.ts';
import { learningLifecycle } from '../../src/dreams/learn/lifecycle.ts';
import type { Handler } from '../../src/rpc/server.ts';
const target = { scope: 'agent' as const, owner: 'person', agentId: 'agent' }, DAY = 86400000;
function seed(store: LearnStore) {
  const run = store.begin(target, { from: 0, to: 1 }, 1); run.sessionIds = ['session']; store.save(run);
  const f = aggregate([{ kind: 'knowledge', change: 'add', contentKey: 'language', text: 'Learned claim marker', evidence: [{ sessionId: 'session', turnId: 'turn', source: 'message', sourceId: 'message', day: '1970-01-01', trust: 'person', agentId: 'agent', owner: 'person' }] }], target, run.id, 1)[0]!;
  store.checkpoint(run.id, 'extract:session', { text: 'CHECKPOINT PRIVATE MARKER' }); store.publish(run, [f], 2);
  return { run, f };
}
test('LQ1 published extraction is removed physically; erasure withdraws, removes evidence and keeps only decision audit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-privacy-')), file = join(dir, 'learn.db');
  const store = new LearnStore(file);
  try {
    const { run, f } = seed(store); assert.equal(store.payload(run.id, 'extract:session'), null);
    store.decide(f.id, 'reviewer', 'accepted', 3, {});
    store.checkpoint(run.id, 'extract:session', { text: 'CHECKPOINT PRIVATE MARKER' });
    store.reconcile({ now: 4, checkpointDays: 7, erased: new Set(['session']), validTarget: () => true, validEvidence: () => false });
    assert.equal(store.finding(f.id)!.status, 'withdrawn'); assert.deepEqual(store.finding(f.id)!.evidence, []);
    assert.equal(store.finding(f.id)!.text, ''); assert.equal(store.payload(run.id, 'extract:session'), null);
    assert.equal(store.decisions(run.id).length, 1); assert.equal(store.decidedFindings('person').length, 0);
    assert.doesNotMatch(readFileSync(file).toString(), /Learned claim marker|CHECKPOINT PRIVATE MARKER/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('LQ1 restart reconciliation, seven-day unfinished retention and thirty-day decision text retention', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-restart-')), file = join(dir, 'learn.db');
  let store = new LearnStore(file);
  try {
    const { run, f } = seed(store); store.decide(f.id, 'reviewer', 'rejected', 10, {});
    const retry = store.begin(target, { from: 2, to: 3 }, 2); store.checkpoint(retry.id, 'extract:session', { text: 'temporary' });
    store.finish(retry, 'failed', 'provider-failed', 3); store.close(); store = new LearnStore(file);
    store.reconcile({ now: 6 * DAY, checkpointDays: 7, validTarget: () => true, validEvidence: () => true });
    assert.ok(store.payload(retry.id, 'extract:session')); assert.equal(store.finding(f.id)!.text, f.text);
    store.reconcile({ now: 31 * DAY, checkpointDays: 7, validTarget: () => true, validEvidence: () => true });
    assert.equal(store.payload(retry.id, 'extract:session'), null); assert.equal(store.finding(f.id)!.text, '');
    assert.equal(store.decidedFindings('person').length, 1);
    store.reconcile({ now: 32 * DAY, checkpointDays: 7, erased: new Set(['session']), validTarget: () => true, validEvidence: () => false });
    assert.equal(store.finding(f.id)!.status, 'withdrawn'); assert.equal(store.decisions(run.id).length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('LQ1 successful lifecycle mutations reconcile after commit; refused mutations never invalidate', async () => {
  const events: unknown[] = [], ctx = { requestId: 'r', connectionId: 'c', signal: new AbortController().signal };
  const methods: Record<string, Handler> = { 'agent.close': async () => { events.push('closed'); return {}; }, 'identity.link.remove': async () => { events.push('unlinked'); return {}; }, 'project.archive': async () => { throw Error('denied'); } };
  const wrapped = learningLifecycle(methods, () => ({ reconcile: (x: unknown) => events.push(x) }) as never, () => 'person');
  await wrapped['agent.close']!({ agentId: 'agent' }, ctx); await wrapped['identity.link.remove']!({ linkId: 'link' }, ctx);
  await assert.rejects(() => wrapped['project.archive']!({}, ctx));
  assert.deepEqual(events, ['closed', { agentId: 'agent' }, 'unlinked', { owner: 'person' }]);
});

test('LQ1 erased in-flight runs cannot recreate payloads or publish after an awaited provider returns', () => {
  const store = new LearnStore(':memory:');
  try {
    const { run, f } = seed(store);
    store.reconcile({ now: 4, checkpointDays: 7, erased: new Set(['session']), validTarget: () => true, validEvidence: () => false });
    assert.throws(() => store.checkpoint(run.id, 'extract:session', { text: 'late reply' }), /rights-changed/);
    assert.throws(() => store.publish(run, [f], 5), /rights-changed/);
    run.sessionIds = ['session']; store.save(run); assert.deepEqual(store.get(run.id)!.sessionIds, []);
  } finally { store.close(); }
});
