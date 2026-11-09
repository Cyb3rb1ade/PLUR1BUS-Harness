//! A1 statistics retain per-agent counters while applying today's show visibility.
use super::{
    context::error,
    memory::{valid_id, MemoryReader},
};
use crate::{
    contract::{
        AgentContext, Cancel, EngineError, MemoryOpErrorCode, MemoryStatsResult, Principal,
    },
    store::recall_stats::RecallStats,
};
use serde_json::json;
impl MemoryReader {
    /// Return counters only for currently visible live cards, in requested order (or ID order).
    /// Explicit visible IDs with no history have zero counters; hidden IDs are always omitted.
    pub fn stats(
        &self,
        ids: Option<&[String]>,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryStatsResult, EngineError> {
        let operation = self.context.enter(principal, agent)?;
        if ids.is_some_and(|ids| ids.len() > 500 || ids.iter().any(|id| !valid_id(id))) {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let ctx = &operation.context;
        // A1 read can initialize/migrate its private database. Refuse that after close starts.
        self.context.assert_open()?;
        let stats = RecallStats::new(&self.base).map_err(|_| error(MemoryOpErrorCode::Storage))?;
        let rows = stats
            .read(ctx.agent_id.as_str(), ids, &Cancel::never())
            .map_err(|_| error(MemoryOpErrorCode::Storage))?;
        let now = self.context.host().now_ms();
        let mut items = Vec::new();
        for row in rows {
            match self.find_visible_record(&row.id, ctx, now) {
                Ok(_) => items.push(row),
                Err(EngineError::MemoryOp(e)) if e.code == MemoryOpErrorCode::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        serde_json::from_value(json!({"agentId":ctx.agent_id,"items":items}))
            .map_err(|_| error(MemoryOpErrorCode::Storage))
    }
}
