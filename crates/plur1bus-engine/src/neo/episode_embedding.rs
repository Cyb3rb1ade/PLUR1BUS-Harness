//! Shared writer composition for episode recovery followed by embedding publication.
use super::*;
use crate::contract::{AgentContext, Principal};
use crate::neo::embedding_publication::Session;
impl EpisodeStore {
    pub(in crate::neo) fn embedding_transaction<T>(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        expected: Option<&RequestContext>,
        cancel: &Cancel,
        action: impl FnOnce(Session<'_>) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        let ctx = RequestContext::build(principal, agent, self.host.as_ref())?;
        if expected.is_some_and(|expected| expected != &ctx) {
            return Err(StoreError::InvalidInput.into());
        }
        self.journal.with_writer(
            principal,
            agent,
            &ctx,
            cancel,
            &|| Ok(()),
            |dir, proof, name, check| {
                self.resume_episode(dir, proof, name, check, cancel)?;
                let now = Utc
                    .timestamp_millis_opt(self.host.now_ms())
                    .single()
                    .ok_or(StoreError::InvalidInput)?
                    .to_rfc3339_opts(SecondsFormat::Millis, true);
                action(Session {
                    dir,
                    proof,
                    name: name.replace("native-episode-pending-", "native-embedding-pending-"),
                    ctx: &ctx,
                    check,
                    journal: &self.journal,
                    now: &now,
                    caller: super::super::caller::encode(principal, agent)?,
                })
            },
        )
    }
}
