//! The pinned Engine's #275 semantic validation, against the actual quarantined Lance generation.
use super::{
    backend::GenerationBackend,
    coordinator::CoordinatorError,
    coordinator_ports::MigrationProvider,
    state_json::{get_text, integer},
};
use crate::{
    contract::{Cancel, EmbedKind},
    ops::import_primitives::field,
    text::json::TolerantJsonValue as Json,
};
use serde_json::{json, Value};

/// Prove an empty planned source without inference, otherwise query the first nonempty source
/// table and require the selected memory among the target's top five. The coordinator must first
/// check current source versions and run full generation validation. This operation never writes.
pub fn validate(
    record: &Json,
    backend: &GenerationBackend,
    provider: &dyn MigrationProvider,
    cancel: &Cancel,
) -> Result<Value, CoordinatorError> {
    let invalid = || CoordinatorError::Invalid("invalid semantic validation record");
    cancel.check().map_err(|_| CoordinatorError::Cancelled)?;
    let source = field(record, "source").ok_or_else(invalid)?;
    let Json::Array(tables) = field(source, "tables").ok_or_else(invalid)? else {
        return Err(invalid());
    };
    let mut selected = None;
    for table in tables {
        let count = field(table, "rowCount")
            .and_then(integer)
            .ok_or_else(invalid)?;
        if count > 0 {
            selected = Some(table);
            break;
        }
    }
    let Some(table) = selected else {
        return Ok(json!({"semanticRecall":true,"validationMemoryId":null,"validationTable":null}));
    };
    let table_id = get_text(table, "tableId").ok_or_else(invalid)?;
    let rows = backend.read_source(&table_id, 0, 1, cancel)?;
    let row = rows.first().ok_or(CoordinatorError::Invalid(
        "reembedding semantic validation source memory is invalid",
    ))?;
    let text = row["text"]
        .as_str()
        .filter(|s| !crate::text::js::js_trim(s).is_empty())
        .ok_or(CoordinatorError::Invalid(
            "reembedding semantic validation source memory is invalid",
        ))?;
    let id = row["id"].as_str().ok_or_else(invalid)?;
    let vectors = provider.embed(&[text.to_owned()], EmbedKind::Query, cancel)?;
    if vectors.len() != 1 {
        return Err(CoordinatorError::Invalid(
            "target embedding batch result mismatch",
        ));
    }
    let target = field(record, "target").ok_or_else(invalid)?;
    let generation = get_text(target, "generation").ok_or_else(invalid)?;
    let dim = field(target, "fingerprint")
        .and_then(|f| field(f, "dimensions"))
        .and_then(integer)
        .ok_or_else(invalid)?;
    let vector = &vectors[0];
    if vector.len() as u64 != dim || vector.iter().any(|n| !n.is_finite()) {
        return Err(CoordinatorError::Invalid(
            "target embedding vector mismatch",
        ));
    }
    cancel.check().map_err(|_| CoordinatorError::Cancelled)?;
    let recalled = backend.search(&generation, &table_id, vector, 5, cancel)?;
    if !recalled.iter().any(|r| r["id"].as_str() == Some(id)) {
        return Err(CoordinatorError::Invalid(
            "reembedding target generation did not recall the source validation memory",
        ));
    }
    Ok(json!({"semanticRecall":true,"validationMemoryId":id,"validationTable":table_id}))
}
