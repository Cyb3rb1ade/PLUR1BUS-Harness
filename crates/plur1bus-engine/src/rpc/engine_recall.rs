//! Foreground recall over the process pools and the RE-04 T6 runtime (RE-D150).
//! Node assembler behavior the library does not provide stays absent; see the RX takeover report.

use super::{composition_invalid, engine_warm, ProcessEngine};
use crate::{
    capture::{
        classify::{forced_tier, Binding, EmotionEngines},
        emotion_engine::AnalysisOptions,
        emotion_legacy,
        emotion_pool::EmotionalPool,
        emotion_state::EmotionalState,
        tier1::Tier1Classifier,
    },
    context::RequestContext,
    contract::{
        Cancel, EngineError, HostServices, MemoryRow, Message, RecallOptions,
        RecallOptionsReranker, RecallQuery, RecallResult, StoreError,
    },
    recall::{
        acl::{AclSubject, DenialSink},
        budget::{resolve_runtime_recall_budget, RecallBudget},
        control::RecallControl,
        finalise::FinaliseLimits,
        graph_source::BoundGraphSource,
        locale::{resolve_locale, LocaleMessage},
        namespace_pipeline::Pipeline,
        neo_prelude::{NeoPrelude, NeoRequest},
        pattern_source::BoundPatternSource,
        render::{RenderError, RenderRequest},
        runtime::{self, RuntimeRequest},
        score::EmotionalRecallState,
        stages::{StageClocks, StageFlags, StageLimits},
        tombstone_mask::TombstoneMask,
    },
    store::{directory::TrustedDirectory, recall_stats::RecallStats},
    text::{
        js::{js_trim, JsString},
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Instant,
};

/// Per-table hard cap the pin's namespace recall passes to every child pipeline.
const CANDIDATE_HARD_LIMIT: usize = 100;

/// What a successful post-admission path asks the outer boundary to announce.
enum Served {
    /// The pin returns these before its scheduler: no events.
    Silent(RecallResult),
    /// Every scheduled exit announces deferrals, degradation and completion.
    Announced(RecallResult),
}

/// One admitted foreground request and the values resolved before admission.
struct Foreground<'a> {
    engine: &'a ProcessEngine,
    base: &'a Path,
    query: &'a RecallQuery,
    options: &'a RecallOptions,
    raw: Value,
    overrides: Value,
    reranker: Option<Arc<dyn crate::embedding::Reranker>>,
    missing_reranker: bool,
    started: Instant,
    caller: &'a Cancel,
}

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
    let reranker = if options.reranker == Some(RecallOptionsReranker::Off) {
        None
    } else {
        engine.embedding.pipeline_reranker()
    };
    let missing_reranker =
        options.reranker == Some(RecallOptionsReranker::On) && reranker.is_none();
    let agent = query.principal.agent_id.to_string();
    if !control.checkpoint(false) {
        // The pin's entry abort announces only the degradation.
        let result = engine_warm::result(&control, Value::Null, missing_reranker)?;
        let wire = serde_json::to_value(&result).map_err(|_| composition_invalid())?;
        host.emit(
            "recall.degraded",
            json!({"agentId":agent,"degraded":wire["degraded"]}),
        );
        return Ok(result);
    }
    // An admission failure is the pin's `Engine.recall` catch: invalid-query, no events.
    let Ok(admitted) = engine.operations.enter(&query.principal, &query.agent) else {
        control.checkpoint(false);
        let degraded = json!({"reason":"invalid-query","capability":"recall"});
        return engine_warm::result(&control, degraded, missing_reranker);
    };
    control.timer.record("entry", control.timer.elapsed_ms());
    let request = Foreground {
        engine,
        base,
        query,
        options,
        raw,
        overrides,
        reranker,
        missing_reranker,
        started,
        caller,
    };
    match serve(&request, &admitted.context, &mut control) {
        Ok(Served::Silent(result)) => Ok(result),
        Ok(Served::Announced(result)) => announce(host, &agent, result),
        // Typed capability, cancellation and input failures stay errors.
        Err(
            error @ (EngineError::Cancelled(_)
            | EngineError::NotAvailable { .. }
            | EngineError::Invalid { .. }),
        ) => Err(error),
        // Every other failure after admission is the pin's store-section catch: no memory
        // content, no other source, a bounded `error` degradation with the usual events.
        Err(_) => {
            control.checkpoint(false);
            let degraded = json!({"reason":"error","capability":"recall","detail":"recall failed"});
            announce(
                host,
                &agent,
                engine_warm::result(&control, degraded, missing_reranker)?,
            )
        }
    }
}

