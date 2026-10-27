//! Host-neutral administrative operations.

use super::{
    AgentContext, EngineError, MemoryForgetResult, MemoryShareResult, MemoryShareTarget,
    MigrationResult, ObsidianConfirmResult, ObsidianDetectOptions, ObsidianDetectResult,
    ObsidianPrepareResult, Principal, SchemaVersion, ShareOptions,
};
use serde_json::Value;

/// Administrative operations, including the deprecated memory aliases.
pub trait AdminOps: Send + Sync {
    /// Alias of memory.share, deprecated since contract 1.6.0 and removed in 2.0.
    fn share(
        &self,
        id: &str,
        target: MemoryShareTarget,
        options: ShareOptions,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryShareResult, EngineError>;
    /// Alias of memory.forget, deprecated since contract 1.6.0 and removed in 2.0.
    fn forget(
        &self,
        id: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryForgetResult, EngineError>;
    /// Access host-owned vector-space migration coordination.
    fn reembedding(&self) -> &dyn ReembeddingOps;
    /// Access workspace sharing policy.
    fn workspace_policy(&self) -> &dyn WorkspacePolicyOps;
    /// Access explicit-path vault setup without a host runtime.
    fn obsidian(&self) -> &dyn ObsidianOps;
    /// Migrate the store schema; rejects conflicting, unknown or downgrading versions.
    fn migrate(
        &self,
        from: SchemaVersion,
        to: SchemaVersion,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MigrationResult, EngineError>;
}

/// Re-embedding migration coordination; opaque payloads mirror the frozen declaration's unknown types.
pub trait ReembeddingOps: Send + Sync {
    /// Prepare a migration plan without applying it.
    fn plan(&self, principal: &Principal, agent: &AgentContext) -> Result<Value, EngineError>;
    /// Apply a prepared migration plan.
    fn apply(&self, principal: &Principal, agent: &AgentContext) -> Result<Value, EngineError>;
    /// Resume interrupted copying from the persisted migration record.
    fn resume(&self, principal: &Principal, agent: &AgentContext) -> Result<Value, EngineError>;
    /// Validate the target generation and semantic recall probe before ready_to_switch.
    /// Failed validation leaves the migration in validating.
    fn validate(&self, principal: &Principal, agent: &AgentContext) -> Result<Value, EngineError>;
    /// Roll back a migration using its persisted record.
    fn rollback(&self, principal: &Principal, agent: &AgentContext) -> Result<Value, EngineError>;
    /// Read the persisted migration state.
    fn status(&self, principal: &Principal, agent: &AgentContext) -> Result<Value, EngineError>;
    /// Switch to a migration that passed validation.
    fn switch(&self, principal: &Principal, agent: &AgentContext) -> Result<Value, EngineError>;
}

/// Workspace sharing policy; payloads remain opaque where the frozen declaration uses unknown.
pub trait WorkspacePolicyOps: Send + Sync {
    /// Read the policy for the caller's workspace.
    fn get(&self, principal: &Principal, agent: &AgentContext) -> Result<Value, EngineError>;
    /// List workspace policies visible to this caller.
    fn list(&self, principal: &Principal, agent: &AgentContext) -> Result<Value, EngineError>;
    /// Apply a workspace policy patch.
    fn set(
        &self,
        patch: Value,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<Value, EngineError>;
}

/// Explicit-path vault setup. Preparation and confirmation require a foreground user
/// context and a proved principal with a user; confirmation nonces expire after ten minutes.
pub trait ObsidianOps: Send + Sync {
    /// Detect candidate vaults and existing confirmation receipts.
    fn detect(
        &self,
        options: ObsidianDetectOptions,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<ObsidianDetectResult, EngineError>;
    /// Prepare a one-use confirmation nonce for this explicit vault path.
    fn prepare(
        &self,
        vault_path: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<ObsidianPrepareResult, EngineError>;
    /// Consume the nonce and confirm access to its vault.
    fn confirm(
        &self,
        nonce: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<ObsidianConfirmResult, EngineError>;
}
