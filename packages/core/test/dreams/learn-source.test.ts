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
  const source = learningSource(store, { config: () => ({ agents: {} } as HarnessConfig), hasAgent: () => true, project: () => null });
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

test('H3: only an owner direct chat with a still-valid pre-existing identity link supplies person evidence', async () => {
  const { createIdentityService } = await import('../../src/identity/service.ts');
  const { parseExtraction } = await import('../../src/dreams/learn/aggregation.ts');
  const identity = createIdentityService({ dbPath: ':memory:', clock: () => 1, audit: () => {} });
  const actor = { user: 'owner', host: 'fixture', role: 'owner' as const, kind: 'person' as const };
  const human = identity.createHuman({ displayName: 'Owner fixture' }, actor);
  const link = identity.link({ humanId: human.id, identity: { channel: 'telegram', accountId: 'bot', userId: 'sender' } }, actor);
  const store = new SessionStore({ path: ':memory:', clock: () => 10 });
  const source = learningSource(store, { config: () => ({ agents: {} } as HarnessConfig), hasAgent: () => true, project: () => null, identity: () => identity });
  try {
    for (const [label, chatKind, senderId, metadata] of [
      ['direct', 'direct', 'sender', true], ['group', 'group', 'sender', true],
      ['foreign', 'direct', 'stranger', true], ['legacy', 'direct', 'sender', false],
    ] as const) {
      const session = store.createSession({ kind: 'channel', agentId: 'agent', owner: deriveUserPrincipal(human.id), chatKey: `telegram:${label}` });
      const { turn, message } = store.beginTurn(session.id, 'The project uses Go.', 5, metadata ? {
        channelOrigin: { channel: 'telegram', accountId: 'bot', chatId: label, senderId, humanId: human.id, chatKind },
      } : {});
      store.completeTurn(turn.id, { text: 'reply', tokens: 1 });
      const extract = () => parseExtraction(JSON.stringify([{ kind: 'knowledge', change: 'add', contentKey: 'project-language', text: 'Uses Go', evidence: [{ source: 'message', id: message.id }] }]), source.transcript(session, { from: 1, to: 20 }))[0]!.evidence[0]!.trust;
      assert.equal(extract(), label === 'direct' ? 'person' : 'untrusted', label);
      if (label === 'direct') {
        identity.unlink({ linkId: link.id }, actor);
        assert.equal(extract(), 'untrusted', 'revocation removes trust on reread');
        identity.link({ humanId: human.id, identity: { channel: 'telegram', accountId: 'bot', userId: 'sender' } }, actor);
      }
    }
  } finally { store.close(); identity.close(); }
});

test('M5: learningSessions pages newest activity first with a stable tie breaker', () => {
  let now = 10;
  const store = new SessionStore({ path: ':memory:', clock: () => now });
  try {
    const ids: string[] = [];
    for (const at of [10, 30, 20]) {
      now = at;
      const s = store.createSession({ kind: 'direct', agentId: 'agent', owner: deriveUserPrincipal('alice') });
      ids.push(s.id);
      const { turn } = store.beginTurn(s.id, 'fixture', 1); store.completeTurn(turn.id, { text: 'reply', tokens: 1 });
    }
    const f = { owner: deriveUserPrincipal('alice'), from: 1, to: 100, limit: 2 };
    assert.deepEqual(store.learningSessions(f).map(s => s.id), [ids[1], ids[2]]);
    assert.deepEqual(store.learningSessions({ ...f, offset: 2 }).map(s => s.id), [ids[0]]);
  } finally { store.close(); }
});

test('L4: live exposure, project membership and archival narrow learning reads', async () => {
  const { DEFAULT_COLLAB_SETTINGS } = await import('../../src/collab/defaults.ts');
  const r = rig();
  let config = { agents: {} } as HarnessConfig;
  let project = { id: 'project', name: 'Fixture', owner: 'alice', members: [], agents: ['agent'],
    settings: DEFAULT_COLLAB_SETTINGS, createdAt: 1, updatedAt: 1, archivedAt: null as number | null };
  const source = learningSource(r.store, { config: () => config, hasAgent: () => true, project: () => project });
  const t = { ...target, scope: 'project' as const, projectId: 'project' };
  const s = { ...r.session, scope: 'project' };
  try {
    assert.equal(source.mayRead(t, s, principal), true);
    project = { ...project, archivedAt: 10 }; assert.equal(source.mayRead(t, s, principal), false);
    project = { ...project, archivedAt: null, agents: [] }; assert.equal(source.mayRead(t, s, principal), false);
    project = { ...project, agents: ['agent'], owner: 'other' }; assert.equal(source.mayRead(t, s, principal), false);
    project = { ...project, owner: 'alice' };
    config = { agents: { agent: { memoryExposure: { collab: { recall: { agentPrivate: false } } } } } } as HarnessConfig;
    assert.equal(source.mayRead(t, s, principal), false);
    config = { agents: {} } as HarnessConfig;
    assert.equal(source.mayRead(t, s, { ...principal, role: 'member' }), false);
    assert.equal(source.mayRead(t, s, { ...principal, userId: 'other' }), false);
  } finally { r.store.close(); }
});
