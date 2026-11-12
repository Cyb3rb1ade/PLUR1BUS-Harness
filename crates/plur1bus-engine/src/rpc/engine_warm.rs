//! Process-only read path for speculative recall. It has no writer or delivery hook.

use super::{composition_invalid, decode, EngineStores, ProcessEngine};
use crate::{
    context::RequestContext,
    contract::{
        Cancel, EngineError, RecallOptions, RecallOptionsReranker, RecallQuery, RecallResult,
    },
    embedding::{identity::try_identity_id, EmbedKind, EmbeddingProvider, Reranker},
    neo::{merged::MetadataReader, prelude},
    ops::{
        memory::ReadSource, reembedding::state::MigrationStateStore, workspace_policy::PolicyStore,
    },
    recall::{
        acl,
        budget::RecallBudget,
        control::RecallControl,
        lifecycle::is_recall_entry_live,
        neo_prelude::{NeoPrelude, NeoRequest},
        render::RenderError,
        score::distance_to_score,
        timing::PhaseTimer,
        warm::{self, WarmParameters, WarmRecall, WarmRequest},
    },
    store::{tombstone::TombstoneRegistry, RowFilter, Store},
    text::js::JsString,
};
use serde_json::{json, Value};
use std::{
    cell::OnceCell,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub(super) fn run(
    engine: &ProcessEngine,
    base: &Path,
    query: &RecallQuery,
    options: &RecallOptions,
    caller: &Cancel,
) -> Result<RecallResult, EngineError> {
    let started = Instant::now();
    let host = engine.operations.host();
    let raw = serde_json::to_value(host.config()).map_err(|_| composition_invalid())?;
    let overrides = serde_json::to_value(&query.budget).map_err(|_| composition_invalid())?;
    let mut control = RecallControl::new(started, RecallBudget::resolve(&overrides, &raw), caller);
    if !control.checkpoint(false) {
        return result(&control, Value::Null, false);
    }

    let Ok(admitted) = engine.operations.enter(&query.principal, &query.agent) else {
        control.checkpoint(false);
        return result(
            &control,
            json!({"reason":"invalid-query","capability":"recall"}),
            false,
        );
    };
    control.timer.record("entry", control.timer.elapsed_ms());
    let context = &admitted.context;
    let allowed = automatic_allowed(base, context);
    if !control.checkpoint(false) || !allowed {
        return result(&control, Value::Null, false);
    }

    let embedder =
        engine
            .embedding
            .memory_only_embedder()
            .ok_or_else(|| EngineError::NotAvailable {
                reason: "warm-memory-cache-required".into(),
            })?;
    let reranker = if options.reranker == Some(RecallOptionsReranker::Off) {
        None
    } else {
        engine.embedding.pipeline_reranker()
    };
    let missing_reranker =
        options.reranker == Some(RecallOptionsReranker::On) && reranker.is_none();
    let now = host.now_ms();
    let neo = NeoWarm {
        base,
        context,
        config: &raw["neo"],
        embedder: embedder.as_ref(),
        cancel: &control.cancel,
        now,
    };
    let recall = &raw["recall"];
    let request = WarmRequest {
        prompt: query.query.clone(),
        neo_enabled: raw["neo"]["enabled"] != false,
        top_n: bounded(&recall["maxPromptMemories"], 12, 1, 100),
        allowed,
    };
    let mut vectors = WarmVectors {
        stores: &engine.live_stores,
        context,
        base,
        sources: OnceCell::new(),
        embedder: embedder.as_ref(),
        reranker: reranker.as_deref(),
        config: &raw,
        prompt: &query.query,
        cancel: &control.cancel,
        timer: &mut control.timer,
        now,
    };
    vectors.timer.start("prelude");
    let answer = warm::run(&request, &mut vectors, &neo);
    control.timer.end("prelude");
    control.checkpoint(false);
    let degraded = match answer {
        Ok(answer) => answer.degraded.map_or(Value::Null, |failure| {
            json!({
                "reason":failure.reason, "capability":failure.capability,
                "detail":failure.detail.to_utf8_lossy()
            })
        }),
        Err(_) => {
            json!({"reason":"warm-failed","capability":"recall","detail":"warm recall unavailable"})
        }
    };
    result(&control, degraded, missing_reranker)
}

/// Automatic workspace policy under the generation switch lock; any read failure denies.
pub(super) fn automatic_allowed(base: &Path, context: &RequestContext) -> bool {
    MigrationStateStore::new(base)
        .and_then(|store| store.switching())
        .is_ok_and(|switching| {
            PolicyStore::new(base).is_ok_and(|policy| {
                policy.automatic(
                    &json!({"agentId":context.agent_id,"workspaceIdentity":context.workspace_key}),
                    switching,
                )["allowed"]
                    == true
            })
        })
}

/// The configured Neo state root, or the pin's default below the store base.
pub(super) fn neo_root(neo: &Value, base: &Path) -> PathBuf {
    neo["statePath"]
        .as_str()
        .filter(|path| !path.is_empty())
        .map_or_else(|| base.join("_neo"), PathBuf::from)
}

/// The pin's empty `recallResult()` with the request's timing.
pub(super) fn result(
    control: &RecallControl,
    degraded: Value,
    missing_reranker: bool,
) -> Result<RecallResult, EngineError> {
    let mut wire = json!({
        "blocks":[],"deferrals":[],"capChars":null,
        "degraded":crate::recall::budgeted_pipeline::degradation(control.stopped()).unwrap_or(degraded),
        "timing":{"phases":control.timer.summary(),"totalMs":control.timer.elapsed_ms()},
    });
    if missing_reranker {
        wire["diagnostics"] = json!([
            {"feature":"reranker","reason":"reranker-not-configured","fallback":"unreranked"}
        ]);
    }
    decode(wire)
}

pub(super) fn bounded(value: &Value, fallback: usize, lo: usize, hi: usize) -> usize {
    value
        .as_f64()
        .unwrap_or(fallback as f64)
        .floor()
        .clamp(lo as f64, hi as f64) as usize
}

fn unavailable(detail: &str) -> RenderError {
    RenderError::Unavailable(detail.into())
}

struct WarmVectors<'a> {
    stores: &'a EngineStores,
    context: &'a RequestContext,
    base: &'a Path,
    sources: OnceCell<Vec<ReadSource>>,
    embedder: &'a dyn EmbeddingProvider,
    reranker: Option<&'a dyn Reranker>,
    config: &'a Value,
    prompt: &'a str,
    cancel: &'a Cancel,
    timer: &'a mut PhaseTimer,
    now: i64,
}

