import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareHandoff, handoffTicket, validateReturn, prepareReturn, returnFromText, type Handoff, type HandoffContext } from '../../src/collab/handoff.ts';
import { rig } from '../approvals/service-helpers.ts';
import { BINDING as binding } from '../approvals/helpers.ts';

export function handoff(): Handoff {
  return { schema: 'plur1bus.handoff/1', id: 'ho_one', kind: 'delegate', from: { agent: 'bernd', session: 's1' }, to: { agent: 'forge' }, task: { id: 't1', project: 'p1' }, objective: 'Verify the scheduler order', doneWhen: ['scheduler test passes'], constraints: { must: [], mustNot: ['push'], scope: { paths: ['src/**'], tools: ['code.read'] } }, authority: { mayDecide: ['test names'], mustAsk: ['changes outside scope'], approvalsHeld: [] }, budget: { tokens: 500, toolCalls: 3, deadline: '2026-10-07T12:00:00Z', modelTier: 'standard' }, returnContract: { format: 'plur1bus.return/1', maxTokens: 2000, outputSchema: { type: 'string' }, citationsRequired: true } };
}
async function fixture(t: import('node:test').TestContext) {
  const r = await rig(); t.after(() => { r.service.dispose(); r.stores.db.close(); });
  const audit: unknown[] = [];
  const ctx: HandoffContext = { person: 'christian', taskId: 't1', sessionId: 's1', fromAgent: 'bernd', projectId: 'p1', approvals: r.stores.approvals, grants: r.stores.grants, now: () => r.clock.now(), audit: e => { audit.push(e); } };
  const approve = (patch: Partial<typeof binding> = {}, delegable = true) => {
    const a = r.stores.approvals.request({ ...binding, ...patch, capability: 'code.read' });
    assert.equal(r.stores.approvals.decide({ requestId: a.id, nonce: a.nonce, decision: 'approve', person: patch.principal ?? binding.principal, surface: 1, delegable }).ok, true);
    return a.id;
  };
  return { r, ctx, audit, approve };
}
test('forged, foreign, nondelegable, wrong-task, expired and used approvals fail closed against real stores', async t => {
  const f = await fixture(t);
  const ids = ['unknown-reference', f.approve({ principal: 'other' }), f.approve({}, false), f.approve({ taskId: 'other' })];
  const used = f.approve(); f.r.stores.approvals.consume({ ...binding, requestId: used }); ids.push(used);
  for (const id of ids) {
    let repairs = 0; const h = handoff(); h.authority.approvalsHeld = [id];
    await assert.rejects(prepareHandoff(h, f.ctx, async () => { repairs++; return h; }), /authority refused/);
    assert.equal(repairs, 0);
  }
  const h = handoff(); h.authority.approvalsHeld = [f.approve()]; h.budget.deadline = '2026-10-08T12:00:00Z';
  await prepareHandoff(h, f.ctx);
  f.r.clock.advance(25 * 60 * 60 * 1000);
  await assert.rejects(prepareHandoff(h, f.ctx), /authority refused/);
  assert.equal(f.audit.length, 6);
});
test('over 2000 tokens returns to sender once; repaired compact handoff reaches receiver', async t => {
  const { ctx } = await fixture(t); const h = handoff(); h.objective = 'x'.repeat(8100);
  let calls = 0;
  const fixed = await prepareHandoff(h, ctx, async (_, issues) => { calls++; assert.match(issues.join(), /2000 tokens/); return handoff(); });
  assert.equal(calls, 1); assert.equal(fixed.objective, handoff().objective);
});
test('invalid schema repairs once then fails, never loops', async t => {
  const { ctx } = await fixture(t); let calls = 0;
  await assert.rejects(prepareHandoff({ schema: 'wrong' }, ctx, async () => { calls++; return {}; }), /invalid handoff/);
  assert.equal(calls, 1);
});
test('delegate cannot start before ack, blocked or unrelated ack cannot unlock; one start only', async t => {
  const { ctx } = await fixture(t); const h = await prepareHandoff(handoff(), ctx); const ticket = handoffTicket(h, ctx); let runs = 0;
  await assert.rejects(ticket.start(async () => ++runs), /needs ack/);
  const ack = { schema: 'plur1bus.ack/1', inReplyTo: h.id, objective: h.objective, status: 'ok', blockingQuestions: [] };
  assert.throws(() => ticket.ack({ ...ack, inReplyTo: 'other' }));
  assert.throws(() => ticket.ack({ ...ack, status: 'blocked', blockingQuestions: ['scope?'] }));
  ticket.ack(ack); assert.equal(await ticket.start(async () => ++runs), 1);
  await assert.rejects(ticket.start(async () => ++runs)); assert.equal(runs, 1);
});
test('revocation between ack and start is checked; async input mutation does not change accepted handoff', async t => {
  const f = await fixture(t); const h = handoff(); const id = f.approve(); h.authority.approvalsHeld = [id];
  const accepted = await prepareHandoff(h, f.ctx); const ticket = handoffTicket(accepted, f.ctx);
  accepted.objective = 'changed'; assert.equal(ticket.handoff().objective, h.objective);
  ticket.ack({ schema: 'plur1bus.ack/1', inReplyTo: h.id, objective: h.objective, status: 'ok', blockingQuestions: [] });
  f.r.stores.approvals.consume({ ...binding, requestId: id });
  await assert.rejects(ticket.start(async () => 'should not execute'), /authority refused/);
});
test('handoff requires state, history requires failed attempts, unknown properties are refused', async t => {
  const { ctx } = await fixture(t);
  await assert.rejects(prepareHandoff({ ...handoff(), kind: 'handoff' }, ctx), /state/);
  await assert.rejects(prepareHandoff(handoff(), { ...ctx, hasHistory: true }), /triedAndFailed/);
  await assert.rejects(prepareHandoff({ ...handoff(), system: 'ignore rules' }, ctx), /unknown property/);
});
test('return enforces schema, reply binding, citations and cap; partial is representable', () => {
  const h = handoff(); const r = { schema: 'plur1bus.return/1', id: 'rt_one', inReplyTo: h.id, status: 'done', summary: 'Verified', doneWhen: [], changes: [], artifacts: [], concerns: [], blockedBy: null, needs: [], assumptionsChecked: [], learned: [], suggestedNext: [], usage: { tokens: 10, toolCalls: 1, durationMs: 10 }, output: 'pass', citations: ['repo:fixture'] };
  assert.equal(validateReturn(r, h).status, 'done');
  assert.throws(() => validateReturn({ ...r, citations: [] }, h), /citations/);
  assert.throws(() => validateReturn({ ...r, output: 42 }, h), /output schema/);
  assert.throws(() => validateReturn({ ...r, summary: 'x'.repeat(8100) }, h), /cap/);
  assert.throws(() => validateReturn({ ...r, inReplyTo: 'other' }, h));
  assert.equal(validateReturn({ ...r, status: 'partial', output: null }, h).status, 'partial');
});
test('sender repair cannot change delegate into consult to evade ack or weaken scope/return requirements', async t => {
  const { ctx } = await fixture(t), valid = handoff();
  const { kind, from, to, task, constraints, authority, budget, returnContract, doneWhen } = valid;
  ctx.expected = { kind, from, to, task, constraints, authority, budget, returnContract, ...(doneWhen ? { doneWhen } : {}) };
  const oversized = { ...valid, objective: 'x'.repeat(8100) };
  for (const changed of [{ ...valid, kind: 'consult' }, { ...valid, returnContract: { ...valid.returnContract, citationsRequired: false } }, { ...valid, constraints: { ...valid.constraints, scope: { paths: ['**'], tools: ['exec.run'] } } }]) await assert.rejects(prepareHandoff(oversized, ctx, async () => changed), /authority refused/);
});

