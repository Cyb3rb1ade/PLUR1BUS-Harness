//! Leaseable physical recall routes; namespace policy is supplied by RE-04.

use std::fs;
use std::sync::Arc;

use super::identity::{canonical_identity, identity_id};
use super::{directory::TrustedDirectory, Store, StorePool};
use crate::contract::{StoreError, VectorSpaceIdentity};

/// One physical namespace lease, with the read-only missing-table policy.
#[derive(Clone)]
pub struct StoreRoute {
    /// Configured namespace, or `None` for the legacy flat layout.
    pub namespace: Option<String>,
    pub(crate) pool: Arc<StorePool>,
    pub(crate) identity_resolver: Arc<dyn StoreIdentityResolver>,
    pub(crate) skip_missing: bool,
    pub(crate) pins: Vec<Arc<TrustedDirectory>>,
}

impl StoreRoute {
    /// Acquire a handle without creating missing legacy sources.
    /// Path replacements and every error other than absence remain failures.
    pub fn lease(&self, agent_id: &str) -> Result<Option<Arc<Store>>, StoreError> {
        self.lease_identified(agent_id)
            .map(|lease| lease.map(|lease| lease.store))
    }

    pub(crate) fn lease_identified(
        &self,
        agent_id: &str,
    ) -> Result<Option<IdentifiedStore>, StoreError> {
        self.check_pins()?;
        let expected = self
            .identity_resolver
            .expected_identity(self.namespace.as_deref(), agent_id)?;
        let (expected, _, expected_id) = canonical_identity(&expected)?;
        if self.skip_missing {
            let table = self.pool.agent_path(agent_id)?.join("memories.lance");
            match fs::symlink_metadata(table) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
                Ok(metadata) if !metadata.is_dir() => return Err(StoreError::Corrupt),
                Ok(_) => {}
            }
        }
        let store = self.pool.get_with_expected(agent_id, Some(&expected))?;
        if store
            .identity()
            .map(identity_id)
            .transpose()?
            .is_some_and(|found| found != expected_id)
        {
            return Err(StoreError::IdentityMismatch);
        }
        self.check_pins()?;
        Ok(Some(IdentifiedStore {
            store,
            identity: expected,
        }))
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

/// Production expected identity for every route and agent, including read-only legacy routes.
/// Implementations resolve configured identity routes, falling back to the active identity.
pub trait StoreIdentityResolver: Send + Sync {
    /// Resolve an immutable expectation before the pool opens the agent's table.
    fn expected_identity(
        &self,
        namespace: Option<&str>,
        agent_id: &str,
    ) -> Result<VectorSpaceIdentity, StoreError>;
}

pub(crate) struct IdentifiedStore {
    pub store: Arc<Store>,
    // Missing persisted identity metadata inherits the expectation without a read-only write.
    pub identity: VectorSpaceIdentity,
}
