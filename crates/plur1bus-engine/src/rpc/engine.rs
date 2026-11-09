//! Process composition over the frozen engine ports.
//!
//! RE-03 provides real embedding/model services. Recall rendering, capture, jobs
//! and operations are not complete in this checkout; their ports explicitly
//! report unavailability until their owning packages supply implementations.
//! Selecting a flat embedding seam never installs a fake memory pipeline.

use super::seams::Seam;
use crate::{
    contract::*,
    embedding::{
        self,
        normalize::normalize_embedding_config,
        service::{Service, ServiceOptions},
    },
};
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
    embedding: Service,
    checkpoints: crate::store::checkpoint::CheckpointStore,
    system_supplement: Vec<String>,
    capabilities: Capabilities,
    status: EngineStatus,
    closed: Arc<AtomicBool>,
    unavailable: Unavailable,
    channels: Channels,
    subscribers: Mutex<Vec<mpsc::Sender<EngineEvent>>>,
    model_degradation: [Degraded; 4],
    closed_degradation: Degraded,
}

impl crate::ops::models::ModelInventory for ProcessEngine {
    fn inventory(
        &self,
        cancel: &Cancel,
    ) -> Result<Vec<crate::ops::models::ModelRequirement>, EngineError> {
        crate::ops::models::ModelInventory::inventory(&self.embedding, cancel)
    }
}

