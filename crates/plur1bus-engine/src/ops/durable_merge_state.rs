//! Bounded normal-store merge receipts; archive/delete stages are independently durable.
use super::conflict_file as io;
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::directory::TrustedDirectory,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub(crate) const MAX_STATE: usize = 8 * 1024 * 1024;
const PREFIX: &str = "native-durable-merge-";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Receipt {
    pub version: u8,
    pub plan: Value,
    pub fingerprint: String,
    pub proof: Value,
    // 0 prepared, 1 archived, 2 replacement verified, 3 delete intent,
    // 4 source deleted, 5 audit durable, 6 complete.
    pub stage: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub curation: Option<CurationReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knowledge: Option<super::normal_insert_state::KnowledgeReceipt>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CurationReceipt {
    pub now_ms: i64,
    pub publication: super::curation_occurrence::Snapshot,
    pub complete: bool,
}
impl Receipt {
    pub(crate) fn pending(&self) -> bool {
        self.stage != 6
            || (self.plan.get("normal_origin").is_some()
                && !self.curation.as_ref().is_some_and(|r| r.complete))
            || (self.plan["normal_origin"]["version"] == 2
                && self.knowledge.as_ref().is_none_or(|r| r.stage != 3))
    }
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
            || receipt.stage > 6
            || (receipt.curation.is_some()
                && (receipt.stage != 6 || receipt.plan.get("normal_origin").is_none()))
            || receipt.knowledge.as_ref().is_some_and(|r| {
                r.stage > 3
                    || receipt.stage != 6
                    || receipt.plan["normal_origin"]["version"] != 2
                    || !receipt.curation.as_ref().is_some_and(|c| c.complete)
            })
            || receipt.version != 1
            || receipt.plan["command"] != "memory-store-merge"
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
    if receipts(dir, cancel)?.iter().any(|(_, r, _)| r.pending()) {
        return Err(StoreError::Busy.into());
    }
    Ok(())
}

/// Bound serialized input before materializing JSON trees, including non-text metadata fields.
pub(super) fn bounded_row(
    row: &crate::contract::MemoryRow,
    cancel: &Cancel,
) -> Result<(), EngineError> {
    struct Count<'a> {
        size: usize,
        cancel: &'a Cancel,
    }
    impl std::io::Write for Count<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.cancel.check().is_err() || bytes.len() > MAX_STATE.saturating_sub(self.size) {
                return Err(std::io::Error::other("merge-input-bound"));
            }
            self.size += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let result = serde_json::to_writer(Count { size: 0, cancel }, row);
    cancel.check()?;
    result.map_err(|_| StoreError::InvalidInput.into())
}
