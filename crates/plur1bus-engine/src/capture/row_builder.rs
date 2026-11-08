//! Typed capture-row defaults and exact Node-schema JSON serialization.
//!
//! Bootstrap defaults are recorded from Lance version 1 of the pinned Node-created table.
//! Capture supplies provenance, classifications and dynamics before persisting a real row.

use crate::contract::{MemoryRow, StoreError};
use crate::text::js::JsString;
use crate::text::json::{write_json, TolerantJsonValue};

/// Shared bootstrap defaults, also used by import and runtime probes.
pub use super::row_defaults::schema_defaults;

fn numeric(value: &serde_json::Number) -> Result<TolerantJsonValue, StoreError> {
    let value = value.as_f64().ok_or(StoreError::InvalidInput)?;
    Ok(TolerantJsonValue::Number(number_json(value)))
}

// Same ECMAScript display ranges as the already-ported checkpoint digest. MemoryRow's
// generated field order is alphabetical, so it is not used as a serialization oracle.
fn number_json(value: f64) -> String {
    if !value.is_finite() {
        return "null".into();
    }
    if value == 0.0 {
        return "0".into();
    }
    let raw = value.abs().to_string();
    let decimal = raw.find('.').unwrap_or(raw.len());
    let digits = raw.replace('.', "");
    let first = digits.find(|character| character != '0').unwrap_or(0);
    let exponent = decimal as i32 - first as i32 - 1;
    let digits = digits[first..].trim_end_matches('0');
    let sign = if value < 0.0 { "-" } else { "" };
    if !(-6..21).contains(&exponent) {
        let fraction = if digits.len() > 1 {
            format!(".{}", &digits[1..])
        } else {
            String::new()
        };
        return format!(
            "{sign}{}{fraction}e{}{exponent}",
            &digits[..1],
            if exponent >= 0 { "+" } else { "" }
        );
    }
    let point = exponent + 1;
    if point <= 0 {
        return format!("{sign}0.{}{digits}", "0".repeat((-point) as usize));
    }
    let point = point as usize;
    if point >= digits.len() {
        return format!("{sign}{digits}{}", "0".repeat(point - digits.len()));
    }
    format!("{sign}{}.{}", &digits[..point], &digits[point..])
}

