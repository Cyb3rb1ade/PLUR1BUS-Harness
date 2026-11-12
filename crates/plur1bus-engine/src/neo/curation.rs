//! Pure human curation selection. Callers own store acquisition and durable C4 mutation.
use super::merged_order::{field, string, truthy};
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, MemoryOpError, MemoryOpErrorCode, StoreError},
    text::{
        js::{js_trim, JsString},
        json::{write_json, TolerantJsonValue as Json},
    },
};
use std::collections::HashMap;

fn human(ctx: &RequestContext, cancel: &Cancel) -> Result<(), EngineError> {
    cancel.check()?;
    if ctx.origin_wire() != "user" || ctx.background() {
        return Err(MemoryOpError::new(MemoryOpErrorCode::Denied).into());
    }
    Ok(())
}
fn timestamp(row: &Json) -> Result<f64, EngineError> {
    let value = field(row, "updatedAt")
        .filter(|v| truthy(v))
        .or_else(|| field(row, "createdAt"));
    let Some(value) = value.filter(|v| truthy(v)) else {
        return Ok(0.);
    };
    let time = match value {
        Json::Number(n) => n.parse::<f64>().ok().filter(|n| n.is_finite()),
        Json::String(s) => {
            let raw = s.to_utf8_lossy();
            let date = if raw.len() == 4 && raw.bytes().all(|b| b.is_ascii_digit()) {
                format!("{raw}-01-01")
            } else {
                raw
            };
            chrono::DateTime::parse_from_rfc3339(&date)
                .ok()
                .map(|v| v.timestamp_millis() as f64)
                .or_else(|| {
                    if date.len() != 10 {
                        return None;
                    }
                    let parsed = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").ok()?;
                    if parsed.format("%Y-%m-%d").to_string() != date {
                        return None;
                    }
                    parsed
                        .and_hms_opt(0, 0, 0)
                        .map(|v| v.and_utc().timestamp_millis() as f64)
                })
        }
        _ => None,
    };
    time.ok_or_else(|| StoreError::InvalidInput.into())
}
fn is_text(value: Option<&Json>, expected: &str) -> bool {
    matches!(value, Some(Json::String(v)) if v == &JsString::from(expected))
}
/// Latest rows in first-ID encounter order, followed by D130 and unresolved-status filtering.
///
/// Each stream is capped at 10,000 rows; unsupported legacy dates fail closed. These snapshots
/// confer no write authority. A writer must recheck the exact source under its C4 lock.
pub fn queue(
    candidates: &[Json],
    behavior: &[Json],
    ctx: &RequestContext,
    cancel: &Cancel,
) -> Result<Vec<Json>, EngineError> {
    human(ctx, cancel)?;
    if candidates.len() > 10_000 || behavior.len() > 10_000 {
        return Err(StoreError::InvalidInput.into());
    }
    let mut positions: HashMap<JsString, usize> = HashMap::new();
    let mut latest: Vec<(&Json, f64)> = Vec::new();
    let mut bytes = 0;
    for row in candidates.iter().chain(behavior) {
        crate::capture::interference::bounded(row, cancel, &mut (0, 0))?;
        let size = write_json(row).len();
        bytes += size;
        if size > 1_048_576 || bytes > 64 * 1024 * 1024 {
            return Err(StoreError::InvalidInput.into());
        }
        let Some(Json::String(id)) = field(row, "id") else {
            return Err(StoreError::InvalidInput.into());
        };
        if id.utf16_len() > 200 || js_trim(&id.to_utf8_lossy()).is_empty() {
            return Err(StoreError::InvalidInput.into());
        }
        let time = timestamp(row)?;
        if let Some(&index) = positions.get(id) {
            if time >= latest[index].1 {
                latest[index] = (row, time);
            }
        } else {
            positions.insert(id.clone(), latest.len());
            latest.push((row, time));
        }
    }
    let mut result = Vec::new();
    for (row, _) in latest {
        cancel.check()?;
        if !field(row, "hardDeleted").is_some_and(truthy)
            && !is_text(field(row, "epistemicStatus"), "invalidated")
            && super::acl::visible(row, Some(ctx))
            && ["candidate", "conflict", "stale"]
                .iter()
                .any(|v| is_text(field(row, "status"), v))
        {
            result.push(row.clone());
        }
    }
    Ok(result)
}
/// Node-compatible list projection on the supported input domain, preserving opaque UTF-16.
/// This is internal native data, not a frozen RPC result or a bypass around typed wire validation.
pub fn list(
    candidates: &[Json],
    behavior: &[Json],
    ctx: &RequestContext,
    limit: Option<f64>,
    cancel: &Cancel,
) -> Result<Json, EngineError> {
    human(ctx, cancel)?;
    let limit = limit.unwrap_or(100.);
    if !limit.is_finite() || limit.fract() != 0. || !(1. ..=100.).contains(&limit) {
        return Err(MemoryOpError::new(MemoryOpErrorCode::InvalidInput).into());
    }
    let rows = queue(candidates, behavior, ctx, cancel)?;
    let items = rows
        .iter()
        .take(limit as usize)
        .map(|row| {
            let text = field(row, "statement")
                .filter(|v| truthy(v))
                .or_else(|| field(row, "text").filter(|v| truthy(v)));
            Json::Object(vec![
                ("id".into(), field(row, "id").cloned().unwrap_or(Json::Null)),
                (
                    "status".into(),
                    field(row, "status").cloned().unwrap_or(Json::Null),
                ),
                (
                    "text".into(),
                    Json::String(text.map(string).unwrap_or_default()),
                ),
                (
                    "category".into(),
                    field(row, "category")
                        .filter(|v| truthy(v))
                        .cloned()
                        .unwrap_or(Json::Null),
                ),
            ])
        })
        .collect();
    cancel.check()?;
    Ok(Json::Object(vec![
        ("agentId".into(), Json::String(ctx.agent_id.as_str().into())),
        ("items".into(), Json::Array(items)),
        ("truncated".into(), Json::Bool(rows.len() > limit as usize)),
    ]))
}
