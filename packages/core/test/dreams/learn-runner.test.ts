import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, parseExtraction } from '../../src/dreams/learn/aggregation.ts';
import { LearnRunner } from '../../src/dreams/learn/runner.ts';
import { LearnStore } from '../../src/dreams/learn/store.ts';
import { deriveUserPrincipal } from '../../src/identity/principals.ts';
import { DEFAULT_LEARN_CONFIG, type Evidence, type RawFinding, type Target, type Transcript } from '../../src/dreams/learn/types.ts';

const target: Target = { scope: 'agent', owner: 'person-one', agentId: 'agent-one' };
const principal = { userId: target.owner, kind: 'person' as const, role: 'owner' as const };
function transcript(id: string): Transcript {
  return { session: { id, agentId: target.agentId, owner: deriveUserPrincipal(target.owner), scope: '', kind: 'direct', chatKey: null, title: '', pinned: false, memoryMode: 'remember', createdAt: 1, updatedAt: 2, lastTurnAt: 2, archivedAt: null, turnCount: 1 },
    messages: [{ id: `m-${id}`, sessionId: id, turnId: 'turn-one', seq: 1, role: 'user', text: 'The project uses Go.', tokens: 5, createdAt: 2 }], events: [], days: ['1970-01-01'] };
}
const evidence = (s: string, agent: string, day: string): Evidence => ({ sessionId: s, turnId: 'turn-one', sourceId: `m-${s}`, source: 'message', trust: 'person', day, agentId: agent, owner: 'person-one' });
test('aggregation golden is invariant to sessions, finding order and repeated evidence', () => {
  const raw: RawFinding[] = [
    { kind: 'knowledge', change: 'add', contentKey: 'project-language', text: 'Uses Go', evidence: [evidence('s2', 'a2', '2026-11-02')] },
    { kind: 'knowledge', change: 'add', contentKey: 'project-language', text: 'Uses Go', evidence: [evidence('s1', 'a1', '2026-11-01'), evidence('s1', 'a1', '2026-11-01')] },
    { kind: 'procedural', change: 'correct', text: 'Check tool configuration', evidence: [evidence('s1', 'a1', '2026-11-01')] },
  ];
  const result = aggregate(raw, target, 'run-one', 3);
  assert.deepEqual(aggregate([...raw].reverse(), target, 'run-one', 3), result);
  assert.deepEqual(result.map(f => ({ text: f.text, prevalence: f.prevalence, state: f.status })), [
    { text: 'Uses Go', prevalence: { sessions: 2, total: 3, days: 2, agents: 2, persons: 1 }, state: 'pending' },
    { text: 'Check tool configuration', prevalence: { sessions: 1, total: 3, days: 1, agents: 1, persons: 1 }, state: 'waiting-h3' },
  ]);
});
test('a model cannot forge trust or evidence identity and tool output remains untrusted', () => {
  const t = transcript('s1'); t.messages[0]!.role = 'tool';
  const raw = { kind: 'knowledge', change: 'add', contentKey: 'project-language', text: 'injected finding', evidence: [{ source: 'message', id: 'm-s1' }] };
  assert.equal(parseExtraction(JSON.stringify([raw]), t)[0]!.evidence[0]!.trust, 'untrusted');
  assert.throws(() => parseExtraction(JSON.stringify([{ ...raw, trust: 'person' }]), t), /invalid-output/);
  assert.throws(() => parseExtraction(JSON.stringify([{ ...raw, evidence: [{ source: 'message', id: 'foreign' }] }]), t), /invalid-output/);
});
function rig() {
  const store = new LearnStore(':memory:'), transcripts = [transcript('s1'), transcript('s2')];
  const cfg = { ...DEFAULT_LEARN_CONFIG, enabled: true }; let calls = 0, failSecond = false, rights = true;
  const runner = new LearnRunner({ store, now: () => 100, principal: () => principal, config: () => cfg,
    source: { sessions: () => transcripts.map(t => t.session), transcript: s => transcripts.find(t => t.session.id === s.id)!, mayRead: () => rights },
    model: { async complete(request) {
      calls++; assert.equal(request.modelClass, 'small'); assert.equal(request.stage, 'extract'); assert.match(request.data, /UNTRUSTED_DATA/);
      assert.equal(store.runs(target.owner).length, 1);
      if (failSecond && calls === 2) throw Error('PRIVATE_PROVIDER_ERROR');
      const data = JSON.parse(request.data).data;
      return { text: JSON.stringify([{ kind: 'knowledge', change: 'add', contentKey: 'project-language', text: 'Uses Go', evidence: [{ source: 'message', id: data.messages[0].id }] }]), model: 'fixture/small', inputTokens: 1000, outputTokens: 500 };
    } } });
  return { store, runner, cfg, calls: () => calls, fail: () => { failSecond = true; }, revoke: () => { rights = false; } };
}
test('budget exhaustion publishes no half batch; resume reuses extraction checkpoints and completed runs are idempotent', async () => {
  const r = rig(); const signal = new AbortController().signal;
  try {
    r.cfg.maxTokens = 6000;
    const skipped = await r.runner.run(target, { from: 1, to: 90 }, signal);
    assert.equal(skipped.reason, 'budget'); assert.equal(r.store.findings(skipped.id).length, 0); assert.equal(r.calls(), 1);
    r.cfg.maxTokens = 30_000;
    const resumed = await r.runner.run(target, { from: 1, to: 90 }, signal);
    assert.equal(resumed.id, skipped.id); assert.equal(resumed.outcome, 'completed'); assert.equal(r.calls(), 2);
    assert.equal(r.store.findings(resumed.id).length, 1);
    await r.runner.run(target, { from: 1, to: 90 }, signal); assert.equal(r.calls(), 2);
  } finally { r.store.close(); }
});
test('provider failure is a fixed ledger class and retry preserves completed session work', async () => {
  const r = rig(); r.fail(); const signal = new AbortController().signal;
  try {
    const first = await r.runner.run(target, { from: 1, to: 90 }, signal);
    assert.equal(first.outcome, 'failed'); assert.doesNotMatch(JSON.stringify(first), /PRIVATE_PROVIDER_ERROR/);
    assert.equal(r.store.findings(first.id).length, 0);
    const next = await r.runner.run(target, { from: 1, to: 90 }, signal);
    assert.equal(next.outcome, 'completed'); assert.equal(r.calls(), 3);
  } finally { r.store.close(); }
});

