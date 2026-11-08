//! F7: storage-wide maintenance authority from an authenticated Core connection, never a person.
use super::{Cancel, EngineError, MigrationResult, SchemaVersion};
use serde_json::Value;

/// Exactly the six productive Core maintenance operations; data access is deliberately absent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MaintenanceMethod {
    /// Advance a schema marker through supported migration steps.
    Migrate,
    /// Prepare a reembedding plan.
    Plan,
    /// Apply a confirmed plan.
    Apply,
    /// Resume a confirmed migration.
    Resume,
    /// Inspect a migration record.
    Status,
    /// Validate the copied target before the Core-owned switch.
    Validate,
}
impl MaintenanceMethod {
    /// Existing wire method, without changing its schema or version.
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Migrate => "engine.admin.migrate",
            Self::Plan => "engine.admin.reembedding.plan",
            Self::Apply => "engine.admin.reembedding.apply",
            Self::Resume => "engine.admin.reembedding.resume",
            Self::Status => "engine.admin.reembedding.status",
            Self::Validate => "engine.admin.reembedding.validate",
        }
    }
    /// Classify the bounded maintenance surface; rollback/switch and data methods are excluded.
    pub fn from_wire(method: &str) -> Option<Self> {
        [
            Self::Migrate,
            Self::Plan,
            Self::Apply,
            Self::Resume,
            Self::Status,
            Self::Validate,
        ]
        .into_iter()
        .find(|m| m.wire_name() == method)
    }
}

/// An unforgeable external capability tied to one authenticated Core-link lifetime.
///
/// It has no serde/Default/Principal conversion. Its only production constructor requires the
/// wire adapter's private authenticated-link proof. Disconnect cancellation revokes it.
/// ```compile_fail
/// use plur1bus_engine::contract::{MaintenanceGrant, Principal};
/// fn person(grant: MaintenanceGrant) -> Principal { grant.into() }
/// ```
/// ```compile_fail
/// use plur1bus_engine::contract::MaintenanceGrant;
/// let grant: MaintenanceGrant = serde_json::from_str("{}").unwrap();
/// ```
pub struct MaintenanceGrant {
    origin: String,
    revoked: Cancel,
}
impl MaintenanceGrant {
    pub(crate) fn from_authenticated_core_link(
        link: &crate::rpc::server::AuthenticatedCoreLink,
    ) -> Self {
        Self {
            origin: link.instance().to_owned(),
            revoked: link.cancellation().clone(),
        }
    }
    /// Non-secret Core-link instance for the required maintenance audit, never a user id.
    pub fn origin(&self) -> &str {
        &self.origin
    }
    /// Reject use after disconnect or after the caller's cancellation/deadline.
    pub fn check(&self, cancel: &Cancel) -> Result<(), EngineError> {
        self.revoked.check()?;
        cancel.check()?;
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn for_test(cancel: Cancel) -> Self {
        Self {
            origin: "test-core-link".into(),
            revoked: cancel,
        }
    }
}

/// Additive request-bearing native contract approved by F7. Every implementation audits each
/// call with method, grant origin and schema versions/migration id, excluding payload contents.
/// The Core retains RBAC and privacy acknowledgment; no person is inferred in the engine.
pub trait MaintenanceOps: Send + Sync {
    /// Supported schema migration, with the authenticated link and request cancellation.
    fn migrate(
        &self,
        grant: &MaintenanceGrant,
        from: SchemaVersion,
        to: SchemaVersion,
        cancel: &Cancel,
    ) -> Result<MigrationResult, EngineError>;
    /// Plan with the actual Core request (id, target, namespaces and limits).
    fn plan(
        &self,
        grant: &MaintenanceGrant,
        request: Value,
        cancel: &Cancel,
    ) -> Result<Value, EngineError>;
    /// Apply the actual request, including its confirmation proof.
    fn apply(
        &self,
        grant: &MaintenanceGrant,
        request: Value,
        cancel: &Cancel,
    ) -> Result<Value, EngineError>;
    /// Resume with the actual request and confirmation proof.
    fn resume(
        &self,
        grant: &MaintenanceGrant,
        request: Value,
        cancel: &Cancel,
    ) -> Result<Value, EngineError>;
    /// Inspect only the requested migration id.
    fn status(
        &self,
        grant: &MaintenanceGrant,
        id: &str,
        cancel: &Cancel,
    ) -> Result<Value, EngineError>;
    /// Validate only the requested migration id.
    fn validate(
        &self,
        grant: &MaintenanceGrant,
        id: &str,
        cancel: &Cancel,
    ) -> Result<Value, EngineError>;
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn grant_is_revoked_with_its_connection_and_never_admits_data_operations() {
        let link = Cancel::never();
        let grant = MaintenanceGrant::for_test(link.clone());
        assert_eq!(grant.origin(), "test-core-link");
        assert!(grant.check(&Cancel::never()).is_ok());
        for method in [
            "engine.recall",
            "engine.memory.list",
            "engine.memory.state",
            "engine.memory.correct",
            "engine.memory.forget",
            "engine.memory.share",
            "engine.admin.workspacePolicy.set",
            "engine.admin.reembedding.rollback",
            "engine.admin.reembedding.switch",
        ] {
            assert_eq!(MaintenanceMethod::from_wire(method), None);
        }
        for method in [
            MaintenanceMethod::Migrate,
            MaintenanceMethod::Plan,
            MaintenanceMethod::Apply,
            MaintenanceMethod::Resume,
            MaintenanceMethod::Status,
            MaintenanceMethod::Validate,
        ] {
            assert_eq!(
                MaintenanceMethod::from_wire(method.wire_name()),
                Some(method)
            );
        }
        let request = Cancel::never();
        request.cancel();
        assert!(matches!(
            grant.check(&request),
            Err(EngineError::Cancelled(_))
        ));
        link.cancel();
        assert!(matches!(
            grant.check(&Cancel::never()),
            Err(EngineError::Cancelled(_))
        ));
    }
}
