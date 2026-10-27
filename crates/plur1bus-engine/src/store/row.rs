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

/// Neutral Arrow text shared with the Node recorder.
pub fn schema_text(schema: &Schema) -> String {
    schema
        .fields()
        .iter()
        .map(|field| {
            let kind = match field.data_type() {
                DataType::Utf8 => "Utf8".to_owned(),
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
    let mut decoder = arrow_json::ReaderBuilder::new(schema)
        .with_batch_size(rows.len().max(1))
        .with_strict_mode(true)
        .build_decoder()
        .map_err(|_| StoreError::Corrupt)?;
    decoder.serialize(rows).map_err(|_| StoreError::Corrupt)?;
    decoder
        .flush()
        .map_err(|_| StoreError::Corrupt)?
        .ok_or(StoreError::Corrupt)
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
