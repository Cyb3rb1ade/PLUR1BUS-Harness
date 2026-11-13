//! Process composition over the frozen engine ports.
//!
//! RE-03 provides real embedding/model services; copied-store inspection and the
//! static system supplement reuse their native components. Store opening uses lazy
//! namespace pools, also used by native memory reads and deletion. Other ports are
//! composed separately as their runtime dependencies become available.
//! Selecting a flat embedding seam never installs a fake memory pipeline.

#[path = "engine_capture.rs"]
mod engine_capture;
#[path = "engine_jobs.rs"]
mod engine_jobs;
#[path = "engine_memory.rs"]
mod engine_memory;
#[path = "engine_recall.rs"]
mod engine_recall;
#[path = "engine_stores.rs"]
mod engine_stores;
#[path = "engine_warm.rs"]
mod engine_warm;
use super::seams::Seam;
use crate::{
    contract::*,
    embedding::{
        self,
        normalize::normalize_embedding_config,
        service::{Service, ServiceOptions},
    },
    ops::{
        import::Importer, import_ledger::ImportLedger, memory::MemoryReader, rebind::Rebinder,
        sharing::ShareServices, write::MemoryWriter,
    },
};
use engine_stores::EngineStores;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};

/// The process engine's composition root; incomplete memory ports fail explicitly.
pub struct ProcessEngine {
    embedding: Arc<Service>,
    stores: crate::ops::adopt::StoreAdopter,
    store_cancel: Cancel,
    live_stores: Arc<EngineStores>,
    memory: Option<ProcessMemory>,
    proposals: engine_memory::ProposalsPort,
    curation: engine_memory::CurationPort,
    #[cfg_attr(not(test), allow(dead_code, reason = "test hooks set the budget"))]
    embed_budget: Arc<engine_memory::EmbedBudget>,
    mood: engine_recall::RecallMood,
    capture: engine_capture::ProcessCapture,
    jobs: Arc<engine_jobs::ProcessJobs>,
    operations: Arc<crate::ops::context::OperationContext>,
    checkpoints: crate::store::checkpoint::CheckpointStore,
    system_supplement: Vec<String>,
    capabilities: Capabilities,
    /// The status before memory composition (no store base): composition-pending/recall.
    status: EngineStatus,
    /// The pin's status reporter over real sources, composed when a store base is configured.
    reporter: Option<crate::ops::status::StatusReporter>,
    closed: Arc<AtomicBool>,
    unavailable: Unavailable,
    channels: Channels,
    subscribers: Mutex<Vec<mpsc::Sender<EngineEvent>>>,
    model_degradation: [Degraded; 4],
    closed_degradation: Degraded,
}

struct ProcessMemory {
    reader: Arc<MemoryReader>,
    writer: MemoryWriter,
    importer: Importer,
    rebinder: Rebinder,
    /// The facade for correct, accept, unimport, promote and curation (RE-D165).
    native: Arc<engine_memory::NativeSlot>,
}

impl crate::ops::models::ModelInventory for ProcessEngine {
    fn inventory(
        &self,
        cancel: &Cancel,
    ) -> Result<Vec<crate::ops::models::ModelRequirement>, EngineError> {
        crate::ops::models::ModelInventory::inventory(self.embedding.as_ref(), cancel)
    }
}

impl ProcessEngine {
    pub(super) fn configured_store_base(&self) -> Option<&std::path::Path> {
        self.live_stores.configured_base()
    }

    /// Run a job admitted by the native host for its bound principal. The legacy
    /// JobRegistry and process RPC do not accept a principal from their caller.
    pub fn run_authorized_job(
        &self,
        authority: crate::jobs::authority::JobAuthority,
        options: RunOptions,
        cancel: &Cancel,
    ) -> Result<JobRun, EngineError> {
        self.jobs.run_authorized(authority, options, cancel)
    }

    pub(super) fn capture_host_turn(
        &self,
        turn: TurnRecord,
        options: CaptureOptions,
        metadata: Option<Vec<crate::neo::turn_batch::MessageMetadata>>,
    ) -> Result<CaptureHandle, EngineError> {
        turn.cancel.check()?;
        if !self.closed.load(Ordering::Acquire) {
            if let Some(base) = self.live_stores.configured_base() {
                return engine_capture::ProcessCapture::accept(self, base, turn, options, metadata);
            }
        }
        Err(self.unavailable.error())
    }

    pub(super) fn job_needs_authority(&self, job: JobName) -> bool {
        self.jobs.needs_authority(job)
    }

