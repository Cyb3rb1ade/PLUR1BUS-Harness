import { realpathSync } from 'node:fs';
import type { ChatRequest } from '../session/provider.ts';
import type { ToolDef } from '../tools/registry.ts';
import type { Principal } from '../rbac/types.ts';
import { authorize } from '../rbac/authorize.ts';
import { authenticatedPrincipal } from '../rbac/guard.ts';
import type { Handler } from '../rpc/server.ts';
import { RpcError } from '../rpc/errors.ts';
import { surfaceError } from '../rpc/surface-errors.ts';
import type { Collab } from './service.ts';
import type { CodingGate } from './coding-gate.ts';
import type { ReturnEnvelope } from './handoff.ts';

/** Shared existing-worktree port. M6 adapters supply their bound checkout here; no second worktree creator exists. */
export interface ProjectWorktreePort { root(agentId: string, projectId: string, cardId: string): string | null }
export interface CodingCompletion { collab: Collab; gate: CodingGate; worktrees: ProjectWorktreePort }
const taskKey = (projectId: string, cardId: string) => `${projectId}/${cardId}`;
function admitted(o: CodingCompletion, person: Principal, projectId: string, cardId: string) {
  if (person.kind !== 'person') throw new RpcError('E_DENIED', 'a person is required');
  const project = o.collab.getProject(person, projectId);
  const membership = project.members.find(m => m.userId === person.userId);
  const p = { ...person, projectRights: membership ? { [projectId]: membership.role } : {} };
  if (authorize(p, 'project.write', { kind: 'project', projectId }).effect !== 'allow') throw new RpcError('E_DENIED', 'project write required');
  const card = o.collab.boardStore.getCard(projectId, cardId);
  return { project, card, membership };
}
async function complete(o: CodingCompletion, p: { projectId: string; cardId: string; overrideNote?: string }, who: Principal, signal: AbortSignal, agentId?: string) {
  const { project, card, membership } = admitted(o, who, p.projectId, p.cardId);
  const assigned = agentId ?? card.assignees.find(a => a.kind === 'agent')?.id;
  if (!assigned || !project.agents.includes(assigned) || !card.assignees.some(a => a.kind === 'agent' && a.id === assigned)) throw new RpcError('E_DENIED', 'assigned project agent required');
  const root = o.worktrees.root(assigned, project.id, card.id);
  if (!root) throw new RpcError('E_CONFLICT', 'bound coding worktree unavailable');
  if (p.overrideNote !== undefined && (agentId || (who.role !== 'owner' && who.role !== 'admin' && membership?.role !== 'lead'))) throw new RpcError('E_DENIED', 'a project lead must explicitly override');
  const result = await o.gate.verify({ task: taskKey(project.id, card.id), root, signal, ...(p.overrideNote !== undefined ? { override: { note: p.overrideNote, person: who.userId } } : {}) });
  if (!result.ok) throw new RpcError('E_CONFLICT', 'coding verification refused completion', { reason: result.reason ?? 'verification-failed', detail: JSON.stringify(result) });
  // Membership and content are rechecked after async verifier execution.
  const current = admitted(o, who, project.id, card.id);
  const bound = o.worktrees.root(assigned, project.id, card.id);
  if (!current.project.agents.includes(assigned) || !current.card.assignees.some(a => a.kind === 'agent' && a.id === assigned) || !bound || realpathSync(bound) !== realpathSync(root)) throw new RpcError('E_DENIED', 'task assignment changed during verification');
  if (o.gate.snapshot(root).treeHash !== result.treeHash) throw new RpcError('E_CONFLICT', 'worktree changed after verification');
  const done = o.collab.boardStore.columns(project.id).find(c => c.titleKey === 'project.board.done');
  if (!done) throw new RpcError('E_CONFLICT', 'done column unavailable');
  return { card: o.collab.boardStore.moveCard(project.id, card.id, done.id, undefined, { kind: agentId ? 'agent' : 'person', id: agentId ?? who.userId }), verification: result };
}
export function codingCompletionTool(o: CodingCompletion, req: ChatRequest, person: () => Principal | null): ToolDef {
  return { name: 'coding_complete', description: 'Complete the assigned coding card only after independent format/lint/typecheck/test verification and required review. The delegate report is not evidence.', capability: 'shell.exec', effect: 'local-write', risk: 'medium', trust: 'first-party', limits: { timeoutMs: 300000 }, classify: () => ({ flags: { outsideRoots: false, denyListHit: false } }), inputSchema: { type: 'object', additionalProperties: false, properties: { projectId: { type: 'string', minLength: 1 }, cardId: { type: 'string', minLength: 1 } }, required: ['projectId', 'cardId'] }, async execute(value, ctx) {
    const who = person(); if (!who || who.userId !== ctx.principal || (req.projectId && req.projectId !== (value as { projectId: string }).projectId)) throw new RpcError('E_DENIED', 'authenticated project principal required');
    return complete(o, value as { projectId: string; cardId: string }, who, ctx.signal, ctx.agentId);
  } };
}
export function codingMethods(o: CodingCompletion): Record<string, Handler> {
  return { 'task.complete': async (p, ctx) => { try { return await complete(o, p, authenticatedPrincipal(ctx), ctx.signal); } catch (e) { return surfaceError(e); } } };
}
export function reviewHooks(o: CodingCompletion) {
  return {
    start(projectId: string, cardId: string, from: string) {
      const project = o.collab.boardProject(projectId), card = o.collab.boardStore.getCard(projectId, cardId);
      if (!project?.agents.includes(from) || !card.assignees.some(a => a.kind === 'agent' && a.id === from)) throw new RpcError('E_DENIED', 'assigned review caller required');
      const root = o.worktrees.root(from, projectId, cardId); if (!root) throw new RpcError('E_CONFLICT', 'review worktree unavailable');
      return { projectId, task: taskKey(projectId, cardId), snapshot: o.gate.snapshot(root), from };
    },
    root(ticket: unknown) { return (ticket as { snapshot: ReturnType<CodingGate['snapshot']> }).snapshot.root; },
    finish(ticket: unknown, to: string, result: ReturnEnvelope) {
      const r = ticket as { projectId: string; task: string; snapshot: ReturnType<CodingGate['snapshot']>; from: string };
      if (result.status !== 'done' || !result.output || typeof result.output !== 'object' || (result.output as { verdict?: string }).verdict !== 'pass') return;
      if (!o.collab.boardProject(r.projectId)?.agents.includes(to)) throw new RpcError('E_DENIED', 'reviewer project assignment required');
      o.gate.recordReview(r.task, r.snapshot, to, r.from);
    },
  };
}
