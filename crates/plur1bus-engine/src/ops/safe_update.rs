//! Native safeUpdate: authorize before idempotency; commit the successor before hiding its source.
use super::{context::error, correction::CorrectionEffects, memory::valid_id, write::MemoryWriter};
use crate::{
    context::RequestContext,
    contract::{
        AgentContext, Cancel, EngineError, MemoryOpErrorCode, MemoryRow, Principal, StoreError,
    },
    recall::acl,
    store::{tombstone::TombstoneRegistry, RowPatch, Store},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

/// Narrow content/metadata patch. Ownership and confirmation cannot be patched here.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdatePatch {
    /// Replacement text; presence creates a new version even when unchanged.
    pub text: Option<String>,
    /// Replacement summary.
    pub summary: Option<String>,
    /// Active embedding space's replacement vector, supplied by the native caller.
    pub vector: Option<Vec<f32>>,
    /// Explicit importance ends pending refinement.
    pub importance: Option<f64>,
    /// Explicit category.
    pub category: Option<String>,
}
/// Provenance, required for semantic content patches.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateEvidence {
    /// Native operation source.
    pub update_source: Option<String>,
    /// Evidence supporting this revision; never diagnostic output.
    pub update_evidence: Option<String>,
    /// Caller supplied confidence.
    pub confidence: Option<f64>,
}
/// Native request, not a new RPC or frozen Engine interface.
pub struct UpdateRequest<'a> {
    /// Existing source card.
    pub id: &'a str,
    /// Narrow changes.
    pub patch: UpdatePatch,
    /// Revision provenance.
    pub evidence: UpdateEvidence,
    /// Explicit native policy decision, e.g. an authoritative user correction.
    pub skip_drift_gate: bool,
}
/// Pinned safeUpdate result. Optional Neo effects are not a durable audit acknowledgement.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    /// Original row.
    pub old_id: String,
    /// Original row for inline/skipped operations, otherwise the durable successor.
    pub new_id: String,
    /// Resulting version number.
    pub version_number: f64,
    /// No successor was created.
    pub inline: bool,
    /// Idempotency event already exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
}
impl MemoryWriter {
    /// Reconcile an authenticated private card using the host timestamp.
    pub fn safe_update(
        &self,
        request: &UpdateRequest<'_>,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<UpdateResult, EngineError> {
        self.safe_update_at(
            request,
            principal,
            agent,
            cancel,
            self.context.host().now_ms(),
        )
    }
    /// Same operation with a captured timestamp. The runtime shares this mutation gate
    /// with foreground writes and holds the exclusive engine generation writer lease.
    pub fn safe_update_at(
        &self,
        request: &UpdateRequest<'_>,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
        now: i64,
    ) -> Result<UpdateResult, EngineError> {
        cancel.check()?;
        let operation = self.context.enter(principal, agent)?;
        let ctx = &operation.context;
        if !valid_id(request.id) {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let _mutation = self.context.mutation()?;
        cancel.check()?;
        let store = self
            .stores
            .existing_private(ctx)
            .map_err(storage)?
            .ok_or_else(|| error(MemoryOpErrorCode::NotFound))?;
        let old = store
            .get(request.id)
            .map_err(storage)?
            .ok_or_else(|| error(MemoryOpErrorCode::NotFound))?;
        authorize(&old, ctx)?;
        if TombstoneRegistry::new(&self.base, ctx.agent_id.as_str())
            .map_err(storage)?
            .find_by_origin(request.id, false)
            .map_err(storage)?
            .is_some()
        {
            return Err(error(MemoryOpErrorCode::NotFound));
        }
        let services = self
            .corrections
            .as_ref()
            .ok_or_else(|| error(MemoryOpErrorCode::Storage))?;
        let identity = store
            .identity()
            .ok_or_else(|| error(MemoryOpErrorCode::EmbeddingIdentityMismatch))?;
        if crate::embedding::identity::try_identity_id(identity).map_err(storage)?
            != crate::embedding::identity::try_identity_id(services.embedder.identity())
                .map_err(storage)?
        {
            return Err(error(MemoryOpErrorCode::EmbeddingIdentityMismatch));
        }
        apply(
            &*store,
            &old,
            request,
            ctx,
            services.effects.as_deref(),
            cancel,
            now,
        )
    }
}
fn storage(_: StoreError) -> EngineError {
    error(MemoryOpErrorCode::Storage)
}
fn authorize(old: &MemoryRow, ctx: &RequestContext) -> Result<(), EngineError> {
    // Private-row mutation honors every explicit binding, even though the read ACL
    // selects its primary rule by scope. Never reuse a foreign workspace or owner.
    let mut memory =
        acl::AclMemory::from_row(old).ok_or_else(|| error(MemoryOpErrorCode::NotFound))?;
    let subject = acl::AclSubject::from_context(ctx);
    for (present, scope) in [
        (
            !old.workspace_id.is_empty() || !old.workspace_key.is_empty(),
            "workspace",
        ),
        (!old.owner_user_id.is_empty(), "user"),
    ] {
        if present {
            memory.scope = scope.into();
            if acl::check_access(Some(&subject), Some(&memory)).is_err() {
                return Err(error(MemoryOpErrorCode::NotFound));
            }
        }
    }

    // Read access to a shared copy never grants a content mutation on its origin.
    if acl::allowed(old, ctx).is_err()
        || old.scope != "agent-private"
        || (!old.agent_id.is_empty() && old.agent_id != ctx.agent_id.as_str())
        || (!old.stored_by.is_empty() && old.stored_by != ctx.agent_id.as_str())
        || (!old.status.is_empty() && old.status != "active")
    {
        return Err(error(MemoryOpErrorCode::NotFound));
    }
    Ok(())
}
trait Database {
    fn store(&self, row: &MemoryRow) -> Result<(), StoreError>;
    fn patch(&self, id: &str, patch: &RowPatch) -> Result<(), StoreError>;
}
impl Database for Store {
    fn store(&self, row: &MemoryRow) -> Result<(), StoreError> {
        self.upsert(std::slice::from_ref(row))
    }
    fn patch(&self, id: &str, patch: &RowPatch) -> Result<(), StoreError> {
        Store::patch(self, id, patch)
    }
}
fn key(old: &MemoryRow, p: &UpdatePatch, e: &UpdateEvidence) -> String {
    let number = p
        .importance
        .map(|n| ryu_js::Buffer::new().format(n).to_owned())
        .unwrap_or_default();
    format!(
        "{:x}",
        Sha256::digest(
            [
                old.id.as_str(),
                e.update_source.as_deref().unwrap_or(""),
                e.update_evidence.as_deref().unwrap_or(""),
                p.text.as_deref().unwrap_or(""),
                p.summary.as_deref().unwrap_or(""),
                &number,
                p.category.as_deref().unwrap_or("")
            ]
            .join("\n")
            .as_bytes()
        )
    )
}
fn drift(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() {
        return 1.;
    }
    let (mut dot, mut aa, mut bb) = (0., 0., 0.);
    for (&x, &y) in a.iter().zip(b) {
        let (x, y) = (f64::from(x), f64::from(y));
        dot += x * y;
        aa += x * x;
        bb += y * y;
    }
    let den = aa.sqrt() * bb.sqrt();
    if den == 0. {
        1.
    } else {
        1. - dot / den
    }
}
#[allow(
    clippy::too_many_arguments,
    reason = "one authenticated source and captured operation inputs"
)]
fn apply(
    db: &dyn Database,
    old: &MemoryRow,
    r: &UpdateRequest<'_>,
    ctx: &RequestContext,
    effects: Option<&dyn CorrectionEffects>,
    cancel: &Cancel,
    now: i64,
) -> Result<UpdateResult, EngineError> {
    authorize(old, ctx)?;
    let (p, e) = (&r.patch, &r.evidence);
    let content = p.text.is_some() || p.summary.is_some();
    if (content
        && (e.update_source.as_ref().is_none_or(String::is_empty)
            || e.update_evidence.as_ref().is_none_or(String::is_empty)))
        || p.importance.is_some_and(|n| !n.is_finite())
        || e.confidence.is_some_and(|n| !n.is_finite())
    {
        return Err(error(MemoryOpErrorCode::InvalidInput));
    }
    let idempotency = key(old, p, e);
    cancel.check()?;
    if effects
        .map(|x| x.contains(ctx, &idempotency))
        .transpose()
        .map_err(storage)?
        .unwrap_or(false)
    {
        return Ok(UpdateResult {
            old_id: old.id.clone(),
            new_id: old.id.clone(),
            version_number: old.version_number.as_f64().unwrap_or(1.),
            inline: true,
            skipped: Some(true),
        });
    }
    if content && p.vector.is_none() {
        return Err(error(MemoryOpErrorCode::InvalidInput));
    }
    if let Some(v) = &p.vector {
        crate::embedding::batch::validate_vectors(std::slice::from_ref(v), 1, old.vector.len())
            .map_err(|_| error(MemoryOpErrorCode::InvalidInput))?;
    }
    let inline = !content && (p.vector.is_some() || p.importance.is_some() || p.category.is_some());
    let semantic_drift = if inline {
        0.
    } else {
        p.vector.as_ref().map_or(0., |v| drift(&old.vector, v))
    };
    if !inline && !r.skip_drift_gate && semantic_drift > 0.45 {
        return Err(error(MemoryOpErrorCode::Conflict));
    }
    cancel.check()?;
    let (new_id, version) = if inline {
        db.patch(
            &old.id,
            &RowPatch {
                importance: p.importance,
                importance_status: p.importance.map(|_| "final".into()),
                category: p.category.clone(),
                vector: p.vector.clone(),
                update_source: e.update_source.clone(),
                update_evidence: e.update_evidence.clone(),
                reconsolidation_confidence: e.confidence,
                updated_at: Some(now as f64),
                ..Default::default()
            },
        )
        .map_err(storage)?;
        (old.id.clone(), old.version_number.as_f64().unwrap_or(1.))
    } else {
        let next = super::safe_update_row::successor(old, p, e, now)?;
        db.store(&next).map_err(storage)?;
        // No cancellation cut between the two writes: finish superseding once the
        // replacement is durable. A patch error leaves a recoverable active fork.
        db.patch(
            &old.id,
            &RowPatch {
                status: Some("superseded".into()),
                superseded_by: Some(next.id.clone()),
                updated_at: Some(now as f64),
                ..Default::default()
            },
        )
        .map_err(storage)?;
        if let Some(effects) = effects {
            let _ = effects.rewrite_edges(ctx, old, &next.id);
        }
        (next.id, next.version_number.as_f64().unwrap_or(1.))
    };
    if let Some(effects) = effects {
        let mut event = json!({"id":uuid::Uuid::new_v4().to_string(),"idempotencyKey":idempotency,"oldMemoryId":old.id,"newMemoryId":new_id,"action":if inline{"metadata_update"}else{"version"},"updateSource":e.update_source.as_deref().unwrap_or(""),"updateEvidence":e.update_evidence.as_deref().unwrap_or(""),"confidence":e.confidence.unwrap_or(0.),"semanticDrift":semantic_drift,"createdAt":now});
        let status = crate::recall::score::normalize_epistemic_status(&old.epistemic_status);
        if !inline && matches!(status, "trusted" | "corroborated") {
            event["previousEpistemicStatus"] = json!(status);
            event["newEpistemicStatus"] = json!("observed");
        }
        let _ = effects.record(ctx, old, &event);
    }
    Ok(UpdateResult {
        old_id: old.id.clone(),
        new_id,
        version_number: version,
        inline,
        skipped: None,
    })
}

#[cfg(test)]
#[path = "safe_update_tests.rs"]
mod tests;
