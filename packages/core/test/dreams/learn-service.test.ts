import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '@plur1bus/config-schema';
import { SessionStore } from '../../src/session/store.ts';
import { LearnStore } from '../../src/dreams/learn/store.ts';
import { LearnService } from '../../src/dreams/learn/service.ts';
import { learningSource } from '../../src/dreams/learn/source.ts';
import { deriveUserPrincipal } from '../../src/identity/principals.ts';
import { guardMethods } from '../../src/rbac/guard.ts';
import { memoryAuditSink } from '../../src/rbac/audit.ts';
import { learnMethods } from '../../src/dreams/learn/methods.ts';
import { RpcError } from '../../src/rpc/errors.ts';
import type { Principal } from '../../src/rbac/types.ts';
import type { CallContext, Handler } from '../../src/rpc/server.ts';
const target = { scope: 'agent' as const, owner: 'person', agentId: 'agent' };
const person: Principal = { userId: 'person', kind: 'person', role: 'owner' };
const DAY = 86400000;
function rig(h3?: import('../../src/dreams/learn/service.ts').LearnServiceOptions['h3'], suffix = '') {
  let now = 10 * DAY, mayRead = true;
  const sessions = new SessionStore({ path: ':memory:', clock: () => now }), store = new LearnStore(':memory:');
  const config = defaults(); config.dreams = { learn: { agents: { agent: { enabled: true, owner: 'person' } } } };
  for (let i = 0; i < 3; i++) {
    now = (10 + i) * DAY;
    const session = sessions.createSession({ kind: 'direct', agentId: 'agent', owner: deriveUserPrincipal('person') });
    const { turn } = sessions.beginTurn(session.id, 'The project uses Go.' + suffix, 5); sessions.completeTurn(turn.id, { text: 'Acknowledged.', tokens: 2 });
  }
  now = 14 * DAY;
  const source = learningSource(sessions, { config: () => config, hasAgent: () => true, project: () => null });
  const read = source.mayRead; source.mayRead = (...args) => mayRead && read(...args);
  const notices: unknown[] = [];
  const service = new LearnService({ erasures: () => sessions.erasures(), onErasure: fn => sessions.onErasure(fn), ...(h3 ? { h3 } : {}), store, source, config: () => config, now: () => now, principal: () => person,
    mayReadTarget: (_t, p) => mayRead && p.userId === person.userId, readPort: async () => null, card: async () => null,
    signal: new AbortController().signal, inbox: { publish: n => { notices.push(n); }, settle: () => {} },
    model: { async complete(req) {
      const data = JSON.parse(req.data).data;
      const text = req.stage === 'extract' ? JSON.stringify([{ kind: 'knowledge', change: 'add', contentKey: 'project-language-go',
        text: 'The project uses Go.', evidence: [{ source: 'message', id: data.messages[0].id }] }])
        : req.stage === 'skeptic' ? JSON.stringify({ verdict: 'holds' }) : JSON.stringify({ text: data.text });
      return { text, model: `fixture/${req.modelClass}`, inputTokens: 100, outputTokens: 100 };
    } } });
  return { service, store, sessions, config, notices, setNow: (at: number) => { now = at; }, revoke: () => { mayRead = false; }, close: async () => { await service.close(); sessions.close(); } };
}
test('LP6: full fake pipeline, guarded public acceptance, rollback and measured precision', async () => {
  const r = rig(), ctx: CallContext = { requestId: 'request', connectionId: 'connection', signal: new AbortController().signal };
  const calls: string[] = []; let identity = person;
  let guarded: Record<string, Handler>;
  const raw = { ...learnMethods(() => r.service, name => guarded[name]!),
    'memory.importText.apply': async (params: { entries: { text: string }[]; targets: { target: string; agentIds: string[] }[] }) => {
      calls.push('memory.importText.apply'); assert.equal(params.entries[0]!.text, 'The project uses Go.');
      assert.deepEqual(params.targets, [{ target: 'agent', agentIds: ['agent'] }]); return { runId: 'import-run', imported: 1, linked: 0 };
    }, 'memory.importText.rollback': async (params: { runId: string }) => { calls.push('memory.importText.rollback'); assert.equal(params.runId, 'import-run'); return { rolledBack: 1 }; } };
  guarded = guardMethods(raw, { resolve: () => identity, audit: memoryAuditSink(), now: () => 14 * DAY });
  try {
    const run = await r.service.run(target, person, ctx.signal);
    assert.equal(run.outcome, 'completed');
    const f = r.store.findings(run.id)[0]!; assert.equal(f.desiredTier, 'A'); assert.equal(f.effectiveTier, 'C'); assert.equal(f.skeptic, 'holds');
    const detail = r.service.get(f.id, person);
    assert.equal(detail.evidence.length, 3);
    assert.doesNotMatch(JSON.stringify(r.notices), /project uses Go/);
    assert.doesNotMatch(JSON.stringify(run), /project uses Go/);
    identity = { ...person, kind: 'agent' };
    await assert.rejects(() => guarded['dreams.learn.decide']!({ id: f.id, contentHash: detail.contentHash, outcome: 'accepted' }, ctx), (e: unknown) => e instanceof RpcError && e.error === 'E_DENIED');
    assert.equal(calls.length, 0);
    identity = person;
    await guarded['dreams.learn.decide']!({ id: f.id, contentHash: detail.contentHash, outcome: 'accepted' }, ctx);
    assert.equal(r.service.calibration(target, person).A.accepted, 1);
    await guarded['dreams.learn.rollback']!({ id: f.id }, ctx);
    assert.deepEqual(calls, ['memory.importText.apply', 'memory.importText.rollback']);
    assert.equal(r.service.calibration(target, person).A.allowed, false);
  } finally { await r.close(); }
});
test('LP6: rights revocation withholds evidence and public operation refusal never counts as acceptance', async () => {
  const r = rig();
  try {
    const run = await r.service.run(target, person, new AbortController().signal), id = r.store.findings(run.id)[0]!.id;
    const { contentHash } = r.service.get(id, person);
    await assert.rejects(() => r.service.decide({ id, contentHash, outcome: 'accepted' }, person, async () => { throw new RpcError('E_DENIED', 'refused'); }), /refused/);
    assert.equal(r.service.calibration(target, person).A.decided, 0);
    r.revoke(); assert.throws(() => r.service.get(id, person), /not available/);
  } finally { await r.close(); }
});
test('LP6: ambiguous mutation failure blocks replay and does not fabricate a decision', async () => {
  const r = rig();
  try {
    const run = await r.service.run(target, person, new AbortController().signal), id = r.store.findings(run.id)[0]!.id;
    const { contentHash } = r.service.get(id, person); let calls = 0;
    const call = async () => { calls++; throw Error('connection lost after write'); };
    await assert.rejects(() => r.service.decide({ id, contentHash, outcome: 'accepted' }, person, call));
    await assert.rejects(() => r.service.decide({ id, contentHash, outcome: 'accepted' }, person, call));
    assert.equal(calls, 1); assert.equal(r.service.calibration(target, person).A.decided, 0);
  } finally { await r.close(); }
});

