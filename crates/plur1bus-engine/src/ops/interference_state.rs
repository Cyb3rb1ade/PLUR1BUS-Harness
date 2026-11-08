//! Bounded original-caller receipts; complete snapshots support exact before/after recovery.
use super::conflict_file as io;
use crate::capture::interference::{self, InterferenceOptions};
use crate::text::json::parse_json;
use crate::{
    contract::{Cancel, EngineError, MemoryRow, StoreError},
    store::{
        directory::TrustedDirectory,
        shared_row::{MemoryRecord, ShareMetadata},
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
pub(super) const MAX_STATE: usize = 8 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Record {
    pub row: MemoryRow,
    pub sharing: Option<ShareMetadata>,
}
impl From<MemoryRecord> for Record {
    fn from(v: MemoryRecord) -> Self {
        Self {
            row: v.row,
            sharing: v.sharing,
        }
    }
}
impl Record {
    pub fn record(&self) -> MemoryRecord {
        MemoryRecord {
            row: self.row.clone(),
            sharing: self.sharing.clone(),
        }
    }
    pub fn same(&self, other: &MemoryRecord) -> Result<bool, EngineError> {
        Ok(
            serde_json::to_value(&self.row).map_err(|_| StoreError::Corrupt)?
                == serde_json::to_value(&other.row).map_err(|_| StoreError::Corrupt)?
                && self.sharing == other.sharing,
        )
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Effect {
    pub before: Record,
    pub after: Record,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Receipt {
    pub version: u8,
    pub operation_id: uuid::Uuid,
    pub options: InterferenceOptions,
    pub digest: String,
    pub proof: Value,
    pub principal: Value,
    pub agent: Value,
    pub source: Record,
    pub effects: Vec<Effect>,
    pub complete: bool,
}
pub(crate) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn inventory(
    dir: &TrustedDirectory,
    cancel: &Cancel,
) -> Result<(usize, usize), EngineError> {
    let mut count = 0;
    let mut total = 0;
    for (i, entry) in std::fs::read_dir(dir.path())
        .map_err(StoreError::from)?
        .enumerate()
    {
        cancel.check()?;
        if i >= 50_000 {
            return Err(StoreError::Unavailable.into());
        }
        let name = entry.map_err(StoreError::from)?.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with("native-interference-") || !name.ends_with(".json") {
            continue;
        }
        count += 1;
        if count > 512 {
            return Err(StoreError::Unavailable.into());
        }
        total += io::read(dir, name, MAX_STATE, cancel)?
            .ok_or(StoreError::Corrupt)?
            .len();
        if total > 64 * 1024 * 1024 {
            return Err(StoreError::Unavailable.into());
        }
    }
    dir.assert_unchanged()?;
    Ok((count, total))
}
pub(super) fn save(
    dir: &TrustedDirectory,
    name: &str,
    old: Option<&[u8]>,
    value: &Receipt,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<Vec<u8>, EngineError> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| StoreError::Corrupt)?;
    bytes.push(b'\n');
    let (_, total) = inventory(dir, cancel)?;
    if total.saturating_sub(old.map_or(0, <[u8]>::len)) + bytes.len() > 64 * 1024 * 1024 {
        return Err(StoreError::Unavailable.into());
    }
    if bytes.len() > MAX_STATE {
        return Err(StoreError::InvalidInput.into());
    }
    io::replace(dir, name, old, &bytes, cancel, check)?;
    Ok(bytes)
}

pub(super) fn validate_effects(
    receipt: &Receipt,
    source: &crate::text::json::TolerantJsonValue,
    options: InterferenceOptions,
    cancel: &Cancel,
) -> Result<(), EngineError> {
    let now = if let Some(first) = receipt.effects.first() {
        let n = first
            .after
            .row
            .last_dynamics_at
            .as_f64()
            .ok_or(StoreError::Corrupt)?;
        if !n.is_finite() || n.abs() > 8_640_000_000_000_000. || n.fract() != 0. {
            return Err(StoreError::Corrupt.into());
        }
        n as i64
    } else {
        0
    };
    let inputs = receipt
        .effects
        .iter()
        .map(|e| {
            parse_json(&serde_json::to_string(&e.before.row).map_err(|_| StoreError::Corrupt)?)
                .map_err(|_| StoreError::Corrupt)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let expected = interference::plan(source, &inputs, now, options, cancel)?;
    if expected.len() != receipt.effects.len() {
        return Err(StoreError::Corrupt.into());
    }
    for (effect, expected) in receipt.effects.iter().zip(expected) {
        let mut projected = effect.before.clone();
        projected.row.memory_strength =
            serde_json::Number::from_f64(expected.memory_strength).ok_or(StoreError::Corrupt)?;
        projected.row.last_dynamics_at =
            serde_json::Number::from_f64(expected.last_dynamics_at as f64)
                .ok_or(StoreError::Corrupt)?;
        if !projected.same(&effect.after.record())? {
            return Err(StoreError::Corrupt.into());
        }
    }
    Ok(())
}

pub(crate) fn receipts(
    dir: &TrustedDirectory,
    cancel: &Cancel,
) -> Result<Vec<(String, Receipt, usize)>, EngineError> {
    inventory(dir, cancel)?;
    let mut result = Vec::new();
    let mut actual_bytes = 0usize;
    for (i, entry) in std::fs::read_dir(dir.path())
        .map_err(StoreError::from)?
        .enumerate()
    {
        cancel.check()?;
        if i >= 50_000 {
            return Err(StoreError::Unavailable.into());
        }
        let name = entry.map_err(StoreError::from)?.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with("native-interference-") || !name.ends_with(".json") {
            continue;
        }
        if result.len() >= 512 {
            return Err(StoreError::Unavailable.into());
        }
        let bytes = io::read(dir, name, MAX_STATE, cancel)?.ok_or(StoreError::Corrupt)?;
        actual_bytes = actual_bytes
            .checked_add(bytes.len())
            .ok_or(StoreError::Unavailable)?;
        if actual_bytes > 64 * 1024 * 1024 {
            return Err(StoreError::Unavailable.into());
        }
        let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|_| StoreError::Corrupt)?;
        if receipt.version != 1 {
            return Err(StoreError::Corrupt.into());
        }
        result.push((name.to_owned(), receipt, bytes.len()));
    }
    dir.assert_unchanged()?;
    Ok(result)
}

/// Automatic writers must not change sources beneath an unfinished original-caller plan.
pub(crate) fn guard_pending(dir: &TrustedDirectory, cancel: &Cancel) -> Result<(), EngineError> {
    if receipts(dir, cancel)?
        .iter()
        .any(|(_, receipt, _)| !receipt.complete)
    {
        return Err(StoreError::Busy.into());
    }
    Ok(())
}
