import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillReview, UnavailableSkillProposals, skillProposalHash, type SkillProposalBackend, type SkillProposal } from '../../src/skill-mining/review.ts';
import { rig, tick, lastNonce } from '../approvals/service-helpers.ts';
const scope = { owner: 'christian', agentId: 'bernd', scope: 'user' };
const actor = () => ({ principal: 'christian', role: 'owner', surface: 3 as const, signal: new AbortController().signal });
function fixture() {
  let proposal: SkillProposal = { id: 'p1', scope, status: 'pending', candidate: {
    schema: 'plur1bus.skill-candidate/1', kind: 'skill', author: 'agent', enabled: false,
    name: 'mined-workflow-0123456789abcdef', workflowHash: 'a'.repeat(64), skillMd: '# Reviewed workflow\n', reason: 'Two sessions', sessionIds: ['s1', 's2'],
  } };
  const calls: string[] = [];
  const backend: SkillProposalBackend = {
    state: 'ready', supportsSkillArtifacts: true,
    async find() { return { id: 'p1', status: proposal.status }; },
    async propose() { return { id: 'p1', status: 'pending' }; },
    async list() { return [structuredClone(proposal)]; },
    // Deliberately returns the same mutable object to test the snapshot boundary.
    async get() { return proposal; },
    async accept(_scope, id, expectedHash) { assert.equal(id, 'p1'); assert.equal(expectedHash, skillProposalHash(proposal)); calls.push('accept'); proposal.status = 'accepted'; },
    async reject(_scope, id, expectedHash) { assert.equal(id, 'p1'); assert.equal(expectedHash, skillProposalHash(proposal)); calls.push('reject'); proposal.status = 'rejected'; },
  };
  return { backend, calls, proposal };
}
test('current production backend is engine-unavailable for every operation without opening approvals', async () => {
  const backend = new UnavailableSkillProposals(); let opened = 0;
  const review = new SkillReview(backend, { async request() { opened++; throw new Error('must not open'); }, begin() { throw new Error('must not begin'); } });
  assert.equal(review.status().state, 'engine-unavailable');
  for (const operation of [() => backend.find(), () => backend.propose(), () => backend.list(), () => backend.get(), () => backend.accept(), () => backend.reject(), () => review.preview(scope, 'p1', actor()), () => review.decide(scope, 'p1', 'accept', actor())]) {
    await assert.rejects(operation, (e: any) => e.error === 'E_NOT_AVAILABLE' && e.reason === 'engine-unavailable');
  }
  assert.equal(opened, 0);
});
for (const decision of ['accept', 'reject'] as const) test(`skill ${decision} uses the real approval surface and consumes a once grant without installing or enabling`, async () => {
  const r = await rig(); const f = fixture();
  try {
    const review = new SkillReview(f.backend, r.service);
    const pending = review.decide(scope, 'p1', decision, actor());
    await tick(); const { id, nonce } = lastNonce(r);
    const shown = r.service.get(id)!;
    assert.equal(shown.tool, 'skills.proposals.review');
    assert.match(shown.summary!, /Reviewed workflow/);
    assert.deepEqual(shown.grantOptions!.map(o => o.scope), ['once']);
    assert.deepEqual(f.calls, []);
    assert.ok(r.service.decide({ requestId: id, nonce, decision: 'approve', person: 'christian', surface: 3 }).ok);
    await pending;
    assert.deepEqual(f.calls, [decision]); assert.equal(f.proposal.candidate.enabled, false);
    assert.notEqual(r.stores.grants.inspect()[0]!.grant.consumedAt, undefined);
    await assert.rejects(review.decide(scope, 'p1', decision, actor()));
  } finally { r.service.dispose(); }
});
test('changed proposal bytes after human preview cannot use the approval, including in-place adapter mutation', async () => {
  const r = await rig(); const f = fixture();
  try {
    const pending = new SkillReview(f.backend, r.service).decide(scope, 'p1', 'accept', actor());
    const rejected = assert.rejects(pending, /changed during review/);
    await tick(); const { id, nonce } = lastNonce(r);
    f.proposal.candidate.skillMd += 'Changed after preview';
    assert.ok(r.service.decide({ requestId: id, nonce, decision: 'approve', person: 'christian', surface: 3 }).ok);
    await rejected; assert.deepEqual(f.calls, []);
  } finally { r.service.dispose(); }
});
test('denial never reaches the engine mutation and roles, foreign scopes and active artifacts fail closed', async () => {
  const r = await rig(); const f = fixture();
  try {
    const review = new SkillReview(f.backend, r.service);
    await assert.rejects(review.preview(scope, 'p1', { ...actor(), role: 'agent' }), /owner or admin/);
    await assert.rejects(review.preview({ ...scope, owner: 'other' }, 'p1', actor()), /this scope/);
    (f.proposal.candidate as any).enabled = true;
    await assert.rejects(review.preview(scope, 'p1', actor()), /active skill/);
    f.proposal.candidate.enabled = false;
    const pending = review.decide(scope, 'p1', 'accept', { ...actor(), role: 'admin' });
    const rejected = assert.rejects(pending, /not approved/);
    await tick(); const { id, nonce } = lastNonce(r);
    assert.ok(r.service.decide({ requestId: id, nonce, decision: 'deny', person: 'christian', surface: 3 }).ok);
    await rejected; assert.deepEqual(f.calls, []);
  } finally { r.service.dispose(); }
});
test('an approved boolean without a valid single-use receipt cannot authorize skill review', async () => {
  const f = fixture(); let began = 0;
  const review = new SkillReview(f.backend, { async request() { return { approved: true, scope: 'once' }; }, begin() { began++; return false; } });
  await assert.rejects(review.decide(scope, 'p1', 'accept', actor()), /already consumed/);
  assert.equal(began, 1); assert.deepEqual(f.calls, []);
});