fn serve(
    request: &Foreground<'_>,
    context: &RequestContext,
    control: &mut RecallControl,
) -> Result<Served, EngineError> {
    let Foreground {
        engine,
        base,
        query,
        options,
        ref raw,
        ref overrides,
        ref reranker,
        missing_reranker,
        started,
        caller,
    } = *request;
    let host = engine.operations.host();
    let empty = |control: &RecallControl, degraded: Value| {
        engine_warm::result(control, degraded, missing_reranker)
    };
    // A workspace whose automatic policy disables memory answers an empty success, before any work.
    if !engine_warm::automatic_allowed(base, context) {
        return empty(control, Value::Null).map(Served::Silent);
    }
    let origin = serde_json::to_value(&query.agent).map_err(|_| composition_invalid())?;
    // Internal turns and prompts under five UTF-16 units get no recall injection.
    if origin["origin"] != "user" || JsString::from(query.query.as_str()).utf16_len() < 5 {
        return empty(control, Value::Null).map(Served::Announced);
    }
    let Ok(workspace) = host.workspace_dir(&query.principal.agent_id) else {
        let degraded = json!({"reason":"invalid-query","capability":"recall"});
        return empty(control, degraded).map(Served::Silent);
    };
    let workspace = workspace.filter(|path| !path.as_os_str().is_empty());
    let now = host.now_ms();
    // The pin catches mood failures; a foreign or corrupt mood file is not used as authority.
    let mood = match engine
        .mood
        .turn(query, context, workspace.as_deref(), &control.cancel)
    {
        Ok(mood) => Some(mood),
        Err(EngineError::Cancelled(_)) => None,
        Err(_) => {
            log::warn!("recall: mood state unavailable");
            None
        }
    };
    if !control.checkpoint(false) {
        return empty(control, Value::Null).map(Served::Announced);
    }
    let pools = engine.live_stores.recall_pools()?;
    let neo = engine_warm::neo_root(&raw["neo"], base);
    let graph = optional(BoundGraphSource::open(&neo, context))?;
    let patterns = optional(BoundPatternSource::open(&neo, context))?;
    // The same registry the memory readers consult (RE-D153).
    let tombstones = TombstoneMask::new(base);
    let embedder = engine.embedding.pipeline_embedder();
    let recall = &raw["recall"];
    let continuity = raw["continuityEngine"]["enabled"] != false;
    let top_n = engine_warm::bounded(&recall["maxPromptMemories"], 12, 1, 100);
    let top_k = engine_warm::bounded(&recall["candidateTopK"], 40, 1, 100);
    let pipeline = Pipeline {
        emotion: mood
            .as_ref()
            .map(|mood| &mood.boost as &dyn EmotionalRecallState),
        identity_providers: &[],
        context,
        denials: &Denials,
        embedder: embedder.as_ref(),
        reranker: reranker.as_deref(),
        workspace_dir: workspace.as_deref(),
        edges: &[],
        bound_graph: graph.as_ref(),
        tombstones: Some(&tombstones),
        cancel: caller,
        limits: StageLimits {
            top_n,
            candidate_top_k: top_k,
            candidate_hard_limit: CANDIDATE_HARD_LIMIT,
            recall_min_score: raw["autoRecallMinScore"].as_f64().unwrap_or(0.2),
            canonical_min_score: recall["canonicalMinScore"].as_f64().unwrap_or(0.3),
            canonical_max_items: recall["canonicalMaxItems"]
                .as_f64()
                .map_or(5, |n| n as usize),
        },
        flags: StageFlags {
            canonical: recall["canonicalFirst"] != false,
            associative: continuity
                && raw["continuityEngine"]["associativeRecall"]["enabled"] != false,
            defer_final_cap: true,
            query_refiner: recall["queryRefinement"]["enabled"] != false,
            persist_knowledge: true,
        },
        clocks: StageClocks {
            now_ms: now,
            temporal_now_ms: now,
            valid_at: None,
        },
        finalise_limits: FinaliseLimits {
            top_n: top_n as f64,
            budget: resolve_runtime_recall_budget(
                &query.query,
                top_n as f64,
                &recall["adaptiveBudget"],
            ) as f64,
            rerank_candidates: raw["reranker"]["candidates"]
                .as_f64()
                .unwrap_or(top_k as f64),
            defer_final_cap: true,
            dedup_enabled: recall["dedup"] != false,
            dedup_jaccard: recall["dedupJaccard"].as_f64().unwrap_or(0.78),
            candidate_hard_limit: CANDIDATE_HARD_LIMIT as f64,
            summary_max_words: raw["summaryMaxWords"].as_f64().unwrap_or(150.0),
            reranker_fallback_on_error: raw["reranker"]["fallbackOnError"] != false,
            canonical_count: 0.0,
        },
    };
    let trace = recall["decisionTrace"]["enabled"] != false;
    let mut render = RenderRequest::new(AclSubject::from_context(context), now as f64);
    render.config = raw.clone();
    render.prompt = query.query.clone();
    // `resolveCommandLocaleRecall` over the event's single user message.
    render.language = resolve_locale(
        None,
        None,
        &[LocaleMessage {
            role: Some("user"),
            content: Some(&query.query),
        }],
        "en",
    );
    render.timezone = host_timezone();
    render.has_workspace = workspace.is_some();
    render.additions.persona =
        crate::jobs::persona_evolve::read_voice(base, context, raw, &control.cancel)
            .unwrap_or_default();
    match crate::jobs::reminder_dispatch::recall_rows(
        engine.live_stores.as_ref(),
        context,
        &tombstones,
        now,
        &control.cancel,
    ) {
        Ok((due, pending)) => {
            render.due_reminders = due;
            render.pending_reminders = pending;
        }
        Err(_) => log::debug!("recall: scoped reminders unavailable"),
    }
    render.temporal_enabled = raw["temporalContext"]["enabled"] != false;
    render.trace_enabled = trace;
    render.trace_in_prompt = trace && recall["decisionTrace"]["includeInPrompt"] == true;
    render.mood = mood
        .as_ref()
        .map_or(Value::Null, |mood| mood.describe.clone());
    let runtime_request = RuntimeRequest {
        pipeline,
        routes: pools.as_ref(),
        render,
        filter: None,
        started,
        budget_overrides: overrides.clone(),
        known_secrets: &[],
        ledger: None,
        neo: &NoNeo,
        pattern_source: patterns.as_ref(),
        reranker_requested: match options.reranker {
            Some(RecallOptionsReranker::Off) => false,
            Some(RecallOptionsReranker::On) => true,
            None => reranker.is_some(),
        },
    };
    let mut outcome = match RecallStats::new(base) {
        Ok(stats) => {
            let counted = runtime::run_with_stats(runtime_request, &stats, host)?;
            if counted.statistics_error.is_some() {
                log::warn!("recall: statistics sidecar unavailable");
            }
            counted.outcome
        }
        Err(_) => {
            log::debug!("recall: statistics base unavailable");
            runtime::run(runtime_request)?
        }
    };
    // The pin's RecallResult never carries the internal decision trace.
    outcome.trace = None;
    outcome.to_contract().map(Served::Announced)
}

