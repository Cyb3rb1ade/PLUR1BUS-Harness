//! Cheap read-only engine status; model probes and memory-store opens belong to other operations.
use crate::{
    contract::{
        ContractVersion, Degraded, EmbeddingIdentity, EngineError, EngineStatus,
        EngineStatusStoreSchema, HostServices, JobsHealth, JobsHealthLedger, JournalBacklog,
        ModelState, ModelsStatus, ModelsStatusEmbedder, ModelsStatusReranker, SharedMemoryMode,
        SharedMemorySupport, SharedMemorySupportReason,
    },
    store::paths::assert_trusted_path,
    text::json::{parse_json, TolerantJsonValue as Json},
};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        mpsc::{self, Receiver, RecvTimeoutError},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

/// The Node host-backlog wait ceiling. Only one callback may remain in flight per reporter.
pub const JOURNAL_BACKLOG_TIMEOUT: Duration = Duration::from_millis(50);
/// Read-only native sources. Implementations return cached model state and ledger-derived health,
/// never warm a model, open a memory table, or create a store while serving these methods.
pub trait StatusSources: Send + Sync {
    /// Job health from the runtime registry, including its actual in-flight work.
    fn jobs(&self) -> Result<JobsHealth, EngineError>;
    /// Current RE-03 readiness snapshot, without invoking a provider.
    fn models(&self) -> Result<ModelsStatus, EngineError>;
    /// Real configured identity used only if the readiness source is unavailable.
    fn identity(&self) -> Result<Option<EmbeddingIdentity>, EngineError>;
    /// Live pool platform/root safety support, not a guessed operating-system value.
    fn shared(&self) -> Result<SharedMemorySupport, EngineError>;
    /// Number of agent namespaces actually opened by this engine instance.
    fn opened_agents(&self) -> usize;
}
/// Optional host backlog callback; the host's synchronous ABI cannot be forcibly cancelled.
pub type JournalSource = dyn Fn() -> Result<Option<JournalBacklog>, EngineError> + Send + Sync;
/// Validate exactly the Node host backlog projection, discarding unrelated input fields.
pub fn normalize_journal(value: &Value) -> Option<JournalBacklog> {
    let entries = value.get("entries")?.as_f64()?;
    if !entries.is_finite()
        || entries < 0.
        || entries.fract() != 0.
        || entries > 9_007_199_254_740_991.
    {
        return None;
    }
    let oldest = value.get("oldestAt")?;
    if !oldest.is_null() && !oldest.as_f64().is_some_and(f64::is_finite) {
        return None;
    }
    serde_json::from_value(serde_json::json!({"entries":value["entries"],"oldestAt":oldest})).ok()
}
/// Read only the base marker. Unknown numeric versions are diagnostic data, not migration permission.
pub fn schema_version(base: &Path) -> Option<String> {
    let path = base.join("_schema.json");
    assert_trusted_path(&path).ok()?;
    let bytes = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some("0".into()),
        Err(_) => return None,
    };
    let raw = parse_json(&bytes).ok()?;
    let Json::String(version) = super::import_primitives::field(&raw, "schemaVersion")? else {
        return None;
    };
    let version = version.to_utf8_lossy();
    (!version.is_empty() && version.bytes().all(|b| b.is_ascii_digit())).then_some(version)
}
struct Backlog {
    source: Arc<JournalSource>,
    pending: Mutex<Option<Receiver<Option<JournalBacklog>>>>,
}
impl Backlog {
    fn get(&self) -> Option<JournalBacklog> {
        let deadline = Instant::now() + JOURNAL_BACKLOG_TIMEOUT;
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Waiting for an earlier status caller consumes this caller's 50 ms budget too.
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        if pending.is_none() {
            let source = self.source.clone();
            let (tx, rx) = mpsc::sync_channel(1);
            if std::thread::Builder::new()
                .name("engine-status-backlog".into())
                .spawn(move || {
                    // A callback panic disconnects the channel; ordinary host failures are values.
                    let value = source()
                        .ok()
                        .flatten()
                        .and_then(|v| serde_json::to_value(v).ok())
                        .and_then(|v| normalize_journal(&v));
                    let _ = tx.send(value);
                })
                .is_err()
            {
                return None;
            }
            *pending = Some(rx);
        }
        match pending
            .as_ref()?
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            Ok(value) => {
                *pending = None;
                value
            }
            Err(RecvTimeoutError::Disconnected) => {
                *pending = None;
                None
            }
            // Retain this receiver. Subsequent calls cannot create unbounded stuck host threads.
            Err(RecvTimeoutError::Timeout) => None,
        }
    }
}
/// Assembles the frozen EngineStatus without acquiring writable resources.
pub struct StatusReporter {
    sources: Arc<dyn StatusSources>,
    base: PathBuf,
    contract: ContractVersion,
    backlog: Option<Backlog>,
}
impl StatusReporter {
    /// Construction does no I/O, no model work and starts no background callback.
    pub fn new(
        sources: Arc<dyn StatusSources>,
        base: PathBuf,
        contract: ContractVersion,
        journal: Option<Arc<JournalSource>>,
    ) -> Self {
        Self {
            sources,
            base,
            contract,
            backlog: journal.map(|source| Backlog {
                source,
                pending: Mutex::new(None),
            }),
        }
    }
    /// Bind the optional callback to the actual host; no fabricated journal state.
    pub fn for_host(
        sources: Arc<dyn StatusSources>,
        base: PathBuf,
        contract: ContractVersion,
        host: Arc<dyn HostServices>,
    ) -> Self {
        Self::new(
            sources,
            base,
            contract,
            Some(Arc::new(move || Ok(host.journal_backlog()))),
        )
    }
    /// Latest status. A slow host backlog contributes null after the bounded wait.
    pub fn status(&self) -> EngineStatus {
        let jobs = self.sources.jobs().unwrap_or(JobsHealth {
            ledger: JobsHealthLedger::Unavailable,
            agents: vec![],
        });
        let models = self.sources.models().unwrap_or_else(|_| {
            let identity = self
                .sources
                .identity()
                .ok()
                .flatten()
                .unwrap_or(EmbeddingIdentity {
                    fingerprint_id: "unknown".into(),
                    provider: "unknown".into(),
                    model: "unknown".into(),
                    dimensions: 0.into(),
                    space: None,
                });
            ModelsStatus {
                embedder: ModelsStatusEmbedder {
                    state: ModelState::Loading,
                    warming: false,
                    checked_at: None,
                    identity,
                    error: None,
                },
                reranker: ModelsStatusReranker {
                    state: ModelState::Loading,
                    warming: false,
                    checked_at: None,
                    provider: None,
                    error: None,
                },
            }
        });
        let journal = self.backlog.as_ref().and_then(Backlog::get);
        let shared_memory = self.sources.shared().unwrap_or(SharedMemorySupport {
            supported: false,
            mode: SharedMemoryMode::Unavailable,
            reason: Some(SharedMemorySupportReason::Platform),
        });
        EngineStatus {
            ready: true,
            degraded: degraded(&models),
            agents: self.sources.opened_agents().into(),
            contract: self.contract,
            store_schema: EngineStatusStoreSchema {
                current: schema_version(&self.base),
                expected: "1".to_owned().into(),
            },
            jobs,
            models,
            journal,
            shared_memory,
        }
    }
}
/// First matching capability wins; a disabled reranker cannot degrade an otherwise ready engine.
pub fn degraded(models: &ModelsStatus) -> Option<Degraded> {
    let (reason, capability) = match (models.embedder.state, models.reranker.state) {
        (ModelState::Failed, _) => ("model-failed", "embedding"),
        (ModelState::Loading, _) => ("models-warming", "embedding"),
        (_, ModelState::Failed) => ("model-failed", "reranker"),
        (_, ModelState::Loading) => ("models-warming", "reranker"),
        _ => return None,
    };
    Some(Degraded {
        reason: reason.into(),
        capability: capability.into(),
        detail: None,
        identities: None,
    })
}
