// Wiring: the scheduler over the real engine, the store under `<state>/dreams`, the agent registry as the agent list.
import path from "node:path";
import type { AgentRegistry } from "../agents.ts";
import type { Layout } from "../paths.ts";
import { DreamScheduler, type SchedulerOptions } from "./scheduler.ts";
import { DreamStore } from "./store.ts";
import { DIARY_FILE, type Clock, type DreamEngine, type DreamLogger } from "./types.ts";

export { DreamScheduler } from "./scheduler.ts";
export { DreamStore, SCHEMA_VERSION } from "./store.ts";
export { buildDreamsMethods } from "./methods.ts";
export * from "./types.ts";

export interface DreamsOptions {
  engine: DreamEngine; layout: Layout; clock: Clock; logger: DreamLogger; agents: AgentRegistry;
  securePath?: (p: string) => unknown;
  /** Test seam / overrides forwarded to the scheduler. */
  scheduler?: Partial<SchedulerOptions>;
}

export interface Dreams { scheduler: DreamScheduler; store: DreamStore; start(): Promise<void>; stop(): Promise<void> }

/** `<state>/dreams/dreams.db` holds the ledger; the per-run logs sit beside it as `<agentId>/<phase>/<runId>.log` (ADR-009). */
export function createDreams(o: DreamsOptions): Dreams {
  const dir = path.join(o.layout.state, "dreams");
  const store = new DreamStore(path.join(dir, "dreams.db"), o.securePath ? { securePath: o.securePath } : {});
  const scheduler = new DreamScheduler({
    store, engine: o.engine, clock: o.clock, logger: o.logger, logsDir: dir, agents: () => o.agents.list(),
    // D15 harness-host name. TODO(engine): the pinned engine still writes DREAMS.md; until it follows D15 `exists` stays false for it.
    diaryPath: (id) => { const ws = o.agents.workspaceOf(id); return ws ? path.join(ws, DIARY_FILE) : null; },
    ...o.scheduler,
  });
  return {
    scheduler, store,
    start: () => scheduler.start(),
    stop: async () => { try { await scheduler.stop(); } finally { store.close(); } },
  };
}
