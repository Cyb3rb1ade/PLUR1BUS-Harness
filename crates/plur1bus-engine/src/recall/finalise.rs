//! Post-hydration recall ordering.
//!
//! The shipped Node pipeline, after graph hydration, is provider ACL, rerank, budget,
//! Jaccard dedupe, then the final ACL filter. Phase 1 follows that order. The optional
//! filter wraps the rerank call. It is off when [`FinaliseRequest::filter`] is `None`.
//! The final ACL drops a row the caller may not see, counts the removal, and records it.

use std::collections::HashSet;

use serde_json::Number;

use super::acl::{self, AclSubject, DenialSink, Rule};
use super::budget::apply_recall_budget;
use super::candidate::RecallCandidate;
use super::dedupe::dedup_results;
use super::filter::{CandidateFilter, FilterOutcome};
use crate::context::RequestContext;
use crate::contract::{Cancel, EngineError, RerankHit};
use crate::embedding::Reranker;

const FALLBACK_REASON: &str =
    "reranker returned no valid indices or threw; falling back to unreranked topN";

/// Raw pipeline numbers. Non-finite limits follow `normalizeRecallLimit`.
#[derive(Clone, Copy, Debug)]
pub struct FinaliseLimits {
    /// Final injection cap.
    pub top_n: f64,
    /// Tier budget. `<= 0` or non-finite skips the budget. `defer_final_cap` skips it too.
    pub budget: f64,
    /// Rerank input cap. `0` means no cap. The input width is `max(top_n, cap)`.
    pub rerank_candidates: f64,
    /// Skip the budget and slice to the hard limit instead of Jaccard.
    pub defer_final_cap: bool,
    /// Run Jaccard dedupe. Ignored while `defer_final_cap` is set.
    pub dedup_enabled: bool,
    /// Jaccard threshold passed through to dedupe.
    pub dedup_jaccard: f64,
    /// Caller hard cap, normalised with fallback 100 and clamped to `1..=100`.
    pub candidate_hard_limit: f64,
    /// Word cap for [`RecallCandidate::document`] when the summary is empty.
    pub summary_max_words: f64,
    /// On a reranker error, slice the post-ACL list. Otherwise return [`EngineError::NotAvailable`].
    pub reranker_fallback_on_error: bool,
    /// Canonical rows already reserved. They reduce the dedupe slot count.
    pub canonical_count: f64,
}

/// Inputs for one post-stage-7 pass.
pub struct FinaliseRequest<'a> {
    /// User query passed to the reranker and the filter.
    pub query: &'a str,
    /// Hydrated rows, before the provider ACL that sits in front of the reranker.
    pub rows: &'a [RecallCandidate],
    /// ACL subject.
    pub context: &'a RequestContext,
    /// Absent means the rows stay in input order and the reranker is not called.
    pub reranker: Option<&'a dyn Reranker>,
    /// Absent in Phase 1. When set, it wraps the rerank call after the provider ACL.
    pub filter: Option<&'a dyn CandidateFilter>,
    /// Shared cancellation budget. The reranker is still invoked so it can report the cancel.
    pub cancel: &'a Cancel,
    /// Numeric limits.
    pub limits: FinaliseLimits,
    /// Rows appended after dedupe and before the final ACL. A foreign row is dropped there.
    pub leaked: &'a [RecallCandidate],
}

/// What the reranker was given. `None` when it was not called.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Saw {
    /// Documents, after the summary fallback.
    pub docs: Vec<String>,
    /// `topN` argument of the rerank call.
    pub top_n: usize,
}

/// One trace decision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    /// Memory id, or empty when the row had none.
    pub memory_id: String,
    /// `rejection` or `deduped`.
    pub action: String,
    /// Pipeline stage name.
    pub stage: String,
    /// Pipeline reason string.
    pub reason: String,
}