impl WarmRecall for WarmVectors<'_> {
    fn has_table(&self) -> Result<bool, RenderError> {
        self.cancel.check().map_err(|_| RenderError::Aborted)?;
        let sources = self
            .stores
            .warm_sources(self.context)
            .map_err(|_| unavailable("store lease unavailable"))?;
        let present = !sources.is_empty();
        self.sources
            .set(sources)
            .map_err(|_| unavailable("store leases already acquired"))?;
        Ok(present)
    }

    fn recall(&mut self, parameters: &WarmParameters) -> Result<(), RenderError> {
        self.cancel.check().map_err(|_| RenderError::Aborted)?;
        self.timer.end("prelude");
        let mut sources = self
            .sources
            .take()
            .ok_or_else(|| unavailable("store leases unavailable"))?;
        let identity = try_identity_id(self.embedder.identity())
            .map_err(|_| unavailable("vector identity unavailable"))?;
        sources.retain(|source| !source.optional || compatible(&source.store, &identity));
        if sources.is_empty() {
            return Ok(());
        }
        if sources
            .iter()
            .any(|source| !compatible(&source.store, &identity))
        {
            return Err(unavailable("vector identity unavailable"));
        }
        self.timer.start("embedding");
        let embeddings =
            self.embedder
                .embed(&[self.prompt.to_owned()], EmbedKind::Query, self.cancel);
        self.timer.end("embedding");
        let vector = embeddings
            .ok()
            .and_then(|mut vectors| vectors.pop())
            .ok_or_else(|| unavailable("query embedding unavailable"))?;
        let recall = &self.config["recall"];
        let limit = bounded(&recall["candidateTopK"], 40, 1, 100);
        let rerank_limit = bounded(&self.config["reranker"]["candidates"], limit, 1, 100);
        let min_score = self.config["autoRecallMinScore"].as_f64().unwrap_or(0.2);
        for source in sources {
            self.cancel.check().map_err(|_| RenderError::Aborted)?;
            let attempt = self.warm_table(
                &source.store,
                &vector,
                limit,
                rerank_limit,
                min_score,
                parameters.top_n,
            );
            if !source.optional {
                attempt?;
            }
        }
        Ok(())
    }
}

