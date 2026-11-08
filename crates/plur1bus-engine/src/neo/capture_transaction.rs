//! Internal writer composition for restored callers without fabricating a new TurnRecord.
use super::*;
pub(super) fn guard_automatic_pending(
    dir: &TrustedDirectory,
    cancel: &Cancel,
) -> Result<(), EngineError> {
    let mut size = 0usize;
    for (index, entry) in std::fs::read_dir(dir.path())
        .map_err(StoreError::from)?
        .enumerate()
    {
        cancel.check()?;
        if index >= journal_io::MAX_ROWS {
            return Err(StoreError::Unavailable.into());
        }
        let name = entry
            .map_err(StoreError::from)?
            .file_name()
            .into_string()
            .map_err(|_| StoreError::UntrustedPath)?;
        let capture = name.starts_with("native-capture-pending-");
        if !name.ends_with(".json")
            || !(capture
                || name.starts_with("native-episode-pending-")
                || name.starts_with("native-embedding-pending-"))
        {
            continue;
        }
        let bytes = journal_io::bytes(dir, &name, cancel)?.ok_or(StoreError::Corrupt)?;
        size = size
            .checked_add(bytes.len())
            .ok_or(StoreError::Unavailable)?;
        if size > journal_io::MAX_BYTES {
            return Err(StoreError::Unavailable.into());
        }
        let value = crate::text::json::parse_json(
            std::str::from_utf8(&bytes).map_err(|_| StoreError::Corrupt)?,
        )
        .map_err(|_| StoreError::Corrupt)?;
        super::super::derived_fields::validate_object(&value)?;
        let active = if capture {
            let Json::Array(groups) = super::super::derived_fields::field(&value, "records")?
            else {
                return Err(StoreError::Corrupt.into());
            };
            if groups.len() != FILES.len() || groups.iter().any(|v| !matches!(v, Json::Array(_))) {
                return Err(StoreError::Corrupt.into());
            }
            groups
                .iter()
                .any(|v| matches!(v,Json::Array(rows) if !rows.is_empty()))
        } else {
            match super::super::derived_fields::field(&value, "plan")? {
                Json::Null => false,
                Json::Object(_) => true,
                _ => return Err(StoreError::Corrupt.into()),
            }
        };
        if active {
            return Err(StoreError::Busy.into());
        }
    }
    dir.assert_unchanged()?;
    Ok(())
}
impl CaptureJournal {
    /// Human operations hold the same leases but must not replay automatic work with their policy.
    pub(crate) fn with_operation_writer<T>(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        expected: &RequestContext,
        cancel: &Cancel,
        extra: &dyn Fn() -> Result<(), EngineError>,
        action: impl FnOnce(
            &TrustedDirectory,
            &Json,
            &str,
            &dyn Fn() -> Result<(), EngineError>,
        ) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        extra()?;
        let binding = self.bind(principal, agent)?;
        if &binding.ctx != expected {
            return Err(StoreError::InvalidInput.into());
        }
        let directory = self
            .directory(&binding, true)?
            .ok_or(StoreError::Unavailable)?;
        self.with_locks(&binding, &directory, principal, agent, cancel, |check| {
            let guarded = || {
                extra()?;
                check()
            };
            guard_automatic_pending(&directory, cancel)?;
            guarded()?;
            action(&directory, &binding.proof, &binding.file, &guarded)
        })
    }
    pub(in crate::neo) fn with_writer<T>(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        expected: &RequestContext,
        cancel: &Cancel,
        extra: &dyn Fn() -> Result<(), EngineError>,
        action: impl FnOnce(
            &TrustedDirectory,
            &Json,
            &str,
            &dyn Fn() -> Result<(), EngineError>,
        ) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        extra()?;
        let binding = self.bind(principal, agent)?;
        if &binding.ctx != expected {
            return Err(StoreError::InvalidInput.into());
        }
        let directory = self
            .directory(&binding, true)?
            .ok_or(StoreError::Unavailable)?;
        self.with_locks(&binding, &directory, principal, agent, cancel, |check| {
            let guarded = || -> Result<(), EngineError> {
                extra()?;
                check()
            };
            super::super::revision_io::guard_pending(&directory, cancel)?;
            self.replay(&binding, &directory, cancel, &guarded)?;
            guarded()?;
            let name = binding
                .file
                .replace("native-capture-pending-", "native-episode-pending-");
            action(&directory, &binding.proof, &name, &guarded)
        })
    }
}
