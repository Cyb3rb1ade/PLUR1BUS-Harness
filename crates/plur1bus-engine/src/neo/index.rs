//! Read the actual canonical candidate index. Complete LF lines only; no cache or state writes.
use super::{
    merged::{optional, MetadataReader, Window},
    merged_order::{field, record_id, time, truthy, Sourced},
    vectors::ordinary,
};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue as Json},
    },
};
use std::{collections::HashMap, io::Read};
const MAX_BYTES: usize = 64 * 1024 * 1024;
pub(super) const MAX_IDS: usize = 50_000;
pub(super) fn read(
    reader: &MetadataReader,
    cancel: &Cancel,
) -> Result<Option<Window>, EngineError> {
    cancel.check()?;
    let Some(workspaces) = optional(reader.root.open_child("workspaces"))? else {
        return Ok(None);
    };
    let Some(dir) = optional(workspaces.open_child(&reader.layout.canonical))? else {
        return Ok(None);
    };
    let Some(mut file) = optional(dir.open_file("candidate-index.jsonl"))? else {
        return Ok(None);
    };
    let before = ordinary(&file)?;
    if before.len() > MAX_BYTES as u64 {
        return Err(StoreError::InvalidInput.into());
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(StoreError::from)?;
    if bytes.len() > MAX_BYTES {
        return Err(StoreError::InvalidInput.into());
    }
    let after = file.metadata().map_err(StoreError::from)?;
    if before.len() != after.len()
        || before.modified().map_err(StoreError::from)?
            != after.modified().map_err(StoreError::from)?
    {
        return Err(StoreError::Busy.into());
    }
    let end = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    let text = String::from_utf8_lossy(&bytes[..end]);
    let mut rows: Vec<Sourced> = Vec::new();
    let mut slots: HashMap<JsString, usize> = HashMap::new();
    for line in text.split('\n').filter(|s| !s.is_empty()) {
        cancel.check()?;
        let Ok(mut row) = parse_json(line) else {
            continue;
        };
        if field(&row, "__parseError").is_some_and(truthy) {
            continue;
        }
        let Some(id) = record_id(&row) else {
            continue;
        };
        // A candidate index is vector-free. Node's global path always overwrites any
        // accidental inline field with the indexed sidecar value for returned hits.
        if let Json::Object(fields) = &mut row {
            fields.retain(|(k, _)| k != &JsString::from("embedding"));
        }
        if let Some(&slot) = slots.get(&id) {
            if time(&row, true) >= time(&rows[slot].metadata, true) {
                rows[slot].metadata = row;
            }
        } else {
            if rows.len() == MAX_IDS {
                return Err(StoreError::InvalidInput.into());
            }
            slots.insert(id, rows.len());
            rows.push(Sourced {
                metadata: row,
                legacy: false,
            });
        }
    }
    dir.assert_unchanged()?;
    workspaces.assert_unchanged()?;
    reader.root.assert_unchanged()?;
    Ok(Some(Window {
        rows,
        canonical: Some(dir),
        legacy: None,
    }))
}
