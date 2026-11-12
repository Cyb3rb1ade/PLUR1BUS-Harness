//! Original-caller reader construction from the same physical Neo root as the human writer.
use super::*;
use crate::neo::merged::MetadataReader;
impl CaptureJournal {
    pub(crate) fn curation_reader(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        expected: &RequestContext,
        cancel: &Cancel,
    ) -> Result<MetadataReader, EngineError> {
        cancel.check()?;
        let binding = self.bind(principal, agent)?;
        if binding.ctx != *expected {
            return Err(StoreError::InvalidInput.into());
        }
        let _ = crate::neo::curation::queue(&[], &[], expected, cancel)?;
        let reader = MetadataReader::open(self.root.path(), &expected.workspace_key)?;
        if reader.root.identity_parts() != self.root.identity_parts() {
            return Err(StoreError::UntrustedPath.into());
        }
        self.check(&binding, principal, agent, cancel)?;
        Ok(reader)
    }
}
