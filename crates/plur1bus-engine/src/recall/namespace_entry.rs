//! Node projectRecallEntry: scalar metadata only, never an embedding vector.
//! The frozen private-store row has no share/source, confirmation-status or legacy
//! reminder timezone/recurrence columns; these use Node's absent-column defaults.
//! Shared-store adapters must supply their own projected provenance in T6/RE-07.

use crate::contract::MemoryRow;
use serde_json::{json, Map, Value};

/// Project a hydrated row exactly as the Node recall boundary does.
#[must_use]
pub fn project_entry(row: &MemoryRow) -> Value {
    let mut fields = Map::new();
    fields.extend(identity_fields(row));
    fields.extend(content_fields(row));
    fields.extend(dynamics_fields(row));
    fields.extend(version_fields(row));
    fields.extend(reminder_fields(row));
    Value::Object(fields)
}

fn identity_fields(row: &MemoryRow) -> Map<String, Value> {
    let values = json!({
        "id": &row.id,
        "text": &row.text,
        "summary": &row.summary,
        "scope": fallback(&row.scope, "agent-private"),
        "storedBy": &row.stored_by,
        "agentId": &row.agent_id,
        "workspaceKey": &row.workspace_key,
        "workspaceId": &row.workspace_id,
        "ownerUserId": &row.owner_user_id,
        "sourceMemoryId": "",
        "sourceAgentId": "",
        "shareIdempotencyKey": "",
    });
    match values {
        Value::Object(fields) => fields,
        _ => Map::new(),
    }
}

fn content_fields(row: &MemoryRow) -> Map<String, Value> {
    let values = json!({
        "shareProvenance": "{}",
        "status": &row.status,
        "origin": fallback(&row.origin, "dm"),
        "category": &row.category,
        "importance": row.importance.as_f64().unwrap_or(0.0),
        "createdAt": row.created_at.as_f64().unwrap_or(0.0),
        "sourceUrl": &row.source_url,
        "evidenceQuote": &row.evidence_quote,
        "emotionalValence": &row.emotional_valence,
        "emotionalIntensity": &row.emotional_intensity,
        "emotionalDominant": fallback(&row.emotional_dominant, "neutral"),
        "retrievalCount": row.retrieval_count.as_f64().unwrap_or(0.0),
    });
    match values {
        Value::Object(fields) => fields,
        _ => Map::new(),
    }
}

fn dynamics_fields(row: &MemoryRow) -> Map<String, Value> {
    let values = json!({
        "lastRetrievedAt": row.last_retrieved_at.as_f64().unwrap_or(0.0),
        "memoryStrength": &row.memory_strength,
        "halfLifeDays": &row.half_life_days,
        "lastStrengthenedAt": row.last_strengthened_at.as_f64().unwrap_or(0.0),
        "lastDynamicsAt": row.last_dynamics_at.as_f64().unwrap_or(0.0),
        "memoryClass": fallback(&row.memory_class, "standard"),
        "neverForget": row.never_forget.as_f64().unwrap_or(0.0),
        "coreMemoryScore": &row.core_memory_score,
        "coreMemoryReason": &row.core_memory_reason,
        "versionNumber": row.version_number.as_f64().unwrap_or(0.0),
        "previousVersion": &row.previous_version,
        "supersededBy": &row.superseded_by,
    });
    match values {
        Value::Object(fields) => fields,
        _ => Map::new(),
    }
}

fn version_fields(row: &MemoryRow) -> Map<String, Value> {
    let values = json!({
        "updateSource": &row.update_source,
        "updateEvidence": &row.update_evidence,
        "reconsolidationConfidence": &row.reconsolidation_confidence,
        "versionCreatedAt": row.version_created_at.as_f64().unwrap_or(0.0),
        "updatedAt": row.updated_at.as_f64().unwrap_or(0.0),
        "expiresAt": row.expires_at.as_f64().unwrap_or(0.0),
        "memoryKind": &row.memory_kind,
        "type": &row.type_,
        "confirmed": row.confirmed,
        "confirmationStatus": "",
        "reminderStatus": &row.reminder_status,
        "reminderKey": &row.reminder_key,
    });
    match values {
        Value::Object(fields) => fields,
        _ => Map::new(),
    }
}

fn reminder_fields(row: &MemoryRow) -> Map<String, Value> {
    let values = json!({
        "remindAt": row.remind_at.as_f64().unwrap_or(0.0),
        "reminderTimezone": "",
        "reminderRecurrence": "",
        "epistemicStatus": &row.epistemic_status,
        "validFrom": row.valid_from.as_f64().unwrap_or(0.0),
        "validUntil": row.valid_until.as_f64().unwrap_or(0.0),
    });
    match values {
        Value::Object(fields) => fields,
        _ => Map::new(),
    }
}

fn fallback<'a>(value: &'a str, default: &'a str) -> &'a str {
    if value.is_empty() {
        default
    } else {
        value
    }
}