test('LP6: targets default off and the existing scheduler due port does not start disabled work', async () => {
  const r = rig();
  try {
    r.config.dreams = { learn: { agents: { agent: { owner: 'person' } } } };
    await r.service.due(new AbortController().signal);
    assert.equal(r.store.runs('person').length, 0);
    assert.equal(r.service.nextRunAt(), null);
    assert.equal((await r.service.run(target, person, new AbortController().signal)).reason, 'disabled');
  } finally { await r.close(); }
});

test('LP6: learning configuration is a validated root namespace and all scopes default off', async () => {
  const { validate, restartClassOf, tierOf } = await import('@plur1bus/config-schema');
  const config = defaults();
  assert.equal(config.dreams?.learn?.installation?.enabled, false);
  assert.deepEqual(config.dreams?.learn?.agents, {});
  config.dreams!.learn!.agents = { agent: { enabled: true, owner: 'person' } };
  assert.equal(validate(config).ok, true);
  assert.equal(restartClassOf('dreams.learn.agents.agent.enabled'), 'core');
  assert.equal(tierOf('dreams.learn.agents.agent.enabled'), 'advanced');
  config.dreams!.learn!.maxSessions = 51;
  assert.equal(validate(config).ok, false);
});

test('LP6: publication cannot change a finding during an awaited human mutation', async () => {
  const r = rig();
  try {
    const run = await r.service.run(target, person, new AbortController().signal);
    const f = r.store.findings(run.id)[0]!, contentHash = r.service.get(f.id, person).contentHash;
    await r.service.decide({ id: f.id, contentHash, outcome: 'accepted' }, person, async () => {
      assert.equal(r.store.prepareCandidate({ ...f, text: 'A different finding' }), null);
      assert.equal(r.service.get(f.id, person).contentHash, contentHash);
      return { runId: 'receipt', imported: 1, linked: 0 };
    });
    assert.equal(r.store.finding(f.id)!.text, f.text);
  } finally { await r.close(); }
});

