//! Post-stage-7 parity for budget, rerank, dedupe and the final ACL.
//!
//! Pipeline goldens were recorded from plugin line v7.18.31. The Rust order matches
//! that pipeline: provider ACL, rerank, budget, dedupe, final ACL. `rule_1b` asserts
//! the recorded tier concatenation. The final ACL drops a leaked foreign row and counts it.

#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::float_arithmetic,
    reason = "parity tests stop when a recorded golden disagrees with the port"
)]

#[path = "recall_support.rs"]
mod support;

use std::cmp::Ordering;
use std::sync::Mutex;

use plur1bus_engine::context::RequestContext;
use plur1bus_engine::contract::{
    AgentContext, CancelReason, Cancelled, EngineError, HostError, LlmParams, LlmPort, LlmResult,
    Principal, RerankHit,
};
use plur1bus_engine::embedding::{Cancel, RerankError, Reranker};
use plur1bus_engine::recall::acl::DenialSink;
use plur1bus_engine::recall::budget::{
    apply_recall_budget, resolve_recall_budget, BudgetResolution, TierCounts,
};
use plur1bus_engine::recall::candidate::RecallCandidate;
use plur1bus_engine::recall::filter::{CandidateFilter, DecisionRoleFilter, FilterOutcome};
use plur1bus_engine::recall::finalise::{
    apply, Decision, FinaliseFailure, FinaliseLimits, FinaliseOutput, FinaliseRequest, Guard, Saw,
};
use serde_json::{json, Value};
use support::TestHost;

#[test]
fn rule_1_tier_budget_preserves_reranker_order_when_asked() {
    replay_all(&load("G-RERANK-1.json"));
}

#[test]
fn rule_1b_tier_budget_sorts_by_score_otherwise() {
    replay_all(&load("G-RERANK-1b.json"));
}

#[test]
fn rule_3_reranker_input_is_bounded_by_max_of_top_n_and_cap() {
    replay_all(&load("G-RERANK-3.json"));
}

#[test]
fn rule_4_a_duplicate_index_counts_once() {
    replay_all(&load("G-RERANK-4.json"));
}

#[test]
fn rule_5_empty_result_is_valid_only_when_declared() {
    replay_all(&load("G-RERANK-5.json"));
}

#[test]
fn rule_6_the_reranker_never_sees_a_row_the_caller_may_not_see() {
    replay_all(&load("G-RERANK-6.json"));
    replay_all(&load("G-ACL-BEFORE-RERANK.json"));
}

#[test]
fn prefilter_removes_only_irrelevant_at_or_above_0_95() {
    assert_prefilter(named(
        &load("prefilter.json"),
        "removes-irrelevant-at-or-above-0-95",
    ));
}

#[test]
fn prefilter_timeout_keeps_every_candidate() {
    let golden = load("prefilter.json");
    assert_prefilter(named(&golden, "timeout-keeps-all"));
    assert_prefilter(named(&golden, "abort-keeps-all"));
    assert_prefilter(named(&golden, "http-error-keeps-all"));
}

#[test]
fn prefilter_judges_at_most_100_candidates() {
    let golden = load("prefilter.json");
    let over = named(&golden, "over-100-keeps-all-unjudged");
    assert_prefilter(over);
    assert_eq!(over["result"]["indices"].as_array().unwrap().len(), 150);
    assert_eq!(over["result"]["fetchCalled"], 0);
    assert_prefilter(named(&golden, "query-over-10000-keeps-all"));
    assert_prefilter(named(&golden, "state-limit-skips-the-overflowing-document"));
}

#[test]
fn dedupe_collapses_near_duplicates_after_rerank() {
    replay_all(&load("dedupe.json"));
}

#[test]
fn resolve_recall_budget_matches_the_recorded_cases() {
    for run in load("budget-resolve.json")["runs"].as_array().unwrap() {
        replay_resolve(run);
    }
}

