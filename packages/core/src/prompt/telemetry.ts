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

export const CACHE_MISS_CAUSES = ["first-request", "model-changed", "tools-changed", "system-changed", "snapshot-changed", "ttl-expired", "provider"] as const;
export type CacheMissCause = (typeof CACHE_MISS_CAUSES)[number];
export type CacheOutcome = "hit" | "miss" | "not-cacheable";
export type NotCacheableReason = "empty-prefix" | "unknown-model" | "below-minimum" | "no-cache-mechanism" | "no-breakpoints";
/** Most sessions whose last stable state is retained for miss attribution. */
export const CACHE_SESSION_STATE_LIMIT = 1024;

export interface CacheUsageSummary {
  hits: number;
  misses: number;
  notCacheable: number;
  missCauses: Record<CacheMissCause, number>;
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
  outcome: CacheOutcome;
  /** Only when outcome === "miss". */
  cause?: CacheMissCause;
  /** Only when outcome === "not-cacheable". */
  notCacheableReason?: NotCacheableReason;
  /** Only when cause === "tools-changed". */
  toolsAdded?: number;
  toolsRemoved?: number;
}

/** Per-model summary shape served by telemetry.cache.summary. */
export interface CacheModelSummary extends CacheUsageSummary {
  model: string;
}

export interface CacheTelemetry {
  /** One successful provider-usage report per turn. Returns a detached record for the host's telemetry hook. */
  record(prompt: RenderedPrompt, usage: ProviderCacheUsage): CacheUsageRecord;
  /** Weighted token share, not the average of turn ratios. Optional sessionId is the host's original identity. */
  summary(agentId: string, model: string, sessionId?: string): CacheUsageSummary | undefined;
  /** Per-model summaries of one harness session (sessionId is converted with stickySessionId). Sorted by model id; [] when nothing was recorded. Returns detached copies. */
  sessionModels(agentId: string, sessionId: string): Array<{ model: string; summary: CacheUsageSummary }>;
}

interface StableState { model: string; tools: string; system: string; memory: string; toolNames: string[] }

const zeroCauses = (): Record<CacheMissCause, number> => ({ "first-request": 0, "model-changed": 0, "tools-changed": 0, "system-changed": 0, "snapshot-changed": 0, "ttl-expired": 0, provider: 0 });

function toolNames(prompt: RenderedPrompt): string[] {
  const names: string[] = [];
  for (const seg of prompt.segments) {
    if (seg.zone !== "tools" || seg.kind !== "tool_def") continue;
    try {
      const name = (JSON.parse(seg.text) as { name?: unknown } | null)?.name;
      if (typeof name === "string") names.push(name);
    } catch { /* skipped */ }
  }
  return names;
}

function classify(prompt: RenderedPrompt, usage: ProviderCacheUsage, prev: StableState | undefined, names: string[]):
  { outcome: CacheOutcome; cause?: CacheMissCause; notCacheableReason?: NotCacheableReason; toolsAdded?: number; toolsRemoved?: number } {
  const c = prompt.cache;
  const reason = c.reason;
  if (reason === "empty-prefix" || reason === "unknown-model" || reason === "below-minimum") return { outcome: "not-cacheable", notCacheableReason: reason };
  if (c.mechanism === "none") return { outcome: "not-cacheable", notCacheableReason: "no-cache-mechanism" };
  if (c.mechanism === "explicit" && prompt.breakpoints.length === 0) return { outcome: "not-cacheable", notCacheableReason: "no-breakpoints" };
  const tolerance = c.mechanism === "implicit" ? 128 : 0;
  if (usage.cache_read >= prompt.stableTokensEstimate - tolerance) return { outcome: "hit" };
  const z = prompt.zoneHashes;
  if (!prev) return { outcome: "miss", cause: "first-request" };
  if (normalizeModelId(prompt.model) !== prev.model) return { outcome: "miss", cause: "model-changed" };
  if (z.tools !== prev.tools) {
    const before = new Set(prev.toolNames);
    const now = new Set(names);
    return { outcome: "miss", cause: "tools-changed", toolsAdded: [...now].filter((n) => !before.has(n)).length, toolsRemoved: [...before].filter((n) => !now.has(n)).length };
  }
  if (z.system !== prev.system) return { outcome: "miss", cause: "system-changed" };
  if (z.memory !== prev.memory) return { outcome: "miss", cause: "snapshot-changed" };
  if (c.ageMs !== null && c.ttlMs !== null && c.ageMs >= c.ttlMs) return { outcome: "miss", cause: "ttl-expired" };
  return { outcome: "miss", cause: "provider" };
}

const empty = (): CacheUsageSummary => ({ hits: 0, misses: 0, notCacheable: 0, missCauses: zeroCauses(), cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0, totalInputTokens: 0, hitRatio: 0, turns: 0 });
const key = (agentId: string, model: string, session_id?: string) => canonicalJson({ agentId, model: normalizeModelId(model), session_id });