    /// Compose the real RE-03 providers or an explicitly selected embedding seam.
    /// Construction is lazy: it neither loads models nor opens memory stores.
    pub fn new(host: Arc<dyn HostServices>, seam: Option<Seam>) -> Result<Self, EngineError> {
        let config = host.config();
        let raw = serde_json::to_value(&config).map_err(|_| composition_invalid())?;
        let normalized = host_normalized_embedding(&raw, host.as_ref())?;
        // The lazy provider owns the complete effective vector identity. A
        // normalized local config alone omits its pinned artifact/revision and
        // pooling metadata, so deriving an envelope from it would reject the
        // real provider (or advertise a different vector space for a seam).
        let configured_provider = embedding::build_embedding_owned(&config, host.clone())?;
        let space = configured_provider.identity().clone();
        let fingerprint_id =
            embedding::fingerprint::try_fingerprint_id(&normalized).map_err(|error| {
                EngineError::Invalid {
                    field: error.path,
                    message: error.message,
                }
            })?;
        let identity = EmbeddingIdentity {
            provider: space.provider.clone(),
            model: space.model.clone(),
            dimensions: space.dimension.clone(),
            fingerprint_id: fingerprint_id.clone(),
            space: Some(space.clone()),
        };
        let provider: Box<dyn embedding::EmbeddingProvider> = match seam {
            Some(seam) => seam.embedder(normalized.dimensions(), &space)?,
            None => configured_provider,
        };
        let reranker = if seam.is_some() {
            None
        } else {
            embedding::build_reranker_owned(&config, host.clone())?
        };
        let mut options = ServiceOptions::from_config(&config)?;
        if reranker.is_some() {
            options.reranker_provider = Some(
                raw.pointer("/reranker/provider")
                    .and_then(Value::as_str)
                    .unwrap_or("local-transformers")
                    .into(),
            );
        }
        let checkpoint_host = host.clone();
        let checkpoints =
            crate::store::checkpoint::CheckpointStore::new(move || checkpoint_host.now_ms() as f64);
        let platform = host.platform().clone();
        let clock_host = host.clone();
        options.clock = Arc::new(move || clock_host.now_ms());
        let store_clock = options.clock.clone();
        let embedding = Arc::new(Service::new(
            provider,
            reranker,
            identity.clone(),
            None,
            options,
        )?);
        let store_cancel = Cancel::never();
        let stores = crate::ops::adopt::StoreAdopter::new(
            embedding.clone(),
            Some(identity),
            platform,
            Arc::new(crate::ops::adopt::CopiedStoreRoutes),
            store_cancel.clone(),
        );
        let base = config
            .base_db_path
            .as_ref()
            .filter(|p| !p.is_empty())
            .map(std::path::PathBuf::from);
        if let Some(base) = &base {
            // No write here: the process initialises a fresh base after acquiring its home lock, and a library
            // composition gets the marker with the first entry in the base (RE-D175).
            crate::store::schema_version::guard_base(base)?;
        }
        let memory_link = base.is_some();
        // Without a store base, the frozen status text keeps composition-pending/recall: no
        // memory, journal, job or schema composition exists. With a base, the pin's reporter
        // assembles the status from its real sources (RE-D157). The process serves A1, so it
        // reports contract 1.18.0 (RE-D167).
        let status: EngineStatus = decode(json!({
            "ready": false, "degraded": {"reason":"composition-pending","capability":"recall"},
            "agents":0,"contract":"1.18.0","storeSchema":{"current":null,"expected":"1"},
            "jobs":{"ledger":"unavailable","agents":[]},"models":embedding.status(),"journal":null,
            "sharedMemory":{"supported":false,"mode":"unavailable"}
        }))?;
        let closed = Arc::new(AtomicBool::new(false));
        let live_stores = Arc::new(EngineStores::new(
            config,
            base.clone(),
            space,
            fingerprint_id,
            store_clock,
            store_cancel.clone(),
        ));
        // Capture's classifier resolves the effective block; recall shares its engines.
        let effective_emotion = crate::config::effective_config(&raw).map_or_else(
            |_| raw["emotion"].clone(),
            |config| config["emotion"].clone(),
        );
        let mood =
            engine_recall::RecallMood::new(host.clone(), raw["emotion"].clone(), effective_emotion);
        let neo_enabled = crate::config::effective_config(&raw).map_or_else(
            |_| raw["neo"]["enabled"] != false,
            |config| config["neo"]["enabled"] != false,
        );
        let drain = base
            .as_deref()
            .filter(|_| neo_enabled)
            .map(|base| engine_jobs::NeoDrain {
                root: engine_warm::neo_root(&raw["neo"], base),
                policy: engine_capture::workspace_capture_policy(base),
                mood: mood.pool(),
                host: host.clone(),
                provider: embedding.pipeline_embedder(),
                impact: raw["neo"]["embeddingDrain"]["impact"]
                    .as_str()
                    .map(str::to_owned),
            });
        let operations = Arc::new(crate::ops::context::OperationContext::new(host.clone()));
        let critical_expiry =
            base.as_deref()
                .map(|base| crate::jobs::critical_expiry::CriticalExpiry {
                    operations: operations.clone(),
                    stores: live_stores.clone(),
                    policy: engine_capture::workspace_capture_policy(base),
                });
        let jobs = Arc::new(
            engine_jobs::ProcessJobs::new(base.clone(), host.clone(), neo_enabled)
                .with_drain(drain)
                .with_critical_expiry(critical_expiry),
        );
        let reporter = base.clone().map(|base| {
            crate::ops::status::StatusReporter::for_host(
                Arc::new(ProcessStatusSources {
                    embedding: embedding.clone(),
                    jobs: jobs.clone(),
                    stores: live_stores.clone(),
                }),
                base,
                status.contract,
                host.clone(),
            )
            .with_fresh_base_current()
        });
        let slot_host = host;
        let embed_budget = engine_memory::EmbedBudget::new(&raw, store_cancel.clone());
        let mut proposal_sharing = None;
        let memory = base.map(|base| {
            let provider = embedding.pipeline_embedder();
            let reader = Arc::new(MemoryReader::new(
                operations.clone(),
                live_stores.clone(),
                provider.clone(),
                base.clone(),
            ));
            // Share embeds under the mutation gate: bounded by shutdown and budget (RE-D165).
            let budgeted =
                engine_memory::BudgetedEmbedder::wrap(provider.clone(), embed_budget.clone());
            let sharing = || ShareServices {
                reader: reader.clone(),
                stores: live_stores.clone(),
                providers: vec![budgeted.clone()],
            };
            proposal_sharing = Some(sharing());
            let writer = MemoryWriter::new(operations.clone(), live_stores.clone(), base.clone())
                .with_sharing(sharing());
            let importer = Importer::new(
                operations.clone(),
                live_stores.clone(),
                provider.clone(),
                Arc::new(ImportLedger::new(&base)),
                base.clone(),
                engine_memory::import_encoding(&raw),
            );
            let rebinder = Rebinder::new(operations.clone(), live_stores.clone(), base.clone());
            let native = Arc::new(engine_memory::NativeSlot::new(engine_memory::SlotInputs {
                operations: operations.clone(),
                stores: live_stores.clone(),
                neo_root: engine_warm::neo_root(&raw["neo"], &base),
                neo_enabled,
                base,
                embedder: provider,
                embed_budget: embed_budget.clone(),
                host: slot_host.clone(),
                raw: raw.clone(),
                shutdown: store_cancel.clone(),
                closed: closed.clone(),
            }));
            ProcessMemory {
                reader,
                writer,
                importer,
                rebinder,
                native,
            }
        });
        let slot = memory.as_ref().map(|memory| memory.native.clone());
        let proposals =
            engine_memory::ProposalsPort::new(slot.clone(), proposal_sharing, closed.clone());
        let curation = engine_memory::CurationPort::new(slot, closed.clone());
        // RE-D167: an A1 flag is set only where its surface is served. `recallStats` means "a
        // base is configured, so the stats reader and the recall counting hook are wired" (both
        // hang on that base, so it equals `memoryLink`). If the counting sidecar fails at run
        // time, recall continues without counting (`engine_recall::run`) and the flag stays
        // true; `stats` then answers `storage`. `memoryCuration` needs the curation slot.
        // `knowledgePromotion` stays off in RX: it also covers the `knowledge-update` job, which
        // answers `job-authority-unbound` until RY-A binds its authority (F13). KNOWN-GAP → RY-A.
        let recall_stats = memory.is_some() && live_stores.configured_base().is_some();
        let capabilities = decode(json!({
            "memoryLink":memory_link,
            "recallStats":recall_stats,"knowledgePromotion":false,
            "memoryCuration":curation.served()
        }))?;
        Ok(Self {
            embedding,
            stores,
            store_cancel,
            live_stores,
            memory,
            proposals,
            curation,
            embed_budget,
            mood,
            capture: engine_capture::ProcessCapture::default(),
            jobs,
            operations,
            checkpoints,
            system_supplement: crate::recall::system_supplement::build(
                raw["neo"]["enabled"] != false,
            )
            .into_iter()
            .map(str::to_owned)
            .collect(),
            capabilities,
            status,
            reporter,
            unavailable: Unavailable {
                closed: closed.clone(),
            },
            closed,
            channels: Channels::default(),
            subscribers: Mutex::new(Vec::new()),
            model_degradation: [
                degradation("model-failed", "embedding")?,
                degradation("models-warming", "embedding")?,
                degradation("model-failed", "reranker")?,
                degradation("models-warming", "reranker")?,
            ],
            closed_degradation: degradation("closed", "engine")?,
        })
    }

