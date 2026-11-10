//! T6 request boundary over the production namespace pipeline and T5 renderer.
//! The process facade supplies authorized source snapshots; this module owns no background jobs.

use super::{
    acl::AclSubject,
    blocks::{RenderEffects, RenderedRecall},
    budget::{resolve_runtime_recall_budget, RecallBudget},
    budgeted_pipeline::{degradation, BudgetedPipeline},
    control::RecallControl,
    filter::CandidateFilter,
    merge::MergeOptions,
    namespace_budget::MergedBudget,
    namespace_pipeline::Pipeline,
    namespaces::{self, NamespaceError, NamespaceRequest},
    neo_prelude::NeoPrelude,
    render::{self, RenderRequest, SelectedRecall},
    trace::{self, TracePolicy},
};
use crate::{
    contract::{EngineError, RecallResult, StoreError},
    store::{ledger::JsonlLedger, ledger_types::RetrievalLedgerLine, StoreRoutes},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use serde_json::{json, Value};
use std::{sync::Arc, time::Instant};

/// Authorized dependencies for one foreground recall, composed by RE-08.
pub struct RuntimeRequest<'a> {
    /// Leased-table dependencies and the canonical ACL context.
    pub pipeline: Pipeline<'a>,
    /// Physical routes in configured order, including required-store failure policy.
    pub routes: &'a dyn StoreRoutes,
    /// Existing T5 source snapshot. Its ACL context must match the pipeline's context.
    pub render: RenderRequest,
    /// Optional document filter, called only after provider ACL checks.
    pub filter: Option<&'a dyn CandidateFilter>,
    /// Request entry, before admission/queue delay.
    pub started: Instant,
    /// The existing query.budget object.
    pub budget_overrides: Value,
    /// Host-registered credential values used solely for trace redaction.
    pub known_secrets: &'a [String],
    /// Optional retrieval ledger; never appended after hard expiry/caller cancellation.
    pub ledger: Option<&'a JsonlLedger<RetrievalLedgerLine>>,
    /// Existing CA5 prelude, with authorization retained by its implementation.
    pub neo: &'a dyn NeoPrelude,
    /// Optional actual Neo source; replaces caller snapshots, never falls back after failure.
    pub pattern_source: Option<&'a super::pattern_source::BoundPatternSource>,
    /// Requested reranker option: missing configured provider yields a diagnostic only when on.
    pub reranker_requested: bool,
}

/// Internal result with codepoint-safe visible text and diagnostic IDs (F3/F5).
pub struct RecallOutcome {
    /// T5 blocks and caller-owned maintenance intents.
    pub rendered: RenderedRecall,
    /// Bounded, content-free cancellation/capability classification.
    pub degraded: Option<Value>,
    /// Request and independent table phase summaries.
    pub timing: Value,
    /// Optional redacted, capped, well-formed Unicode trace.
    pub trace: Option<Json>,
    /// Existing per-call contract diagnostics.
    pub diagnostics: Vec<Value>,
    /// Best-effort ledger delivery, kept outside the serialized recall contract.
    pub ledger_error: Option<StoreError>,
}

impl RecallOutcome {
    /// Cross the frozen typed contract without a raw-JSON RPC adapter.
    pub fn to_contract(&self) -> Result<RecallResult, EngineError> {
        serde_json::from_str(&self.to_json_line()?).map_err(|_| malformed())
    }

    /// Emit the existing wire fields, preserving opaque internal JSON construction.
    pub fn to_json_line(&self) -> Result<String, EngineError> {
        let Json::Object(mut fields) =
            parse_json(&self.rendered.to_json_line()).map_err(|_| malformed())?
        else {
            return Err(malformed());
        };
        if let Some(degraded) = &self.degraded {
            if let Some((_, value)) = fields
                .iter_mut()
                .find(|(key, _)| key == &JsString::from("degraded"))
            {
                *value = trace::from_value(degraded);
            }
        }
        fields.push((JsString::from("timing"), trace::from_value(&self.timing)));
        if let Some(trace) = &self.trace {
            fields.push((JsString::from("trace"), trace.clone()));
        }
        if !self.diagnostics.is_empty() {
            fields.push((
                JsString::from("diagnostics"),
                trace::from_value(&json!(self.diagnostics)),
            ));
        }
        Ok(write_json(&Json::Object(fields)))
    }
}

