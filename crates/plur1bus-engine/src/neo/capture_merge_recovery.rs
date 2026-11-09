//! Only saved original principals can recover durable merge plans.
use super::*;
use crate::ops::{
    durable_merge::{restore, RestoredMerge},
    durable_merge_state as state,
};
impl CaptureJournal {
    pub(crate) fn merge_requests(
        &self,
        cancel: &Cancel,
    ) -> Result<Vec<RestoredMerge>, EngineError> {
        cancel.check()?;
        self.root.assert_unchanged()?;
        let Some(parent) = optional(self.root.open_child("workspaces"))? else {
            return Ok(Vec::new());
        };
        let mut plans = Vec::new();
        let mut total = 0usize;
        let mut count = 0usize;
        for (i, entry) in std::fs::read_dir(parent.path())
            .map_err(StoreError::from)?
            .enumerate()
        {
            cancel.check()?;
            if i >= 50_000 {
                return Err(StoreError::Unavailable.into());
            }
            let entry = entry.map_err(StoreError::from)?;
            let kind = entry.file_type().map_err(StoreError::from)?;
            if kind.is_symlink() {
                return Err(StoreError::UntrustedPath.into());
            }
            if !kind.is_dir() {
                continue;
            }
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| StoreError::UntrustedPath)?;
            let dir = parent.open_child(&name)?;
            for (file, receipt, bytes) in state::receipts(&dir, cancel)? {
                count += 1;
                total = total
                    .checked_add(bytes.len())
                    .ok_or(StoreError::Unavailable)?;
                if count > 512 || total > 64 * 1024 * 1024 {
                    return Err(StoreError::Unavailable.into());
                }
                if receipt.stage == 6 {
                    continue;
                }
                let (request, principal, agent) = restore(&receipt.plan, cancel)?;
                let identity = crate::capture::durable_merge::identity(
                    principal.agent_id.as_str(),
                    &request.source.row.id,
                    &JsString::from(if request.write_key.is_empty() {
                        request.source.row.text.as_str()
                    } else {
                        request.write_key.as_str()
                    }),
                    cancel,
                )?;
                let binding = self.bind(&principal, &agent)?;
                let proof: serde_json::Value = serde_json::from_str(&write_json(&binding.proof))
                    .map_err(|_| StoreError::Corrupt)?;
                let expected = format!(
                    "native-durable-merge-{}.json",
                    crate::ops::interference_state::hash(
                        format!("{}:{}", binding.file, identity.idempotency_key).as_bytes()
                    )
                );
                if receipt.proof != proof || binding.layout.canonical != name || file != expected {
                    return Err(StoreError::Corrupt.into());
                }
                let actual = self
                    .directory(&binding, false)?
                    .ok_or(StoreError::Corrupt)?;
                if actual.identity_parts() != dir.identity_parts() {
                    return Err(StoreError::UntrustedPath.into());
                }
                transaction::guard_automatic_pending(&dir, cancel)?;
                Self::guard_non_merge_pending(&dir, cancel)?;
                crate::ops::normal_insert_state::guard_pending(&dir, cancel)?;
                crate::ops::conflict_application_state::guard_pending(&dir, cancel)?;
                self.check(&binding, &principal, &agent, cancel)?;
                plans.push((request, principal, agent));
            }
            dir.assert_unchanged()?;
            parent.assert_unchanged()?;
        }
        cancel.check()?;
        self.root.assert_unchanged()?;
        parent.assert_unchanged()?;
        Ok(plans)
    }
}
