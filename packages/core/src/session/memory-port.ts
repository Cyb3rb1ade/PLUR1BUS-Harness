import { channelBehaviour, channelOrigin, permitsEngineMemory } from '../channels/behaviour-context.ts';
import { requireAgentScope } from "../agents/scope.ts";
import { deriveUserPrincipal } from '../identity/principals.ts';
// The turn loop's one door to the engine (acceptance 4: no second memory loop). The loop calls `recall` once before a
// turn and `capture` once after it; the engine-backed port below makes exactly the engine calls `memory.recall` and
// `memory.capture` make (rpc/methods.ts), with the same identity, budgets and signals.
import type { Degraded, Engine } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { HarnessConfig } from "@plur1bus/config-schema";
import type { CallerIdentity } from "@plur1bus/rpc-schema";
import type { AgentRegistry } from "../agents.ts";
import { joinBlocks } from "../join.ts";
import type { HarnessLogger } from "../logger.ts";
import { requireAgent } from "../memory-ops.ts";
import { AGENT_CONTEXT_CLI, callerToPrincipal } from "../principal.ts";

/** Why the port did not hand a capture to the engine: a fixed code, never a text taken from a policy or a message. */
export type CaptureSkipReason = "channel-policy" | "scope-not-permitted" | "core-stopping";
/** What a capture did. A port that returns nothing makes no statement (the turn loop ignores the result). */
export type CaptureOutcome = { submitted: true } | { submitted: false; reason: CaptureSkipReason };
/** The scopes a recall may read (`workspace`, the person's `user` scope, `agentPrivate`). */
export interface RecallScopes { readonly workspace: boolean; readonly user: boolean; readonly agentPrivate: boolean }
/** Where a capture came from, beyond the session key and the run id the engine stores with a card. The engine has no
 *  provenance field a host can set; this goes into the harness log line of the capture (`session capture done`). */
export type CaptureProvenance = Readonly<Record<string, string>>;

export interface TurnMemory {
  /** One call per turn, before the provider runs. Never throws for a degraded recall (returns `degraded`).
   *  `scopes` (internal channels, `memory-exposure/`) narrows what the turn may read; a normal turn passes none and reads
   *  everything its principal reaches. The engine can withhold the user scope alone (no `user` on the principal); it cannot
   *  exclude the workspace or the agent-private scope, so a request that needs either off is refused with
   *  `degraded.reason = "scope-not-enforceable"` and the engine is not asked. */
  recall(a: { agentId: string; caller: CallerIdentity; authenticatedPerson?: string; query: string; signal: AbortSignal; turnProfile?: import("../voice/turn-profile.ts").TurnProfile; scopes?: RecallScopes }): Promise<{ text: string; cardIds?: string[]; blocks?: { name: string; text: string; droppable?: boolean; chars?: number }[]; degraded: Degraded | null }>;
  /** One call per turn, after it completed, and never for an incognito session. `incognito` is derived by the core from
   *  the session (F10): it is never a client parameter. */
  capture(a: { agentId: string; caller: CallerIdentity; authenticatedPerson?: string; sessionId: string; turnId: string; messages: { role: "user" | "assistant"; content: string }[]; incognito: boolean; turnProfile?: import("../voice/turn-profile.ts").TurnProfile; provenance?: CaptureProvenance }): Promise<CaptureOutcome | void>;
  /** D23: the `compaction` checkpoint before a swap; never called for an incognito session. */
  checkpoint(a: { agentId: string; reason: "compaction" | "session-end" }): Promise<void>;
}

export interface EnginePortDeps {
  engine: Engine; config: () => HarnessConfig; agents: AgentRegistry; logger: HarnessLogger;
  /** R19: the core's shutdown signal, the only abort a capture observes. */
  captureSignal: AbortSignal; isStopping: () => boolean;
  onStoredCapture?: (agentId: string) => void;
  identity?: import("../identity/service.ts").IdentityService;
  scope?: import("../identity/recall.ts").RecallScopeProvider;
}

