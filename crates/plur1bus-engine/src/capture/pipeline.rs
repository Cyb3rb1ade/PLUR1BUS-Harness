//! Actual RE-05 capture worker: selected text becomes a committed Lance row behind replay callbacks.
//!
//! Classification and Neo are explicit ports so their owning stages run at the real source
//! boundaries. Row identities, provenance, duplicate checks and WAL ordering are owned here.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;

use crate::config::effective_config;
use crate::context::RequestContext;
use crate::contract::{
    Cancel, CaptureOptions, CaptureResult, EmbedKind, EngineError, HostServices, StoreError,
    TurnRecord,
};
use crate::embedding::{batch::validate_vectors, EmbeddingProvider};
use crate::store::{identity::identity_id, Store, StorePool};

use super::accept::CaptureWorker;
use super::chunking::{self, ExpansionMode, PreparedCapture, StorageDecision};
use super::epistemic_cutoff::ensure_cutoff;
use super::logging::{CaptureLogSink, CaptureLogStage, SafeCaptureLog, StandardCaptureLog};
use super::replay_guard::ReplayRows;
use super::result::counts;
use super::shared_scope::CapturePolicy;
use super::{batch, dedupe, row_builder};

#[path = "pipeline_capture.rs"]
mod capture;
#[path = "pipeline_ports.rs"]
mod ports;
#[path = "pipeline_prepare.rs"]
pub(super) mod prepare;
#[path = "pipeline_routes.rs"]
mod routes;
#[path = "pipeline_row.rs"]
mod row;
pub use ports::{
    CaptureChunkDecider, CaptureClassification, CaptureClassifier, CaptureDynamics,
    CapturePostStore, CaptureSummary, ClassificationRequest, NeoCaptureHook, ReminderEffect,
};
pub use routes::HostCaptureSummary;

type EmbeddedCapture = (PreparedCapture<prepare::CaptureItem>, Vec<f32>);

/// A row-producing worker consumed directly by `CaptureRuntime`.
pub struct CapturePipeline {
    host: Arc<dyn HostServices>,
    stores: Arc<StorePool>,
    embedder: Arc<dyn EmbeddingProvider>,
    classifier: Arc<dyn CaptureClassifier>,
    policy: Arc<dyn CapturePolicy>,
    summary: Option<Arc<dyn CaptureSummary>>,
    decider: Option<Arc<dyn CaptureChunkDecider>>,
    neo: Option<Arc<dyn NeoCaptureHook>>,
    log: Arc<dyn CaptureLogSink>,
    config: Value,
    base_db: PathBuf,
    cutoff_failed: bool,
    admissions: super::admission::Admissions,
    shutdown: Cancel,
    /// Agents with retained work still pending after a transient failure (RE-D156).
    pending: std::sync::Mutex<std::collections::BTreeSet<String>>,
    /// A malformed admission file was found; it is kept and never blocks anyone.
    unreadable: std::sync::atomic::AtomicBool,
}