/// One trace guard.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Guard {
    /// Guard name. ACL denials use `acl` even when the decision stage differs.
    pub name: String,
    /// `false` for the denials and the rerank fallback this stage records.
    pub passed: bool,
    /// Rule name or the rerank fallback sentence.
    pub reason: String,
    /// Memory id. Absent on the rerank fallback guard.
    pub memory_id: Option<String>,
}

/// Ordered rows and the trace collected on the way.
#[derive(Clone, Debug, PartialEq)]
pub struct FinaliseOutput {
    /// Kept ids.
    pub ids: Vec<String>,
    /// Rerank ceiling scores. `None` when that row was not reranked.
    pub rerank_scores: Vec<Option<f64>>,
    /// `source` of each kept row.
    pub sources: Vec<String>,
    /// Reranker inputs. `None` when the reranker was not called.
    pub saw: Option<Saw>,
    /// Decisions in emission order.
    pub decisions: Vec<Decision>,
    /// Guards in emission order.
    pub guards: Vec<Guard>,
    /// Rows removed by the final ACL. Matches the decisions whose stage is `acl`.
    pub acl_removed: usize,
}

/// A rerank refusal, with the trace collected before the return.
#[derive(Debug)]
pub struct FinaliseFailure {
    /// `NotAvailable { reason: "rerank" }`.
    pub error: EngineError,
    /// Partial trace. Ids are empty: the pipeline did not return a result list.
    pub output: FinaliseOutput,
}

#[derive(Default)]
struct Trace {
    decisions: Vec<Decision>,
    guards: Vec<Guard>,
}

struct Ranked {
    ordered: Vec<RecallCandidate>,
    applied: bool,
    saw: Option<Saw>,
    guard: bool,
}

struct Abort {
    saw: Option<Saw>,
}

enum Invoke {
    Ranked {
        hits: Vec<RerankHit>,
        empty_valid: bool,
    },
    Failed,
}

/// Run provider ACL, rerank, budget, dedupe and the final ACL.
///
/// # Errors
///
/// Returns [`FinaliseFailure`] when the reranker fails and fallback is off.
/// A row the final ACL rejects is dropped, counted, and named in the trace.
pub fn apply(
    request: &FinaliseRequest<'_>,
    sink: &dyn DenialSink,
) -> Result<FinaliseOutput, Box<FinaliseFailure>> {
    let mut trace = Trace::default();
    let boosted = provider_filter(request.rows, request.context, sink, &mut trace);
    let ranked = match rerank_stage(request, &boosted) {
        Ok(ranked) => ranked,
        Err(abort) => {
            return Err(Box::new(failure(
                EngineError::NotAvailable {
                    reason: "rerank".to_owned(),
                },
                abort.saw,
                trace,
            )));
        }
    };
    if ranked.guard {
        trace.guards.push(rerank_guard());
    }
    let budgeted = budget_stage(&ranked.ordered, request, ranked.applied, &mut trace);
    let mut finished = dedupe_stage(&budgeted, request, &mut trace);
    finished.extend(request.leaked.iter().cloned());
    let (rows, acl_removed) = final_acl(&finished, request.context, sink, &mut trace);
    Ok(output_of(&rows, ranked.saw, trace, acl_removed))
}

fn provider_filter(
    rows: &[RecallCandidate],
    ctx: &RequestContext,
    sink: &dyn DenialSink,
    trace: &mut Trace,
) -> Vec<RecallCandidate> {
    let mut kept = Vec::new();
    for row in rows {
        match access(row, ctx) {
            Ok(()) => kept.push(row.clone()),
            Err(rule) => note_acl(trace, sink, ctx, row, "provider-acl", rule),
        }
    }
    kept
}

