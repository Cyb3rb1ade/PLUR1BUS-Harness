// Maps existing recall/capture cards onto CandidateInput. The pinned engine (1.12.0) yields content
// and an optional topic-search score, but no recall/query stats; those fields stay unset unless the
// memory port reports them. Gates in candidates.ts stay the authority. Do not invent scoring.
// ADR-009 Q5: M1 dreams the agent-private partition only.
import type { CandidateInput, CandidateSource } from "./types.ts";

export interface CandidateMemoryItem {
  content: string;
  partition?: string;
  recalls?: number;
  uniqueQueries?: number;
  score?: number;
}

/** A memory list the producer can drive. Tests supply a fake; production wraps Engine.memory.list. */
export interface CandidateMemory {
  list(agentId: string): Promise<CandidateMemoryItem[]> | CandidateMemoryItem[];
}

/** Shape of `Engine.memory.list` the production wiring maps. Score is typically absent on a `since` listing. */
export interface EngineMemoryCard {
  text: string;
  scope: string;
  score?: number;
}

export interface EngineMemoryList {
  items: readonly EngineMemoryCard[];
  truncated: boolean;
}

const AGENT_PRIVATE = "agent-private";

/** Fail closed on a truncated page; keep only agent-private cards (copy `scope` as `partition`). Do not invent stats. */
export function itemsFromEngineList(r: EngineMemoryList): CandidateMemoryItem[] {
  if (r.truncated) throw new Error("engine memory listing is truncated");
  const out: CandidateMemoryItem[] = [];
  for (const c of r.items) {
    if (c.scope !== AGENT_PRIVATE) continue;
    out.push({
      content: c.text,
      partition: AGENT_PRIVATE,
      ...(typeof c.score === "number" && Number.isFinite(c.score) ? { score: c.score } : {}),
    });
  }
  return out;
}

export function createCandidateSource(memory: CandidateMemory): CandidateSource {
  return {
    async pull(agentId) {
      const items = await memory.list(agentId);
      const out: CandidateInput[] = [];
      for (const i of items) {
        if (i.partition !== undefined && i.partition !== AGENT_PRIVATE) continue;
        out.push({
          content: i.content,
          ...(i.partition !== undefined ? { partition: i.partition } : {}),
          ...(i.recalls !== undefined ? { recalls: i.recalls } : {}),
          ...(i.uniqueQueries !== undefined ? { uniqueQueries: i.uniqueQueries } : {}),
          ...(i.score !== undefined ? { score: i.score } : {}),
        });
      }
      return out;
    },
  };
}
