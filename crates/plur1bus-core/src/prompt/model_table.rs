//! The prompt builder's view of the provider cache-profile table (ADR-010 R1/R2;
//! `packages/core/src/prompt/model-table.ts`, `ttl.ts`). The rows are data in
//! `packages/providers/schema/cache-profiles.json`, read here through `plur1bus-tokens`, which the engine uses as well.
use plur1bus_tokens::cache_profiles::CacheProfileTable;
use serde_json::{json, Value};
use std::sync::OnceLock;

pub use plur1bus_tokens::cache_profiles::CacheRoute;

/// How a provider caches a prompt prefix.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mechanism {
    /// The caller marks breakpoints.
    Explicit,
    /// The provider caches the longest stable prefix on its own.
    Implicit,
    /// Nothing is known, so no marker is ever emitted.
    None,
}

impl Mechanism {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Mechanism::Explicit => "explicit",
            Mechanism::Implicit => "implicit",
            Mechanism::None => "none",
        }
    }
}

/// `CacheProfile`: what the builder needs of one table row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CacheProfile {
    /// The table row; `unknown` for the fail-closed fallback.
    pub id: String,
    /// The provider class of the row, or `unknown`.
    pub provider: String,
    /// The cache mechanism.
    pub mechanism: Mechanism,
    /// Minimum cacheable prefix in tokens.
    pub min_tokens: u64,
    /// Most explicit breakpoints per request; 0 for implicit and unknown.
    pub max_breakpoints: u64,
    /// How many block positions a cache read walks back from a breakpoint.
    pub lookback_positions: u64,
    /// TTL tiers the caller can choose, shortest first.
    pub ttls: Vec<String>,
    /// Window in which a repeated prefix is predicted warm.
    pub warm_ms: Option<u64>,
    /// Whether the table knows the model on this route.
    pub known: bool,
}

impl CacheProfile {
    /// The profile as the TypeScript object (for the vectors).
    pub fn json(&self) -> Value {
        json!({ "id": self.id, "provider": self.provider, "mechanism": self.mechanism.as_str(), "minTokens": self.min_tokens,
            "maxBreakpoints": self.max_breakpoints, "lookbackPositions": self.lookback_positions, "ttls": self.ttls,
            "warmMs": self.warm_ms, "known": self.known })
    }
}

/// The bundled table, checked once. `None` when the compiled-in file does not pass its own schema: every model is then
/// unknown, which places no marker (fail closed). A unit test keeps that from shipping.
fn table() -> Option<&'static CacheProfileTable> {
    static TABLE: OnceLock<Option<CacheProfileTable>> = OnceLock::new();
    TABLE
        .get_or_init(|| CacheProfileTable::bundled().ok())
        .as_ref()
}

/// The fail-closed fallback: no markers (a wire format may reject a marker it does not support) and the highest floor
/// in the table.
fn unknown() -> CacheProfile {
    let min_tokens = table()
        .and_then(|t| t.rows().iter().map(|r| r.min_tokens).max())
        .unwrap_or(u64::MAX);
    CacheProfile {
        id: "unknown".to_owned(),
        provider: "unknown".to_owned(),
        mechanism: Mechanism::None,
        min_tokens,
        max_breakpoints: 0,
        lookback_positions: 0,
        ttls: Vec::new(),
        warm_ms: None,
        known: false,
    }
}

/// `normalizeModelId`: lower case, no gateway or platform decoration, dots as dashes, served aliases applied.
pub fn normalize_model_id(model: &str) -> String {
    match table() {
        Some(t) => t.normalize_model_ref(model).id,
        None => model.to_owned(),
    }
}

/// `lookupCacheProfile(model, route)`; first-party when no route is known.
pub fn lookup_cache_profile(model: &str, route: Option<&CacheRoute>) -> CacheProfile {
    let Some(t) = table() else {
        return unknown();
    };
    let default_route = CacheRoute::default();
    let found = t.find_cache_profile(model, route.unwrap_or(&default_route));
    let Some(row) = found.row else {
        return unknown();
    };
    CacheProfile {
        id: row.id.clone(),
        provider: row.provider.clone(),
        mechanism: if row.mechanism == "explicit" {
            Mechanism::Explicit
        } else {
            Mechanism::Implicit
        },
        min_tokens: row.min_tokens,
        max_breakpoints: row.max_breakpoints,
        lookback_positions: row.lookback_positions,
        ttls: row.ttls.iter().map(|t| t.ttl.clone()).collect(),
        warm_ms: row.warm_ms,
        known: true,
    }
}

/// ADR-010 R7/Q1: with the 1-hour TTL a write costs 2.0x instead of 1.25x, so it pays once the window is read this often.
const MIN_PROJECTED_READS_FOR_LONG_TTL: f64 = 3.0;

/// `chooseCacheTtl`: the 1-hour TTL once at least three reads are projected inside it, for models that offer it;
/// otherwise the shortest TTL the model supports. `never` pins the short TTL. An unknown model gets `5m`.
pub fn choose_cache_ttl(
    model: &str,
    projected_reads: f64,
    never: bool,
    route: Option<&CacheRoute>,
) -> String {
    let p = lookup_cache_profile(model, route);
    let short = if p.ttls.iter().any(|t| t == "5m") {
        "5m".to_owned()
    } else {
        p.ttls.first().cloned().unwrap_or_else(|| "5m".to_owned())
    };
    if never || !p.ttls.iter().any(|t| t == "1h") {
        return short;
    }
    if projected_reads.is_finite() && projected_reads >= MIN_PROJECTED_READS_FOR_LONG_TTL {
        "1h".to_owned()
    } else {
        short
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_table_loads() {
        assert!(table().is_some());
        assert!(unknown().min_tokens < u64::MAX);
    }
}
