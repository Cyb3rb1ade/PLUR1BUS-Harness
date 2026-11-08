//! Finished-card row construction; no LLM work and no capture-turn side effects.
use super::context::error;
use crate::{
    capture::{
        categorize::categorize_memory_with_reason, dynamics::apply_dynamics_defaults,
        fact_quality::compute_memory_importance, row_defaults::schema_defaults,
    },
    context::RequestContext,
    contract::{EngineError, MemoryOpErrorCode, MemoryRow},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue},
        legacy::text_utils::generate_summary,
    },
};
use serde_json::{json, Value};

/// Validated, classified import input. Source reference retains the pre-Arrow UTF-16 cut.
#[derive(Clone)]
pub(super) struct ImportPlan {
    pub id: String,
    pub key: String,
    pub text: String,
    pub kind: Option<String>,
    pub scope: String,
    pub owner: String,
    pub workspace: String,
    pub source: JsString,
    pub created_at: f64,
}

/// Host configuration shared with capture; no caller-controlled classification settings.
pub struct ImportEncoding {
    /// Category half-life overrides from validated engine configuration.
    pub half_life_overrides: TolerantJsonValue,
    /// Enables the Node flashbulb half-life floor.
    pub flashbulb: bool,
    /// Maximum generated summary word count.
    pub summary_max_words: usize,
}
impl Default for ImportEncoding {
    fn default() -> Self {
        Self {
            half_life_overrides: TolerantJsonValue::Object(vec![]),
            flashbulb: false,
            summary_max_words: 150,
        }
    }
}

pub(super) fn build(
    plan: &ImportPlan,
    context: &RequestContext,
    vector: &[f32],
    now: i64,
    encoding: &ImportEncoding,
) -> Result<MemoryRow, EngineError> {
    let text = JsString::from(plan.text.as_str());
    let (category, reason) = if let Some(kind) = &plan.kind {
        (kind.as_str(), "caller-provided")
    } else {
        let category = categorize_memory_with_reason(&text)?;
        (category.category, category.reason)
    };
    let importance =
        compute_memory_importance(&text, Some(&JsString::from(reason)), None)?.importance;
    let entry = json!({
        "id":plan.id, "text":plan.text,
        "summary":generate_summary(&plan.text,encoding.summary_max_words),
        "origin":"internal", "vector":vector, "importance":importance, "category":category,
        "createdAt":plan.created_at, "mergedFrom":"[]", "expiresAt":0,
        "agentId":context.agent_id, "storedBy":context.agent_id,
        "workspaceId":plan.workspace, "workspaceKey":plan.workspace, "ownerUserId":plan.owner,
        "sourceTurnId":"", "sourceMessageRole":"", "sourceTimestamp":now,
        "sourceUrl":plan.source.to_utf8_lossy(), "evidenceQuote":"", "scope":plan.scope,
        "validFrom":0, "validUntil":0,
        // Internal imported content can never gain the user-role 'observed' trust value.
        "epistemicStatus":"untrusted"
    });
    let entry = parse_json(&entry.to_string()).map_err(|_| error(MemoryOpErrorCode::Storage))?;
    let options = TolerantJsonValue::Object(vec![(
        "flashbulbEncodingEnabled".into(),
        TolerantJsonValue::Bool(encoding.flashbulb),
    )]);
    let dynamics =
        apply_dynamics_defaults(&entry, now as f64, &encoding.half_life_overrides, &options);
    let mut row = serde_json::to_value(schema_defaults(vec![]))
        .map_err(|_| error(MemoryOpErrorCode::Storage))?;
    let applied: Value = serde_json::from_str(&write_json(&dynamics))
        .map_err(|_| error(MemoryOpErrorCode::Storage))?;
    let (Some(row_fields), Some(applied)) = (row.as_object_mut(), applied.as_object()) else {
        return Err(error(MemoryOpErrorCode::Storage));
    };
    row_fields.extend(applied.clone());
    serde_json::from_value(row).map_err(|_| error(MemoryOpErrorCode::Storage))
}