    /// Invalidate the outbound policy cache after a reverse-host policy notification.
    pub fn invalidate_egress(&self) {
        self.embedding.invalidate_egress();
    }

    /// Test budgets: the embedding budget, the gate wait and a hook inside every budgeted
    /// embedding call (RE-D165).
    #[cfg(test)]
    pub(crate) fn set_memory_budgets(
        &self,
        embed: Duration,
        gate: Duration,
        hook: Option<engine_memory::EmbedHook>,
    ) {
        self.embed_budget.set(embed);
        self.embed_budget.set_hook(hook);
        self.operations.set_mutation_wait(gate);
    }

    /// RE-D170: reapply's view of this process — the same namespace routes (active generation
    /// included) after S5 recovery, the engine-wide mutation gate and the engine's close.
    pub fn snapshot_routes(&self) -> Arc<dyn super::snapshot::ReapplyRoutes> {
        Arc::new(SnapshotRoutes {
            stores: self.live_stores.clone(),
            operations: self.operations.clone(),
            closed: self.closed.clone(),
        })
    }

    /// Deterministic test receipts for an explicitly authorized offline clock.
    #[must_use]
    pub fn with_fixture_tombstone_ids(mut self) -> Self {
        if let Some(memory) = &mut self.memory {
            // Node's fixture allocator consumes the first UUID in archive staging.
            let sequence = std::sync::atomic::AtomicU64::new(2);
            memory.writer.set_tombstone_id_source(move || {
                let next = u128::from(sequence.fetch_add(1, Ordering::Relaxed));
                uuid::Uuid::from_u128(0xe100_0000_0000_4000_8000_0000_0000_0000 | next)
            });
        }
        self
    }
}

