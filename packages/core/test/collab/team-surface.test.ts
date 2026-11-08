import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFixtures, validateResult } from '@plur1bus/rpc-schema';
import { open, owner, member, viewer, projectWithAgents } from './helpers.ts';
import { buildTeamSurface, TEAM_METHODS } from '../../src/rpc/team-surface.ts';
import { guardMethods } from '../../src/rbac/guard.ts';
import type { Principal } from '../../src/rbac/types.ts';
import { RpcError } from '../../src/rpc/errors.ts';
const ctx = { requestId: 'test', connectionId: 'test', signal: new AbortController().signal };
const denied = (e: unknown) => e instanceof RpcError && e.error === 'E_DENIED';
const fixtures = loadFixtures().methods;

test('TK1 every team RPC denies viewer and agent, including owner-ranked agents', async () => {
  const h = open();
  try {
    for (const principal of [viewer(), owner({ kind: 'agent' })]) {
      const surface = guardMethods(buildTeamSurface(() => h.collab), { resolve: () => principal, now: () => 0 });
      for (const method of TEAM_METHODS) await assert.rejects(surface[method]!(fixtures[method]!.params, ctx), denied, method);
    }
    assert.equal(h.seen.length, 0);
  } finally { h.collab.close(); }
});

test('TK1 persisted project visibility and lead rights override forged caller claims; commands remain pending', async () => {
  const h = open();
  try {
    const project = await projectWithAgents(h);
    let principal: Principal = owner();
    const surface = guardMethods(buildTeamSurface(() => h.collab), { resolve: () => principal, now: () => 0 });
    const result = await surface['team.create']!({ projectId: project.id, objective: 'fixture', leadAgent: 'lead' }, ctx) as { run: { id: string; state: string } };
    assert.equal(validateResult('team.create', result).ok, true);
    const runId = result.run.id;
    principal = member({ projectRights: { [project.id]: 'lead' } });
    await assert.rejects(surface['team.get']!({ runId }, ctx), denied);
    for (const role of ['worker', 'reviewer', 'member'] as const) {
      h.collab.addMember(owner(), project.id, principal.userId, role);
      assert.equal(validateResult('team.get', await surface['team.get']!({ runId }, ctx)).ok, true);
      await assert.rejects(surface['team.pause']!({ runId }, ctx), denied);
    }
    h.collab.addMember(owner(), project.id, principal.userId, 'lead');
    for (const method of ['team.pause', 'team.resume', 'team.cancel']) {
      const response = await surface[method]!({ runId }, ctx);
      assert.equal(validateResult(method, response).ok, true);
    }
    assert.equal(h.collab.worktreeStore.team.get(runId).state, 'proposing');
    assert.deepEqual(h.collab.worktreeStore.team.pendingActions(runId), []);
    assert.equal(h.collab.worktreeStore.team.events(runId).length, 4);
    assert.equal(h.seen.length, 0);
  } finally { h.collab.close(); }
});
