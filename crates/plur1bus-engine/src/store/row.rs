//! Arrow mappings recorded from the Node fixture; field order and nullability are persisted API.
use crate::contract::{MemoryRow, StoreError};
use arrow_array::RecordBatch;
use arrow_schema::{DataType, Field, Schema, SchemaRef};
use std::sync::Arc;

// Generated from tests/fixtures/store-v1/schema.txt; the parity test guards the recording.
const COLUMNS: &[(&str, &str)] = &[
    ("id", "Utf8"),
    ("type", "Utf8"),
    ("confirmed", "Boolean"),
    ("text", "Utf8"),
    ("summary", "Utf8"),
    ("origin", "Utf8"),
    ("vector", "FixedSizeList[384]<Float32>"),
    ("importance", "Float64"),
    ("category", "Utf8"),
    ("createdAt", "Float64"),
    ("mergedFrom", "Utf8"),
    ("expiresAt", "Float64"),
    ("agentId", "Utf8"),
    ("storedBy", "Utf8"),
    ("sourceTurnId", "Utf8"),
    ("sourceMessageRole", "Utf8"),
    ("sourceTimestamp", "Float64"),
    ("sourceUrl", "Utf8"),
    ("evidenceQuote", "Utf8"),
    ("scope", "Utf8"),
    ("ownerUserId", "Utf8"),
    ("emotionalValence", "Utf8"),
    ("emotionalIntensity", "Float64"),
    ("emotionalDominant", "Utf8"),
    ("moodContextAtCapture", "Utf8"),
    ("emotionStatus", "Utf8"),
    ("importanceStatus", "Utf8"),
    ("replayCount", "Float64"),
    ("lastReplayed", "Float64"),
    ("retrievalCount", "Float64"),
    ("lastRetrievedAt", "Float64"),
    ("memoryStrength", "Float64"),
    ("halfLifeDays", "Float64"),
    ("lastStrengthenedAt", "Float64"),
    ("lastDynamicsAt", "Float64"),
    ("memoryClass", "Utf8"),
    ("neverForget", "Float64"),
    ("coreMemoryScore", "Float64"),
    ("coreMemoryReason", "Utf8"),
    ("versionNumber", "Float64"),
    ("previousVersion", "Utf8"),
    ("supersededBy", "Utf8"),
    ("updateSource", "Utf8"),
    ("updateEvidence", "Utf8"),
    ("reconsolidationConfidence", "Float64"),
    ("status", "Utf8"),
    ("versionCreatedAt", "Float64"),
    ("updatedAt", "Float64"),
    ("workspaceId", "Utf8"),
    ("workspaceKey", "Utf8"),
    ("memoryKind", "Utf8"),
    ("reminderStatus", "Utf8"),
    ("remindAt", "Float64"),
    ("remindedAt", "Float64"),
    ("dispatchedAt", "Float64"),
    ("acknowledgedAt", "Float64"),
    ("cancelledAt", "Float64"),
    ("reminderKey", "Utf8"),
    ("dispatchCount", "Float64"),
    ("lastDispatchAttemptAt", "Float64"),
    ("nextDispatchAttemptAt", "Float64"),
    ("epistemicStatus", "Utf8"),
    ("epistemicStatusUpdatedAt", "Float64"),
    ("epistemicStatusActor", "Utf8"),
    ("epistemicStatusReason", "Utf8"),
    ("previousEpistemicStatus", "Utf8"),
    ("validFrom", "Float64"),
    ("validUntil", "Float64"),
    ("chunkGroupId", "Utf8"),
];

/// The exact memory-table schema, parameterized only by vector width.
pub fn arrow_schema(dim: usize) -> Result<SchemaRef, StoreError> {
    let dim = i32::try_from(dim)
        .ok()
        .filter(|dim| *dim > 0)
        .ok_or(StoreError::Corrupt)?;
    let fields = COLUMNS
        .iter()
        .map(|(name, kind)| {
            Field::new(
                *name,
                match *kind {
                    "Utf8" => DataType::Utf8,
                    "Boolean" => DataType::Boolean,
                    "Float64" => DataType::Float64,
                    _ => DataType::FixedSizeList(
                        Arc::new(Field::new("item", DataType::Float32, true)),
                        dim,
                    ),
                },
                true,
            )
        })
        .collect::<Vec<_>>();
    Ok(Arc::new(Schema::new(fields)))
}

