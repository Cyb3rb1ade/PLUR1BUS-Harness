import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '@plur1bus/config-schema';
import { createCore } from '../../src/core.ts';
import { FakeChatProvider } from '../../src/session/provider.ts';
import { AdminStore } from '../../src/identity/admin-store.ts';
import { guardMethods, RPC_RULES } from '../../src/rbac/guard.ts';
import { policyFor } from '../../src/rbac/policy.ts';
import { authorize } from '../../src/rbac/authorize.ts';
import { flatTestInternals } from '../helpers/flat-embedder.ts';
import { createApiServer } from '../../../api/src/server.ts';
import { createCoreLink } from '../../../api/src/core-link.ts';
import { MemoryUserDirectory } from '../../../api/src/memory-stores.ts';
import { hashPassword } from '../../../api/src/password.ts';
import { memoryAuditSink } from '../../src/rbac/audit.ts';
import { ROUTES } from '../../../api/src/routes.ts';
import { webEndpoint } from '../../../api/src/rpc-route.ts';

// Reviewed method classification for M3's delegated /rpc route. Board agent access
// is intentional and already scoped to persisted project assignments by its handler.
const methods = [
  ['chat.promote.links', 'read', 'chat:read', false],
  ['chat.promote.preview', 'write', 'chat:write', false],
  ['chat.promote.commit', 'write', 'chat:write', false],
  ['collab.trace.get', 'read', 'project.surface.read', false],
  ['collab.trace.list', 'read', 'project.surface.read', false],
  ['collab.session.replay', 'read', 'project.surface.read', false],
  ['collab.chain.cancel', 'write', 'project.surface.write', false],
  ['project.column.list', 'read', 'project.board.read', true],
  ['project.card.comment.add', 'write', 'project.board.comment', true],
  ['project.card.comment.list', 'read', 'project.board.read', true],
  ['project.card.activity.list', 'read', 'project.board.read', true],
  ['task.complete', 'write', 'project.surface.write', false],
] as const;

test('M5 Web methods have reviewed read/write RBAC and intentional principal classifications', async () => {
  const route = ROUTES.find(r => r.id === 'web.rpc')!;
  assert.equal(route.auth, 'session'); assert.equal(route.authz, 'delegated'); assert.equal(route.csrf, true);
  for (const [method, mode, action, agents] of methods) {
    assert.equal(webEndpoint(method), 'core', method);
    const rule = RPC_RULES[method]!; assert.ok(rule, method); assert.equal(rule.action, action);
    assert.equal(rule.humanOnly === true || policyFor(action)?.humanOnly === true, !agents, method);
    const decision = authorize({ userId: 'viewer', kind: 'person', role: 'viewer' }, action, rule.resource({}));
    assert.equal(decision.effect, mode === 'read' ? 'allow' : 'deny', method);
    // Exercise the real guard as well as the policy for both anonymous and agent identities.
    for (const kind of ['anonymous', 'agent'] as const) {
      let entered = false;
      const guarded = guardMethods({ [method]: async () => { entered = true; return {}; } }, {
        resolve: () => kind === 'anonymous' ? null : { userId: 'a1', kind: 'agent', role: 'member' }, now: Date.now,
      });
      const request = guarded[method]!({}, { requestId: 'classification', connectionId: 'fixture', signal: new AbortController().signal });
      if (kind === 'agent' && agents) { await request; assert.equal(entered, true); }
      else { await assert.rejects(request, (e: any) => e.error === (kind === 'anonymous' ? 'E_UNAUTHORIZED' : 'E_DENIED')); assert.equal(entered, false); }
    }
  }
});

