//! ACL-filtered memory operations, proposals and human curation.

use super::{
    AgentContext, EngineError, MemoryCard, MemoryCorrectResult, MemoryCurationAction,
    MemoryCurationListQuery, MemoryCurationListResult, MemoryCurationResolveResult,
    MemoryForgetResult, MemoryImportRequest, MemoryImportResult, MemoryLinkRequest,
    MemoryLinkResult, MemoryListQuery, MemoryListResult, MemoryPromoteRequest,
    MemoryPromotionResult, MemoryProposalAcceptResult, MemoryProposalListQuery,
    MemoryProposalListResult, MemoryProposalRejectResult, MemoryProposeResult, MemoryRebindRequest,
    MemoryRebindResult, MemoryShareResult, MemoryShareTarget, MemoryState, MemoryStatsResult,
    MemoryUnbindRequest, MemoryUnbindResult, MemoryUnimportRequest, MemoryUnimportResult,
    Principal, ProposalRejectOptions, ProposeOptions, ShareOptions,
};

/// Read and mutate memories through the caller's principal and execution context.
/// Shared-copy proposals change a memory only after the original sharer accepts them.
pub trait MemoryOps: Send + Sync {
    /// List visible memories within the requested topic, time and count bounds.
    fn list(
        &self,
        query: MemoryListQuery,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryListResult, EngineError>;
    /// Read a visible card; missing, hidden and tombstoned ids all answer not-found.
    fn show(
        &self,
        id: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryCard, EngineError>;
    /// Archive a card and record its tombstone, respecting shared-copy ownership.
    fn forget(
        &self,
        id: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryForgetResult, EngineError>;
    /// Correct an owned card, refreshing its shared copy when one exists.
    fn correct(
        &self,
        id: &str,
        new_text: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryCorrectResult, EngineError>;
    /// Share an owned card; allow_sensitive is explicit confirmation after approval-required.
    fn share(
        &self,
        id: &str,
        target: MemoryShareTarget,
        options: ShareOptions,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryShareResult, EngineError>;
    /// Return the visible memory and tombstone counters.
    fn state(
        &self,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryState, EngineError>;
    /// File a user-originated change proposal against a readable shared copy the caller does not own.
    fn propose(
        &self,
        shared_id: &str,
        new_text: &str,
        options: ProposeOptions,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryProposeResult, EngineError>;
    /// Access shared-copy change proposals, scoped to the readable shared pools.
    fn proposals(&self) -> &dyn MemoryProposalsOps;
    /// Ingest at most 500 finished cards without the live-store LLM merge.
    /// Requires a foreground system context; the request principal supplies each card's ACL binding.
    fn import(
        &self,
        request: MemoryImportRequest,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryImportResult, EngineError>;
    /// Attach user-scope cards of one channel identity to a harness user.
    /// Dry-run defaults to true; requires a foreground system context and returns counters only.
    fn rebind(
        &self,
        request: MemoryRebindRequest,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryRebindResult, EngineError>;
    /// Restore owner bindings from a rebind receipt, leaving cards written afterwards alone.
    fn unbind(
        &self,
        request: MemoryUnbindRequest,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryUnbindResult, EngineError>;
    /// Roll back cards created by one import run, returning ids, counters and reason codes only.
    /// Dry-run defaults to true and the execution context must be foreground system.
    fn unimport(
        &self,
        request: MemoryUnimportRequest,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryUnimportResult, EngineError>;
    /// Attach another source to a visible existing card without changing its text, vector or row.
    /// Requires foreground system context; source_ref makes the operation idempotent.
    fn link(
        &self,
        id: &str,
        request: MemoryLinkRequest,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryLinkResult, EngineError>;
    /// Read persisted counters for visible cards only, accepting at most 500 requested ids.
    /// Omitted ids reads persisted counters; unseen requested visible ids return zero counters.
    fn stats(
        &self,
        ids: Option<&[String]>,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryStatsResult, EngineError>;
    /// Promote agent-private source rows from a foreground system or user host context.
    /// Uses the configured per-invocation cap and never invokes providers.
    fn promote(
        &self,
        request: MemoryPromoteRequest,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryPromotionResult, EngineError>;
    /// Access human foreground curation, separate from shared-copy change proposals.
    fn curation(&self) -> &dyn MemoryCurationOps;
}

/// Shared-copy change proposals, visible only through their readable shared pool.
pub trait MemoryProposalsOps: Send + Sync {
    /// List visible proposals within the requested status and count bounds.
    fn list(
        &self,
        query: MemoryProposalListQuery,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryProposalListResult, EngineError>;
    /// Accept as the sharer and refresh the shared copy with the proposed text.
    fn accept(
        &self,
        proposal_id: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryProposalAcceptResult, EngineError>;
    /// Reject a proposal with an optional note; non-sharers receive not-found.
    fn reject(
        &self,
        proposal_id: &str,
        options: ProposalRejectOptions,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryProposalRejectResult, EngineError>;
}

/// Human foreground keep/drop decisions, separate from shared-copy proposals.
pub trait MemoryCurationOps: Send + Sync {
    /// List pending human curation records up to the requested limit.
    fn list(
        &self,
        query: MemoryCurationListQuery,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryCurationListResult, EngineError>;
    /// Resolve a curation record with an explicit keep or drop decision.
    fn resolve(
        &self,
        id: &str,
        action: MemoryCurationAction,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryCurationResolveResult, EngineError>;
}
