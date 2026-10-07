import { canonicalJson, sha256Hex } from "./canonical.ts";
import { normalizeModelId } from "./model-table.ts";
import type { RenderedPrompt, ZoneHashes } from "./types.ts";

/** Provider adapters translate their usage into these non-overlapping token buckets. */
export interface ProviderCacheUsage {
  cache_read: number;
  cache_creation: number;
  /** Uncached input only (subtract cached tokens if the provider reports an inclusive total). */
  input: number;
}

export interface CacheUsageSummary {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputTokens: number;
  totalInputTokens: number;
  hitRatio: number;
  turns: number;
}

export interface CacheUsageRecord extends Omit<CacheUsageSummary, "turns"> {
  agentId: string;
  model: string;
  session_id: string;
  turn: number;
  breakpointCount: number;
  zoneHashes: ZoneHashes;
}

export interface CacheTelemetry {
  /** One successful provider-usage report per turn. Returns a detached record for the host's telemetry hook. */
  record(prompt: RenderedPrompt, usage: ProviderCacheUsage): CacheUsageRecord;
  /** Weighted token share, not the average of turn ratios. Optional sessionId is the host's original identity. */
  summary(agentId: string, model: string, sessionId?: string): CacheUsageSummary | undefined;
}

const empty = (): CacheUsageSummary => ({ cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0, totalInputTokens: 0, hitRatio: 0, turns: 0 });
const key = (agentId: string, model: string, session_id?: string) => canonicalJson({ agentId, model: normalizeModelId(model), session_id });

/** No logging backend or I/O; retains totals rather than an unbounded history of turn records. */
export function createCacheTelemetry(): CacheTelemetry {
  const totals = new Map<string, CacheUsageSummary>();
  return {
    record(prompt, usage) {
      const counts = [usage.cache_read, usage.cache_creation, usage.input];
      if (!counts.every((n) => Number.isSafeInteger(n) && n >= 0)) throw new TypeError("cache usage must contain nonnegative safe integer token counts");
      const totalInputTokens = usage.cache_read + usage.cache_creation + usage.input;
      if (!Number.isSafeInteger(totalInputTokens)) throw new TypeError("cache usage total exceeds safe integer range");
      const keys = [key(prompt.agentId, prompt.model), key(prompt.agentId, prompt.model, prompt.session_id)];
      const updated = keys.map((k) => {
        const prev = totals.get(k) ?? empty();
        const next = { cacheReadTokens: prev.cacheReadTokens + usage.cache_read,
          cacheCreationTokens: prev.cacheCreationTokens + usage.cache_creation, inputTokens: prev.inputTokens + usage.input,
          totalInputTokens: prev.totalInputTokens + totalInputTokens, turns: prev.turns + 1, hitRatio: 0 };
        if (![next.cacheReadTokens, next.cacheCreationTokens, next.inputTokens, next.totalInputTokens, next.turns].every(Number.isSafeInteger)) throw new TypeError("cache usage aggregate exceeds safe integer range");
        next.hitRatio = next.totalInputTokens === 0 ? 0 : next.cacheReadTokens / next.totalInputTokens;
        return next;
      });
      keys.forEach((k, i) => totals.set(k, updated[i]!));
      return { agentId: prompt.agentId, model: prompt.model, session_id: prompt.session_id, turn: updated[1]!.turns,
        cacheReadTokens: usage.cache_read, cacheCreationTokens: usage.cache_creation, inputTokens: usage.input,
        totalInputTokens, hitRatio: totalInputTokens === 0 ? 0 : usage.cache_read / totalInputTokens,
        breakpointCount: prompt.breakpoints.length, zoneHashes: { ...prompt.zoneHashes } };
    },
    summary(agentId, model, sessionId) {
      const session_id = sessionId === undefined ? undefined : stickySessionId(agentId, sessionId);
      const value = totals.get(key(agentId, model, session_id));
      return value ? { ...value } : undefined;
    },
  };
}

/** Stable routing identity; kept separate from rendered prefix content. */
export function stickySessionId(agentId: string, sessionId = "default"): string {
  return sha256Hex(canonicalJson({ agentId, sessionId }));
}