struct SnapshotRoutes {
    stores: Arc<EngineStores>,
    operations: Arc<crate::ops::context::OperationContext>,
    closed: Arc<AtomicBool>,
}
impl super::snapshot::ReapplyRoutes for SnapshotRoutes {
    fn reapply_target(
        &self,
    ) -> Result<Option<crate::ops::tombstone_reapply::NamespaceReapplyTarget>, EngineError> {
        Ok(self.stores.existing_pools()?.map(|pools| {
            crate::ops::tombstone_reapply::NamespaceReapplyTarget::new(
                pools,
                self.operations.clone(),
            )
        }))
    }
    fn stopped(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
}

/// The host-selected embedding defaults RE-03 applies before its pure normalizer: an absent
/// provider is local unless remote fields are present, and a local cache defaults below the
/// engine state. Process maintenance derives the same active fingerprint from it (RE-D166).
pub(super) fn host_normalized_embedding(
    raw: &Value,
    host: &dyn HostServices,
) -> Result<embedding::normalize::NormalizedEmbeddingConfig, EngineError> {
    let mut block = raw
        .get("embedding")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let object = block.as_object_mut().ok_or_else(composition_invalid)?;
    // Mirror RE-03's host-selected defaults before invoking its pure normalizer.
    if !object.contains_key("provider") {
        if ["baseUrl", "apiKey", "apiKeyRef", "apiKeyEnv"]
            .iter()
            .any(|key| object.get(*key).is_some_and(|value| !value.is_null()))
        {
            return Err(EngineError::Invalid {
                field: "embedding.provider".into(),
                message: "remote embeddings require an explicit provider".into(),
            });
        }
        object.insert("provider".into(), json!("local-transformers"));
    }
    if object.get("provider").and_then(Value::as_str) == Some("local-transformers") {
        let cache_dir = object
            .get("cacheDir")
            .cloned()
            .unwrap_or_else(|| json!(host.state_dir().join("models")));
        let local = object
            .entry("local")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(composition_invalid)?;
        local.entry("cacheDir").or_insert(cache_dir);
    }
    normalize_embedding_config(&block).map_err(|error| EngineError::Invalid {
        field: error.path,
        message: error.message,
    })
}

fn composition_invalid() -> EngineError {
    EngineError::Invalid {
        field: "engine.composition".into(),
        message: "invalid process composition".into(),
    }
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, EngineError> {
    serde_json::from_value(value).map_err(|_| composition_invalid())
}

/// Status priority, first match wins (RE-D159, schema after composition-invalid per RE-D160).
/// The declaration order is the documented order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum StatusRank {
    Closed,
    CompositionInvalid,
    SchemaUnsupported,
    EmbeddingFailed,
    CaptureNotServed,
    EmbeddingWarming,
    RerankerFailed,
    RerankerLoading,
    CaptureDeferred,
    CompositionPending,
}

fn degradation(reason: &str, capability: &str) -> Result<Degraded, EngineError> {
    decode(json!({"reason": reason, "capability": capability}))
}

impl Engine for ProcessEngine {
    fn contract(&self) -> ContractVersion {
        self.status.contract
    }
    fn capabilities(&self) -> &Capabilities {
        &self.capabilities
    }
    fn open(&self, agent: &AgentId) -> Result<AgentStoreHandle, EngineError> {
        let handle = self.live_stores.open(agent)?;
        // Opening recovers pending capture work (admissions, WAL, Neo plans) before new turns.
        // A failed recovery does not fail the open: status reports it and capture retries it.
        if let Some(base) = self.live_stores.configured_base() {
            let _ = engine_capture::ProcessCapture::open(self, base);
        }
        Ok(handle)
    }
    fn close(&self, budget: Option<Duration>) -> Result<(), EngineError> {
        let started = std::time::Instant::now();
        self.closed.store(true, Ordering::Release);
        // Stop store opening first: a capture composition still in S5 recovery aborts too.
        self.store_cancel.cancel();
        // Job session starts (recovery, migration) observe the same shutdown; nothing waits.
        self.jobs.close();
        // Admitted capture work settles within the budget before stores are released (RE-D144).
        let drained = self.capture.close(budget);
        self.embedding.close();
        // Memory operations: their tokens end with `store_cancel` above and gate waiters are
        // refused; the drain waits at most what is left of the close budget (RE-D165). One
        // still inside a provider call finishes on its own thread and cannot write any more.
        let left = budget
            .unwrap_or(Duration::from_secs(30))
            .saturating_sub(started.elapsed());
        let memory_drained = self.operations.close_within(left);
        let stores_closed = self.live_stores.close();
        self.subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        stores_closed?;
        // Capture work still settling past the budget keeps its own writer handles, and a
        // memory operation still inside a step that cannot be interrupted keeps its request
        // worker (it writes nothing more: `assert_open` precedes every write step): report it.
        if drained && memory_drained {
            Ok(())
        } else {
            Err(EngineError::NotAvailable {
                reason: "capture-drain-incomplete".into(),
            })
        }
    }
    fn status(&self) -> EngineStatus {
        // With a store base: the pin's reporter (journal within 50 ms, job health, schema
        // marker, models), then the process's own states (RE-D157). Without one: the frozen
        // `composition-pending` status. Either way the first match of the RE-D159 priority
        // wins; the pin's model order (`types/engine.d.ts`, `status-reporter.js`) is kept as a
        // subsequence. Model degradation and deferred capture work keep ready, as at the pin.
        let closed = self.closed.load(Ordering::Acquire);
        // After close no source is asked: no host callback, no ledger read (RE-D160).
        let reporter = self.reporter.as_ref().filter(|_| !closed);
        let (mut status, models) = if let Some(reporter) = reporter {
            let mut status = reporter.status();
            let models = status.degraded.take();
            (status, models)
        } else {
            let mut status = self.status.clone();
            status.models = self.embedding.status();
            status.agents = (self.live_stores.count() as u64).into();
            let index = match (&status.models.embedder.state, &status.models.reranker.state) {
                (ModelState::Failed, _) => Some(0),
                (ModelState::Loading, _) => Some(1),
                (_, ModelState::Failed) => Some(2),
                (_, ModelState::Loading) => Some(3),
                _ => None,
            };
            let models = index.map(|index| self.model_degradation[index].clone());
            (status, models)
        };
        // RE-D159 priority with the store schema after composition-invalid (RE-D160):
        // closed > composition invalid > schema unsupported > embedding failed > capture not
        // served > embedding warming > reranker failed > reranker loading > capture deferred
        // > composition-pending.
        let mut ranked: Vec<(StatusRank, Degraded)> = Vec::new();
        let mut served = !closed;
        if closed {
            ranked.push((StatusRank::Closed, self.closed_degradation.clone()));
        } else {
            if let Some((degraded, capture)) = self.capture.degradation() {
                let rank = match capture {
                    engine_capture::Served::Invalid => StatusRank::CompositionInvalid,
                    engine_capture::Served::No => StatusRank::CaptureNotServed,
                    engine_capture::Served::Deferred => StatusRank::CaptureDeferred,
                };
                served &= capture == engine_capture::Served::Deferred;
                ranked.push((rank, degraded));
            }
            if reporter.is_some() {
                // Only an unusable jobs root; one agent's session start affects only that agent.
                if let Some(degraded) = self.jobs.degradation() {
                    served = false;
                    ranked.push((StatusRank::CompositionInvalid, degraded));
                }
                if let Some(degraded) = self.schema_degradation() {
                    served = false;
                    ranked.push((StatusRank::SchemaUnsupported, degraded));
                }
            }
        }
        if let Some(degraded) = models {
            let rank = match (degraded.reason.as_str(), degraded.capability.as_str()) {
                ("model-failed", "embedding") => StatusRank::EmbeddingFailed,
                ("models-warming", "embedding") => StatusRank::EmbeddingWarming,
                ("model-failed", _) => StatusRank::RerankerFailed,
                _ => StatusRank::RerankerLoading,
            };
            ranked.push((rank, degraded));
        }
        // The frozen default without a store base (`composition-pending`).
        if let Some(degraded) = status.degraded.take() {
            ranked.push((StatusRank::CompositionPending, degraded));
        }
        status.degraded = ranked
            .into_iter()
            .min_by_key(|(rank, _)| *rank)
            .map(|(_, degraded)| degraded);
        if self.reporter.is_some() && !served {
            status.ready = false;
        }
        status
    }
    fn system_supplement(&self) -> Vec<String> {
        self.system_supplement.clone()
    }
    fn recall(
        &self,
        query: RecallQuery,
        options: RecallOptions,
        cancel: &Cancel,
    ) -> Result<RecallResult, EngineError> {
        if !self.closed.load(Ordering::Acquire) {
            if let Some(base) = self.live_stores.configured_base() {
                return if query.warm_only == Some(true) {
                    engine_warm::run(self, base, &query, &options, cancel)
                } else {
                    engine_recall::run(self, base, &query, &options, cancel)
                };
            }
        }
        cancel.check()?;
        Err(self.unavailable.error())
    }
    fn capture(
        &self,
        turn: TurnRecord,
        options: CaptureOptions,
    ) -> Result<CaptureHandle, EngineError> {
        self.capture_host_turn(turn, options, None)
    }
    fn checkpoint(
        &self,
        agent: &AgentId,
        reason: CheckpointReason,
    ) -> Result<CheckpointResult, EngineError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(self.unavailable.error());
        }
        let name = match reason {
            CheckpointReason::Compaction => "compaction",
            CheckpointReason::SessionEnd => "session-end",
            CheckpointReason::Shutdown => "shutdown",
            CheckpointReason::Manual => "manual",
        };
        // The pin keeps this map for the engine lifetime. A boundary is not an engine close,
        // a model reset, a capture flush, or a new on-disk checkpoint format.
        let result = self
            .checkpoints
            .checkpoint(agent.as_str(), name, None, "")?;
        Ok(CheckpointResult {
            agent_id: agent.clone(),
            reason,
            digest: result.digest,
            written: result.written,
        })
    }
    fn jobs(&self) -> &dyn JobRegistry {
        self.jobs.as_ref()
    }
    fn embedding(&self) -> &dyn EmbeddingService {
        self.embedding.as_ref()
    }
    fn models(&self) -> &dyn ModelsService {
        self.embedding.as_ref()
    }
    fn memory(&self) -> &dyn MemoryOps {
        self
    }
    fn admin(&self) -> &dyn AdminOps {
        &self.unavailable
    }
    fn stores(&self) -> &dyn StoreOps {
        &self.stores
    }
    fn channels(&self) -> &dyn ChannelRegistry {
        &self.channels
    }
    fn events(&self) -> EventReceiver {
        let (sender, receiver) = mpsc::channel();
        let mut subscribers = self
            .subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !self.closed.load(Ordering::Acquire) {
            subscribers.push(sender);
        }
        receiver
    }
}

