//! Immutable, current-source review plans. A plan and its fingerprint are not an approval.
use super::*;
use crate::{
    capture::conflict_resolution,
    contract::{MemoryOpErrorCode, MemoryRow},
    embedding::{identity::try_identity_id, VectorSpaceIdentity},
    ops::{memory::SourceKind, safe_update, safe_update_row},
    store::Store,
    text::json::TolerantJsonValue as Json,
};
/// Exact proposal selected by the caller, with its already computed replacement embedding.
/// Creating a review plan performs no model call and changes no memory.
pub struct ApplicationRequest<'a> {
    /// Stable identity for this proposed application, not an authorization token.
    pub operation_id: uuid::Uuid,
    /// Either source ID of the currently selected conflict.
    pub memory_id: &'a str,
    /// Exact proposal previously displayed/read; a changed proposal must be reviewed again.
    pub expected_proposal: &'a Value,
    /// Replacement vector in the explicitly declared active embedding space.
    pub vector: Vec<f32>,
    /// Must equal both the active provider and the actual private store identity.
    pub identity: &'a VectorSpaceIdentity,
}
/// Prepared from current authorized sources. Private fields prevent arbitrary caller-built plans.
/// It intentionally has no Deserialize implementation and conveys no permission to apply.
pub struct ApplicationPlan {
    operation_id: uuid::Uuid,
    principal: Value,
    agent: Value,
    proposal: Value,
    sources: ConflictRequest,
    identity: VectorSpaceIdentity,
    successor: MemoryRow,
    now: i64,
    semantic_drift: f64,
    fingerprint: String,
}
impl ApplicationPlan {
    fn payload(&self) -> Value {
        json!({
            "version":1, "command":"conflict-apply", "operationId":self.operation_id,
            "principal":self.principal, "agent":self.agent, "proposal":self.proposal,
            "sourceOperationId":self.sources.operation_id, "score":self.sources.score,
            "decision":self.sources.decision.name(),
            "new":self.sources.new.row, "newSharing":self.sources.new.sharing,
            "existing":self.sources.existing.row, "existingSharing":self.sources.existing.sharing,
            "identity":self.identity, "successor":self.successor,
            "createdAt":self.now, "semanticDrift":self.semantic_drift
        })
    }
    fn digest(&self) -> Result<String, EngineError> {
        let bytes = serde_json::to_vec(&self.payload()).map_err(|_| StoreError::Corrupt)?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(format!("sha256:{}", hash(&bytes)))
    }
    /// Complete binding for a later explicit host confirmation. Possessing it grants no authority.
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
    /// Concrete intended change for review, without returning the embedding vector or a proof.
    pub fn review(&self) -> Value {
        json!({
            "command":"conflict-apply", "operationId":self.operation_id,
            "fingerprint":self.fingerprint, "proposalId":self.proposal["operationId"],
            "targetId":self.sources.existing.row.id, "successorId":self.successor.id,
            "oldText":self.sources.existing.row.text, "newText":self.successor.text,
            "reason":self.successor.update_evidence, "semanticDrift":self.semantic_drift,
            "createdAt":self.now, "identity":self.identity
        })
    }
}
impl ConflictLedger {
    /// Build a concrete review plan under current policy, caller, source and private-store leases.
    /// Read access to another agent's shared source never grants mutation of that source.
    pub fn prepare_application(
        &self,
        request: &ApplicationRequest<'_>,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<ApplicationPlan, EngineError> {
        if request.operation_id.is_nil() || !valid_id(request.memory_id) {
            return Err(StoreError::InvalidInput.into());
        }
        let principal_value = serde_json::to_value(principal).map_err(|_| StoreError::Corrupt)?;
        let agent_value = serde_json::to_value(agent).map_err(|_| StoreError::Corrupt)?;
        self.transaction(principal, agent, cancel, |workspace, ctx, check| {
            let (proposal, sources) = self
                .resolution_at(workspace, ctx, check, request.memory_id, cancel)?
                .ok_or(StoreError::InvalidInput)?;
            if proposal != *request.expected_proposal {
                return Err(StoreError::InvalidInput.into());
            }
            let store = self.application_store(&sources.existing, ctx, request.identity)?;
            let parsed = parse_json(&proposal.to_string()).map_err(|_| StoreError::Corrupt)?;
            if conflict_resolution::apply_id(&parsed)?
                != Json::String(sources.existing.row.id.as_str().into())
            {
                return Err(StoreError::InvalidInput.into());
            }
            let text =
                String::from_utf16(conflict_resolution::apply_text(&parsed)?.as_utf16_units())
                    .map_err(|_| StoreError::InvalidInput)?;
            if text.is_empty() || text.len() > 1024 * 1024 || request.vector.len() > 32768 {
                return Err(StoreError::InvalidInput.into());
            }
            crate::embedding::batch::validate_vectors(
                std::slice::from_ref(&request.vector),
                1,
                sources.existing.row.vector.len(),
            )
            .map_err(|_| StoreError::InvalidInput)?;
            let semantic_drift = safe_update::drift(&sources.existing.row.vector, &request.vector);
            if !semantic_drift.is_finite() || semantic_drift > 0.45 {
                return Err(crate::ops::context::error(MemoryOpErrorCode::Conflict));
            }
            // This native apply path accepts textual evidence only; untrusted object coercions
            // remain lossless in proposal storage and never become mutation provenance here.
            let reason = match &proposal["reason"] {
                Value::Null => "conflict apply",
                Value::String(s) if s.is_empty() => "conflict apply",
                Value::String(s) => s,
                _ => return Err(StoreError::InvalidInput.into()),
            };
            let now = self.reader.context.host().now_ms();
            let successor = safe_update_row::successor(
                &sources.existing.row,
                &safe_update::UpdatePatch {
                    text: Some(text),
                    vector: Some(request.vector.clone()),
                    ..Default::default()
                },
                &safe_update::UpdateEvidence {
                    update_source: Some("conflict-resolver".into()),
                    update_evidence: Some(reason.into()),
                    ..Default::default()
                },
                now,
            )?;
            let successor = crate::store::row::persisted_projection(&successor)?;
            if store.get_record(&successor.id)?.is_some() {
                return Err(StoreError::InvalidInput.into());
            }
            let mut plan = ApplicationPlan {
                operation_id: request.operation_id,
                principal: principal_value.clone(),
                agent: agent_value.clone(),
                proposal,
                sources,
                identity: request.identity.clone(),
                successor,
                now,
                semantic_drift,
                fingerprint: String::new(),
            };
            plan.fingerprint = plan.digest()?;
            self.sources(&plan.sources, ctx)?;
            check()?;
            Ok(plan)
        })
    }
    fn application_store(
        &self,
        target: &MemoryRecord,
        ctx: &RequestContext,
        identity: &VectorSpaceIdentity,
    ) -> Result<Arc<Store>, EngineError> {
        let row = &target.row;
        safe_update::authorize(row, ctx)?;
        if row.scope != "agent-private"
            || row.agent_id != ctx.agent_id.as_str()
            || row.stored_by != ctx.agent_id.as_str()
            || row.owner_user_id != ctx.owner_user_id
            || row.workspace_key != ctx.workspace_key
            || target.sharing.is_some()
        {
            return Err(StoreError::InvalidInput.into());
        }
        let identity_id = try_identity_id(identity)?;
        if identity_id != try_identity_id(self.reader.embedding_identity())? {
            return Err(StoreError::InvalidInput.into());
        }
        let mut selected: Option<Arc<Store>> = None;
        for source in self.reader.stores.sources(ctx)? {
            if source.kind != SourceKind::Private {
                continue;
            }
            let Some(actual) = source.store.get_record(&row.id)? else {
                continue;
            };
            if actual.sharing != target.sharing
                || serde_json::to_value(&actual.row).map_err(|_| StoreError::Corrupt)?
                    != serde_json::to_value(row).map_err(|_| StoreError::Corrupt)?
                || try_identity_id(source.store.identity().ok_or(StoreError::InvalidInput)?)?
                    != identity_id
                || selected
                    .as_ref()
                    .is_some_and(|s| !Arc::ptr_eq(s, &source.store))
            {
                return Err(StoreError::InvalidInput.into());
            }
            selected = Some(source.store);
        }
        selected.ok_or_else(|| StoreError::InvalidInput.into())
    }
    /// Revalidate a review plan before presenting/consuming a separate host confirmation.
    /// Success is only a current-source check; this method performs no mutation and grants nothing.
    pub fn validate_application(
        &self,
        plan: &ApplicationPlan,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if serde_json::to_value(principal).map_err(|_| StoreError::Corrupt)? != plan.principal
            || serde_json::to_value(agent).map_err(|_| StoreError::Corrupt)? != plan.agent
            || plan.digest()? != plan.fingerprint
        {
            return Err(StoreError::InvalidInput.into());
        }
        self.transaction(principal, agent, cancel, |workspace, ctx, check| {
            let (proposal, _) = self
                .resolution_at(workspace, ctx, check, &plan.sources.new.row.id, cancel)?
                .ok_or(StoreError::InvalidInput)?;
            if proposal != plan.proposal {
                return Err(StoreError::InvalidInput.into());
            }
            self.sources(&plan.sources, ctx)?;
            let store = self.application_store(&plan.sources.existing, ctx, &plan.identity)?;
            if store.get_record(&plan.successor.id)?.is_some() {
                return Err(StoreError::InvalidInput.into());
            }
            check()
        })
    }
}

#[path = "conflict_application.rs"]
mod apply;
pub use apply::{
    ApplicationAuthorization, ApplicationResult, ConfirmationCheck, ConfirmationVerifier,
};

#[path = "conflict_application_recovery.rs"]
mod recovery;
