//! Agent-session-owned migration: immutable first copy, exact ledger replay, then state marker.
use super::*;
use crate::{
    jobs::migration::{plan, Status},
    store::kernel_lease,
};
use std::path::Path;
#[path = "migration_io.rs"]
mod publication;
#[path = "migration_state.rs"]
mod state;
const FILE: &str = "run-state.json";
const BACKUP: &str = "run-state.json.migrated";
const STATE_MAX: usize = 2 * 1024 * 1024;
const RECEIPT_MAX: usize = 16 * 1024 * 1024;
/// Acknowledged legacy metadata result; never a job execution or permission receipt.
#[derive(Debug)]
pub struct MigrationReport {
    /// A1-compatible classification for a fresh migration; active native recovery reports Migrated.
    pub status: Status,
    /// Number of selected legacy completions, including verified already-imported rows.
    pub migrated: usize,
    /// A prior prepared native receipt was resumed with its original clock and bytes.
    pub recovered: bool,
}
impl JobSession {
    /// Migrate an explicitly host-selected physical state directory after orphan recovery and
    /// before admitting bodies. Holds run-state-writer then job-ledger-writer; first-copy bytes
    /// are never refreshed. No memory/card authority is implied by this metadata operation.
    pub fn migrate_legacy(
        &mut self,
        root: &Path,
        now: f64,
        cancel: &Cancel,
    ) -> Result<MigrationReport, EngineError> {
        self.check(cancel)?;
        if !self.recovered || !self.ledger.orphan_markers(cancel)?.is_empty() {
            return Err(StoreError::Busy.into());
        }
        let state = TrustedDirectory::open(root)?;
        let receipt_name = format!("native-job-migration-{}.json", self.ledger.agent);
        if io::read(&state, FILE, STATE_MAX, cancel)?.is_none()
            && io::read(&state, &receipt_name, RECEIPT_MAX, cancel)?.is_none()
        {
            return Ok(MigrationReport {
                status: Status::Absent,
                migrated: 0,
                recovered: false,
            });
        }
        state.restrict_private()?;
        let lease = kernel_lease::acquire(&state, "run-state-writer", cancel, &mut || {})?;
        let check = || {
            self.check(cancel)?;
            state.assert_unchanged()?;
            lease.check(&state)?;
            Ok(())
        };
        check()?;
        self.ledger.write(cancel, |dir| {
            check()?;
            state::check_other_receipts(&state, &receipt_name, cancel)?;
            if !self.ledger.orphan_markers(cancel)?.is_empty() {
                return Err(StoreError::Busy.into());
            }
            let old = io::read(&state, &receipt_name, RECEIPT_MAX, cancel)?;
            let saved = old.as_deref().map(state::decode).transpose()?;
            let active = saved.as_ref().is_some_and(|r| !r.complete);
            let mut receipt = if active {
                saved.ok_or(StoreError::Corrupt)?
            } else {
                let source = io::read(&state, FILE, STATE_MAX, cancel)?;
                let raw = source
                    .as_deref()
                    .map(std::str::from_utf8)
                    .transpose()
                    .map_err(|_| StoreError::Corrupt)?;
                let planned = plan(raw, &self.ledger.agent, now, cancel)?;
                if planned.status != Status::Migrated {
                    if planned.preserve_original {
                        keep_copy(
                            &state,
                            source.as_deref().ok_or(StoreError::Corrupt)?,
                            cancel,
                            &check,
                        )?;
                    }
                    return Ok(MigrationReport {
                        status: planned.status,
                        migrated: 0,
                        recovered: false,
                    });
                }
                state::prepare(
                    self,
                    &state,
                    dir,
                    source.ok_or(StoreError::Corrupt)?,
                    now,
                    &planned,
                    cancel,
                )?
            };
            state::validate(&receipt, self, &state, dir, cancel)?;
            if !active {
                publication::replace(
                    &state,
                    &receipt_name,
                    old.as_deref(),
                    &state::encode(&receipt)?,
                    RECEIPT_MAX,
                    cancel,
                    &check,
                )?;
            }
            self.observe("migration-prepared");
            check()?;
            verify_receipt(&state, &receipt_name, &receipt, cancel)?;
            state::validate(&receipt, self, &state, dir, cancel)?;
            keep_copy(&state, receipt.before.as_bytes(), cancel, &check)?;
            state::validate(&receipt, self, &state, dir, cancel)?;
            let before = state::encode(&receipt)?;
            receipt.backup_file = Some(io::identity(&state, BACKUP)?.ok_or(StoreError::Corrupt)?);
            publication::replace(
                &state,
                &receipt_name,
                Some(&before),
                &state::encode(&receipt)?,
                RECEIPT_MAX,
                cancel,
                &check,
            )?;
            self.observe("migration-backup");
            check()?;
            verify_receipt(&state, &receipt_name, &receipt, cancel)?;
            state::validate(&receipt, self, &state, dir, cancel)?;
            if !receipt.suffix.is_empty() {
                dir.append_binary_replay_durable(
                    "ledger.jsonl",
                    receipt.prefix as u64,
                    &receipt.prefix_sha,
                    receipt.suffix.as_bytes(),
                    MAX_BYTES,
                    cancel,
                )?;
            } else if io::identity(dir, "ledger.jsonl")?.is_some() {
                dir.sync_file_durable("ledger.jsonl")?;
            }
            state::validate(&receipt, self, &state, dir, cancel)?;
            let before = state::encode(&receipt)?;
            receipt.ledger_file = io::identity(dir, "ledger.jsonl")?;
            if receipt.ledger_file.is_some() {
                dir.sync_file_durable("ledger.jsonl")?;
            }
            state::validate(&receipt, self, &state, dir, cancel)?;
            publication::replace(
                &state,
                &receipt_name,
                Some(&before),
                &state::encode(&receipt)?,
                RECEIPT_MAX,
                cancel,
                &check,
            )?;
            self.observe("migration-rows");
            check()?;
            verify_receipt(&state, &receipt_name, &receipt, cancel)?;
            let current = state::validate(&receipt, self, &state, dir, cancel)?;
            if current != receipt.after.as_bytes() {
                publication::replace(
                    &state,
                    FILE,
                    Some(&current),
                    receipt.after.as_bytes(),
                    STATE_MAX,
                    cancel,
                    &check,
                )?;
            }
            self.observe("migration-state");
            check()?;
            verify_receipt(&state, &receipt_name, &receipt, cancel)?;
            state::validate(&receipt, self, &state, dir, cancel)?;
            let before =
                io::read(&state, &receipt_name, RECEIPT_MAX, cancel)?.ok_or(StoreError::Corrupt)?;
            if before != state::encode(&receipt)? {
                return Err(StoreError::Corrupt.into());
            }
            receipt.complete = true;
            publication::replace(
                &state,
                &receipt_name,
                Some(&before),
                &state::encode(&receipt)?,
                RECEIPT_MAX,
                cancel,
                &check,
            )?;
            self.observe("migration-complete");
            check()?;
            verify_receipt(&state, &receipt_name, &receipt, cancel)?;
            state::validate(&receipt, self, &state, dir, cancel)?;
            Ok(MigrationReport {
                status: Status::Migrated,
                migrated: receipt.migrated,
                recovered: active,
            })
        })
    }
}
fn keep_copy(
    dir: &TrustedDirectory,
    before: &[u8],
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    if io::read(dir, BACKUP, STATE_MAX, cancel)?.is_none() {
        publication::replace(dir, BACKUP, None, before, STATE_MAX, cancel, check)?;
    } else {
        dir.sync_file_durable(BACKUP)?;
    }
    check()
}

fn verify_receipt(
    dir: &TrustedDirectory,
    name: &str,
    receipt: &state::Receipt,
    cancel: &Cancel,
) -> Result<(), EngineError> {
    if io::read(dir, name, RECEIPT_MAX, cancel)?.as_deref()
        != Some(state::encode(receipt)?.as_slice())
    {
        return Err(StoreError::Corrupt.into());
    }
    Ok(())
}
