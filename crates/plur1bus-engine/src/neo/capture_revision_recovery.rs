//! Read-only original-caller inventory for human revision startup, separate from capture policy.
use super::*;
use crate::neo::{
    caller,
    derived_fields::{bool_field, field},
    revision_io, revision_plan,
};

impl CaptureJournal {
    pub(in crate::neo) fn revision_callers(
        &self,
        cancel: &Cancel,
    ) -> Result<Vec<caller::Caller>, EngineError> {
        cancel.check()?;
        self.root.assert_unchanged()?;
        let Some(parent) = optional(self.root.open_child("workspaces"))? else {
            return Ok(vec![]);
        };
        let mut callers = Vec::new();
        let mut bytes = 0usize;
        for (index, entry) in std::fs::read_dir(parent.path())
            .map_err(StoreError::from)?
            .enumerate()
        {
            cancel.check()?;
            if index >= journal_io::MAX_ROWS {
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
            let Some((state, actual_bytes)) = revision_io::state_with_size(&dir, cancel)? else {
                continue;
            };
            bytes = bytes
                .checked_add(actual_bytes)
                .ok_or(StoreError::Unavailable)?;
            if bytes > journal_io::MAX_BYTES {
                return Err(StoreError::Unavailable.into());
            }
            if bool_field(&state, "complete")? {
                continue;
            }
            transaction::guard_automatic_pending(&dir, cancel)?;
            if callers.len() == 512 {
                return Err(StoreError::Unavailable.into());
            }
            let caller = caller::decode(field(&state, "caller")?)?;
            let binding = self.bind(&caller.principal, &caller.agent)?;
            if field(&state, "ownership")? != &binding.proof || binding.layout.canonical != name {
                return Err(StoreError::Corrupt.into());
            }
            let actual = self
                .directory(&binding, false)?
                .ok_or(StoreError::Corrupt)?;
            if actual.identity_parts() != dir.identity_parts() {
                return Err(StoreError::UntrustedPath.into());
            }
            let _ = revision_plan::validate(&dir, &binding.proof, &binding.ctx, &state, cancel)?;
            let audit = binding.workspace.open_child(".adaptive-learning")?;
            revision_io::preflight(&dir, &audit, &state, cancel)?;
            self.check(&binding, &caller.principal, &caller.agent, cancel)?;
            dir.assert_unchanged()?;
            parent.assert_unchanged()?;
            callers.push(caller);
        }
        self.root.assert_unchanged()?;
        parent.assert_unchanged()?;
        cancel.check()?;
        Ok(callers)
    }
}
