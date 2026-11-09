//! Process-owned implementation of the authorized F7 maintenance entry points.
use crate::{
    contract::{
        Cancel, EngineError, HostServices, MaintenanceGrant, MaintenanceOps, MigrationResult,
        SchemaVersion,
    },
    ops::migrate::{FileMaintenanceAudit, SchemaMigrator},
};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};

/// Native schema maintenance over the same configured base as the process store.
pub struct ProcessMaintenance {
    schema: Option<SchemaMigrator>,
}

impl ProcessMaintenance {
    /// Bind the marker and the private audit path without opening either.
    pub fn new(host: Arc<dyn HostServices>) -> Self {
        let schema = host
            .config()
            .base_db_path
            .filter(|path| !path.is_empty())
            .map(|base| {
                let audit =
                    FileMaintenanceAudit::new(host.state_dir().join("engine-maintenance.jsonl"));
                SchemaMigrator::new(
                    PathBuf::from(base),
                    crate::CRATE_VERSION.into(),
                    Arc::new(move || host.now_ms()),
                    Arc::new(audit),
                )
            });
        Self { schema }
    }
}

fn unavailable() -> EngineError {
    EngineError::NotAvailable {
        reason: "composition-pending".into(),
    }
}

fn reembedding_pending(grant: &MaintenanceGrant, cancel: &Cancel) -> Result<Value, EngineError> {
    grant.check(cancel)?;
    Err(unavailable())
}

impl MaintenanceOps for ProcessMaintenance {
    fn migrate(
        &self,
        grant: &MaintenanceGrant,
        from: SchemaVersion,
        to: SchemaVersion,
        cancel: &Cancel,
    ) -> Result<MigrationResult, EngineError> {
        self.schema
            .as_ref()
            .ok_or_else(unavailable)?
            .migrate(grant, from, to, cancel)
    }

    fn plan(
        &self,
        grant: &MaintenanceGrant,
        _request: Value,
        cancel: &Cancel,
    ) -> Result<Value, EngineError> {
        reembedding_pending(grant, cancel)
    }
    fn apply(
        &self,
        grant: &MaintenanceGrant,
        _request: Value,
        cancel: &Cancel,
    ) -> Result<Value, EngineError> {
        reembedding_pending(grant, cancel)
    }
    fn resume(
        &self,
        grant: &MaintenanceGrant,
        _request: Value,
        cancel: &Cancel,
    ) -> Result<Value, EngineError> {
        reembedding_pending(grant, cancel)
    }
    fn status(
        &self,
        grant: &MaintenanceGrant,
        _id: &str,
        cancel: &Cancel,
    ) -> Result<Value, EngineError> {
        reembedding_pending(grant, cancel)
    }
    fn validate(
        &self,
        grant: &MaintenanceGrant,
        _id: &str,
        cancel: &Cancel,
    ) -> Result<Value, EngineError> {
        reembedding_pending(grant, cancel)
    }
}
