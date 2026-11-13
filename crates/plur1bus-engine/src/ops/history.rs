//! Version traversal stays on the selected physical source and rechecks every linked row.
use super::{
    context::error,
    memory::{reachable, valid_id, MemoryReader},
};
use crate::{
    context::RequestContext,
    contract::{AgentContext, Cancel, EngineError, MemoryOpErrorCode, MemoryRow, Principal},
    recall::acl,
    store::{shared_row::MemoryRecord, Store},
};
use serde::Serialize;
use std::collections::HashSet;

/// Pinned history projection; source content is emitted only after per-link authorization.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// Version UUID.
    pub id: String,
    /// Persisted version counter.
    pub version_number: f64,
    /// Version's text.
    pub text: String,
    /// Version's summary.
    pub summary: String,
    /// Update source.
    pub update_source: String,
    /// Stored evidence.
    pub update_evidence: String,
    /// Revision confidence.
    pub reconsolidation_confidence: f64,
    /// Historical lifecycle state, including superseded.
    pub status: String,
    /// Version timestamp.
    pub version_created_at: f64,
    /// Last update timestamp.
    pub updated_at: f64,
    /// Stored predecessor pointer.
    pub previous_version: String,
}
impl From<MemoryRow> for HistoryEntry {
    fn from(r: MemoryRow) -> Self {
        Self {
            id: r.id,
            version_number: r.version_number.as_f64().unwrap_or(1.),
            text: r.text,
            summary: r.summary,
            update_source: r.update_source,
            update_evidence: r.update_evidence,
            reconsolidation_confidence: r.reconsolidation_confidence.as_f64().unwrap_or(0.),
            status: if r.status.is_empty() {
                "active".into()
            } else {
                r.status
            },
            version_created_at: r.version_created_at.as_f64().unwrap_or(0.),
            updated_at: r.updated_at.as_f64().unwrap_or(0.),
            previous_version: r.previous_version,
        }
    }
}
impl MemoryReader {
    /// Walk backwards newest-to-oldest, stopping at missing/hidden rows, cycles or depth.
    /// `None` uses Node's default 50; this native API does not change MemoryOps/RPC.
    pub fn history(
        &self,
        id: &str,
        max_depth: Option<usize>,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<Vec<HistoryEntry>, EngineError> {
        Ok(self
            .version_chain(id, max_depth, principal, agent, cancel, false)?
            .into_iter()
            .map(HistoryEntry::from)
            .collect())
    }
    /// Follow successors and return the last reachable authorized row. Like Node,
    /// a broken/cyclic/depth-limited chain may end on a superseded row, not an active one.
    pub fn current_version(
        &self,
        id: &str,
        max_depth: Option<usize>,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<Option<MemoryRow>, EngineError> {
        Ok(self
            .version_chain(id, max_depth, principal, agent, cancel, true)?
            .pop())
    }
    fn version_chain(
        &self,
        id: &str,
        max_depth: Option<usize>,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
        forward: bool,
    ) -> Result<Vec<MemoryRow>, EngineError> {
        cancel.check()?;
        let operation = self.context.enter(principal, agent)?;
        let ctx = &operation.context;
        if !valid_id(id) {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let max_depth = max_depth.unwrap_or(50);
        if max_depth == 0 {
            return Ok(Vec::new());
        }
        let mut sources = self
            .stores
            .sources(ctx)
            .map_err(|_| error(MemoryOpErrorCode::Storage))?;
        sources.sort_by_key(|source| source.kind);
        for source in sources {
            cancel.check()?;
            if !reachable(source.kind, ctx) {
                continue;
            }
            let first = match self.history_row(&source.store, id, ctx) {
                Ok(row) => row,
                Err(_) if source.optional => continue,
                Err(error) => return Err(error),
            };
            let Some(mut row) = first else {
                continue;
            };
            let mut seen = HashSet::new();
            let mut result = Vec::new();
            loop {
                cancel.check()?;
                if !seen.insert(row.id.clone()) {
                    break;
                }
                let next = if forward {
                    row.superseded_by.clone()
                } else {
                    row.previous_version.clone()
                };
                result.push(row);
                if result.len() >= max_depth || next.is_empty() || seen.contains(&next) {
                    break;
                }
                if !valid_id(&next) {
                    break;
                }
                let Some(next_row) = self.history_row(&source.store, &next, ctx)? else {
                    break;
                };
                row = next_row;
            }
            cancel.check()?;
            return Ok(result);
        }
        Ok(Vec::new())
    }
    fn history_row(
        &self,
        store: &Store,
        id: &str,
        ctx: &RequestContext,
    ) -> Result<Option<MemoryRow>, EngineError> {
        let Some(record) = store
            .get_record(id)
            .map_err(|_| error(MemoryOpErrorCode::Storage))?
        else {
            return Ok(None);
        };
        if record.row.status == "deleted"
            || !self.source_visible(&record, ctx)?
            || !explicit_bindings(&record, ctx)
        {
            return Ok(None);
        }
        Ok(Some(record.row))
    }
}
fn explicit_bindings(record: &MemoryRecord, ctx: &RequestContext) -> bool {
    let Some(mut memory) = acl::AclMemory::from_row(&record.row) else {
        return false;
    };
    let subject = acl::AclSubject::from_context(ctx);
    if memory.dream_narrative {
        return acl::check_access(Some(&subject), Some(&memory)).is_ok();
    }
    for (present, scope) in [
        (
            !memory.workspace_id.is_empty() || !memory.workspace_key.is_empty(),
            "workspace",
        ),
        (!memory.owner_user_id.is_empty(), "user"),
    ] {
        if present {
            memory.scope = scope.into();
            if acl::check_access(Some(&subject), Some(&memory)).is_err() {
                return false;
            }
        }
    }
    true
}
