//! Bounded native dedupe evidence survives live-journal caps. It grants no read/write authority.
use super::{
    derived_fields::{object, text, validate_object},
    journal_io,
    merged_order::field,
};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::{directory::TrustedDirectory, state_file::StateFile},
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
use std::collections::HashMap;
const NAME: &str = "native-append-history.json";

pub(super) fn read(dir: &TrustedDirectory, cancel: &Cancel) -> Result<Vec<Vec<Json>>, EngineError> {
    let Some(bytes) = journal_io::bytes(dir, NAME, cancel)? else {
        return Ok(vec![vec![]; journal_io::FILES.len()]);
    };
    let value = parse_json(std::str::from_utf8(&bytes).map_err(|_| StoreError::Corrupt)?)
        .map_err(|_| StoreError::Corrupt)?;
    validate_object(&value)?;
    if field(&value, "version") != Some(&text("1")) {
        return Err(StoreError::Corrupt.into());
    }
    let Some(Json::Array(groups)) = field(&value, "records") else {
        return Err(StoreError::Corrupt.into());
    };
    if groups.len() != journal_io::FILES.len() {
        return Err(StoreError::Corrupt.into());
    }
    let mut out = Vec::new();
    for group in groups {
        let Json::Array(rows) = group else {
            return Err(StoreError::Corrupt.into());
        };
        if rows.len() > journal_io::MAX_ROWS {
            return Err(StoreError::Unavailable.into());
        }
        for row in rows {
            cancel.check()?;
            journal_io::id(row)?;
        }
        out.push(rows.clone());
    }
    Ok(out)
}

fn evidence(row: &Json) -> Result<Json, StoreError> {
    validate_object(row)?;
    let Json::Object(fields) = row else {
        return Err(StoreError::Corrupt);
    };
    // Keep every ACL spelling, including legacy/conflicting claims. Projection cannot turn an
    // invisible source into owned evidence. No message content or embedding is copied.
    let keys = [
        "id",
        "ownerUserId",
        "ownerId",
        "agentId",
        "workspaceKey",
        "workspaceIdentity",
        "workspaceId",
        "scope",
        "visibility",
        "origin",
        "aclBindings",
        "normalizedStatement",
    ];
    Ok(Json::Object(
        fields
            .iter()
            .filter(|(key, _)| keys.iter().any(|k| key == &(*k).into()))
            .cloned()
            .collect(),
    ))
}

pub(super) fn preserve(
    dir: &TrustedDirectory,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    let mut history = read(dir, cancel)?;
    for (index, rows) in history.iter_mut().enumerate() {
        let mut positions = HashMap::new();
        for (i, row) in rows.iter().enumerate() {
            positions.insert(journal_io::id(row)?, i);
        }
        for row in journal_io::rows(dir, journal_io::FILES[index], cancel)? {
            cancel.check()?;
            let id = journal_io::id(&row)?;
            let projected = evidence(&row)?;
            if let Some(position) = positions.get(&id) {
                // Keep original ownership and content evidence. A revision is not a new append.
                let old = &rows[*position];
                for key in ["ownerUserId", "agentId", "workspaceKey"] {
                    if field(old, key) != field(&projected, key) {
                        return Err(StoreError::InvalidInput.into());
                    }
                }
            } else {
                if rows.len() == journal_io::MAX_ROWS {
                    return Err(StoreError::Unavailable.into());
                }
                positions.insert(id, rows.len());
                rows.push(projected);
            }
        }
    }
    let value = object(vec![
        ("version", text("1")),
        (
            "records",
            Json::Array(history.into_iter().map(Json::Array).collect()),
        ),
    ]);
    if write_json(&value).len() + 1 > journal_io::MAX_BYTES {
        return Err(StoreError::Unavailable.into());
    }
    check()?;
    dir.assert_unchanged()?;
    StateFile::store(&dir.path().join(NAME), &value)?;
    check()?;
    Ok(())
}
