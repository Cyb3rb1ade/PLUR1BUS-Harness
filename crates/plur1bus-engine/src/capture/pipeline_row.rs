//! Row construction from capture-owned provenance and narrow classification fields.

use crate::context::RequestContext;
use crate::contract::{Cancel, EngineError, MemoryRow, StoreError, TurnRecord};
use crate::text::legacy::text_utils::generate_summary;

use super::super::epistemic::decide_capture_status;
use super::super::epistemic_cutoff::read_cutoff;
use super::{prepare, row_builder, CapturePipeline, PreparedCapture};

#[derive(Clone, Copy)]
pub(super) struct RowContext<'a> {
    pub turn: &'a TurnRecord,
    pub context: &'a RequestContext,
    pub origin: &'a str,
    pub now: i64,
    pub cancel: &'a Cancel,
}

impl CapturePipeline {
    pub(super) fn row(
        &self,
        id: String,
        prep: &PreparedCapture<prepare::CaptureItem>,
        vector: Vec<f32>,
        request: RowContext<'_>,
    ) -> Result<MemoryRow, EngineError> {
        let RowContext {
            turn,
            context,
            origin,
            now,
            cancel,
        } = request;
        let classification = self.classifier.classify(super::ClassificationRequest {
            text: &prep.text,
            role: &prep.item.role,
            turn,
            context,
            now,
            cancel,
        })?;
        let mut row = row_builder::schema_defaults(vector);
        row.id = id;
        row.text = super::super::output_unicode::external(&prep.text);
        row.summary = generate_summary(
            &row.text,
            self.config["summaryMaxWords"].as_u64().unwrap_or(150) as usize,
        );
        row.origin = origin.into();
        row.importance = serde_json::Number::from_f64(0.5).ok_or(StoreError::InvalidInput)?;
        row.importance_status = "pending".into();
        row.category = classification.category;
        row.created_at = now.into();
        row.stored_by = context.agent_id.to_string();
        row.source_turn_id = turn.run_id.clone().unwrap_or_default();
        row.chunk_group_id = prep.chunk_group_id.clone().unwrap_or_default();
        row.source_message_role = prep.item.role.clone();
        row.epistemic_status =
            decide_capture_status(&prep.text, &prep.item.role, origin, self.cutoff_failed)?.into();
        let cutoff = read_cutoff(&self.base_db);
        if row.epistemic_status == "observed"
            && matches!(
                cutoff.reason,
                "cutoff_missing_after_upgrade" | "cutoff_read_error"
            )
        {
            row.epistemic_status = "untrusted".into();
        }
        row.source_timestamp = now.into();
        row.source_url = super::super::output_unicode::external(&prep.item.source_url);
        row.evidence_quote =
            super::super::output_unicode::external(&prep.item.text.utf16_slice(0, 200));
        row.emotional_valence = classification.emotional_valence;
        row.emotional_intensity = number(classification.emotional_intensity)?;
        row.emotional_dominant = classification.emotional_dominant;
        row.mood_context_at_capture = classification.mood_context_at_capture;
        row.emotion_status = classification.emotion_status;
        let dynamics = classification.dynamics;
        row.memory_strength = number(dynamics.memory_strength)?;
        row.half_life_days = number(dynamics.half_life_days)?;
        row.last_strengthened_at = number(dynamics.last_strengthened_at)?;
        row.last_dynamics_at = number(dynamics.last_dynamics_at)?;
        row.memory_class = dynamics.memory_class;
        row.never_forget = number(dynamics.never_forget)?;
        row.core_memory_score = number(dynamics.core_memory_score)?;
        row.core_memory_reason = dynamics.core_memory_reason;
        row.version_created_at = now.into();
        row.updated_at = now.into();
        Ok(row)
    }
}

fn number(value: f64) -> Result<serde_json::Number, EngineError> {
    serde_json::Number::from_f64(value).ok_or_else(|| StoreError::InvalidInput.into())
}
