//! S5 startup recovery of interrupted forget transactions.
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::{paths::assert_trusted_path, tombstone::TombstoneRegistry},
    text::{js::JsString, json::TolerantJsonValue},
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::Path,
};

/// Ten-minute grace for a live row whose delete may still be running elsewhere.
pub const ATTEMPTED_GRACE_MS: i64 = 600_000;

/// Raw active-generation lookups. Recovery must not create missing stores or apply read ACLs.
pub trait TombstoneLookup: Send + Sync {
    /// Whether this agent has an existing store in the active generation.
    fn agent_exists(&self, agent: &str) -> Result<bool, StoreError>;
    /// Persisted lifecycle status, including deleted rows; None means absent.
    fn status(&self, agent: &str, memory_id: &str) -> Result<Option<String>, StoreError>;
}

/// Read-only lookup over the explicitly selected active generation. The registry
/// root remains independent so generation changes never move deletion history.
pub struct ActiveGenerationLookup {
    pool: crate::store::StorePool,
}
impl ActiveGenerationLookup {
    /// Open a bounded cache without creating a store, namespace or table.
    pub fn open(
        root: &Path,
        identity: &crate::contract::VectorSpaceIdentity,
    ) -> Result<Self, StoreError> {
        Ok(Self {
            pool: crate::store::StorePool::open(
                root,
                crate::store::OpenMode::ReadOnly,
                Some(identity),
                8,
            )?,
        })
    }
}
impl TombstoneLookup for ActiveGenerationLookup {
    fn agent_exists(&self, agent: &str) -> Result<bool, StoreError> {
        self.pool.check_roots()?;
        let path = self.pool.agent_path(agent)?;
        assert_trusted_path(&path)?;
        let exists = match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_dir() => Ok(true),
            Ok(_) => Err(StoreError::Corrupt),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        };
        self.pool.check_roots()?;
        exists
    }
    fn status(&self, agent: &str, memory_id: &str) -> Result<Option<String>, StoreError> {
        Ok(self.pool.get(agent)?.get(memory_id)?.map(|row| row.status))
    }
}

/// Recovery view over the same configured active writer used by the runtime.
/// Only existing leases and row reads are used; legacy recall tables cannot vote.
pub struct NamespaceGenerationLookup {
    stores: std::sync::Arc<crate::recall::namespaces::NamespaceStores>,
}
impl NamespaceGenerationLookup {
    /// Reuse already resolved pools without discovering or creating any path.
    pub fn new(stores: std::sync::Arc<crate::recall::namespaces::NamespaceStores>) -> Self {
        Self { stores }
    }
}
impl TombstoneLookup for NamespaceGenerationLookup {
    fn agent_exists(&self, agent: &str) -> Result<bool, StoreError> {
        Ok(self.stores.existing_write_store(agent)?.is_some())
    }
    fn status(&self, agent: &str, memory_id: &str) -> Result<Option<String>, StoreError> {
        let Some(store) = self.stores.existing_write_store(agent)? else {
            return Ok(None);
        };
        Ok(store.get(memory_id)?.map(|row| row.status))
    }
}

/// Node-compatible recovery groups; errors contain bounded categories, never backend text.
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    /// Interrupted deletes completed by appending a committed record.
    pub committed: Vec<Value>,
    /// Old attempts whose row survived, appended as failed.
    pub abandoned: Vec<Value>,
    /// Young attempts left untouched.
    pub pending: Vec<Value>,
    /// Missing rows or stores; no guessed transition.
    pub row_missing: Vec<Value>,
    /// Read/append failures; no guessed transition.
    pub errors: Vec<Value>,
    /// Invalid or unreadable registries, left untouched.
    pub registry_errors: Vec<Value>,
}

