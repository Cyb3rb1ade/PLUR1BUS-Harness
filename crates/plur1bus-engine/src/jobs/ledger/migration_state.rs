//! Frozen source and ledger evidence for migration replay; row claims never confer authority.
use super::*;
use crate::{
    capture::interference::bounded,
    jobs::{
        ledger::json::node_value,
        migration::{plan, Plan, Status},
    },
    text::js::{js_trim, JsString},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Receipt {
    pub version: u8,
    pub agent: String,
    pub state_path: String,
    pub state_identity: (u64, u64),
    pub ledger_path: String,
    pub ledger_identity: (u64, u64),
    pub source_identity: (u64, u64),
    pub backup_sha: [u8; 32],
    pub backup_file: Option<(u64, u64)>,
    pub before: String,
    pub after: String,
    pub now: f64,
    pub prefix: usize,
    pub prefix_sha: [u8; 32],
    pub ledger_file: Option<(u64, u64)>,
    pub suffix: String,
    pub migrated: usize,
    pub complete: bool,
}
pub(super) fn encode(receipt: &Receipt) -> Result<Vec<u8>, EngineError> {
    serde_json::to_vec(receipt).map_err(|_| StoreError::Corrupt.into())
}
pub(super) fn decode(bytes: &[u8]) -> Result<Receipt, EngineError> {
    serde_json::from_slice(bytes).map_err(|_| StoreError::Corrupt.into())
}
fn versioned(row: &Json) -> Result<Json, EngineError> {
    let Json::Object(fields) = row else {
        return Err(StoreError::Corrupt.into());
    };
    let mut output = vec![("v".into(), Json::Number("1".into()))];
    output.extend(fields.clone());
    Ok(node_value(Json::Object(output)))
}
fn id(row: &Json) -> Option<JsString> {
    match crate::jobs::metadata::get(row, "runId") {
        Some(Json::String(id)) => Some(id.clone()),
        _ => None,
    }
}
fn suffix(raw: &[u8], plan: &Plan, cancel: &Cancel) -> Result<String, EngineError> {
    let text = std::str::from_utf8(raw).map_err(|_| StoreError::Corrupt)?;
    let mut existing: HashMap<JsString, Option<Json>> = HashMap::new();
    let mut lines = 0;
    for line in text.split('\n') {
        cancel.check()?;
        if js_trim(line).is_empty() {
            continue;
        }
        lines += 1;
        if lines > MAX_ROWS || line.len() > MAX_RECORD {
            return Err(StoreError::Corrupt.into());
        }
        let row = parse_json(line).map_err(|_| StoreError::Corrupt)?;
        bounded(&row, cancel, &mut (0, 0))?;
        if !matches!(row, Json::Object(_)) {
            return Err(StoreError::Corrupt.into());
        }
        if let Some(id) = id(&row) {
            let row = node_value(row);
            existing
                .entry(id)
                .and_modify(|v| *v = None)
                .or_insert(Some(row));
        }
    }
    let mut suffix = String::new();
    for row in &plan.rows {
        cancel.check()?;
        let row = versioned(row)?;
        let id = id(&row).ok_or(StoreError::Corrupt)?;
        if let Some(old) = existing.get(&id) {
            if old.as_ref() != Some(&row) {
                return Err(StoreError::Corrupt.into());
            }
            continue;
        }
        if suffix.is_empty() && raw.last().is_some_and(|b| *b != b'\n') {
            suffix.push('\n');
        }
        let encoded = write_json(&row);
        lines += 1;
        if encoded.len() > MAX_RECORD
            || lines > MAX_ROWS
            || raw.len() + suffix.len() + encoded.len() + 1 > MAX_BYTES
        {
            return Err(StoreError::Corrupt.into());
        }
        suffix.push_str(&encoded);
        suffix.push('\n');
    }
    Ok(suffix)
}
pub(super) fn prepare(
    session: &JobSession,
    state: &TrustedDirectory,
    dir: &TrustedDirectory,
    source: Vec<u8>,
    now: f64,
    planned: &Plan,
    cancel: &Cancel,
) -> Result<Receipt, EngineError> {
    let before = String::from_utf8(source).map_err(|_| StoreError::Corrupt)?;
    let after = write_json(planned.state.as_ref().ok_or(StoreError::Corrupt)?);
    if after.len() > STATE_MAX {
        return Err(StoreError::Corrupt.into());
    }
    let raw = io::read(dir, "ledger.jsonl", MAX_BYTES, cancel)?.unwrap_or_default();
    let backup = io::read(state, BACKUP, STATE_MAX, cancel)?;
    let backup_sha = Sha256::digest(backup.as_deref().unwrap_or(before.as_bytes())).into();
    Ok(Receipt {
        version: 1,
        agent: session.ledger.agent.clone(),
        state_path: state
            .path()
            .to_str()
            .ok_or(StoreError::UntrustedPath)?
            .into(),
        state_identity: state.identity_parts(),
        ledger_path: dir.path().to_str().ok_or(StoreError::UntrustedPath)?.into(),
        ledger_identity: dir.identity_parts(),
        source_identity: io::identity(state, FILE)?.ok_or(StoreError::Corrupt)?,
        backup_sha,
        backup_file: io::identity(state, BACKUP)?,
        before,
        after,
        now,
        prefix: raw.len(),
        prefix_sha: Sha256::digest(&raw).into(),
        ledger_file: io::identity(dir, "ledger.jsonl")?,
        suffix: suffix(&raw, planned, cancel)?,
        migrated: planned.rows.len(),
        complete: false,
    })
}
pub(super) fn validate(
    receipt: &Receipt,
    session: &JobSession,
    state: &TrustedDirectory,
    dir: &TrustedDirectory,
    cancel: &Cancel,
) -> Result<Vec<u8>, EngineError> {
    if receipt.version != 1
        || receipt.agent != session.ledger.agent
        || receipt.state_path != state.path().to_str().ok_or(StoreError::UntrustedPath)?
        || receipt.state_identity != state.identity_parts()
        || receipt.ledger_path != dir.path().to_str().ok_or(StoreError::UntrustedPath)?
        || receipt.ledger_identity != dir.identity_parts()
    {
        return Err(StoreError::UntrustedPath.into());
    }
    let planned = plan(Some(&receipt.before), &receipt.agent, receipt.now, cancel)?;
    if planned.status != Status::Migrated
        || planned.rows.len() != receipt.migrated
        || planned.state.as_ref().map(write_json).as_deref() != Some(&receipt.after)
        || receipt.after.len() > STATE_MAX
    {
        return Err(StoreError::Corrupt.into());
    }
    let current = io::read(state, FILE, STATE_MAX, cancel)?.ok_or(StoreError::Corrupt)?;
    let backup = io::read(state, BACKUP, STATE_MAX, cancel)?;
    if receipt.backup_file.is_some() && io::identity(state, BACKUP)? != receipt.backup_file {
        return Err(StoreError::UntrustedPath.into());
    }
    if let Some(bytes) = backup {
        let digest: [u8; 32] = Sha256::digest(&bytes).into();
        if digest != receipt.backup_sha {
            return Err(StoreError::Corrupt.into());
        }
    } else if receipt.backup_file.is_some() {
        return Err(StoreError::Corrupt.into());
    }
    if current == receipt.before.as_bytes() {
        if io::identity(state, FILE)? != Some(receipt.source_identity) {
            return Err(StoreError::UntrustedPath.into());
        }
    } else if current != receipt.after.as_bytes() {
        return Err(StoreError::Corrupt.into());
    }
    let raw = io::read(dir, "ledger.jsonl", MAX_BYTES, cancel)?.unwrap_or_default();
    if receipt.prefix > raw.len()
        || receipt.ledger_file.is_some()
            && io::identity(dir, "ledger.jsonl")? != receipt.ledger_file
    {
        return Err(StoreError::Corrupt.into());
    }
    let prefix = &raw[..receipt.prefix];
    let digest: [u8; 32] = Sha256::digest(prefix).into();
    if digest != receipt.prefix_sha || suffix(prefix, &planned, cancel)? != receipt.suffix {
        return Err(StoreError::Corrupt.into());
    }
    let present = &raw[receipt.prefix..];
    if !receipt.suffix.as_bytes().starts_with(present)
        || current == receipt.after.as_bytes() && present.len() != receipt.suffix.len()
    {
        return Err(StoreError::Corrupt.into());
    }
    Ok(current)
}

/// A shared run-state file cannot advance past another agent's interrupted transaction.
/// Scan only native receipts, with explicit entry and byte budgets, under run-state-writer.
pub(super) fn check_other_receipts(
    state: &TrustedDirectory,
    own_name: &str,
    cancel: &Cancel,
) -> Result<(), EngineError> {
    let mut count = 0;
    let mut bytes = 0usize;
    for (index, entry) in std::fs::read_dir(state.path())
        .map_err(StoreError::from)?
        .enumerate()
    {
        cancel.check()?;
        if index >= 50_000 {
            return Err(StoreError::Corrupt.into());
        }
        let entry = entry.map_err(StoreError::from)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name == own_name
            || !name.starts_with("native-job-migration-")
            || !name.ends_with(".json")
        {
            continue;
        }
        count += 1;
        if count > 128 {
            return Err(StoreError::Corrupt.into());
        }
        let raw = io::read(state, name, RECEIPT_MAX.saturating_sub(bytes), cancel)?
            .ok_or(StoreError::Corrupt)?;
        bytes += raw.len();
        let receipt = decode(&raw)?;
        if receipt.version != 1 || format!("native-job-migration-{}.json", receipt.agent) != name {
            return Err(StoreError::Corrupt.into());
        }
        if !receipt.complete {
            return Err(StoreError::Busy.into());
        }
    }
    state.assert_unchanged()?;
    Ok(())
}
