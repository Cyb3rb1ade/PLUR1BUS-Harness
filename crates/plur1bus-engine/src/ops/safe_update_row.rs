//! Persisted successor shape shared by explicit correction and reconsolidation.
use super::{
    context::error,
    safe_update::{UpdateEvidence, UpdatePatch},
};
use crate::contract::{EngineError, MemoryOpErrorCode, MemoryRow};
use serde_json::json;
pub(super) fn successor(
    old: &MemoryRow,
    patch: &UpdatePatch,
    evidence: &UpdateEvidence,
    now: i64,
) -> Result<MemoryRow, EngineError> {
    let mut value = serde_json::to_value(old).map_err(|_| error(MemoryOpErrorCode::Storage))?;
    for (key, fallback) in [
        ("type", "memory"),
        ("origin", "dm"),
        ("category", "other"),
        ("mergedFrom", "[]"),
        ("emotionalDominant", "neutral"),
        ("emotionStatus", "final"),
        ("memoryClass", "standard"),
    ] {
        if value[key].as_str().is_none_or(str::is_empty) {
            value[key] = json!(fallback);
        }
    }
    if !matches!(
        value["importanceStatus"].as_str(),
        Some("pending" | "pending_backfill" | "final")
    ) {
        value["importanceStatus"] = json!("final");
    }
    for key in ["createdAt", "sourceTimestamp"] {
        if value[key].as_f64() == Some(0.) {
            value[key] = json!(now);
        }
    }
    for key in ["reminderStatus", "reminderKey"] {
        value[key] = json!("");
    }
    for key in [
        "remindAt",
        "remindedAt",
        "dispatchedAt",
        "acknowledgedAt",
        "cancelledAt",
        "dispatchCount",
        "lastDispatchAttemptAt",
        "nextDispatchAttemptAt",
    ] {
        value[key] = json!(0);
    }
    value["memoryKind"] = json!("memory");
    value["id"] = json!(uuid::Uuid::new_v4().to_string());
    if let Some(text) = &patch.text {
        value["text"] = json!(text);
    }
    if let Some(summary) = &patch.summary {
        value["summary"] = json!(summary);
    }
    if let Some(vector) = &patch.vector {
        value["vector"] = json!(vector);
    }
    if let Some(importance) = patch.importance {
        value["importance"] = json!(importance);
        value["importanceStatus"] = json!("final");
    }
    if let Some(category) = &patch.category {
        value["category"] = json!(category);
    }
    value["versionNumber"] = json!(old.version_number.as_f64().unwrap_or(1.) + 1.);
    value["previousVersion"] = json!(old.id);
    value["supersededBy"] = json!("");
    if let Some(source) = evidence.update_source.as_ref().filter(|v| !v.is_empty()) {
        value["updateSource"] = json!(source);
    }
    if let Some(text) = evidence.update_evidence.as_ref().filter(|v| !v.is_empty()) {
        value["updateEvidence"] = json!(text);
    }
    if let Some(confidence) = evidence.confidence {
        value["reconsolidationConfidence"] = json!(confidence);
    }
    value["status"] = json!("active");
    value["versionCreatedAt"] = json!(now);
    value["updatedAt"] = json!(now);
    let epistemic = crate::recall::score::normalize_epistemic_status(&old.epistemic_status);
    if matches!(epistemic, "trusted" | "corroborated") {
        value["epistemicStatus"] = json!("observed");
        value["previousEpistemicStatus"] = json!(epistemic);
        value["epistemicStatusActor"] = json!("system:content-edit");
        value["epistemicStatusReason"] =
            json!("trusted/corroborated collapsed to observed on a content-changing safeUpdate");
        value["epistemicStatusUpdatedAt"] = json!(now);
    }
    serde_json::from_value(value).map_err(|_| error(MemoryOpErrorCode::Storage))
}
