/** Human team controls. All execution requests remain pending events until PT-4b. */
import { validateParams, type TeamCreateParams, type TeamCompositionConfirmParams, type TeamPlanApproveParams } from '@plur1bus/rpc-schema';
import type { Handler } from './server.ts';
import { RpcError } from './errors.ts';
import { authenticatedPrincipal } from '../rbac/guard.ts';
import { authorize } from '../rbac/authorize.ts';
import type { Collab } from '../collab/service.ts';
import { surfaceError } from './surface-errors.ts';

export const TEAM_METHODS = [
  'team.get', 'team.list', 'team.create', 'team.composition.confirm', 'team.plan.approve', 'team.scope.extend',
  'team.pause', 'team.resume', 'team.cancel', 'team.package.reassign', 'team.package.budget.set', 'team.budget.set', 'team.package.sync.set',
] as const;

export function buildTeamSurface(service: () => Collab | null): Record<string, Handler> {
  return Object.fromEntries(TEAM_METHODS.map(method => [method, (async (params, ctx) => {
    const person = authenticatedPrincipal(ctx);
    if (person.kind !== 'person' || person.role === 'viewer') throw new RpcError('E_DENIED', 'human team access required');
    const s = service(); if (!s) throw new RpcError('E_NOT_AVAILABLE', 'collaboration unavailable');
    if (!validateParams(method, params).ok) throw new RpcError('E_INVALID_PARAMS', 'invalid team parameters');
    const p = params as Record<string, unknown>, teams = s.worktreeStore.team;
    try {
      const projectId = method === 'team.list' || method === 'team.create' ? String(p.projectId) : teams.get(String(p.runId)).projectId;
      const project = s.getProject(person, projectId);
      const membership = project.members.find(m => m.userId === person.userId);
      const privileged = person.role === 'owner' || person.role === 'admin';
      if (!privileged && !membership && person.role !== 'operator') throw new RpcError('E_DENIED', 'project visibility required');
      const read = method === 'team.get' || method === 'team.list';
      const principal = { ...person, projectRights: membership ? { [projectId]: membership.role } : {} };
      if (authorize(principal, read ? 'project.read' : 'project.write', { kind: 'project', projectId }).effect !== 'allow') throw new RpcError('E_DENIED', 'project rights required');
      if (!read && method !== 'team.create' && !privileged && membership?.role !== 'lead') throw new RpcError('E_DENIED', 'project lead required');
      if (!read && project.archivedAt !== null) throw new RpcError('E_CONFLICT', 'project archived');
      if (method === 'team.list') return teams.list(projectId, p.limit as number | undefined, p.offset as number | undefined);
      let run;
      if (method === 'team.get') run = teams.get(String(p.runId));
      else if (method === 'team.create') {
        const input = params as TeamCreateParams;
        if (input.cardId && !s.boardStore.getCard(projectId, input.cardId)) throw new RpcError('E_NOT_FOUND', 'project card not found');
        run = teams.create(input, person.userId);
      } else if (method === 'team.composition.confirm') {
        const input = params as TeamCompositionConfirmParams;
        if (input.members.some(m => m.kind === 'a2a') && person.role !== 'owner') throw new RpcError('E_DENIED', 'A2A composition requires owner');
        run = teams.confirm(input.runId, input.compositionHash, input.members, person.userId);
      } else if (method === 'team.plan.approve' || method === 'team.scope.extend') run = teams.approve(params as TeamPlanApproveParams, person.userId, method === 'team.scope.extend');
      else run = teams.request(String(p.runId), `${method}.requested`, p, person.userId);
      return { run };
    } catch (error) { return surfaceError(error); }
  }) satisfies Handler]));
}
