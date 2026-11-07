import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deriveUserPrincipal } from '../../src/identity/principals.ts';
import { LearnStore } from '../../src/dreams/learn/store.ts';
import { selectTranscripts } from '../../src/dreams/learn/selection.ts';
import type { SelectionSource, Target, Transcript } from '../../src/dreams/learn/types.ts';

const target: Target = { scope: 'agent', owner: 'person-one', agentId: 'agent-one' };
const principal = { userId: target.owner, kind: 'person' as const, role: 'owner' as const };
const window = { from: 1, to: 100 };
function transcript(id: string, patch: Partial<Transcript['session']> = {}): Transcript {
  return { session: { id, agentId: target.agentId, owner: deriveUserPrincipal(target.owner), scope: 'project-one', kind: 'direct', chatKey: null, title: '', pinned: false, memoryMode: 'remember', createdAt: 1, updatedAt: 2, lastTurnAt: 2, archivedAt: null, turnCount: 1, ...patch },
    messages: [{ id: `message-${id}`, sessionId: id, turnId: 'turn-one', seq: 1, role: 'user', text: 'private fixture', tokens: 3, createdAt: 2 }], events: [], days: ['2026-11-01'] };
}
function source(rows: Transcript[], denied: string[] = []): SelectionSource {
  return { sessions: () => rows.map(t => t.session), transcript: s => rows.find(t => t.session.id === s.id)!, mayRead: (_target, s) => !denied.includes(s.id) };
}
test('learn selection excludes other owners, agents, incognito and revoked target read rights before loading text', () => {
  const rows = [transcript('allowed'), transcript('foreign', { owner: deriveUserPrincipal('person-two') }), transcript('other-agent', { agentId: 'agent-two' }), transcript('private', { memoryMode: 'incognito' }), transcript('denied')];
  const input = source(rows, ['denied']); const loaded: string[] = [];
  const read = input.transcript; input.transcript = (s, w) => { loaded.push(s.id); return read(s, w); };
  assert.deepEqual(selectTranscripts(input, target, principal, window, 50).map(t => t.session.id), ['allowed']);
  assert.deepEqual(loaded, ['allowed']);
  assert.throws(() => selectTranscripts(input, target, { ...principal, userId: 'person-two' }, window, 50), /rights-changed/);
});
test('project selection excludes other projects and applies a deterministic explicit session cap', () => {
  const input = source([transcript('z'), transcript('a'), transcript('outside', { scope: 'project-two' })]);
  assert.deepEqual(selectTranscripts(input, { ...target, scope: 'project', projectId: 'project-one' }, principal, window, 1).map(t => t.session.id), ['a']);
});
test('a foreign content row or oversized transcript fails closed instead of creating partial evidence', () => {
  const t = transcript('a'); t.messages[0]!.sessionId = 'foreign';
  assert.throws(() => selectTranscripts(source([t]), target, principal, window, 50), /source-unavailable/);
  const huge = transcript('b'); huge.messages[0]!.text = 'x'.repeat(262_145);
  assert.throws(() => selectTranscripts(source([huge]), target, principal, window, 50), /transcript-cap/);
});
test('same target/window has one durable run and resumes completed checkpoints without content in ledger rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-store-')); const file = join(dir, 'learn.db');
  let store = new LearnStore(file);
  try {
    const first = store.begin(target, window, 10);
    store.step(first.id, 'extract-session-one', 'started');
    store.checkpoint(first.id, 'extract-session-one', { text: 'PRIVATE_LEARN_MARKER' });
    store.close(); store = new LearnStore(file);
    assert.deepEqual(store.begin(target, window, 20), first);
    assert.deepEqual(store.payload(first.id, 'extract-session-one'), { text: 'PRIVATE_LEARN_MARKER' });
    assert.equal(store.runs(target.owner).length, 1);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM learn_run').all()), /PRIVATE_LEARN_MARKER/);
      assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM learn_step').all()), /PRIVATE_LEARN_MARKER/);
    } finally { db.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('M3: reordered target keys share idempotency and breaker state', () => {
  const store = new LearnStore(':memory:');
  const reordered: Target = { agentId: target.agentId, owner: target.owner, scope: target.scope };
  try {
    for (let i = 1; i <= 3; i++) {
      const run = store.begin(target, { from: i, to: i + 1 }, 100);
      store.finish(run, 'failed', 'provider-failed', 101);
    }
    assert.equal(store.begin(reordered, { from: 1, to: 2 }, 102).id, store.begin(target, { from: 1, to: 2 }, 102).id);
    assert.equal(store.breakerOpen(reordered, 103), true);
  } finally { store.close(); }
});
