//! `session/maintenance.ts`, `sessionMaintenance(home, config)`: the maintenance block of the composition, as plain values.
//! The compaction bounds come from `session.compaction` of the configuration over a window of 8192 tokens (the fallback the
//! compactor uses until a model names its window); the prune settings pass through. The read-only model catalogue
//! (`readOnlyCatalog(<home>/catalog/models.json)`) is the [`super::tokens::ReadCatalog`] port: the file read, its stamp cache
//! and `validateCatalog` belong to discovery and are not ported here.
//!
//! Not ported: `sessionRoleFactory`, the wiring of the decision client, the role backend and the coding profile around the
//! router (the router and async plumbing; its decisions are in [`super::role_routing`]).
use super::compaction::{CompactionConfig, SummarizerMode};
use super::pruning::{Decider, PruneConfig};
use serde_json::Value;

/// The fallback window of the compactor.
pub const FALLBACK_WINDOW_TOKENS: i64 = 8192;

/// What `sessionMaintenance` returns, less the catalogue port.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionMaintenance {
    /// The compaction configuration.
    pub compaction: CompactionConfig,
    /// The prune configuration.
    pub prune: PruneConfig,
}

fn num(v: &Value, key: &str) -> Result<f64, String> {
    v.get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("session.compaction.{key} is not a number"))
}

/// `sessionMaintenance(home, config)` over a configuration value that `config-schema` has already validated: a member that is
/// missing or of the wrong type is an error here, where TypeScript would carry `undefined` along.
pub fn session_maintenance(config: &Value) -> Result<SessionMaintenance, String> {
    let c = config
        .pointer("/session/compaction")
        .ok_or("session.compaction is missing")?;
    let summarizer = match c.get("summarizer").and_then(Value::as_str) {
        Some("llm") => Some(SummarizerMode::Llm),
        Some("digest") => Some(SummarizerMode::Digest),
        _ => return Err("session.compaction.summarizer is not llm or digest".to_owned()),
    };
    let p = c
        .get("prune")
        .ok_or("session.compaction.prune is missing")?;
    let decider = match p.get("decider").and_then(Value::as_str) {
        Some("laya") => Decider::Laya,
        Some("heuristic") => Decider::Heuristic,
        Some("off") => Decider::Off,
        _ => return Err("session.compaction.prune.decider is unknown".to_owned()),
    };
    Ok(SessionMaintenance {
        compaction: CompactionConfig {
            window_tokens: FALLBACK_WINDOW_TOKENS,
            summarizer,
            soft_ratio: num(c, "softRatio")?,
            hard_ratio: num(c, "hardRatio")?,
            summary_max_tokens: num(c, "summaryMaxTokens")? as i64,
            max_message_tokens: num(c, "maxMessageTokens")? as i64,
        },
        prune: PruneConfig {
            enabled: p
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or("session.compaction.prune.enabled is not a boolean")?,
            keep_last_turns: num(p, "keepLastTurns")? as i64,
            decider,
            max_ms: num(p, "maxMs")?,
            batch_size: num(p, "batchSize")? as i64,
        },
    })
}