/// Run real namespace selection, then pure rendering. All scoped workers have settled on return.
/// Required store errors fail closed; only a typed cancellation becomes a partial successful result.
pub fn run(mut request: RuntimeRequest<'_>) -> Result<RecallOutcome, EngineError> {
    if request.render.context != AclSubject::from_context(request.pipeline.context) {
        return Err(EngineError::Invalid {
            field: "principal".into(),
            message: "recall source context differs".into(),
        });
    }
    let budget = RecallBudget::resolve(&request.budget_overrides, &request.render.config);
    let mut control = RecallControl::new(request.started, budget, request.pipeline.cancel);
    let diagnostics = if request.reranker_requested && request.pipeline.reranker.is_none() {
        vec![
            json!({"feature":"reranker","reason":"reranker-not-configured","fallback":"unreranked"}),
        ]
    } else {
        Vec::new()
    };
    if !control.checkpoint(false) {
        return Ok(RecallOutcome {
            rendered: RenderedRecall {
                cap_chars: budget.cap_chars,
                ..RenderedRecall::default()
            },
            degraded: degradation(control.stopped()),
            timing: json!({"phases":control.timer.summary(),"totalMs":control.timer.elapsed_ms(),"namespacePhases":[]}),
            trace: None,
            diagnostics,
            ledger_error: None,
        });
    }
    if !request.reranker_requested {
        request.pipeline.reranker = None;
    }
    let policy = Arc::new(TracePolicy::new(
        &request.render.config["recall"]["trace"],
        request.known_secrets,
    ));
    let context = request.pipeline.context;
    let pipeline = BudgetedPipeline::new(request.pipeline, request.filter, request.started, budget)
        .with_trace_policy(policy.clone())
        .with_soft_fallback(request.render.config["recall"]["softBudgetFallback"] != false);
    let namespace = namespace_request(request.routes, &pipeline, &request.render, &policy);
    control.timer.start("namespace_recall");
    let selected = namespaces::recall(&namespace).map_err(namespace_error)?;
    control.timer.end("namespace_recall");
    control.checkpoint(false);
    let trace = request.render.trace_enabled.then(|| {
        policy.finish(
            &request.render.prompt,
            selected
                .result
                .trace
                .as_ref()
                .unwrap_or(&Default::default()),
            request.render.now_ms as i64,
        )
    });
    let ledger_line = namespaces::retrieval_line(&namespace, &selected.result);
    request.render.trace = trace.as_ref().map(trace::prompt_view);
    // Drop the immutable render borrow before installing selected rows.
    request.render.selected = SelectedRecall {
        canonical: selected
            .result
            .canonical
            .iter()
            .cloned()
            .map(serde_json::from_value)
            .collect::<Result<_, _>>()
            .map_err(|_| malformed())?,
        memories: selected
            .result
            .memories
            .iter()
            .cloned()
            .map(serde_json::from_value)
            .collect::<Result<_, _>>()
            .map_err(|_| malformed())?,
    };
    request.render.config["recall"]["globalInjectMaxChars"] = json!(budget.cap_chars);
    if let Some(source) = request.pattern_source {
        request.render.patterns.clear();
        if request.render.config["continuityEngine"]["enabled"] != false
            && request.render.config["continuityEngine"]["patternSurfacing"]["enabled"] != false
            && control.checkpoint(true)
        {
            control.timer.start("patterns");
            match source.read_for(context, &control.cancel) {
                Ok(patterns) => request.render.patterns = patterns,
                Err(EngineError::Cancelled(_)) if control.cancel.is_cancelled() => {}
                Err(error) => return Err(error),
            }
            control.timer.end("patterns");
            control.checkpoint(false);
        }
    }
    if control.cancel.is_cancelled() {
        request.render.neo_enabled = false;
    }
    control.timer.start("render");
    let mut rendered =
        render::render_context(&request.render, request.neo).map_err(|_| malformed())?;
    control.timer.end("render");
    control.checkpoint(false);
    let degraded =
        degradation(control.stopped().or_else(|| pipeline.stopped())).or(selected.result.degraded);
    let ledger_error = if control.cancel.is_cancelled() {
        rendered.effects = RenderEffects::default();
        None
    } else if pipeline.has_children() {
        request
            .ledger
            .and_then(|ledger| ledger.append(&ledger_line).err())
    } else {
        None
    };
    Ok(RecallOutcome {
        rendered,
        degraded,
        trace,
        diagnostics,
        ledger_error,
        timing: json!({"phases":control.timer.summary(),"totalMs":control.timer.elapsed_ms(),"namespacePhases":pipeline.namespace_phases()}),
    })
}

