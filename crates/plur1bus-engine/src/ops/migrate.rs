//! Explicit schema-marker migration. The Node 0→1 step does not rewrite Lance columns.
use crate::{
    contract::{
        Cancel, EngineError, MaintenanceGrant, MaintenanceMethod, MemoryOpErrorCode,
        MigrationResult, SchemaVersion,
    },
    store::{
        atomic_write::atomic_write, ledger::JsonlLedger, lock::JobLock, paths::assert_trusted_path,
    },
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc, time::Duration};

/// Required durable audit sink; failure must prevent a maintenance mutation.
pub trait MaintenanceAudit: Send + Sync {
    /// Persist only this projected method/origin/target envelope, never an operation payload.
    fn append(&self, entry: &Value) -> Result<(), EngineError>;
}
/// File-backed native audit. Construction performs no I/O.
pub struct FileMaintenanceAudit {
    path: PathBuf,
}
impl FileMaintenanceAudit {
    /// Use the engine-owned audit path supplied by the composition root.
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}
impl MaintenanceAudit for FileMaintenanceAudit {
    fn append(&self, entry: &Value) -> Result<(), EngineError> {
        JsonlLedger::<Value>::open(&self.path)
            .and_then(|ledger| ledger.append(entry))
            .map_err(storage)
    }
}
fn storage(_: impl Sized) -> EngineError {
    super::context::error(MemoryOpErrorCode::Storage)
}
fn invalid() -> EngineError {
    super::context::error(MemoryOpErrorCode::InvalidInput)
}
fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}
fn outcome(from: &str, to: &str, applied: bool) -> Result<MigrationResult, EngineError> {
    serde_json::from_value(json!({"from":from,"to":to,"applied":applied})).map_err(storage)
}
/// Marker-only migration service, bound to a real base, clock and durable audit sink.
pub struct SchemaMigrator {
    base: PathBuf,
    engine_version: String,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    audit: Arc<dyn MaintenanceAudit>,
}
impl SchemaMigrator {
    /// Bind dependencies without creating directories or reading the schema.
    pub fn new(
        base: PathBuf,
        engine_version: String,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
        audit: Arc<dyn MaintenanceAudit>,
    ) -> Self {
        Self {
            base,
            engine_version,
            clock,
            audit,
        }
    }
    fn validate(&self, from: &str, to: &str) -> Result<bool, EngineError> {
        if !digits(from) || !digits(to) {
            return Err(invalid());
        }
        let current = super::status::schema_version(&self.base).ok_or_else(|| storage(()))?;
        if from != current {
            return Err(super::context::error(MemoryOpErrorCode::Conflict));
        }
        let a = from.parse::<f64>().map_err(|_| invalid())?;
        let b = to.parse::<f64>().map_err(|_| invalid())?;
        if b < a || b > 1. {
            return Err(invalid());
        }
        if a == b {
            return Ok(false);
        }
        if a != 0. || b != 1. {
            return Err(invalid());
        }
        Ok(true)
    }
    /// Audit an explicit maintenance invocation and apply only the registered 0→1 marker step.
    /// Physical legacy/shared-column migration is separate and is never claimed by this report.
    pub fn migrate(
        &self,
        grant: &MaintenanceGrant,
        from: SchemaVersion,
        to: SchemaVersion,
        cancel: &Cancel,
    ) -> Result<MigrationResult, EngineError> {
        grant.check(cancel)?;
        let from: String = from.into();
        let to: String = to.into();
        let target = if digits(&from) && digits(&to) && from.len() <= 128 && to.len() <= 128 {
            json!({"from":from,"to":to})
        } else {
            json!({"invalid":true})
        };
        self.audit.append(&json!({"kind":"engine-maintenance","method":MaintenanceMethod::Migrate.wire_name(),"actor":"core-maintenance","coreLink":grant.origin(),"target":target,"at":(self.clock)()}))?;
        grant.check(cancel)?;
        if !self.validate(&from, &to)? {
            return outcome(&from, &to, false);
        }
        // The engine owns one base; a nonce lock also fences independent service instances.
        let lock = JobLock::acquire(&self.base, "_schema-migrate", Duration::from_secs(60))
            .map_err(|e| match e {
                crate::store::lock::LockBusy::Store(e) => storage(e),
                _ => super::context::error(MemoryOpErrorCode::LockBusy),
            })?;
        grant.check(cancel)?;
        if !self.validate(&from, &to)? {
            return outcome(&from, &to, false);
        }
        if !lock.is_owned() {
            return Err(super::context::error(MemoryOpErrorCode::LockLost));
        }
        let path = self.base.join("_schema.json");
        assert_trusted_path(&path).map_err(storage)?;
        let timestamp = DateTime::<Utc>::from_timestamp_millis((self.clock)())
            .ok_or_else(|| storage(()))?
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Marker<'a> {
            schema_version: &'a str,
            written_at: &'a str,
            engine_version: &'a str,
        }
        let bytes = serde_json::to_vec_pretty(&Marker {
            schema_version: &to,
            written_at: &timestamp,
            engine_version: &self.engine_version,
        })
        .map_err(storage)?;
        grant.check(cancel)?;
        if !lock.is_owned() {
            return Err(super::context::error(MemoryOpErrorCode::LockLost));
        }
        atomic_write(&path, &bytes).map_err(storage)?;
        outcome(&from, &to, true)
    }
}

#[cfg(test)]
#[path = "migrate_tests.rs"]
mod tests;
