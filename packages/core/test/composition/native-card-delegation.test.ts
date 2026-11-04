import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { delegationWorkBudget } from '../../src/collab/limits.ts';
import type { AgentRunInput } from '../../src/collab/runner.ts';
import { alsAgentScopePort, runWithAgentScope, scopeFor } from '../../src/collab/scope.ts';
import { composedAgentRunner } from '../../src/composition/collaboration.ts';
import { provisionedWorktreePort } from '../../src/external-agents/provisioner.ts';
import type { ChatProvider, ChatRequest } from '../../src/session/provider.ts';
import { nativeWorktreeBinding } from '../../src/tools/sandbox/worktree-mount.ts';
import { rig } from '../approvals/service-helpers.ts';
import { nativeCardFixture } from './native-card-fixture.ts';

async function delegated(kind: 'delegate' | 'handoff' = 'delegate') {
  const b = nativeCardFixture(), approvals = await rig();
  const traceId = randomUUID(), spanId = randomUUID(), taskId = randomUUID(), sessionId = randomUUID();
  const scope = { ...scopeFor('worker', b.project.id), toolView: ['exec.run', 'file.write'],
    delegation: { traceId, spanId, path: ['lead', 'worker'], callClass: 'write' as 'write' | 'read' | 'review', workBudget: delegationWorkBudget(10000) } };
  const input: AgentRunInput = { agentId: 'worker', principal: b.who, question: 'Code', context: '', sessionId,
    signal: new AbortController().signal, origin: { fromAgent: 'lead', traceId, spanId }, handoff: {
      contract: { schema: 'plur1bus.handoff/1', id: randomUUID(), kind,
        ...(kind === 'handoff' ? { state: { done: [], current: 'Implement card', next: ['Verify result'] } } : {}), from: { agent: 'lead', session: sessionId },
        to: { agent: 'worker' }, task: { id: taskId, project: b.project.id, card: b.card.id }, objective: 'Code', doneWhen: ['verified'],
        constraints: { must: [], mustNot: [], scope: { paths: ['**'], tools: ['exec.run', 'file.write'] } },
        authority: { mayDecide: [], mustAsk: [], approvalsHeld: [] },
        budget: { tokens: 10000, toolCalls: 10, deadline: new Date(Date.now() + 30000).toISOString(), modelTier: 'standard' },
        returnContract: { format: 'plur1bus.return/1', maxTokens: 2000, outputSchema: { type: 'string' }, citationsRequired: false } },
      context: { person: b.who.userId, taskId, sessionId, fromAgent: 'lead', projectId: b.project.id,
        ...(kind === 'handoff' ? { onAccepted() {
          assert.ok(b.collab.boardStore.getCard(b.project.id, b.card.id).assignees.some(a => a.id === 'lead'));
          b.collab.boardStore.assign(b.project.id, b.card.id, { kind: 'agent', id: 'lead' }, false, { kind: 'person', id: b.who.userId });
        } } : {}),
        approvals: approvals.stores.approvals, grants: approvals.stores.grants, now: Date.now, audit() {} },
    } };
  const port = provisionedWorktreePort(b.store, () => null, join(b.home, 'state'));
  return { ...b, input, scope, port,
    run(provider: ChatProvider) {
      const before = b.store.liveWorktree(b.project.id, input.handoff!.contract.task.card ?? null);
      const accepting: ChatProvider = { id: provider.id, async *stream(req) {
        if (req.messages[0]?.text.startsWith('Acceptance check only.')) {
          assert.deepEqual(req.toolView, []);
          assert.equal(req.codingWorktree, undefined);
          assert.equal(req.worktreeMount, undefined);
          assert.deepEqual(b.store.liveWorktree(b.project.id, input.handoff!.contract.task.card ?? null), before,
            'the acceptance phase must not provision a worktree');
          yield { type: 'delta', text: JSON.stringify({ schema: 'plur1bus.ack/1', inReplyTo: input.handoff!.contract.id,
            objective: input.handoff!.contract.objective, status: 'ok', blockingQuestions: [] }) };
          return;
        }
        yield* provider.stream(req);
      } };
      const runner = composedAgentRunner(accepting, alsAgentScopePort(), b.home, [], undefined, port);
      return runWithAgentScope(scope, () => runner.run(input));
    },
    close() { approvals.service.dispose(); approvals.stores.db.close(); b.close(); } };
}

