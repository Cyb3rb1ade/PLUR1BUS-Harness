//! Caller-bound rollback: archive, fenced intent, soft delete, key release, completion.
use super::{
    archive,
    context::{error, OperationContext},
    import::ImportReceipts,
    import_lock::{self, ImportLease},
    link::valid_run_id,
    unimport_ledger::UnimportLedger,
    unimport_plan::{self as plan, storage, Decision, Selected, SelectedLink, Snapshot},
};
use crate::{
    context::RequestContext,
    contract::{
        AgentContext, Cancel, EngineError, MemoryOpErrorCode, MemoryRow, MemoryUnimportRequest,
        MemoryUnimportResult, Principal, StoreError, TurnOrigin,
    },
    neo::{
        capture_journal::CaptureJournal, correction_effects::EffectAuthority,
        unimport_graph::UnimportGraph,
    },
    store::{ledger::JsonlLedger, RowPatch, Store},
    text::{
        js::{js_trim, utf16_len, JsString},
        json::TolerantJsonValue as Json,
    },
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
/// Authoritative private store and non-creating shared-pool routes for each authenticated binding.
pub trait UnimportStores: Send + Sync {
    /// Read the operator's existing physical private store without creating or migrating it.
    fn existing(&self, ctx: &RequestContext) -> Result<Option<Arc<Store>>, StoreError>;
    /// Acquire the writable private store only under the per-agent import lease.
    fn writable(&self, ctx: &RequestContext) -> Result<Arc<Store>, StoreError>;
    /// Existing workspace and user pools. Unavailable routes must fail, never masquerade as empty.
    fn shared_pools(&self, ctx: &RequestContext) -> Result<Vec<Arc<Store>>, StoreError>;
    /// Soft-delete only lifecycle fields, retaining the archive baseline and import timestamp.
    fn tombstone(&self, store: &Store, id: &str) -> Result<(), StoreError> {
        store.patch(
            id,
            &RowPatch {
                status: Some("deleted".into()),
                epistemic_status: Some("invalidated".into()),
                ..Default::default()
            },
        )
    }
}
/// Derived graph/mirror cleanup is retryable after card rollback has committed.
#[derive(Default)]
pub struct UnimportCleanup {
    /// Canonical graph edges removed.
    pub graph_edges_removed: usize,
    /// Obsidian mirrors moved into the archive.
    pub mirrors_archived: usize,
    /// Best-effort cleanup failures.
    pub cleanup_errors: usize,
}
/// Durable archive/audit boundary and optional derived-data cleanup supplied by the native host.
pub trait UnimportEffects: Send + Sync {
    /// Archive the full authoritative row, including its vector, before a delete intent.
    fn archive(
        &self,
        row: &MemoryRow,
        agent: &str,
        state: &Path,
        now: i64,
    ) -> Result<PathBuf, EngineError>;
    /// Report an audit failure instead of silently claiming a successful destructive operation.
    fn audit(&self, workspace: &Path, entry: &Value) -> Result<(), EngineError>;
    /// None means no configured derived-data integration. Errors are counted and retried on rerun.
    fn cleanup(
        &self,
        _agent: &str,
        _workspace: Option<&Path>,
        _archive: &Path,
        _ids: &[String],
    ) -> Result<Option<UnimportCleanup>, EngineError> {
        Ok(None)
    }
}
/// On-disk archive and human audit; higher-level composition adds its real graph/mirror cleanup.
pub struct FileUnimportEffects;
impl UnimportEffects for FileUnimportEffects {
    fn archive(
        &self,
        row: &MemoryRow,
        agent: &str,
        state: &Path,
        now: i64,
    ) -> Result<PathBuf, EngineError> {
        archive::raw(row, agent, state, now)
    }
    fn audit(&self, workspace: &Path, entry: &Value) -> Result<(), EngineError> {
        archive::audit(workspace, entry)
    }
}
/// Native operation; no contextless privileged wire adapter is introduced.
pub struct Unimporter {
    context: Arc<OperationContext>,
    stores: Arc<dyn UnimportStores>,
    receipts: Arc<dyn ImportReceipts>,
    effects: Arc<dyn UnimportEffects>,
    base: PathBuf,
    jobs_root: Option<PathBuf>,
    graph: Option<Arc<CaptureJournal>>,
}
impl Unimporter {
    /// Compose guarded stores, the import ledger, archives and optional jobs history.
    pub fn new(
        context: Arc<OperationContext>,
        stores: Arc<dyn UnimportStores>,
        receipts: Arc<dyn ImportReceipts>,
        effects: Arc<dyn UnimportEffects>,
        base: PathBuf,
        jobs_root: Option<PathBuf>,
    ) -> Self {
        Self {
            context,
            stores,
            receipts,
            effects,
            base,
            jobs_root,
            graph: None,
        }
    }
    /// Compose native graph cleanup while retaining the original caller for each invocation.
    #[must_use]
    pub fn with_graph_cleanup(mut self, journal: Arc<CaptureJournal>) -> Self {
        self.graph = Some(journal);
        self
    }
    fn fence(&self, lease: &ImportLease) -> Result<(), EngineError> {
        self.context.assert_open()?;
        lease.assert_held()
    }
    fn shared(&self, id: &str, contexts: &[&RequestContext]) -> Result<bool, StoreError> {
        for ctx in contexts {
            for store in self.stores.shared_pools(ctx)? {
                if store.has_live_shared_origin(id, ctx.agent_id.as_str())? {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    fn decide(
        &self,
        card: &Selected,
        row: Option<&MemoryRow>,
        snapshot: &Snapshot,
        contexts: &[&RequestContext],
        req: &MemoryUnimportRequest,
    ) -> Result<Decision, EngineError> {
        let decision = plan::decide(
            card,
            row,
            snapshot,
            contexts,
            &req.import_run_id,
            req.force == Some(true),
            || self.shared(&card.receipt.card_id.to_utf8_lossy(), contexts),
        )?;
        if decision == Decision::Finish && row.is_none() {
            let (_, archived) = archive::rollback_record(
                self.context.host().state_dir(),
                req.agent_id.as_str(),
                &card.receipt.card_id.to_utf8_lossy(),
            )?;
            if !plan::visible(&archived, contexts)? {
                return Ok(Decision::Kept("binding-changed"));
            }
        }
        Ok(decision)
    }
    /// Preview by default; apply is explicitly false dryRun, system-origin and foreground only.
    pub fn unimport(
        &self,
        req: &MemoryUnimportRequest,
        p: &Principal,
        a: &AgentContext,
        cancel: &Cancel,
    ) -> Result<MemoryUnimportResult, EngineError> {
        if a.origin != TurnOrigin::System || a.background {
            return Err(error(MemoryOpErrorCode::Denied));
        }
        let operator = self.context.enter(p, a)?;
        if req.agent_id != p.agent_id
            || req.agent_id != operator.context.agent_id
            || !valid_run_id(&req.import_run_id)
        {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let keys = req
            .idempotency_keys
            .as_ref()
            .map(|keys| {
                if keys.len() > 500 {
                    return Err(error(MemoryOpErrorCode::InvalidInput));
                }
                keys.iter()
                    .map(|key| {
                        let key = js_trim(key);
                        if key.is_empty() || utf16_len(key) > 256 {
                            Err(error(MemoryOpErrorCode::InvalidInput))
                        } else {
                            Ok(JsString::from(key))
                        }
                    })
                    .collect::<Result<HashSet<_>, _>>()
            })
            .transpose()?;
        let binding = if let Some(p) = &req.principal {
            if p.agent_id != req.agent_id {
                return Err(error(MemoryOpErrorCode::InvalidInput));
            }
            Some(self.context.enter(p, a)?)
        } else {
            None
        };
        let mut contexts = vec![&operator.context];
        if let Some(binding) = &binding {
            contexts.push(&binding.context);
        }
        let agent = req.agent_id.as_str();
        let run = &req.import_run_id;
        let dry = req.dry_run != Some(false);
        let selected = plan::select(&self.base, agent, run, keys.as_ref())?;
        let links = plan::links(&self.base, agent, run, keys.as_ref())?;
        let mut result = Summary::new(
            req,
            &selected,
            &links,
            &plan::derived_jobs(self.jobs_root.as_deref(), agent, &selected),
        );
        if selected.is_empty() && links.is_empty() {
            return result.finish();
        }
        if dry {
            let snapshot = Snapshot::load(&self.base, agent, run)?;
            if !selected.is_empty() {
                let store = self.stores.existing(&operator.context).map_err(storage)?;
                for card in &selected {
                    if cancel.is_cancelled() {
                        break;
                    }
                    let decision = store
                        .as_ref()
                        .map(|s| s.get(&card.receipt.card_id.to_utf8_lossy()))
                        .transpose()
                        .map(Option::flatten)
                        .map_err(storage)
                        .and_then(|row| self.decide(card, row.as_ref(), &snapshot, &contexts, req));
                    match decision {
                        Ok(d) => result.decision(card, d),
                        Err(_) => result.card(
                            card,
                            "failed",
                            Some(if cancel.is_cancelled() {
                                "aborted"
                            } else {
                                "storage"
                            }),
                        ),
                    }
                }
            }
            for link in &links {
                result.link(link, link.done);
            }
            return result.finish();
        }
        if cancel.is_cancelled() {
            return result.finish();
        }
        let _mutation = self.context.mutation()?;
        // Admission errors affect derived cleanup only; card rollback remains independently durable.
        let graph = self.graph.as_ref().map(|journal| {
            UnimportGraph::open(
                self.context.clone(),
                journal.clone(),
                self.stores.clone(),
                EffectAuthority {
                    principal: p.clone(),
                    agent: a.clone(),
                    cancel: cancel.clone(),
                    base_db: self.base.clone(),
                },
            )
        });
        // No creating base-directory write for an empty selection or a cancelled request.
        let mut lease =
            match import_lock::acquire(&self.base, agent, cancel, Duration::from_secs(120)) {
                Ok(l) => l,
                Err(_) if cancel.is_cancelled() => return result.finish(),
                Err(e) => return Err(e),
            };
        self.fence(&lease)?;
        let sidecar = UnimportLedger::new(&self.base);
        sidecar.prepare(agent, run, self.context.host().now_ms(), &lease)?;
        let workspace = self
            .context
            .host()
            .workspace_dir(&req.agent_id)
            .map_err(storage)?;
        let store = if selected.is_empty() {
            None
        } else {
            Some(self.stores.writable(&operator.context).map_err(storage)?)
        };
        let mut cleanup = vec![];
        for card in &selected {
            lease.heartbeat()?;
            if cancel.is_cancelled() {
                break;
            }
            self.fence(&lease)?;
            let id = card.receipt.card_id.to_utf8_lossy();
            let store = store.as_ref().ok_or_else(|| storage(()))?;
            // Refresh external authorities for each card. A previous iteration is not a capability.
            let snapshot = Snapshot::load(&self.base, agent, run)?;
            let row = match store.get(&id) {
                Ok(row) => row,
                Err(_) => {
                    result.card(card, "failed", Some("storage"));
                    continue;
                }
            };
            let decision = match self.decide(card, row.as_ref(), &snapshot, &contexts, req) {
                Ok(d) => d,
                Err(e) if fatal(&e) => return Err(e),
                Err(_) => {
                    result.card(card, "failed", Some("storage"));
                    continue;
                }
            };
            if !matches!(decision, Decision::Eligible(_) | Decision::Finish) {
                if decision == Decision::Done && row.as_ref().is_some_and(|r| r.status == "deleted")
                {
                    cleanup.push(id);
                }
                result.decision(card, decision);
                continue;
            }
            if let Decision::Eligible(forced) = decision {
                let row = row.as_ref().ok_or_else(|| storage(()))?;
                self.fence(&lease)?;
                if cancel.is_cancelled() {
                    break;
                }
                let path = match self.effects.archive(
                    row,
                    agent,
                    self.context.host().state_dir(),
                    self.context.host().now_ms(),
                ) {
                    Ok(p) => p,
                    Err(e) if fatal(&e) => return Err(e),
                    Err(_) => {
                        result.card(card, "failed", Some("storage"));
                        continue;
                    }
                };
                if cancel.is_cancelled() {
                    break;
                }
                self.fence(&lease)?;
                sidecar.ensure_header(agent, run, self.context.host().now_ms(), &lease)?;
                let current = store.get(&id).map_err(storage)?;
                let fresh = Snapshot::load(&self.base, agent, run)?;
                let again = self.decide(card, current.as_ref(), &fresh, &contexts, req);
                let changed = plan::moved(row, current.as_ref())?;
                match again {
                    Ok(Decision::Eligible(_)) if !changed => {}
                    Ok(Decision::Eligible(_)) => {
                        result.decision(card, Decision::Kept("edited"));
                        continue;
                    }
                    Ok(Decision::Finish) => {
                        result.decision(card, Decision::Forgotten);
                        continue;
                    }
                    Ok(d) => {
                        result.decision(card, d);
                        continue;
                    }
                    Err(e) if fatal(&e) => return Err(e),
                    Err(_) => {
                        result.card(card, "failed", Some("storage"));
                        continue;
                    }
                }
                if cancel.is_cancelled() {
                    break;
                }
                self.fence(&lease)?;
                sidecar.append_intent(
                    agent,
                    run,
                    &card.receipt,
                    self.context.host().now_ms(),
                    &lease,
                )?;
                if cancel.is_cancelled() {
                    break;
                }
                self.fence(&lease)?;
                if self.stores.tombstone(store, &id).is_err() {
                    result.card(card, "failed", Some("storage"));
                    continue;
                }
                if cancel.is_cancelled() {
                    break;
                }
                self.fence(&lease)?;
                if let Some(workspace) = &workspace {
                    self.effects.audit(workspace,&json!({"event":"memory.unimported","source":"memory_unimport","agentId":agent,"memoryId":id,"importRunId":run,"archivePath":path.to_string_lossy(),"forced":forced.unwrap_or(""),"result":"committed","timestamp":archive::iso(self.context.host().now_ms())?}))?;
                }
            }
            if decision == Decision::Finish {
                // A Node/crashed call may have deleted the row before auditing. Recovery
                // cannot silently skip an earlier audit failure and declare success.
                if cancel.is_cancelled() {
                    break;
                }
                self.fence(&lease)?;
                let (path, _) =
                    archive::rollback_record(self.context.host().state_dir(), agent, &id)?;
                if let Some(workspace) = &workspace {
                    self.effects.audit(workspace, &json!({"event":"memory.unimported","source":"memory_unimport","agentId":agent,"memoryId":id,"importRunId":run,"archivePath":path.to_string_lossy(),"forced":"","result":"committed","recovered":true,"timestamp":archive::iso(self.context.host().now_ms())?}))?;
                }
            }
            // A concurrent forget must never be turned into a free idempotency key.
            if cancel.is_cancelled() {
                break;
            }
            self.fence(&lease)?;
            let fresh = Snapshot::load(&self.base, agent, run)?;
            if fresh.forgotten.contains(&card.receipt.card_id) {
                result.decision(card, Decision::Forgotten);
                continue;
            }
            if !fresh
                .index
                .unimported_by_card_id
                .get(&card.receipt.card_id)
                .is_some_and(|l| {
                    plan::text(&l.raw, "importRunId") == Some(&JsString::from(run.as_str()))
                })
            {
                let receipt = Json::Object(vec![
                    ("kind".into(), Json::String("unimported".into())),
                    (
                        "idempotencyKey".into(),
                        Json::String(card.receipt.idempotency_key.clone()),
                    ),
                    ("cardId".into(), Json::String(card.receipt.card_id.clone())),
                    ("importRunId".into(), Json::String(run.as_str().into())),
                    (
                        "at".into(),
                        Json::Number(self.context.host().now_ms().to_string()),
                    ),
                ]);
                self.receipts.append(agent, &receipt).map_err(storage)?;
            }
            if cancel.is_cancelled() {
                break;
            }
            self.fence(&lease)?;
            sidecar.ensure_header(agent, run, self.context.host().now_ms(), &lease)?;
            sidecar.append_done(
                agent,
                run,
                &card.receipt,
                self.context.host().now_ms(),
                &lease,
            )?;
            result.card(card, "unimported", None);
            cleanup.push(id);
        }
        if !cancel.is_cancelled() {
            let current = plan::links(&self.base, agent, run, keys.as_ref())?;
            for link in &links {
                lease.heartbeat()?;
                if cancel.is_cancelled() {
                    break;
                }
                self.fence(&lease)?;
                let entry = current.iter().find(|l| l.link_id == link.link_id);
                if entry.is_none_or(|e| e.done) {
                    result.link(link, true);
                    continue;
                }
                let now = self.context.host().now_ms();
                let entry = entry.ok_or_else(|| storage(()))?;
                let raw = Json::Object(vec![
                    ("v".into(), Json::Number("1".into())),
                    ("kind".into(), Json::String("unlinked".into())),
                    ("linkId".into(), Json::String(entry.link_id.clone())),
                    ("cardId".into(), Json::String(entry.card_id.clone())),
                    ("importRunId".into(), Json::String(run.as_str().into())),
                    ("at".into(), Json::Number(now.to_string())),
                ]);
                JsonlLedger::<Json>::open(&self.base.join("_links").join(format!("{agent}.jsonl")))
                    .and_then(|l| l.append_durable(&raw))
                    .map_err(storage)?;
                if let Some(workspace) = &workspace {
                    self.effects.audit(workspace,&json!({"event":"memory.unlinked","source":"memory_unimport","agentId":agent,"memoryId":entry.card_id.to_utf8_lossy(),"linkId":entry.link_id.to_utf8_lossy(),"importRunId":run,"result":"committed","timestamp":archive::iso(now)?}))?;
                }
                result.link(entry, false);
            }
        }
        if !cleanup.is_empty() && !cancel.is_cancelled() {
            self.fence(&lease)?;
            let cleaned = self.effects.cleanup(
                agent,
                workspace.as_deref(),
                &self.context.host().state_dir().join("memory/_archive"),
                &cleanup,
            );
            let cleaned = cleaned.unwrap_or_else(|_| {
                Some(UnimportCleanup {
                    cleanup_errors: 1,
                    ..Default::default()
                })
            });
            let graph_result = graph.map(|admission| {
                admission.and_then(|graph| graph.run(&cleanup, &|| self.fence(&lease)))
            });
            let cleaned = match graph_result {
                None => cleaned,
                Some(result) => {
                    let mut combined = cleaned.unwrap_or_default();
                    match result {
                        Ok(graph) => {
                            combined.graph_edges_removed += graph.graph_edges_removed;
                            combined.cleanup_errors += graph.cleanup_errors;
                        }
                        Err(_) => combined.cleanup_errors += 1,
                    }
                    Some(combined)
                }
            };
            if let Some(c) = cleaned {
                result.value["derived"]["graphEdgesRemoved"] = json!(c.graph_edges_removed);
                result.value["derived"]["mirrorsArchived"] = json!(c.mirrors_archived);
                result.value["derived"]["cleanupErrors"] = json!(c.cleanup_errors);
            }
        }
        result.finish()
    }
}
fn fatal(e: &EngineError) -> bool {
    matches!(e,EngineError::MemoryOp(e) if matches!(e.code,MemoryOpErrorCode::LockLost|MemoryOpErrorCode::LedgerCorrupt))
}
struct Summary {
    value: Value,
}
impl Summary {
    fn new(
        req: &MemoryUnimportRequest,
        cards: &[Selected],
        links: &[SelectedLink],
        jobs: &[String],
    ) -> Self {
        let mut value = json!({"agentId":req.agent_id,"importRunId":req.import_run_id,"dryRun":req.dry_run!=Some(false),"selected":cards.len(),"unimported":0,"keptModified":0,"alreadyForgotten":0,"alreadyUnimported":0,"missing":0,"failed":0,"remaining":cards.len(),"cards":[],"derived":{"jobsSinceImport":jobs}});
        if !links.is_empty() {
            value["links"] =
                json!({"selected":links.len(),"unlinked":0,"alreadyUnlinked":0,"items":[]});
        }
        Self { value }
    }
    fn card(&mut self, card: &Selected, outcome: &str, reason: Option<&str>) {
        let mut row = json!({"idempotencyKey":card.receipt.idempotency_key.to_utf8_lossy(),"id":card.receipt.card_id.to_utf8_lossy(),"outcome":outcome});
        if let Some(reason) = reason {
            row["reason"] = json!(reason);
        }
        if let Some(cards) = self.value["cards"].as_array_mut() {
            cards.push(row);
        }
        self.value["remaining"] = json!(self.value["remaining"]
            .as_u64()
            .unwrap_or(1)
            .saturating_sub(1));
        let counter = match outcome {
            "unimported" => "unimported",
            "kept-modified" => "keptModified",
            "already-forgotten" => "alreadyForgotten",
            "already-unimported" => "alreadyUnimported",
            "missing" => "missing",
            _ => "failed",
        };
        self.value[counter] = json!(self.value[counter].as_u64().unwrap_or(0) + 1);
    }
    fn decision(&mut self, card: &Selected, d: Decision) {
        let (outcome, reason) = d.result();
        self.card(card, outcome, reason);
    }
    fn link(&mut self, link: &SelectedLink, done: bool) {
        let outcome = if done { "already-unlinked" } else { "unlinked" };
        let counter = if done { "alreadyUnlinked" } else { "unlinked" };
        let row = json!({"linkId":link.link_id.to_utf8_lossy(),"id":link.card_id.to_utf8_lossy(),"outcome":outcome});
        if let Some(items) = self.value["links"]["items"].as_array_mut() {
            items.push(row);
        }
        self.value["links"][counter] =
            json!(self.value["links"][counter].as_u64().unwrap_or(0) + 1);
    }
    fn finish(self) -> Result<MemoryUnimportResult, EngineError> {
        serde_json::from_value(self.value).map_err(storage)
    }
}