/// Serialize every persisted column in the pinned Node Arrow-schema order.
/// JS numeric formatting, including integer-looking floats, is retained. The caller still
/// owns volatile-field normalization; this function never removes or sorts fields.
/// Invalid numeric arguments return a content-free store error.
pub fn to_node_json(row: &MemoryRow) -> Result<String, StoreError> {
    let fields = vec![
        (
            JsString::from("id"),
            TolerantJsonValue::String(JsString::from(row.id.as_str())),
        ),
        (
            JsString::from("type"),
            TolerantJsonValue::String(JsString::from(row.type_.as_str())),
        ),
        (
            JsString::from("confirmed"),
            TolerantJsonValue::Bool(row.confirmed),
        ),
        (
            JsString::from("text"),
            TolerantJsonValue::String(JsString::from(row.text.as_str())),
        ),
        (
            JsString::from("summary"),
            TolerantJsonValue::String(JsString::from(row.summary.as_str())),
        ),
        (
            JsString::from("origin"),
            TolerantJsonValue::String(JsString::from(row.origin.as_str())),
        ),
        (
            JsString::from("vector"),
            TolerantJsonValue::Array(
                row.vector
                    .iter()
                    .map(|value| TolerantJsonValue::Number(number_json(f64::from(*value))))
                    .collect(),
            ),
        ),
        (JsString::from("importance"), numeric(&row.importance)?),
        (
            JsString::from("category"),
            TolerantJsonValue::String(JsString::from(row.category.as_str())),
        ),
        (JsString::from("createdAt"), numeric(&row.created_at)?),
        (
            JsString::from("mergedFrom"),
            TolerantJsonValue::String(JsString::from(row.merged_from.as_str())),
        ),
        (JsString::from("expiresAt"), numeric(&row.expires_at)?),
        (
            JsString::from("agentId"),
            TolerantJsonValue::String(JsString::from(row.agent_id.as_str())),
        ),
        (
            JsString::from("storedBy"),
            TolerantJsonValue::String(JsString::from(row.stored_by.as_str())),
        ),
        (
            JsString::from("sourceTurnId"),
            TolerantJsonValue::String(JsString::from(row.source_turn_id.as_str())),
        ),
        (
            JsString::from("sourceMessageRole"),
            TolerantJsonValue::String(JsString::from(row.source_message_role.as_str())),
        ),
        (
            JsString::from("sourceTimestamp"),
            numeric(&row.source_timestamp)?,
        ),
        (
            JsString::from("sourceUrl"),
            TolerantJsonValue::String(JsString::from(row.source_url.as_str())),
        ),
        (
            JsString::from("evidenceQuote"),
            TolerantJsonValue::String(JsString::from(row.evidence_quote.as_str())),
        ),
        (
            JsString::from("scope"),
            TolerantJsonValue::String(JsString::from(row.scope.as_str())),
        ),
        (
            JsString::from("ownerUserId"),
            TolerantJsonValue::String(JsString::from(row.owner_user_id.as_str())),
        ),
        (
            JsString::from("emotionalValence"),
            TolerantJsonValue::String(JsString::from(row.emotional_valence.as_str())),
        ),
        (
            JsString::from("emotionalIntensity"),
            numeric(&row.emotional_intensity)?,
        ),
        (
            JsString::from("emotionalDominant"),
            TolerantJsonValue::String(JsString::from(row.emotional_dominant.as_str())),
        ),
        (
            JsString::from("moodContextAtCapture"),
            TolerantJsonValue::String(JsString::from(row.mood_context_at_capture.as_str())),
        ),
        (
            JsString::from("emotionStatus"),
            TolerantJsonValue::String(JsString::from(row.emotion_status.as_str())),
        ),
        (
            JsString::from("importanceStatus"),
            TolerantJsonValue::String(JsString::from(row.importance_status.as_str())),
        ),
        (JsString::from("replayCount"), numeric(&row.replay_count)?),
        (JsString::from("lastReplayed"), numeric(&row.last_replayed)?),
        (
            JsString::from("retrievalCount"),
            numeric(&row.retrieval_count)?,
        ),
        (
            JsString::from("lastRetrievedAt"),
            numeric(&row.last_retrieved_at)?,
        ),
        (
            JsString::from("memoryStrength"),
            numeric(&row.memory_strength)?,
        ),
        (
            JsString::from("halfLifeDays"),
            numeric(&row.half_life_days)?,
        ),
        (
            JsString::from("lastStrengthenedAt"),
            numeric(&row.last_strengthened_at)?,
        ),
        (
            JsString::from("lastDynamicsAt"),
            numeric(&row.last_dynamics_at)?,
        ),
        (
            JsString::from("memoryClass"),
            TolerantJsonValue::String(JsString::from(row.memory_class.as_str())),
        ),
        (JsString::from("neverForget"), numeric(&row.never_forget)?),
        (
            JsString::from("coreMemoryScore"),
            numeric(&row.core_memory_score)?,
        ),
        (
            JsString::from("coreMemoryReason"),
            TolerantJsonValue::String(JsString::from(row.core_memory_reason.as_str())),
        ),
        (
            JsString::from("versionNumber"),
            numeric(&row.version_number)?,
        ),
        (
            JsString::from("previousVersion"),
            TolerantJsonValue::String(JsString::from(row.previous_version.as_str())),
        ),
        (
            JsString::from("supersededBy"),
            TolerantJsonValue::String(JsString::from(row.superseded_by.as_str())),
        ),
        (
            JsString::from("updateSource"),
            TolerantJsonValue::String(JsString::from(row.update_source.as_str())),
        ),
        (
            JsString::from("updateEvidence"),
            TolerantJsonValue::String(JsString::from(row.update_evidence.as_str())),
        ),
        (
            JsString::from("reconsolidationConfidence"),
            numeric(&row.reconsolidation_confidence)?,
        ),
        (
            JsString::from("status"),
            TolerantJsonValue::String(JsString::from(row.status.as_str())),
        ),
        (
            JsString::from("versionCreatedAt"),
            numeric(&row.version_created_at)?,
        ),
        (JsString::from("updatedAt"), numeric(&row.updated_at)?),
        (
            JsString::from("workspaceId"),
            TolerantJsonValue::String(JsString::from(row.workspace_id.as_str())),
        ),
        (
            JsString::from("workspaceKey"),
            TolerantJsonValue::String(JsString::from(row.workspace_key.as_str())),
        ),
        (
            JsString::from("memoryKind"),
            TolerantJsonValue::String(JsString::from(row.memory_kind.as_str())),
        ),
        (
            JsString::from("reminderStatus"),
            TolerantJsonValue::String(JsString::from(row.reminder_status.as_str())),
        ),
        (JsString::from("remindAt"), numeric(&row.remind_at)?),
        (JsString::from("remindedAt"), numeric(&row.reminded_at)?),
        (JsString::from("dispatchedAt"), numeric(&row.dispatched_at)?),
        (
            JsString::from("acknowledgedAt"),
            numeric(&row.acknowledged_at)?,
        ),
        (JsString::from("cancelledAt"), numeric(&row.cancelled_at)?),
        (
            JsString::from("reminderKey"),
            TolerantJsonValue::String(JsString::from(row.reminder_key.as_str())),
        ),
        (
            JsString::from("dispatchCount"),
            numeric(&row.dispatch_count)?,
        ),
        (
            JsString::from("lastDispatchAttemptAt"),
            numeric(&row.last_dispatch_attempt_at)?,
        ),
        (
            JsString::from("nextDispatchAttemptAt"),
            numeric(&row.next_dispatch_attempt_at)?,
        ),
        (
            JsString::from("epistemicStatus"),
            TolerantJsonValue::String(JsString::from(row.epistemic_status.as_str())),
        ),
        (
            JsString::from("epistemicStatusUpdatedAt"),
            numeric(&row.epistemic_status_updated_at)?,
        ),
        (
            JsString::from("epistemicStatusActor"),
            TolerantJsonValue::String(JsString::from(row.epistemic_status_actor.as_str())),
        ),
        (
            JsString::from("epistemicStatusReason"),
            TolerantJsonValue::String(JsString::from(row.epistemic_status_reason.as_str())),
        ),
        (
            JsString::from("previousEpistemicStatus"),
            TolerantJsonValue::String(JsString::from(row.previous_epistemic_status.as_str())),
        ),
        (JsString::from("validFrom"), numeric(&row.valid_from)?),
        (JsString::from("validUntil"), numeric(&row.valid_until)?),
        (
            JsString::from("chunkGroupId"),
            TolerantJsonValue::String(JsString::from(row.chunk_group_id.as_str())),
        ),
    ];
    Ok(write_json(&TolerantJsonValue::Object(fields)))
}
