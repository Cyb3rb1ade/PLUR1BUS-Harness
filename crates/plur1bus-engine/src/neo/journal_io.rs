//! Bounded lossless journal reads and private durable capture plans.
use super::{
    derived_fields::{object, text, validate_object},
    merged::optional,
    merged_order::field,
};
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, StoreError},
    store::{directory::TrustedDirectory, state_file::StateFile},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use std::{collections::HashMap, io::Read};

pub(super) const MAX_BYTES: usize = 64 * 1024 * 1024;
pub(super) const MAX_ROWS: usize = 50_000;
pub(super) const FILES: [&str; 5] = [
    "turn-journal.jsonl",
    "memory-candidates.jsonl",
    "reaction-ledger.jsonl",
    "behavior-cards.jsonl",
    "embedding-queue.jsonl",
];

pub(super) fn bytes(
    dir: &TrustedDirectory,
    name: &str,
    cancel: &Cancel,
) -> Result<Option<Vec<u8>>, EngineError> {
    let Some(mut file) = optional(dir.open_file(name))? else {
        return Ok(None);
    };
    super::vectors::ordinary(&file)?;
    let identity = crate::store::directory::regular_file_identity(&file)?;
    if file.metadata().map_err(StoreError::from)?.len() > MAX_BYTES as u64 {
        return Err(StoreError::Corrupt.into());
    }
    let mut out = Vec::new();
    let mut chunk = [0; 65536];
    loop {
        cancel.check()?;
        let n = file.read(&mut chunk).map_err(StoreError::from)?;
        if n == 0 {
            break;
        }
        if out.len() + n > MAX_BYTES {
            return Err(StoreError::Corrupt.into());
        }
        out.extend_from_slice(&chunk[..n]);
    }
    if crate::store::directory::regular_file_identity(&dir.open_file(name)?)? != identity {
        return Err(StoreError::UntrustedPath.into());
    }
    dir.assert_unchanged()?;
    Ok(Some(out))
}

pub(super) fn rows(
    dir: &TrustedDirectory,
    name: &str,
    cancel: &Cancel,
) -> Result<Vec<Json>, EngineError> {
    let Some(bytes) = bytes(dir, name, cancel)? else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    // Only complete LF-delimited records are committed; a killed append can leave a partial tail.
    for line in bytes
        .split_inclusive(|b| *b == b'\n')
        .filter(|line| line.ends_with(b"\n"))
    {
        cancel.check()?;
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        if out.len() == MAX_ROWS {
            return Err(StoreError::Corrupt.into());
        }
        let value = parse_json(std::str::from_utf8(line).map_err(|_| StoreError::Corrupt)?)
            .map_err(|_| StoreError::Corrupt)?;
        validate_object(&value)?;
        out.push(value);
    }
    Ok(out)
}

pub(super) fn id(row: &Json) -> Result<JsString, StoreError> {
    validate_object(row)?;
    match field(row, "id") {
        Some(Json::String(s)) if !s.is_empty() => Ok(s.clone()),
        _ => Err(StoreError::Corrupt),
    }
}
pub(super) fn owned(row: &Json, ctx: &RequestContext) -> bool {
    super::acl::visible(row, Some(ctx))
        && field(row, "ownerUserId") == Some(&text(&ctx.owner_user_id))
        && field(row, "agentId") == Some(&text(ctx.agent_id.as_str()))
        && field(row, "workspaceKey") == Some(&text(&ctx.workspace_key))
}
pub(super) fn latest(rows: Vec<Json>) -> Result<Vec<Json>, StoreError> {
    let mut positions: HashMap<JsString, usize> = HashMap::new();
    let mut result = Vec::new();
    for row in rows {
        let key = id(&row)?;
        if let Some(index) = positions.get(&key) {
            if super::merged_order::time(&row, true)
                >= super::merged_order::time(&result[*index], true)
            {
                result[*index] = row;
            }
        } else {
            positions.insert(key, result.len());
            result.push(row);
        }
    }
    Ok(result)
}

pub(super) fn read_plan(
    dir: &TrustedDirectory,
    name: &str,
    proof: &Json,
    cancel: &Cancel,
) -> Result<Option<Vec<Vec<Json>>>, EngineError> {
    let Some(bytes) = bytes(dir, name, cancel)? else {
        return Ok(None);
    };
    let value = parse_json(std::str::from_utf8(&bytes).map_err(|_| StoreError::Corrupt)?)
        .map_err(|_| StoreError::Corrupt)?;
    validate_object(&value)?;
    if field(&value, "ownership") != Some(proof) {
        return Err(StoreError::Corrupt.into());
    }
    let Some(Json::Array(groups)) = field(&value, "records") else {
        return Err(StoreError::Corrupt.into());
    };
    if groups.len() != FILES.len() {
        return Err(StoreError::Corrupt.into());
    }
    let mut plan = Vec::new();
    let mut total = 0;
    for group in groups {
        let Json::Array(rows) = group else {
            return Err(StoreError::Corrupt.into());
        };
        total += rows.len();
        if total > MAX_ROWS {
            return Err(StoreError::Corrupt.into());
        }
        for row in rows {
            id(row)?;
        }
        plan.push(rows.clone());
    }
    Ok(Some(plan))
}
pub(super) fn write_plan(
    dir: &TrustedDirectory,
    name: &str,
    proof: &Json,
    plan: &[Vec<Json>],
) -> Result<(), StoreError> {
    let value = object(vec![
        ("ownership", proof.clone()),
        (
            "records",
            Json::Array(plan.iter().cloned().map(Json::Array).collect()),
        ),
    ]);
    if write_json(&value).len() + 1 > MAX_BYTES
        || plan.iter().map(Vec::len).sum::<usize>() > MAX_ROWS
    {
        return Err(StoreError::InvalidInput);
    }
    dir.assert_unchanged()?;
    StateFile::store(&dir.path().join(name), &value)?;
    dir.assert_unchanged()
}
