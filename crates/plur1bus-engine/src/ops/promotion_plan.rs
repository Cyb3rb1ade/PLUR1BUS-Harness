//! Deterministic A1 proposal only: callers retain current source authority and atomic publication.
use super::{context::error, memory::valid_id};
use crate::{
    capture::knowledge_pending,
    contract::{
        Cancel, EngineError, MemoryOpErrorCode, MemoryPromotionResult, MemoryRow, StoreError,
    },
    recall::{
        acl::{self, AclMemory, AclSubject},
        lifecycle::is_recall_entry_live,
    },
    text::{
        js::JsString,
        json::{write_json, TolerantJsonValue as Json},
    },
};
use chrono::{Datelike, TimeZone, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
const MAX_TEXT: usize = 64 * 1024 * 1024;
/// Caller-bound source snapshot supplied by the eventual publication adapter.
/// This value alone grants no file or source mutation authority.
pub struct PromotionInput<'a> {
    /// Canonical authenticated ownership context.
    pub context: &'a AclSubject,
    /// Effective engine configuration, including schicht15 policy.
    pub config: &'a Value,
    /// Explicit host IDs, or this agent's normalized pending queue selection.
    pub ids: Option<&'a [String]>,
    /// Current queue snapshot, including other agents' entries.
    pub pending: &'a Json,
    /// Exact existing UTF-8 Markdown; absence uses the reference header.
    pub content: Option<&'a str>,
    /// Captured host time for this proposed publication.
    pub now: i64,
    /// Result of acquiring the actual publisher lock; never inferred from file existence.
    pub lock_busy: bool,
}
/// Proposed atomic document and queue writes; neither has been published or acknowledged.
pub struct PromotionPlan {
    /// Reference outcomes, to return only after the adapter commits the corresponding effects.
    pub result: MemoryPromotionResult,
    /// Complete new Markdown if at least one source is newly promoted.
    pub markdown: Option<String>,
    /// Canonical pending state after cleanup; absent for disabled/busy calls.
    pub queue: Option<String>,
    /// Exact source rows inspected, for the adapter's current-row CAS before publication.
    pub sources: Vec<MemoryRow>,
}
fn invalid() -> EngineError {
    error(MemoryOpErrorCode::InvalidInput)
}
fn result(agent: &str, items: &[Value]) -> Result<MemoryPromotionResult, EngineError> {
    serde_json::from_value(json!({"agentId":agent,"items":items}))
        .map_err(|_| StoreError::Corrupt.into())
}
/// Apply the actual A1 selection, eligibility, marker and evidence rules without filesystem effects.
/// The final open check precedes all returned write intents, as in the actual helper.
pub fn plan<F, C>(
    input: &PromotionInput<'_>,
    cancel: &Cancel,
    mut read: F,
    mut assert_open: C,
) -> Result<PromotionPlan, EngineError>
where
    F: FnMut(&str) -> Result<Option<MemoryRow>, EngineError>,
    C: FnMut() -> Result<(), EngineError>,
{
    cancel.check()?;
    let agent = &input.context.agent_id;
    if agent.is_empty()
        || agent.len() > 64
        || !agent
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(invalid());
    }
    if input.content.is_some_and(|s| s.len() > MAX_TEXT) {
        return Err(StoreError::Unavailable.into());
    }
    let normalized = knowledge_pending::normalize(input.pending, input.now, cancel)?;
    let normalized: Value =
        serde_json::from_str(&write_json(&normalized)).map_err(|_| StoreError::Corrupt)?;
    let pending = normalized["pending"]
        .as_array()
        .ok_or(StoreError::Corrupt)?
        .iter()
        .filter(|v| v["sourceAgent"] == agent.as_str())
        .collect::<Vec<_>>();
    let implicit = pending
        .iter()
        .map(|v| {
            v["memoryId"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(invalid)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let requested = input.ids.unwrap_or(&implicit);
    // Bound pre-dedupe work separately; A1's public 500 limit applies after deduplication.
    if requested.len() > 50_000 {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    let mut selected = Vec::new();
    for id in requested {
        cancel.check()?;
        if !valid_id(id) {
            return Err(invalid());
        }
        if seen.insert(id) {
            selected.push(id);
        }
    }
    let cfg = &input.config["schicht15"];
    let cap = if cfg["maxPromotionsPerRun"].is_null() {
        0.
    } else {
        cfg["maxPromotionsPerRun"].as_f64().ok_or_else(invalid)?
    };
    if !cap.is_finite()
        || !(0. ..=9_007_199_254_740_991.).contains(&cap)
        || cap.fract() != 0.
        || input.ids.is_some() && selected.len() > 500
    {
        return Err(invalid());
    }
    let skip = if cfg["enabled"] == false {
        Some("disabled")
    } else if input.lock_busy {
        Some("lock-busy")
    } else {
        None
    };
    if let Some(reason) = skip {
        return Ok(PromotionPlan {
            result: result(
                agent,
                &selected
                    .iter()
                    .map(|id| json!({"id":id,"outcome":"skipped","reason":reason}))
                    .collect::<Vec<_>>(),
            )?,
            markdown: None,
            queue: None,
            sources: Vec::new(),
        });
    }
    let minimum = if cfg["minImportance"].is_null() {
        0.7
    } else {
        cfg["minImportance"]
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or_else(invalid)?
    };
    let time = Utc
        .timestamp_millis_opt(input.now)
        .single()
        .filter(|t| (0..=9999).contains(&t.year()))
        .ok_or_else(invalid)?;
    let date = time.format("%Y-%m-%d").to_string();
    let mut content = input.content.unwrap_or("# Knowledge\n").to_owned();
    let mut promoted = 0usize;
    let mut items = Vec::new();
    let mut removals = Vec::new();
    let mut sources = Vec::new();
    for id in selected {
        cancel.check()?;
        let row = read(id)?;
        let mut reason = match row.as_ref() {
            None => Some("not-found"),
            Some(row)
                if acl::check_access(Some(input.context), AclMemory::from_row(row).as_ref())
                    .is_err() =>
            {
                Some("not-found")
            }
            Some(row) if !is_recall_entry_live(row, input.now, None) => Some("not-live"),
            Some(row) if !row.scope.is_empty() && row.scope != "agent-private" => {
                Some("scope-not-publishable")
            }
            Some(row) if !row.agent_id.is_empty() && row.agent_id != *agent => Some("not-found"),
            Some(row)
                if matches!(
                    row.importance_status.as_str(),
                    "pending" | "pending_backfill"
                ) =>
            {
                Some("importance-pending")
            }
            Some(row)
                if pending.iter().any(|p| {
                    p["memoryId"] == id.as_str() && p["reason"] == "importance-refinement"
                }) && row.importance.as_f64().is_none_or(|v| v < minimum) =>
            {
                Some("importance-below-threshold")
            }
            _ => None,
        };
        if let Some(row) = row.as_ref() {
            if row.text.len() > MAX_TEXT {
                return Err(StoreError::Unavailable.into());
            }
            let mut hash = Sha256::new();
            hash.update(agent.as_bytes());
            hash.update([0]);
            hash.update(id.as_bytes());
            hash.update([0]);
            hash.update(row.text.as_bytes());
            let marker = format!("<!-- plur1bus-promotion:{:x} -->", hash.finalize());
            if reason.is_none() && content.contains(&marker) {
                reason = Some("already-promoted");
            }
            if reason.is_none() && cap > 0. && promoted as f64 >= cap {
                reason = Some("cap-reached");
            }
            if reason.is_none() {
                let evidence = row
                    .text
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
                    .split('\n')
                    .map(|line| format!("> {line}"))
                    .collect::<Vec<_>>()
                    .join("\n");
                let addition = format!("\n{marker}\n## {date} · {id}\n\n{evidence}\n");
                if content.len().saturating_add(addition.len()) > MAX_TEXT {
                    return Err(StoreError::Unavailable.into());
                }
                content.push_str(&addition);
                promoted += 1;
            }
        }
        items.push(json!({"id":id,"outcome":if reason.is_none(){"promoted"}else{"skipped"},"reason":reason.unwrap_or("integrated")}));
        if reason.is_none()
            || matches!(
                reason,
                Some("already-promoted" | "not-found" | "not-live" | "importance-below-threshold")
            )
        {
            for item in pending.iter().filter(|p| p["memoryId"] == id.as_str()) {
                removals.push(JsString::from(
                    item["key"].as_str().ok_or(StoreError::Corrupt)?,
                ));
            }
        }
        if let Some(row) = row {
            sources.push(row);
        }
    }
    cancel.check()?;
    assert_open()?;
    let queue = knowledge_pending::remove(input.pending, &removals, &[], input.now, cancel)?;
    Ok(PromotionPlan {
        result: result(agent, &items)?,
        markdown: (promoted > 0).then_some(content),
        queue: Some(knowledge_pending::encode(&queue, cancel)?),
        sources,
    })
}