test('LP7: a future public H3 adapter receives pending findings once and only with live rights', async () => {
  let available = false, calls = 0;
  const r = rig({ available: () => available, async submit({ finding, idempotencyKey }) {
    assert.equal(finding.kind, 'procedural'); assert.match(idempotencyKey, /^learn:/); calls++; return { receiptId: 'h3-receipt' };
  } });
  try {
    const run = await r.service.run(target, person, new AbortController().signal), f = r.store.findings(run.id)[0]!;
    r.store.publish(run, [{ ...f, kind: 'procedural', status: 'waiting-h3' }], 14 * DAY);
    await r.service.handoff(); assert.equal(calls, 0);
    available = true; await r.service.handoff(); await r.service.handoff(); assert.equal(calls, 1);
    assert.equal(r.store.finding(f.id)!.status, 'waiting-h3'); assert.equal(r.store.decidedFindings('person').length, 0);
  } finally { await r.close(); }
});

test('LQ1: actual SessionStore erasure immediately withdraws derived review, without waiting for RPC or scheduler', async () => {
  const r = rig();
  try {
    const run = await r.service.run(target, person, new AbortController().signal), f = r.store.findings(run.id)[0]!;
    const sessionId = f.evidence[0]!.sessionId;
    r.sessions.archiveSession(sessionId);
    r.sessions.eraseSession(sessionId, { actor: 'person', reason: 'owner-request' });
    assert.equal(r.store.finding(f.id)!.status, 'withdrawn'); assert.equal(r.store.finding(f.id)!.text, '');
    assert.ok(r.store.finding(f.id)!.evidence.every(e => e.sessionId !== sessionId));
  } finally { await r.close(); }
});

test('LQ1: evidence excerpts are fetched live and never copied into the learning payload', async () => {
  const marker = ' SYNTHETIC PRIVATE EXCERPT';
  const r = rig(undefined, marker);
  try {
    const run = await r.service.run(target, person, new AbortController().signal), f = r.store.findings(run.id)[0]!;
    assert.ok(r.service.get(f.id, person).evidence.some(e => e.excerpt.includes(marker)));
    assert.equal(JSON.stringify(r.store.payload(run.id, `finding:${f.id}`)).includes(marker), false);
    assert.equal(JSON.stringify({ run, notices: r.notices, decisions: r.store.decisions(run.id) }).includes(marker), false);
    r.revoke(); assert.throws(() => r.service.get(f.id, person));
  } finally { await r.close(); }
});

test('LQ2: later full fake runs measure accepted repeats although they create no second review', async () => {
  const r = rig();
  try {
    const run = await r.service.run(target, person, new AbortController().signal), f = r.store.findings(run.id)[0]!;
    await r.service.decide({ id: f.id, contentHash: r.service.get(f.id, person).contentHash, outcome: 'accepted' }, person, async () => ({ runId: 'receipt', imported: 1, linked: 0 }));
    for (let i = 15; i < 25; i++) {
      r.setNow(i * DAY); const session = r.sessions.createSession({ kind: 'direct', agentId: 'agent', owner: deriveUserPrincipal('person') });
      const { turn } = r.sessions.beginTurn(session.id, 'The project uses Go.', 5); r.sessions.completeTurn(turn.id, { text: 'Acknowledged.', tokens: 2 });
    }
    r.setNow(30 * DAY); r.config.dreams!.learn!.windowDays = 30;
    const later = await r.service.run(target, person, new AbortController().signal);
    assert.equal(later.outcome, 'completed'); assert.equal(later.findings, 0);
    assert.equal(r.store.prediction(f.id)!.status, 'not-confirmed'); assert.equal(r.store.prediction(f.id)!.sessions, 10);
    assert.equal(r.service.get(f.id, person).prediction!.retireProposed, true);
  } finally { await r.close(); }
});
