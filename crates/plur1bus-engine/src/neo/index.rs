//! Read actual complete LF index lines with a content-validated, bounded parse cache.
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
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io::Read, sync::TryLockError};
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
    let mut chunk = [0u8; 64 * 1024];
    loop {
        cancel.check()?;
        let count = file.read(&mut chunk).map_err(StoreError::from)?;
        if count == 0 {
            break;
        }
        if bytes.len() + count > MAX_BYTES {
            return Err(StoreError::InvalidInput.into());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    let after = file.metadata().map_err(StoreError::from)?;
    if before.len() != after.len()
        || before.modified().map_err(StoreError::from)?
            != after.modified().map_err(StoreError::from)?
    {
        return Err(StoreError::Busy.into());
    }
    let end = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    // A filesystem timestamp is not proof that an old prefix is still present.
    // Full bounded bytes are read each time; only unchanged-prefix JSON parsing is skipped.
    let mut cache = reader.index_cache.try_lock().map_err(|error| match error {
        TryLockError::WouldBlock => StoreError::Busy,
        TryLockError::Poisoned(_) => StoreError::Corrupt,
    })?;
    cache.update(&bytes[..end], cancel)?;
    let mut rows = Vec::with_capacity(cache.rows.len());
    for row in &cache.rows {
        cancel.check()?;
        rows.push(row.clone());
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

/// One reader/workspace, not a global path cache. No authorization decisions or vectors
/// are cached; search rechecks the actual caller and reads current sidecars every time.
#[derive(Default)]
pub(super) struct Cache {
    consumed: usize,
    digest: [u8; 32],
    rows: Vec<Sourced>,
    slots: HashMap<JsString, usize>,
}
impl Cache {
    /// Errors invalidate the whole state, including revisions applied before a cancellation.
    fn update(&mut self, bytes: &[u8], cancel: &Cancel) -> Result<usize, EngineError> {
        let result = self.update_inner(bytes, cancel);
        if result.is_err() {
            *self = Self::default();
        }
        result
    }
    fn update_inner(&mut self, bytes: &[u8], cancel: &Cancel) -> Result<usize, EngineError> {
        cancel.check()?;
        if bytes.len() > MAX_BYTES {
            return Err(StoreError::InvalidInput.into());
        }
        let end = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        if self.consumed > end || digest(&bytes[..self.consumed], cancel)? != self.digest {
            *self = Self::default();
        }
        let text = String::from_utf8_lossy(&bytes[self.consumed..end]);
        let mut parsed = 0;
        for line in text.split('\n').filter(|s| !s.is_empty()) {
            cancel.check()?;
            parsed += 1;
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
            if let Some(&slot) = self.slots.get(&id) {
                if time(&row, true) >= time(&self.rows[slot].metadata, true) {
                    self.rows[slot].metadata = row;
                }
            } else {
                if self.rows.len() == MAX_IDS {
                    return Err(StoreError::InvalidInput.into());
                }
                self.slots.insert(id, self.rows.len());
                self.rows.push(Sourced {
                    metadata: row,
                    legacy: false,
                });
            }
        }
        cancel.check()?;
        self.digest = digest(&bytes[..end], cancel)?;
        self.consumed = end;
        Ok(parsed)
    }
}
fn digest(bytes: &[u8], cancel: &Cancel) -> Result<[u8; 32], EngineError> {
    let mut hash = Sha256::new();
    for chunk in bytes.chunks(64 * 1024) {
        cancel.check()?;
        hash.update(chunk);
    }
    cancel.check()?;
    Ok(hash.finalize().into())
}

#[cfg(test)]
#[path = "index_cache_tests.rs"]
mod tests;
