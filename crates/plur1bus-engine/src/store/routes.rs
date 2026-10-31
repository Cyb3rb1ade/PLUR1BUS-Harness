//! Leaseable physical recall routes; namespace policy is supplied by RE-04.

use std::fs;
use std::sync::Arc;

use super::{directory::TrustedDirectory, Store, StorePool};
use crate::contract::StoreError;

/// One physical namespace lease, with the read-only missing-table policy.
#[derive(Clone)]
pub struct StoreRoute {
    /// Configured namespace, or `None` for the legacy flat layout.
    pub namespace: Option<String>,
    pub(crate) pool: Arc<StorePool>,
    pub(crate) skip_missing: bool,
    pub(crate) pins: Vec<Arc<TrustedDirectory>>,
}

impl StoreRoute {
    /// Acquire a handle without creating missing legacy sources.
    /// Path replacements and every error other than absence remain failures.
    pub fn lease(&self, agent_id: &str) -> Result<Option<Arc<Store>>, StoreError> {
        self.check_pins()?;
        if self.skip_missing {
            let table = self.pool.agent_path(agent_id)?.join("memories.lance");
            match fs::symlink_metadata(table) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
                Ok(metadata) if !metadata.is_dir() => return Err(StoreError::Corrupt),
                Ok(_) => {}
            }
        }
        let store = self.pool.get(agent_id)?;
        self.check_pins()?;
        Ok(Some(store))
    }

    pub(crate) fn check_pins(&self) -> Result<(), StoreError> {
        for pin in &self.pins {
            pin.assert_unchanged()?;
        }
        Ok(())
    }
}

/// Configured routes in stable read order. Implementations retain directory capabilities.
pub trait StoreRoutes: Send + Sync {
    /// Describe routes without reading any memory; each route owns its lease policy.
    fn read_routes(&self) -> Result<Vec<StoreRoute>, StoreError>;
}
