//! Caller-bound native policy facade. The legacy contextless wire stays unavailable (F6).
use super::{
    context::{error, OperationContext},
    workspace_policy::{PolicyError, PolicyStore},
};
use crate::{
    context::RequestContext,
    contract::{
        AgentContext, EngineError, MemoryOpErrorCode, Principal, TurnOrigin, WorkspacePolicyOps,
    },
    recall::acl::{self, AclMemory, AclSubject},
};
use serde_json::{json, Value};
use std::sync::Arc;

/// Host-owned recall/warm-cache invalidation after a policy change is durable.
pub trait PolicyInvalidation: Send + Sync {
    /// Only the authorized canonical tuple is supplied, never caller-selected authority.
    fn invalidate(&self, agent: &str, workspace: &str) -> Result<(), PolicyError>;
}
fn failure(e: &PolicyError) -> EngineError {
    error(match e {
        PolicyError::Invalid => MemoryOpErrorCode::InvalidInput,
        PolicyError::Conflict { .. } => MemoryOpErrorCode::Conflict,
        PolicyError::IdentityRequired | PolicyError::Disabled { .. } => MemoryOpErrorCode::Denied,
        PolicyError::InvalidState | PolicyError::Storage | PolicyError::Maintenance => {
            MemoryOpErrorCode::Storage
        }
    })
}
fn visible(policy: &Value, ctx: &RequestContext) -> bool {
    let (Some(agent), Some(workspace)) = (
        policy["agentId"].as_str(),
        policy["workspaceIdentity"].as_str(),
    ) else {
        return false;
    };
    let ownership = AclMemory {
        scope: "workspace".into(),
        agent_id: agent.into(),
        stored_by: agent.into(),
        workspace_id: workspace.into(),
        workspace_key: workspace.into(),
        ..Default::default()
    };
    acl::check_access(Some(&AclSubject::from_context(ctx)), Some(&ownership)).is_ok()
}
fn tuple(ctx: &RequestContext) -> Result<Value, EngineError> {
    if ctx.workspace_key.is_empty() {
        return Err(error(MemoryOpErrorCode::Denied));
    }
    let tuple = json!({"agentId":ctx.agent_id,"workspaceIdentity":ctx.workspace_key});
    if !visible(&tuple, ctx) {
        return Err(error(MemoryOpErrorCode::Denied));
    }
    Ok(tuple)
}
/// Native get/list/set with real request context. Internal automatic policy reads use PolicyStore.
pub struct CallerPolicy {
    context: Arc<OperationContext>,
    store: Arc<PolicyStore>,
    invalidation: Arc<dyn PolicyInvalidation>,
}
impl CallerPolicy {
    /// Compose explicitly; the future native core supplies the genuine caller and cache owner.
    pub fn new(
        context: Arc<OperationContext>,
        store: Arc<PolicyStore>,
        invalidation: Arc<dyn PolicyInvalidation>,
    ) -> Self {
        Self {
            context,
            store,
            invalidation,
        }
    }
}
impl WorkspacePolicyOps for CallerPolicy {
    fn get(&self, p: &Principal, a: &AgentContext) -> Result<Value, EngineError> {
        let op = self.context.enter(p, a)?;
        let identity = tuple(&op.context)?;
        self.store.get(&identity).map_err(|e| failure(&e))
    }
    fn list(&self, p: &Principal, a: &AgentContext) -> Result<Value, EngineError> {
        let op = self.context.enter(p, a)?;
        let ctx = &op.context;
        // No workspace means no visible policy, and must not open the global policy file.
        if ctx.workspace_key.is_empty() {
            return Ok(json!([]));
        }
        let rows = self.store.list().map_err(|e| failure(&e))?;
        Ok(Value::Array(
            rows.as_array()
                .ok_or_else(|| error(MemoryOpErrorCode::Storage))?
                .iter()
                .filter(|r| visible(r, ctx))
                .cloned()
                .collect(),
        ))
    }
    fn set(&self, mut patch: Value, p: &Principal, a: &AgentContext) -> Result<Value, EngineError> {
        let op = self.context.enter(p, a)?;
        let ctx = &op.context;
        // Interactive mutations require a proved user. Automatic maintenance uses the
        // internal store, not an invented user or a caller-supplied actorId.
        if a.origin != TurnOrigin::User
            || a.background
            || ctx.trust() != "proved"
            || ctx.owner_user_id.is_empty()
        {
            return Err(error(MemoryOpErrorCode::Denied));
        }
        let identity = tuple(ctx)?;
        let fields = patch
            .as_object_mut()
            .ok_or_else(|| error(MemoryOpErrorCode::InvalidInput))?;
        if fields.keys().any(|key| {
            ![
                "agentId",
                "workspaceIdentity",
                "enabled",
                "expectedRevision",
                "actorId",
            ]
            .contains(&key.as_str())
        }) {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        for key in ["agentId", "workspaceIdentity"] {
            if fields.get(key).is_some_and(|value| value != &identity[key]) {
                return Err(error(MemoryOpErrorCode::Denied));
            }
            fields.insert(key.into(), identity[key].clone());
        }
        if fields
            .get("actorId")
            .is_some_and(|v| v.as_str() != Some(&ctx.owner_user_id))
        {
            return Err(error(MemoryOpErrorCode::Denied));
        }
        fields.insert("actorId".into(), json!(ctx.owner_user_id));
        let _mutation = self.context.mutation()?;
        self.store
            .set_and_invalidate(&patch, self.context.host().now_ms(), |tuple| {
                self.invalidation.invalidate(
                    tuple["agentId"].as_str().ok_or(PolicyError::InvalidState)?,
                    tuple["workspaceIdentity"]
                        .as_str()
                        .ok_or(PolicyError::InvalidState)?,
                )
            })
            .map_err(|e| failure(&e))
    }
}
