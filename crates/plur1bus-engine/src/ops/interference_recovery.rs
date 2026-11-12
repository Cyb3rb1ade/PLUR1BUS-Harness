//! Bounded component startup preflights all saved original callers before applying any plan.
use super::*;
impl NativeInterference {
    /// Open only after all bounded pending receipts pass current original-caller preflight.
    pub fn open(
        reader: Arc<MemoryReader>,
        journal: Arc<CaptureJournal>,
    ) -> Result<Self, EngineError> {
        let adapter = Self::new(reader, journal);
        adapter.recover_pending(&Cancel::never())?;
        Ok(adapter)
    }
    /// Recover saved original requests without a host resubmission or newly invented authority.
    pub fn recover_pending(&self, cancel: &Cancel) -> Result<usize, EngineError> {
        let cancel =
            cancel.limited_to(std::time::Instant::now() + std::time::Duration::from_secs(300));
        let requests = self.journal.interference_requests(&cancel)?;
        for (request, principal, agent) in &requests {
            self.settle(request, principal, agent, &cancel, Mode::ValidateExisting)?;
        }
        for (request, principal, agent) in &requests {
            self.settle(request, principal, agent, &cancel, Mode::ApplyExisting)?;
        }
        Ok(requests.len())
    }
}