/// Emit the pin's per-deferral, degraded and completion events for a scheduled exit.
fn announce(
    host: &dyn HostServices,
    agent: &str,
    result: RecallResult,
) -> Result<RecallResult, EngineError> {
    let wire = serde_json::to_value(&result).map_err(|_| composition_invalid())?;
    for deferral in wire["deferrals"].as_array().into_iter().flatten() {
        let mut payload = json!({"agentId":agent});
        if let (Some(fields), Some(target)) = (deferral.as_object(), payload.as_object_mut()) {
            target.extend(fields.clone());
        }
        let kind = deferral["kind"].as_str().unwrap_or_default();
        host.emit(&format!("recall.block-{kind}"), payload);
    }
    if !wire["degraded"].is_null() {
        host.emit(
            "recall.degraded",
            json!({"agentId":agent,"degraded":wire["degraded"]}),
        );
    }
    host.emit(
        "recall.completed",
        json!({"agentId":agent,"timing":wire["timing"],"degraded":wire["degraded"]}),
    );
    Ok(result)
}

/// Absent Neo metadata is no source; any other open failure fails the recall closed.
fn optional<T>(source: Result<T, StoreError>) -> Result<Option<T>, EngineError> {
    match source {
        Ok(source) => Ok(Some(source)),
        Err(StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
        }) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// `Intl.DateTimeFormat().resolvedOptions().timeZone`: ICU honors `TZ`, then the system zone link.
pub(crate) fn host_timezone() -> String {
    let valid = |name: &str| {
        name.parse::<chrono_tz::Tz>()
            .is_ok()
            .then(|| name.to_owned())
    };
    if let Some(zone) = std::env::var("TZ")
        .ok()
        .and_then(|zone| valid(zone.trim_start_matches(':')))
    {
        return zone;
    }
    std::fs::read_link("/etc/localtime")
        .ok()
        .and_then(|target| {
            let target = target.to_string_lossy().into_owned();
            target
                .find("zoneinfo/")
                .and_then(|index| valid(&target[index + "zoneinfo/".len()..]))
        })
        .unwrap_or_else(|| "UTC".into())
}

/// The ACL sink always receives denials; the process records only the rule at debug level.
struct Denials;
impl DenialSink for Denials {
    fn denied(&self, _row_id: &str, rule: &'static str, _ctx: &RequestContext) {
        log::debug!("recall: row denied by {rule}");
    }
}

/// The library has no recall injection mark or hook record, so foreground recall injects no Neo prelude.
struct NoNeo;
impl NeoPrelude for NoNeo {
    fn read(&self, _request: &NeoRequest<'_>) -> Result<JsString, RenderError> {
        Err(RenderError::Unavailable("neo prelude not composed".into()))
    }
}

/// The turn's mood: its description for the style directive and its state for scoring.
struct Mood {
    describe: Value,
    boost: MoodBoost,
}

/// `computeRecallBoost` over a stored row's legacy valence, at the request clock.
struct MoodBoost {
    state: Mutex<EmotionalState>,
    now: i64,
}
impl EmotionalRecallState for MoodBoost {
    fn recall_boost(&self, row: &MemoryRow) -> f64 {
        let Ok(row) = serde_json::to_value(row) else {
            return 1.0;
        };
        let mut valence = match &row["emotionalValence"] {
            Value::String(value) => emotion_legacy::deserialize(value),
            _ => Json::Object(Vec::new()),
        };
        let intensity = row["emotionalIntensity"]
            .as_f64()
            .filter(|n| n.is_finite())
            .unwrap_or(0.0);
        if let (Json::Object(fields), Ok(number)) =
            (&mut valence, parse_json(&json!(intensity).to_string()))
        {
            if !fields
                .iter()
                .any(|(key, _)| key == &JsString::from("emotionalIntensity"))
            {
                fields.push((JsString::from("emotionalIntensity"), number));
            }
        }
        let importance = row["importance"].as_f64().unwrap_or(f64::NAN);
        self.state
            .lock()
            .ok()
            .and_then(|mut state| state.recall_boost(&valence, importance, self.now).ok())
            .unwrap_or(1.0)
    }
}

/// One authenticated mood pool and the per-owner emotion engines, both shared with capture.
pub(super) struct RecallMood {
    host: Arc<dyn HostServices>,
    pool: Arc<EmotionalPool>,
    emotion: Value,
    engines: Arc<EmotionEngines>,
}
impl RecallMood {
    /// Capture the configured `emotion` block; construction performs no I/O.
    /// The engines use the effective block, as the pin's single `setEmotionConfig`.
    pub(super) fn new(host: Arc<dyn HostServices>, emotion: Value, effective: Value) -> Self {
        let clock = host.clone();
        Self {
            pool: Arc::new(EmotionalPool::new(host.clone(), emotion.clone())),
            engines: Arc::new(EmotionEngines::new(
                effective,
                Arc::new(move || clock.now_ms()),
            )),
            host,
            emotion,
        }
    }

    /// The mood pool capture classifies against (RE-D51 ownership binding unchanged).
    pub(super) fn pool(&self) -> Arc<EmotionalPool> {
        self.pool.clone()
    }

    /// The per-owner emotion engines capture routes through.
    pub(super) fn engines(&self) -> Arc<EmotionEngines> {
        self.engines.clone()
    }

    /// Classify the prompt (tier 1/2; no tier-3 route is composed), commit it to the bound mood.
    fn turn(
        &self,
        query: &RecallQuery,
        context: &RequestContext,
        workspace: Option<&Path>,
        cancel: &Cancel,
    ) -> Result<Mood, EngineError> {
        cancel.check()?;
        let text = JsString::from(js_trim(&query.query));
        let legacy = if text.utf16_len() >= 3 {
            let input = text.utf16_slice(0, 2000);
            // The same canonical binding capture's classifier resolves.
            let directory = workspace
                .map(|path| TrustedDirectory::open(path).map(|dir| dir.path().to_path_buf()))
                .transpose()?;
            let engine = self.engines.engine(Binding {
                agent: context.agent_id.to_string(),
                owner: context.owner_user_id.clone(),
                workspace: context.workspace_key.clone(),
                directory,
            })?;
            let result = engine
                .lock()
                .map_err(|_| StoreError::Corrupt)?
                .analyze_with_completion(
                    &input,
                    "user",
                    AnalysisOptions {
                        force_tier: forced_tier(&self.emotion),
                        skip_tier3: false,
                    },
                    cancel,
                    None,
                );
            cancel.check()?;
            Some(match result {
                Ok(score) => emotion_legacy::from_score(&score),
                Err(_) => emotion_legacy::infer_sync(
                    &Tier1Classifier::new(&Json::Null)?,
                    &input,
                    self.host.now_ms(),
                )?,
            })
        } else {
            None
        };
        let messages: Vec<Message> =
            serde_json::from_value(json!([{"role":"user","content":query.query}]))
                .map_err(|_| composition_invalid())?;
        let commit = self
            .pool
            .update(&query.principal, &query.agent, cancel, |state, now| {
                match &legacy {
                    Some(emotion) => state.apply_emotion(emotion, now)?,
                    None => state.update_messages(&messages, now)?,
                }
                Ok((state.describe(now)?, state.clone(), now))
            })?;
        let (describe, state, now) = commit.value;
        Ok(Mood {
            describe: serde_json::from_str(&write_json(&describe)).unwrap_or(Value::Null),
            boost: MoodBoost {
                state: Mutex::new(state),
                now,
            },
        })
    }
}
