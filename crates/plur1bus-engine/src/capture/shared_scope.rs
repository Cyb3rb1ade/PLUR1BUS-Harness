//! Capture's read-only workspace-policy boundary; policy mutations remain with memory operations.

use crate::context::RequestContext;
use crate::contract::{EngineError, StoreError};
use crate::ops::workspace_policy::PolicyStore;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;

/// Why automatic capture is (not) allowed right now (RE-D156).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyDecision {
    /// Capture may write for this workspace.
    Allowed,
    /// The workspace owner switched capture off: retained input is discarded, not resumed.
    Revoked,
    /// A temporary maintenance state (re-embedding switch): retained input waits.
    Maintenance,
}

/// The automatic capture policy, consulted before any capture-owned write.
pub trait CapturePolicy: Send + Sync {
    /// Return the current workspace decision; an error is a fail-closed refusal.
    fn allowed(&self, context: &RequestContext) -> Result<bool, EngineError>;

    /// Separate a revocation from maintenance. Policies without a maintenance state treat
    /// every refusal as a revocation.
    fn decision(&self, context: &RequestContext) -> Result<PolicyDecision, EngineError> {
        Ok(if self.allowed(context)? {
            PolicyDecision::Allowed
        } else {
            PolicyDecision::Revoked
        })
    }
}

/// Read the same `control/workspace-policy.json` state as the pinned Node guard.
pub struct WorkspaceCapturePolicy {
    base_db: PathBuf,
    maintenance: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

impl WorkspaceCapturePolicy {
    /// Configure read-only policy lookup without creating a state file.
    #[must_use]
    pub fn new(base_db: PathBuf) -> Self {
        Self {
            base_db,
            maintenance: None,
        }
    }

    /// Include the operation-owned re-embedding switching gate, evaluated on every call.
    #[must_use]
    pub fn with_maintenance(mut self, active: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        self.maintenance = Some(active);
        self
    }
}

impl CapturePolicy for WorkspaceCapturePolicy {
    fn decision(&self, context: &RequestContext) -> Result<PolicyDecision, EngineError> {
        if self.maintenance.as_ref().is_some_and(|active| active()) {
            return Ok(PolicyDecision::Maintenance);
        }
        let policy = PolicyStore::new(&self.base_db).map_err(|_| StoreError::Unavailable)?;
        let decision = policy.automatic(
            &json!({
                "agentId": context.agent_id.as_str(), "workspaceIdentity": context.workspace_key
            }),
            false,
        );
        match decision["reason"].as_str() {
            _ if decision["allowed"] == true => Ok(PolicyDecision::Allowed),
            Some("workspace_disabled") => Ok(PolicyDecision::Revoked),
            Some("migration_switching") => Ok(PolicyDecision::Maintenance),
            // The caller has no workspace identity or sent an invalid one: deterministic.
            Some("workspace_identity_required" | "invalid") => Err(StoreError::InvalidInput.into()),
            // An unreadable or unwritable policy state is an operator repair: retried (and
            // counted, RE-D159), never read as a user's revocation.
            _ => Err(StoreError::Unavailable.into()),
        }
    }

    /// The same decision as [`CapturePolicy::decision`]: only `Allowed` allows.
    fn allowed(&self, context: &RequestContext) -> Result<bool, EngineError> {
        Ok(self.decision(context)? == PolicyDecision::Allowed)
    }
}