#[test]
fn filtered_rerank_sees_only_kept_documents() {
    let rows = vec![
        sample("m0", "a1", "alpha one"),
        sample("m1", "a1", "bravo two"),
        sample("m2", "a1", "charlie three"),
    ];
    let ctx = context_for("a1");
    let cancel = Cancel::never();
    let kept = IndexFilter {
        indices: vec![1, 2],
    };
    let scripted = scripted_hits(&[json!({"index": 0, "score": 0.4})], false, None);
    let output = finish(&rows, &ctx, Some(&scripted), Some(&kept), &[], &cancel).unwrap();
    let calls = scripted.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].0,
        vec!["bravo two".to_owned(), "charlie three".to_owned()]
    );
    assert_eq!(output.ids, vec!["m1".to_owned()]);
    assert_eq!(output.rerank_scores, vec![Some(0.4)]);
    drop(calls);

    let scripted = scripted_hits(&[json!({"index": 0, "score": 1.0})], false, None);
    let output = finish(
        &rows,
        &ctx,
        Some(&scripted),
        Some(&IndexFilter {
            indices: Vec::new(),
        }),
        &[],
        &cancel,
    )
    .unwrap();
    assert!(scripted.calls.lock().unwrap().is_empty());
    assert!(output.ids.is_empty());
    assert!(output.guards.is_empty());
}

#[test]
fn finalisation_reasserts_the_acl() {
    replay_all(&load("G-ACL-FINAL.json"));
}

fn replay_all(golden: &Value) {
    for run in golden["runs"].as_array().unwrap() {
        match run["kind"].as_str() {
            Some("pipeline") => replay_pipeline(run),
            Some("budget") => replay_budget(run),
            other => panic!("unexpected golden kind {other:?} in {}", golden["id"]),
        }
    }
}

fn replay_pipeline(run: &Value) {
    let request = &run["request"];
    let rows = rows_of(&run["rows"]);
    let leaked = request
        .get("leak")
        .filter(|value| value.is_array())
        .map(rows_of)
        .unwrap_or_default();
    let ctx = context_for(request["agentId"].as_str().unwrap());
    let scripted = scripted_from(&request["rerank"]);
    let reranker = scripted.as_ref().map(|value| value as &dyn Reranker);
    let cancel = Cancel::never();
    let outcome = apply(
        &FinaliseRequest {
            query: request["query"].as_str().unwrap(),
            rows: &rows,
            context: &ctx,
            reranker,
            filter: None,
            cancel: &cancel,
            limits: limits_of(request),
            leaked: &leaked,
        },
        &NullSink,
    );
    let result = &run["result"];
    if result["threw"].as_bool().unwrap() {
        let failure = *outcome.unwrap_err();
        assert_rerank_refusal(&failure);
        assert_result(&failure.output, result);
        assert_acl_count(&failure.output, result);
        assert_saw_call(scripted.as_ref(), &failure.output.saw);
        return;
    }
    let output = outcome.unwrap_or_else(|failure| panic!("{}", failure.error));
    assert_result(&output, result);
    assert_acl_count(&output, result);
    assert_saw_call(scripted.as_ref(), &output.saw);
}

fn replay_budget(run: &Value) {
    let rows = rows_of(&run["rows"]);
    let canonical = rows_of(&run["canonical"]);
    let allocation = apply_recall_budget(
        &rows,
        &canonical,
        run["budget"].as_f64().unwrap(),
        run["preserveOrder"].as_bool().unwrap(),
    );
    assert_eq!(ids_of(&allocation.selected), strings(&run["result"]["ids"]));
    assert_counts(allocation.tier_counts, &run["result"]["tierCounts"]);
}

fn replay_resolve(run: &Value) {
    let input = &run["input"];
    let got = resolve_recall_budget(
        input["promptLength"].as_f64().unwrap(),
        input["hasProjectSignals"].as_bool().unwrap(),
        input["maxPromptMemories"].as_f64().unwrap(),
        input["tokenBudgetPct"].as_f64().unwrap(),
    );
    assert_resolution(got, &run["result"]);
}

