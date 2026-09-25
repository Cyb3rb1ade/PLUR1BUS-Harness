import type { Engine } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { AgentRegistry } from "./agents.ts";
import type { HarnessLogger } from "./logger.ts";

export interface ReplayOptions { dir: string; agents: AgentRegistry; engine: Engine; logger: HarnessLogger; clock: () => number }
export interface ReplayResult { replayed: number; kept: number }

/** Replays state/journal/<agentId>.jsonl into the engine at core start. Task 8 stub: Task 9 replaces the body. */
export async function replayJournal(_o: ReplayOptions): Promise<ReplayResult> {
  return { replayed: 0, kept: 0 };
}
