//! Emergency bounds under the same original-caller leases as the source append.
use super::*;
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct CapScan(BTreeMap<&'static str, ([u8; 32], usize)>);

impl CaptureJournal {
    pub(super) fn cap(
        &self,
        binding: &Binding,
        dir: &TrustedDirectory,
        cancel: &Cancel,
        check: &dyn Fn() -> Result<(), EngineError>,
        scan: &mut CapScan,
    ) -> Result<(), EngineError> {
        let policy = super::super::store_policy::StorePolicy::from_config(&self.host.config())?;
        let mut over = Vec::new();
        for name in super::super::append_cap::FILES {
            let Some((source, bytes)) =
                super::super::append_source::SourceProof::read(dir, name, cancel)?
            else {
                continue;
            };
            let digest = source.digest();
            // Recheck the file and bytes on every pass. The held lease lets a later pass
            // reuse the JSON validation only when those exact bytes are still present.
            if scan
                .0
                .get(name)
                .is_some_and(|&(previous, rows)| digest == previous && rows <= policy.max_records)
            {
                continue;
            }
            let rows = journal_io::parse_rows(&bytes, cancel)?;
            if rows.len() <= policy.max_records {
                scan.0.insert(name, (digest, rows.len()));
                continue;
            }
            // No principal may use append housekeeping to archive another owner's records.
            if rows.iter().any(|row| !journal_io::owned(row, &binding.ctx)) {
                return Err(StoreError::InvalidInput.into());
            }
            over.push((name, source));
        }
        if over.is_empty() {
            return Ok(());
        }
        transaction::guard_automatic_pending(dir, cancel)?;
        Self::guard_non_application_pending(dir, cancel)?;
        crate::ops::conflict_application_state::guard_pending(dir, cancel)?;
        let guarded = || {
            check()?;
            if super::super::store_policy::StorePolicy::from_config(&self.host.config())? != policy
            {
                return Err(StoreError::InvalidInput.into());
            }
            Ok(())
        };
        super::super::append_history::preserve(dir, cancel, &guarded)?;
        for (name, source) in over {
            super::super::append_cap::compact(
                dir,
                name,
                &source,
                policy.max_records,
                cancel,
                &guarded,
            )?;
        }
        Ok(())
    }
}
