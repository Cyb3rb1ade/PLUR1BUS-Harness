//! Reapply committed deletion history after restore, then verify that no addressed row
//! remains recallable. This internal maintenance path does not invent a user principal.
use super::tombstones::TombstoneLookup;
use crate::{
    contract::{Cancel, EngineError, StoreError, VectorSpaceIdentity},
    store::{
        paths::assert_trusted_path, row::RowPatch, tombstone::TombstoneRegistry, OpenMode,
        StorePool,
    },
    text::json::TolerantJsonValue,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{fs, path::Path};

/// Result of an idempotent soft deletion of one existing row.
pub enum ReapplyMutation {
    /// Row changed to deleted/invalidated.
    Applied,
    /// Row was already deleted; no update was issued.
    AlreadyTombstoned,
    /// The table exists, but the row does not.
    NotFound,
}

/// Explicit maintenance-only target; no ACL filtering may hide restored rows from verification.
pub trait ReapplyTarget: TombstoneLookup {
    /// Set status=deleted and epistemicStatus=invalidated without changing text/vector/timestamps.
    fn tombstone(&self, agent: &str, memory_id: &str) -> Result<ReapplyMutation, StoreError>;
    /// Whether this target may still write. When false, `reapply` reads the registry without
    /// repairing a torn tail (a write); a torn tail then counts as corrupt (fail closed).
    fn writable(&self) -> bool {
        true
    }
}

/// Existing physical generation. Registry location is supplied separately to `reapply`:
/// switching an embedding generation must never switch or replace deletion history.
pub struct GenerationReapplyTarget {
    pool: StorePool,
}

impl GenerationReapplyTarget {
    /// Configure a bounded, non-creating pool; readonly mode supports dry-run verification.
    pub fn open(
        root: &Path,
        identity: &VectorSpaceIdentity,
        mode: OpenMode,
    ) -> Result<Self, StoreError> {
        Ok(Self {
            pool: StorePool::open(root, mode, Some(identity), 8)?,
        })
    }
}

impl TombstoneLookup for GenerationReapplyTarget {
    fn agent_exists(&self, agent: &str) -> Result<bool, StoreError> {
        let path = self.pool.agent_path(agent)?;
        assert_trusted_path(&path)?;
        match fs::symlink_metadata(path) {
            Ok(m) if m.is_dir() => Ok(true),
            Ok(_) => Err(StoreError::Corrupt),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }
    fn status(&self, agent: &str, memory_id: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .pool
            .get_existing(agent)?
            .get(memory_id)?
            .map(|r| r.status))
    }
}

impl ReapplyTarget for GenerationReapplyTarget {
    fn tombstone(&self, agent: &str, memory_id: &str) -> Result<ReapplyMutation, StoreError> {
        let store = self.pool.get_existing(agent)?;
        let Some(row) = store.get(memory_id)? else {
            return Ok(ReapplyMutation::NotFound);
        };
        if row.status == "deleted" {
            return Ok(ReapplyMutation::AlreadyTombstoned);
        }
        store.patch(
            memory_id,
            &RowPatch {
                status: Some("deleted".into()),
                epistemic_status: Some("invalidated".into()),
                ..RowPatch::default()
            },
        )?;
        Ok(ReapplyMutation::Applied)
    }
}

/// RE-D170: the process's own namespace routes, so reapply hits the active generation of every
/// agent (namespace mode, a re-embedding switch). Each row patch takes the engine-wide mutation
/// gate, as `forget`'s patch does, for exactly that one write step: same wait budget, same
/// waiter limit. A gate still held answers [`StoreError::Busy`], reported as `"busy"`.
///
/// One target serves one run: after the first `engine-busy` every further id of the run is
/// `busy` at once, without another gate attempt, so a run waits for the gate at most once
/// (one `MUTATION_WAIT`), whatever the size of the registry.
pub struct NamespaceReapplyTarget {
    stores: std::sync::Arc<crate::recall::namespaces::NamespaceStores>,
    gate: std::sync::Arc<super::context::OperationContext>,
    busy: std::sync::atomic::AtomicBool,
    /// Test hook: called with the gate held, just before the row patch.
    #[cfg(test)]
    pub(crate) after_gate: Option<Box<dyn Fn() + Send + Sync>>,
}

impl NamespaceReapplyTarget {
    /// Reuse the process's resolved pools and its operation context; nothing is created.
    pub fn new(
        stores: std::sync::Arc<crate::recall::namespaces::NamespaceStores>,
        gate: std::sync::Arc<super::context::OperationContext>,
    ) -> Self {
        Self {
            stores,
            gate,
            busy: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            after_gate: None,
        }
    }
}

impl TombstoneLookup for NamespaceReapplyTarget {
    fn agent_exists(&self, agent: &str) -> Result<bool, StoreError> {
        // After close no store is opened (`registryErrors`, fail closed).
        self.gate
            .assert_open()
            .map_err(|_| StoreError::Unavailable)?;
        Ok(self.stores.existing_write_store(agent)?.is_some())
    }
    fn status(&self, agent: &str, memory_id: &str) -> Result<Option<String>, StoreError> {
        // After close the verification reads no further row (`"verify: storage"`).
        self.gate
            .assert_open()
            .map_err(|_| StoreError::Unavailable)?;
        let Some(store) = self.stores.existing_write_store(agent)? else {
            return Ok(None);
        };
        Ok(store.get(memory_id)?.map(|row| row.status))
    }
}

impl ReapplyTarget for NamespaceReapplyTarget {
    fn writable(&self) -> bool {
        self.gate.assert_open().is_ok()
    }
    fn tombstone(&self, agent: &str, memory_id: &str) -> Result<ReapplyMutation, StoreError> {
        use std::sync::atomic::Ordering;
        if self.busy.load(Ordering::Acquire) {
            return Err(StoreError::Busy);
        }
        let _gate = self.gate.mutation().map_err(|error| match error {
            EngineError::NotAvailable { reason } if reason == "engine-busy" => {
                self.busy.store(true, Ordering::Release);
                StoreError::Busy
            }
            _ => StoreError::Unavailable,
        })?;
        let Some(store) = self.stores.existing_write_store(agent)? else {
            return Ok(ReapplyMutation::NotFound);
        };
        let Some(row) = store.get(memory_id)? else {
            return Ok(ReapplyMutation::NotFound);
        };
        if row.status == "deleted" {
            return Ok(ReapplyMutation::AlreadyTombstoned);
        }
        // A close that began while this caller waited refuses the write, as for `forget`.
        self.gate
            .assert_open()
            .map_err(|_| StoreError::Unavailable)?;
        #[cfg(test)]
        if let Some(hook) = &self.after_gate {
            hook();
        }
        store.patch(
            memory_id,
            &RowPatch {
                status: Some("deleted".into()),
                epistemic_status: Some("invalidated".into()),
                ..RowPatch::default()
            },
        )?;
        Ok(ReapplyMutation::Applied)
    }
}

/// Node-compatible local maintenance report. Runtime logs should expose counts only.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReapplyReport {
    /// `apply` or `dry-run`.
    pub mode: &'static str,
    /// Changed rows, or proposed changes in a dry run.
    pub applied: Vec<Value>,
    /// Already deleted rows left untouched.
    pub already_tombstoned: Vec<Value>,
    /// Missing rows or missing agent stores.
    pub not_found: Vec<Value>,
    /// Bounded storage failures, never raw backend text or memory contents.
    pub errors: Vec<Value>,
    /// Unreadable/corrupt registries: no mutation for that agent.
    pub registry_errors: Vec<Value>,
    /// Rows still active or legacy-recallable after applying.
    pub active_after_reapply: Vec<Value>,
}

