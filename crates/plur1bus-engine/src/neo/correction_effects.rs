//! Original-caller-bound, durable optional Neo effects after a real Lance revision.
//! The caller owns the engine generation/mutation gate. These appends do not make the
//! preceding Lance commit and optional Neo effects a single atomic transaction.
use super::{
    capture_journal::CaptureJournal,
    derived_fields::{set, text, validate_object},
    journal_io,
    merged::{MetadataReader, RecordKind},
    merged_order::field,
};
use crate::{
    context::{is_user_principal, RequestContext},
    contract::{AgentContext, Cancel, EngineError, HostServices, MemoryRow, Principal, StoreError},
    ops::{correction::CorrectionEffects, write::MutationStores},
    store::{directory::TrustedDirectory, tombstone::TombstoneRegistry, Store},
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::PathBuf, sync::Arc};

const EVENTS: &str = "reconsolidation-events.jsonl";
const GRAPH: &str = "memory-graph.jsonl";

/// Original operation identity and cancellation, never reconstructed from a later caller.
pub struct EffectAuthority {
    /// Original authenticated caller.
    pub principal: Principal,
    /// Original foreground/background execution context.
    pub agent: AgentContext,
    /// Original operation lifetime; the Neo lease also applies its fixed acquisition budget.
    pub cancel: Cancel,
    /// Trusted registry root shared with the actual MemoryWriter.
    pub base_db: PathBuf,
}

