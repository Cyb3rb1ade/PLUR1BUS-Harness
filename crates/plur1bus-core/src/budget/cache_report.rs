//! `budget/cache-report.ts` (D120 H2-1): the read model over the budget ledger, the prompt-cache hit ratio per provider, agent
//! and model. Read-only; counts and ids only. The ledger has no marker for estimated settlements: those rows land in
//! `uncached_calls`; `hit_ratio_caching` is the ratio over calls that reported any cache activity.
use super::BudgetError;
use plur1bus_store::rusqlite::{params, Connection};

/// `CacheUsageRow`.
#[derive(Clone, Debug, PartialEq)]
pub struct CacheUsageRow {
    /// The provider (empty for a row recorded without one).
    pub provider: String,
    /// The agent.
    pub agent_id: String,
    /// The model.
    pub model: String,
    /// Ledger rows.
    pub calls: i64,
    /// Rows with `cache_read_tokens = 0` and `cache_write_tokens = 0`.
    pub uncached_calls: i64,
    /// `SUM(input_tokens)`, cache reads and writes included.
    pub input_tokens: i64,
    /// Output tokens.
    pub output_tokens: i64,
    /// Cache reads.
    pub cache_read_tokens: i64,
    /// Cache writes.
    pub cache_write_tokens: i64,
    /// `SUM(input_tokens)` over rows with any cache activity.
    pub caching_input_tokens: i64,
    /// Reads over input, at most 1.
    pub hit_ratio: f64,
    /// Reads over the input of rows with cache activity, at most 1.
    pub hit_ratio_caching: f64,
}

fn ratio(n: i64, d: i64) -> f64 {
    if d == 0 {
        0.0
    } else {
        (n as f64 / d as f64).min(1.0)
    }
}

/// `summarizeCacheUsage` over `[since, until)`, optionally for one agent, ordered by provider, agent, model.
pub fn summarize_cache_usage(
    conn: &Connection,
    since: i64,
    until: i64,
    agent_id: Option<&str>,
) -> Result<Vec<CacheUsageRow>, BudgetError> {
    let sql = format!(
        "SELECT provider, agent, model,
  COUNT(*) AS calls,
  COALESCE(SUM(CASE WHEN cache_read_tokens = 0 AND cache_write_tokens = 0 THEN 1 ELSE 0 END), 0) AS uncached_calls,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(CASE WHEN cache_read_tokens > 0 OR cache_write_tokens > 0 THEN input_tokens ELSE 0 END), 0) AS caching_input_tokens
FROM usage_event
WHERE ts >= ? AND ts < ?{}
GROUP BY provider, agent, model
ORDER BY provider, agent, model",
        if agent_id.is_some() { " AND agent = ?" } else { "" }
    );
    let map = |r: &plur1bus_store::rusqlite::Row<'_>| {
        let input_tokens: i64 = r.get(5)?;
        let cache_read_tokens: i64 = r.get(7)?;
        let caching_input_tokens: i64 = r.get(9)?;
        Ok(CacheUsageRow {
            provider: r.get(0)?,
            agent_id: r.get(1)?,
            model: r.get(2)?,
            calls: r.get(3)?,
            uncached_calls: r.get(4)?,
            input_tokens,
            output_tokens: r.get(6)?,
            cache_read_tokens,
            cache_write_tokens: r.get(8)?,
            caching_input_tokens,
            hit_ratio: ratio(cache_read_tokens, input_tokens),
            hit_ratio_caching: ratio(cache_read_tokens, caching_input_tokens),
        })
    };
    let mut st = conn.prepare(&sql)?;
    let rows = match agent_id {
        None => st
            .query_map(params![since, until], map)?
            .collect::<Result<Vec<_>, _>>()?,
        Some(a) => st
            .query_map(params![since, until, a], map)?
            .collect::<Result<Vec<_>, _>>()?,
    };
    Ok(rows)
}
