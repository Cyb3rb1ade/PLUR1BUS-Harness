//! Pure pinned queue transitions for string identifiers and finite priorities.
//! No source authority or publication: adapters must authorize every removal, including cap eviction
//! and the pin's loss of legacy null-source entries during re-normalization on write.
use super::{
    dynamics::{number, truthy},
    emotion_json::{get, object, string},
    fact_quality::number_json,
    interference::bounded,
};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    text::{
        js::{locale_compare_utf16, JsString},
        json::TolerantJsonValue as Json,
    },
};
use chrono::{SecondsFormat, TimeZone, Utc};
use std::collections::{HashMap, HashSet};
/// Actual pending queue cap. A pure truncation is never authorization to discard another caller's work.
pub const CAP: usize = 200;
/// One canonical state to publish and the pin's optional overflow log proposal.
pub struct PendingChange {
    /// Complete queue state after the pin's write-time normalization.
    pub state: Json,
    /// Optional overflow event; no file is appended here.
    pub curation: Option<Json>,
}
fn n(value: f64) -> Json {
    Json::Number(number_json(value))
}
fn iso(now: i64) -> Result<JsString, EngineError> {
    if now < 0 {
        return Err(StoreError::InvalidInput.into());
    }
    let time = Utc
        .timestamp_millis_opt(now)
        .single()
        .filter(|v| (0..=9999).contains(&chrono::Datelike::year(v)))
        .ok_or(StoreError::InvalidInput)?;
    Ok(JsString::from(
        time.to_rfc3339_opts(SecondsFormat::Millis, true),
    ))
}
fn text(value: &Json) -> Result<JsString, EngineError> {
    match value {
        Json::String(v) => Ok(v.clone()),
        _ => Err(StoreError::InvalidInput.into()),
    }
}
fn or(value: &Json, fallback: Json) -> Json {
    if truthy(Some(value)) {
        value.clone()
    } else {
        fallback
    }
}
fn priority(value: &Json) -> Result<f64, EngineError> {
    let value = if *value == Json::Null {
        0.5
    } else {
        number(Some(value))
    };
    if !value.is_finite() {
        return Err(StoreError::InvalidInput.into());
    }
    Ok(value)
}
fn key(agent: &JsString, id: &JsString) -> JsString {
    let mut units = agent.as_utf16_units().to_vec();
    units.push(u16::from(b':'));
    units.extend_from_slice(id.as_utf16_units());
    JsString::from_utf16_units(units)
}
struct Item {
    key: JsString,
    importance: f64,
    queued: JsString,
    value: Json,
}
fn item(
    key: JsString,
    source: Json,
    id: JsString,
    queued: JsString,
    reason: JsString,
    category: JsString,
    importance: f64,
) -> Item {
    let value = object([
        ("key", Json::String(key.clone())),
        ("sourceAgent", source),
        ("memoryId", Json::String(id)),
        ("queuedAt", Json::String(queued.clone())),
        ("reason", Json::String(reason)),
        ("category", Json::String(category)),
        ("importance", n(importance)),
    ]);
    Item {
        key,
        importance,
        queued,
        value,
    }
}
/// Normalize a bounded reference state with the actual 200-cap, first-position/last-value key semantics.
/// Unsupported non-string identity fields and nonfinite priorities fail closed rather than being invented.
pub fn normalize(raw: &Json, now_ms: i64, cancel: &Cancel) -> Result<Json, EngineError> {
    bounded(raw, cancel, &mut (0, 0))?;
    let now = iso(now_ms)?;
    let fallback = or(get(raw, "lastStoreAt"), Json::String(now));
    let mut items = Vec::new();
    if let Json::Array(entries) = get(raw, "pending") {
        for entry in entries {
            cancel.check()?;
            let source = get(entry, "sourceAgent");
            let id = get(entry, "memoryId");
            if !truthy(Some(source)) || !truthy(Some(id)) {
                continue;
            }
            let agent = text(source)?;
            let id = text(id)?;
            items.push(item(
                text(&or(get(entry, "key"), Json::String(key(&agent, &id))))?,
                Json::String(agent),
                id,
                text(&or(get(entry, "queuedAt"), fallback.clone()))?,
                text(&or(get(entry, "reason"), string("schicht15-store-pending")))?,
                text(&or(get(entry, "category"), string("fact")))?,
                priority(get(entry, "importance"))?,
            ));
        }
    }
    if let Json::Array(ids) = get(raw, "pendingMemoryIds") {
        for id in ids.iter().filter(|v| truthy(Some(v))) {
            cancel.check()?;
            let id = text(id)?;
            items.push(item(
                id.clone(),
                Json::Null,
                id,
                text(&fallback)?,
                JsString::from("legacy-pending-id"),
                JsString::from("fact"),
                0.5,
            ));
        }
    }
    let mut deduped: Vec<Item> = Vec::new();
    let mut positions = HashMap::new();
    for item in items {
        if let Some(index) = positions.get(&item.key) {
            deduped[*index] = item;
        } else {
            positions.insert(item.key.clone(), deduped.len());
            deduped.push(item);
        }
    }
    deduped.sort_by(|a, b| {
        b.importance
            .partial_cmp(&a.importance)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                locale_compare_utf16(b.queued.as_utf16_units(), a.queued.as_utf16_units())
            })
    });
    let count = deduped.len();
    let state = object([
        ("schema", n(2.)),
        (
            "pending",
            Json::Array(deduped.into_iter().take(CAP).map(|i| i.value).collect()),
        ),
        ("pendingCount", n(count.min(CAP) as f64)),
        ("pendingOverflowCount", n(count.saturating_sub(CAP) as f64)),
        ("lastStoreAt", or(get(raw, "lastStoreAt"), Json::Null)),
        ("lastUpdateAt", or(get(raw, "lastUpdateAt"), Json::Null)),
    ]);
    bounded(&state, cancel, &mut (0, 0))?;
    Ok(state)
}
fn set(state: &mut Json, key: &str, value: Json) -> Result<(), EngineError> {
    let Json::Object(fields) = state else {
        return Err(StoreError::InvalidInput.into());
    };
    fields
        .iter_mut()
        .find(|(k, _)| k == &JsString::from(key))
        .ok_or(StoreError::InvalidInput)?
        .1 = value;
    Ok(())
}
/// Plan actual read-normalize/replace-own-key/write-normalize behavior, including overflow reporting.
/// Missing source/ID is the pin's no-op. No lock, filesystem write or permission grant occurs here.
pub fn track(
    raw: &Json,
    memory: &Json,
    now_ms: i64,
    cancel: &Cancel,
) -> Result<Option<PendingChange>, EngineError> {
    bounded(memory, cancel, &mut (0, 0))?;
    if !truthy(Some(get(memory, "sourceAgent"))) || !truthy(Some(get(memory, "memoryId"))) {
        return Ok(None);
    }
    let now = iso(now_ms)?;
    let agent = text(get(memory, "sourceAgent"))?;
    let id = text(get(memory, "memoryId"))?;
    let key = key(&agent, &id);
    let category = text(&or(get(memory, "category"), string("fact")))?;
    let entry = item(
        key.clone(),
        Json::String(agent.clone()),
        id.clone(),
        now.clone(),
        text(&or(
            get(memory, "reason"),
            string("schicht15-store-pending"),
        ))?,
        category.clone(),
        priority(get(memory, "importance"))?,
    )
    .value;
    let mut state = normalize(raw, now_ms, cancel)?;
    let Json::Array(entries) = get(&state, "pending") else {
        return Err(StoreError::Corrupt.into());
    };
    let mut entries: Vec<_> = entries
        .iter()
        .filter(|v| get(v, "key") != &Json::String(key.clone()))
        .cloned()
        .collect();
    entries.push(entry);
    set(&mut state, "pending", Json::Array(entries))?;
    set(&mut state, "lastStoreAt", Json::String(now.clone()))?;
    let state = normalize(&state, now_ms, cancel)?;
    let overflow = number(Some(get(&state, "pendingOverflowCount")));
    let curation = (overflow > 0.).then(|| {
        object([
            ("event", string("knowledge_pending.overflow")),
            ("timestamp", Json::String(now)),
            ("agentId", Json::String(agent)),
            ("memoryId", Json::String(id)),
            ("text", string("")),
            ("category", Json::String(category)),
            ("origin", string("system")),
            (
                "reason",
                string(&format!(
                    "pending_cap:{CAP}, overflow:{}",
                    number_json(overflow)
                )),
            ),
            ("relatedId", Json::Null),
        ])
    });
    cancel.check()?;
    Ok(Some(PendingChange { state, curation }))
}
/// Plan exact requested-key/legacy-ID removal and the pin's subsequent write-time normalization.
/// Callers must separately authorize all entries that disappear; null-source legacy entries confer no authority.
pub fn remove(
    raw: &Json,
    keys: &[JsString],
    legacy_ids: &[JsString],
    now_ms: i64,
    cancel: &Cancel,
) -> Result<Json, EngineError> {
    cancel.check()?;
    if keys.len().saturating_add(legacy_ids.len()) > 50_000 {
        return Err(StoreError::InvalidInput.into());
    }
    let total = keys
        .iter()
        .chain(legacy_ids)
        .try_fold(0usize, |n, v| n.checked_add(v.as_utf16_units().len()))
        .ok_or(StoreError::InvalidInput)?;
    if total > 1_048_576 {
        return Err(StoreError::InvalidInput.into());
    }
    let now = iso(now_ms)?;
    let mut state = normalize(raw, now_ms, cancel)?;
    let keys: HashSet<_> = keys.iter().collect();
    let legacy: HashSet<_> = legacy_ids.iter().collect();
    let Json::Array(entries) = get(&state, "pending") else {
        return Err(StoreError::Corrupt.into());
    };
    let mut retained = Vec::new();
    for entry in entries {
        cancel.check()?;
        if keys.contains(&text(get(entry, "key"))?)
            || (*get(entry, "sourceAgent") == Json::Null
                && legacy.contains(&text(get(entry, "memoryId"))?))
        {
            continue;
        }
        retained.push(entry.clone());
    }
    set(&mut state, "pending", Json::Array(retained))?;
    set(&mut state, "lastUpdateAt", Json::String(now))?;
    normalize(&state, now_ms, cancel)
}

