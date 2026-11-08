//! Internal writer composition for restored callers without fabricating a new TurnRecord.
use super::*;
impl CaptureJournal {
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
            self.replay(&binding, &directory, cancel, &guarded)?;
            guarded()?;
            let name = binding
                .file
                .replace("native-capture-pending-", "native-episode-pending-");
            action(&directory, &binding.proof, &name, &guarded)
        })
    }
}
