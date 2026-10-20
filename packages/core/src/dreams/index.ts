// Wiring: the scheduler over the real engine, the store under `<state>/dreams`, the agent registry as the agent list.
import path from "node:path";
import type { AgentRegistry } from "../agents.ts";
import type { Layout } from "../paths.ts";
import { createCandidateSource, type CandidateMemory } from "./producer.ts";
import { DreamScheduler, type SchedulerOptions } from "./scheduler.ts";
import { DreamStore } from "./store.ts";
import { DIARY_FILE, type CandidateSource, type Clock, type DreamEngine, type DreamLogger } from "./types.ts";

export { DreamScheduler } from "./scheduler.ts";
export { DreamStore, SCHEMA_VERSION } from "./store.ts";
export { buildDreamsMethods } from "./methods.ts";
export { createCandidateSource, itemsFromEngineList, type CandidateMemory, type CandidateMemoryItem } from "./producer.ts";
export * from "./types.ts";

export interface DreamsOptions {
  engine: DreamEngine; layout: Layout; clock: Clock; logger: DreamLogger; agents: AgentRegistry;
  securePath?: (p: string, options?: { mode?: number }) => unknown;
  /** Test seam / overrides forwarded to the scheduler. */
  scheduler?: Partial<SchedulerOptions>;
  /** Optional candidate producer. Takes precedence over `candidateMemory`. */
  candidates?: CandidateSource;
  /** Memory list the default producer wraps when `candidates` is omitted. */
  candidateMemory?: CandidateMemory;
}

export interface Dreams { scheduler: DreamScheduler; store: DreamStore; start(): Promise<void>; stop(): Promise<void> }

/** `<state>/dreams/dreams.db` holds the ledger; the per-run logs sit beside it as `<agentId>/<phase>/<runId>.log` (ADR-009). */
export function createDreams(o: DreamsOptions): Dreams {
  const dir = path.join(o.layout.state, "dreams");
  const store = new DreamStore(path.join(dir, "dreams.db"), o.securePath ? { securePath: o.securePath } : {});
  const candidates = o.candidates ?? (o.candidateMemory ? createCandidateSource(o.candidateMemory) : undefined);
  const scheduler = new DreamScheduler({
    store, engine: o.engine, clock: o.clock, logger: o.logger, logsDir: dir, agents: () => o.agents.list(),
    // Read the engine-owned diary in the registered agent workspace.
    diaryPath: (id) => { const ws = o.agents.workspaceOf(id); return ws ? path.join(ws, DIARY_FILE) : null; },
    ...o.scheduler,
    ...(candidates ? { candidates } : {}),
  });
  // Runs a killed core left open are closed now, also when the scheduler's own timers stay off (manual-only mode).
  scheduler.reconcile();
  return {
    scheduler, store,
    start: () => scheduler.start(),
    stop: async () => { try { await scheduler.stop(); } finally { store.close(); } },
  };
}

/**
 * For the code that removes an agent (the composition root): drops the agent's schedule rows at once instead of at the next start.
 * Call it after the registry no longer lists the agent (`forgetAgent` refuses a registered one). Never throws: a failure is logged
 * and the next start's cleanup removes the rows.
 */
export function forgetRemovedAgent(scheduler: Pick<DreamScheduler, "forgetAgent"> | null | undefined, agentId: string, logger: DreamLogger): void {
  if (!scheduler) return;
  try {
    const rows = scheduler.forgetAgent(agentId);
    if (rows > 0) logger.info("dreams schedule rows of a removed agent deleted", { agentId, rows });
  } catch (err) { logger.warn("dreams schedule rows of a removed agent kept until the next start", { agentId, err: String((err as Error)?.message ?? err) }); }
}