async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'm5-http-')), root = join(home, 'checkout'); mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'README.md'), '# HTTP authorization fixture\n'); git('add', '.'); git('commit', '-m', 'fixture');
  const cfg = defaults(); cfg.agents.a1 = {}; cfg.agents.b1 = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, reranker: { enabled: false }, duplicateThreshold: 1.01 };
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
  const people = new AdminStore({ path: join(home, 'state', 'admin.sqlite'), ownerId: 'local-owner' });
  const users = new MemoryUserDirectory(), password = randomBytes(24).toString('base64url'), passwordHash = await hashPassword(password);
  for (const [id, role] of [['alice', 'member'], ['bob', 'member'], ['viewer', 'viewer']] as const) {
    people.setRole(id, role, () => {}); people.setRight('a1', id, 'use'); people.setRight('b1', id, 'use');
    users.add({ id, username: id, role, agentRights: { a1: 'use', b1: 'use' }, passwordHash });
  }
  people.close();
  const audit = memoryAuditSink();
  const core = createCore({ home, testInternals: flatTestInternals(), chatProvider: new FakeChatProvider(), rbac: { audit }, composition: { projectWorktrees: { root: () => root } }, discovery: { scheduler: false }, dreams: { scheduler: false } });
  t.after(async () => { await core.stop({ budgetMs: 5000 }); rmSync(home, { recursive: true, force: true }); });
  await core.start();
  const link = createCoreLink(home); t.after(() => link.close());
  const bucket = { capacity: 10000, refillPerSec: 10000 };
  // The chat submit below waits for a real Core turn (engine recall and capture): about 0.5 s on Linux, 5.6 s and over
  // 10 s in two windows-2025 runs. The 10 s HTTP handler limit is not what this test examines (packages/api tests it).
  const api = createApiServer({ core: link, users, ownerToken: randomBytes(32).toString('hex'), audit, rateClasses: { auth: bucket, read: bucket, write: bucket, rpc: bucket }, limits: { handlerTimeoutMs: 60_000 } });
  t.after(() => api.close()); const { url } = await api.listen();
  const login = async (username: string) => {
    const response = await fetch(url + '/api/v1/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200, await response.clone().text()); await response.text(); return response.headers.get('set-cookie')!.split(';')[0]!;
  };
  const alice = await login('alice'), bob = await login('bob'), viewer = await login('viewer');
  let id = 0;
  const post = async (cookie: string, path: string, body: object, csrf = true) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (cookie && csrf) { const r = await fetch(url + '/api/v1/csrf', { headers: { cookie } }); assert.equal(r.status, 200); headers['x-csrf-token'] = (await r.json() as any).token; }
    const response = await fetch(url + path, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const rpc = (cookie: string, method: string, params: object, csrf = true) => post(cookie, '/rpc', { jsonrpc: '2.0', id: ++id, method, params }, csrf);
  const getChat = async () => { const response = await fetch(url + '/api/v1/chats/' + sessionId, { headers: { cookie: alice } }); assert.equal(response.status, 200); return await response.json() as any; };
  const who = { userId: 'alice', kind: 'person' as const, role: 'owner' as const }, collab = core.collaboration()!;
  assert.ok(collab, 'real Core collaboration must be available');
  const project = collab.createProject(who, { name: 'Private HTTP project' });
  collab.addMember(who, project.id, 'viewer', 'member');
  for (const agent of ['a1', 'b1']) collab.addAgent(who, project.id, agent);
  const card = collab.boardStore.createCard(project.id, { title: 'HTTP task', columnId: collab.boardStore.columns(project.id)[0]!.id }, { kind: 'person', id: 'alice' });
  collab.boardStore.assign(project.id, card.id, { kind: 'agent', id: 'a1' }, true, { kind: 'person', id: 'alice' });
  const answer = await collab.consult({ principal: who, projectId: project.id, fromAgent: 'a1', toAgent: 'b1', question: 'HTTP replay marker', context: '' });
  const spanId = collab.getTrace(who, answer.traceId).spans[0]!.spanId;
  const created = await post(alice, '/api/v1/chats', { agentId: 'a1', title: 'private-title-http-marker' }); assert.equal(created.status, 201, JSON.stringify(created));
  const sessionId = created.body.session.id as string;
  const preview = await rpc(alice, 'chat.promote.preview', { sessionId, target: { kind: 'project', projectId: project.id } });
  assert.ok(preview.body.result, JSON.stringify(preview));
  const params: Record<string, object> = {
    'chat.promote.links': { sessionId },
    'chat.promote.preview': { sessionId, target: { kind: 'project', projectId: project.id } },
    'chat.promote.commit': { previewId: preview.body.result.previewId },
    'collab.trace.get': { traceId: answer.traceId }, 'collab.trace.list': { projectId: project.id },
    'collab.session.replay': { traceId: answer.traceId, spanId }, 'collab.chain.cancel': { traceId: answer.traceId },
    'project.column.list': { projectId: project.id },
    'project.card.comment.add': { projectId: project.id, cardId: card.id, text: 'HTTP comment marker' },
    'project.card.comment.list': { projectId: project.id, cardId: card.id }, 'project.card.activity.list': { projectId: project.id, cardId: card.id },
    'task.complete': { projectId: project.id, cardId: card.id, overrideNote: 'HTTP authorization fixture: verifier behavior is independently tested by coding-gate.test.ts.' },
  };
  return { rpc, post, getChat, alice, bob, viewer, params, project, card, collab, who, audit, sessionId, answer, spanId };
}

test('each M5 method traverses real HTTP /rpc and Core with session, role and persisted object isolation', { timeout: 60000 }, async t => {
  const h = await fixture(t);
  for (const [method, mode] of methods) await t.test(method, async () => {
    const params = h.params[method]!;
    assert.equal((await h.rpc('', method, params)).status, 401, 'no session');
    assert.equal((await h.rpc(h.alice, method, params, false)).status, 403, 'CSRF applies even to reads');
    const malformed = await h.rpc(h.alice, method, { ...params, unexpected: true });
    assert.equal(malformed.body.error?.data.error, 'E_INVALID_PARAMS', JSON.stringify(malformed));
    const foreign = await h.rpc(h.bob, method, params);
    assert.equal(foreign.status, 200); assert.ok(['E_DENIED', 'E_NOT_FOUND'].includes(foreign.body.error?.data.error), JSON.stringify(foreign));
    assert.ok(!JSON.stringify(foreign).includes('HTTP replay marker')); assert.ok(!JSON.stringify(foreign).includes('private-title-http-marker'));
    if (mode === 'write') {
      const denied = await h.rpc(h.viewer, method, params);
      assert.equal(denied.status, 200); assert.equal(denied.body.error?.data.error, 'E_DENIED', JSON.stringify(denied));
    } else if (!method.startsWith('chat.')) {
      const read = await h.rpc(h.viewer, method, params); assert.ok(read.body.result, JSON.stringify(read));
    }
    const allowed = await h.rpc(h.alice, method, params);
    assert.equal(allowed.status, 200); assert.ok(Object.hasOwn(allowed.body, 'result'), JSON.stringify(allowed));
    if (method === 'chat.promote.commit') {
      assert.equal(allowed.body.result.cardId, null, 'default choice does not publish chat content');
      assert.deepEqual((await h.rpc(h.alice, method, params)).body.result, allowed.body.result, 'HTTP retry is idempotent');
    }
    if (method === 'collab.session.replay') assert.deepEqual(allowed.body.result, h.collab.replay(h.who, h.answer.traceId, h.spanId));
    if (method === 'project.card.comment.add') assert.equal(allowed.body.result.author.id, 'alice', 'real authenticated identity reaches Core');
    if (method === 'task.complete') assert.equal(allowed.body.result.verification.override, true);
  });
  await t.test('explicit selected-message promotion crosses HTTP and leaves the private source identical', async () => {
    const submitted = await h.post(h.alice, `/api/v1/chats/${h.sessionId}/messages`, { text: 'chosen-http-message', wait: true });
    assert.equal(submitted.status, 200, JSON.stringify(submitted)); assert.equal(submitted.body.state, 'completed');
    const before = await h.getChat(), chosen = before.messages.find((m: any) => m.role === 'user'); assert.ok(chosen);
    const preview = await h.rpc(h.alice, 'chat.promote.preview', { sessionId: h.sessionId, target: { kind: 'project', projectId: h.project.id }, selection: { kind: 'selected', messageIds: [chosen.id] } });
    assert.equal(preview.body.result?.content, 'user: chosen-http-message', JSON.stringify(preview));
    assert.equal(h.collab.boardStore.cards(h.project.id, {}).cards.length, 1, 'preview has no public effect');
    const committed = await h.rpc(h.alice, 'chat.promote.commit', { previewId: preview.body.result.previewId }); assert.ok(committed.body.result, JSON.stringify(committed));
    const card = h.collab.boardStore.getCard(h.project.id, committed.body.result.cardId);
    assert.equal(card.description, 'user: chosen-http-message'); assert.ok(!JSON.stringify(card).includes('private-title-http-marker'));
    assert.deepEqual(await h.getChat(), before);
    const links = await h.rpc(h.alice, 'chat.promote.links', { sessionId: h.sessionId }); assert.equal(links.body.result.links.length, 2);
    const destinationOwner = { ...h.who, userId: 'local-owner' }, destination = h.collab.createProject(destinationOwner, { name: 'Revocable destination' });
    h.collab.addMember(destinationOwner, destination.id, 'alice', 'member');
    const revoked = await h.rpc(h.alice, 'chat.promote.preview', { sessionId: h.sessionId, target: { kind: 'project', projectId: destination.id } });
    assert.ok(revoked.body.result, JSON.stringify(revoked));
    h.collab.removeMember(destinationOwner, destination.id, 'alice');
    const denied = await h.rpc(h.alice, 'chat.promote.commit', { previewId: revoked.body.result.previewId });
    assert.ok(['E_DENIED', 'E_NOT_FOUND'].includes(denied.body.error?.data.error), JSON.stringify(denied));
    assert.deepEqual(await h.getChat(), before); assert.equal(h.collab.boardStore.cards(h.project.id, {}).cards.length, 2);
    assert.equal(h.collab.boardStore.cards(destination.id, {}).cards.length, 0);
  });
  await t.test('request claims cannot replace authenticated person; unguarded/internal methods stay excluded', async () => {
    const spoof = await h.post(h.bob, '/rpc', { jsonrpc: '2.0', id: 500, method: 'chat.promote.preview', principal: { userId: 'alice', kind: 'person', role: 'owner' }, params: { ...h.params['chat.promote.preview'], principal: { userId: 'alice', role: 'owner' }, actAs: 'alice' } });
    assert.ok(['E_DENIED', 'E_NOT_FOUND'].includes(spoof.body.error?.data.error), JSON.stringify(spoof));
    for (const method of ['core.auth', 'core.shutdown', 'memory.capture', 'secret.get', 'admin.backup.snapshot']) {
      const denied = await h.rpc(h.alice, method, {}); assert.equal(denied.body.error?.data.error, 'E_DENIED'); assert.equal(denied.body.error?.data.reason, 'web-method');
    }
    assert.ok(h.audit.events.some(e => e.action === 'rbac.denied' && e.actor.user === 'viewer'));
  });
});
