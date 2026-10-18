import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SessionStore } from '../../src/session/store.ts';
import { WorkflowEvidence } from '../../src/skill-mining/evidence.ts';
import { mineSessionWorkflows, SkillMining, miningConfig, type MiningScope, type MiningTool, type SkillProposalQueue, type SkillCandidate } from '../../src/skill-mining/miner.ts';
import { useTempDirs, scriptedAdapter, turnFixture, readTool, collect } from '../composition/helpers.ts';
const dirs = useTempDirs('l11-miner-');
const scope: MiningScope = { owner: 'person-a', agentId: 'agent-a', scope: 'project-a' };
const tools: MiningTool[] = ['file.stat', 'file.read', 'file.list'].map(name => ({ name, version: createHash('sha256').update(name).digest('hex') }));
function rig() {
  const home = dirs.make(); const clock = () => Date.UTC(2026, 9, 16);
  const store = new SessionStore({ path: join(home, 'sessions.sqlite'), clock }); const evidence = new WorkflowEvidence(join(home, 'mining.sqlite'));
  function add(over: Partial<MiningScope> & { failed?: boolean; incognito?: boolean; active?: boolean; proven?: boolean; steps?: MiningTool[]; errorResult?: boolean } = {}) {
    const selected = { ...scope, ...over }; const session = store.createSession({ kind: 'direct', owner: selected.owner, agentId: selected.agentId, scope: selected.scope, title: 'private-title-marker', memoryMode: over.incognito ? 'incognito' : 'remember' });
    const { turn } = store.beginTurn(session.id, 'private-user-marker', 1);
    for (const [i, tool] of (over.steps ?? tools.slice(0, 2)).entries()) {
      const callId = `call-${i}`;
      store.appendEvent(turn.id, 'tool.call', { id: callId, name: tool.name, args: { value: 'private-secret-marker', foreign: 'foreign-scope-marker' } });
      store.appendEvent(turn.id, 'tool.result', { id: callId, output: JSON.stringify({ isError: over.errorResult === true, value: 'private-result-marker' }) });
      if (over.proven !== false) evidence.record({ owner: selected.owner, agentId: selected.agentId, sessionId: session.id, turnId: turn.id, callId, tool: tool.name, version: tool.version, success: over.errorResult !== true });
    }
    if (over.failed) store.failTurn(turn.id, 'failure'); else store.completeTurn(turn.id, { text: 'private-answer-marker', tokens: 1 });
    if (!over.active) store.archiveSession(session.id); return session;
  }
  return { home, store, evidence, add, close() { store.close(); evidence.close(); } };
}
function fakeQueue() {
  const records = new Map<string, { id: string; status: 'pending' | 'accepted' | 'rejected'; candidate: SkillCandidate }>();
  const key = (s: MiningScope, h: string) => JSON.stringify([s, h]);
  const queue: SkillProposalQueue = { supportsSkillArtifacts: true, async find(s, h) { return records.get(key(s, h)) ?? null; }, async propose(s, candidate) { const id = `proposal-${records.size}`; records.set(key(s, candidate.workflowHash), { id, status: 'pending', candidate }); return { id, status: 'pending' }; } };
  return { queue, records };
}
test('two proven completed same-scope sessions yield an inactive skill with provenance IDs and no session contents', () => {
  const r = rig(); const a = r.add(), b = r.add(); r.add({ owner: 'foreign-owner' }); r.add({ agentId: 'foreign-agent' }); r.add({ scope: 'foreign-project' });
  try {
    const candidates = mineSessionWorkflows(r.store, scope, tools, r.evidence); assert.equal(candidates.length, 1); const candidate = candidates[0]!;
    assert.equal(candidate.enabled, false); assert.equal(candidate.author, 'agent'); assert.deepEqual(candidate.sessionIds, [a.id, b.id].sort());
    const text = JSON.stringify(candidate); for (const marker of ['private-title-marker', 'private-user-marker', 'private-secret-marker', 'private-result-marker', 'private-answer-marker', 'foreign-scope-marker', 'foreign-owner', 'foreign-project']) assert(!text.includes(marker), marker);
    assert(candidate.skillMd.includes('file.stat')); assert(candidate.skillMd.includes('file.read'));
  } finally { r.close(); }
});
test('active, incognito, failed, unproven and error-result sessions cannot train mining; repetitions within one session count once', () => {
  const r = rig(); r.add(); r.add({ active: true }); r.add({ incognito: true }); r.add({ failed: true }); r.add({ proven: false }); r.add({ errorResult: true });
  try { assert.deepEqual(mineSessionWorkflows(r.store, scope, tools, r.evidence), []); assert.throws(() => miningConfig({ ...miningConfig(), minSessions: 1 })); } finally { r.close(); }
});
test('agent views cannot inject foreign sessions or events; partial source windows fail closed', () => {
  const r = rig(); const foreign = r.add({ owner: 'foreign-owner' }); r.add();
  try {
    const source = { listSessions: () => ({ sessions: [foreign], truncated: false }), listTurns: r.store.listTurns.bind(r.store), listEvents: r.store.listEvents.bind(r.store) };
    assert.deepEqual(mineSessionWorkflows(source, scope, tools, r.evidence), []);
    assert.throws(() => mineSessionWorkflows({ ...source, listSessions: () => ({ sessions: [], truncated: true }) }, scope, tools, r.evidence), (e: any) => e.error === 'E_NOT_AVAILABLE');
  } finally { r.close(); }
});
test('rejected hash stays suppressed on another mining run; changed workflow gets its own proposal; no installer or activation', async () => {
  const r = rig(); r.add(); r.add(); const q = fakeQueue();
  const miner = new SkillMining(r.store, () => tools, r.evidence, q.queue);
  try {
    assert.equal((await miner.propose(scope)).ids.length, 1);
    const record = [...q.records.values()][0]!; record.status = 'rejected';
    const restarted = new SkillMining(r.store, () => tools, r.evidence, q.queue); assert.deepEqual(await restarted.propose(scope), { ids: [], duplicates: 1 });
    r.add({ steps: [tools[0]!, tools[2]!] }); r.add({ steps: [tools[0]!, tools[2]!] });
    assert.equal((await restarted.propose(scope)).ids.length, 1); assert.equal(q.records.size, 2); assert([...q.records.values()].every(p => p.candidate.enabled === false));
  } finally { r.close(); }
});
test('missing engine artifact API fails before proposing; own system job reports the contract gap and accepts no caller scope', async () => {
  const r = rig(); r.add(); r.add(); const miner = new SkillMining(r.store, () => tools, r.evidence);
  try {
    assert.equal(miner.status().available, false); await assert.rejects(miner.propose(scope), (e: any) => e.error === 'E_NOT_AVAILABLE' && e.reason === 'skill-proposal-contract-unavailable');
    const job = miner.job(scope); assert.throws(() => job.validateArgs({ owner: 'foreign-owner' }));
    assert.equal((await job.run({}, { runId: 'job', trigger: 'manual', signal: new AbortController().signal })).outcome, 'skipped');
  } finally { r.close(); }
});
test('workflow evidence survives restart and binds owner, agent, session, call, tool and version', () => {
  const home = dirs.make(), path = join(home, 'proof.sqlite'); const record = { owner: scope.owner, agentId: scope.agentId, sessionId: 'session', turnId: 'turn', callId: 'call', tool: tools[0]!.name, version: tools[0]!.version, success: true };
  let ledger = new WorkflowEvidence(path); ledger.record(record); ledger.close(); ledger = new WorkflowEvidence(path);
  try {
    assert(ledger.verified(scope, 'session', 'turn', 'call', record.tool, record.version));
    assert(!ledger.verified({ ...scope, owner: 'foreign-owner' }, 'session', 'turn', 'call', record.tool, record.version));
    assert(!ledger.verified(scope, 'session', 'turn', 'call', record.tool, 'different-version'));
  } finally { ledger.close(); }
});
test('only a real dispatcher result reaches the mining evidence hook', async () => {
  const home = dirs.make(); const records: unknown[] = []; const wire = scriptedAdapter([{ calls: [{ id: 'read', name: 'file_read', args: { path: 'x' } }] }, { text: 'done' }]);
  const f = turnFixture(wire.adapter, { onExecution: e => records.push(e) }, home); f.registry.register(readTool('file.read', async () => 'private-result-marker'));
  try { await collect(f.provider); assert.equal(records.length, 1); assert.equal((records[0] as { success: boolean }).success, true); assert(!JSON.stringify(records).includes('private-result-marker')); } finally { f.close(); }
});
test('pending candidates never enter the live capability index; concurrent mining coalesces within one scope', async () => {
  const r = rig(); r.add(); r.add(); const q = fakeQueue(); const miner = new SkillMining(r.store, () => tools, r.evidence, q.queue);
  const { mkdirSync } = await import('node:fs'); const { LiveCapabilityIndex } = await import('../../src/toolcall/live-index.ts'); mkdirSync(join(r.home, 'state'));
  const live = new LiveCapabilityIndex(r.home);
  try {
    await Promise.all([miner.propose(scope), miner.propose(scope)]); assert.equal(q.records.size, 1);
    assert.equal(live.view('A', [], {}, scope.agentId).skills.length, 0); assert.equal(live.registry.snapshot().filter(e => e.kind === 'skill').length, 0);
  } finally { live.close(); r.close(); }
});
test('workflow identity is stable across equivalent scope property order and repeated proposal calls', async () => {
  const r = rig(); r.add(); r.add(); const q = fakeQueue(); const miner = new SkillMining(r.store, () => tools, r.evidence, q.queue);
  try {
    const reversed: MiningScope = { scope: scope.scope, agentId: scope.agentId, owner: scope.owner };
    assert.equal((await miner.preview(scope))[0]!.workflowHash, (await miner.preview(reversed))[0]!.workflowHash);
    await miner.propose(scope); assert.deepEqual(await miner.propose(reversed), { ids: [], duplicates: 1 });
  } finally { r.close(); }
});
