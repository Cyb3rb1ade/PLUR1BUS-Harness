import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type {
  CallerIdentity, Degraded, ErrorCode, MemoryCard, MemoryCorrectParams, MemoryForgetParams, MemoryListParams, MemoryProposal, MemoryProposalsAcceptParams,
  MemoryProposalsListParams, MemoryProposalsRejectParams, MemoryProposeParams, MemoryShareParams, MemoryShowParams, MemoryStateParams,
} from "@plur1bus/rpc-schema";
import type { AgentRegistry } from "./agents.ts";
import type { HarnessLogger } from "./logger.ts";
import { AGENT_CONTEXT_CLI, callerToPrincipal } from "./principal.ts";
import { RpcError } from "./rpc/errors.ts";
import type { Handler } from "./rpc/server.ts";

export const MEMORY_OP_METHODS = ["memory.list", "memory.show", "memory.forget", "memory.correct", "memory.share", "memory.state",
  "memory.propose", "memory.proposals.list", "memory.proposals.accept", "memory.proposals.reject"] as const;
export type MemoryOpMethod = (typeof MEMORY_OP_METHODS)[number];

export interface MemoryOpDeps { engine: E.Engine; agents: AgentRegistry; logger: HarnessLogger; isStopping: () => boolean }

/** The H1 agent check every agent-scoped method shares: the workspace of a registered agent, else E_AGENT_UNKNOWN. */
export function requireAgent(agents: AgentRegistry, agentId: string): string {
  const ws = agents.workspaceOf(agentId);
  if (!ws) throw new RpcError("E_AGENT_UNKNOWN", `agent not registered: ${agentId}`, { reason: "not-registered" });
  return ws;
}

// G7: the engine's MemoryOpErrorCode → the closed RPC code; `reason` carries the engine code verbatim.
const ERROR_MAP: Readonly<Record<E.MemoryOpErrorCode, ErrorCode>> = Object.freeze({
  "not-found": "E_NOT_FOUND", denied: "E_DENIED", "invalid-input": "E_INVALID_PARAMS", "approval-required": "E_APPROVAL_REQUIRED", conflict: "E_CONFLICT", storage: "E_STORAGE",
});

const coreStopping = () => new RpcError("E_CORE_UNAVAILABLE", "core is stopping", { reason: "core-stopping" });

/** A MemoryOpError (recognised by name and a known code, never by importing an engine internal) as an RpcError; null for anything else. */
export function mapMemoryOpError(e: unknown, o: { stopping: boolean }): RpcError | null {
  if (!(e instanceof Error) || e.name !== "MemoryOpError") return null;
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string" || !Object.hasOwn(ERROR_MAP, code)) return null;
  // The engine closes on shutdown and then answers `storage` ("engine is closed"): that is the core going away, not a storage fault.
  if (code === "storage" && o.stopping) return coreStopping();
  const detail = (e as { detail?: unknown }).detail;
  const ids: Record<string, string> = {};
  if (detail && typeof detail === "object") for (const [k, v] of Object.entries(detail)) if (typeof v === "string") ids[k] = v;
  return new RpcError(ERROR_MAP[code as E.MemoryOpErrorCode], e.message, { reason: code, ...(Object.keys(ids).length > 0 ? { ids } : {}) });
}

// The wire shapes are closed (rpc.schema.json): every engine object is projected onto exactly the schema's keys.
export function projectCard(c: E.MemoryCard): MemoryCard {
  return {
    id: c.id, scope: c.scope, text: c.text, summary: c.summary, createdAt: c.createdAt, origin: c.origin, epistemicStatus: c.epistemicStatus,
    ...(typeof c.score === "number" ? { score: c.score } : {}),
    ...(typeof c.sharedBy === "string" ? { sharedBy: c.sharedBy } : {}),
    ...(typeof c.sourceId === "string" ? { sourceId: c.sourceId } : {}),
  };
}

export function projectProposal(p: E.MemoryProposal): MemoryProposal {
  return {
    id: p.id, sharedId: p.sharedId, sourceId: p.sourceId, target: p.target, sharerAgentId: p.sharerAgentId, proposerAgentId: p.proposerAgentId,
    oldText: p.oldText, newText: p.newText, note: p.note, createdAt: p.createdAt, status: p.status, resolvedAt: p.resolvedAt, resultId: p.resultId,
    resolutionNote: p.resolutionNote,
  };
}

const withDegraded = <T extends object>(r: T, degraded: Degraded | null): T & { degraded?: Degraded } => (degraded ? { ...r, degraded } : r);

