// Read model over the budget ledger (D120 H2-1): prompt-cache hit ratio per provider, agent and model. Read-only; counts and ids only.
// The ledger has no marker for estimated settlements: those rows land in `uncachedCalls`; `hitRatioCaching` is the ratio over calls
// that reported any cache activity.
import type { DatabaseSync } from "node:sqlite";

export interface CacheUsageRow {
  provider: string; agentId: string; model: string;
  /** Ledger rows. */
  calls: number;
  /** Rows with cache_read_tokens = 0 AND cache_write_tokens = 0. */
  uncachedCalls: number;
  /** SUM(input_tokens), cache reads and writes included. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** SUM(input_tokens) over rows with any cache activity. */
  cachingInputTokens: number;
  hitRatio: number;
  hitRatioCaching: number;
}

interface Row {
  provider: string; agent: string; model: string; calls: number | bigint; uncached_calls: number | bigint; input_tokens: number | bigint;
  output_tokens: number | bigint; cache_read_tokens: number | bigint; cache_write_tokens: number | bigint; caching_input_tokens: number | bigint;
}

const ratio = (n: number, d: number): number => (d === 0 ? 0 : Math.min(1, n / d));

export function summarizeCacheUsage(db: DatabaseSync, o: { since: number; until: number; agentId?: string }): CacheUsageRow[] {
  const sql = `SELECT provider, agent, model,
  COUNT(*) AS calls,
  COALESCE(SUM(CASE WHEN cache_read_tokens = 0 AND cache_write_tokens = 0 THEN 1 ELSE 0 END), 0) AS uncached_calls,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(CASE WHEN cache_read_tokens > 0 OR cache_write_tokens > 0 THEN input_tokens ELSE 0 END), 0) AS caching_input_tokens
FROM usage_event
WHERE ts >= ? AND ts < ?${o.agentId === undefined ? "" : " AND agent = ?"}
GROUP BY provider, agent, model
ORDER BY provider, agent, model`;
  const params = o.agentId === undefined ? [o.since, o.until] : [o.since, o.until, o.agentId];
  const rows = db.prepare(sql).all(...params) as unknown as Row[];
  return rows.map((r) => {
    const inputTokens = Number(r.input_tokens), cacheReadTokens = Number(r.cache_read_tokens), cachingInputTokens = Number(r.caching_input_tokens);
    return { provider: r.provider, agentId: r.agent, model: r.model, calls: Number(r.calls), uncachedCalls: Number(r.uncached_calls),
      inputTokens, outputTokens: Number(r.output_tokens), cacheReadTokens, cacheWriteTokens: Number(r.cache_write_tokens), cachingInputTokens,
      hitRatio: ratio(cacheReadTokens, inputTokens), hitRatioCaching: ratio(cacheReadTokens, cachingInputTokens) };
  });
}