// Node explicitly accepts UTF-8 columns promoted by Lance to 64-bit offsets.
// Preserve that existing physical type while keeping the recorded bootstrap schema exact.
pub(super) fn validate_schema(schema: &Schema, dim: usize) -> Result<(), StoreError> {
    let expected = arrow_schema(dim)?;
    if schema.fields().len() != expected.fields().len() {
        return Err(StoreError::Corrupt);
    }
    for (actual, expected) in schema.fields().iter().zip(expected.fields()) {
        let compatible = actual.data_type() == expected.data_type()
            || (expected.data_type() == &DataType::Utf8
                && actual.data_type() == &DataType::LargeUtf8);
        if actual.name() != expected.name()
            || actual.is_nullable() != expected.is_nullable()
            || !compatible
        {
            return Err(StoreError::Corrupt);
        }
    }
    Ok(())
}

/// Neutral Arrow text shared with the Node recorder.
pub fn schema_text(schema: &Schema) -> String {
    schema
        .fields()
        .iter()
        .map(|field| {
            let kind = match field.data_type() {
                DataType::Utf8 => "Utf8".to_owned(),
                DataType::LargeUtf8 => "LargeUtf8".to_owned(),
                DataType::Boolean => "Boolean".to_owned(),
                DataType::Float64 => "Float64".to_owned(),
                DataType::FixedSizeList(child, dim) if child.data_type() == &DataType::Float32 => {
                    format!("FixedSizeList[{dim}]<Float32>")
                }
                other => format!("{other:?}"),
            };
            format!("{}\t{kind}\t{}\n", field.name(), field.is_nullable())
        })
        .collect()
}

