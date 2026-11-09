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
    /// Read-side idempotency checks hold the writer leases without running append housekeeping.
    pub(crate) fn with_operation_reader<T>(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        expected: &RequestContext,
        cancel: &Cancel,
        extra: &dyn Fn() -> Result<(), EngineError>,
        action: impl FnOnce(
            &TrustedDirectory,
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
        self.with_leases(&binding, &directory, principal, agent, cancel, |check| {
            let guarded = || {
                extra()?;
                check()
            };
            guard_automatic_pending(&directory, cancel)?;
            Self::guard_non_application_pending(&directory, cancel)?;
            crate::ops::conflict_application_state::guard_pending(&directory, cancel)?;
            guarded()?;
            action(&directory, &guarded)
        })
    }
    pub(crate) fn guard_non_application_pending(
        directory: &TrustedDirectory,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        crate::ops::normal_insert_state::guard_pending(directory, cancel)?;
        crate::ops::normal_duplicate_state::guard_pending(directory, cancel)?;
        crate::ops::durable_merge_state::guard_pending(directory, cancel)?;
        Self::guard_non_merge_pending(directory, cancel)
    }
    pub(crate) fn guard_non_merge_pending(
        directory: &TrustedDirectory,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        crate::ops::interference_state::guard_pending(directory, cancel)?;
        if super::super::revision_io::state(directory, cancel)?.is_some_and(|value| {
            !super::super::derived_fields::bool_field(&value, "complete")
                .is_ok_and(|complete| complete)
        }) {
            return Err(StoreError::Busy.into());
        }
        Ok(())
    }

    /// Shrinking cleanup holds all writer leases and pending-plan guards without append caps.
    /// Its caller must retain opaque foreign bytes instead of parsing them as append input.
    pub(crate) fn with_operation_cleanup<T>(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        expected: &RequestContext,
        cancel: &Cancel,
        extra: &dyn Fn() -> Result<(), EngineError>,
        action: impl FnOnce(
            &TrustedDirectory,
            &dyn Fn() -> Result<(), EngineError>,
        ) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        self.with_operation_reader(principal, agent, expected, cancel, extra, action)
    }

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
        self.with_conflict_application_writer(
            principal,
            agent,
            expected,
            cancel,
            extra,
            |dir, proof, binding, check| {
                crate::ops::conflict_application_state::guard_pending(dir, cancel)?;
                action(dir, proof, binding, check)
            },
        )
    }
    /// The owning confirmed-application component validates and resumes its own pending receipt.
    pub(crate) fn with_conflict_application_writer<T>(
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
        self.with_merge_writer(
            principal,
            agent,
            expected,
            cancel,
            extra,
            |dir, proof, binding, check| {
                crate::ops::durable_merge_state::guard_pending(dir, cancel)?;
                action(dir, proof, binding, check)
            },
        )
    }
    /// Owning merge validates its own pending receipt; other writers remain fenced.
    pub(crate) fn with_merge_writer<T>(
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
        self.with_normal_store_writer(
            principal,
            agent,
            expected,
            cancel,
            extra,
            |dir, proof, binding, check| {
                crate::ops::normal_insert_state::guard_pending(dir, cancel)?;
                action(dir, proof, binding, check)
            },
        )
    }
    /// Owning ordinary primary store validates its own pending receipt; other writers remain fenced.
    pub(crate) fn with_normal_store_writer<T>(
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
        self.with_foreground_writer(
            principal,
            agent,
            expected,
            cancel,
            extra,
            |dir, proof, binding, check| {
                crate::ops::normal_duplicate_state::guard_pending(dir, cancel)?;
                action(dir, proof, binding, check)
            },
        )
    }
    /// Owning duplicate rejection validates its receipt while ordinary intents remain fenced.
    pub(crate) fn with_normal_duplicate_writer<T>(
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
        self.with_foreground_writer(
            principal,
            agent,
            expected,
            cancel,
            extra,
            |dir, proof, binding, check| {
                crate::ops::normal_insert_state::guard_pending(dir, cancel)?;
                action(dir, proof, binding, check)
            },
        )
    }
    fn with_foreground_writer<T>(
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