export function buildMemoryOpMethods(d: MemoryOpDeps): Record<MemoryOpMethod, Handler> {
  const m = d.engine.memory;
  type Call = { principal: E.Principal; degraded: Degraded | null };

  /** Steps (1)-(3) and (5)-(7) of every memory op; `fn` is the engine call plus the projection. */
  function op<P extends { caller: CallerIdentity; agentId: string }, R>(method: MemoryOpMethod, write: boolean, fn: (p: P, c: Call) => Promise<R>, pre?: (p: P) => void): Handler {
    return async (p: P) => {
      if (d.isStopping()) throw coreStopping();
      const workspace = requireAgent(d.agents, p.agentId);
      const { principal, degraded } = callerToPrincipal(p.caller, p.agentId, workspace);
      // G8: a write never reaches the engine with an inferred principal; a read proceeds and says so.
      if (degraded && write) throw new RpcError("E_DENIED", `caller identity is not valid (${degraded.detail ?? "identity"})`, { reason: "principal-invalid" });
      pre?.(p);
      try {
        return await fn(p, { principal, degraded });
      } catch (e) {
        const mapped = mapMemoryOpError(e, { stopping: d.isStopping() });
        if (!mapped) throw e; // the server answers E_INTERNAL handler-threw
        d.logger.debug("memory op refused", { method, agentId: p.agentId, error: mapped.error, reason: mapped.reason });
        throw mapped;
      }
    };
  }

  return {
    "memory.list": op<MemoryListParams, unknown>("memory.list", false, async (p, c) => {
      const q: E.MemoryListQuery = {
        ...(p.topic !== undefined ? { topic: p.topic } : {}), ...(p.since !== undefined ? { since: p.since } : {}),
        ...(p.until !== undefined ? { until: p.until } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}),
      };
      const r = await m.list(q, c.principal, AGENT_CONTEXT_CLI);
      return withDegraded({ agentId: r.agentId, items: r.items.map(projectCard), truncated: r.truncated }, c.degraded);
    }, (p) => {
      // G9: the flat params cannot express "exactly one of topic/since" (nor the engine's "until only with since").
      if ((p.topic !== undefined) === (p.since !== undefined)) throw new RpcError("E_INVALID_PARAMS", "exactly one of topic and since is required", { reason: "topic-xor-since" });
      if (p.until !== undefined && p.since === undefined) throw new RpcError("E_INVALID_PARAMS", "until is only allowed with since", { reason: "topic-xor-since" });
    }),

    "memory.show": op<MemoryShowParams, unknown>("memory.show", false, async (p, c) =>
      withDegraded({ card: projectCard(await m.show(p.id, c.principal, AGENT_CONTEXT_CLI)) }, c.degraded)),

    "memory.forget": op<MemoryForgetParams, unknown>("memory.forget", true, async (p, c) => {
      const r = await m.forget(p.id, c.principal, AGENT_CONTEXT_CLI);
      return { id: r.id, archived: r.archived, tombstoneId: r.tombstoneId, alreadyForgotten: r.alreadyForgotten };
    }),

    "memory.correct": op<MemoryCorrectParams, unknown>("memory.correct", true, async (p, c) => {
      const r = await m.correct(p.id, p.text, c.principal, AGENT_CONTEXT_CLI);
      return { id: r.id, archived: r.archived };
    }),

    "memory.share": op<MemoryShareParams, unknown>("memory.share", true, async (p, c) => {
      // allowSensitive only as the caller's explicit `true`; anything else leaves the engine's approval gate in place.
      const r = p.allowSensitive === true
        ? await m.share(p.id, p.target, c.principal, AGENT_CONTEXT_CLI, { allowSensitive: true })
        : await m.share(p.id, p.target, c.principal, AGENT_CONTEXT_CLI);
      return { sourceId: r.sourceId, sharedId: r.sharedId, target: r.target };
    }),

    "memory.state": op<MemoryStateParams, unknown>("memory.state", false, async (_p, c) => {
      const r = await m.state(c.principal, AGENT_CONTEXT_CLI);
      return withDegraded({
        agentId: r.agentId, cards: { agentPrivate: r.cards.agentPrivate, workspace: r.cards.workspace, user: r.cards.user }, tombstones: r.tombstones, archiveDir: r.archiveDir,
      }, c.degraded);
    }),

    "memory.propose": op<MemoryProposeParams, unknown>("memory.propose", true, async (p, c) => {
      const r = p.note !== undefined
        ? await m.propose(p.sharedId, p.text, c.principal, AGENT_CONTEXT_CLI, { note: p.note })
        : await m.propose(p.sharedId, p.text, c.principal, AGENT_CONTEXT_CLI);
      return { proposalId: r.proposalId, sharedId: r.sharedId, sharerAgentId: r.sharerAgentId };
    }),

    "memory.proposals.list": op<MemoryProposalsListParams, unknown>("memory.proposals.list", false, async (p, c) => {
      const q: E.MemoryProposalListQuery = { ...(p.status !== undefined ? { status: p.status } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}) };
      const r = await m.proposals.list(q, c.principal, AGENT_CONTEXT_CLI);
      return withDegraded({ agentId: r.agentId, items: r.items.map(projectProposal), truncated: r.truncated, unreadable: r.unreadable }, c.degraded);
    }),

    "memory.proposals.accept": op<MemoryProposalsAcceptParams, unknown>("memory.proposals.accept", true, async (p, c) => {
      const r = await m.proposals.accept(p.proposalId, c.principal, AGENT_CONTEXT_CLI);
      return { proposalId: r.proposalId, id: r.id, sourceId: r.sourceId };
    }),

    "memory.proposals.reject": op<MemoryProposalsRejectParams, unknown>("memory.proposals.reject", true, async (p, c) => {
      const r = p.note !== undefined
        ? await m.proposals.reject(p.proposalId, c.principal, AGENT_CONTEXT_CLI, { note: p.note })
        : await m.proposals.reject(p.proposalId, c.principal, AGENT_CONTEXT_CLI);
      return { proposalId: r.proposalId, status: r.status };
    }),
  };
}
