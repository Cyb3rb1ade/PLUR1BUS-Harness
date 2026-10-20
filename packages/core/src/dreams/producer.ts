// Public memory cards provide identity/age; Engine 1.17.0 (A1) adds persistent recall
// statistics and confirmed promotion. The pinned contract is allowed to lack both.
// ADR-009 Q5: dreaming considers agent-private cards only; no invented recall signals.
import type { AgentContext, Principal } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { contentHash } from "./candidates.ts";
import type { CandidateInput, CandidateSource, CandidatePromotionResult, CandidateRecallStats } from "./types.ts";

export interface CandidateMemoryItem extends CandidateInput {}

/** Bound to the requesting agent's principal by the composition root. */
export interface CandidateMemory {
  list(agentId: string): Promise<CandidateMemoryItem[]> | CandidateMemoryItem[];
  stats?(agentId: string, ids: readonly string[]): Promise<CandidateRecallStats>;
  promote?(agentId: string, ids: readonly string[]): Promise<CandidatePromotionResult>;
}

/** Compatibility slice until the Controller pins the A1 contract. No private Engine API. */
export interface A1MemoryOperations {
  stats?(ids: readonly string[] | undefined, principal: Principal, context: AgentContext): Promise<CandidateRecallStats>;
  promote?(request: { ids: readonly string[] }, principal: Principal, context: AgentContext): Promise<CandidatePromotionResult>;
}

export interface EngineMemoryCard {
  id?: string; text: string; scope: string; score?: number; createdAt?: number | null;
  /** Used only when reported by a public contract; never inferred from search score. */
  importance?: number;
}
export interface EngineMemoryList { items: readonly EngineMemoryCard[]; truncated: boolean }
const AGENT_PRIVATE = "agent-private";
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Refuse an incomplete corpus; retain actual private ids and source metadata. */
export function itemsFromEngineList(r: EngineMemoryList): CandidateMemoryItem[] {
  if (r.truncated) throw new Error("engine memory listing is truncated");
  const cards = r.items.filter((c) => c.scope === AGENT_PRIVATE);
  const repetitions = new Map<string, Set<string>>();
  for (const c of cards) {
    const hash = contentHash(c.text);
    if (typeof c.id !== "string" || c.id.length === 0) continue;
    const ids = repetitions.get(hash) ?? new Set<string>();
    ids.add(c.id); repetitions.set(hash, ids);
  }
  return cards.map((c) => ({
    content: c.text, partition: AGENT_PRIVATE,
    ...(typeof c.id === "string" && c.id.length > 0 ? { memoryId: c.id } : {}),
    ...(finite(c.createdAt) ? { createdAt: c.createdAt } : {}),
    ...(finite(c.importance) ? { importance: c.importance } : {}),
    ...(finite(c.score) ? { score: c.score } : {}),
    // Count distinct source cards, never scheduler pulls of the same card.
    ...((repetitions.get(contentHash(c.text))?.size ?? 0) > 1 ? { repetitions: repetitions.get(contentHash(c.text))!.size } : {}),
  }));
}

export function createCandidateSource(memory: CandidateMemory): CandidateSource {
  return {
    async pull(agentId) {
      const items = (await memory.list(agentId)).filter((i) => i.partition === undefined || i.partition === AGENT_PRIVATE);
      const ids = [...new Set(items.flatMap((i) => i.memoryId ? [i.memoryId] : []))];
      const byId = new Map<string, CandidateRecallStats["items"][number]>();
      if (memory.stats && ids.length > 0) {
        const result = await memory.stats(agentId, ids);
        if (result.agentId !== agentId || !Array.isArray(result.items)) throw new Error("invalid Engine recall statistics agent");
        const requested = new Set(ids);
        for (const s of result.items) {
          if (!requested.has(s.id) || byId.has(s.id) || !Number.isSafeInteger(s.recalls) || s.recalls < 0 ||
            !Number.isSafeInteger(s.distinctQueries) || s.distinctQueries < 0 ||
            !(s.lastRecalledAt === null || (finite(s.lastRecalledAt) && s.lastRecalledAt >= 0))) throw new Error("invalid Engine recall statistics item");
          byId.set(s.id, s);
        }
      }
      return items.map((i) => {
        const s = i.memoryId ? byId.get(i.memoryId) : undefined;
        const { recalls: _recalls, uniqueQueries: _queries, lastRecalledAt: _lastRecall, ...withoutCounters } = i;
        return { ...(memory.stats ? withoutCounters : i), ...(s ? { recalls: s.recalls, uniqueQueries: s.distinctQueries, lastRecalledAt: s.lastRecalledAt } : {}) };
      });
    },
    ...(memory.promote ? { promote: (agentId: string, ids: readonly string[]) => memory.promote!(agentId, ids) } : {}),
  };
}