fn rerank_stage(
    request: &FinaliseRequest<'_>,
    boosted: &[RecallCandidate],
) -> Result<Ranked, Abort> {
    let Some(reranker) = request.reranker else {
        return Ok(passthrough(boosted));
    };
    if boosted.len() <= 1 {
        return Ok(passthrough(boosted));
    }
    let hard = hard_limit(request.limits.candidate_hard_limit);
    let top_n = finite_usize(request.limits.top_n);
    let input = rerank_input(boosted, top_n, request.limits.rerank_candidates);
    let docs: Vec<String> = input
        .iter()
        .map(|row| row.document(finite_usize(request.limits.summary_max_words)))
        .collect();
    let rerank_limit = rerank_limit(request, hard, top_n);
    let saw = Some(Saw {
        docs: docs.clone(),
        top_n: rerank_limit,
    });
    match invoke(
        reranker,
        request.filter,
        request.query,
        &docs,
        rerank_limit,
        request.cancel,
    ) {
        Invoke::Failed if request.limits.reranker_fallback_on_error => {
            Ok(fallback_ranked(boosted, request, saw))
        }
        Invoke::Failed => Err(Abort { saw }),
        Invoke::Ranked { hits, empty_valid } => Ok(order_hits(
            boosted,
            &input,
            &hits,
            empty_valid,
            request,
            saw,
        )),
    }
}

fn passthrough(rows: &[RecallCandidate]) -> Ranked {
    Ranked {
        ordered: rows.to_vec(),
        applied: false,
        saw: None,
        guard: false,
    }
}

fn rerank_input(
    boosted: &[RecallCandidate],
    top_n: usize,
    rerank_candidates: f64,
) -> Vec<RecallCandidate> {
    let cap = normalize_recall_limit(rerank_candidates, 0.0);
    if cap == 0 {
        boosted.to_vec()
    } else {
        boosted.iter().take(top_n.max(cap)).cloned().collect()
    }
}

fn rerank_limit(request: &FinaliseRequest<'_>, hard: usize, top_n: usize) -> usize {
    if request.limits.defer_final_cap {
        hard
    } else if request.limits.dedup_enabled {
        top_n.saturating_mul(2)
    } else {
        top_n
    }
}

fn fallback_ranked(
    boosted: &[RecallCandidate],
    request: &FinaliseRequest<'_>,
    saw: Option<Saw>,
) -> Ranked {
    let hard = hard_limit(request.limits.candidate_hard_limit);
    let top_n = finite_usize(request.limits.top_n);
    let width = if request.limits.defer_final_cap {
        hard
    } else {
        top_n
    };
    Ranked {
        ordered: boosted.iter().take(width).cloned().collect(),
        applied: false,
        saw,
        guard: true,
    }
}

fn invoke(
    reranker: &dyn Reranker,
    filter: Option<&dyn CandidateFilter>,
    query: &str,
    docs: &[String],
    rerank_limit: usize,
    cancel: &Cancel,
) -> Invoke {
    let Some(filter) = filter else {
        return match reranker.rerank(query, docs, rerank_limit, cancel) {
            Ok(hits) => Invoke::Ranked {
                hits,
                empty_valid: reranker.empty_result_is_valid(),
            },
            Err(_) => Invoke::Failed,
        };
    };
    let outcome = filter.select(query, docs, cancel);
    let indices = accepted_indices(&outcome, docs.len());
    if indices.is_empty() {
        return Invoke::Ranked {
            hits: Vec::new(),
            empty_valid: true,
        };
    }
    let subset: Vec<String> = indices.iter().map(|index| docs[*index].clone()).collect();
    let top_n = rerank_limit.min(indices.len());
    match reranker.rerank(query, &subset, top_n, cancel) {
        Ok(hits) => match map_ranked(&hits, &indices) {
            Some(hits) => Invoke::Ranked {
                hits,
                empty_valid: false,
            },
            None => Invoke::Failed,
        },
        Err(_) => Invoke::Failed,
    }
}

fn accepted_indices(outcome: &FilterOutcome, len: usize) -> Vec<usize> {
    if outcome.indices.iter().any(|index| *index >= len) {
        return (0..len).collect();
    }
    let mut seen = HashSet::new();
    outcome
        .indices
        .iter()
        .copied()
        .filter(|index| seen.insert(*index))
        .collect()
}