impl ProcessEngine {
    /// Compose the real RE-03 providers or an explicitly selected embedding seam.
    /// Construction is lazy: it neither loads models nor opens memory stores.
    pub fn new(host: Arc<dyn HostServices>, seam: Option<Seam>) -> Result<Self, EngineError> {
        let config = host.config();
        let raw = serde_json::to_value(&config).map_err(|_| composition_invalid())?;
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
        let normalized =
            normalize_embedding_config(&block).map_err(|error| EngineError::Invalid {
                field: error.path,
                message: error.message,
            })?;
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
            fingerprint_id,
            space: Some(space.clone()),
        };
        let provider: Box<dyn embedding::EmbeddingProvider> = match seam {
            Some(seam) => Box::new(
                seam.embedder(normalized.dimensions())
                    .bind_identity(&space)?,
            ),
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
        let clock_host = host;
        options.clock = Arc::new(move || clock_host.now_ms());
        let embedding = Service::new(provider, reranker, identity, None, options)?;
        let capabilities = decode(
            json!({"memoryLink":false,"recallStats":false,"knowledgePromotion":false,"memoryCuration":false}),
        )?;
        let status = decode(json!({
            "ready": false, "degraded": {"reason":"composition-pending","capability":"recall"},
            "agents":0,"contract":"1.17.0","storeSchema":{"current":null,"expected":"1"},
            "jobs":{"ledger":"unavailable","agents":[]},"models":embedding.status(),"journal":null,
            "sharedMemory":{"supported":false,"mode":"unavailable"}
        }))?;
        let closed = Arc::new(AtomicBool::new(false));
        Ok(Self {
            embedding,
            checkpoints,
            system_supplement: crate::recall::system_supplement::build(
                raw["neo"]["enabled"] != false,
            )
            .into_iter()
            .map(str::to_owned)
            .collect(),
            capabilities,
            status,
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
    fn open(&self, _agent: &AgentId) -> Result<AgentStoreHandle, EngineError> {
        Err(self.unavailable.error())
    }
    fn close(&self, _budget: Option<Duration>) -> Result<(), EngineError> {
        self.closed.store(true, Ordering::Release);
        self.embedding.close();
        self.subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        Ok(())
    }
    fn status(&self) -> EngineStatus {
        let mut status = self.status.clone();
        status.models = self.embedding.status();
        // Memory/journal composition is pending; status never blocks on reverse RPC.
        if self.closed.load(Ordering::Acquire) {
            status.degraded = Some(self.closed_degradation.clone());
        } else {
            let index = match (&status.models.embedder.state, &status.models.reranker.state) {
                (ModelState::Failed, _) => Some(0),
                (ModelState::Loading, _) => Some(1),
                (_, ModelState::Failed) => Some(2),
                (_, ModelState::Loading) => Some(3),
                _ => None,
            };
            if let Some(index) = index {
                status.degraded = Some(self.model_degradation[index].clone());
            }
        }
        status
    }
    fn system_supplement(&self) -> Vec<String> {
        self.system_supplement.clone()
    }
    fn recall(
        &self,
        _query: RecallQuery,
        _options: RecallOptions,
        cancel: &Cancel,
    ) -> Result<RecallResult, EngineError> {
        cancel.check()?;
        Err(self.unavailable.error())
    }
    fn capture(
        &self,
        turn: TurnRecord,
        _options: CaptureOptions,
    ) -> Result<CaptureHandle, EngineError> {
        turn.cancel.check()?;
        Err(self.unavailable.error())
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
        &self.unavailable
    }
    fn embedding(&self) -> &dyn EmbeddingService {
        &self.embedding
    }
    fn models(&self) -> &dyn ModelsService {
        &self.embedding
    }
    fn memory(&self) -> &dyn MemoryOps {
        &self.unavailable
    }
    fn admin(&self) -> &dyn AdminOps {
        &self.unavailable
    }
    fn stores(&self) -> &dyn StoreOps {
        &self.unavailable
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

impl MemoryOps for Unavailable {
    unavailable_methods! {
        fn list(_query: MemoryListQuery, _principal: &Principal, _agent: &AgentContext) -> MemoryListResult;
        fn show(_id: &str, _principal: &Principal, _agent: &AgentContext) -> MemoryCard;
        fn forget(_id: &str, _principal: &Principal, _agent: &AgentContext) -> MemoryForgetResult;
        fn correct(_id: &str, _text: &str, _principal: &Principal, _agent: &AgentContext) -> MemoryCorrectResult;
        fn share(_id: &str, _target: MemoryShareTarget, _options: ShareOptions, _principal: &Principal, _agent: &AgentContext) -> MemoryShareResult;
        fn state(_principal: &Principal, _agent: &AgentContext) -> MemoryState;
        fn propose(_id: &str, _text: &str, _options: ProposeOptions, _principal: &Principal, _agent: &AgentContext) -> MemoryProposeResult;
        fn import(_request: MemoryImportRequest, _cancel: &Cancel, _principal: &Principal, _agent: &AgentContext) -> MemoryImportResult;
        fn rebind(_request: MemoryRebindRequest, _cancel: &Cancel, _principal: &Principal, _agent: &AgentContext) -> MemoryRebindResult;
        fn unbind(_request: MemoryUnbindRequest, _cancel: &Cancel, _principal: &Principal, _agent: &AgentContext) -> MemoryUnbindResult;
        fn unimport(_request: MemoryUnimportRequest, _cancel: &Cancel, _principal: &Principal, _agent: &AgentContext) -> MemoryUnimportResult;
        fn link(_id: &str, _request: MemoryLinkRequest, _principal: &Principal, _agent: &AgentContext) -> MemoryLinkResult;
        fn stats(_ids: Option<&[String]>, _principal: &Principal, _agent: &AgentContext) -> MemoryStatsResult;
        fn promote(_request: MemoryPromoteRequest, _principal: &Principal, _agent: &AgentContext) -> MemoryPromotionResult;
    }
    fn proposals(&self) -> &dyn MemoryProposalsOps {
        self
    }
    fn curation(&self) -> &dyn MemoryCurationOps {
        self
    }
}
impl MemoryProposalsOps for Unavailable {
    unavailable_methods! {
        fn list(_query: MemoryProposalListQuery, _principal: &Principal, _agent: &AgentContext) -> MemoryProposalListResult;
        fn accept(_id: &str, _principal: &Principal, _agent: &AgentContext) -> MemoryProposalAcceptResult;
        fn reject(_id: &str, _options: ProposalRejectOptions, _principal: &Principal, _agent: &AgentContext) -> MemoryProposalRejectResult;
    }
}
impl MemoryCurationOps for Unavailable {
    unavailable_methods! {
        fn list(_query: MemoryCurationListQuery, _principal: &Principal, _agent: &AgentContext) -> MemoryCurationListResult;
        fn resolve(_id: &str, _action: MemoryCurationAction, _principal: &Principal, _agent: &AgentContext) -> MemoryCurationResolveResult;
    }
}
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
impl JobRegistry for Unavailable {
    fn list(&self) -> Vec<JobSpec> {
        crate::jobs::catalog()
    }
    fn run(
        &self,
        _job: JobName,
        _agent: &AgentId,
        _options: RunOptions,
        cancel: &Cancel,
    ) -> Result<JobRun, EngineError> {
        cancel.check()?;
        Err(self.error())
    }
    unavailable_methods! { fn history(_agent: &AgentId, _filter: HistoryFilter) -> Vec<JobRun>; }
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
        not_available(engine.open(&agent_id), "composition-pending");
        not_available(
            engine.memory().show("fixture-id", &principal(), &agent()),
            "composition-pending",
        );
        assert!(!engine.status().ready);
        assert!(!engine.capabilities().memory_link);
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