impl ReapplyReport {
    /// Any unverified deletion keeps restore recovery pending.
    pub fn failed(&self) -> bool {
        !self.errors.is_empty()
            || !self.registry_errors.is_empty()
            || !self.active_after_reapply.is_empty()
    }
}

fn string(row: &TolerantJsonValue, key: &str) -> Option<String> {
    let TolerantJsonValue::Object(fields) = row else {
        return None;
    };
    fields
        .iter()
        .rev()
        .find_map(|(k, v)| {
            if k.to_utf8_lossy() != key {
                return None;
            }
            Some(match v {
                TolerantJsonValue::String(s) => Some(s.to_utf8_lossy()),
                _ => None,
            })
        })
        .flatten()
}

/// Repair torn registry tails only when applying, soft-delete every committed ID, and
/// verify all addressed rows independently even after a failed write. Caller must retain
/// the restore marker on error or `report.failed()` and fence other writers during startup.
pub fn reapply(
    base: &Path,
    target: &dyn ReapplyTarget,
    apply: bool,
    cancel: &Cancel,
) -> Result<ReapplyReport, EngineError> {
    cancel.check()?;
    let root = base
        .parent()
        .ok_or(StoreError::InvalidInput)?
        .join("_tombstones");
    assert_trusted_path(&root)?;
    let mut report = ReapplyReport {
        mode: if apply { "apply" } else { "dry-run" },
        applied: vec![],
        already_tombstoned: vec![],
        not_found: vec![],
        errors: vec![],
        registry_errors: vec![],
        active_after_reapply: vec![],
    };
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(report),
        Err(e) => return Err(StoreError::from(e).into()),
    };
    let mut names = entries
        .map(|e| e.map(|e| e.file_name()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(StoreError::from)?;
    names.sort();
    for name in names {
        cancel.check()?;
        let name = name.to_string_lossy();
        let Some(agent) = name.strip_suffix(".jsonl") else {
            continue;
        };
        let registry = match TombstoneRegistry::new(base, agent) {
            Ok(registry) => registry,
            Err(_) => {
                report
                    .registry_errors
                    .push(json!({"agent":agent,"error":"invalid registry filename"}));
                continue;
            }
        };
        // A torn tail is repaired only when applying and the target may still write.
        let rows = match registry.read(apply && target.writable()) {
            Ok(rows) if rows.corrupt_lines == 0 => rows.tombstones,
            Ok(rows) => {
                report.registry_errors.push(json!({"agent":agent,"error":format!("corrupt registry lines: {}", rows.corrupt_lines)}));
                continue;
            }
            Err(_) => {
                report
                    .registry_errors
                    .push(json!({"agent":agent,"error":"storage"}));
                continue;
            }
        };
        let ids: Vec<_> = rows
            .iter()
            .filter(|row| string(row, "status").as_deref() == Some("committed"))
            .filter_map(|row| string(row, "memoryId").filter(|id| !id.is_empty()))
            .collect();
        if ids.is_empty() {
            continue;
        }
        match target.agent_exists(agent) {
            Ok(true) => (),
            Ok(false) => {
                report
                    .not_found
                    .extend(ids.iter().map(|id| json!({"agent":agent,"memoryId":id})));
                continue;
            }
            Err(_) => {
                report
                    .registry_errors
                    .push(json!({"agent":agent,"error":"storage"}));
                continue;
            }
        }
        for id in &ids {
            cancel.check()?;
            let entry = json!({"agent":agent,"memoryId":id});
            if !apply {
                report
                    .applied
                    .push(json!({"agent":agent,"memoryId":id,"dryRun":true}));
                continue;
            }
            match target.tombstone(agent, id) {
                Ok(ReapplyMutation::Applied) => report.applied.push(entry),
                Ok(ReapplyMutation::AlreadyTombstoned) => report.already_tombstoned.push(entry),
                Ok(ReapplyMutation::NotFound) => report.not_found.push(entry),
                // A held mutation gate or store lock: retrying the idempotent run is enough.
                Err(StoreError::Busy) => report
                    .errors
                    .push(json!({"agent":agent,"memoryId":id,"error":"busy"})),
                Err(_) => report
                    .errors
                    .push(json!({"agent":agent,"memoryId":id,"error":"storage"})),
            }
        }
        for id in &ids {
            cancel.check()?;
            match target.status(agent, id) {
                Ok(Some(status)) if status == "active" || status.is_empty() => report
                    .active_after_reapply
                    .push(json!({"agent":agent,"memoryId":id,"status":status})),
                Ok(_) => (),
                Err(_) => report
                    .errors
                    .push(json!({"agent":agent,"memoryId":id,"error":"verify: storage"})),
            }
        }
    }
    cancel.check()?;
    Ok(report)
}

#[cfg(test)]
#[path = "tombstone_reapply_tests.rs"]
mod tests;
