import { channelBehaviour, channelOrigin, permitsEngineMemory } from '../channels/behaviour-context.ts';
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

export interface TurnMemory {
  /** One call per turn, before the provider runs. Never throws for a degraded recall (returns `degraded`). */
  recall(a: { agentId: string; caller: CallerIdentity; authenticatedPerson?: string; query: string; signal: AbortSignal; turnProfile?: import("../voice/turn-profile.ts").TurnProfile }): Promise<{ text: string; degraded: Degraded | null }>;
  /** One call per turn, after it completed, and never for an incognito session. `incognito` is derived by the core from
   *  the session (F10): it is never a client parameter. */
  capture(a: { agentId: string; caller: CallerIdentity; authenticatedPerson?: string; sessionId: string; turnId: string; messages: { role: "user" | "assistant"; content: string }[]; incognito: boolean; turnProfile?: import("../voice/turn-profile.ts").TurnProfile }): Promise<void>;
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
    async recall({ agentId, caller, authenticatedPerson, query, signal, turnProfile }) {
      if (!permitsEngineMemory()) return { text: "", degraded: { reason: "behaviour-scope-unavailable", capability: "recall" } };
      const { principal, degraded } = identity(caller, agentId, authenticatedPerson);
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
      return { text, degraded: g ?? degraded };
    },
    async capture({ agentId, caller, authenticatedPerson, sessionId, turnId, messages, incognito }) {
      const policy = channelBehaviour.getStore();
      if (policy?.memory.capture === "none") return;
      if (policy?.memory.capture === "provenance-only") {
        d.logger.info("channel.capture.provenance", { agentId, sessionId, turnId, channel: channelOrigin.getStore()?.channel ?? caller.channel });
        return; // no third-party message text reaches the engine
      }
      if (!permitsEngineMemory()) {
        d.logger.warn("channel.capture.refused", { agentId, sessionId, turnId, reason: "behaviour-scope-unavailable" }); return;
      }
      if (d.isStopping()) return; // the turn is already stored; a stopping core takes no new capture (the next start does not replay it: RULING, a lost capture is logged)
      const { principal } = identity(caller, agentId, authenticatedPerson);
      if (principal.user?.startsWith('user:v2:') && d.scope) principal.user = d.scope.capturePrincipal(principal.user) as NonNullable<typeof principal.user>;
      const handle = d.engine.capture({
        agentId, principal, agent: AGENT_CONTEXT_CLI, messages, incognito, signal: d.captureSignal, sessionKey: `session:${sessionId}`, runId: turnId,
      });
      const r = await handle.done;
      if (r.stored > 0) d.onStoredCapture?.(agentId);
      d.logger.info("session capture done", { agentId, sessionId, turnId, captureId: handle.id, stored: r.stored, skipped: r.skipped, reason: r.reason });
    },
    async checkpoint({ agentId, reason }) {
      requireAgent(d.agents, agentId);
      await d.engine.checkpoint(agentId, reason);
    },
  };
}
