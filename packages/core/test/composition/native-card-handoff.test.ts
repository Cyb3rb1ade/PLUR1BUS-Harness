import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCollab } from '../../src/collab/service.ts';
import { alsAgentScopePort } from '../../src/collab/scope.ts';
import { composedAgentRunner } from '../../src/composition/collaboration.ts';
import { composeTools } from '../../src/composition/tools.ts';
import { provisionedWorktreePort } from '../../src/external-agents/provisioner.ts';
import { memoryAuditSink } from '../../src/rbac/audit.ts';
import type { ChatRequest } from '../../src/session/provider.ts';
import { collaborationTools } from '../../src/tools/collaboration.ts';
import { ToolDispatcher } from '../../src/tools/dispatcher.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { nativeWorktreeBinding, type WorktreeMount } from '../../src/tools/sandbox/worktree-mount.ts';
import { rig } from '../approvals/service-helpers.ts';
import { nativeCardFixture } from './native-card-fixture.ts';

test('the shipped handoff transfers ownership before the receiver writes in its native card', async () => {
  const b = nativeCardFixture(), approvals = await rig();
  const signal = new AbortController().signal;
  let mount: WorktreeMount | undefined;
  let workCalls = 0;
  let runnerFailure: unknown;
  const dispatcher = (registry: ToolRegistry) => new ToolDispatcher({ registry,
    approvals: approvals.service, grants: approvals.stores.grants, clock: { now: Date.now } });
  const runner = composedAgentRunner({ id: 'fixture', async *stream(req) {
    const h = JSON.parse(req.peerResults![0]!.text).handoff;
    if (req.messages[0]!.text.startsWith('Acceptance check only.')) {
      assert.ok(b.collab.boardStore.getCard(b.project.id, b.card.id).assignees.some(a => a.id === 'lead'));
      yield { type: 'delta', text: JSON.stringify({ schema: 'plur1bus.ack/1', inReplyTo: h.id,
        objective: h.objective, status: 'ok', blockingQuestions: [] }) };
      return;
    }
    workCalls++;
    const assigned = b.collab.boardStore.getCard(b.project.id, b.card.id).assignees;
    assert.equal(assigned.some(a => a.id === 'lead'), false, 'the production callback removed the sender');
    assert.ok(assigned.some(a => a.id === 'worker'));
    assert.ok(req.worktreeMount);
    mount = req.worktreeMount;
    assert.equal(nativeWorktreeBinding(mount, 'worker', b.project.id).path, b.tree.path);
    const tools = await composeTools({ home: b.home, roots: [], audit: memoryAuditSink(),
      grants: approvals.stores.grants, sandbox: { required: true } }, { ...req, principal: b.who.userId });
    const result = await dispatcher(tools).call({ id: 'receiver-write', name: 'file.write',
      args: { path: join(b.tree.path, 'handoff.txt'), content: 'received ownership\n' } },
    { agentId: 'worker', principal: b.who.userId, sessionId: req.sessionId, surface: 1, signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    yield { type: 'delta', text: 'Done' };
  } }, alsAgentScopePort(), b.home, [], undefined, provisionedWorktreePort(b.store, () => null, join(b.home, 'state')));
  const collab = createCollab({ path: join(b.home, 'state', 'collab.sqlite'), home: b.home,
    runner: { async run(input) {
      try { return await runner.run(input); }
      catch (error) { runnerFailure = error; throw error; }
    } }, toolView: () => ['file.write'] });
  try {
    const request: ChatRequest = { agentId: 'lead', principal: b.who.userId, projectId: b.project.id,
      sessionId: 'handoff-parent', turnId: 'handoff-turn', summaries: [], memory: '', messages: [], signal };
    const registry = new ToolRegistry();
    for (const tool of collaborationTools({ collab, enabled: () => true, principal: () => b.who,
      authority: { approvals: approvals.stores.approvals, grants: approvals.stores.grants, now: Date.now, audit() {} } }, request)) registry.register(tool);
    const result = await dispatcher(registry).call({ id: 'transfer', name: 'handoff', args: {
      projectId: b.project.id, cardId: b.card.id, toAgent: 'worker', objective: 'Continue coding',
      scope: { paths: ['**'], tools: ['file.write'] }, outputSchema: { type: 'string' },
    } }, { agentId: 'lead', principal: b.who.userId, sessionId: request.sessionId, turnId: request.turnId!, surface: 1, signal });
    assert.equal(b.collab.boardStore.getCard(b.project.id, b.card.id).assignees.some(a => a.id === 'lead'), false,
      'the actual ownership-transfer callback ran');
    assert.equal(result.isError, false, `${JSON.stringify(result)}; ${runnerFailure instanceof Error ? runnerFailure.stack : runnerFailure}`);
    assert.equal(workCalls, 1);
    assert.equal(readFileSync(join(b.tree.path, 'handoff.txt'), 'utf8'), 'received ownership\n');
    assert.ok(mount);
    b.collab.boardStore.assign(b.project.id, b.card.id, { kind: 'agent', id: 'worker' }, false, { kind: 'person', id: b.who.userId });
    assert.throws(() => nativeWorktreeBinding(mount!, 'worker', b.project.id), /revoked/);
  } finally { await collab.shutdown(); approvals.service.dispose(); approvals.stores.close(); b.close(); }
});