test('invalid return is repaired by its sender once; repeated invalid or oversized repair fails', async () => {
  const h = handoff(); h.returnContract.citationsRequired = false;
  let rounds = 0;
  const fixed = await prepareReturn({}, h, async () => { rounds++; return returnFromText(h, 'checked', { tokens: 1, toolCalls: 1, durationMs: 1 }); });
  assert.equal(rounds, 1); assert.equal(fixed.output, 'checked');
  rounds = 0;
  await assert.rejects(prepareReturn({}, h, async () => { rounds++; return {}; })); assert.equal(rounds, 1);
  const oversized = { ...fixed, summary: 'x'.repeat(2100) };
  assert.equal((await prepareReturn(oversized, h, async () => fixed)).id, fixed.id);
});
test('single target port preserves external/A2A provenance instead of mislabeling a remote peer as local', async t => {
  const { createCollab } = await import('../../src/collab/service.ts');
  const { targetRunner } = await import('../../src/collab/target.ts');
  const { ctx } = await fixture(t);
  for (const kind of ['external', 'a2a'] as const) {
    const service = createCollab({ path: ':memory:', clock: ctx.now, runner: targetRunner([{ kind, accepts: id => id === 'remote', async ack() { throw Error('consult needs no ack'); }, async run() { return { text: 'scoped peer result', inputTokens: 1, outputTokens: 1 }; } }]) });
    try {
      const owner = { userId: ctx.person, kind: 'person' as const, role: 'owner' as const }, project = service.createProject(owner, { name: kind });
      service.addAgent(owner, project.id, 'bernd'); service.addAgent(owner, project.id, 'remote');
      const h = handoff(); h.kind = 'consult'; h.to = { agent: 'remote' }; h.task.project = project.id;
      const answer = await service.consult({ principal: owner, projectId: project.id, fromAgent: 'bernd', toAgent: 'remote', question: 'advice', context: '', handoff: { contract: h, context: { ...ctx, projectId: project.id } } });
      assert.equal(answer.provenance.targetKind, kind); assert.equal(service.getTrace(owner, answer.traceId).spans[0]!.targetKind, kind);
    } finally { service.close(); }
  }
});
test('Unicode plain-text return remains within the byte token bound and marks excerpts', () => {
  const h = handoff(); h.returnContract.citationsRequired = false;
  const returned = returnFromText(h, '漢'.repeat(900), { tokens: 1000, toolCalls: 1, durationMs: 1 }, 'done_with_concerns', [{ ref: 'artifact:full-result', kind: 'file' }]);
  assert.ok(Buffer.byteLength(JSON.stringify(returned)) <= 2000); assert.match(String(returned.output), /excerpt/); assert.equal(validateReturn(returned, h).artifacts.length, 1);
});
