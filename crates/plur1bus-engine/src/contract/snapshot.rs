//! F9 / RE-D170: engine snapshot authority from an authenticated Core connection, never a
//! person. Separate from the F7 maintenance grant: neither admits the other's methods.
use super::{Cancel, EngineError};
use crate::ops::snapshot::SnapshotError;
use serde_json::Value;
use std::path::Path;

/// Exactly the three existing snapshot wire methods (`since 1.7.0`, schema unchanged).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SnapshotMethod {
    /// Create a verified snapshot below one of the two permitted snapshot roots.
    Create,
    /// Verify a published snapshot below one of the two permitted snapshot roots.
    Verify,
    /// Reapply committed tombstones to the active generation (`apply = true`).
    Reapply,
}
impl SnapshotMethod {
    /// Existing wire method, without changing its schema or version.
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Create => "engine.snapshot.create",
            Self::Verify => "engine.snapshot.verify",
            Self::Reapply => "engine.tombstones.reapply",
        }
    }
    /// Classify the bounded snapshot surface; maintenance and data methods are excluded.
    pub fn from_wire(method: &str) -> Option<Self> {
        [Self::Create, Self::Verify, Self::Reapply]
            .into_iter()
            .find(|m| m.wire_name() == method)
    }
}

/// An unforgeable capability tied to one authenticated Core-link lifetime (RE-D170).
///
/// It has no serde/Default/Principal conversion. Its only production constructor requires the
/// wire adapter's private authenticated-link proof. Disconnect cancellation revokes it.
/// ```compile_fail
/// use plur1bus_engine::contract::{Principal, SnapshotGrant};
/// fn person(grant: SnapshotGrant) -> Principal { grant.into() }
/// ```
/// ```compile_fail
/// use plur1bus_engine::contract::SnapshotGrant;
/// let grant: SnapshotGrant = serde_json::from_str("{}").unwrap();
/// ```
/// ```compile_fail
/// use plur1bus_engine::contract::{MaintenanceGrant, SnapshotGrant};
/// fn widen(grant: MaintenanceGrant) -> SnapshotGrant { grant.into() }
/// ```
pub struct SnapshotGrant {
    origin: String,
    revoked: Cancel,
}
impl SnapshotGrant {
    pub(crate) fn from_authenticated_core_link(
        link: &crate::rpc::server::AuthenticatedCoreLink,
    ) -> Self {
        Self {
            origin: link.instance().to_owned(),
            revoked: link.cancellation().clone(),
        }
    }
    /// Non-secret Core-link instance for the required audit, never a user id.
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

/// A content-free snapshot refusal: a snapshot category or a common engine failure.
#[derive(Debug)]
pub enum SnapshotFailure {
    /// A `plur1bus.snapshot/1` category (`unsafe-path`, `source-busy`, `insufficient-disk`, …).
    Snapshot(SnapshotError),
    /// Grant, cancellation, availability (`engine-busy`, `composition-pending`) or storage.
    Engine(EngineError),
}
impl From<SnapshotError> for SnapshotFailure {
    fn from(error: SnapshotError) -> Self {
        match error {
            SnapshotError::Cancelled => Self::Engine(EngineError::Cancelled(super::Cancelled {
                reason: super::CancelReason::Caller,
            })),
            error => Self::Snapshot(error),
        }
    }
}
impl From<EngineError> for SnapshotFailure {
    fn from(error: EngineError) -> Self {
        Self::Engine(error)
    }
}
impl From<super::Cancelled> for SnapshotFailure {
    fn from(error: super::Cancelled) -> Self {
        Self::Engine(EngineError::Cancelled(error))
    }
}

/// Additive request-bearing native contract approved by F9. Every mutation (create, reapply)
/// is audited before it starts, with method, grant origin and a content-free target.
/// Sources and permitted roots come from the host composition, never from the caller.
pub trait SnapshotOps: Send + Sync {
    /// Create `plur1bus-<UTC>-snapshot` below `out`, which must be a permitted snapshot root.
    /// Result: `{id, dir, bytes, files, pruned, warnings}`.
    fn create(
        &self,
        grant: &SnapshotGrant,
        out: &Path,
        cancel: &Cancel,
    ) -> Result<Value, SnapshotFailure>;
    /// Verify a published snapshot directly below a permitted root. Result: `{id, files, bytes}`.
    fn verify(
        &self,
        grant: &SnapshotGrant,
        dir: &Path,
        cancel: &Cancel,
    ) -> Result<Value, SnapshotFailure>;
    /// Reapply committed tombstones to the active generation; the unchanged `ReapplyReport`.
    fn reapply(&self, grant: &SnapshotGrant, cancel: &Cancel) -> Result<Value, SnapshotFailure>;
    /// A granted call with missing or invalid parameters: create and reapply are audited as
    /// `{"invalid":true}` (verify is never audited). Nothing else happens.
    fn refuse(
        &self,
        grant: &SnapshotGrant,
        method: SnapshotMethod,
        cancel: &Cancel,
    ) -> Result<(), SnapshotFailure>;
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::contract::MaintenanceMethod;

    #[test]
    fn grant_is_revoked_with_its_connection_and_admits_only_the_three_methods() {
        let link = Cancel::never();
        let grant = SnapshotGrant::for_test(link.clone());
        assert_eq!(grant.origin(), "test-core-link");
        assert!(grant.check(&Cancel::never()).is_ok());
        for method in [
            SnapshotMethod::Create,
            SnapshotMethod::Verify,
            SnapshotMethod::Reapply,
        ] {
            assert_eq!(SnapshotMethod::from_wire(method.wire_name()), Some(method));
            // The F7 maintenance allowlist never learns the snapshot surface.
            assert_eq!(MaintenanceMethod::from_wire(method.wire_name()), None);
        }
        for method in [
            "engine.admin.migrate",
            "engine.admin.reembedding.apply",
            "engine.memory.forget",
            "engine.admin.forget",
            "engine.stores.adopt",
            "engine.snapshot.restore",
            "engine.snapshot.list",
        ] {
            assert_eq!(SnapshotMethod::from_wire(method), None);
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