pub(super) fn to_batch(rows: &[MemoryRow], schema: SchemaRef) -> Result<RecordBatch, StoreError> {
    use arrow_array::{
        ArrayRef, BooleanArray, FixedSizeListArray, Float32Array, Float64Array, LargeStringArray,
        StringArray,
    };
    let values = rows
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| StoreError::Corrupt)?;
    let columns = schema
        .fields()
        .iter()
        .map(|field| -> Result<ArrayRef, StoreError> {
            let name = field.name();
            Ok(match field.data_type() {
                DataType::Utf8 => Arc::new(StringArray::from(
                    values
                        .iter()
                        .map(|row| row[name].as_str().ok_or(StoreError::Corrupt))
                        .collect::<Result<Vec<_>, _>>()?,
                )),
                DataType::LargeUtf8 => Arc::new(LargeStringArray::from(
                    values
                        .iter()
                        .map(|row| row[name].as_str().ok_or(StoreError::Corrupt))
                        .collect::<Result<Vec<_>, _>>()?,
                )),
                DataType::Boolean => Arc::new(BooleanArray::from(
                    values
                        .iter()
                        .map(|row| row[name].as_bool().ok_or(StoreError::Corrupt))
                        .collect::<Result<Vec<_>, _>>()?,
                )),
                DataType::Float64 => Arc::new(Float64Array::from(
                    values
                        .iter()
                        .map(|row| row[name].as_f64().ok_or(StoreError::Corrupt))
                        .collect::<Result<Vec<_>, _>>()?,
                )),
                DataType::FixedSizeList(child, dim) => {
                    let vectors = Float32Array::from(
                        rows.iter()
                            .flat_map(|row| row.vector.iter().copied())
                            .collect::<Vec<_>>(),
                    );
                    Arc::new(
                        FixedSizeListArray::try_new(child.clone(), *dim, Arc::new(vectors), None)
                            .map_err(|_| StoreError::Corrupt)?,
                    )
                }
                _ => return Err(StoreError::Corrupt),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    RecordBatch::try_new(schema, columns).map_err(|_| StoreError::Corrupt)
}

pub(super) fn json_rows(batch: &RecordBatch) -> Result<Vec<serde_json::Value>, StoreError> {
    let mut writer = arrow_json::ArrayWriter::new(Vec::new());
    writer.write(batch).map_err(|_| StoreError::Corrupt)?;
    writer.finish().map_err(|_| StoreError::Corrupt)?;
    serde_json::from_slice(&writer.into_inner()).map_err(|_| StoreError::Corrupt)
}

pub(super) fn from_batches(batches: &[RecordBatch]) -> Result<Vec<MemoryRow>, StoreError> {
    batches.iter().try_fold(Vec::new(), |mut rows, batch| {
        for value in json_rows(batch)? {
            rows.push(serde_json::from_value(value).map_err(|_| StoreError::Corrupt)?);
        }
        Ok(rows)
    })
}

/// A committed row paired with Lance's unmodified squared-L2 distance.
#[derive(Clone, Debug)]
pub struct Scored<T> {
    /// Persisted row.
    pub row: T,
    /// Lance distance; no square root or metric conversion is applied.
    pub distance: f32,
}
/// Optional values for each patchable memory column; absence leaves that column unchanged.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowPatch {
    /// Replacement for the persisted `type` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "type")]
    pub type_: Option<String>,
    /// Replacement for the persisted `confirmed` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "confirmed")]
    pub confirmed: Option<bool>,
    /// Replacement for the persisted `text` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "text")]
    pub text: Option<String>,
    /// Replacement for the persisted `summary` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "summary")]
    pub summary: Option<String>,
    /// Replacement for the persisted `origin` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "origin")]
    pub origin: Option<String>,
    /// Replacement for the persisted `vector` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "vector")]
    pub vector: Option<Vec<f32>>,
    /// Replacement for the persisted `importance` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "importance")]
    pub importance: Option<f64>,
    /// Replacement for the persisted `category` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "category")]
    pub category: Option<String>,
    /// Replacement for the persisted `createdAt` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "createdAt")]
    pub created_at: Option<f64>,
    /// Replacement for the persisted `mergedFrom` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "mergedFrom")]
    pub merged_from: Option<String>,
    /// Replacement for the persisted `expiresAt` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "expiresAt")]
    pub expires_at: Option<f64>,
    /// Replacement for the persisted `agentId` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "agentId")]
    pub agent_id: Option<String>,
    /// Replacement for the persisted `storedBy` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "storedBy")]
    pub stored_by: Option<String>,
    /// Replacement for the persisted `sourceTurnId` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "sourceTurnId")]
    pub source_turn_id: Option<String>,
    /// Replacement for the persisted `sourceMessageRole` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "sourceMessageRole")]
    pub source_message_role: Option<String>,
    /// Replacement for the persisted `sourceTimestamp` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "sourceTimestamp")]
    pub source_timestamp: Option<f64>,
    /// Replacement for the persisted `sourceUrl` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "sourceUrl")]
    pub source_url: Option<String>,
    /// Replacement for the persisted `evidenceQuote` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "evidenceQuote")]
    pub evidence_quote: Option<String>,
    /// Replacement for the persisted `scope` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "scope")]
    pub scope: Option<String>,
    /// Replacement for the persisted `ownerUserId` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "ownerUserId")]
    pub owner_user_id: Option<String>,
    /// Replacement for the persisted `emotionalValence` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "emotionalValence")]
    pub emotional_valence: Option<String>,
    /// Replacement for the persisted `emotionalIntensity` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "emotionalIntensity")]
    pub emotional_intensity: Option<f64>,
    /// Replacement for the persisted `emotionalDominant` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "emotionalDominant")]
    pub emotional_dominant: Option<String>,
    /// Replacement for the persisted `moodContextAtCapture` column.
    #[serde(
        skip_serializing_if = "Option::is_none",
        rename = "moodContextAtCapture"
    )]
    pub mood_context_at_capture: Option<String>,
    /// Replacement for the persisted `emotionStatus` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "emotionStatus")]
    pub emotion_status: Option<String>,
    /// Replacement for the persisted `importanceStatus` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "importanceStatus")]
    pub importance_status: Option<String>,
    /// Replacement for the persisted `replayCount` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "replayCount")]
    pub replay_count: Option<f64>,
    /// Replacement for the persisted `lastReplayed` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "lastReplayed")]
    pub last_replayed: Option<f64>,
    /// Replacement for the persisted `retrievalCount` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "retrievalCount")]
    pub retrieval_count: Option<f64>,
    /// Replacement for the persisted `lastRetrievedAt` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "lastRetrievedAt")]
    pub last_retrieved_at: Option<f64>,
    /// Replacement for the persisted `memoryStrength` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "memoryStrength")]
    pub memory_strength: Option<f64>,
    /// Replacement for the persisted `halfLifeDays` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "halfLifeDays")]
    pub half_life_days: Option<f64>,
    /// Replacement for the persisted `lastStrengthenedAt` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "lastStrengthenedAt")]
    pub last_strengthened_at: Option<f64>,
    /// Replacement for the persisted `lastDynamicsAt` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "lastDynamicsAt")]
    pub last_dynamics_at: Option<f64>,
    /// Replacement for the persisted `memoryClass` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "memoryClass")]
    pub memory_class: Option<String>,
    /// Replacement for the persisted `neverForget` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "neverForget")]
    pub never_forget: Option<f64>,
    /// Replacement for the persisted `coreMemoryScore` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "coreMemoryScore")]
    pub core_memory_score: Option<f64>,
    /// Replacement for the persisted `coreMemoryReason` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "coreMemoryReason")]
    pub core_memory_reason: Option<String>,
    /// Replacement for the persisted `versionNumber` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "versionNumber")]
    pub version_number: Option<f64>,
    /// Replacement for the persisted `previousVersion` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "previousVersion")]
    pub previous_version: Option<String>,
    /// Replacement for the persisted `supersededBy` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "supersededBy")]
    pub superseded_by: Option<String>,
    /// Replacement for the persisted `updateSource` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "updateSource")]
    pub update_source: Option<String>,
    /// Replacement for the persisted `updateEvidence` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "updateEvidence")]
    pub update_evidence: Option<String>,
    /// Replacement for the persisted `reconsolidationConfidence` column.
    #[serde(
        skip_serializing_if = "Option::is_none",
        rename = "reconsolidationConfidence"
    )]
    pub reconsolidation_confidence: Option<f64>,
    /// Replacement for the persisted `status` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "status")]
    pub status: Option<String>,
    /// Replacement for the persisted `versionCreatedAt` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "versionCreatedAt")]
    pub version_created_at: Option<f64>,
    /// Replacement for the persisted `updatedAt` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "updatedAt")]
    pub updated_at: Option<f64>,
    /// Replacement for the persisted `workspaceId` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "workspaceId")]
    pub workspace_id: Option<String>,
    /// Replacement for the persisted `workspaceKey` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "workspaceKey")]
    pub workspace_key: Option<String>,
    /// Replacement for the persisted `memoryKind` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "memoryKind")]
    pub memory_kind: Option<String>,
    /// Replacement for the persisted `reminderStatus` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "reminderStatus")]
    pub reminder_status: Option<String>,
    /// Replacement for the persisted `remindAt` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "remindAt")]
    pub remind_at: Option<f64>,
    /// Replacement for the persisted `remindedAt` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "remindedAt")]
    pub reminded_at: Option<f64>,
    /// Replacement for the persisted `dispatchedAt` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "dispatchedAt")]
    pub dispatched_at: Option<f64>,
    /// Replacement for the persisted `acknowledgedAt` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "acknowledgedAt")]
    pub acknowledged_at: Option<f64>,
    /// Replacement for the persisted `cancelledAt` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "cancelledAt")]
    pub cancelled_at: Option<f64>,
    /// Replacement for the persisted `reminderKey` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "reminderKey")]
    pub reminder_key: Option<String>,
    /// Replacement for the persisted `dispatchCount` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "dispatchCount")]
    pub dispatch_count: Option<f64>,
    /// Replacement for the persisted `lastDispatchAttemptAt` column.
    #[serde(
        skip_serializing_if = "Option::is_none",
        rename = "lastDispatchAttemptAt"
    )]
    pub last_dispatch_attempt_at: Option<f64>,
    /// Replacement for the persisted `nextDispatchAttemptAt` column.
    #[serde(
        skip_serializing_if = "Option::is_none",
        rename = "nextDispatchAttemptAt"
    )]
    pub next_dispatch_attempt_at: Option<f64>,
    /// Replacement for the persisted `epistemicStatus` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "epistemicStatus")]
    pub epistemic_status: Option<String>,
    /// Replacement for the persisted `epistemicStatusUpdatedAt` column.
    #[serde(
        skip_serializing_if = "Option::is_none",
        rename = "epistemicStatusUpdatedAt"
    )]
    pub epistemic_status_updated_at: Option<f64>,
    /// Replacement for the persisted `epistemicStatusActor` column.
    #[serde(
        skip_serializing_if = "Option::is_none",
        rename = "epistemicStatusActor"
    )]
    pub epistemic_status_actor: Option<String>,
    /// Replacement for the persisted `epistemicStatusReason` column.
    #[serde(
        skip_serializing_if = "Option::is_none",
        rename = "epistemicStatusReason"
    )]
    pub epistemic_status_reason: Option<String>,
    /// Replacement for the persisted `previousEpistemicStatus` column.
    #[serde(
        skip_serializing_if = "Option::is_none",
        rename = "previousEpistemicStatus"
    )]
    pub previous_epistemic_status: Option<String>,
    /// Replacement for the persisted `validFrom` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "validFrom")]
    pub valid_from: Option<f64>,
    /// Replacement for the persisted `validUntil` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "validUntil")]
    pub valid_until: Option<f64>,
    /// Replacement for the persisted `chunkGroupId` column.
    #[serde(skip_serializing_if = "Option::is_none", rename = "chunkGroupId")]
    pub chunk_group_id: Option<String>,
}

/// Node's Phase 1 distance score, including the nullish default and its unmodified edge cases.
pub fn distance_to_score(distance: Option<f64>) -> f64 {
    1.0 / (1.0 + distance.unwrap_or(0.0))
}