fn assert_prefilter(run: &Value) {
    let docs = strings(&run["documents"]);
    let port = ScriptedLlm::from_run(run);
    let filter = DecisionRoleFilter::new(&port, usize_value(&run["maxStateChars"]));
    let cancel = Cancel::never();
    let outcome = filter.select(run["query"].as_str().unwrap(), &docs, &cancel);
    assert_eq!(
        outcome.indices,
        usizes(&run["result"]["indices"]),
        "{}",
        run["name"]
    );
    assert_eq!(
        outcome.fallback.as_deref(),
        expected_fallback(run),
        "{}",
        run["name"]
    );
    assert_eq!(
        outcome.evaluated,
        optional_usize(&run["result"]["evaluated"])
    );
    assert_eq!(outcome.removed, optional_usize(&run["result"]["removed"]));
    let calls = port.calls.lock().unwrap();
    assert_eq!(calls.len(), usize_value(&run["result"]["fetchCalled"]));
    if let Some(params) = calls.first() {
        let value = serde_json::to_value(params).unwrap();
        let system = value["messages"][0]["content"].as_str().unwrap();
        assert!(system.starts_with("recall-prefilter"), "{system}");
    }
}

fn expected_fallback(run: &Value) -> Option<&str> {
    match run["result"]["fallback"].as_str() {
        Some("http_error") => Some("error"),
        other => other,
    }
}

fn assert_rerank_refusal(failure: &FinaliseFailure) {
    match &failure.error {
        EngineError::NotAvailable { reason } => assert_eq!(reason, "rerank"),
        other => panic!("expected rerank refusal, got {other}"),
    }
}

fn assert_acl_count(output: &FinaliseOutput, result: &Value) {
    let traced = output
        .decisions
        .iter()
        .filter(|decision| decision.stage == "acl")
        .count();
    assert_eq!(output.acl_removed, traced);
    if let Some(removed) = result.get("aclRemoved").and_then(|value| value.as_u64()) {
        assert_eq!(output.acl_removed as u64, removed);
    }
}

fn assert_result(output: &FinaliseOutput, result: &Value) {
    assert_eq!(output.ids, strings(&result["ids"]));
    assert_scores(&output.rerank_scores, &result["rerankScores"]);
    assert_eq!(output.sources, strings(&result["sources"]));
    assert_saw(&output.saw, &result["saw"]);
    assert_decisions(&output.decisions, &result["decisions"]);
    assert_guards(&output.guards, &result["guards"]);
}

fn assert_saw_call(scripted: Option<&Scripted>, saw: &Option<Saw>) {
    let Some(scripted) = scripted else {
        assert!(saw.is_none());
        return;
    };
    let calls = scripted.calls.lock().unwrap();
    match saw {
        Some(saw) => {
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].0, saw.docs);
            assert_eq!(calls[0].1, saw.top_n);
        }
        None => assert!(calls.is_empty()),
    }
}

fn assert_scores(got: &[Option<f64>], want: &Value) {
    let want = want.as_array().unwrap();
    assert_eq!(got.len(), want.len());
    for (got, want) in got.iter().zip(want) {
        match (got, want.as_f64()) {
            (None, None) => {}
            (Some(got), Some(want)) => assert_eq!(got.total_cmp(&want), Ordering::Equal),
            (got, want) => panic!("{got:?} vs {want:?}"),
        }
    }
}

fn assert_saw(got: &Option<Saw>, want: &Value) {
    if want.is_null() {
        assert!(got.is_none());
        return;
    }
    let got = got.as_ref().unwrap();
    assert_eq!(got.docs, strings(&want["docs"]));
    assert_eq!(got.top_n, usize_value(&want["topN"]));
}

fn assert_decisions(got: &[Decision], want: &Value) {
    let want = want.as_array().unwrap();
    assert_eq!(got.len(), want.len(), "{want:?}");
    for (got, want) in got.iter().zip(want) {
        assert_eq!(got.memory_id, want["memoryId"].as_str().unwrap_or(""));
        assert_eq!(got.action, want["action"].as_str().unwrap());
        assert_eq!(got.stage, want["stage"].as_str().unwrap());
        assert_eq!(got.reason, want["reason"].as_str().unwrap());
    }
}

fn assert_guards(got: &[Guard], want: &Value) {
    let want = want.as_array().unwrap();
    assert_eq!(got.len(), want.len(), "{want:?}");
    for (got, want) in got.iter().zip(want) {
        assert_eq!(got.name, want["name"].as_str().unwrap());
        assert_eq!(got.passed, want["passed"].as_bool().unwrap());
        assert_eq!(got.reason, want["reason"].as_str().unwrap());
        assert_eq!(got.memory_id.as_deref(), want["memoryId"].as_str());
    }
}