for (const kind of ['delegate', 'handoff'] as const) {
test(`a trusted assigned ${kind} carries the opaque mount into its ordinary native request`, async () => {
  const b = await delegated(kind);
  try {
    let calls = 0;
    await b.run({ id: 'fixture', async *stream(req) {
      calls++;
      assert.ok(req.worktreeMount);
      assert.equal(nativeWorktreeBinding(req.worktreeMount, 'worker', b.project.id).path, b.tree.path);
      assert.equal(req.codingWorktree, b.tree.path);
      yield { type: 'delta', text: 'Done' };
    } });
    assert.equal(calls, 1);
  } finally { b.close(); }
});

for (const mismatch of ['sender', 'receiver', 'unknown-card', 'archived-card', 'project', 'from', 'to', 'person'] as const) {
  test(`invalid ${kind} ${mismatch} creates no mount, fork or work-provider call`, async () => {
    const b = await delegated(kind);
    try {
      const h = b.input.handoff!.contract;
      if (mismatch === 'sender' || mismatch === 'receiver') b.collab.boardStore.assign(b.project.id, b.card.id,
        { kind: 'agent', id: mismatch === 'sender' ? 'lead' : 'worker' }, false, { kind: 'person', id: b.who.userId });
      else if (mismatch === 'unknown-card') h.task.card = 'unknown-card';
      else if (mismatch === 'archived-card') b.collab.boardStore.archiveCard(b.project.id, b.card.id, true, { kind: 'person', id: b.who.userId });
      else if (mismatch === 'project') h.task.project = 'foreign-project';
      else if (mismatch === 'from') h.from.agent = 'other';
      else if (mismatch === 'to') h.to = { agent: 'other' };
      else b.input.handoff!.context.person = 'foreign-person';
      let calls = 0;
      const before = b.store.liveWorktree(b.project.id, h.task.card ?? null);
      await assert.rejects(b.run({ id: 'fixture', async *stream() { calls++; yield { type: 'delta', text: 'Unexpected' }; } }));
      assert.equal(calls, 0);
      assert.deepEqual(b.store.liveWorktree(b.project.id, h.task.card ?? null), before);
    } finally { b.close(); }
  });
}
}

test('a card handoff without the trusted acceptance callback cannot obtain native authority', async () => {
  const b = await delegated('handoff');
  try {
    delete b.input.handoff!.context.onAccepted;
    await assert.rejects(b.run({ id: 'fixture', async *stream() { assert.fail('unaccepted handoff reached provider'); } }),
      /trusted ownership transfer/);
  } finally { b.close(); }
});

for (const callClass of ['read', 'review'] as const) test(`${callClass} scopes cannot upgrade a selected card to a native writable turn`, async () => {
  const b = await delegated();
  try {
    b.scope.delegation.callClass = callClass;
    const seen: ChatRequest[] = [];
    await b.run({ id: 'fixture', async *stream(req) { seen.push(req); yield { type: 'delta', text: 'Done' }; } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.codingWorktree, undefined);
    assert.equal(seen[0]!.worktreeMount, undefined);
  } finally { b.close(); }
});

test('only an authenticated assigned handoff may auto-provision its missing card through the sole provisioner', async () => {
  const b = await delegated();
  try {
    const card = b.collab.boardStore.createCard(b.project.id, { title: 'New coding card',
      columnId: b.collab.boardStore.columns(b.project.id)[0]!.id }, { kind: 'person', id: b.who.userId });
    b.input.handoff!.contract.task.card = card.id;
    for (const agent of ['lead', 'worker']) b.collab.boardStore.assign(b.project.id, card.id,
      { kind: 'agent', id: agent }, true, { kind: 'person', id: b.who.userId });
    assert.equal(b.store.liveWorktree(b.project.id, card.id), null);
    await b.run({ id: 'fixture', async *stream(req) {
      assert.ok(req.worktreeMount);
      const row = b.store.liveWorktree(b.project.id, card.id);
      assert.ok(row);
      assert.equal(req.codingWorktree, row.path);
      assert.equal(nativeWorktreeBinding(req.worktreeMount, 'worker', b.project.id).cardId, card.id);
      yield { type: 'delta', text: 'Done' };
    } });
  } finally { b.close(); }
});