fn namespace_request<'a>(
    routes: &'a dyn StoreRoutes,
    pipeline: &'a BudgetedPipeline<'a>,
    render: &'a RenderRequest,
    policy: &TracePolicy,
) -> NamespaceRequest<'a> {
    let recall = &render.config["recall"];
    let ceiling = recall["maxPromptMemories"]
        .as_f64()
        .filter(|n| n.is_finite())
        .unwrap_or(12.0)
        .floor()
        .clamp(1.0, 100.0);
    let count = resolve_runtime_recall_budget(&render.prompt, ceiling, &recall["adaptiveBudget"]);
    NamespaceRequest {
        routes,
        pipeline,
        agent_id: &render.context.agent_id,
        workspace_key: &render.context.workspace_identity,
        query: &render.prompt,
        timestamp_ms: render.now_ms as i64,
        ledger: None,
        rrf_k: render.config["embeddings"]["rrfK"].as_f64().unwrap_or(60.0),
        budget: MergedBudget {
            enabled: recall["adaptiveBudget"]["enabled"] != false,
            limit: count as f64,
        },
        merge: MergeOptions {
            max_out: ceiling.floor().clamp(1.0, 100.0) as usize,
            canonical_max_items: recall["canonicalMaxItems"].as_u64().unwrap_or(5) as usize,
            dedup_enabled: recall["dedup"] != false,
            dedup_jaccard: recall["dedupJaccard"].as_f64().unwrap_or(0.78),
            trace_limits: render.trace_enabled.then_some(policy.limits),
        },
    }
}

fn malformed() -> EngineError {
    EngineError::Invalid {
        field: "recall".into(),
        message: "invalid internal recall result".into(),
    }
}
fn namespace_error(error: NamespaceError) -> EngineError {
    match error {
        NamespaceError::Store(error)
        | NamespaceError::Stage(super::stages::StageError::Store(error)) => {
            EngineError::Store(error)
        }
        NamespaceError::Stage(super::stages::StageError::Embed(error)) => {
            EngineError::Embedding(error)
        }
        NamespaceError::Finalise(error) => error,
        NamespaceError::WorkerFailed => EngineError::NotAvailable {
            reason: "recall worker".into(),
        },
    }
}

/// Successful recall plus an isolated, content-free statistics side-effect failure.
/// The optional failure must not become a recall failure or enter its frozen wire result.
pub struct CountedRecall {
    /// Same result produced by the ordinary runtime.
    pub outcome: RecallOutcome,
    /// Failed sidecar delivery; no prompt, memory text or digest is included.
    pub statistics_error: Option<EngineError>,
}

/// Run an authorized foreground recall and count only its complete final rendered records.
/// Warm recall has its own read-only path and must not call this foreground entry point.
pub fn run_with_stats(
    request: RuntimeRequest<'_>,
    statistics: &crate::store::recall_stats::RecallStats,
    host: &dyn crate::contract::HostServices,
) -> Result<CountedRecall, EngineError> {
    let agent = request.pipeline.context.agent_id.clone();
    let query = request.render.prompt.clone();
    let cancel = request.pipeline.cancel;
    let outcome = run(request)?;
    let statistics_error = super::stats::record_returned(
        statistics,
        &super::stats::ReturnedRecall {
            rendered: &outcome.rendered,
            agent: agent.as_str(),
            query: &query,
            now: host.now_ms() as f64,
            warm_only: false,
            degraded: outcome.degraded.is_some(),
            cancel,
        },
    )
    .err();
    Ok(CountedRecall {
        outcome,
        statistics_error,
    })
}
