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

#[path = "pipeline_ports.rs"]
mod ports;
#[path = "pipeline_prepare.rs"]
pub(super) mod prepare;
#[path = "pipeline_routes.rs"]
mod routes;
#[path = "pipeline_row.rs"]
mod row;
pub use ports::{
    CaptureChunkDecider, CaptureClassification, CaptureClassifier, CaptureDynamics, CaptureSummary,
    ClassificationRequest, NeoCaptureHook,
};
pub use routes::{HostCaptureSummary, JevChunkDecider};

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
        let decider = if config["captureChunkingMode"] == "automatisch" {
            JevChunkDecider::from_host(host.clone(), &config["captureChunkingJev"])?
                .map(|decider| Arc::new(decider) as Arc<dyn CaptureChunkDecider>)
        } else {
            None
        };
        Ok(Self {
            host,
            stores,
            embedder,
            classifier,
            policy,
            summary,
            decider,
            neo: None,
            log: Arc::new(StandardCaptureLog),
            config,
            base_db,
            cutoff_failed,
        })
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

impl CaptureWorker for CapturePipeline {
    fn capture(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        options: &CaptureOptions,
        replay: ReplayRows,
        cancel: &Cancel,
    ) -> Result<CaptureResult, EngineError> {
        if !self.policy.allowed(context).unwrap_or(false) {
            return Ok(counts(0, 1, Some("not_captured")));
        }
        if cancel.is_cancelled() {
            return Ok(aborted(0, 0));
        }
        if self.config["neo"]["enabled"] != false {
            let result = self.neo.as_ref().map_or_else(
                || {
                    Err(EngineError::NotAvailable {
                        reason: "neo-capture-unavailable".into(),
                    })
                },
                |hook| hook.record_turn(turn, context, cancel),
            );
            if let Err(error) = result {
                self.warn(&error, CaptureLogStage::NeoCapture, 1);
            }
        }
        if turn.messages.is_empty() {
            return Ok(counts(0, 0, None));
        }
        let mut early_store = None;
        if !replay.stale_row_ids().is_empty() {
            let store = self.store(context)?;
            let run = turn.run_id.as_deref().unwrap_or_default();
            // Validate the complete pending set before removing any existing row.
            for id in replay.stale_row_ids() {
                cancel.check()?;
                if let Some(row) = store.get(id)? {
                    if run.is_empty()
                        || row.stored_by != context.agent_id.as_str()
                        || row.source_turn_id != run
                        || row.scope != "agent-private"
                        || !row.owner_user_id.is_empty()
                        || !row.agent_id.is_empty()
                        || !row.workspace_id.is_empty()
                        || !row.workspace_key.is_empty()
                    {
                        return Err(StoreError::Corrupt.into());
                    }
                }
            }
            for id in replay.stale_row_ids() {
                cancel.check()?;
                if store.get(id)?.is_some() {
                    store.delete_capture_replay_row(id, context.agent_id.as_str(), run)?;
                }
            }
            early_store = Some(store);
        }
        let items = prepare::select_items(turn)?;
        if items.is_empty() {
            return Ok(counts(0, 0, None));
        }
        let origin = prepare::capture_origin(turn, &items)?;
        let now = self.host.now_ms();
        let (preps, mut failed) = self.prepare(items, context, cancel);
        if cancel.is_cancelled() {
            return Ok(aborted(0, 0));
        }
        let expansion = chunking::expand_for_capture(
            &preps,
            self.expansion_mode(),
            |text| {
                self.decider
                    .as_ref()
                    .map_or(StorageDecision::Both, |decider| {
                        match decider.decide(text, context, cancel) {
                            Ok(storage) => storage,
                            Err(error) => {
                                self.warn(&error, CaptureLogStage::CapturePipeline, 1);
                                StorageDecision::Both
                            }
                        }
                    })
            },
            || uuid::Uuid::new_v4().to_string(),
        );
        if cancel.is_cancelled() {
            return Ok(aborted(0, 0));
        }
        let (prepared, embed_failed) = self.embed(expansion.items, context, cancel);
        failed += embed_failed;
        if cancel.is_cancelled() {
            return Ok(aborted(0, 0));
        }
        let store = match early_store.map(Ok).unwrap_or_else(|| self.store(context)) {
            Ok(store) => store,
            Err(error) => {
                self.warn(
                    &error,
                    CaptureLogStage::CapturePipeline,
                    prepared.len() as u64,
                );
                return Ok(counts(
                    0,
                    (prepared.len() as u64).max(1),
                    Some("capture-incomplete"),
                ));
            }
        };
        let mut selected = Vec::new();
        let prepared_count = prepared.len();
        let threshold = self.config["duplicateThreshold"].as_f64().unwrap_or(0.95);
        for (prep, vector) in prepared {
            cancel.check()?;
            match store.search_capture_duplicates(&vector, 1) {
                Ok(nearest) if !dedupe::is_duplicate(nearest.first(), threshold) => {
                    selected.push((prep, vector))
                }
                Ok(_) => {}
                Err(error) => {
                    failed += 1;
                    self.warn(&error.into(), CaptureLogStage::CapturePipeline, 1);
                }
            }
        }
        let mut skipped = (prepared_count - selected.len()) as u64;
        let planned = selected
            .iter()
            .map(|_| uuid::Uuid::new_v4().to_string())
            .collect::<Vec<_>>();
        if !planned.is_empty() {
            replay.on_rows_planned(&planned)?;
        }
        let mut committed = Vec::new();
        for ((prep, vector), id) in selected.into_iter().zip(planned) {
            if cancel.is_cancelled() {
                return Ok(aborted(committed.len() as u64, skipped));
            }
            let write = self
                .row(
                    id,
                    &prep,
                    vector,
                    row::RowContext {
                        turn,
                        context,
                        origin,
                        now,
                        cancel,
                    },
                )
                .and_then(|row| {
                    cancel.check()?;
                    // Every upsert is a completed Lance commit before this row becomes visible.
                    store.upsert(std::slice::from_ref(&row))?;
                    Ok(row)
                });
            match write {
                Ok(row) => committed.push(row),
                Err(_) if cancel.is_cancelled() => {
                    return Ok(aborted(committed.len() as u64, skipped))
                }
                Err(EngineError::Store(StoreError::TombstoneBlocked)) => skipped += 1,
                Err(error) => {
                    failed += 1;
                    self.warn(&error, CaptureLogStage::CapturePipeline, 1);
                }
            }
        }
        if !committed.is_empty() && failed == 0 {
            replay.on_rows_settled()?;
        } else {
            replay.on_rows_kept()?;
        }
        if let Err(error) = self
            .classifier
            .post_store(turn, context, &committed, cancel)
        {
            self.warn(&error, CaptureLogStage::CapturePipeline, 1);
        }
        if let Some(neo) = &self.neo {
            if let Err(error) = neo.post_store(turn, context, options, cancel) {
                self.warn(&error, CaptureLogStage::NeoCapture, 1);
            }
        }
        let stored = committed.len() as u64;
        Ok(counts(
            stored,
            if failed > 0 && stored == 0 {
                skipped.max(1)
            } else {
                skipped
            },
            (failed > 0).then_some("capture-incomplete"),
        ))
    }
}
