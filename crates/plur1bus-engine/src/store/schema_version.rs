//! The Node store schema marker, without implicit migrations.
use crate::contract::StoreError;
use std::path::Path;
/// Persisted schema generations understood by the Phase 1 store.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreSchemaVersion {
    /// A store without a marker.
    Legacy0,
    /// The current 69-column schema.
    V1,
}
pub(super) fn read(path: &Path) -> Result<StoreSchemaVersion, StoreError> {
    let text = match std::fs::read_to_string(path.join("_schema.json")) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StoreSchemaVersion::Legacy0)
        }
        Err(error) => return Err(StoreError::Io { kind: error.kind() }),
    };
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| StoreError::Corrupt)?;
    match value["schemaVersion"].as_str() {
        Some("0") => Ok(StoreSchemaVersion::Legacy0),
        Some("1") => Ok(StoreSchemaVersion::V1),
        _ => Err(StoreError::Corrupt),
    }
}
