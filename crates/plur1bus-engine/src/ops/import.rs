//! Finished-card import: classify read-only, embed outside the lock, recheck/store/receipt under it.
use super::{
    context::{error, OperationContext},
    import_ledger::{ImportIndex, ImportLedger},
    import_lock,
    import_primitives::{import_card_id, import_row_digest},
    import_row::{self, ImportEncoding, ImportPlan},
    link::{source_ref_run_id, valid_run_id},
};
use crate::{
    capture::categorize::MEMORY_CATEGORIES,
    context::RequestContext,
    contract::{
        AgentContext, Cancel, EngineError, MemoryImportRequest, MemoryImportResult,
        MemoryOpErrorCode, MemoryRow, Principal, StoreError, TurnOrigin,
    },
    embedding::{EmbedKind, EmbeddingProvider},
    recall::acl,
    store::{
        identity::identity_id,
        paths::secure_dir,
        tombstone::{TombstoneContext, TombstoneRegistry},
        Store,
    },
    text::{
        js::{js_trim, utf16_len, JsString},
        json::{parse_json, TolerantJsonValue as Json},
    },
};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

/// Host-owned routes: dry-run and initial classification must never create a store.
pub trait ImportStores: Send + Sync {
    /// Lease only the existing private physical store for the authenticated binding.
    fn existing(&self, context: &RequestContext) -> Result<Option<Arc<Store>>, StoreError>;
    /// Lease or create that store only after apply acquires the import lock.
    fn writable(&self, context: &RequestContext) -> Result<Arc<Store>, StoreError>;
    /// Remove a just-imported row after receipt failure, or a previously unimported row.
    fn delete(&self, store: &Store, id: &str) -> Result<(), StoreError> {
        store.delete(&[id]).map(|_| ())
    }
}
/// Durable receipt boundary. Production uses the same Node-compatible import ledger.
pub trait ImportReceipts: Send + Sync {
    /// Read current indices; an unreadable ledger is never an empty index.
    fn load(&self, agent: &str) -> Result<ImportIndex, StoreError>;
    /// Append and file-sync one projected receipt before reporting completion.
    fn append(&self, agent: &str, receipt: &Json) -> Result<(), StoreError>;
}
impl ImportReceipts for ImportLedger {
    fn load(&self, agent: &str) -> Result<ImportIndex, StoreError> {
        self.load(agent)
    }
    fn append(&self, agent: &str, receipt: &Json) -> Result<(), StoreError> {
        self.append(agent, receipt)
    }
}