/// Encode the ordered state as the pin's two-space JSON, with no trailing newline.
/// This only formats a bounded proposal; it does not grant permission to publish it.
pub fn encode(state: &Json, cancel: &Cancel) -> Result<String, EngineError> {
    fn write(
        value: &Json,
        depth: usize,
        out: &mut String,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        cancel.check()?;
        match value {
            Json::Array(values) if !values.is_empty() => {
                out.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth + 1));
                    write(value, depth + 1, out, cancel)?;
                }
                out.push('\n');
                out.push_str(&"  ".repeat(depth));
                out.push(']');
            }
            Json::Object(fields) if !fields.is_empty() => {
                out.push('{');
                for (index, (key, value)) in fields.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth + 1));
                    out.push_str(&crate::text::json::write_json(&Json::String(key.clone())));
                    out.push_str(": ");
                    write(value, depth + 1, out, cancel)?;
                }
                out.push('\n');
                out.push_str(&"  ".repeat(depth));
                out.push('}');
            }
            _ => out.push_str(&crate::text::json::write_json(value)),
        }
        if out.len() > 8 * 1024 * 1024 {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(())
    }
    bounded(state, cancel, &mut (0, 0))?;
    let mut out = String::new();
    write(state, 0, &mut out, cancel)?;
    Ok(out)
}
