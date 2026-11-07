import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveUserPrincipal } from '../../src/identity/principals.ts';
import { SessionStore } from '../../src/session/store.ts';
import { learningSource } from '../../src/dreams/learn/source.ts';
import { LearnRunner } from '../../src/dreams/learn/runner.ts';
import { LearnStore } from '../../src/dreams/learn/store.ts';
import { DEFAULT_LEARN_CONFIG } from '../../src/dreams/learn/types.ts';
import type { HarnessConfig } from '@plur1bus/config-schema';
const target = { scope: 'agent' as const, owner: 'alice', agentId: 'agent' };
const principal = { userId: 'alice', kind: 'person' as const, role: 'owner' as const };
function rig() {
  let now = 10;
  const store = new SessionStore({ path: ':memory:', clock: () => now });
  const session = store.createSession({ kind: 'direct', agentId: 'agent', owner: deriveUserPrincipal('alice') });
  const source = learningSource(store, { config: () => ({} as HarnessConfig), hasAgent: () => true, project: () => null });
  const turn = (at: number) => { now = at; const { turn } = store.beginTurn(session.id, 'fixture', 1); store.completeTurn(turn.id, { text: 'reply', tokens: 1 }); return turn; };
  return { store, session, source, turn };
}
test('H2: a long session loads recent completed turns rather than its oldest 2001 messages', () => {
  const r = rig();
  try {
    for (let i = 0; i < 1002; i++) r.turn(10);
    const recent = r.turn(100);
    r.turn(200);
    const t = r.source.transcript(r.session, { from: 100, to: 200 });
    assert.equal(t.messages.length, 2);
    assert.equal(t.events.length, 2);
    assert.ok(t.messages.every(m => m.turnId === recent.id));
    assert.ok(t.events.every(e => e.turnId === recent.id));
  } finally { r.store.close(); }
});
test('H2: an oversized in-window transcript is deferred explicitly without a model call', async () => {
  const r = rig(), ledger = new LearnStore(':memory:');
  try {
    for (let i = 0; i < 1001; i++) r.turn(100);
    let calls = 0;
    const runner = new LearnRunner({ store: ledger, source: r.source, now: () => 300, principal: () => principal,
      config: () => ({ ...DEFAULT_LEARN_CONFIG, enabled: true }),
      model: { async complete() { calls++; throw Error('unexpected'); } } });
    const run = await runner.run(target, { from: 100, to: 200 }, new AbortController().signal);
    assert.equal(run.outcome, 'deferred'); assert.equal(run.reason, 'transcript-cap'); assert.equal(calls, 0);
    assert.equal(ledger.get(run.id)?.reason, 'transcript-cap');
  } finally { ledger.close(); r.store.close(); }
});
test('learningSessions includes only completed non-incognito turns in the half-open window', () => {
  const r = rig();
  try {
    r.turn(10);
    assert.equal(r.store.learningSessions({ owner: deriveUserPrincipal('alice'), from: 10, to: 11, limit: 50 }).length, 1);
    assert.equal(r.store.learningSessions({ owner: deriveUserPrincipal('alice'), from: 9, to: 10, limit: 50 }).length, 0);
    r.store.updateSession(r.session.id, { memoryMode: 'incognito' }); r.turn(100);
    r.store.updateSession(r.session.id, { memoryMode: 'remember' });
    assert.equal(r.store.learningSessions({ owner: deriveUserPrincipal('alice'), from: 100, to: 200, limit: 50 }).length, 0);
    assert.equal(r.store.learningSessions({ owner: deriveUserPrincipal('bob'), from: 1, to: 200, limit: 50 }).length, 0);
    assert.equal(r.store.learningSessions({ owner: deriveUserPrincipal('alice'), projectId: 'outside', from: 1, to: 200, limit: 50 }).length, 0);
  } finally { r.store.close(); }
});