/// Caller-bound importer without a second scheduler or any LLM calls.
pub struct Importer {
    context: Arc<OperationContext>,
    stores: Arc<dyn ImportStores>,
    embedder: Arc<dyn EmbeddingProvider>,
    receipts: Arc<dyn ImportReceipts>,
    base: PathBuf,
    encoding: ImportEncoding,
}
struct Entry {
    card: Value,
    key: String,
    result: Option<Value>,
    plan: Option<ImportPlan>,
    duplicate: Option<usize>,
    backfill: Option<(Box<MemoryRow>, ImportPlan)>,
}
impl Entry {
    fn reject(&mut self, reason: &str) {
        self.result = Some(json!({"idempotencyKey":self.key,"outcome":"rejected","reason":reason}));
        self.plan = None;
    }
    fn matched(&mut self, id: &str) {
        self.result = Some(
            json!({"idempotencyKey":self.key,"outcome":"matched-existing","id":id,"reason":"already-imported"}),
        );
    }
}
fn storage(_: impl Sized) -> EngineError {
    error(MemoryOpErrorCode::Storage)
}
fn source(card: &Value) -> JsString {
    JsString::from(card["sourceRef"].as_str().unwrap_or("")).utf16_slice(0, 500)
}
fn run(explicit: Option<&str>, source: &JsString) -> String {
    explicit
        .map(str::to_owned)
        .unwrap_or_else(|| source_ref_run_id(&source.to_utf8_lossy()))
}
fn digest(row: &MemoryRow) -> Result<Value, StoreError> {
    let raw = parse_json(&serde_json::to_string(row).map_err(|_| StoreError::Corrupt)?)
        .map_err(|_| StoreError::Corrupt)?;
    serde_json::to_value(import_row_digest(&raw)).map_err(|_| StoreError::Corrupt)
}
fn receipt(
    key: &str,
    id: &str,
    source: &JsString,
    now: f64,
    run: &str,
    baseline: Option<Value>,
    backfilled: bool,
) -> Result<Json, StoreError> {
    let mut value = json!({"idempotencyKey":key,"cardId":id,"sourceRef":"","importedAt":now});
    if !run.is_empty() {
        value["importRunId"] = json!(run);
        if backfilled {
            value["backfilled"] = json!(true);
        }
    }
    if let Some(digest) = baseline {
        value["digest"] = digest;
    }
    let mut raw = parse_json(&value.to_string()).map_err(|_| StoreError::Corrupt)?;
    if let Json::Object(fields) = &mut raw {
        if let Some((_, value)) = fields
            .iter_mut()
            .find(|(k, _)| *k == JsString::from("sourceRef"))
        {
            *value = Json::String(source.clone());
        }
    }
    Ok(raw)
}
fn backfill(
    row: &MemoryRow,
    plan: &ImportPlan,
    now: i64,
    explicit: Option<&str>,
) -> Result<Json, StoreError> {
    let created = row.source_timestamp.as_f64().unwrap_or(0.);
    let untouched = created.is_finite()
        && created > 0.
        && row.updated_at.as_f64() == Some(created)
        && row.text == plan.text;
    let source = if plan.source.is_empty() {
        JsString::from(row.source_url.as_str())
    } else {
        plan.source.clone()
    };
    let own_run = source_ref_run_id(&row.source_url);
    let run = if own_run.is_empty() {
        run(explicit, &source)
    } else {
        own_run
    };
    receipt(
        &plan.key,
        &plan.id,
        &source,
        if untouched { created } else { now as f64 },
        &run,
        if untouched { Some(digest(row)?) } else { None },
        true,
    )
}
enum Existing {
    Live(Box<MemoryRow>),
    Missing,
    Unimported,
    Rejected(&'static str),
}
fn existing(
    store: Option<&Store>,
    plan: &ImportPlan,
    index: &ImportIndex,
    registry: &TombstoneRegistry,
    ctx: &RequestContext,
) -> Result<Existing, StoreError> {
    let row = store.map(|s| s.get(&plan.id)).transpose()?.flatten();
    if let Some(row) = row {
        // A deterministic ID is not proof of access to an old user/workspace binding.
        if acl::allowed(&row, ctx).is_err() {
            return Ok(Existing::Rejected("principal-unresolved"));
        }
        if registry.find_by_origin(&plan.id, false)?.is_some() {
            return Ok(Existing::Rejected("previously-imported-deleted"));
        }
        if row.status.is_empty() || row.status == "active" {
            return Ok(Existing::Live(Box::new(row)));
        }
        if row.status == "deleted"
            && index
                .unimported_by_card_id
                .contains_key(&JsString::from(plan.id.as_str()))
            && !index
                .by_key
                .contains_key(&JsString::from(plan.key.as_str()))
        {
            return Ok(Existing::Unimported);
        }
        return Ok(Existing::Rejected("previously-imported-deleted"));
    }
    Ok(
        if index
            .by_key
            .contains_key(&JsString::from(plan.key.as_str()))
        {
            Existing::Rejected("previously-imported-deleted")
        } else {
            Existing::Missing
        },
    )
}
fn plan(entry: &Entry, ctx: &RequestContext, now: i64) -> Result<ImportPlan, &'static str> {
    let card = &entry.card;
    if card["provenance"] != "imported" {
        return Err("provenance-not-imported");
    }
    let raw = card["text"].as_str().unwrap_or("");
    let text = js_trim(raw);
    if text.is_empty() {
        return Err("empty-text");
    }
    if utf16_len(raw) > 50_000 {
        return Err("invalid-input");
    }
    let kind = card["kind"].as_str().filter(|s| !s.is_empty());
    if kind.is_some_and(|k| !MEMORY_CATEGORIES.contains(&k)) {
        return Err("invalid-input");
    }
    let scope = card["scope"].as_str().unwrap_or("agent-private");
    if scope == "user" && (ctx.trust() != "proved" || ctx.owner_user_id.is_empty())
        || scope == "workspace" && ctx.workspace_key.is_empty()
    {
        return Err("principal-unresolved");
    }
    Ok(ImportPlan {
        id: import_card_id(ctx.agent_id.as_str(), &entry.key),
        key: entry.key.clone(),
        text: text.to_owned(),
        kind: kind.map(str::to_owned),
        scope: scope.to_owned(),
        owner: if scope == "user" {
            ctx.owner_user_id.clone()
        } else {
            String::new()
        },
        workspace: if scope == "workspace" {
            ctx.workspace_key.clone()
        } else {
            String::new()
        },
        source: source(card),
        created_at: card["createdAt"]
            .as_f64()
            .filter(|n| n.is_finite())
            .map_or(now as f64, f64::floor),
    })
}
impl Importer {
    /// Compose authenticated routes, provider, durable receipts and encoding policy.
    pub fn new(
        context: Arc<OperationContext>,
        stores: Arc<dyn ImportStores>,
        embedder: Arc<dyn EmbeddingProvider>,
        receipts: Arc<dyn ImportReceipts>,
        base: PathBuf,
        encoding: ImportEncoding,
    ) -> Self {
        Self {
            context,
            stores,
            embedder,
            receipts,
            base,
            encoding,
        }
    }
    /// Import at the host's operation time.
    pub fn import(
        &self,
        request: &MemoryImportRequest,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<MemoryImportResult, EngineError> {
        self.import_with_clock(request, principal, agent, cancel, &|| {
            self.context.host().now_ms()
        })
    }
    /// Explicit clock seam for deterministic replay tests; all authorization remains active.
    pub fn import_at(
        &self,
        request: &MemoryImportRequest,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
        now: i64,
    ) -> Result<MemoryImportResult, EngineError> {
        self.import_with_clock(request, principal, agent, cancel, &|| now)
    }
    fn import_with_clock(
        &self,
        request: &MemoryImportRequest,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
        clock: &dyn Fn() -> i64,
    ) -> Result<MemoryImportResult, EngineError> {
        if agent.origin != TurnOrigin::System || agent.background {
            return Err(error(MemoryOpErrorCode::Denied));
        }
        let _operator = self.context.enter(principal, agent)?;
        if request.agent_id != principal.agent_id
            || request.principal.agent_id != request.agent_id
            || request.cards.len() > 500
            || request
                .import_run_id
                .as_ref()
                .is_some_and(|r| !valid_run_id(r))
        {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let binding = self.context.enter(&request.principal, agent)?;
        let ctx = &binding.context;
        let registry =
            TombstoneRegistry::new(&self.base, ctx.agent_id.as_str()).map_err(storage)?;
        let dry = request.dry_run == Some(true);
        let explicit = request.import_run_id.as_deref();
        let now = clock();
        let mut entries = request
            .cards
            .iter()
            .map(|c| {
                let card = serde_json::to_value(c).map_err(storage)?;
                Ok(Entry {
                    key: card["idempotencyKey"].as_str().unwrap_or("").to_owned(),
                    card,
                    result: None,
                    plan: None,
                    duplicate: None,
                    backfill: None,
                })
            })
            .collect::<Result<Vec<_>, EngineError>>()?;
        let store = self.stores.existing(ctx).map_err(storage)?;
        let index = self.receipts.load(ctx.agent_id.as_str()).map_err(storage)?;
        let mut seen = HashMap::<String, usize>::new();
        for (position, entry) in entries.iter_mut().enumerate() {
            if cancel.check().is_err() {
                entry.reject("aborted");
                continue;
            }
            let key = js_trim(&entry.key);
            if key.is_empty() || utf16_len(key) > 256 {
                entry.reject("invalid-input");
                continue;
            }
            entry.key = key.to_owned();
            if let Some(first) = seen.get(&entry.key) {
                entry.duplicate = Some(*first);
                continue;
            }
            let plan = match plan(entry, ctx, now) {
                Ok(p) => p,
                Err(reason) => {
                    entry.reject(reason);
                    continue;
                }
            };
            match existing(store.as_deref(), &plan, &index, &registry, ctx) {
                Ok(Existing::Live(row)) => {
                    entry.matched(&plan.id);
                    if !index
                        .by_card_id
                        .contains_key(&JsString::from(plan.id.as_str()))
                    {
                        entry.backfill = Some((row, plan));
                    }
                }
                Ok(Existing::Missing | Existing::Unimported) => {
                    let context = TombstoneContext {
                        agent_id: ctx.agent_id.as_str(),
                        scope: &plan.scope,
                        workspace_identity: &plan.workspace,
                        owner_user_id: &plan.owner,
                    };
                    if registry
                        .find_blocking_readonly(&plan.text, context)
                        .map_err(storage)?
                        .is_some()
                    {
                        entry.reject("tombstone-blocked");
                        continue;
                    }
                    entry.plan = Some(plan);
                }
                Ok(Existing::Rejected(reason)) => {
                    entry.reject(reason);
                    continue;
                }
                Err(_) => {
                    entry.reject("storage");
                    continue;
                }
            }
            seen.insert(entry.key.clone(), position);
        }
        drop(store);
        if dry {
            for entry in &mut entries {
                if entry.plan.is_some() {
                    entry.result = Some(json!({"idempotencyKey":entry.key,"outcome":"created"}));
                }
            }
        } else {
            self.apply(&mut entries, ctx, &registry, explicit, cancel, clock)?;
        }
        for position in 0..entries.len() {
            if let Some(first) = entries[position].duplicate {
                let initial = entries[first].result.as_ref();
                let result = if initial.is_some_and(|r| r["outcome"] != "rejected") {
                    json!({"idempotencyKey":entries[position].key,"outcome":"matched-existing","id":import_card_id(ctx.agent_id.as_str(),&entries[first].key),"reason":"duplicate-in-batch"})
                } else {
                    json!({"idempotencyKey":entries[position].key,"outcome":"rejected","reason":initial.and_then(|r|r["reason"].as_str()).unwrap_or("storage")})
                };
                entries[position].result = Some(result);
            }
        }
        let cards = entries
            .into_iter()
            .map(|e| e.result.ok_or_else(|| storage(())))
            .collect::<Result<Vec<_>, _>>()?;
        let count = |name| cards.iter().filter(|c| c["outcome"] == name).count();
        serde_json::from_value(json!({"agentId":ctx.agent_id,"dryRun":dry,"created":count("created"),"matchedExisting":count("matched-existing"),"rejected":count("rejected"),"cards":cards})).map_err(storage)
    }
    fn apply(
        &self,
        entries: &mut [Entry],
        ctx: &RequestContext,
        registry: &TombstoneRegistry,
        explicit: Option<&str>,
        cancel: &Cancel,
        clock: &dyn Fn() -> i64,
    ) -> Result<(), EngineError> {
        let pending = entries
            .iter()
            .enumerate()
            .filter(|(_, e)| e.plan.is_some())
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        let texts = pending
            .iter()
            .filter_map(|i| entries[*i].plan.as_ref().map(|p| p.text.clone()))
            .collect::<Vec<_>>();
        let mut vectors = HashMap::new();
        if !pending.is_empty() {
            match self.embedder.embed(&texts, EmbedKind::Passage, cancel) {
                Ok(batch) if batch.len() == pending.len() && cancel.check().is_ok() => {
                    for (position, vector) in pending.iter().copied().zip(batch) {
                        vectors.insert(position, vector);
                    }
                }
                _ => {
                    for i in &pending {
                        entries[*i].reject(if cancel.check().is_err() {
                            "aborted"
                        } else {
                            "storage"
                        });
                    }
                }
            }
        }
        if cancel.check().is_err() {
            for entry in entries.iter_mut() {
                if entry.result.is_none() && entry.duplicate.is_none() {
                    entry.reject("aborted");
                }
            }
            return Ok(());
        }
        self.context.assert_open()?;
        secure_dir(&self.base).map_err(storage)?;
        let mut lease = match import_lock::acquire(
            &self.base,
            ctx.agent_id.as_str(),
            cancel,
            Duration::from_secs(120),
        ) {
            Ok(lease) => lease,
            Err(_) => {
                for entry in entries {
                    if entry.result.is_none() && entry.duplicate.is_none() {
                        entry.reject(if cancel.check().is_err() {
                            "aborted"
                        } else {
                            "storage"
                        });
                    }
                }
                return Ok(());
            }
        };
        let store = self.stores.writable(ctx).map_err(storage)?;
        let mut index = self.receipts.load(ctx.agent_id.as_str()).map_err(storage)?;
        for entry in entries.iter_mut() {
            if let Some((row, plan)) = entry.backfill.as_ref() {
                if index
                    .by_card_id
                    .contains_key(&JsString::from(plan.id.as_str()))
                {
                    continue;
                }
                let receipt = backfill(row, plan, clock(), explicit).map_err(storage)?;
                lease.heartbeat()?;
                self.context.assert_open()?;
                if self
                    .receipts
                    .append(ctx.agent_id.as_str(), &receipt)
                    .is_ok()
                {
                    index = self.receipts.load(ctx.agent_id.as_str()).map_err(storage)?;
                }
            }
        }
        for position in pending {
            lease.heartbeat()?;
            let entry = &mut entries[position];
            if entry.result.is_some() {
                continue;
            }
            if cancel.check().is_err() {
                entry.reject("aborted");
                continue;
            }
            let Some(plan) = entry.plan.clone() else {
                entry.reject("storage");
                continue;
            };
            let replace = match existing(Some(&store), &plan, &index, registry, ctx) {
                Ok(Existing::Live(row)) => {
                    entry.matched(&plan.id);
                    if !index
                        .by_card_id
                        .contains_key(&JsString::from(plan.id.as_str()))
                    {
                        let receipt = backfill(&row, &plan, clock(), explicit).map_err(storage)?;
                        if self
                            .receipts
                            .append(ctx.agent_id.as_str(), &receipt)
                            .is_ok()
                        {
                            index = self.receipts.load(ctx.agent_id.as_str()).map_err(storage)?;
                        }
                    }
                    continue;
                }
                Ok(Existing::Unimported) => true,
                Ok(Existing::Missing) => false,
                Ok(Existing::Rejected(reason)) => {
                    entry.reject(reason);
                    continue;
                }
                Err(_) => {
                    entry.reject("storage");
                    continue;
                }
            };
            let Some(vector) = vectors.remove(&position) else {
                entry.reject("storage");
                continue;
            };
            if vector.is_empty()
                || vector.iter().any(|n| !n.is_finite())
                || store.identity().is_some_and(|id| {
                    identity_id(id).ok() != identity_id(self.embedder.identity()).ok()
                })
            {
                entry.reject("storage");
                continue;
            }
            let now = clock();
            let row = match import_row::build(&plan, ctx, &vector, now, &self.encoding) {
                Ok(row) => row,
                Err(_) => {
                    entry.reject("storage");
                    continue;
                }
            };
            self.context.assert_open()?;
            lease.assert_held()?;
            if cancel.check().is_err() {
                entry.reject("aborted");
                continue;
            }
            if replace && self.stores.delete(&store, &plan.id).is_err() {
                entry.reject("storage");
                continue;
            }
            if let Err(err) = store.upsert(&[row]) {
                entry.reject(if err == StoreError::TombstoneBlocked {
                    "tombstone-blocked"
                } else {
                    "storage"
                });
                continue;
            }
            let run = run(explicit, &plan.source);
            let baseline = if run.is_empty() {
                None
            } else {
                store
                    .get(&plan.id)
                    .ok()
                    .flatten()
                    .and_then(|row| digest(&row).ok())
            };
            let receipt = receipt(
                &plan.key,
                &plan.id,
                &plan.source,
                now as f64,
                &run,
                baseline,
                false,
            )
            .map_err(storage)?;
            lease.assert_held()?;
            if self
                .receipts
                .append(ctx.agent_id.as_str(), &receipt)
                .is_err()
            {
                let _ = self.stores.delete(&store, &plan.id);
                entry.reject("storage");
                continue;
            }
            index = self.receipts.load(ctx.agent_id.as_str()).map_err(storage)?;
            entry.result =
                Some(json!({"idempotencyKey":plan.key,"outcome":"created","id":plan.id}));
        }
        Ok(())
    }
}
