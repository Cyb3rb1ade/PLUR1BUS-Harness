//! Capture's read-only workspace-policy boundary; policy mutations remain with memory operations.

use crate::context::RequestContext;
use crate::contract::{EngineError, StoreError};
use crate::ops::workspace_policy::PolicyStore;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;

/// The automatic capture policy, consulted before any capture-owned write.
pub trait CapturePolicy: Send + Sync {
    /// Return the current workspace decision; an error is a fail-closed refusal.
    fn allowed(&self, context: &RequestContext) -> Result<bool, EngineError>;
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
    fn allowed(&self, context: &RequestContext) -> Result<bool, EngineError> {
        let maintenance = self.maintenance.as_ref().is_some_and(|active| active());
        if maintenance {
            return Ok(false);
        }
        let policy = PolicyStore::new(&self.base_db).map_err(|_| StoreError::Corrupt)?;
        let decision = policy.automatic(
            &json!({
                "agentId": context.agent_id.as_str(), "workspaceIdentity": context.workspace_key
            }),
            maintenance,
        );
        Ok(decision["allowed"] == true)
    }
}
