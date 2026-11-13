//! RE-D31/F4: all state counts are reads under the same ACL as list/show.
use super::{
    context::error,
    memory::{reachable, MemoryReader, SourceKind},
};
use crate::{
    context::RequestContext,
    contract::{AgentContext, EngineError, MemoryOpErrorCode, MemoryState, Principal},
    recall::acl::{self, AclMemory, AclSubject},
    store::tombstone::TombstoneRegistry,
    text::json::TolerantJsonValue as Json,
};
use serde_json::json;
use std::collections::HashSet;

impl MemoryReader {
    /// Count only caller-visible live cards and authorized committed tombstones.
    pub fn state(
        &self,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryState, EngineError> {
        self.state_at(principal, agent, self.context.host().now_ms())
    }

    /// Read-only snapshot at one host time; an unreadable count is null, never zero.
    pub fn state_at(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        now: i64,
    ) -> Result<MemoryState, EngineError> {
        let operation = self.context.enter(principal, agent)?;
        let ctx = &operation.context;
        let mut counts = [None, None, None];
        if let Ok(mut sources) = self.stores.sources(ctx) {
            sources.sort_by_key(|source| source.kind);
            counts[0] = Some(0_usize);
            let mut failed = [false; 3];
            let mut seen = HashSet::new();
            for source in sources {
                if !reachable(source.kind, ctx) {
                    continue;
                }
                let index = match source.kind {
                    SourceKind::Private => 0,
                    SourceKind::Workspace => 1,
                    SourceKind::User => 2,
                };
                if failed[index] {
                    continue;
                }
                counts[index].get_or_insert(0);
                // Use the same lifecycle acquisition and exact same final predicate as
                // list. State has no result cap and no createdAt-window restriction.
                let rows = source.store.memory_records(
                    None,
                    Some((-9_007_199_254_740_991., 9_007_199_254_740_991.)),
                    usize::MAX,
                    now,
                );
                let visible = rows
                    .map_err(|_| error(MemoryOpErrorCode::Storage))
                    .and_then(|rows| {
                        rows.into_iter()
                            .filter_map(|(row, _)| match self.visible(&row, ctx, now) {
                                Ok(true) => Some(Ok(row)),
                                Ok(false) => None,
                                Err(e) => Some(Err(e)),
                            })
                            .collect::<Result<Vec<_>, _>>()
                    });
                match visible {
                    Ok(rows) => {
                        for row in rows {
                            if row.origin().is_none_or(|key| seen.insert(key)) {
                                if let Some(count) = &mut counts[index] {
                                    *count += 1;
                                }
                            }
                        }
                    }
                    Err(_) => {
                        counts[index] = None;
                        failed[index] = true;
                    }
                }
            }
        }
        let tombstones = self.visible_tombstones(ctx);
        let archive = self.context.host().state_dir().join("memory/_archive");
        let archive = archive
            .to_str()
            .ok_or_else(|| error(MemoryOpErrorCode::Storage))?;
        serde_json::from_value(json!({"agentId":ctx.agent_id,
            "cards":{"agentPrivate":counts[0],"workspace":counts[1],"user":counts[2]},
            "tombstones":tombstones,"archiveDir":archive}))
        .map_err(|_| error(MemoryOpErrorCode::Storage))
    }

    fn visible_tombstones(&self, ctx: &RequestContext) -> Option<usize> {
        let registry = TombstoneRegistry::new(&self.base, ctx.agent_id.as_str()).ok()?;
        let read = registry.read(false).ok()?;
        if read.corrupt_lines != 0 {
            return None;
        }
        let subject = AclSubject::from_context(ctx);
        Some(
            read.tombstones
                .iter()
                .filter(|row| {
                    if text(row, "status") != "committed" {
                        return false;
                    }
                    let memory = AclMemory {
                        id: text(row, "memoryId"),
                        scope: text(row, "scope"),
                        agent_id: text(row, "agentId"),
                        stored_by: text(row, "storedBy"),
                        workspace_id: text(row, "workspaceId"),
                        workspace_key: text(row, "workspaceKey"),
                        owner_user_id: text(row, "ownerUserId"),
                        type_name: String::new(),
                        dream_narrative: text(row, "origin") == "dream"
                            && text(row, "memoryClass") == "dream",
                    };
                    acl::check_access(Some(&subject), Some(&memory)).is_ok()
                })
                .count(),
        )
    }
}

// Read only schema-owned fields; an opaque field with lone UTF-16 units must
// neither invalidate the whole row nor be converted into replacement text.
fn text(row: &Json, key: &str) -> String {
    if let Json::Object(fields) = row {
        if let Some((_, Json::String(value))) = fields
            .iter()
            .rev()
            .find(|(k, _)| k.as_utf16_units().iter().copied().eq(key.encode_utf16()))
        {
            return String::from_utf16(value.as_utf16_units()).unwrap_or_default();
        }
    }
    String::new()
}