struct Unavailable {
    closed: Arc<AtomicBool>,
}
impl Unavailable {
    fn error(&self) -> EngineError {
        EngineError::NotAvailable {
            reason: if self.closed.load(Ordering::Acquire) {
                "closed"
            } else {
                "composition-pending"
            }
            .into(),
        }
    }
}

// All incomplete contract ports share the same typed failure boundary. No method
// accepts a write, fabricates a job run, or returns an empty successful memory read.
macro_rules! unavailable_methods {
    ($(fn $name:ident($($arg:ident: $ty:ty),* $(,)?) -> $result:ty;)*) => {$ (
        fn $name(&self, $($arg: $ty),*) -> Result<$result, EngineError> { Err(self.error()) }
    )*};
}

impl ProcessEngine {
    fn error(&self) -> EngineError {
        self.unavailable.error()
    }

    /// `schema-unsupported/store` when the base marker is one every store open refuses
    /// (unsupported version, malformed, untrusted or unreadable). A missing marker is legacy 0,
    /// as at the pin. Read-only, through the same reader the store open uses (RE-D160).
    fn schema_degradation(&self) -> Option<Degraded> {
        let base = self.live_stores.configured_base()?;
        crate::store::schema_version::read_base(base).err()?;
        degradation("schema-unsupported", "store").ok()
    }

    fn memory_ports(&self) -> Result<&ProcessMemory, EngineError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(self.error());
        }
        self.memory.as_ref().ok_or_else(|| self.error())
    }
}

