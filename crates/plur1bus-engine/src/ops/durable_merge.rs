//! Actual private normal-store merge. The prepared replacement is a native input, never a wire grant.
//! Model decisions, candidate selection and normal-store row construction compose above this writer.
use super::{
    conflict_file as io, durable_merge_state as state,
    interference_state::{hash, Record},
    memory::{MemoryReader, SourceKind},
};
use crate::{
    capture::durable_merge as protocol,
    context::{is_user_principal, RequestContext},
    contract::{AgentContext, Cancel, EngineError, MemoryRow, Principal, StoreError},
    embedding::{identity::try_identity_id, VectorSpaceIdentity},
    neo::capture_journal::CaptureJournal,
    store::{directory::TrustedDirectory, shared_row::MemoryRecord, Store},
    text::{
        js::JsString,
        json::{parse_json, write_json},
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
#[cfg(feature = "testkit")]
type Observer = Arc<dyn Fn(&str) -> Result<(), EngineError> + Send + Sync>;
/// Immutable prepared input; retry exactly, including original time and source snapshot.
#[derive(Clone)]
pub struct MergeRequest {
    /// Exact selected authoritative source, including sharing metadata.
    pub source: MemoryRecord,
    /// Prepared replacement, checked for identity, lineage, ownership and epistemic provenance.
    pub replacement: MemoryRow,
    /// Effective frozen normal-store key; an empty value falls back to the source text.
    pub write_key: String,
    /// Original preparation timestamp, not a recovery clock.
    pub now_ms: i64,
    /// Actual provider and store vector-space identity.
    pub identity: VectorSpaceIdentity,
}
/// Acknowledged only after the original archive, replacement, deletion and audit are durable.
#[derive(Debug)]
pub struct MergeResult {
    /// Exact replacement UUID.
    pub replacement_id: String,
    /// Verified original full-row archive.
    pub archive_path: PathBuf,
    /// Existing durable operation was replayed.
    pub replayed: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    version: u8,
    command: String,
    principal: Value,
    agent: Value,
    source: Record,
    replacement: MemoryRow,
    write_key: String,
    now_ms: i64,
    identity: VectorSpaceIdentity,
    store_binding: (PathBuf, (u64, u64)),
    state_binding: (PathBuf, (u64, u64)),
}
impl Saved {
    fn request(&self) -> MergeRequest {
        MergeRequest {
            source: self.source.record(),
            replacement: self.replacement.clone(),
            write_key: self.write_key.clone(),
            now_ms: self.now_ms,
            identity: self.identity.clone(),
        }
    }
}
/// Shares lifecycle, original-caller policy and Neo writer leases with all other native adapters.
pub struct NativeMerge {
    reader: Arc<MemoryReader>,
    journal: Arc<CaptureJournal>,
    #[cfg(feature = "testkit")]
    observer: Option<Observer>,
}
impl NativeMerge {
    /// Bind existing services without changing stores or configuration.
    pub fn new(reader: Arc<MemoryReader>, journal: Arc<CaptureJournal>) -> Self {
        Self {
            reader,
            journal,
            #[cfg(feature = "testkit")]
            observer: None,
        }
    }
    /// Deterministic durable-boundary fault seam, absent in production.
    #[cfg(feature = "testkit")]
    pub fn with_observer(mut self, observer: Observer) -> Self {
        self.observer = Some(observer);
        self
    }
    fn observe(&self, stage: &str) -> Result<(), EngineError> {
        #[cfg(feature = "testkit")]
        if let Some(f) = &self.observer {
            return f(stage);
        }
        let _ = stage;
        Ok(())
    }
    fn private(&self, row: &MemoryRecord, ctx: &RequestContext) -> Result<(), EngineError> {
        let r = &row.row;
        if row.sharing.is_some()
            || r.status != "active"
            || r.scope != "agent-private"
            || r.agent_id != ctx.agent_id.as_str()
            || r.stored_by != ctx.agent_id.as_str()
            || r.owner_user_id != ctx.owner_user_id
            || r.workspace_key != ctx.workspace_key
            || !self
                .reader
                .visible(row, ctx, self.reader.context.host().now_ms())?
        {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(())
    }
    fn selected_store(
        &self,
        ctx: &RequestContext,
        identity: &VectorSpaceIdentity,
    ) -> Result<Arc<Store>, EngineError> {
        let expected = try_identity_id(identity)?;
        if try_identity_id(self.reader.embedding_identity())? != expected {
            return Err(StoreError::InvalidInput.into());
        }
        let mut selected = None;
        for source in self.reader.stores.sources(ctx)? {
            if source.kind != SourceKind::Private {
                continue;
            }
            if try_identity_id(source.store.identity().ok_or(StoreError::InvalidInput)?)?
                != expected
                || selected
                    .as_ref()
                    .is_some_and(|s| !Arc::ptr_eq(s, &source.store))
            {
                return Err(StoreError::InvalidInput.into());
            }
            selected = Some(source.store);
        }
        selected.ok_or_else(|| StoreError::InvalidInput.into())
    }
    /// Commit only the exact prepared plan. Errors can follow partial writes; retain the input for retry.
    pub fn apply(
        &self,
        request: &MergeRequest,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<MergeResult, EngineError> {
        self.settle(request, principal, agent, cancel, false, false)
    }
    fn settle(
        &self,
        request: &MergeRequest,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
        existing_only: bool,
        validate_only: bool,
    ) -> Result<MergeResult, EngineError> {
        cancel.check()?;
        validate_request(request, cancel)?;
        let op = self.reader.context.enter(principal, agent)?;
        let ctx = &op.context;
        if !is_user_principal(&ctx.owner_user_id) {
            return Err(StoreError::InvalidInput.into());
        }
        let workspace = TrustedDirectory::open(&self.reader.context.destructive_workspace(ctx)?)?;
        let base = TrustedDirectory::open(&self.reader.base)?;
        let _gate = self.reader.context.mutation()?;
        let extra = || {
            cancel.check()?;
            self.reader.context.assert_open()?;
            workspace.assert_unchanged()?;
            base.assert_unchanged()?;
            if RequestContext::build(principal, agent, self.reader.context.host())? != *ctx
                || self
                    .reader
                    .context
                    .host()
                    .workspace_dir(&ctx.agent_id)?
                    .as_deref()
                    != Some(workspace.path())
            {
                return Err(StoreError::InvalidInput.into());
            }
            Ok(())
        };
        self.journal.with_merge_writer(
            principal,
            agent,
            ctx,
            cancel,
            &extra,
            |dir, proof, binding, check| {
                CaptureJournal::guard_non_merge_pending(dir, cancel)?;
                super::conflict_application_state::guard_pending(dir, cancel)?;
                self.private(&request.source, ctx)?;
                let replacement = Record {
                    row: crate::store::row::persisted_projection(&request.replacement)?,
                    sharing: None,
                };
                self.private(&replacement.record(), ctx)?;
                let store = self.selected_store(ctx, &request.identity)?;
                let key = effective_key(request);
                let identity = protocol::identity(
                    ctx.agent_id.as_str(),
                    &request.source.row.id,
                    &JsString::from(key),
                    cancel,
                )?;
                let name = format!(
                    "native-durable-merge-{}.json",
                    hash(format!("{binding}:{}", identity.idempotency_key).as_bytes())
                );
                let mut inventory = state::receipts(dir, cancel)?;
                if inventory
                    .iter()
                    .any(|(file, r, _)| file != &name && r.stage != 6)
                {
                    return Err(StoreError::Busy.into());
                }
                let old = inventory
                    .iter()
                    .position(|(n, _, _)| n == &name)
                    .map(|i| inventory.remove(i));
                let replayed = old.is_some();
                if existing_only && !replayed {
                    return Err(StoreError::Corrupt.into());
                }
                // A receipt-free call must still have its exact original; never infer authorization from a successor.
                if !replayed && !request.source_matches(&store)? {
                    return Err(StoreError::InvalidInput.into());
                }
                let state_path = self.reader.context.host().state_dir();
                if !replayed {
                    crate::store::paths::secure_dir(state_path)?;
                }
                let home = TrustedDirectory::open(state_path)?;
                let saved = Saved {
                    version: 1,
                    command: "memory-store-merge".into(),
                    principal: serde_json::to_value(principal).map_err(|_| StoreError::Corrupt)?,
                    agent: serde_json::to_value(agent).map_err(|_| StoreError::Corrupt)?,
                    source: request.source.clone().into(),
                    replacement: replacement.row.clone(),
                    write_key: request.write_key.clone(),
                    now_ms: request.now_ms,
                    identity: request.identity.clone(),
                    store_binding: store.physical_binding()?,
                    state_binding: (home.path().to_owned(), home.identity_parts()),
                };
                let plan = serde_json::to_value(&saved).map_err(|_| StoreError::Corrupt)?;
                let fingerprint = format!(
                    "sha256:{}",
                    hash(&serde_json::to_vec(&plan).map_err(|_| StoreError::Corrupt)?)
                );
                let proof =
                    serde_json::from_str(&write_json(proof)).map_err(|_| StoreError::Corrupt)?;
                let (mut receipt, mut bytes) = match old {
                    Some((_, r, b)) => {
                        if r.plan != plan || r.fingerprint != fingerprint || r.proof != proof {
                            return Err(StoreError::InvalidInput.into());
                        }
                        (r, Some(b))
                    }
                    None => (
                        state::Receipt {
                            version: 1,
                            plan,
                            fingerprint,
                            proof,
                            stage: 0,
                        },
                        None,
                    ),
                };
                let original: Record = request.source.clone().into();
                let files = Files::open(
                    &home,
                    &workspace,
                    ctx.agent_id.as_str(),
                    request,
                    !replayed,
                    cancel,
                )?;
                let preflight = |stage: u8| -> Result<(), EngineError> {
                    check()?;
                    home.assert_unchanged()?;
                    files.check()?;
                    self.private(&original.record(), ctx)?;
                    self.private(&replacement.record(), ctx)?;
                    let routed = self.selected_store(ctx, &request.identity)?;
                    if routed.physical_binding()? != saved.store_binding {
                        return Err(StoreError::InvalidInput.into());
                    }
                    check_rows(&store, &original, &replacement, stage)?;
                    files.validate(&original.row, stage, cancel)?;
                    check()
                };
                preflight(receipt.stage)?;
                let result = || MergeResult {
                    replacement_id: replacement.row.id.clone(),
                    archive_path: files.archive_path(),
                    replayed,
                };
                if validate_only {
                    return Ok(result());
                }
                if bytes.is_none() {
                    bytes = Some(state::save(dir, &name, None, &receipt, cancel, &|| {
                        preflight(0)
                    })?);
                }
                self.observe("prepared")?;
                let mut advance = |stage: u8| -> Result<(), EngineError> {
                    if receipt.stage < stage {
                        preflight(receipt.stage)?;
                        receipt.stage = stage;
                        bytes = Some(state::save(
                            dir,
                            &name,
                            bytes.as_deref(),
                            &receipt,
                            cancel,
                            &|| preflight(stage),
                        )?);
                    }
                    Ok(())
                };
                files.archive(&original.row, cancel, &|| preflight(0))?;
                self.observe("archive-write")?;
                advance(1)?;
                self.observe("archived")?;
                if store.get_record(&replacement.row.id)?.is_none() {
                    preflight(1)?;
                    store.upsert(std::slice::from_ref(&replacement.row))?;
                }
                self.observe("replacement-write")?;
                advance(2)?;
                self.observe("replaced")?;
                advance(3)?;
                self.observe("delete-intent")?;
                if store.get_record(&original.row.id)?.is_some() {
                    preflight(3)?;
                    store.delete(&[original.row.id.as_str()])?;
                }
                self.observe("delete")?;
                advance(4)?;
                self.observe("deleted")?;
                files.audit(cancel, &|| preflight(4))?;
                self.observe("audit-write")?;
                advance(5)?;
                self.observe("audited")?;
                advance(6)?;
                self.observe("complete")?;
                preflight(6)?;
                Ok(result())
            },
        )
    }
}
impl MergeRequest {
    fn source_matches(&self, store: &Store) -> Result<bool, EngineError> {
        match store.get_record(&self.source.row.id)? {
            Some(actual) => Record::from(self.source.clone()).same(&actual),
            None => Ok(false),
        }
    }
}
fn effective_key(r: &MergeRequest) -> &str {
    if r.write_key.is_empty() {
        &r.source.row.text
    } else {
        &r.write_key
    }
}
fn validate_request(r: &MergeRequest, cancel: &Cancel) -> Result<(), EngineError> {
    cancel.check()?;
    if r.source.sharing.is_some()
        || r.write_key.len() > 4 * 1_048_576
        || r.source.row.vector.len() > 32768
    {
        return Err(StoreError::InvalidInput.into());
    }
    state::bounded_row(&r.source.row, cancel)?;
    state::bounded_row(&r.replacement, cancel)?;
    let id = protocol::identity(
        &r.source.row.agent_id,
        &r.source.row.id,
        &JsString::from(effective_key(r)),
        cancel,
    )?;
    if r.replacement.id != id.replacement_id
        || r.replacement.id == r.source.row.id
        || r.replacement.text.is_empty()
        || r.replacement.text.len() > 1024 * 1024
        || r.source.row.text.len() > 1024 * 1024
        || r.replacement.vector.is_empty()
        || r.replacement.vector.len() > 32768
        || r.replacement.vector.iter().any(|v| !v.is_finite())
        || r.identity.dimension.as_u64() != Some(r.replacement.vector.len() as u64)
    {
        return Err(StoreError::InvalidInput.into());
    }
    let raw = parse_json(&serde_json::to_string(&r.source.row).map_err(|_| StoreError::Corrupt)?)
        .map_err(|_| StoreError::Corrupt)?;
    let meta: Value = serde_json::from_str(&write_json(&protocol::epistemic_metadata(
        &raw, r.now_ms, cancel,
    )?))
    .map_err(|_| StoreError::Corrupt)?;
    let row = serde_json::to_value(&r.replacement).map_err(|_| StoreError::Corrupt)?;
    for (k, v) in meta.as_object().ok_or(StoreError::Corrupt)? {
        if if k == "epistemicStatusUpdatedAt" {
            row[k].as_f64() != Some(r.now_ms as f64)
        } else {
            row[k] != *v
        } {
            return Err(StoreError::InvalidInput.into());
        }
    }
    if r.replacement.merged_from != write_json(&protocol::lineage(&raw, cancel)?) {
        return Err(StoreError::InvalidInput.into());
    }
    Ok(())
}
fn check_rows(
    store: &Store,
    before: &Record,
    after: &Record,
    stage: u8,
) -> Result<(), EngineError> {
    let original = store.get_record(&before.row.id)?;
    let replacement = store.get_record(&after.row.id)?;
    match &original {
        Some(v) if stage < 4 && before.same(v)? => (),
        None if stage >= 3 => (),
        _ => return Err(StoreError::InvalidInput.into()),
    }
    match replacement {
        Some(v) if after.same(&v)? => (),
        None if stage < 2 && original.is_some() => (),
        _ => return Err(StoreError::InvalidInput.into()),
    }
    Ok(())
}
#[path = "durable_merge_files.rs"]
mod files;
use files::Files;

#[path = "durable_merge_recovery.rs"]
mod recovery;
pub(crate) use recovery::{restore, RestoredMerge};
