//! Process-owned implementation of the authorized F7 maintenance entry points.
#[path = "maintenance_reembedding.rs"]
mod reembedding;

use super::seams::Seam;
use crate::{
    contract::{
        Cancel, EngineError, HostServices, MaintenanceGrant, MaintenanceOps, MigrationResult,
        SchemaVersion,
    },
    ops::migrate::{FileMaintenanceAudit, MaintenanceAudit, SchemaMigrator},
};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};

/// Native schema maintenance and re-embedding (RE-D166) over the configured process store base.
pub struct ProcessMaintenance {
    schema: Option<SchemaMigrator>,
    reembedding: Option<reembedding::Reembedding>,
}

impl ProcessMaintenance {
    /// Bind the marker and the private audit path without opening either.
    pub fn new(host: Arc<dyn HostServices>) -> Self {
        Self::with_seam(host, None)
    }

    /// As `new`; an authorized process seam also selects the pin's flat re-embedding target
    /// provider (`reembeddingTargetProvider`), so no target model is loaded or called.
    pub fn with_seam(host: Arc<dyn HostServices>, seam: Option<Seam>) -> Self {
        // The hook is read only under an explicitly authorized seam.
        let hold = seam
            .and_then(|_| std::env::var_os(reembedding::HOLD_VARIABLE))
            .map(PathBuf::from);
        Self::compose(host, seam, hold)
    }

    fn compose(host: Arc<dyn HostServices>, seam: Option<Seam>, hold: Option<PathBuf>) -> Self {
        let Some(base) = host
            .config()
            .base_db_path
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
        else {
            return Self {
                schema: None,
                reembedding: None,
            };
        };
        let audit: Arc<dyn MaintenanceAudit> = Arc::new(FileMaintenanceAudit::new(
            host.state_dir().join("engine-maintenance.jsonl"),
        ));
        let reembedding =
            reembedding::Reembedding::new(host.clone(), base.clone(), audit.clone(), seam, hold);
        let clock = host;
        let schema = SchemaMigrator::new(
            base,
            crate::CRATE_VERSION.into(),
            Arc::new(move || clock.now_ms()),
            audit,
        )
        .with_fresh_base_current();
        Self {
            schema: Some(schema),
            reembedding: Some(reembedding),
        }
    }

    fn reembedding(
        &self,
        grant: &MaintenanceGrant,
        cancel: &Cancel,
    ) -> Result<&reembedding::Reembedding, EngineError> {
        grant.check(cancel)?;
        self.reembedding.as_ref().ok_or_else(unavailable)
    }
}

fn unavailable() -> EngineError {
    EngineError::NotAvailable {
        reason: "composition-pending".into(),
    }
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
        request: Value,
        cancel: &Cancel,
    ) -> Result<Value, EngineError> {
        self.reembedding(grant, cancel)?
            .plan(grant, &request, cancel)
    }
    fn apply(
        &self,
        grant: &MaintenanceGrant,
        request: Value,
        cancel: &Cancel,
    ) -> Result<Value, EngineError> {
        self.reembedding(grant, cancel)?
            .apply(grant, &request, cancel, false)
    }
    fn resume(
        &self,
        grant: &MaintenanceGrant,
        request: Value,
        cancel: &Cancel,
    ) -> Result<Value, EngineError> {
        self.reembedding(grant, cancel)?
            .apply(grant, &request, cancel, true)
    }
    fn status(
        &self,
        grant: &MaintenanceGrant,
        id: &str,
        cancel: &Cancel,
    ) -> Result<Value, EngineError> {
        self.reembedding(grant, cancel)?.status(grant, id, cancel)
    }
    fn validate(
        &self,
        grant: &MaintenanceGrant,
        id: &str,
        cancel: &Cancel,
    ) -> Result<Value, EngineError> {
        self.reembedding(grant, cancel)?.validate(grant, id, cancel)
    }
}

#[cfg(test)]
#[path = "maintenance_tests.rs"]
mod tests;
