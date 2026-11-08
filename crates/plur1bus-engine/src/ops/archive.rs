//! Archive-first persistence with the pinned human-operation card projection.
use super::context::error;
use crate::{
    contract::{EngineError, MemoryOpErrorCode, MemoryRow},
    store::{
        atomic_write::atomic_write,
        ledger::JsonlLedger,
        paths::{assert_trusted_path, secure_dir},
    },
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue},
    },
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub(super) fn iso(now: i64) -> Result<String, EngineError> {
    chrono::DateTime::from_timestamp_millis(now)
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| error(MemoryOpErrorCode::Storage))
}
pub(super) fn archive(
    row: &MemoryRow,
    agent: &str,
    state: &Path,
    now: i64,
) -> Result<PathBuf, EngineError> {
    archive_value(&row.id, agent, state, now, &project(row)?)
}
// Unimport receives the authoritative database row, unlike human card projections.
pub(super) fn raw(
    row: &MemoryRow,
    agent: &str,
    state: &Path,
    now: i64,
) -> Result<PathBuf, EngineError> {
    let raw =
        parse_json(&serde_json::to_string(row).map_err(|_| error(MemoryOpErrorCode::Storage))?)
            .map_err(|_| error(MemoryOpErrorCode::Storage))?;
    archive_value(&row.id, agent, state, now, &raw)
}
/// Recover the full-row archive after an interrupted rollback. Never invent an audit path.
pub(super) fn rollback_record(
    state: &Path,
    agent: &str,
    id: &str,
) -> Result<(PathBuf, MemoryRow), EngineError> {
    let directory = state.join("memory/_archive").join(agent);
    assert_trusted_path(&directory).map_err(|_| error(MemoryOpErrorCode::Storage))?;
    let suffix = format!("-{id}.json");
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(&directory).map_err(|_| error(MemoryOpErrorCode::Storage))? {
        let path = entry.map_err(|_| error(MemoryOpErrorCode::Storage))?.path();
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with(&suffix))
        {
            assert_trusted_path(&path).map_err(|_| error(MemoryOpErrorCode::Storage))?;
            paths.push(path);
        }
    }
    paths.sort();
    let path = paths
        .pop()
        .ok_or_else(|| error(MemoryOpErrorCode::Storage))?;
    let archived: MemoryRow = serde_json::from_slice(
        &std::fs::read(&path).map_err(|_| error(MemoryOpErrorCode::Storage))?,
    )
    .map_err(|_| error(MemoryOpErrorCode::Storage))?;
    if archived.id != id {
        return Err(error(MemoryOpErrorCode::Storage));
    }
    Ok((path, archived))
}
fn archive_value(
    id: &str,
    agent: &str,
    state: &Path,
    now: i64,
    content: &TolerantJsonValue,
) -> Result<PathBuf, EngineError> {
    crate::context::safe_agent_id(agent).map_err(|_| error(MemoryOpErrorCode::Storage))?;
    let directory = state.join("memory/_archive").join(agent);
    secure_dir(&directory).map_err(|_| error(MemoryOpErrorCode::Storage))?;
    let timestamp = iso(now)?.replace([':', '.'], "-");
    let path = directory.join(format!("{timestamp}-{id}.json"));
    assert_trusted_path(&path).map_err(|_| error(MemoryOpErrorCode::Storage))?;
    // Ordinary card JSON is pretty-printed like Node; a lone UTF-16 title remains
    // valid escaped JSON via the existing lossless writer, never replacement text.
    let text = write_json(content);
    let bytes = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| serde_json::to_string_pretty(&v).ok())
        .unwrap_or(text);
    atomic_write(&path, bytes.as_bytes()).map_err(|_| error(MemoryOpErrorCode::Storage))?;
    Ok(path)
}
pub(super) fn audit(workspace: &Path, entry: &Value) -> Result<(), EngineError> {
    JsonlLedger::<Value>::open(&workspace.join(".adaptive-learning/destructive-ops.jsonl"))
        .and_then(|ledger| ledger.append(entry))
        .map_err(|_| error(MemoryOpErrorCode::Storage))
}
fn project(row: &MemoryRow) -> Result<TolerantJsonValue, EngineError> {
    let fallback = |value: &str, default: &str| {
        if value.is_empty() {
            default.to_owned()
        } else {
            value.to_owned()
        }
    };
    let source = match row.origin.as_str() {
        "dm" => "konversation",
        "group" => "gruppe",
        "voice" => "sprachnotiz",
        "note" => "notiz",
        "" => "notiz",
        other => other,
    };
    let created = row.created_at.as_f64().unwrap_or(0.);
    let date = if created == 0. {
        String::new()
    } else {
        iso(created as i64)?.chars().take(10).collect()
    };
    let title = if row.summary.is_empty() {
        &row.text
    } else {
        &row.summary
    }
    .split('\n')
    .next()
    .unwrap_or("");
    let title = JsString::from_utf8_str(if title.is_empty() {
        "(ohne Titel)"
    } else {
        title
    })
    .utf16_slice(0, 80);
    let value = json!({"id":row.id,"title":"","source":source,"date":date,"text":row.text,"summary":row.summary,"createdAt":row.created_at,"origin":fallback(&row.origin,"dm"),"category":fallback(&row.category,"other"),"type":row.type_,"status":row.status,"memoryClass":fallback(&row.memory_class,"standard"),"neverForget":row.never_forget,"importance":row.importance,"coreMemoryScore":row.core_memory_score,"coreMemoryReason":row.core_memory_reason,"scope":fallback(&row.scope,"agent-private"),"ownerUserId":row.owner_user_id,"agentId":row.agent_id,"workspaceId":row.workspace_id,"storedBy":row.stored_by,"workspaceKey":row.workspace_key,"sourceMessageRole":row.source_message_role,"epistemicStatus":row.epistemic_status,"validFrom":row.valid_from,"validUntil":row.valid_until});
    let mut record =
        parse_json(&value.to_string()).map_err(|_| error(MemoryOpErrorCode::Storage))?;
    if let TolerantJsonValue::Object(fields) = &mut record {
        if let Some((_, value)) = fields
            .iter_mut()
            .find(|(key, _)| *key == JsString::from_utf8_str("title"))
        {
            *value = TolerantJsonValue::String(title);
        }
    }
    Ok(record)
}