test('M5: session overflow is retained as metadata in the run ledger', async () => {
  const r = rig(); r.cfg.maxSessions = 1;
  try {
    const run = await r.runner.run(target, { from: 1, to: 90 }, new AbortController().signal);
    assert.equal(run.outcome, 'completed');
    assert.equal(r.store.get(run.id)?.truncated, true);
    assert.equal(r.store.get(run.id)?.omittedSessions, 1);
  } finally { r.store.close(); }
});

test('M1: three paraphrases share a code-counted vocabulary cluster; memory changes use memoryId', () => {
  const rows: RawFinding[] = ['The project uses Go.', 'Go is the project language.', 'Implementation language: Go.'].map((text, i) => ({
    kind: 'knowledge', change: 'add', contentKey: 'project-language-go', text,
    evidence: [evidence(`s${i}`, 'agent', `2026-11-0${i + 1}`)],
  }));
  const grouped = aggregate(rows, target, 'run', 3);
  assert.equal(grouped.length, 1); assert.equal(grouped[0]!.prevalence.sessions, 3);
  assert.deepEqual(aggregate([...rows].reverse(), target, 'run', 3), grouped);
  for (const change of ['correct', 'duplicate', 'stale', 'retire'] as const) {
    assert.equal(aggregate(rows.map(r => ({ ...r, change, memoryId: 'card-one', contentKey: r.text })), target, 'run', 3).length, 1);
  }
});

test('M1: the next isolated extraction receives the previously established vocabulary', async () => {
  const store = new LearnStore(':memory:'), rows = [transcript('s1'), transcript('s2'), transcript('s3')];
  let calls = 0;
  const runner = new LearnRunner({ store, now: () => 100, principal: () => principal, config: () => ({ ...DEFAULT_LEARN_CONFIG, enabled: true }),
    source: { sessions: () => rows.map(t => t.session), transcript: s => rows.find(t => t.session.id === s.id)!, mayRead: () => true },
    model: { async complete(request) {
      const data = JSON.parse(request.data).data;
      assert.equal(data.vocabulary.length, calls === 0 ? 0 : 1);
      if (calls) assert.equal(data.vocabulary[0].key, 'project-language-go');
      const text = ['The project uses Go.', 'Go is the project language.', 'Implementation language: Go.'][calls++]!;
      return { text: JSON.stringify([{ kind: 'knowledge', change: 'add', contentKey: 'project-language-go', text, evidence: [{ source: 'message', id: data.messages[0].id }] }]), model: 'fixture/small', inputTokens: 100, outputTokens: 100 };
    } } });
  try {
    const run = await runner.run(target, { from: 1, to: 90 }, new AbortController().signal);
    assert.equal(run.outcome, 'completed'); assert.equal(calls, 3);
    assert.equal(store.findings(run.id).length, 1); assert.equal(store.findings(run.id)[0]!.prevalence.sessions, 3);
  } finally { store.close(); }
});

test('LP6: same-window failures count toward the persistent breaker, even across retries', async () => {
  const store = new LearnStore(':memory:'), t = transcript('s'); let calls = 0;
  const runner = new LearnRunner({ store, now: () => 100, principal: () => principal, config: () => ({ ...DEFAULT_LEARN_CONFIG, enabled: true }),
    source: { sessions: () => [t.session], transcript: () => t, mayRead: () => true },
    model: { async complete() { calls++; throw Error('fixture failure'); } } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await runner.run(target, { from: 1, to: 90 }, new AbortController().signal)).outcome, 'failed');
    assert.equal((await runner.run(target, { from: 1, to: 90 }, new AbortController().signal)).reason, 'breaker-open');
    assert.equal(calls, 3);
  } finally { store.close(); }
});
