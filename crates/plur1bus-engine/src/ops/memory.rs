//! ACL-filtered list and show over required private and optional shared sources.
use super::context::{error, OperationContext};
use super::ledgers::Provenance;
use crate::{
    context::RequestContext,
    contract::{
        AgentContext, Cancel, EngineError, MemoryCard, MemoryListQuery, MemoryListResult,
        MemoryOpErrorCode, MemoryRow, Principal, StoreError,
    },
    embedding::{EmbedKind, EmbeddingProvider},
    recall::{acl, lifecycle::is_recall_entry_live},
    store::{shared_row::MemoryRecord, tombstone::TombstoneRegistry, Store},
};
use serde_json::{json, Value};
use std::{collections::HashSet, path::PathBuf, sync::Arc};

/// Stable physical-source preference, matching the Node access-pool merge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum SourceKind {
    /// The requesting agent's own namespace(s).
    Private,
    /// Proved workspace scope.
    Workspace,
    /// Proved user scope, shared only by that user's agents.
    User,
}
/// One already leased physical source. A source does not confer row-level access.
pub struct ReadSource {
    /// Store lease retained for the complete operation.
    pub store: Arc<Store>,
    /// Source preference for canonical-origin deduplication.
    pub kind: SourceKind,
    /// Optional shared-source failure is isolated; required private failure aborts.
    pub optional: bool,
}
/// Host composition supplies only pools reachable through the authenticated request.
pub trait ReadStores: Send + Sync {
    /// Lease sources in stable namespace order, after request validation.
    fn sources(&self, context: &RequestContext) -> Result<Vec<ReadSource>, StoreError>;
}
/// Foreground read implementation; no engine or RPC capability is advertised here.
pub struct MemoryReader {
    pub(super) context: Arc<OperationContext>,
    pub(super) stores: Arc<dyn ReadStores>,
    embedder: Arc<dyn EmbeddingProvider>,
    pub(super) base: PathBuf,
}
impl MemoryReader {
    /// Compose the host lifecycle, physical routes, provider and registry root.
    pub fn new(
        context: Arc<OperationContext>,
        stores: Arc<dyn ReadStores>,
        embedder: Arc<dyn EmbeddingProvider>,
        base: PathBuf,
    ) -> Self {
        Self {
            context,
            stores,
            embedder,
            base,
        }
    }
    /// List visible cards using the host clock.
    pub fn list(
        &self,
        query: &MemoryListQuery,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryListResult, EngineError> {
        self.list_at(query, principal, agent, self.context.host().now_ms())
    }
    /// List at one captured operation time, preserving Node's per-source acquisition bound.
    pub fn list_at(
        &self,
        query: &MemoryListQuery,
        principal: &Principal,
        agent: &AgentContext,
        now: i64,
    ) -> Result<MemoryListResult, EngineError> {
        let operation = self.context.enter(principal, agent)?;
        let ctx = &operation.context;
        let since = query.since.as_ref().and_then(serde_json::Number::as_f64);
        let until = query.until.as_ref().and_then(serde_json::Number::as_f64);
        if query.topic.is_some() == since.is_some()
            || query.topic.as_ref().is_some_and(|t| {
                crate::text::js::js_trim(t).is_empty() || t.encode_utf16().count() > 2000
            })
            || (query.topic.is_some() && until.is_some())
            || since.zip(until).is_some_and(|(s, u)| u < s)
        {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let limit = query
            .limit
            .as_ref()
            .and_then(serde_json::Number::as_f64)
            .unwrap_or(20.)
            .floor()
            .clamp(1., 100.) as usize;
        let vector = query
            .topic
            .as_ref()
            .map(|topic| {
                let mut vectors = self
                    .embedder
                    .embed(
                        std::slice::from_ref(topic),
                        EmbedKind::Query,
                        &Cancel::never(),
                    )
                    .map_err(|_| error(MemoryOpErrorCode::Storage))?;
                if vectors.len() != 1 {
                    return Err(error(MemoryOpErrorCode::Storage));
                }
                Ok(vectors.remove(0))
            })
            .transpose()?;
        let mut sources = self
            .stores
            .sources(ctx)
            .map_err(|_| error(MemoryOpErrorCode::Storage))?;
        sources.sort_by_key(|source| source.kind);
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        for source in sources {
            if !reachable(source.kind, ctx) {
                continue;
            }
            // F4: a hidden prefix must not make pagination claim exhaustion.
            // Increase acquisition until enough authorized candidates survive or
            // this source is exhausted. The ACL itself stays in visible().
            let mut acquisition = limit + 1;
            let rows = loop {
                let rows = source.store.memory_records(
                    vector.as_deref(),
                    since.map(|s| (s, until.unwrap_or(now as f64))),
                    acquisition,
                    now,
                );
                let rows = match rows {
                    Ok(rows) => rows,
                    Err(_) if source.optional => break Vec::new(),
                    Err(_) => return Err(error(MemoryOpErrorCode::Storage)),
                };
                let exhausted = rows.len() < acquisition;
                let mut visible = Vec::new();
                let mut origins = seen.clone();
                for (row, score) in rows {
                    if self.visible(&row, ctx, now)?
                        && row.origin().is_none_or(|origin| origins.insert(origin))
                    {
                        visible.push((row, score));
                    }
                }
                if exhausted || visible.len() > limit {
                    visible.truncate(limit + 1);
                    break visible;
                }
                acquisition = acquisition
                    .checked_mul(2)
                    .ok_or_else(|| error(MemoryOpErrorCode::Storage))?;
            };
            for (row, score) in rows {
                if let Some(key) = row.origin() {
                    if !seen.insert(key) {
                        continue;
                    }
                }
                candidates.push((row, score));
            }
        }
        candidates.sort_by(|(a, ascore), (b, bscore)| {
            if vector.is_some() {
                bscore
                    .unwrap_or(f64::NEG_INFINITY)
                    .total_cmp(&ascore.unwrap_or(f64::NEG_INFINITY))
            } else {
                b.row
                    .created_at
                    .as_f64()
                    .unwrap_or(0.)
                    .total_cmp(&a.row.created_at.as_f64().unwrap_or(0.))
            }
        });
        let truncated = candidates.len() > limit;
        let provenance = Provenance::load(&self.base, ctx.agent_id.as_str());
        let items = candidates
            .into_iter()
            .take(limit)
            .map(|(row, score)| record_card(&row, score, &provenance))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(MemoryListResult {
            agent_id: ctx.agent_id.clone(),
            items,
            truncated,
        })
    }
    /// Look up a visible card using the host clock.
    pub fn show(
        &self,
        id: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryCard, EngineError> {
        self.show_at(id, principal, agent, self.context.host().now_ms())
    }
    /// Look up at a captured operation time. Hidden, deleted and missing all return not-found.
    pub fn show_at(
        &self,
        id: &str,
        principal: &Principal,
        agent: &AgentContext,
        now: i64,
    ) -> Result<MemoryCard, EngineError> {
        let operation = self.context.enter(principal, agent)?;
        if !valid_id(id) {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let row = self.find_visible_record(id, &operation.context, now)?;
        record_card(
            &row,
            None,
            &Provenance::load(&self.base, operation.context.agent_id.as_str()),
        )
    }
    pub(super) fn find_visible(
        &self,
        id: &str,
        ctx: &RequestContext,
        now: i64,
    ) -> Result<MemoryRow, EngineError> {
        self.find_visible_record(id, ctx, now)
            .map(|record| record.row)
    }
    pub(super) fn find_visible_record(
        &self,
        id: &str,
        ctx: &RequestContext,
        now: i64,
    ) -> Result<MemoryRecord, EngineError> {
        let mut sources = self
            .stores
            .sources(ctx)
            .map_err(|_| error(MemoryOpErrorCode::Storage))?;
        sources.sort_by_key(|source| source.kind);
        for source in sources {
            if !reachable(source.kind, ctx) {
                continue;
            }
            match source.store.get_record(id) {
                Ok(Some(row)) if self.visible(&row, ctx, now)? => return Ok(row),
                Ok(_) => {}
                Err(_) if source.optional => {}
                Err(_) => return Err(error(MemoryOpErrorCode::Storage)),
            }
        }
        Err(error(MemoryOpErrorCode::NotFound))
    }
    /// Shared mutation lookup can require a definite absence instead of swallowing optional I/O.
    pub(super) fn find_shared_record(
        &self,
        id: &str,
        ctx: &RequestContext,
        now: i64,
        strict: bool,
    ) -> Result<Option<MemoryRecord>, EngineError> {
        let mut sources = self
            .stores
            .sources(ctx)
            .map_err(|_| error(MemoryOpErrorCode::Storage))?;
        sources.sort_by_key(|source| source.kind);
        for source in sources {
            if source.kind == SourceKind::Private || !reachable(source.kind, ctx) {
                continue;
            }
            match source.store.get_record(id) {
                Ok(Some(row)) if self.visible(&row, ctx, now)? => return Ok(Some(row)),
                Ok(_) => {}
                Err(_) if !strict => {}
                Err(_) => return Err(error(MemoryOpErrorCode::Storage)),
            }
        }
        Ok(None)
    }
    pub(super) fn visible(
        &self,
        record: &MemoryRecord,
        context: &RequestContext,
        now: i64,
    ) -> Result<bool, EngineError> {
        let row = &record.row;
        if !is_recall_entry_live(row, now, None) || acl::allowed(row, context).is_err() {
            return Ok(false);
        }
        let owner = if row.agent_id.is_empty() {
            &row.stored_by
        } else {
            &row.agent_id
        };
        let registry = TombstoneRegistry::new(&self.base, owner)
            .map_err(|_| error(MemoryOpErrorCode::Storage))?;
        if registry
            .find_by_origin(&row.id, false)
            .map_err(|_| error(MemoryOpErrorCode::Storage))?
            .is_some()
        {
            return Ok(false);
        }
        if let Some((source_agent, source_id)) = record
            .origin()
            .filter(|(agent, id)| agent != owner || id != &row.id)
        {
            let registry = TombstoneRegistry::new(&self.base, &source_agent)
                .map_err(|_| error(MemoryOpErrorCode::Storage))?;
            if registry
                .find_by_origin(&source_id, false)
                .map_err(|_| error(MemoryOpErrorCode::Storage))?
                .is_some()
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
}
pub(super) fn reachable(kind: SourceKind, ctx: &RequestContext) -> bool {
    match kind {
        SourceKind::Private => true,
        SourceKind::Workspace => !ctx.workspace_key.is_empty(),
        SourceKind::User => !ctx.owner_user_id.is_empty(),
    }
}
pub(super) fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn card(
    row: &MemoryRow,
    score: Option<f64>,
    provenance: &Provenance,
) -> Result<MemoryCard, EngineError> {
    let null_if_empty = |text: &str| {
        if text.is_empty() {
            Value::Null
        } else {
            json!(text)
        }
    };
    let mut value = json!({"id": row.id, "scope": row.scope, "text": row.text, "summary": if row.summary.is_empty() { &row.text } else { &row.summary }, "createdAt": row.created_at, "origin": null_if_empty(&row.origin), "epistemicStatus": null_if_empty(&row.epistemic_status)});
    if let Some(score) = score {
        value["score"] = json!(score);
    }
    provenance.apply(&mut value);
    serde_json::from_value(value).map_err(|_| error(MemoryOpErrorCode::Storage))
}

fn record_card(
    record: &MemoryRecord,
    score: Option<f64>,
    provenance: &Provenance,
) -> Result<MemoryCard, EngineError> {
    let mut card = card(&record.row, score, provenance)?;
    if record.row.scope != "agent-private" {
        if let Some(shared) = record
            .sharing
            .as_ref()
            .filter(|s| !s.source_agent_id.is_empty())
        {
            card.shared_by = Some(
                shared
                    .source_agent_id
                    .parse()
                    .map_err(|_| error(MemoryOpErrorCode::Storage))?,
            );
            card.source_id =
                (!shared.source_memory_id.is_empty()).then(|| shared.source_memory_id.clone());
        }
    }
    Ok(card)
}