impl CapturePipeline {
    /// Compose existing services and materialize the same effective configuration as Node.
    /// The restore-safe cutoff is initialized once; no agent store is opened until capture.
    pub fn new(
        host: Arc<dyn HostServices>,
        stores: Arc<StorePool>,
        embedder: Arc<dyn EmbeddingProvider>,
        classifier: Arc<dyn CaptureClassifier>,
        policy: Arc<dyn CapturePolicy>,
    ) -> Result<Self, EngineError> {
        let raw = serde_json::to_value(host.config()).map_err(|_| invalid_config())?;
        let config = effective_config(&raw).map_err(|_| invalid_config())?;
        let base_db = config["baseDbPath"]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or_else(invalid_config)?;
        let cutoff_failed = !ensure_cutoff(&base_db, host.now_ms()).ok;
        let model = config["llmRouter"]["defaultModel"]
            .as_str()
            .map(crate::text::js::js_trim)
            .filter(|model| !model.is_empty())
            .map(str::to_owned);
        let summary = host.llm().is_some().then(|| {
            Arc::new(HostCaptureSummary::new(host.clone(), model)) as Arc<dyn CaptureSummary>
        });
        // D125: conversation content never goes to a built-in Jev decision route.
        // Without an explicitly composed decider, automatic mode captures whole + parts.
        let admissions = super::admission::Admissions::new(
            &base_db,
            host.clone(),
            policy.clone(),
            &config,
            identity_id(embedder.identity())?,
        )?;
        Ok(Self {
            admissions,
            host,
            stores,
            embedder,
            classifier,
            policy,
            summary,
            decider: None,
            neo: None,
            log: Arc::new(StandardCaptureLog),
            config,
            base_db,
            cutoff_failed,
            shutdown: Cancel::never(),
            pending: std::sync::Mutex::default(),
            unreadable: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// Bind startup recovery to a shutdown signal; admitted work keeps its own cancellation.
    #[must_use]
    pub fn with_recovery_cancel(mut self, shutdown: Cancel) -> Self {
        self.shutdown = shutdown;
        self
    }

    /// Whether retained capture work is still unfinished: a pending entry awaiting its
    /// owner's next turn (or the end of maintenance), or a malformed admission file.
    #[must_use]
    pub fn has_unfinished_recovery(&self) -> bool {
        self.unreadable.load(std::sync::atomic::Ordering::Acquire)
            || !self
                .pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_empty()
    }

    /// Supply the configured summary route; absence means Node's route is unavailable.
    #[must_use]
    pub fn with_summary(mut self, route: Arc<dyn CaptureSummary>) -> Self {
        self.summary = Some(route);
        self
    }
    /// Supply an authenticated, guarded Jev route; absent credentials retain deterministic both mode.
    #[must_use]
    pub fn with_decider(mut self, route: Arc<dyn CaptureChunkDecider>) -> Self {
        self.decider = Some(route);
        self
    }
    /// Bind RE-05/T5 working memory without changing the capture contract.
    #[must_use]
    pub fn with_neo(mut self, hook: Arc<dyn NeoCaptureHook>) -> Self {
        self.neo = Some(hook);
        self
    }
    /// Supply a content-free diagnostic sink for this engine's capture work.
    #[must_use]
    pub fn with_log(mut self, log: Arc<dyn CaptureLogSink>) -> Self {
        self.log = log;
        self
    }

    fn warn(&self, error: &EngineError, stage: CaptureLogStage, count: u64) {
        self.log
            .record(SafeCaptureLog::from_error(stage, error, count));
    }

    fn store(&self, context: &RequestContext) -> Result<Arc<Store>, EngineError> {
        let store = self.stores.get(context.agent_id.as_str())?;
        let expected = self.embedder.identity();
        if let Some(actual) = store.identity() {
            if identity_id(actual)? != identity_id(expected)? {
                return Err(StoreError::IdentityMismatch.into());
            }
        }
        let width = expected
            .dimension
            .as_u64()
            .ok_or(StoreError::InvalidInput)?;
        let schema = store.arrow_schema();
        let vector = schema
            .fields()
            .iter()
            .find(|field| field.name() == "vector")
            .ok_or(StoreError::Corrupt)?;
        if !matches!(vector.data_type(), arrow_schema::DataType::FixedSizeList(_, found) if u64::try_from(*found).ok() == Some(width))
        {
            return Err(StoreError::IdentityMismatch.into());
        }
        Ok(store)
    }

    fn expansion_mode(&self) -> ExpansionMode {
        if self.config["captureChunking"] == false {
            return ExpansionMode::Disabled;
        }
        match self.config["captureChunkingMode"].as_str() {
            Some("geteilt") => ExpansionMode::PartsOnly,
            Some("automatisch") if self.decider.is_some() => ExpansionMode::Decided,
            _ => ExpansionMode::WholeAndParts,
        }
    }

    fn prepare(
        &self,
        items: Vec<prepare::CaptureItem>,
        context: &RequestContext,
        cancel: &Cancel,
    ) -> (Vec<PreparedCapture<prepare::CaptureItem>>, usize) {
        let max_chars = self.config["captureMaxChars"]
            .as_u64()
            .filter(|value| *value > 0)
            .unwrap_or(15_000) as usize;
        let mut preps = Vec::new();
        let failed = 0;
        for item in items {
            let text = if item.text.utf16_len() > max_chars {
                match self
                    .summary
                    .as_ref()
                    .filter(|_| self.config["merging"]["enabled"] != false)
                {
                    Some(route) => match route.summarize(&item.text, max_chars, context, cancel) {
                        Ok(text) => text,
                        Err(error) => {
                            self.warn(&error, CaptureLogStage::CapturePipeline, 1);
                            chunking::truncate_for_capture(&item.text, max_chars)
                        }
                    },
                    None => chunking::truncate_for_capture(&item.text, max_chars),
                }
            } else {
                item.text.clone()
            };
            preps.push(PreparedCapture {
                item,
                text,
                chunk_group_id: None,
            });
        }
        (preps, failed)
    }

    fn embed(
        &self,
        preps: Vec<PreparedCapture<prepare::CaptureItem>>,
        context: &RequestContext,
        cancel: &Cancel,
    ) -> (Vec<EmbeddedCapture>, usize) {
        let width = self.embedder.identity().dimension.as_u64().unwrap_or(0) as usize;
        let batch_size = self.config["embeddingBatchSize"]
            .as_u64()
            .filter(|value| *value > 0)
            .unwrap_or(8) as usize;
        let vectors = batch::run_batch(self.log.as_ref(), preps.len() as u64, || {
            let mut found = HashMap::new();
            for chunk in preps.chunks(batch_size) {
                cancel.check()?;
                let texts = chunk
                    .iter()
                    .map(|prep| super::output_unicode::external(&prep.text))
                    .collect::<Vec<_>>();
                let vectors = self.embedder.embed(&texts, EmbedKind::Passage, cancel)?;
                validate_vectors(&vectors, texts.len(), width)?;
                cancel.check()?;
                for (prep, vector) in chunk.iter().zip(vectors) {
                    found.insert(prep.text.clone(), vector);
                }
            }
            Ok(found)
        })
        .unwrap_or_default();
        let mut prepared = Vec::new();
        let mut failed = 0;
        for prep in preps {
            if cancel.is_cancelled() {
                break;
            }
            let vector = vectors.get(&prep.text).cloned().or_else(|| {
                let texts = [super::output_unicode::external(&prep.text)];
                match self
                    .embedder
                    .embed(&texts, EmbedKind::Passage, cancel)
                    .and_then(|vectors| {
                        validate_vectors(&vectors, 1, width)?;
                        vectors
                            .into_iter()
                            .next()
                            .ok_or(crate::contract::EmbedError::InvalidVector)
                    }) {
                    Ok(vector) => Some(vector),
                    Err(error) => {
                        self.warn(&error.into(), CaptureLogStage::CapturePipeline, 1);
                        None
                    }
                }
            });
            if let Some(vector) = vector {
                prepared.push((prep, vector));
            } else {
                failed += 1;
            }
        }
        let _ = context;
        (prepared, failed)
    }
}

fn invalid_config() -> EngineError {
    EngineError::Invalid {
        field: "capture".into(),
        message: "invalid capture configuration".into(),
    }
}
fn aborted(stored: u64, skipped: u64) -> CaptureResult {
    counts(
        stored,
        if stored > 0 { skipped } else { skipped.max(1) },
        Some("aborted"),
    )
}
