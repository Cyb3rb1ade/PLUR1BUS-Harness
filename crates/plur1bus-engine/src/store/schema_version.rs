//! The Node store schema marker, without implicit migrations.

use std::fs;
use std::path::Path;

use crate::contract::StoreError;
use crate::text::js::JsString;
use crate::text::json::{parse_json, TolerantJsonValue};

use super::atomic_write::atomic_write;
use super::paths::{assert_trusted_path, secure_dir};

/// Persisted schema generations understood by the Phase 1 store.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreSchemaVersion {
    /// A store without a marker.
    Legacy0,
    /// The current 69-column schema.
    V1,
}

/// Read a physical agent store's marker, accepting a colocated composite-fixture marker first.
///
/// The pinned engine's ordinary marker belongs to `baseDbPath`, one level above its agent
/// directory. A missing marker is legacy; an unreadable or unsupported marker is an error.
pub fn read(path: &Path) -> Result<StoreSchemaVersion, StoreError> {
    assert_trusted_path(path)?;
    match read_marker(&path.join("_schema.json"))? {
        Some(version) => Ok(version),
        None => read_base(path.parent().unwrap_or(path)),
    }
}

/// Read exactly the marker owned by a configured Node `baseDbPath`.
pub fn read_base(base: &Path) -> Result<StoreSchemaVersion, StoreError> {
    Ok(read_marker(&base.join("_schema.json"))?.unwrap_or(StoreSchemaVersion::Legacy0))
}

/// Initialize only a missing or empty base, as the pinned engine does before opening any table.
///
/// Existing nonempty bases stay legacy and existing markers are left byte-identical. The
/// caller supplies its clock's ISO timestamp and engine version. This is initialization, not
/// a migration: call it before creating an agent directory inside a new base.
pub fn initialize_base(
    base: &Path,
    written_at: &str,
    engine_version: &str,
) -> Result<StoreSchemaVersion, StoreError> {
    assert_trusted_path(base)?;
    let fresh = match fs::read_dir(base) {
        Ok(entries) => {
            let mut fresh = true;
            for entry in entries {
                let name = entry.map_err(io_error)?.file_name();
                if !name.to_str().is_some_and(is_marker_temporary) {
                    fresh = false;
                    break;
                }
            }
            fresh
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => return Err(io_error(error)),
    };
    if !fresh {
        return read_base(base);
    }
    secure_dir(base)?;
    let timestamp = serde_json::to_string(written_at).map_err(|_| StoreError::Corrupt)?;
    let version = serde_json::to_string(engine_version).map_err(|_| StoreError::Corrupt)?;
    let text = format!(
        "{{\n  \"schemaVersion\": \"1\",\n  \"writtenAt\": {timestamp},\n  \"engineVersion\": {version}\n}}\n"
    );
    atomic_write(&base.join("_schema.json"), text.as_bytes()).map_err(io_error)?;
    Ok(StoreSchemaVersion::V1)
}

fn read_marker(path: &Path) -> Result<Option<StoreSchemaVersion>, StoreError> {
    assert_trusted_path(path)?;
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
            return Err(StoreError::Corrupt)
        }
        Err(error) => return Err(io_error(error)),
    };
    let TolerantJsonValue::Object(fields) = parse_json(&text).map_err(|_| StoreError::Corrupt)?
    else {
        return Err(StoreError::Corrupt);
    };
    let key = JsString::from_utf8_str("schemaVersion");
    let value = fields
        .into_iter()
        .rev()
        .find(|(name, _)| *name == key)
        .map(|(_, value)| value);
    match value {
        Some(TolerantJsonValue::String(value)) if value == JsString::from_utf8_str("0") => {
            Ok(Some(StoreSchemaVersion::Legacy0))
        }
        Some(TolerantJsonValue::String(value)) if value == JsString::from_utf8_str("1") => {
            Ok(Some(StoreSchemaVersion::V1))
        }
        _ => Err(StoreError::Corrupt),
    }
}

fn is_marker_temporary(name: &str) -> bool {
    let Some(suffix) = name
        .strip_prefix("_schema.json.")
        .or_else(|| name.strip_prefix("._schema.json."))
    else {
        return false;
    };
    let mut pieces = suffix.split('.');
    let Some(pid) = pieces.next() else {
        return false;
    };
    let Some(nonce) = pieces.next() else {
        return false;
    };
    !pid.is_empty()
        && pid.bytes().all(|byte| byte.is_ascii_digit())
        && nonce.len() == 12
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && pieces.next() == Some("tmp")
        && pieces.next().is_none()
}

fn io_error(error: std::io::Error) -> StoreError {
    StoreError::Io { kind: error.kind() }
}