fn assert_counts(got: TierCounts, want: &Value) {
    assert_eq!(got.core, usize_value(&want["core"]));
    assert_eq!(got.canonical, usize_value(&want["canonical"]));
    assert_eq!(got.project, usize_value(&want["project"]));
    assert_eq!(got.episodic, usize_value(&want["episodic"]));
    assert_eq!(got.associative, usize_value(&want["associative"]));
}

fn assert_resolution(got: BudgetResolution, want: &Value) {
    assert_eq!(got.reason, want["reason"].as_str().unwrap());
    assert_eq!(
        got.budget.total_cmp(&want["budget"].as_f64().unwrap()),
        Ordering::Equal
    );
}

fn finish(
    rows: &[RecallCandidate],
    ctx: &RequestContext,
    reranker: Option<&dyn Reranker>,
    filter: Option<&dyn CandidateFilter>,
    leaked: &[RecallCandidate],
    cancel: &Cancel,
) -> Result<FinaliseOutput, Box<FinaliseFailure>> {
    apply(
        &FinaliseRequest {
            query: "recall",
            rows,
            context: ctx,
            reranker,
            filter,
            cancel,
            limits: open_limits(),
            leaked,
        },
        &NullSink,
    )
}

fn open_limits() -> FinaliseLimits {
    FinaliseLimits {
        top_n: 5.0,
        budget: 10.0,
        rerank_candidates: 20.0,
        defer_final_cap: false,
        dedup_enabled: true,
        dedup_jaccard: 0.78,
        candidate_hard_limit: 100.0,
        summary_max_words: 150.0,
        reranker_fallback_on_error: true,
        canonical_count: 0.0,
    }
}

fn limits_of(request: &Value) -> FinaliseLimits {
    FinaliseLimits {
        top_n: request["topN"].as_f64().unwrap(),
        budget: request["budget"].as_f64().unwrap(),
        rerank_candidates: request["rerankCandidates"].as_f64().unwrap(),
        defer_final_cap: request["deferFinalCap"].as_bool().unwrap(),
        dedup_enabled: request["dedupEnabled"].as_bool().unwrap(),
        dedup_jaccard: request["dedupJaccard"].as_f64().unwrap(),
        candidate_hard_limit: request["candidateHardLimit"].as_f64().unwrap(),
        summary_max_words: request["summaryMaxWords"].as_f64().unwrap(),
        reranker_fallback_on_error: request["rerankerFallbackOnError"].as_bool().unwrap(),
        canonical_count: request["canonicalCount"].as_f64().unwrap(),
    }
}

fn context_for(agent: &str) -> RequestContext {
    let dir = tempfile::tempdir().unwrap();
    let host = TestHost::new(dir.path().to_path_buf());
    let principal: Principal = serde_json::from_value(json!({
        "agentId": agent,
        "workspace": "workspace:v1:agent-private",
        "channel": "",
        "accountId": "",
        "chat": {"id": "1", "kind": "direct"},
        "trust": "inferred",
    }))
    .unwrap();
    let agent_ctx: AgentContext =
        serde_json::from_value(json!({"origin": "user", "background": false})).unwrap();
    RequestContext::build(&principal, &agent_ctx, &host).unwrap()
}

fn sample(id: &str, agent: &str, text: &str) -> RecallCandidate {
    RecallCandidate {
        id: id.to_owned(),
        text: text.to_owned(),
        summary: text.to_owned(),
        category: "note".to_owned(),
        agent_id: agent.to_owned(),
        scope: "agent-private".to_owned(),
        score: Some(0.5),
        source: "vector".to_owned(),
        ..RecallCandidate::default()
    }
}

fn rows_of(value: &Value) -> Vec<RecallCandidate> {
    value.as_array().unwrap().iter().map(candidate_of).collect()
}