fn map_ranked(ranked: &[RerankHit], indices: &[usize]) -> Option<Vec<RerankHit>> {
    let mut mapped = Vec::new();
    for hit in ranked {
        let Some(local) = integer_index(&hit.index, indices.len()) else {
            continue;
        };
        mapped.push(RerankHit {
            index: Number::from(indices[local] as u64),
            score: hit.score.clone(),
        });
    }
    if mapped.is_empty() {
        None
    } else {
        Some(mapped)
    }
}

fn order_hits(
    boosted: &[RecallCandidate],
    input: &[RecallCandidate],
    hits: &[RerankHit],
    empty_valid: bool,
    request: &FinaliseRequest<'_>,
    saw: Option<Saw>,
) -> Ranked {
    let valid = valid_hits(hits, input.len());
    if valid.is_empty() && empty_valid {
        return Ranked {
            ordered: Vec::new(),
            applied: false,
            saw,
            guard: false,
        };
    }
    if valid.is_empty() {
        return fallback_ranked(boosted, request, saw);
    }
    Ranked {
        ordered: apply_ceiling(input, &valid),
        applied: true,
        saw,
        guard: false,
    }
}

fn valid_hits(hits: &[RerankHit], len: usize) -> Vec<(usize, f64)> {
    let mut seen = HashSet::new();
    let mut valid = Vec::new();
    for hit in hits {
        let Some(index) = integer_index(&hit.index, len) else {
            continue;
        };
        if !seen.insert(index) {
            continue;
        }
        let score = hit.score.as_f64().filter(|score| score.is_finite());
        valid.push((index, score.unwrap_or(f64::NAN)));
    }
    // Positional scores are filled once the valid list length is known.
    let total = valid.len();
    valid
        .into_iter()
        .enumerate()
        .map(|(position, (index, score))| {
            let score = if score.is_finite() {
                score
            } else {
                positional(position, total)
            };
            (index, score)
        })
        .collect()
}

fn apply_ceiling(input: &[RecallCandidate], valid: &[(usize, f64)]) -> Vec<RecallCandidate> {
    let mut ceiling = f64::INFINITY;
    let mut ordered = Vec::new();
    for (index, score) in valid {
        ceiling = ceiling.min(*score);
        let mut row = input[*index].clone();
        row.rerank_score = Some(ceiling);
        ordered.push(row);
    }
    ordered
}

fn budget_stage(
    ordered: &[RecallCandidate],
    request: &FinaliseRequest<'_>,
    applied: bool,
    trace: &mut Trace,
) -> Vec<RecallCandidate> {
    let budget_open = request.limits.budget.partial_cmp(&0.0) == Some(std::cmp::Ordering::Greater);
    if request.limits.defer_final_cap || ordered.is_empty() || !budget_open {
        return ordered.to_vec();
    }
    let before: Vec<String> = ordered.iter().map(|row| row.id.clone()).collect();
    let allocation = apply_recall_budget(ordered, &[], request.limits.budget, applied);
    note_missing(
        trace,
        &before,
        &allocation.selected,
        "rejection",
        "recall-budget",
        "budget cap",
    );
    allocation.selected
}

fn dedupe_stage(
    ordered: &[RecallCandidate],
    request: &FinaliseRequest<'_>,
    trace: &mut Trace,
) -> Vec<RecallCandidate> {
    let hard = hard_limit(request.limits.candidate_hard_limit);
    let top_n = finite_usize(request.limits.top_n);
    let slots = if request.limits.defer_final_cap {
        hard
    } else {
        top_n.saturating_sub(finite_usize(request.limits.canonical_count))
    };
    let before: Vec<String> = ordered.iter().map(|row| row.id.clone()).collect();
    let kept = if request.limits.defer_final_cap || !request.limits.dedup_enabled {
        ordered.iter().take(slots).cloned().collect()
    } else {
        dedup_results(ordered, slots, request.limits.dedup_jaccard)
    };
    note_missing(
        trace,
        &before,
        &kept,
        "deduped",
        "jaccard-dedup",
        "duplicate or beyond slot limit",
    );
    kept
}