impl MemoryOps for ProcessEngine {
    fn list(
        &self,
        query: MemoryListQuery,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryListResult, EngineError> {
        self.memory_ports()?.reader.list(&query, principal, agent)
    }

    fn show(
        &self,
        id: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryCard, EngineError> {
        self.memory_ports()?.reader.show(id, principal, agent)
    }

    fn state(
        &self,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryState, EngineError> {
        self.memory_ports()?.reader.state(principal, agent)
    }

    fn forget(
        &self,
        id: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryForgetResult, EngineError> {
        self.memory_ports()?.writer.forget(id, principal, agent)
    }

    fn link(
        &self,
        id: &str,
        request: MemoryLinkRequest,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryLinkResult, EngineError> {
        self.memory_ports()?
            .reader
            .link(id, &request, principal, agent)
    }

    fn import(
        &self,
        request: MemoryImportRequest,
        cancel: &Cancel,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryImportResult, EngineError> {
        self.memory_ports()?
            .importer
            .import(&request, principal, agent, cancel)
    }

    fn rebind(
        &self,
        request: MemoryRebindRequest,
        cancel: &Cancel,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryRebindResult, EngineError> {
        self.memory_ports()?
            .rebinder
            .rebind(&request, principal, agent, cancel)
    }

    fn unbind(
        &self,
        request: MemoryUnbindRequest,
        cancel: &Cancel,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryUnbindResult, EngineError> {
        self.memory_ports()?
            .rebinder
            .unbind(&request, principal, agent, cancel)
    }

    fn correct(
        &self,
        id: &str,
        text: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryCorrectResult, EngineError> {
        self.memory_ports()?
            .native
            .correct(id, text, principal, agent)
    }

    fn share(
        &self,
        id: &str,
        target: MemoryShareTarget,
        options: ShareOptions,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryShareResult, EngineError> {
        self.memory_ports()?
            .writer
            .share(id, target, principal, agent, &options)
    }

    fn propose(
        &self,
        id: &str,
        text: &str,
        options: ProposeOptions,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryProposeResult, EngineError> {
        self.memory_ports()?;
        self.proposals.propose(id, text, &options, principal, agent)
    }

    fn unimport(
        &self,
        request: MemoryUnimportRequest,
        cancel: &Cancel,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryUnimportResult, EngineError> {
        self.memory_ports()?
            .native
            .unimport(&request, cancel, principal, agent)
    }

    fn stats(
        &self,
        ids: Option<&[String]>,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryStatsResult, EngineError> {
        self.memory_ports()?.reader.stats(ids, principal, agent)
    }

    /// Foreground publication only: no `knowledge-update` job is planned or started (F13).
    fn promote(
        &self,
        request: MemoryPromoteRequest,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryPromotionResult, EngineError> {
        self.memory_ports()?
            .native
            .promote(&request, principal, agent)
    }

    fn proposals(&self) -> &dyn MemoryProposalsOps {
        &self.proposals
    }
    fn curation(&self) -> &dyn MemoryCurationOps {
        &self.curation
    }
}
// RE-D165: `engine.admin.share` and `engine.admin.forget` stay unavailable (fail closed): no
// native implementation and no productive caller in the Harness. KNOWN-GAP → RY.
impl AdminOps for Unavailable {
    unavailable_methods! {
        fn share(_id: &str, _target: MemoryShareTarget, _options: ShareOptions, _principal: &Principal, _agent: &AgentContext) -> MemoryShareResult;
        fn forget(_id: &str, _principal: &Principal, _agent: &AgentContext) -> MemoryForgetResult;
        fn migrate(_from: SchemaVersion, _to: SchemaVersion, _principal: &Principal, _agent: &AgentContext) -> MigrationResult;
    }
    fn reembedding(&self) -> &dyn ReembeddingOps {
        self
    }
    fn workspace_policy(&self) -> &dyn WorkspacePolicyOps {
        self
    }
    fn obsidian(&self) -> &dyn ObsidianOps {
        self
    }
}
impl ReembeddingOps for Unavailable {
    unavailable_methods! {
        fn plan(_principal: &Principal, _agent: &AgentContext) -> Value;
        fn apply(_principal: &Principal, _agent: &AgentContext) -> Value;
        fn resume(_principal: &Principal, _agent: &AgentContext) -> Value;
        fn validate(_principal: &Principal, _agent: &AgentContext) -> Value;
        fn rollback(_principal: &Principal, _agent: &AgentContext) -> Value;
        fn status(_principal: &Principal, _agent: &AgentContext) -> Value;
        fn switch(_principal: &Principal, _agent: &AgentContext) -> Value;
    }
}
impl WorkspacePolicyOps for Unavailable {
    unavailable_methods! {
        fn get(_principal: &Principal, _agent: &AgentContext) -> Value;
        fn list(_principal: &Principal, _agent: &AgentContext) -> Value;
        fn set(_patch: Value, _principal: &Principal, _agent: &AgentContext) -> Value;
    }
}
impl ObsidianOps for Unavailable {
    unavailable_methods! {
        fn detect(_options: ObsidianDetectOptions, _principal: &Principal, _agent: &AgentContext) -> ObsidianDetectResult;
        fn prepare(_path: &str, _principal: &Principal, _agent: &AgentContext) -> ObsidianPrepareResult;
        fn confirm(_nonce: &str, _principal: &Principal, _agent: &AgentContext) -> ObsidianConfirmResult;
    }
}
impl StoreOps for Unavailable {
    unavailable_methods! { fn adopt(_request: StoreAdoptRequest) -> AdoptReport; }
}
/// Read-only status sources over the process's own services (RE-D157). Nothing here opens a
/// store, warms a model or creates a file.
struct ProcessStatusSources {
    embedding: Arc<Service>,
    jobs: Arc<engine_jobs::ProcessJobs>,
    stores: Arc<EngineStores>,
}
impl crate::ops::status::StatusSources for ProcessStatusSources {
    fn jobs(&self) -> Result<JobsHealth, EngineError> {
        Ok(self.jobs.health())
    }
    fn models(&self) -> Result<ModelsStatus, EngineError> {
        Ok(self.embedding.status())
    }
    fn identity(&self) -> Result<Option<EmbeddingIdentity>, EngineError> {
        Ok(self.embedding.identities().into_iter().next())
    }
    fn shared(&self) -> Result<SharedMemorySupport, EngineError> {
        // Share and propose are served (RE-D165). The platform's mode as at the pin
        // (`defaultSharedMemoryMode`: descriptor aliases on Linux, verified paths on macOS
        // and Windows), reported as supported only once a share decision found the pools
        // supported; before the first one, or when it did not, the cautious `unavailable`.
        // No lock, store, pool or host call is made here.
        let mode = if cfg!(target_os = "linux") {
            "fd-capability"
        } else if cfg!(any(target_os = "macos", windows)) {
            "verified-path"
        } else {
            return decode(json!({"supported":false,"mode":"unavailable","reason":"platform"}));
        };
        match self.stores.shared_support() {
            Some(true) => decode(json!({"supported":true,"mode":mode})),
            Some(false) => {
                decode(json!({"supported":false,"mode":"unavailable","reason":"unsafe-root"}))
            }
            None => decode(json!({"supported":false,"mode":"unavailable"})),
        }
    }
    fn opened_agents(&self) -> usize {
        self.stores.count()
    }
}

#[derive(Default)]
struct Channels(Mutex<BTreeMap<String, ChannelRef>>);
impl ChannelRegistry for Channels {
    fn register(&self, name: ChannelRef) -> String {
        let canonical = name.to_string();
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(canonical.clone(), name);
        canonical
    }
    fn has(&self, name: ChannelRef) -> bool {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(&name.to_string())
    }
    fn list(&self) -> Vec<ChannelRef> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect()
    }
}

/// Scripted memory behavior for tests that inject an engine into the RPC server.
/// This module is excluded from the normal process binary and never selected by a seam.
#[cfg(any(test, feature = "testkit"))]
pub mod testkit {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// A deterministic fixture callback that deliberately ignores cancellation.
    #[derive(Default)]
    pub struct FixtureGate {
        state: Mutex<(bool, bool)>,
        changed: std::sync::Condvar,
    }
    impl FixtureGate {
        pub(crate) fn block(&self) {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.0 = true;
            self.changed.notify_all();
            while !state.1 {
                state = self
                    .changed
                    .wait(state)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
        }
        /// Wait until the callback actually begins; tests do not guess a scheduling delay.
        pub fn wait_entered(&self, timeout: Duration) -> bool {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let (state, _) = self
                .changed
                .wait_timeout_while(state, timeout, |state| !state.0)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.0
        }
        /// Release a blocked fixture callback after its server has returned.
        pub fn release(&self) {
            self.state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .1 = true;
            self.changed.notify_all();
        }
    }

    /// A transport fixture returning only the recall/capture values supplied by its test.
    pub struct FixtureEngine {
        inner: ProcessEngine,
        host: Arc<dyn HostServices>,
        recall: RecallResult,
        capture: CaptureResult,
        captures: AtomicUsize,
        pending: AtomicBool,
        held_captures: Mutex<Vec<mpsc::Sender<CaptureResult>>>,
        recall_gate: Mutex<Option<Arc<FixtureGate>>>,
        close_gate: Mutex<Option<Arc<FixtureGate>>>,
    }

    impl FixtureEngine {
        /// Compose a flat embedder and explicitly scripted memory responses.
        pub fn new(
            host: Arc<dyn HostServices>,
            recall: RecallResult,
            capture: CaptureResult,
        ) -> Result<Self, EngineError> {
            Ok(Self {
                inner: ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder))?,
                host,
                recall,
                capture,
                captures: AtomicUsize::new(0),
                pending: AtomicBool::new(false),
                held_captures: Mutex::new(Vec::new()),
                recall_gate: Mutex::new(None),
                close_gate: Mutex::new(None),
            })
        }

        /// Keep capture receipts pending until the engine closes.
        pub fn hold_captures(&self) {
            self.pending.store(true, Ordering::Release);
        }

        /// Install a recall callback that a test can release explicitly.
        pub fn block_recall(&self) -> Arc<FixtureGate> {
            let gate = Arc::new(FixtureGate::default());
            *self
                .recall_gate
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(gate.clone());
            gate
        }

        /// Install a close callback that a test can release explicitly.
        pub fn block_close(&self) -> Arc<FixtureGate> {
            let gate = Arc::new(FixtureGate::default());
            *self
                .close_gate
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(gate.clone());
            gate
        }
    }

    impl Engine for FixtureEngine {
        fn contract(&self) -> ContractVersion {
            self.inner.contract()
        }
        fn capabilities(&self) -> &Capabilities {
            self.inner.capabilities()
        }
        fn open(&self, agent: &AgentId) -> Result<AgentStoreHandle, EngineError> {
            if self.inner.closed.load(Ordering::Acquire) {
                return Err(self.inner.unavailable.error());
            }
            Ok(AgentStoreHandle {
                agent_id: agent.clone(),
                close: Box::new(|| Ok(())),
            })
        }
        fn close(&self, budget: Option<Duration>) -> Result<(), EngineError> {
            let gate = self
                .close_gate
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            if let Some(gate) = gate {
                gate.block();
            }
            self.held_captures
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clear();
            self.inner.close(budget)
        }
        fn status(&self) -> EngineStatus {
            let mut status = self.inner.status();
            status.ready = !self.inner.closed.load(Ordering::Acquire);
            status
        }
        fn system_supplement(&self) -> Vec<String> {
            self.inner.system_supplement()
        }
        fn recall(
            &self,
            _query: RecallQuery,
            _options: RecallOptions,
            cancel: &Cancel,
        ) -> Result<RecallResult, EngineError> {
            cancel.check()?;
            let gate = self
                .recall_gate
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            if let Some(gate) = gate {
                gate.block();
            }
            if self.inner.closed.load(Ordering::Acquire) {
                return Err(self.inner.unavailable.error());
            }
            Ok(self.recall.clone())
        }
        fn capture(
            &self,
            turn: TurnRecord,
            _options: CaptureOptions,
        ) -> Result<CaptureHandle, EngineError> {
            turn.cancel.check()?;
            if self.inner.closed.load(Ordering::Acquire) {
                return Err(self.inner.unavailable.error());
            }
            let (sender, done) = mpsc::channel();
            // Pending capture tests retain the sender; the default fixture completes immediately.
            if self.pending.load(Ordering::Acquire) {
                self.held_captures
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(sender);
            } else {
                let _ = sender.send(self.capture.clone());
            }
            let id = self.captures.fetch_add(1, Ordering::Relaxed);
            Ok(CaptureHandle {
                id: format!("fixture-capture-{id}"),
                accepted_at: self.host.now_ms(),
                done,
                abort: Box::new(|_| {}),
            })
        }
        fn checkpoint(
            &self,
            agent: &AgentId,
            reason: CheckpointReason,
        ) -> Result<CheckpointResult, EngineError> {
            self.inner.checkpoint(agent, reason)
        }
        fn jobs(&self) -> &dyn JobRegistry {
            self.inner.jobs()
        }
        fn embedding(&self) -> &dyn EmbeddingService {
            self.inner.embedding()
        }
        fn models(&self) -> &dyn ModelsService {
            self.inner.models()
        }
        fn memory(&self) -> &dyn MemoryOps {
            self.inner.memory()
        }
        fn admin(&self) -> &dyn AdminOps {
            self.inner.admin()
        }
        fn stores(&self) -> &dyn StoreOps {
            self.inner.stores()
        }
        fn channels(&self) -> &dyn ChannelRegistry {
            self.inner.channels()
        }
        fn events(&self) -> EventReceiver {
            self.inner.events()
        }
    }
}

#[cfg(any(test, feature = "testkit"))]
pub use testkit::FixtureEngine;

#[cfg(test)]
mod tests {
    // Tests fail immediately on invalid fixtures or failed cleanup; no unchecked values reach production.
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use crate::contract::testing::FakeHost;

    fn host(state_dir: std::path::PathBuf) -> Arc<FakeHost> {
        Arc::new(FakeHost::new(
            state_dir,
            serde_json::from_value(json!({})).unwrap(),
        ))
    }
    fn principal() -> Principal {
        serde_json::from_value(json!({"agentId":"fixture-agent","workspace":"workspace:v1:fixture","channel":"cli","accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"proved"})).unwrap()
    }
    fn agent() -> AgentContext {
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap()
    }
    fn query() -> RecallQuery {
        serde_json::from_value(
            json!({"query":"fixture text","principal":principal(),"agent":agent()}),
        )
        .unwrap()
    }
    fn turn() -> TurnRecord {
        serde_json::from_value(json!({"agentId":"fixture-agent","principal":principal(),"agent":agent(),"messages":[],"incognito":false})).unwrap()
    }
    fn recall_options() -> RecallOptions {
        serde_json::from_value(json!({})).unwrap()
    }
    fn capture_options() -> CaptureOptions {
        serde_json::from_value(json!({})).unwrap()
    }
    fn not_available<T>(result: Result<T, EngineError>, expected: &str) {
        assert!(matches!(result, Err(EngineError::NotAvailable {reason}) if reason == expected));
    }

    #[test]
    fn production_composition_never_fabricates_capture_or_recall_even_with_flat_seam() {
        let scratch =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let state_dir = scratch.path().join("not-created");
        let engine = ProcessEngine::new(host(state_dir.clone()), Some(Seam::FlatEmbedder)).unwrap();
        not_available(
            engine.recall(query(), recall_options(), &Cancel::never()),
            "composition-pending",
        );
        not_available(
            engine.capture(turn(), capture_options()),
            "composition-pending",
        );
        let agent_id = serde_json::from_value(json!("fixture-agent")).unwrap();
        assert!(
            matches!(engine.open(&agent_id), Err(EngineError::Invalid { field, .. }) if field == "baseDbPath")
        );
        not_available(
            engine.memory().show("fixture-id", &principal(), &agent()),
            "composition-pending",
        );
        assert!(!engine.status().ready);
        assert!(!engine.capabilities().memory_link);
        // RE-D167: without a store base no A1 surface is served, so every A1 flag is off.
        assert!(!engine.capabilities().recall_stats);
        assert!(!engine.capabilities().memory_curation);
        assert!(!engine.capabilities().knowledge_promotion);
        assert_eq!(
            serde_json::to_value(engine.status().contract).unwrap(),
            "1.18.0"
        );
        assert!(!state_dir.exists());
    }

    #[test]
    fn production_model_composition_is_lazy_and_does_not_create_files() {
        let scratch =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let state_dir = scratch.path().join("not-created");
        let engine = ProcessEngine::new(host(state_dir.clone()), None).unwrap();
        let identities = engine.embedding().identities();
        assert_eq!(identities.len(), 1);
        // The facade must publish the actual RE-03 provider's complete space,
        // including its pinned artifact and revision metadata.
        let expected_host = host(state_dir.clone());
        let expected_provider =
            embedding::build_embedding_owned(&expected_host.config(), expected_host).unwrap();
        assert_eq!(
            serde_json::to_value(identities[0].space.as_ref()).unwrap(),
            serde_json::to_value(expected_provider.identity()).unwrap()
        );
        assert_eq!(engine.models().status().embedder.state, ModelState::Loading);
        assert!(!state_dir.exists());
    }

    #[test]
    fn embedding_and_models_use_the_real_re03_facade() {
        let scratch =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let host = host(scratch.path().join("not-created"));
        host.set_now_ms(1234);
        let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
        let identity = engine.embedding().identities().remove(0);
        let vectors = engine
            .embedding()
            .embed(
                &["fixture text".into()],
                EmbedKind::Query,
                &identity,
                &Cancel::never(),
            )
            .unwrap();
        assert_eq!(vectors.len(), 1);
        assert_eq!(
            vectors[0].len(),
            identity.dimensions.as_u64().unwrap() as usize
        );
        assert_eq!(vectors[0][0], 1.0);
        let models = engine.models().warm(&Cancel::never(), false).unwrap();
        assert_eq!(models.embedder.state, ModelState::Ready);
        assert_eq!(models.reranker.state, ModelState::Disabled);
        assert_eq!(models.embedder.checked_at.unwrap().as_i64(), Some(1234));
        // Warming providers cannot make the incomplete recall pipeline ready.
        assert!(!engine.status().ready);
        assert_eq!(
            engine.status().degraded.unwrap().reason,
            "composition-pending"
        );
    }

    #[test]
    fn cancellation_and_idempotent_close_preserve_typed_failures() {
        let scratch =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let engine =
            ProcessEngine::new(host(scratch.path().to_path_buf()), Some(Seam::FlatEmbedder))
                .unwrap();
        let cancelled = Cancel::never();
        cancelled.cancel();
        assert!(matches!(
            engine.recall(query(), recall_options(), &cancelled),
            Err(EngineError::Cancelled(_))
        ));
        let events = engine.events();
        assert!(matches!(events.try_recv(), Err(mpsc::TryRecvError::Empty)));
        engine.close(None).unwrap();
        engine.close(Some(Duration::ZERO)).unwrap();
        not_available(engine.capture(turn(), capture_options()), "closed");
        assert_eq!(engine.status().degraded.unwrap().reason, "closed");
        assert!(matches!(
            events.try_recv(),
            Err(mpsc::TryRecvError::Disconnected)
        ));
        assert!(matches!(
            engine.events().try_recv(),
            Err(mpsc::TryRecvError::Disconnected)
        ));
        not_available(engine.embedding().serve(), "closed");
    }

    #[test]
    fn fixture_engine_uses_only_explicit_scripted_results() {
        let scratch =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let host = host(scratch.path().to_path_buf());
        host.set_now_ms(42);
        let recall: RecallResult = serde_json::from_value(json!({"blocks":[],"capChars":null,"degraded":null,"timing":{"phases":null,"totalMs":7},"deferrals":[]})).unwrap();
        let capture: CaptureResult =
            serde_json::from_value(json!({"stored":2,"skipped":1})).unwrap();
        let engine = FixtureEngine::new(host, recall.clone(), capture.clone()).unwrap();
        let actual = engine
            .recall(query(), recall_options(), &Cancel::never())
            .unwrap();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(recall).unwrap()
        );
        let handle = engine.capture(turn(), capture_options()).unwrap();
        assert_eq!(handle.id, "fixture-capture-0");
        assert_eq!(handle.accepted_at, 42);
        assert_eq!(
            serde_json::to_value(handle.done.recv().unwrap()).unwrap(),
            serde_json::to_value(capture).unwrap()
        );
    }
}

#[cfg(test)]
#[path = "engine_checkpoint_tests.rs"]
mod checkpoint_tests;

#[cfg(test)]
#[path = "engine_supplement_tests.rs"]
mod supplement_tests;

#[cfg(test)]
#[path = "engine_adopt_tests.rs"]
mod adopt_tests;

#[cfg(test)]
#[path = "engine_open_tests.rs"]
mod open_tests;

#[cfg(test)]
#[path = "engine_recovery_tests.rs"]
mod recovery_tests;

#[cfg(test)]
#[path = "engine_memory_tests.rs"]
mod memory_tests;

#[cfg(test)]
#[path = "engine_warm_tests.rs"]
mod warm_tests;

#[cfg(test)]
#[path = "engine_recall_tests.rs"]
mod recall_tests;

#[cfg(test)]
#[path = "engine_capture_tests.rs"]
mod capture_tests;

#[cfg(test)]
#[path = "engine_jobs_tests.rs"]
mod jobs_tests;

#[cfg(test)]
#[path = "engine_ops_tests.rs"]
mod ops_tests;

#[cfg(test)]
#[path = "engine_snapshot_tests.rs"]
mod snapshot_tests;