fn candidate_of(value: &Value) -> RecallCandidate {
    RecallCandidate {
        id: field(value, "id"),
        text: field(value, "text"),
        summary: field(value, "summary"),
        category: field(value, "category"),
        core_memory_score: value["coreMemoryScore"].as_f64().unwrap_or(0.0),
        agent_id: field(value, "agentId"),
        scope: field(value, "scope"),
        chunk_group_id: field(value, "chunkGroupId"),
        source_turn_id: field(value, "sourceTurnId"),
        valid_from: value["validFrom"].as_f64().unwrap_or(0.0),
        valid_until: value["validUntil"].as_f64().unwrap_or(0.0),
        score: value["score"].as_f64(),
        source: field(value, "source"),
        graph_source: field(value, "graphSource"),
        rerank_score: None,
    }
}

fn field(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").to_owned()
}

fn load(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/recall/golden/rerank")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn named<'a>(golden: &'a Value, name: &str) -> &'a Value {
    golden["runs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|run| run["name"] == name)
        .unwrap_or_else(|| panic!("missing run {name}"))
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_owned())
        .collect()
}

fn usizes(value: &Value) -> Vec<usize> {
    value.as_array().unwrap().iter().map(usize_value).collect()
}

fn usize_value(value: &Value) -> usize {
    value.as_u64().unwrap() as usize
}

fn optional_usize(value: &Value) -> Option<usize> {
    value.as_u64().map(|number| number as usize)
}

fn ids_of(rows: &[RecallCandidate]) -> Vec<String> {
    rows.iter().map(|row| row.id.clone()).collect()
}

fn scripted_from(value: &Value) -> Option<Scripted> {
    if value.is_null() {
        None
    } else {
        Some(scripted_hits(
            value["hits"].as_array().unwrap(),
            value["emptyResultIsValid"].as_bool().unwrap_or(false),
            value["error"].as_str(),
        ))
    }
}

fn scripted_hits(hits: &[Value], empty_valid: bool, error: Option<&str>) -> Scripted {
    Scripted {
        empty_valid,
        hits: hits.to_vec(),
        error: error.map(str::to_owned),
        calls: Mutex::new(Vec::new()),
    }
}

struct Scripted {
    empty_valid: bool,
    hits: Vec<Value>,
    error: Option<String>,
    calls: Mutex<Vec<(Vec<String>, usize)>>,
}

impl Reranker for Scripted {
    fn rerank(
        &self,
        _query: &str,
        docs: &[String],
        top_n: usize,
        _cancel: &Cancel,
    ) -> Result<Vec<RerankHit>, RerankError> {
        self.calls.lock().unwrap().push((docs.to_vec(), top_n));
        if let Some(error) = &self.error {
            return Err(if error == "timeout" {
                RerankError::Timeout
            } else {
                RerankError::Unavailable
            });
        }
        Ok(self
            .hits
            .iter()
            .map(|hit| serde_json::from_value(hit.clone()).unwrap())
            .collect())
    }

    fn empty_result_is_valid(&self) -> bool {
        self.empty_valid
    }
}

struct IndexFilter {
    indices: Vec<usize>,
}

impl CandidateFilter for IndexFilter {
    fn select(&self, _query: &str, _documents: &[String], _cancel: &Cancel) -> FilterOutcome {
        FilterOutcome {
            indices: self.indices.clone(),
            fallback: None,
            evaluated: None,
            removed: None,
        }
    }
}

struct ScriptedLlm {
    answers: Value,
    error: Option<HostError>,
    calls: Mutex<Vec<LlmParams>>,
}

impl ScriptedLlm {
    fn from_run(run: &Value) -> Self {
        let error = if run["throwName"].as_str().is_some() {
            Some(HostError::Cancelled(Cancelled {
                reason: CancelReason::Caller,
            }))
        } else if run["httpStatus"].is_number() {
            Some(HostError::Failed)
        } else {
            None
        };
        Self {
            answers: run["answers"].clone(),
            error,
            calls: Mutex::new(Vec::new()),
        }
    }
}

impl LlmPort for ScriptedLlm {
    fn complete(&self, params: LlmParams, _cancel: &Cancel) -> Result<LlmResult, HostError> {
        self.calls.lock().unwrap().push(params);
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        let text = json!({"answers": self.answers}).to_string();
        Ok(serde_json::from_value(json!({"text": text})).unwrap())
    }
}

struct NullSink;

impl DenialSink for NullSink {
    fn denied(&self, _row_id: &str, _rule: &'static str, _ctx: &RequestContext) {}
}