fn final_acl(
    rows: &[RecallCandidate],
    ctx: &RequestContext,
    sink: &dyn DenialSink,
    trace: &mut Trace,
) -> (Vec<RecallCandidate>, usize) {
    let mut kept = Vec::new();
    let mut removed = 0;
    for row in rows {
        match access(row, ctx) {
            Ok(()) => kept.push(row.clone()),
            Err(rule) => {
                note_acl(trace, sink, ctx, row, "acl", rule);
                removed += 1;
            }
        }
    }
    (kept, removed)
}

fn access(row: &RecallCandidate, ctx: &RequestContext) -> Result<(), Rule> {
    let memory = row.acl_memory();
    acl::check_access(Some(&AclSubject::from_context(ctx)), Some(&memory))
}

fn note_acl(
    trace: &mut Trace,
    sink: &dyn DenialSink,
    ctx: &RequestContext,
    row: &RecallCandidate,
    stage: &str,
    rule: Rule,
) {
    sink.denied(&row.id, rule.name(), ctx);
    trace.guards.push(Guard {
        name: "acl".to_owned(),
        passed: false,
        reason: rule.name().to_owned(),
        memory_id: Some(row.id.clone()),
    });
    trace.decisions.push(Decision {
        memory_id: row.id.clone(),
        action: "rejection".to_owned(),
        stage: stage.to_owned(),
        reason: rule.name().to_owned(),
    });
}

fn note_missing(
    trace: &mut Trace,
    before: &[String],
    kept: &[RecallCandidate],
    action: &str,
    stage: &str,
    reason: &str,
) {
    let selected: HashSet<&str> = kept.iter().map(|row| row.id.as_str()).collect();
    for id in before {
        if !selected.contains(id.as_str()) {
            trace.decisions.push(Decision {
                memory_id: id.clone(),
                action: action.to_owned(),
                stage: stage.to_owned(),
                reason: reason.to_owned(),
            });
        }
    }
}

fn rerank_guard() -> Guard {
    Guard {
        name: "rerank".to_owned(),
        passed: false,
        reason: FALLBACK_REASON.to_owned(),
        memory_id: None,
    }
}

fn output_of(
    rows: &[RecallCandidate],
    saw: Option<Saw>,
    trace: Trace,
    acl_removed: usize,
) -> FinaliseOutput {
    FinaliseOutput {
        ids: rows.iter().map(|row| row.id.clone()).collect(),
        rerank_scores: rows.iter().map(|row| row.rerank_score).collect(),
        sources: rows.iter().map(|row| row.source.clone()).collect(),
        saw,
        decisions: trace.decisions,
        guards: trace.guards,
        acl_removed,
    }
}

fn failure(error: EngineError, saw: Option<Saw>, trace: Trace) -> FinaliseFailure {
    FinaliseFailure {
        error,
        output: output_of(&[], saw, trace, 0),
    }
}

fn integer_index(number: &Number, len: usize) -> Option<usize> {
    let value = number.as_f64()?;
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 {
        return None;
    }
    let index = value as usize;
    if index as f64 != value || index >= len {
        None
    } else {
        Some(index)
    }
}

fn positional(position: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        (total - position) as f64 / total as f64
    }
}

fn normalize_recall_limit(value: f64, fallback: f64) -> usize {
    let chosen = if value.is_finite() { value } else { fallback };
    finite_usize(chosen)
}

fn hard_limit(value: f64) -> usize {
    normalize_recall_limit(value, 100.0).clamp(1, 100)
}

fn finite_usize(value: f64) -> usize {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    let floored = value.floor();
    if floored >= usize::MAX as f64 {
        usize::MAX
    } else {
        floored as usize
    }
}
