//! Bounded inventory restores original interference callers, never a new startup principal.
use super::*;
use crate::ops::{interference::InterferenceRequest, interference_state as state};
impl CaptureJournal {
    pub(crate) fn interference_requests(
        &self,
        cancel: &Cancel,
    ) -> Result<Vec<(InterferenceRequest, Principal, AgentContext)>, EngineError> {
        cancel.check()?;
        self.root.assert_unchanged()?;
        let Some(parent) = optional(self.root.open_child("workspaces"))? else {
            return Ok(Vec::new());
        };
        let mut requests = Vec::new();
        let mut bytes = 0usize;
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
            for (file, receipt, size) in state::receipts(&dir, cancel)? {
                bytes = bytes.checked_add(size).ok_or(StoreError::Unavailable)?;
                count += 1;
                if count > 512 || bytes > 64 * 1024 * 1024 {
                    return Err(StoreError::Unavailable.into());
                }
                if receipt.complete {
                    continue;
                }
                let principal: Principal =
                    serde_json::from_value(receipt.principal).map_err(|_| StoreError::Corrupt)?;
                let agent: AgentContext =
                    serde_json::from_value(receipt.agent).map_err(|_| StoreError::Corrupt)?;
                let binding = self.bind(&principal, &agent)?;
                let proof: serde_json::Value = serde_json::from_str(&write_json(&binding.proof))
                    .map_err(|_| StoreError::Corrupt)?;
                let expected = format!(
                    "native-interference-{}.json",
                    state::hash(format!("{}:{}", binding.file, receipt.operation_id).as_bytes())
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
                self.check(&binding, &principal, &agent, cancel)?;
                requests.push((
                    InterferenceRequest {
                        operation_id: receipt.operation_id,
                        source: receipt.source.record(),
                        options: receipt.options,
                    },
                    principal,
                    agent,
                ));
            }
            dir.assert_unchanged()?;
            parent.assert_unchanged()?;
        }
        cancel.check()?;
        self.root.assert_unchanged()?;
        parent.assert_unchanged()?;
        Ok(requests)
    }
}