/** No logging backend or I/O; retains totals rather than an unbounded history of turn records. */
export function createCacheTelemetry(): CacheTelemetry {
  const totals = new Map<string, CacheUsageSummary>();
  const states = new Map<string, StableState>();
  const sessionModelIds = new Map<string, Set<string>>();
  const copy = (v: CacheUsageSummary): CacheUsageSummary => ({ ...v, missCauses: { ...v.missCauses } });
  return {
    record(prompt, usage) {
      const counts = [usage.cache_read, usage.cache_creation, usage.input];
      if (!counts.every((n) => Number.isSafeInteger(n) && n >= 0)) throw new TypeError("cache usage must contain nonnegative safe integer token counts");
      const totalInputTokens = usage.cache_read + usage.cache_creation + usage.input;
      if (!Number.isSafeInteger(totalInputTokens)) throw new TypeError("cache usage total exceeds safe integer range");
      const prev = states.get(prompt.session_id);
      const names = toolNames(prompt);
      const verdict = classify(prompt, usage, prev, names);
      const keys = [key(prompt.agentId, prompt.model), key(prompt.agentId, prompt.model, prompt.session_id)];
      const updated = keys.map((k) => {
        const prev = totals.get(k) ?? empty();
        const next = { cacheReadTokens: prev.cacheReadTokens + usage.cache_read,
          cacheCreationTokens: prev.cacheCreationTokens + usage.cache_creation, inputTokens: prev.inputTokens + usage.input,
          totalInputTokens: prev.totalInputTokens + totalInputTokens, turns: prev.turns + 1, hitRatio: 0,
          hits: prev.hits + (verdict.outcome === "hit" ? 1 : 0), misses: prev.misses + (verdict.outcome === "miss" ? 1 : 0),
          notCacheable: prev.notCacheable + (verdict.outcome === "not-cacheable" ? 1 : 0), missCauses: { ...prev.missCauses } };
        if (verdict.cause) next.missCauses[verdict.cause] += 1;
        if (![next.cacheReadTokens, next.cacheCreationTokens, next.inputTokens, next.totalInputTokens, next.turns, next.hits, next.misses, next.notCacheable].every(Number.isSafeInteger)) throw new TypeError("cache usage aggregate exceeds safe integer range");
        next.hitRatio = next.totalInputTokens === 0 ? 0 : next.cacheReadTokens / next.totalInputTokens;
        return next;
      });
      keys.forEach((k, i) => totals.set(k, updated[i]!));
      states.delete(prompt.session_id);
      states.set(prompt.session_id, { model: normalizeModelId(prompt.model), tools: prompt.zoneHashes.tools, system: prompt.zoneHashes.system, memory: prompt.zoneHashes.memory, toolNames: names });
      if (states.size > CACHE_SESSION_STATE_LIMIT) states.delete(states.keys().next().value as string);
      const sessionKey = `${prompt.agentId}\0${prompt.session_id}`;
      const ids = sessionModelIds.get(sessionKey) ?? new Set<string>();
      ids.add(normalizeModelId(prompt.model));
      sessionModelIds.set(sessionKey, ids);
      const turnCauses = zeroCauses();
      if (verdict.cause) turnCauses[verdict.cause] = 1;
      return { agentId: prompt.agentId, model: prompt.model, session_id: prompt.session_id, turn: updated[1]!.turns,
        cacheReadTokens: usage.cache_read, cacheCreationTokens: usage.cache_creation, inputTokens: usage.input,
        totalInputTokens, hitRatio: totalInputTokens === 0 ? 0 : usage.cache_read / totalInputTokens,
        breakpointCount: prompt.breakpoints.length, zoneHashes: { ...prompt.zoneHashes },
        hits: verdict.outcome === "hit" ? 1 : 0, misses: verdict.outcome === "miss" ? 1 : 0, notCacheable: verdict.outcome === "not-cacheable" ? 1 : 0, missCauses: turnCauses,
        outcome: verdict.outcome, ...(verdict.cause ? { cause: verdict.cause } : {}),
        ...(verdict.notCacheableReason ? { notCacheableReason: verdict.notCacheableReason } : {}),
        ...(verdict.cause === "tools-changed" ? { toolsAdded: verdict.toolsAdded!, toolsRemoved: verdict.toolsRemoved! } : {}) };
    },
    summary(agentId, model, sessionId) {
      const session_id = sessionId === undefined ? undefined : stickySessionId(agentId, sessionId);
      const value = totals.get(key(agentId, model, session_id));
      return value ? copy(value) : undefined;
    },
    sessionModels(agentId, sessionId) {
      const sticky = stickySessionId(agentId, sessionId);
      const ids = sessionModelIds.get(`${agentId}\0${sticky}`);
      if (!ids) return [];
      const out: Array<{ model: string; summary: CacheUsageSummary }> = [];
      for (const model of [...ids].sort()) {
        const v = totals.get(key(agentId, model, sticky));
        if (v) out.push({ model, summary: copy(v) });
      }
      return out;
    },
  };
}

/** Stable routing identity; kept separate from rendered prefix content. */
export function stickySessionId(agentId: string, sessionId = "default"): string {
  return sha256Hex(canonicalJson({ agentId, sessionId }));
}
