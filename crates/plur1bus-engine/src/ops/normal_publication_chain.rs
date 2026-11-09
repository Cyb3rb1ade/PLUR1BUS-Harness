//! Persist the ordinary branch's phase obligation before primary writes, then drive existing children.
use super::*;
/// Acknowledges ordinary primary, curation and knowledge staging only; not interference or a whole request.
#[derive(Debug)]
pub struct StorePublicationResult {
    /// Original operation/memory ID.
    pub memory_id: String,
    /// An existing primary intent was reused, including an explicitly upgraded primary-only intent.
    pub replayed: bool,
    /// Historical queue publication, never current membership or job execution.
    pub knowledge_staged: bool,
}
impl NativeMerge {
    /// Persist an admitted ordinary row and its requested curation/knowledge publication chain.
    /// The obligation survives gaps between child intents. It neither selects a candidate nor
    /// acknowledges merge/duplicate outcomes, interference, jobs or ProcessEngine activation.
    pub fn store_selected_with_publication(
        &self,
        plan: &NormalCandidatePlan,
        operation_id: Uuid,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<StorePublicationResult, EngineError> {
        let result = self.insert_selected(
            plan,
            operation_id,
            principal,
            agent,
            cancel,
            InsertMode {
                publication: true,
                ..InsertMode::default()
            },
        )?;
        let knowledge = self.finish_publication(operation_id, principal, agent, cancel)?;
        Ok(StorePublicationResult {
            memory_id: result.primary.memory_id,
            replayed: result.primary.replayed,
            knowledge_staged: knowledge.staged,
        })
    }
    pub(super) fn finish_publication(
        &self,
        operation_id: Uuid,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<StoreKnowledgeResult, EngineError> {
        // Each child owns and releases its own mutation/Neo lease. No nested writer acquisition.
        // The original receipt remains pending across the gaps and fences unrelated native writers.
        self.publish_store_curation(operation_id, principal, agent, cancel)?;
        self.publish_store_knowledge(operation_id, principal, agent, cancel)
    }
}