impl WarmVectors<'_> {
    fn warm_table(
        &mut self,
        store: &Store,
        vector: &[f32],
        limit: usize,
        rerank_limit: usize,
        min_score: f64,
        top_n: usize,
    ) -> Result<(), RenderError> {
        self.timer.start("vector_search");
        let rows = store.search(
            vector,
            limit,
            &RowFilter {
                memory_kind: Some("memory".into()),
                ..RowFilter::default()
            },
        );
        self.timer.end("vector_search");
        let rows = rows.map_err(|_| unavailable("vector search unavailable"))?;
        let Some(reranker) = self.reranker else {
            return Ok(());
        };
        if self.timer.soft_exceeded() && self.config["recall"]["softBudgetFallback"] != false {
            return Ok(());
        }
        let mut docs = Vec::new();
        for hit in rows {
            if distance_to_score(f64::from(hit.distance)) < min_score {
                continue;
            }
            self.cancel.check().map_err(|_| RenderError::Aborted)?;
            let Some(record) = store
                .get_record(&hit.row.id)
                .map_err(|_| unavailable("candidate unavailable"))?
            else {
                continue;
            };
            let row = &record.row;
            if !is_recall_entry_live(row, self.now, None)
                || acl::allowed(row, self.context).is_err()
            {
                continue;
            }
            let owner = if row.agent_id.is_empty() {
                &row.stored_by
            } else {
                &row.agent_id
            };
            let blocked = |agent: &str, id: &str| {
                TombstoneRegistry::new(self.base, agent)
                    .and_then(|registry| registry.blocks_warm_read(id))
                    .map_err(|_| unavailable("deletion state unavailable"))
            };
            if blocked(owner, &row.id)? {
                continue;
            }
            if let Some((agent, id)) = record.origin() {
                if (agent != *owner || id != row.id) && blocked(&agent, &id)? {
                    continue;
                }
            }
            docs.push(row.text.clone());
            if docs.len() == rerank_limit {
                break;
            }
        }
        if docs.len() > 1 {
            self.timer.start("rerank");
            let attempt = reranker.rerank(self.prompt, &docs, top_n.min(docs.len()), self.cancel);
            self.timer.end("rerank");
            if attempt.is_err() && self.config["reranker"]["fallbackOnError"] == false {
                return Err(unavailable("reranker unavailable"));
            }
        }
        Ok(())
    }
}

fn compatible(store: &Store, identity: &str) -> bool {
    store
        .identity()
        .is_none_or(|space| try_identity_id(space).is_ok_and(|found| found == identity))
}

struct NeoWarm<'a> {
    base: &'a Path,
    context: &'a RequestContext,
    config: &'a Value,
    embedder: &'a dyn EmbeddingProvider,
    cancel: &'a Cancel,
    now: i64,
}

impl NeoPrelude for NeoWarm<'_> {
    fn read(&self, request: &NeoRequest<'_>) -> Result<JsString, RenderError> {
        let root = neo_root(self.config, self.base);
        let reader = match MetadataReader::open(&root, &self.context.workspace_key) {
            Ok(reader) => reader,
            Err(crate::contract::StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => {
                return Ok(JsString::default());
            }
            Err(_) => return Err(unavailable("Neo source unavailable")),
        };
        let global = &self.config["recall"]["global"];
        let prelude = prelude::NativePrelude::new(
            &reader,
            self.context,
            self.embedder,
            prelude::Config {
                now_ms: self.now as f64,
                embedding_timeout: Duration::from_millis(bounded(
                    &global["embedTimeoutMs"],
                    4000,
                    500,
                    60_000,
                ) as u64),
                global: (global["enabled"] != false).then(|| prelude::GlobalConfig {
                    top_k: bounded(&global["topK"], 30, 1, 200),
                    min_similarity: global["minSimilarity"]
                        .as_f64()
                        .unwrap_or(0.35)
                        .clamp(0., 1.),
                    half_life_days: global["halfLifeDays"]
                        .as_f64()
                        .filter(|n| *n > 0.)
                        .unwrap_or(30.),
                    max_candidates: bounded(&global["maxCandidates"], 20_000, 100, 50_000),
                    dedupe_threshold: global["dedupeThreshold"]
                        .as_f64()
                        .unwrap_or(0.8)
                        .clamp(0., 1.),
                }),
                format: crate::neo::format::Options::default(),
            },
            self.cancel.clone(),
        )
        .map_err(|_| unavailable("Neo prelude unavailable"))?;
        prelude.read(request)
    }
}