/// Recover every valid agent registry against the selected generation.
/// Unknown fields and UTF-16 strings survive each append without reserialization through Value.
pub fn reconcile(
    base: &Path,
    lookup: &dyn TombstoneLookup,
    now: i64,
    cancel: &Cancel,
) -> Result<ReconcileReport, EngineError> {
    cancel.check()?;
    let root = base
        .parent()
        .ok_or(StoreError::InvalidInput)?
        .join("_tombstones");
    assert_trusted_path(&root)?;
    let mut report = ReconcileReport::default();
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(report),
        Err(error) => return Err(StoreError::from(error).into()),
    };
    let mut names = entries
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(StoreError::from)?;
    names.sort();
    for name in names {
        cancel.check()?;
        let Some(agent) = name.to_str().and_then(|name| name.strip_suffix(".jsonl")) else {
            continue;
        };
        let registry = match TombstoneRegistry::new(base, agent) {
            Ok(registry) => registry,
            Err(_) => {
                report
                    .registry_errors
                    .push(json!({"error":"invalid registry filename"}));
                continue;
            }
        };
        let rows = match registry.read(true) {
            Ok(rows) if rows.corrupt_lines == 0 => rows.tombstones,
            Ok(rows) => {
                report.registry_errors.push(json!({"agent":agent, "error":format!("corrupt registry lines: {}", rows.corrupt_lines)}));
                continue;
            }
            Err(_) => {
                report
                    .registry_errors
                    .push(json!({"agent":agent,"error":"storage"}));
                continue;
            }
        };
        let mut committed = HashSet::new();
        let mut latest = BTreeMap::new();
        for (order, row) in rows.iter().enumerate() {
            let memory = string(row, "memoryId").unwrap_or_default();
            if string(row, "status").as_deref() == Some("committed") {
                committed.insert(memory.clone());
            }
            let key = property(row, "tombstoneId")
                .filter(|v| !matches!(v, TolerantJsonValue::Null))
                .map(crate::text::json::write_json)
                .unwrap_or_else(|| {
                    format!("{memory}:{}", string(row, "deletedAt").unwrap_or_default())
                });
            // Map.set retains the original insertion position, while replacing the value.
            latest
                .entry(key)
                .and_modify(|(_, value)| *value = row)
                .or_insert((order, row));
        }
        let mut ordered: Vec<_> = latest.into_values().collect();
        ordered.sort_by_key(|(order, _)| *order);
        let open: Vec<_> = ordered
            .into_iter()
            .map(|(_, row)| row)
            .filter(|row| {
                string(row, "status").as_deref() == Some("attempted")
                    && !committed.contains(&string(row, "memoryId").unwrap_or_default())
            })
            .collect();
        if open.is_empty() {
            continue;
        }
        let exists = lookup.agent_exists(agent);
        for row in open {
            cancel.check()?;
            let memory = string(row, "memoryId").unwrap_or_default();
            let mut entry = json!({"agent":agent,"memoryId":memory});
            if let Some(tombstone) = string(row, "tombstoneId") {
                entry["tombstoneId"] = json!(tombstone);
            }
            match exists {
                Ok(false) => {
                    report
                        .row_missing
                        .push(json!({"agent":agent,"memoryId":memory}));
                    continue;
                }
                Err(_) => {
                    entry["error"] = json!("storage");
                    report.errors.push(entry);
                    continue;
                }
                Ok(true) => {}
            }
            let status = match lookup.status(agent, &memory) {
                Ok(None) => {
                    report.row_missing.push(entry);
                    continue;
                }
                Ok(Some(status)) => status,
                Err(_) => {
                    entry["error"] = json!("storage");
                    report.errors.push(entry);
                    continue;
                }
            };
            let deleted = status == "deleted";
            let age = string(row, "deletedAt")
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
                .map(|date| i128::from(now) - i128::from(date.timestamp_millis()));
            if !deleted && age.is_some_and(|age| age < i128::from(ATTEMPTED_GRACE_MS)) {
                report.pending.push(entry);
                continue;
            }
            cancel.check()?;
            let mut next = row.clone();
            set_status(&mut next, if deleted { "committed" } else { "failed" });
            if registry.append(&next).is_err() {
                entry["error"] = json!("storage");
                report.errors.push(entry);
            } else if deleted {
                report.committed.push(entry);
            } else {
                report.abandoned.push(entry);
            }
        }
    }
    Ok(report)
}
fn property<'a>(row: &'a TolerantJsonValue, name: &str) -> Option<&'a TolerantJsonValue> {
    let TolerantJsonValue::Object(fields) = row else {
        return None;
    };
    let key = JsString::from_utf8_str(name);
    fields
        .iter()
        .rev()
        .find(|(name, _)| *name == key)
        .map(|(_, value)| value)
}
fn string(row: &TolerantJsonValue, name: &str) -> Option<String> {
    let TolerantJsonValue::String(text) = property(row, name)? else {
        return None;
    };
    String::from_utf16(text.as_utf16_units()).ok()
}
fn set_status(row: &mut TolerantJsonValue, status: &str) {
    if let TolerantJsonValue::Object(fields) = row {
        let key = JsString::from_utf8_str("status");
        if let Some((_, value)) = fields.iter_mut().rev().find(|(name, _)| *name == key) {
            *value = TolerantJsonValue::String(JsString::from_utf8_str(status));
        }
    }
}
