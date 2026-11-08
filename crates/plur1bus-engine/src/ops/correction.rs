//! Archive-first foreground correction; persist the successor before superseding the source.
use super::{archive, context::error, memory::valid_id, write::MemoryWriter};
use crate::{
    context::RequestContext,
    contract::{
        AgentContext, Cancel, EngineError, MemoryCorrectResult, MemoryOpErrorCode, MemoryRow,
        Principal, StoreError,
    },
    embedding::{EmbedKind, EmbeddingProvider},
    recall::{acl, lifecycle::is_recall_entry_live, memory_sanitize},
    store::{tombstone::TombstoneRegistry, RowPatch},
    text::js::{js_trim, JsString},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Request-bound Neo effects. Implementations must enforce the requesting source ACL
/// and preserve the tightest source scope on every rewritten edge and event.
pub trait CorrectionEffects: Send + Sync {
    /// Check the last 1,000 authorized reconsolidation events; read failure aborts the correction.
    fn contains(&self, context: &RequestContext, key: &str) -> Result<bool, StoreError>;
    /// Rewrite authorized edges referencing the old row, preserving their other fields.
    fn rewrite_edges(
        &self,
        context: &RequestContext,
        old: &MemoryRow,
        new_id: &str,
    ) -> Result<(), StoreError>;
    /// Append a source-bound reconsolidation event.
    fn record(
        &self,
        context: &RequestContext,
        source: &MemoryRow,
        event: &Value,
    ) -> Result<(), StoreError>;
}
/// Providers used only after authorization and a durable archive.
pub struct CorrectionServices {
    /// Embedding provider for the active destination identity.
    pub embedder: Arc<dyn EmbeddingProvider>,
    /// Absent only when Neo is disabled; runtime composition supplies the authorized service.
    pub effects: Option<Arc<dyn CorrectionEffects>>,
}
impl MemoryWriter {
    /// Configure correction providers without changing existing forget-only construction.
    #[must_use]
    pub fn with_corrections(mut self, services: CorrectionServices) -> Self {
        self.corrections = Some(services);
        self
    }
    /// Correct an owned live card with one captured host timestamp.
    pub fn correct(
        &self,
        id: &str,
        new_text: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryCorrectResult, EngineError> {
        self.correct_at(id, new_text, principal, agent, self.context.host().now_ms())
    }
    /// Correct at an explicit operation time; shared-copy delegation is composed separately.
    pub fn correct_at(
        &self,
        id: &str,
        new_text: &str,
        principal: &Principal,
        agent: &AgentContext,
        now: i64,
    ) -> Result<MemoryCorrectResult, EngineError> {
        let operation = self.context.enter(principal, agent)?;
        let ctx = &operation.context;
        self.context.destructive_workspace(ctx)?;
        let new_text = js_trim(new_text);
        if !valid_id(id) || new_text.is_empty() || new_text.encode_utf16().count() > 8000 {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let _mutation = self.context.mutation()?;
        self.correct_locked(id, new_text, ctx, now)
    }
    pub(super) fn correct_locked(
        &self,
        id: &str,
        new_text: &str,
        ctx: &RequestContext,
        now: i64,
    ) -> Result<MemoryCorrectResult, EngineError> {
        let workspace = self.context.destructive_workspace(ctx)?;
        let store = self.stores.existing_private(ctx).map_err(storage)?;
        let old = store
            .as_ref()
            .map(|store| store.get(id))
            .transpose()
            .map_err(storage)?
            .flatten()
            .filter(|row| acl::allowed(row, ctx).is_ok() && is_recall_entry_live(row, now, None));
        let Some(old) = old else {
            let card = self.require_shared(id, ctx, now)?;
            let refreshed = self.refresh_locked(&card, new_text, ctx, now, "MemoryOps.correct")?;
            return serde_json::from_value(json!({"id":refreshed.shared_id,"archived":true}))
                .map_err(|_| error(MemoryOpErrorCode::Storage));
        };
        let store = store.ok_or_else(|| error(MemoryOpErrorCode::NotFound))?;
        // A restored live copy remains forgotten even before startup reconciliation.
        let owner = if old.agent_id.is_empty() {
            &old.stored_by
        } else {
            &old.agent_id
        };
        if TombstoneRegistry::new(&self.base, owner)
            .map_err(storage)?
            .find_by_origin(id, false)
            .map_err(storage)?
            .is_some()
        {
            return Err(error(MemoryOpErrorCode::NotFound));
        }
        let archive = archive::archive(
            &old,
            ctx.agent_id.as_str(),
            self.context.host().state_dir(),
            now,
        )?;
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
        let mut vectors = services
            .embedder
            .embed(&[new_text.to_owned()], EmbedKind::Passage, &Cancel::never())
            .map_err(|_| error(MemoryOpErrorCode::Storage))?;
        if vectors.len() != 1 {
            return Err(error(MemoryOpErrorCode::Storage));
        }
        let vector = vectors.remove(0);
        let before = if old.text.is_empty() {
            &old.summary
        } else {
            &old.text
        };
        let evidence = if before.is_empty() {
            "User correction via /correct".to_owned()
        } else {
            format!(
                "User corrected \"{}\" to \"{new_text}\"",
                memory_sanitize::evidence(&JsString::from(before.as_str()), 300).to_utf8_lossy()
            )
        };
        let first = new_text.split_once('\n').map_or(new_text, |(line, _)| {
            line.strip_suffix('\r').unwrap_or(line)
        });
        // Stored Arrow strings and the raw-string hash use Node's UTF-8/U+FFFD boundary,
        // unlike F3's visible prompt output. Do not use presentation normalization here.
        let summary = JsString::from(first).utf16_slice(0, 200).to_utf8_lossy();
        let key = format!(
            "{:x}",
            Sha256::digest(
                format!("{id}\nuser_correction\n{evidence}\n{new_text}\n{summary}\n\n").as_bytes()
            )
        );
        let skipped = services
            .effects
            .as_ref()
            .map(|effects| effects.contains(ctx, &key))
            .transpose()
            .map_err(storage)?
            .unwrap_or(false);
        let new_id = if skipped {
            old.id.clone()
        } else {
            let successor = successor(&old, new_text, &summary, &vector, &evidence, now)?;
            store
                .upsert(std::slice::from_ref(&successor))
                .map_err(|failure| {
                    error(if matches!(failure, StoreError::TombstoneBlocked) {
                        MemoryOpErrorCode::Conflict
                    } else {
                        MemoryOpErrorCode::Storage
                    })
                })?;
            store
                .patch(
                    id,
                    &RowPatch {
                        status: Some("superseded".into()),
                        superseded_by: Some(successor.id.clone()),
                        updated_at: Some(now as f64),
                        ..RowPatch::default()
                    },
                )
                .map_err(storage)?;
            if let Some(effects) = &services.effects {
                // Node isolates optional Neo effects after the durable version boundary.
                let _ = effects.rewrite_edges(ctx, &old, &successor.id);
                let mut event = json!({"id":uuid::Uuid::new_v4().to_string(),"idempotencyKey":key,"oldMemoryId":id,
                    "newMemoryId":successor.id,"action":"version","updateSource":"user_correction","updateEvidence":evidence,
                    "confidence":1,"semanticDrift":drift(&old.vector,&successor.vector),"createdAt":now});
                if matches!(old.epistemic_status.as_str(), "trusted" | "corroborated") {
                    event["previousEpistemicStatus"] = json!(old.epistemic_status);
                    event["newEpistemicStatus"] = json!("observed");
                }
                let _ = effects.record(ctx, &old, &event);
            }
            successor.id
        };
        if let Ok(Some(row)) = store.get(&new_id) {
            let _ = store.patch(
                &new_id,
                &super::correction_dynamics::reinforcement(&row, now),
            );
        }
        // D129: audit failure cannot masquerade as a fully completed human operation.
        archive::audit(
            &workspace,
            &json!({"event":"memory.updated","source":"telegram_correct","agentId":ctx.agent_id,"memoryId":id,
            "archivePath":archive.to_str().ok_or_else(||error(MemoryOpErrorCode::Storage))?,"timestamp":archive::iso(now)?}),
        )?;
        serde_json::from_value(json!({"id":new_id,"archived":true}))
            .map_err(|_| error(MemoryOpErrorCode::Storage))
    }
}
fn storage(_: StoreError) -> EngineError {
    error(MemoryOpErrorCode::Storage)
}
fn successor(
    old: &MemoryRow,
    text: &str,
    summary: &str,
    vector: &[f32],
    evidence: &str,
    now: i64,
) -> Result<MemoryRow, EngineError> {
    super::safe_update_row::successor(
        old,
        &super::safe_update::UpdatePatch {
            text: Some(text.into()),
            summary: Some(summary.into()),
            vector: Some(vector.into()),
            ..Default::default()
        },
        &super::safe_update::UpdateEvidence {
            update_source: Some("user_correction".into()),
            update_evidence: Some(evidence.into()),
            confidence: Some(1.),
        },
        now,
    )
}

fn drift(old: &[f32], new: &[f32]) -> f64 {
    if old.len() != new.len() {
        return 1.;
    }
    let (mut dot, mut a, mut b) = (0., 0., 0.);
    for (&x, &y) in old.iter().zip(new) {
        let (x, y) = (f64::from(x), f64::from(y));
        dot += x * y;
        a += x * x;
        b += y * y;
    }
    let denominator = a.sqrt() * b.sqrt();
    if denominator == 0. {
        1.
    } else {
        (1. - dot / denominator).clamp(0., 2.)
    }
}
