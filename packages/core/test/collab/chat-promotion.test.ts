import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionStore } from '../../src/session/store.ts';
import { ChatPromotion } from '../../src/collab/chat-promotion.ts';
import { createCollab } from '../../src/collab/service.ts';
import { deriveUserPrincipal } from '../../src/identity/principals.ts';
import { useTempDirs } from '../composition/helpers.ts';
const tmp = useTempDirs('m5-promotion-');
const owner = { userId: 'owner', kind: 'person' as const, role: 'owner' as const };
function fixture(t: import('node:test').TestContext) {
  const root = tmp.make(), path = join(root, 'links.sqlite'); let now = 1000;
  const store = new SessionStore({ path: join(root, 'sessions.sqlite') }), volatile = new SessionStore({ path: ':memory:' });
  const sessions = { store, forSession: (id: string) => ({ store: volatile.getSession(id) ? volatile : store }) } as never;
  const collab = createCollab({ path: join(root, 'collab.sqlite') }), project = collab.createProject(owner, { name: 'Public project' });
  const audit: object[] = [];
  const promotion = new ChatPromotion({ path, sessions: () => sessions, collab, now: () => now, audit: e => { audit.push(e); } });
  t.after(() => { promotion.close(); collab.close(); store.close(); volatile.close(); });
  const create = (person: { userId: string } = owner, ephemeral = false) => {
    const db = ephemeral ? volatile : store;
    const session = db.createSession({ kind: 'direct', agentId: 'a1', owner: deriveUserPrincipal(person.userId), title: 'private-title-isolation-marker', memoryMode: ephemeral ? 'incognito' : 'remember' });
    const turn = db.beginTurn(session.id, 'chosen-message-marker', 1).turn; db.completeTurn(turn.id, { text: 'unselected-private-marker', tokens: 1 });
    return { session, messages: db.listMessages(session.id) };
  };
  return { root, path, store, volatile, collab, project, promotion, audit, create, advance: () => { now += 600001; } };
}
test('no content choice creates only a private link; original chat owner/kind/agent/scope/messages remain identical', t => {
  const f = fixture(t), source = f.create(); const before = f.store.getSession(source.session.id);
  const preview = f.promotion.preview(owner, { sessionId: source.session.id, target: { kind: 'project', projectId: f.project.id } });
  assert.equal(preview.content, ''); assert.equal(preview.selection, 'none');
  const result = f.promotion.commit(owner, preview.previewId);
  assert.equal(f.promotion.links(owner, source.session.id).links.length, 1);
  assert.equal(result.cardId, null); assert.equal(f.collab.boardStore.cards(f.project.id, {}).cards.length, 0);
  assert.deepEqual(f.store.getSession(source.session.id), before); assert.deepEqual(f.store.listMessages(source.session.id), source.messages);
  assert.ok(!JSON.stringify(f.audit).includes('private-marker')); assert.ok(!JSON.stringify(f.audit).includes(source.session.id));
});
test('linking copies exactly the selected messages, never the other message or private title', t => {
  const f = fixture(t), source = f.create();
  const preview = f.promotion.preview(owner, { sessionId: source.session.id, target: { kind: 'project', projectId: f.project.id }, selection: { kind: 'selected', messageIds: [source.messages[0]!.id] } });
  assert.equal(f.collab.boardStore.cards(f.project.id, {}).cards.length, 0, 'preview must not publish');
  const result = f.promotion.commit(owner, preview.previewId), card = f.collab.boardStore.getCard(result.projectId, result.cardId!);
  assert.equal(card.description, 'user: chosen-message-marker'); assert.equal(card.title, 'Conversation notes');
  assert.ok(!JSON.stringify(card).includes('unselected-private-marker')); assert.ok(!JSON.stringify(card).includes('private-title-isolation-marker')); assert.ok(!JSON.stringify(card).includes(source.session.id));
  assert.deepEqual(f.promotion.commit(owner, preview.previewId), result); assert.equal(f.collab.boardStore.cards(f.project.id, {}).cards.length, 1);
});
test('foreign person including another Owner cannot preview or commit a stolen preview', t => {
  const f = fixture(t), source = f.create(), other = { ...owner, userId: 'other' };
  const input = { sessionId: source.session.id, target: { kind: 'project' as const, projectId: f.project.id } };
  assert.throws(() => f.promotion.preview(other, input), /not found/);
  assert.throws(() => f.promotion.links(other, source.session.id), /not found/);
  const preview = f.promotion.preview(owner, input);
  assert.throws(() => f.promotion.commit(other, preview.previewId), /not found/); assert.equal(f.collab.boardStore.cards(f.project.id, {}).cards.length, 0);
});
test('destination requires live project membership and write rights, ignoring claimed project rights', t => {
  const f = fixture(t); const member = { ...owner, userId: 'member', role: 'member' as const, agentRights: { a1: 'use' as const }, projectRights: { [f.project.id]: 'lead' as const } };
  const source = f.create(member);
  const input = { sessionId: source.session.id, target: { kind: 'project' as const, projectId: f.project.id } };
  assert.throws(() => f.promotion.preview(member, input));
  f.collab.addMember(owner, f.project.id, member.userId, 'member');
  const preview = f.promotion.preview(member, input); f.collab.removeMember(owner, f.project.id, member.userId);
  assert.throws(() => f.promotion.commit(member, preview.previewId));
});
test('summary, card and new-project promotion copy only explicit content; returned preview cannot mutate destination', t => {
  const f = fixture(t), source = f.create();
  const preview = f.promotion.preview(owner, { sessionId: source.session.id, target: { kind: 'new_project', name: 'Chosen destination' }, selection: { kind: 'summary', summary: 'Explicit summary only' } });
  preview.target.name = 'tampered'; const result = f.promotion.commit(owner, preview.previewId);
  assert.equal(f.collab.getProject(owner, result.projectId).name, 'Chosen destination'); assert.equal(f.collab.boardStore.getCard(result.projectId, result.cardId!).description, 'Explicit summary only');
  const card = f.promotion.preview(owner, { sessionId: source.session.id, target: { kind: 'card', projectId: f.project.id, title: 'Explicit title' } });
  const empty = f.promotion.commit(owner, card.previewId); assert.equal(f.collab.boardStore.getCard(empty.projectId, empty.cardId!).description, '');
});
test('expired/stale previews and foreign message ids are refused; full transcript is explicit', t => {
  const f = fixture(t), source = f.create(), other = f.create();
  assert.throws(() => f.promotion.preview(owner, { sessionId: source.session.id, target: { kind: 'project', projectId: f.project.id }, selection: { kind: 'selected', messageIds: [other.messages[0]!.id] } }));
  const expired = f.promotion.preview(owner, { sessionId: source.session.id, target: { kind: 'project', projectId: f.project.id } }); f.advance(); assert.throws(() => f.promotion.commit(owner, expired.previewId), /expired/);
  const stale = f.promotion.preview(owner, { sessionId: source.session.id, target: { kind: 'project', projectId: f.project.id } }); const turn = f.store.beginTurn(source.session.id, 'later', 1).turn; f.store.completeTurn(turn.id, { text: 'later answer', tokens: 1 }); assert.throws(() => f.promotion.commit(owner, stale.previewId), /chat changed/);
  const full = f.promotion.preview(owner, { sessionId: source.session.id, target: { kind: 'project', projectId: f.project.id }, selection: { kind: 'transcript' } }); assert.match(full.content, /chosen-message-marker/); assert.match(full.content, /unselected-private-marker/);
});
test('incognito preview stays in RAM, explicit promotion leaves the source ephemeral and private', t => {
  const f = fixture(t), source = f.create(owner, true);
  const preview = f.promotion.preview(owner, { sessionId: source.session.id, target: { kind: 'project', projectId: f.project.id }, selection: { kind: 'summary', summary: 'chosen-message-marker' } });
  assert.equal(f.store.getSession(source.session.id), null); assert.ok(!readFileSync(f.path).includes(Buffer.from('chosen-message-marker')));
  const result = f.promotion.commit(owner, preview.previewId); assert.equal(f.collab.boardStore.getCard(result.projectId, result.cardId!).description, 'chosen-message-marker'); assert.equal(f.store.getSession(source.session.id), null); assert.equal(f.volatile.getSession(source.session.id)!.kind, 'direct');
});