/// Shared operations archive Node's recall projection, which retains the original's provenance.
pub(super) fn shared(
    record: &crate::store::shared_row::MemoryRecord,
    agent: &str,
    state: &Path,
    now: i64,
) -> Result<PathBuf, EngineError> {
    let row = &record.row;
    let raw = serde_json::to_value(row).map_err(|_| error(MemoryOpErrorCode::Storage))?;
    let keys = [
        "id",
        "text",
        "summary",
        "scope",
        "storedBy",
        "agentId",
        "workspaceKey",
        "workspaceId",
        "ownerUserId",
        "status",
        "origin",
        "category",
        "importance",
        "createdAt",
        "sourceUrl",
        "evidenceQuote",
        "emotionalValence",
        "emotionalIntensity",
        "emotionalDominant",
        "retrievalCount",
        "lastRetrievedAt",
        "memoryStrength",
        "halfLifeDays",
        "lastStrengthenedAt",
        "lastDynamicsAt",
        "memoryClass",
        "neverForget",
        "coreMemoryScore",
        "coreMemoryReason",
        "versionNumber",
        "previousVersion",
        "supersededBy",
        "updateSource",
        "updateEvidence",
        "reconsolidationConfidence",
        "versionCreatedAt",
        "updatedAt",
        "expiresAt",
        "memoryKind",
        "type",
        "confirmed",
        "reminderStatus",
        "reminderKey",
        "remindAt",
        "epistemicStatus",
        "validFrom",
        "validUntil",
    ];
    let mut value = Value::Object(
        keys.into_iter()
            .map(|key| (key.to_owned(), raw[key].clone()))
            .collect(),
    );
    for (key, fallback) in [
        ("scope", "agent-private"),
        ("origin", "dm"),
        ("emotionalDominant", "neutral"),
        ("memoryClass", "standard"),
    ] {
        if value[key].as_str() == Some("") {
            value[key] = json!(fallback);
        }
    }
    for key in [
        "confirmationStatus",
        "reminderTimezone",
        "reminderRecurrence",
    ] {
        value[key] = json!("");
    }
    let sharing = record
        .sharing
        .as_ref()
        .ok_or_else(|| error(MemoryOpErrorCode::Storage))?;
    for (key, text) in [
        ("sourceMemoryId", &sharing.source_memory_id),
        ("sourceAgentId", &sharing.source_agent_id),
        ("shareIdempotencyKey", &sharing.share_idempotency_key),
        ("shareProvenance", &sharing.share_provenance),
    ] {
        value[key] = json!(text);
    }
    let title = project(row)?;
    let mut content =
        parse_json(&value.to_string()).map_err(|_| error(MemoryOpErrorCode::Storage))?;
    if let (TolerantJsonValue::Object(fields), TolerantJsonValue::Object(projected)) =
        (&mut content, title)
    {
        for (key, value) in projected {
            if ["title", "source", "date"]
                .iter()
                .any(|name| key == JsString::from_utf8_str(name))
            {
                fields.push((key, value));
            }
        }
    }
    archive_value(&row.id, agent, state, now, &content)
}
