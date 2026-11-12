//! Restart reconstructs only complete saved plans and restores their original callers.
use super::*;
use crate::store::shared_row::ShareMetadata;
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Saved {
    version: u8,
    command: String,
    operation_id: uuid::Uuid,
    principal: Value,
    agent: Value,
    proposal: Value,
    source_operation_id: uuid::Uuid,
    score: f64,
    decision: String,
    new: MemoryRow,
    new_sharing: Option<ShareMetadata>,
    existing: MemoryRow,
    existing_sharing: Option<ShareMetadata>,
    identity: VectorSpaceIdentity,
    successor: MemoryRow,
    created_at: i64,
    semantic_drift: f64,
}
impl ApplicationPlan {
    pub(crate) fn original_caller(&self) -> Result<(Principal, AgentContext), EngineError> {
        Ok((
            serde_json::from_value(self.principal.clone()).map_err(|_| StoreError::Corrupt)?,
            serde_json::from_value(self.agent.clone()).map_err(|_| StoreError::Corrupt)?,
        ))
    }
    pub(crate) fn operation_id(&self) -> uuid::Uuid {
        self.operation_id
    }
    pub(crate) fn from_saved(
        value: &Value,
        fingerprint: String,
        cancel: &Cancel,
    ) -> Result<Self, EngineError> {
        cancel.check()?;
        let saved: Saved =
            serde_json::from_value(value.clone()).map_err(|_| StoreError::Corrupt)?;
        if saved.version != 1
            || saved.command != "conflict-apply"
            || saved.operation_id.is_nil()
            || saved.source_operation_id.is_nil()
            || !saved.score.is_finite()
            || !(0. ..=1.).contains(&saved.score)
            || !valid_id(&saved.new.id)
            || !valid_id(&saved.existing.id)
            || saved.new.id == saved.existing.id
            || !valid_id(&saved.successor.id)
            || saved.successor.id == saved.new.id
            || saved.successor.id == saved.existing.id
        {
            return Err(StoreError::Corrupt.into());
        }
        let plan = ApplicationPlan {
            operation_id: saved.operation_id,
            principal: saved.principal,
            agent: saved.agent,
            proposal: saved.proposal,
            sources: ConflictRequest {
                operation_id: saved.source_operation_id,
                new: MemoryRecord {
                    row: saved.new,
                    sharing: saved.new_sharing,
                },
                existing: MemoryRecord {
                    row: saved.existing,
                    sharing: saved.existing_sharing,
                },
                score: saved.score,
                decision: match saved.decision.as_str() {
                    "stored_separately" => MergeDecision::StoredSeparately,
                    "no_merge_llm_call" => MergeDecision::NoMergeLlmCall,
                    _ => return Err(StoreError::Corrupt.into()),
                },
            },
            identity: saved.identity,
            successor: saved.successor,
            now: saved.created_at,
            semantic_drift: saved.semantic_drift,
            fingerprint,
        };
        if plan.payload() != *value || plan.digest()? != plan.fingerprint {
            return Err(StoreError::Corrupt.into());
        }
        plan.original_caller()?;
        resolutions::validate_original(&plan.proposal["original"], &plan.sources)?;
        let digest = request_digest(&plan.sources)?;
        if plan.proposal["sourceDigest"] != digest
            || plan.proposal["original"]["requestDigest"] != digest
            || plan.proposal["original"]["operationId"] != plan.sources.operation_id.to_string()
            || plan.proposal["recommendation"] != "apply_via_safe_reconsolidation"
            || plan.proposal["dryRun"] != false
        {
            return Err(StoreError::Corrupt.into());
        }
        let proposal = parse_json(&plan.proposal.to_string()).map_err(|_| StoreError::Corrupt)?;
        let projected = conflict_resolution::proposal(
            &parse_json(&plan.proposal["original"].to_string()).map_err(|_| StoreError::Corrupt)?,
            &proposal,
            plan.now,
            cancel,
        )?;
        let projected: Value = serde_json::from_str(&crate::text::json::write_json(&projected))
            .map_err(|_| StoreError::Corrupt)?;
        if projected["recommendation"] != "apply_via_safe_reconsolidation"
            || conflict_resolution::apply_id(&proposal)?
                != Json::String(plan.sources.existing.row.id.as_str().into())
        {
            return Err(StoreError::Corrupt.into());
        }
        let text = String::from_utf16(conflict_resolution::apply_text(&proposal)?.as_utf16_units())
            .map_err(|_| StoreError::Corrupt)?;
        if text.is_empty() || text.len() > 1024 * 1024 || plan.successor.vector.len() > 32768 {
            return Err(StoreError::Corrupt.into());
        }
        crate::embedding::batch::validate_vectors(
            std::slice::from_ref(&plan.successor.vector),
            1,
            plan.sources.existing.row.vector.len(),
        )
        .map_err(|_| StoreError::Corrupt)?;
        let drift = safe_update::drift(&plan.sources.existing.row.vector, &plan.successor.vector);
        if !drift.is_finite() || drift > 0.45 || drift != plan.semantic_drift {
            return Err(StoreError::Corrupt.into());
        }
        let reason = match &plan.proposal["reason"] {
            Value::Null => "conflict apply",
            Value::String(s) if s.is_empty() => "conflict apply",
            Value::String(s) => s,
            _ => return Err(StoreError::Corrupt.into()),
        };
        let mut expected = safe_update_row::successor(
            &plan.sources.existing.row,
            &safe_update::UpdatePatch {
                text: Some(text),
                vector: Some(plan.successor.vector.clone()),
                ..Default::default()
            },
            &safe_update::UpdateEvidence {
                update_source: Some("conflict-resolver".into()),
                update_evidence: Some(reason.into()),
                ..Default::default()
            },
            plan.now,
        )?;
        expected.id.clone_from(&plan.successor.id);
        let expected = crate::store::row::persisted_projection(&expected)?;
        if serde_json::to_value(expected).map_err(|_| StoreError::Corrupt)?
            != serde_json::to_value(&plan.successor).map_err(|_| StoreError::Corrupt)?
        {
            return Err(StoreError::Corrupt.into());
        }
        cancel.check()?;
        Ok(plan)
    }
}
impl ConflictLedger {
    /// Open the conflict application component only after original-caller recovery succeeds.
    /// No confirmation is minted or inferred during restart.
    pub fn open(
        reader: Arc<MemoryReader>,
        journal: Arc<CaptureJournal>,
    ) -> Result<Self, EngineError> {
        let ledger = Self::new(reader, journal);
        ledger.recover_applications(&Cancel::never())?;
        Ok(ledger)
    }
    /// Bound inventory, preflight every pending original plan, then resume its primary commit.
    /// This is component startup; ProcessEngine activation remains a separate composition step.
    pub fn recover_applications(&self, cancel: &Cancel) -> Result<usize, EngineError> {
        let cancel =
            cancel.limited_to(std::time::Instant::now() + std::time::Duration::from_secs(300));
        let plans = self.journal.conflict_application_plans(&cancel)?;
        for plan in &plans {
            let (principal, agent) = plan.original_caller()?;
            self.settle_application(plan, None, &principal, &agent, &cancel, true)?;
        }
        for plan in &plans {
            let (principal, agent) = plan.original_caller()?;
            self.settle_application(plan, None, &principal, &agent, &cancel, false)?;
        }
        Ok(plans.len())
    }
}
