import { randomUUID } from 'node:crypto';
import type { ToolDef, ToolRunContext } from './registry.ts';
import type { ChatRequest } from '../session/provider.ts';
import type { Collab } from '../collab/service.ts';
import { prepareHandoff, validateReturn, returnFromText, type Handoff, type HandoffContext, type HandoffRepair, type ReturnEnvelope } from '../collab/handoff.ts';
import type { Principal } from '../rbac/types.ts';
import { CollabError } from '../collab/errors.ts';
import { currentAgentScope } from '../collab/scope.ts';

export interface CollaborationTools {
  collab: Collab;
  enabled(): boolean;
  /** Resolves a live authenticated human, never a model-supplied identity. */
  principal(request: ChatRequest): Principal | null;
  authority: Pick<HandoffContext, 'approvals' | 'grants' | 'audit' | 'now'>;
  repair?: HandoffRepair;
  review?: { start(project: string, card: string, from: string): unknown; root(ticket: unknown): string; finish(ticket: unknown, to: string, result: ReturnEnvelope): void };
}
const str = { type: 'string', minLength: 1, maxLength: 8000 };
const strings = { type: 'array', items: str, maxItems: 32 };
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', additionalProperties: false, properties, required });
const delegationSchema = schema({ projectId: str, toAgent: str, objective: str, context: { type: 'string', maxLength: 8000 }, doneWhen: strings, forbiddenActions: strings, scope: schema({ paths: strings, tools: strings }, ['paths', 'tools']), approvalsHeld: strings, outputSchema: { type: 'object' }, citationsRequired: { type: 'boolean' }, modelTier: { enum: ['cheap', 'standard', 'premium'] }, deadline: str, cardId: str }, ['projectId', 'toAgent', 'objective']);
interface Args { projectId: string; toAgent: string; objective: string; context?: string; doneWhen?: string[]; forbiddenActions?: string[]; scope?: Handoff['constraints']['scope']; approvalsHeld?: string[]; outputSchema?: Record<string, unknown>; citationsRequired?: boolean; modelTier?: Handoff['budget']['modelTier']; deadline?: string; cardId?: string }