export function engineTurnMemory(d: EnginePortDeps): TurnMemory {
  const identity = (caller: CallerIdentity, agentId: string, authenticatedPerson?: string) => {
    requireAgentScope(agentId);
    const result = callerToPrincipal(caller, agentId, requireAgent(d.agents, agentId));
    const origin = channelOrigin.getStore();
    if (origin) {
      const linked = origin.accountId && origin.senderId ? d.identity?.resolve({ channel: origin.channel, accountId: origin.accountId, userId: origin.senderId }) : null;
      if (!linked || linked.humanId !== origin.humanId) throw new Error('channel identity no longer linked');
      result.principal.channel = origin.channel;
      result.principal.accountId = origin.accountId!;
      result.principal.chat = { id: origin.chatId, kind: origin.chatKind === 'direct' ? 'direct' : 'group' };
      result.principal.user = deriveUserPrincipal(linked.humanId);
      return result;
    }
    const linked = d.identity?.resolve(caller);
    if (authenticatedPerson) result.principal.user = deriveUserPrincipal(authenticatedPerson);
    else if (linked) result.principal.user = deriveUserPrincipal(linked.humanId);
    return result;
  };
  return {
    async recall({ agentId, caller, authenticatedPerson, query, signal, turnProfile, scopes }) {
      if (!permitsEngineMemory()) return { text: "", degraded: { reason: "behaviour-scope-unavailable", capability: "recall" } };
      if (scopes && !(scopes.workspace && scopes.agentPrivate)) {
        // Fail closed: the ACL reads the agent's workspace and agent-private scopes for the agent itself, whoever asks.
        const detail = [!scopes.workspace && "workspace", !scopes.agentPrivate && "agent-private"].filter(Boolean).join(", ");
        d.logger.info("memory.recall.refused", { agentId, reason: "scope-not-enforceable", scopes: detail });
        return { text: "", degraded: { reason: "scope-not-enforceable", capability: "recall", detail } };
      }
      const { principal, degraded } = identity(caller, agentId, authenticatedPerson);
      if (scopes && !scopes.user) delete principal.user;
      const r = d.config().core.recall;
      const hard = AbortSignal.timeout(r.hardBudgetMs);
      const principals = (!turnProfile?.localRealtime.enabled || turnProfile.localRealtime.features.recallMultiIdentity.mode === 'on') && principal.user?.startsWith('user:v2:') && d.scope ? d.scope.resolvePrincipals(principal.user) as NonNullable<typeof principal.user>[] : [principal.user];
      const results = await Promise.all(principals.map(user => d.engine.recall({ query, principal: { ...principal, ...(user ? { user } : {}) }, agent: AGENT_CONTEXT_CLI, budget: { softMs: r.softBudgetMs, hardMs: r.hardBudgetMs, capChars: r.capChars }, signal: AbortSignal.any([signal, hard]) })));
      signal.throwIfAborted();
      const res = results[0]!;
      // Union at the adapter boundary: shared workspace/agent blocks repeat across ACL reads, never across output.
      const seen = new Set<string>();
      res.blocks = results.flatMap(result => result.blocks).filter(block => { const key = `${block.name}:${block.text}`; if (seen.has(key)) return false; seen.add(key); return true; });
      const blocks = res.blocks.map((b) => ({ name: b.name, text: b.text, droppable: b.droppable, chars: b.chars }));
      const engineCap = Number.isFinite(res.capChars) ? res.capChars : null;
      const text = joinBlocks(blocks, engineCap === null ? r.capChars : Math.min(engineCap, r.capChars)).text;
      const g = res.degraded ? { reason: String(res.degraded.reason), capability: String(res.degraded.capability ?? "recall") } : null;
      const cardIds = res.blocks.map((b) => b.name);
      return { text, cardIds, blocks, degraded: g ?? degraded };
    },
    async capture({ agentId, caller, authenticatedPerson, sessionId, turnId, messages, incognito, provenance }) {
      const policy = channelBehaviour.getStore();
      if (policy?.memory.capture === "none") return { submitted: false, reason: "channel-policy" };
      if (policy?.memory.capture === "provenance-only") {
        d.logger.info("channel.capture.provenance", { agentId, sessionId, turnId, channel: channelOrigin.getStore()?.channel ?? caller.channel });
        return { submitted: false, reason: "channel-policy" }; // no third-party message text reaches the engine
      }
      if (!permitsEngineMemory()) {
        d.logger.warn("channel.capture.refused", { agentId, sessionId, turnId, reason: "behaviour-scope-unavailable" });
        return { submitted: false, reason: "scope-not-permitted" };
      }
      if (d.isStopping()) return { submitted: false, reason: "core-stopping" }; // the turn is already stored; a stopping core takes no new capture (the next start does not replay it: RULING, a lost capture is logged)
      const { principal } = identity(caller, agentId, authenticatedPerson);
      if (principal.user?.startsWith('user:v2:') && d.scope) principal.user = d.scope.capturePrincipal(principal.user) as NonNullable<typeof principal.user>;
      const handle = d.engine.capture({
        agentId, principal, agent: AGENT_CONTEXT_CLI, messages, incognito, signal: d.captureSignal, sessionKey: `session:${sessionId}`, runId: turnId,
      });
      const r = await handle.done;
      if (r.stored > 0) d.onStoredCapture?.(agentId);
      d.logger.info("session capture done", { ...provenance, agentId, sessionId, turnId, captureId: handle.id, stored: r.stored, skipped: r.skipped, reason: r.reason });
      return { submitted: true };
    },
    async checkpoint({ agentId, reason }) {
      requireAgentScope(agentId);
      requireAgent(d.agents, agentId);
      await d.engine.checkpoint(agentId, reason);
    },
  };
}
