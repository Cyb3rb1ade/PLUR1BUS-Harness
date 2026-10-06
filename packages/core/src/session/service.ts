// Assembles the session subsystem for the core: store file, crash recovery, compactor with the pre-swap checkpoint,
// the turn runner, the `session.*` handlers. Kept apart from core.ts so the wiring there is one contained block.
import type { AgentRegistry } from "../agents.ts";
import type { HarnessLogger } from "../logger.ts";
import type { Handler } from "../rpc/server.ts";
import { Compactor, defaultCompaction, type CompactionConfig } from "./compaction.ts";
import type { TurnMemory } from "./memory-port.ts";
import { buildSessionMethods, toWireEvent } from "./methods.ts";
import type { ChatProvider } from "./provider.ts";
import { SessionStore } from "./store.ts";
import { TurnRunner } from "./turn-loop.ts";

export interface SessionServiceDeps {
  dbPath: string; clock: () => number; logger: HarnessLogger; agents: AgentRegistry; isStopping: () => boolean;
  memory: TurnMemory;
  /** null: none configured; the real adapters (packages/providers) plug in here later. */
  provider: () => ChatProvider | null;
  /** `session.event` fan-out (opt-in notification; the core binds it to its RPC server). */
  notify: (method: string, params: object, opts: { optIn: true }) => void;
  /** The core's shutdown signal. */
  signal: AbortSignal;
  compaction?: CompactionConfig;
}

export interface SessionService { store: SessionStore; runner: TurnRunner; methods: Record<string, Handler>; recovered: number; close(budgetMs?: number): Promise<void> }

export function openSessionService(d: SessionServiceDeps): SessionService {
  const store = new SessionStore({ path: d.dbPath, clock: d.clock });
  // Acceptance 7: a turn that was running when the previous core died is marked failed before anything is served.
  const recovered = store.recoverRunningTurns().length;
  if (recovered > 0) d.logger.warn("session turns recovered as failed", { count: recovered });
  const compactor = new Compactor(store, d.compaction ?? defaultCompaction(), {
    // D23: the engine checkpoint `compaction` precedes every swap; an incognito session never checkpoints (D92 §3.3).
    beforeSwap: async ({ sessionId }) => {
      const s = store.getSession(sessionId);
      if (!s || s.memoryMode === "incognito") return "skipped";
      await d.memory.checkpoint({ agentId: s.agentId, reason: "compaction" });
    },
    onError: (what, err) => d.logger.warn(`${what} failed`, { err }),
  });
  const runner = new TurnRunner({
    store, compactor, memory: d.memory, provider: d.provider, signal: d.signal,
    logger: { info: (m, f) => d.logger.info(m, f), warn: (m, f) => d.logger.warn(m, f) },
    notify: (e, s) => d.notify("session.event", { agentId: s.agentId, event: toWireEvent(e) }, { optIn: true }),
  });
  const methods = buildSessionMethods({ store, runner, agents: d.agents, isStopping: d.isStopping });
  return {
    store, runner, methods, recovered,
    // A turn that ignores the shutdown abort is not waited for beyond the budget: it stays `running` in the file and the
    // next start marks it failed (recovery), so nothing is lost by closing the store under it.
    async close(budgetMs = 5_000) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([runner.idle(), new Promise<void>((res) => { timer = setTimeout(res, budgetMs); timer.unref(); })]);
      clearTimeout(timer);
      store.close();
    },
  };
}