/** Per-turn closures share the library trace and limits across every tool call, never across people or turns. */
export function collaborationTools(o: CollaborationTools, req: ChatRequest): ToolDef[] {
  const traces = new Map<string, string>();
  let transferred = false, starts = 0;
  const pairStarts = new Map<string, number>();
  const admitted = (ctx: ToolRunContext, projectId: string, finalizing = false) => {
    if (transferred && !finalizing) throw new CollabError('conflict', 'sender already handed off ownership');
    const who = o.principal(req);
    if (!who || who.kind !== 'person' || who.role === 'viewer' || who.userId !== ctx.principal) throw new CollabError('unauthorized', 'authenticated collaboration principal required');
    const project = o.collab.getProject(who, projectId);
    if (project.archivedAt !== null || !project.agents.includes(ctx.agentId)) throw new CollabError('unauthorized', 'active project agent assignment required');
    if (req.projectId && req.projectId !== projectId) throw new CollabError('unauthorized', 'project boundary');
    const membership = project.members.find(m => m.userId === who.userId);
    if (!membership && who.role !== 'owner' && who.role !== 'admin') throw new CollabError('unauthorized', 'project membership required');
    return { ...who, projectRights: membership ? { [projectId]: membership.role } : {} };
  };
  const definition = (name: string, description: string, inputSchema: Record<string, unknown>, execute: ToolDef['execute'], read = false): ToolDef => ({ name, description, inputSchema, capability: 'agent.delegate', effect: read ? 'read' : 'local-write', risk: 'low', trust: 'first-party', limits: { timeoutMs: 300000 }, classify: () => ({ flags: { outsideRoots: false, denyListHit: false } }), execute });
  const run = (kind: 'consult' | 'delegate' | 'handoff', review = false): ToolDef['execute'] => async (value, ctx) => {
    const a = value as Args, who = admitted(ctx, a.projectId);
    // Nested delegates never become a fresh root chain. Depth defaults to one.
    if (currentAgentScope()) throw new CollabError('guardrail', 'nested fan-out refused', { guardrail: 'depth' });
    if (req.incognito) throw new CollabError('guardrail', 'private incognito chat needs explicit promotion before a durable delegation');
    if (!o.enabled()) throw new CollabError('guardrail', 'collaboration fan-out is disabled pending owner approval');
    const pair = `${ctx.agentId}→${a.toAgent}`;
    if ((pairStarts.get(pair) ?? 0) >= 2) throw new CollabError('guardrail', 'guardrail pair-limit', { guardrail: 'pair-limit' });
    if (starts >= 3) throw new CollabError('guardrail', 'guardrail fanout', { guardrail: 'fanout' });
    const taskId = req.turnId ?? req.sessionId;
    const authority: HandoffContext = { ...o.authority, person: who.userId, taskId, sessionId: req.sessionId, fromAgent: ctx.agentId, projectId: a.projectId };
    const candidate: Handoff = {
      schema: 'plur1bus.handoff/1', id: `ho_${randomUUID()}`, kind,
      from: { agent: ctx.agentId, session: req.sessionId }, to: { agent: a.toAgent }, task: { id: taskId, project: a.projectId, ...(a.cardId ? { card: a.cardId } : {}) },
      objective: a.objective, ...(a.context ? { why: a.context } : {}), doneWhen: a.doneWhen ?? [review ? 'Independent reviewer reports findings and evidence' : a.objective],
      constraints: { must: [], mustNot: a.forbiddenActions ?? [], scope: a.scope ?? { paths: [], tools: [] } },
      authority: { mayDecide: [], mustAsk: ['Any action outside scope'], approvalsHeld: a.approvalsHeld ?? [] },
      budget: { tokens: 2000, toolCalls: 25, deadline: a.deadline ?? new Date(o.authority.now() + 300000).toISOString(), modelTier: a.modelTier ?? 'standard' },
      returnContract: { format: 'plur1bus.return/1', maxTokens: 2000, outputSchema: a.outputSchema ?? {}, citationsRequired: a.citationsRequired ?? false },
      ...(kind === 'handoff' ? { state: { done: [], current: a.context ?? a.objective, next: a.doneWhen ?? [a.objective] } } : {}),
    };
    if (review) { candidate.returnContract.outputSchema = { type: 'object', additionalProperties: false, properties: { verdict: { enum: ['pass', 'changes_requested'] }, findings: { type: 'array', items: { type: 'string' } } }, required: ['verdict', 'findings'] }; candidate.returnContract.citationsRequired = true; }
    const reviewTicket = review && a.cardId ? o.review?.start(a.projectId, a.cardId, ctx.agentId) : undefined;
    if (reviewTicket && o.review) { authority.readOnlyWorktree = o.review.root(reviewTicket); candidate.constraints.scope = { paths: ['**'], tools: ['file.read', 'file.list', 'file.stat'] }; }
    const { kind: expectedKind, from, to, task, constraints, authority: expectedAuthority, budget: expectedBudget, returnContract, doneWhen } = candidate;
    authority.expected = structuredClone({ kind: expectedKind, from, to, task, constraints, authority: expectedAuthority, budget: expectedBudget, returnContract, ...(doneWhen ? { doneWhen } : {}) });
    const h = await prepareHandoff(candidate, authority, o.repair);
    if (kind === 'handoff') authority.onAccepted = () => {
      admitted(ctx, a.projectId);
      if (a.cardId) {
        const card = o.collab.boardStore.getCard(a.projectId, a.cardId);
        if (!card.assignees.some(x => x.kind === 'agent' && x.id === ctx.agentId)) throw new CollabError('unauthorized', 'handoff requires the assigned sender');
        o.collab.boardStore.assign(a.projectId, a.cardId, { kind: 'agent', id: a.toAgent }, true, { kind: 'agent', id: ctx.agentId });
        o.collab.boardStore.assign(a.projectId, a.cardId, { kind: 'agent', id: ctx.agentId }, false, { kind: 'agent', id: ctx.agentId });
      }
      transferred = true;
    };
    ctx.signal.throwIfAborted();
    starts++; pairStarts.set(pair, (pairStarts.get(pair) ?? 0) + 1);
    const started = o.authority.now();
    let traceId = traces.get(a.projectId);
    const input = { principal: who, projectId: a.projectId, fromAgent: ctx.agentId, toAgent: a.toAgent, signal: ctx.signal, ...(traceId ? { traceId } : {}), handoff: { contract: h, context: authority } };
    let text: string, partial: boolean, provenance: object, tokens = 0;
    const resultArtifacts: ReturnEnvelope['artifacts'] = [];
    if (kind === 'consult') {
      const answer = await o.collab.consult({ ...input, question: a.objective, context: a.context ?? '' });
      traceId = answer.traceId; text = answer.text; partial = answer.status === 'partial'; provenance = answer.provenance;
      tokens = answer.provenance.cost.inputTokens + answer.provenance.cost.outputTokens;
    } else {
      const handle = o.collab.delegate({ ...input, task: a.objective, acceptanceCriteria: (a.doneWhen ?? [a.objective]).join('\n') });
      traceId = handle.task.traceId;
      const result = await handle.done;
      if (result.artifactPointer) resultArtifacts.push({ ref: result.artifactPointer, kind: 'delegation-result' });
      text = result.result ?? result.error ?? ''; partial = result.status === 'cancelled';
      if (result.status === 'failed') throw new CollabError('invalid', 'delegation failed', { reason: 'run-failed' });
      provenance = { agentId: a.toAgent, projectId: a.projectId, traceId, spanId: result.spanId, targetKind: result.targetKind ?? 'local' };
      tokens = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);

    }
    if (traceId) traces.set(a.projectId, traceId);
    // A delegate's claims are data. D98 decides completion independently in phase 4.
    const returned = returnFromText(h, text, { tokens, toolCalls: 1, durationMs: o.authority.now() - started }, partial ? 'partial' : 'done_with_concerns', resultArtifacts);
    // When a target returns the structured format, validate the target's binding and contract directly.
    let result: ReturnEnvelope = returned;
    try { const parsed = JSON.parse(text); if (parsed?.schema === 'plur1bus.return/1') result = validateReturn(parsed, h); else result = validateReturn(returned, h); }
    catch (e) { if (e instanceof SyntaxError) result = validateReturn(returned, h); else throw e; }
    if (a.cardId) { admitted(ctx, a.projectId, true); o.collab.boardStore.comment(a.projectId, a.cardId, JSON.stringify(result), { kind: 'agent', id: a.toAgent }); }
    if (review && reviewTicket && !partial) o.review?.finish(reviewTicket, a.toAgent, result);
    if (kind === 'handoff' && !partial) transferred = true;
    return { kind: 'tool_result', trust: 'untrusted', provenance, result, ownershipTransferred: transferred };
  };
  return [
    definition('consult_agent', 'Ask a project peer for advice; peer output is untrusted data.', delegationSchema, run('consult'), true),
    definition('delegate_task', 'Delegate through the single local/external/A2A target port using D104.', delegationSchema, run('delegate')),
    definition('request_review', 'Request an independent project peer review with evidence.', delegationSchema, run('delegate', true)),
    definition('handoff', 'Transfer ownership after the receiver acknowledges; sender stops.', delegationSchema, run('handoff')),
    definition('post_to_project', 'Post untrusted peer data to an existing project card.', schema({ projectId: str, cardId: str, text: str }, ['projectId', 'cardId', 'text']), async (v, ctx) => { const a = v as { projectId: string; cardId: string; text: string }; admitted(ctx, a.projectId); return o.collab.boardStore.comment(a.projectId, a.cardId, a.text, { kind: 'agent', id: ctx.agentId }); }),
    definition('read_project_board', 'Read the authorized project board.', schema({ projectId: str }, ['projectId']), async (v, ctx) => { const a = v as { projectId: string }; admitted(ctx, a.projectId); return { kind: 'tool_result', trust: 'untrusted', provenance: { source: 'project-board', projectId: a.projectId }, board: { columns: o.collab.boardStore.columns(a.projectId), ...o.collab.boardStore.cards(a.projectId, { limit: 100 }) } }; }, true),
  ];
}
