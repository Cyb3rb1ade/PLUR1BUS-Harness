// Maps existing recall/capture cards onto CandidateInput. The pinned engine (1.12.0) yields content
// and an optional topic-search score, but no recall/query stats; those fields stay unset unless the
// memory port reports them. Gates in candidates.ts stay the authority. Do not invent scoring.
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

export function createCandidateSource(memory: CandidateMemory): CandidateSource {
  return {
    async pull(agentId) {
      const items = await memory.list(agentId);
      return items.map((i): CandidateInput => ({
        content: i.content,
        ...(i.partition !== undefined ? { partition: i.partition } : {}),
        ...(i.recalls !== undefined ? { recalls: i.recalls } : {}),
        ...(i.uniqueQueries !== undefined ? { uniqueQueries: i.uniqueQueries } : {}),
        ...(i.score !== undefined ? { score: i.score } : {}),
      }));
    },
  };
}
