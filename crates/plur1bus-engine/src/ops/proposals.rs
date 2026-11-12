//! Shared-copy proposals, pool-bound authorization, durable resolution and host events.
use super::{
    archive,
    context::error,
    memory::valid_id,
    proposal_store::{Proposal, ProposalStore},
    write::MemoryWriter,
};
use crate::{
    context::RequestContext,
    contract::{
        AgentContext, EngineError, ErrorId, MemoryOpError, MemoryOpErrorCode,
        MemoryProposalAcceptResult, MemoryProposalListQuery, MemoryProposalListResult,
        MemoryProposalRejectResult, MemoryProposalsOps, MemoryProposeResult, Principal,
        ProposalRejectOptions, ProposeOptions,
    },
    recall::{acl, lifecycle::is_recall_entry_live},
    text::js::js_trim,
};
use serde_json::json;
use std::sync::Arc;
fn storage() -> EngineError {
    error(MemoryOpErrorCode::Storage)
}
fn detail(pairs: &[(&str, &str)]) -> EngineError {
    let mut failure = MemoryOpError::new(MemoryOpErrorCode::Storage);
    for (key, value) in pairs {
        if let (Some(key), Some(value)) = (ErrorId::new(key), ErrorId::new(value)) {
            failure = failure.with_detail(key, value);
        }
    }
    failure.into()
}
fn actor(ctx: &RequestContext) -> String {
    if ctx.owner_user_id.is_empty() {
        format!("principal:{}", ctx.agent_id.as_str())
    } else {
        ctx.owner_user_id.clone()
    }
}
fn check_note(note: Option<&str>) -> Result<(), EngineError> {
    if note.is_some_and(|s| s.encode_utf16().count() > 500) {
        Err(error(MemoryOpErrorCode::InvalidInput))
    } else {
        Ok(())
    }
}
/// Proposals share the same writer/lifecycle guard as direct human changes.
pub struct Proposals {
    writer: Arc<MemoryWriter>,
}
impl Proposals {
    /// Compose the proposal facade without touching persistent state.
    #[must_use]
    pub fn new(writer: Arc<MemoryWriter>) -> Self {
        Self { writer }
    }
    fn store(&self) -> Result<ProposalStore, EngineError> {
        ProposalStore::new(&self.writer.base)
    }
    fn emit(&self, p: &Proposal) {
        let payload = json!({"proposalId":p.text("id"),"status":p.text("status"),"sharerAgentId":p.text("sharerAgentId"),"proposerAgentId":p.text("proposerAgentId"),"sharedId":p.text("sharedId")});
        // Host listener failure must not undo the durable boundary or turn it into a retry.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.writer.context.host().emit("memory.proposal", payload)
        }));
    }
    fn pending(&self, id: &str, ctx: &RequestContext) -> Result<Proposal, EngineError> {
        let proposal = self
            .store()?
            .get(ctx, id)?
            .filter(|p| p.reachable(ctx))
            .ok_or_else(|| error(MemoryOpErrorCode::NotFound))?;
        if proposal.text("status") != "pending" {
            return Err(error(MemoryOpErrorCode::Conflict));
        }
        Ok(proposal)
    }
    /// File a foreground proposal with the host clock.
    pub fn propose(
        &self,
        id: &str,
        text: &str,
        options: &ProposeOptions,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryProposeResult, EngineError> {
        self.propose_at(
            id,
            text,
            options,
            principal,
            agent,
            self.writer.context.host().now_ms(),
        )
    }
    /// File using a captured clock. Duplicate pending proposals are checked under the writer lock.
    pub fn propose_at(
        &self,
        id: &str,
        text: &str,
        options: &ProposeOptions,
        principal: &Principal,
        agent: &AgentContext,
        now: i64,
    ) -> Result<MemoryProposeResult, EngineError> {
        let operation = self.writer.context.enter(principal, agent)?;
        let ctx = &operation.context;
        let workspace = self.writer.context.destructive_workspace(ctx)?;
        let text = js_trim(text);
        if !valid_id(id) || text.is_empty() || text.encode_utf16().count() > 8000 {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        check_note(options.note.as_deref())?;
        let _mutation = self.writer.context.mutation()?;
        if let Some(store) = self
            .writer
            .stores
            .existing_private(ctx)
            .map_err(|_| storage())?
        {
            if store.get(id).map_err(|_| storage())?.is_some_and(|row| {
                acl::allowed(&row, ctx).is_ok() && is_recall_entry_live(&row, now, None)
            }) {
                return Err(error(MemoryOpErrorCode::InvalidInput));
            }
        }
        let services = self
            .writer
            .sharing
            .as_ref()
            .ok_or_else(|| error(MemoryOpErrorCode::NotFound))?;
        let card = services
            .reader
            .find_shared_record(id, ctx, now, false)
            .ok()
            .flatten()
            .ok_or_else(|| error(MemoryOpErrorCode::NotFound))?;
        let share = card
            .sharing
            .as_ref()
            .filter(|share| !share.source_agent_id.is_empty() && !share.source_memory_id.is_empty())
            .ok_or_else(|| error(MemoryOpErrorCode::Denied))?;
        let pool = match card.row.scope.as_str() {
            "workspace" if !ctx.workspace_key.is_empty() => {
                crate::context::workspace_pool_key(&ctx.workspace_key)
            }
            "user" if !ctx.owner_user_id.is_empty() => {
                crate::context::user_pool_key(&ctx.owner_user_id)
            }
            _ => return Err(error(MemoryOpErrorCode::NotFound)),
        };
        if share.source_agent_id == ctx.agent_id.as_str() || card.row.text == text {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let store = self.store()?;
        if store.pending(&share.source_agent_id, id, ctx.agent_id.as_str())? {
            return Err(error(MemoryOpErrorCode::Conflict));
        }
        let proposal = Proposal::new(
            &json!({"id":uuid::Uuid::new_v4().to_string(),"sharedId":id,"sourceId":share.source_memory_id,"target":card.row.scope,"sharerAgentId":share.source_agent_id,"proposerAgentId":ctx.agent_id,"oldText":card.row.text,"newText":text,"note":options.note,"createdAt":now,"status":"pending","resolvedAt":null,"resultId":null,"resolutionNote":null,"poolKey":pool}),
        )?;
        self.writer.context.assert_open()?;
        store.save(&proposal)?;
        archive::audit(
            &workspace,
            &json!({"op":"memory-propose","proposalId":proposal.text("id"),"sharedId":id,"actor":actor(ctx),"at":archive::iso(now)?}),
        )?;
        self.emit(&proposal);
        serde_json::from_value(json!({"proposalId":proposal.text("id"),"sharedId":id,"sharerAgentId":share.source_agent_id})).map_err(|_|storage())
    }
    /// Resolve a pending proposal as its sharer; a stale shared copy is never overwritten.
    pub fn accept_at(
        &self,
        id: &str,
        principal: &Principal,
        agent: &AgentContext,
        now: i64,
    ) -> Result<MemoryProposalAcceptResult, EngineError> {
        let operation = self.writer.context.enter(principal, agent)?;
        let ctx = &operation.context;
        let workspace = self.writer.context.destructive_workspace(ctx)?;
        if !valid_id(id) {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let _mutation = self.writer.context.mutation()?;
        let mut proposal = self.pending(id, ctx)?;
        let services = self.writer.sharing.as_ref().ok_or_else(storage)?;
        if !services.stores.supported() {
            let mut failure = MemoryOpError::new(MemoryOpErrorCode::Unsupported);
            for (k, v) in [
                ("capability", "shared-memory"),
                ("reason", services.stores.unsupported_reason()),
            ] {
                if let (Some(k), Some(v)) = (ErrorId::new(k), ErrorId::new(v)) {
                    failure = failure.with_detail(k, v);
                }
            }
            return Err(failure.into());
        }
        let card = services
            .reader
            .find_shared_record(proposal.text("sharedId"), ctx, now, true)?;
        let card = card.filter(|c| {
            c.row.text == proposal.text("oldText")
                && c.sharing
                    .as_ref()
                    .is_some_and(|s| s.source_agent_id == ctx.agent_id.as_str())
        });
        let Some(card) = card else {
            self.writer.context.assert_open()?;
            proposal.set("status", json!("stale"))?;
            proposal.set("resolvedAt", json!(now))?;
            self.store()?.save(&proposal)?;
            self.emit(&proposal);
            return Err(error(MemoryOpErrorCode::Conflict));
        };
        let refreshed = self.writer.refresh_locked(
            &card,
            proposal.text("newText"),
            ctx,
            now,
            "MemoryOps.proposals.accept",
        )?;
        proposal.set("status", json!("accepted"))?;
        proposal.set("resolvedAt", json!(now))?;
        proposal.set("resultId", json!(refreshed.shared_id))?;
        let recovery = [
            ("proposalId", id),
            ("id", refreshed.shared_id.as_str()),
            ("sourceId", refreshed.source_id.as_str()),
        ];
        self.writer.context.assert_open()?;
        self.store()?
            .save(&proposal)
            .map_err(|_| detail(&recovery))?;
        archive::audit(&workspace,&json!({"op":"memory-proposal-accept","proposalId":id,"resultId":refreshed.shared_id,"actor":actor(ctx),"at":archive::iso(now)?})).map_err(|_|detail(&recovery))?;
        self.emit(&proposal);
        serde_json::from_value(
            json!({"proposalId":id,"id":refreshed.shared_id,"sourceId":refreshed.source_id}),
        )
        .map_err(|_| storage())
    }
    /// Record rejection before emitting an event; optional notes never enter event payloads.
    pub fn reject_at(
        &self,
        id: &str,
        options: &ProposalRejectOptions,
        principal: &Principal,
        agent: &AgentContext,
        now: i64,
    ) -> Result<MemoryProposalRejectResult, EngineError> {
        let operation = self.writer.context.enter(principal, agent)?;
        let ctx = &operation.context;
        let workspace = self.writer.context.destructive_workspace(ctx)?;
        if !valid_id(id) {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        check_note(options.note.as_deref())?;
        let _mutation = self.writer.context.mutation()?;
        let mut proposal = self.pending(id, ctx)?;
        proposal.set("status", json!("rejected"))?;
        proposal.set("resolvedAt", json!(now))?;
        proposal.set("resolutionNote", json!(options.note))?;
        self.writer.context.assert_open()?;
        self.store()?.save(&proposal)?;
        archive::audit(&workspace,&json!({"op":"memory-proposal-reject","proposalId":id,"actor":actor(ctx),"at":archive::iso(now)?})).map_err(|_|detail(&[("proposalId",id)]))?;
        self.emit(&proposal);
        serde_json::from_value(json!({"proposalId":id,"status":"rejected"})).map_err(|_| storage())
    }
}
impl MemoryProposalsOps for Proposals {
    fn list(
        &self,
        query: MemoryProposalListQuery,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryProposalListResult, EngineError> {
        let operation = self.writer.context.enter(principal, agent)?;
        let limit = query
            .limit
            .as_ref()
            .and_then(serde_json::Number::as_f64)
            .unwrap_or(20.);
        if !(1. ..=100.).contains(&limit) || limit.fract() != 0. {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let status = query.status.map(|s| s.to_string());
        serde_json::from_value(self.store()?.list(
            &operation.context,
            status.as_deref(),
            limit as usize,
        )?)
        .map_err(|_| storage())
    }
    fn accept(
        &self,
        id: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryProposalAcceptResult, EngineError> {
        self.accept_at(id, principal, agent, self.writer.context.host().now_ms())
    }
    fn reject(
        &self,
        id: &str,
        options: ProposalRejectOptions,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryProposalRejectResult, EngineError> {
        self.reject_at(
            id,
            &options,
            principal,
            agent,
            self.writer.context.host().now_ms(),
        )
    }
}
