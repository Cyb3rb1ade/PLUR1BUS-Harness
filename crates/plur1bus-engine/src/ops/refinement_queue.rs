//! Stage a pending, exact-owner importance candidate before the conditional Lance write.
use super::conflict_file as io;
use crate::{
    capture::knowledge_pending,
    context::RequestContext,
    contract::{Cancel, EngineError, HostServices, MemoryRow, StoreError},
    store::{directory::TrustedDirectory, lock::Lock},
    text::json::parse_json,
};
use serde_json::{json, Value};
use std::{collections::HashMap, time::Duration};

const QUEUE: &str = "knowledge-pending.json";
const MAX_QUEUE: usize = 2 * 1024 * 1024;

pub(crate) fn stage(
    host: &dyn HostServices,
    request: &RequestContext,
    row: &MemoryRow,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    check()?;
    let workspace = host
        .workspace_dir(&request.agent_id)?
        .ok_or(StoreError::InvalidInput)?;
    let dir = TrustedDirectory::open(&workspace)?.create_child(".adaptive-learning")?;
    let lock = Lock::try_acquire(
        &dir.path().join("knowledge-pending.lock"),
        Duration::from_secs(60),
        None,
    )?
    .ok_or(StoreError::Busy)?;
    let guarded = || {
        check()?;
        dir.assert_unchanged()?;
        if !lock.is_owned()
            || host.workspace_dir(&request.agent_id)?.as_deref() != Some(workspace.as_path())
        {
            return Err(StoreError::Unavailable.into());
        }
        Ok(())
    };
    guarded()?;
    let before = io::read(&dir, QUEUE, MAX_QUEUE, cancel)?;
    let bytes = before.as_deref().unwrap_or(b"{}");
    let raw = std::str::from_utf8(bytes).map_err(|_| StoreError::Corrupt)?;
    let current: Value = serde_json::from_str(raw).map_err(|_| StoreError::Corrupt)?;
    let raw = parse_json(raw).map_err(|_| StoreError::Corrupt)?;
    let now = host.now_ms();
    let key = format!("{}:{}", request.agent_id.as_str(), row.id);
    let existing = current["pending"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if existing.iter().any(|value| {
        value["key"] == key
            && value["reason"] == "importance-refinement"
            && value["sourceAgent"] == request.agent_id.as_str()
            && value["memoryId"] == row.id
    }) {
        guarded()?;
        return Ok(());
    }
    let input = json!({
        "sourceAgent":request.agent_id,"memoryId":row.id,"reason":"importance-refinement",
        "category":row.category,"importance":row.importance,
    });
    let input = parse_json(&input.to_string()).map_err(|_| StoreError::Corrupt)?;
    let change = knowledge_pending::track(&raw, &input, now, cancel)?.ok_or(StoreError::Corrupt)?;
    let encoded = knowledge_pending::encode(&change.state, cancel)?;
    let mut after: Value = serde_json::from_str(&encoded).map_err(|_| StoreError::Corrupt)?;
    let rows = after["pending"].as_array().ok_or(StoreError::Corrupt)?;
    let next: HashMap<_, _> = rows
        .iter()
        .filter_map(|row| row["key"].as_str().map(|key| (key, row)))
        .collect();
    // Queue normalization does not authorize dropping or rewriting another
    // source's work, including ambiguous legacy entries.
    if current.get("pendingMemoryIds").is_some()
        || existing.iter().any(|entry| {
            entry["key"]
                .as_str()
                .is_none_or(|old| old != key && next.get(old).is_none_or(|v| !same_entry(entry, v)))
        })
        || !next.contains_key(key.as_str())
    {
        return Err(StoreError::Unavailable.into());
    }
    let root = after.as_object_mut().ok_or(StoreError::Corrupt)?;
    for (field, value) in current.as_object().ok_or(StoreError::Corrupt)? {
        root.entry(field).or_insert_with(|| value.clone());
    }
    let encoded = serde_json::to_vec_pretty(&after).map_err(|_| StoreError::Corrupt)?;
    io::replace(&dir, QUEUE, before.as_deref(), &encoded, cancel, &guarded)
}

fn same_entry(before: &Value, after: &Value) -> bool {
    let (Some(before), Some(after)) = (before.as_object(), after.as_object()) else {
        return false;
    };
    before.len() == after.len()
        && before.iter().all(|(key, value)| {
            after.get(key).is_some_and(|next| {
                value == next
                    || (key == "importance"
                        && value.is_number()
                        && next.is_number()
                        && value.as_f64() == next.as_f64())
            })
        })
}