/// Actual CorrectionEffects implementation for one caller and physical workspace.
pub struct NativeCorrectionEffects {
    journal: Arc<CaptureJournal>,
    host: Arc<dyn HostServices>,
    stores: Arc<dyn MutationStores>,
    authority: EffectAuthority,
    context: RequestContext,
    workspace: TrustedDirectory,
    base: TrustedDirectory,
}
impl NativeCorrectionEffects {
    /// Bind existing physical roots without creating files, tables, providers or new identity.
    pub fn open(
        journal: Arc<CaptureJournal>,
        host: Arc<dyn HostServices>,
        stores: Arc<dyn MutationStores>,
        authority: EffectAuthority,
    ) -> Result<Self, EngineError> {
        authority.cancel.check()?;
        let path = host
            .workspace_dir(&authority.principal.agent_id)?
            .ok_or(StoreError::InvalidInput)?;
        let context = RequestContext::build(&authority.principal, &authority.agent, host.as_ref())?;
        if !is_user_principal(&context.owner_user_id)
            || context.workspace_key.is_empty()
            || host.workspace_dir(&authority.principal.agent_id)?.as_ref() != Some(&path)
        {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(Self {
            journal,
            host,
            stores,
            workspace: TrustedDirectory::open(&path)?,
            base: TrustedDirectory::open(&authority.base_db)?,
            authority,
            context,
        })
    }

    fn check(&self, expected: &RequestContext) -> Result<(), EngineError> {
        self.authority.cancel.check()?;
        self.workspace.assert_unchanged()?;
        self.base.assert_unchanged()?;
        if expected != &self.context
            || RequestContext::build(
                &self.authority.principal,
                &self.authority.agent,
                self.host.as_ref(),
            )? != self.context
            || self
                .host
                .workspace_dir(&self.authority.principal.agent_id)?
                .as_deref()
                != Some(self.workspace.path())
        {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(())
    }

    fn transaction<T>(
        &self,
        ctx: &RequestContext,
        action: impl FnOnce(
            &TrustedDirectory,
            &dyn Fn() -> Result<(), EngineError>,
        ) -> Result<T, EngineError>,
    ) -> Result<T, StoreError> {
        self.check(ctx).map_err(storage)?;
        self.journal
            .with_writer(
                &self.authority.principal,
                &self.authority.agent,
                ctx,
                &self.authority.cancel,
                &|| self.check(ctx),
                |dir, _, _, check| action(dir, check),
            )
            .map_err(storage)
    }

    fn store(&self, ctx: &RequestContext) -> Result<Arc<Store>, EngineError> {
        self.stores
            .existing_private(ctx)?
            .ok_or_else(|| StoreError::Unavailable.into())
    }

    fn row(&self, store: &Store, id: &str, ctx: &RequestContext) -> Result<MemoryRow, EngineError> {
        let row = store.get(id)?.ok_or(StoreError::InvalidInput)?;
        if !private(&row, ctx)
            || TombstoneRegistry::new(self.base.path(), ctx.agent_id.as_str())?
                .find_by_origin(id, false)?
                .is_some()
        {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(row)
    }

    fn linkage(
        &self,
        ctx: &RequestContext,
        old: &MemoryRow,
        new: &str,
    ) -> Result<Arc<Store>, EngineError> {
        if !private(old, ctx) {
            return Err(StoreError::InvalidInput.into());
        }
        let store = self.store(ctx)?;
        let source = self.row(&store, &old.id, ctx)?;
        let target = self.row(&store, new, ctx)?;
        if source.text != old.text
            || source.summary != old.summary
            || source.vector != old.vector
            || target.status != "active"
            || (new != old.id
                && (source.status != "superseded"
                    || source.superseded_by != new
                    || target.previous_version != old.id))
            || (new == old.id && source.status != "active")
        {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(store)
    }
}
impl CorrectionEffects for NativeCorrectionEffects {
    fn contains(&self, ctx: &RequestContext, key: &str) -> Result<bool, StoreError> {
        if key.is_empty() || key.len() > 256 {
            return Err(StoreError::InvalidInput);
        }
        self.transaction(ctx, |dir, check| {
            let rows = read(dir, EVENTS, &self.authority.cancel)?;
            check()?;
            Ok(rows
                .iter()
                .rev()
                .filter(|row| owned(row, ctx))
                .take(1000)
                .any(|row| field(row, "idempotencyKey") == Some(&text(key))))
        })
    }

    fn rewrite_edges(
        &self,
        ctx: &RequestContext,
        old: &MemoryRow,
        new: &str,
    ) -> Result<(), StoreError> {
        self.transaction(ctx, |dir, check| {
            let store = self.linkage(ctx, old, new)?;
            let mut existing = read(dir, GRAPH, &self.authority.cancel)?;
            let mut seen: HashSet<[u8; 32]> = existing.iter().map(fingerprint).collect();
            // Use the established latest-revision/ACL-before-tail reader, including its safe
            // read-only legacy overlay. Writes always stay in the canonical directory.
            let root = dir
                .path()
                .parent()
                .and_then(|path| path.parent())
                .ok_or(StoreError::InvalidInput)?;
            let reader = MetadataReader::open(root, &ctx.workspace_key)?;
            let edges = reader.read_metadata(RecordKind::Graph, 10_000, ctx)?;
            for edge in edges {
                check()?;
                if !owned(&edge, ctx) {
                    continue;
                }
                let source = string(&edge, "source")?;
                let target = string(&edge, "target")?;
                if source != old.id && target != old.id {
                    continue;
                }
                // A visible edge never grants access to its peer. Missing/foreign/deleted
                // peers make this edge ineligible without touching it.
                let peer = if source == old.id { &target } else { &source };
                if peer != &old.id {
                    match self.row(&store, peer, ctx) {
                        Ok(row) if row.status == "active" => (),
                        Ok(_) | Err(EngineError::Store(StoreError::InvalidInput)) => continue,
                        Err(error) => return Err(error),
                    }
                }
                let mut rewritten = edge;
                if source == old.id {
                    set(&mut rewritten, "source", text(new))?;
                }
                if target == old.id {
                    set(&mut rewritten, "target", text(new))?;
                }
                let fingerprint = fingerprint(&rewritten);
                if seen.contains(&fingerprint) {
                    continue;
                }
                check()?;
                self.linkage(ctx, old, new)?;
                if peer != &old.id && self.row(&store, peer, ctx)?.status != "active" {
                    return Err(StoreError::InvalidInput.into());
                }
                append(dir, GRAPH, &rewritten, &existing, &self.authority.cancel)?;
                seen.insert(fingerprint);
                existing.push(rewritten);
            }
            check()
        })
    }

    fn record(
        &self,
        ctx: &RequestContext,
        old: &MemoryRow,
        event: &Value,
    ) -> Result<(), StoreError> {
        self.transaction(ctx, |dir, check| {
            let mut event = parse_json(&event.to_string()).map_err(|_| StoreError::InvalidInput)?;
            validate_object(&event)?;
            let key = string(&event, "idempotencyKey")?;
            let id = string(&event, "id")?;
            let new = string(&event, "newMemoryId")?;
            let action = string(&event, "action")?;
            if key.is_empty()
                || key.len() > 256
                || uuid::Uuid::parse_str(&id).is_err()
                || string(&event, "oldMemoryId")? != old.id
                || !matches!(action.as_str(), "version" | "metadata_update")
                || (action == "metadata_update") != (new == old.id)
            {
                return Err(StoreError::InvalidInput.into());
            }
            self.linkage(ctx, old, &new)?;
            for (name, value) in [
                ("scope", "agent_private"),
                ("agentId", ctx.agent_id.as_str()),
                ("ownerUserId", &ctx.owner_user_id),
                ("workspaceKey", &ctx.workspace_key),
            ] {
                if field(&event, name).is_some_and(|old| old != &text(value)) {
                    return Err(StoreError::InvalidInput.into());
                }
                set(&mut event, name, text(value))?;
            }
            if !owned(&event, ctx) {
                return Err(StoreError::InvalidInput.into());
            }
            let existing = read(dir, EVENTS, &self.authority.cancel)?;
            for prior in existing
                .iter()
                .rev()
                .filter(|row| owned(row, ctx))
                .take(1000)
            {
                if field(prior, "idempotencyKey") == Some(&text(&key)) {
                    if field(prior, "oldMemoryId") != field(&event, "oldMemoryId")
                        || field(prior, "newMemoryId") != field(&event, "newMemoryId")
                    {
                        return Err(StoreError::InvalidInput.into());
                    }
                    return check();
                }
            }
            check()?;
            self.linkage(ctx, old, &new)?;
            append(dir, EVENTS, &event, &existing, &self.authority.cancel)?;
            check()
        })
    }
}
fn string(value: &Json, name: &str) -> Result<String, StoreError> {
    match field(value, name) {
        Some(Json::String(s)) => char::decode_utf16(s.as_utf16_units().iter().copied())
            .collect::<Result<String, _>>()
            .map_err(|_| StoreError::InvalidInput),
        _ => Err(StoreError::InvalidInput),
    }
}
fn owned(row: &Json, ctx: &RequestContext) -> bool {
    journal_io::owned(row, ctx) && field(row, "scope") == Some(&text("agent_private"))
}
fn private(row: &MemoryRow, ctx: &RequestContext) -> bool {
    row.scope == "agent-private"
        && row.agent_id == ctx.agent_id.as_str()
        && row.stored_by == ctx.agent_id.as_str()
        && row.owner_user_id == ctx.owner_user_id
        && row.workspace_key == ctx.workspace_key
        && (row.workspace_id.is_empty() || row.workspace_id == ctx.workspace_key)
        && !matches!(row.status.as_str(), "deleted" | "pruned" | "tombstoned")
}
fn read(dir: &TrustedDirectory, name: &str, cancel: &Cancel) -> Result<Vec<Json>, EngineError> {
    if journal_io::bytes(dir, name, cancel)?
        .is_some_and(|bytes| !bytes.is_empty() && !bytes.ends_with(b"\n"))
    {
        return Err(StoreError::Corrupt.into());
    }
    journal_io::rows(dir, name, cancel)
}
fn append(
    dir: &TrustedDirectory,
    name: &str,
    row: &Json,
    existing: &[Json],
    cancel: &Cancel,
) -> Result<(), EngineError> {
    cancel.check()?;
    let bytes = match super::merged::optional(dir.open_file(name))? {
        Some(file) => usize::try_from(super::vectors::ordinary(&file)?.len())
            .map_err(|_| StoreError::Corrupt)?,
        None => 0,
    };
    let line = write_json(row);
    if existing.len() >= journal_io::MAX_ROWS
        || line.len() > 1024 * 1024
        || bytes
            .checked_add(line.len() + 1)
            .is_none_or(|sum| sum > journal_io::MAX_BYTES)
    {
        return Err(StoreError::InvalidInput.into());
    }
    dir.append_jsonl_durable(name, row, 1024 * 1024)?;
    Ok(())
}
fn storage(error: EngineError) -> StoreError {
    match error {
        EngineError::Store(error) => error,
        _ => StoreError::Unavailable,
    }
}

fn fingerprint(row: &Json) -> [u8; 32] {
    Sha256::digest(write_json(row).as_bytes()).into()
}
