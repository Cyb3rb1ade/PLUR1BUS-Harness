//! Bounded duplicate-rejection receipts, each owning one curation occurrence.
use super::conflict_file as io;
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::directory::TrustedDirectory,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub(crate) const MAX_STATE: usize = 8 * 1024 * 1024;
const PREFIX: &str = "native-normal-duplicate-";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Receipt {
    pub version: u8,
    pub plan: Value,
    pub fingerprint: String,
    pub proof: Value,
    pub publication: super::curation_occurrence::Snapshot,
    pub complete: bool,
}
pub(crate) fn receipts(
    dir: &TrustedDirectory,
    cancel: &Cancel,
) -> Result<Vec<(String, Receipt, Vec<u8>)>, EngineError> {
    let mut result = Vec::new();
    let mut total = 0usize;
    for (i, entry) in std::fs::read_dir(dir.path())
        .map_err(StoreError::from)?
        .enumerate()
    {
        cancel.check()?;
        if i >= 50_000 {
            return Err(StoreError::Unavailable.into());
        }
        let entry = entry.map_err(StoreError::from)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(PREFIX) || !name.ends_with(".json") {
            continue;
        }
        if result.len() >= 512 {
            return Err(StoreError::Unavailable.into());
        }
        let bytes = io::read(dir, name, MAX_STATE, cancel)?.ok_or(StoreError::Corrupt)?;
        total = total
            .checked_add(bytes.len())
            .ok_or(StoreError::Unavailable)?;
        if total > 64 * 1024 * 1024 {
            return Err(StoreError::Unavailable.into());
        }
        let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|_| StoreError::Corrupt)?;
        let digest = format!(
            "sha256:{}",
            super::interference_state::hash(
                &serde_json::to_vec(&receipt.plan).map_err(|_| StoreError::Corrupt)?
            )
        );
        if receipt.fingerprint != digest
            || receipt.version != 1
            || receipt.plan["command"] != "memory-store-duplicate"
            || receipt.plan["version"] != 1
            || !receipt.fingerprint.starts_with("sha256:")
        {
            return Err(StoreError::Corrupt.into());
        }
        result.push((name.into(), receipt, bytes));
    }
    dir.assert_unchanged()?;
    Ok(result)
}
pub(crate) fn save(
    dir: &TrustedDirectory,
    name: &str,
    old: Option<&[u8]>,
    receipt: &Receipt,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<Vec<u8>, EngineError> {
    let inventory = receipts(dir, cancel)?;
    let total: usize = inventory.iter().map(|(_, _, bytes)| bytes.len()).sum();
    let mut bytes = serde_json::to_vec(receipt).map_err(|_| StoreError::Corrupt)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_STATE
        || (old.is_none() && inventory.len() >= 512)
        || total.saturating_sub(old.map_or(0, <[u8]>::len)) + bytes.len() > 64 * 1024 * 1024
    {
        return Err(StoreError::Unavailable.into());
    }
    io::replace(dir, name, old, &bytes, cancel, check)?;
    Ok(bytes)
}
pub(crate) fn guard_pending(dir: &TrustedDirectory, cancel: &Cancel) -> Result<(), EngineError> {
    if receipts(dir, cancel)?.iter().any(|(_, r, _)| !r.complete) {
        return Err(StoreError::Busy.into());
    }
    Ok(())
}
