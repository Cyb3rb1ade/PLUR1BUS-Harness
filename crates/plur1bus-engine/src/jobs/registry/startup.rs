//! Explicit metadata roots are held at configuration time and migrated before any body admission.
use super::*;
impl Registry {
    /// Add one host-selected legacy state directory for this agent before the first real run.
    /// No scanning, file creation, owner inference or data authority is performed. At most 128
    /// roots may be configured; duplicate physical roots and reconfiguration after admission refuse.
    pub fn with_legacy_state_root(
        mut self,
        agent: &AgentId,
        root: &Path,
    ) -> Result<Self, EngineError> {
        self.check(&Cancel::never())?;
        if !self
            .agents
            .get_mut()
            .map_err(|_| StoreError::Corrupt)?
            .is_empty()
            || self.legacy.values().map(Vec::len).sum::<usize>() >= 128
        {
            return Err(StoreError::Busy.into());
        }
        crate::jobs::migration::plan(None, agent.as_ref(), 0., &Cancel::never())?;
        let dir = TrustedDirectory::open(root)?;
        let roots = self.legacy.entry(agent.to_string()).or_default();
        if roots
            .iter()
            .any(|old| old.identity_parts() == dir.identity_parts())
        {
            return Err(StoreError::InvalidInput.into());
        }
        roots.push(dir);
        Ok(self)
    }
    pub(super) fn start_session(
        &self,
        agent: &AgentId,
        cancel: &Cancel,
    ) -> Result<JobSession, EngineError> {
        self.check(cancel)?;
        let mut session = JobLedger::open(self.root.path(), agent.as_ref())?.session(cancel)?;
        #[cfg(any(test, feature = "testkit"))]
        if let Some(observer) = &self.observer {
            session = session.with_observer(observer.clone());
        }
        session.recover((self.clock)() as f64, cancel)?;
        if let Some(roots) = self.legacy.get::<str>(agent.as_ref()) {
            for root in roots {
                self.check(cancel)?;
                root.assert_unchanged()?;
                let result = session.migrate_legacy(root.path(), (self.clock)() as f64, cancel)?;
                root.assert_unchanged()?;
                // A corrupt file preserves its first copy, but cannot establish that a previous
                // window has not completed. Keep this agent unadmitted and retry after repair.
                if result.status == crate::jobs::migration::Status::Corrupt {
                    return Err(StoreError::Corrupt.into());
                }
            }
        }
        self.check(cancel)?;
        Ok(session)
    }
}
