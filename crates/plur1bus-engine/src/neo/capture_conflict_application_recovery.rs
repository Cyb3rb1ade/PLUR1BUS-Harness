//! Only saved original principals can recover confirmed conflict plans.
use super::*;
use crate::ops::{conflict_application_state as state, conflicts::ApplicationPlan};
impl CaptureJournal {
    pub(crate) fn conflict_application_plans(
        &self,
        cancel: &Cancel,
    ) -> Result<Vec<ApplicationPlan>, EngineError> {
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
                if receipt.complete {
                    continue;
                }
                let plan = ApplicationPlan::from_saved(&receipt.plan, receipt.fingerprint, cancel)?;
                let (principal, agent) = plan.original_caller()?;
                let binding = self.bind(&principal, &agent)?;
                let proof: serde_json::Value = serde_json::from_str(&write_json(&binding.proof))
                    .map_err(|_| StoreError::Corrupt)?;
                let expected = format!(
                    "native-conflict-application-{}.json",
                    crate::ops::interference_state::hash(
                        format!("{}:{}", binding.file, plan.operation_id()).as_bytes()
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
                Self::guard_non_application_pending(&dir, cancel)?;
                self.check(&binding, &principal, &agent, cancel)?;
                plans.push(plan);
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
