//! Recall stages 1–7: embed, search, temporal, knowledge, score, graph.
//!
//! Budget, Jaccard dedupe and rerank run afterwards in [`super::finalise`]. With
//! `defer_final_cap` the pinned pipeline skips the budget and replaces dedupe with a
//! hard-limit slice. Query refinement (RE-D151) runs the pin's deterministic refiner
//! when no hit reaches the minimum score: a second search, merged by id (higher score
//! wins), with a `query-refinement` trace guard. The pinned engine emits no skip trace
//! when `queryRefinerEnabled` is false.
//!
//! `clocks.now_ms` is the pipeline `now` (lifecycle and expiry). `clocks.temporal_now_ms`
//! is `Date.now()`, which `parseTemporal` reads instead of that argument. The stage
//! recorder freezes both to the same instant.

use std::path::Path;

use crate::context::RequestContext;
use crate::contract::{MemoryRow, StoreError};
use crate::embedding::{Cancel, EmbedError, EmbedKind, EmbeddingProvider};
use crate::store::{RowFilter, Store};

use super::acl::{self, DenialSink};
use super::graph::{
    cap_graph_score, edges_between, lance_stored_relevance, reachable_endpoint_ids,
    reembedded_relevance, relevance_below_threshold, relevance_reason, traverse_observed,
    GraphEdge, HYDRATION_RELEVANCE_THRESHOLD,
};
use super::knowledge::{self, CanonicalHit};
use super::lifecycle::{self, epoch};
use super::namespace_observation::Observations;
use super::namespace_trace::{NamespaceTrace, TraceLimits};
use super::score::{self, distance_to_score};
use super::temporal::{self, range_from_anchor, Temporal};

/// Limits copied from the pipeline arguments.
#[derive(Clone, Debug)]
pub struct StageLimits {
    /// Final injection cap. The deferred path does not apply it before stage 7.
    pub top_n: usize,
    /// Requested ANN width, then capped by the hard limit.
    pub candidate_top_k: usize,
    /// Caller hard cap, itself capped at 100.
    pub candidate_hard_limit: usize,
    /// Minimum vector score. The function default in Node is 0.15.
    pub recall_min_score: f64,
    /// Minimum canonical cosine. The function default is 0.30.
    pub canonical_min_score: f64,
    /// Maximum canonical sections.
    pub canonical_max_items: usize,
}

/// Switches for the stages this task owns.
#[derive(Clone, Debug)]
pub struct StageFlags {
    /// Read `memory/KNOWLEDGE.md` when a workspace is set.
    pub canonical: bool,
    /// Walk `edges` after scoring.
    pub associative: bool,
    /// Skip the budget and slice to the hard limit instead of Jaccard.
    pub defer_final_cap: bool,
    /// Node runs refinement only when this is true. T2 leaves it false.
    pub query_refiner: bool,
    /// Write the knowledge cache. A warm-only recall would set this false.
    pub persist_knowledge: bool,
}

/// The two clocks the pinned pipeline keeps separate.
#[derive(Clone, Debug)]
pub struct StageClocks {
    /// Lifecycle, expiry and graph authorization.
    pub now_ms: i64,
    /// Clock `parseTemporal` reads via `Date.now()`.
    pub temporal_now_ms: i64,
    /// Bi-temporal instant. `None` means no valid-time predicate and the createdAt parser runs.
    pub valid_at: Option<i64>,
}

/// Inputs for one stage-7 recall.
pub struct StageInput<'a> {
    /// User query. Temporal parsing and the embedder both see it.
    pub query: &'a str,
    /// Lance table. Vector search uses an empty status predicate.
    pub store: &'a Store,
    /// Query embeddings, and passage embeddings for knowledge sections.
    pub embedder: &'a dyn EmbeddingProvider,
    /// ACL subject. Built request contexts convert through [`acl::AclSubject::from_context`].
    pub context: &'a RequestContext,
    /// Workspace that holds `memory/KNOWLEDGE.md`.
    pub workspace_dir: Option<&'a Path>,
    /// In-memory edges. The golden graph is unbound.
    pub edges: &'a [GraphEdge],
    /// Authorized Neo source read after providers, immediately before traversal.
    pub bound_graph: Option<&'a super::graph_source::BoundGraphSource>,
    /// Committed-deletion mask applied after the ACL to every row source (RE-D153).
    pub tombstones: Option<&'a super::tombstone_mask::TombstoneMask>,
    /// Numeric limits.
    pub limits: StageLimits,
    /// Stage switches.
    pub flags: StageFlags,
    /// Lifecycle clock, temporal clock and optional valid time.
    pub clocks: StageClocks,
}

/// Ordered stage-7 memories plus the canonical list and rejection trace.
#[derive(Clone, Debug)]
pub struct StageSnapshot {
    /// Owned hydrated rows; row, score and provenance cannot become misaligned.
    pub hydrated: Vec<HydratedMemory>,
    /// Observations emitted at the actual stage boundaries, excluding T6 wall-clock fields.
    pub trace: NamespaceTrace,
    /// Query vector shared with namespace merge.
    pub query_vector: Vec<f32>,
    /// Initial live, authorized vector ids for child-trace replay.
    pub candidate_ids: Vec<String>,
    /// Memory ids after hydration, the deferred slice and the final ACL.
    pub ordered_ids: Vec<String>,
    /// Scores in the same order, before rounding.
    pub scores: Vec<f64>,
    /// Canonical sections that cleared `canonical_min_score`.
    pub canonical: Vec<CanonicalHit>,
    /// Trace decisions whose action is `rejection`, in emission order.
    pub rejections: Vec<Rejection>,
}

impl PartialEq for StageSnapshot {
    fn eq(&self, other: &Self) -> bool {
        self.ordered_ids == other.ordered_ids
            && self.scores == other.scores
            && self.canonical == other.canonical
            && self.rejections == other.rejections
            && self.trace == other.trace
            && self.query_vector == other.query_vector
            && self.candidate_ids == other.candidate_ids
            && hydrated_equal(&self.hydrated, &other.hydrated)
    }
}

/// A hydrated row moved from the hit list, including its originating graph depth.
#[derive(Clone, Debug, serde::Serialize)]
pub struct HydratedMemory {
    /// Persisted row with its full authorization binding.
    pub row: MemoryRow,
    /// Score at the end of hydration.
    pub score: f64,
    /// Vector, graph or overlapping source.
    pub source: &'static str,
    /// Present only for graph-only wrappers.
    pub depth: Option<usize>,
}

/// One rejection decision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rejection {
    /// Memory id, or empty when the row had none.
    pub memory_id: String,
    /// Pipeline stage name.
    pub stage: String,
    /// Pipeline reason string.
    pub reason: String,
}

/// A store or embedding failure while running the stages.
#[derive(Debug)]
pub enum StageError {
    /// The Lance read failed.
    Store(StoreError),
    /// The query embedding failed. Section failures are caught and do not use this variant.
    Embed(EmbedError),
}

impl std::fmt::Display for StageError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(error) => write!(formatter, "{error}"),
            Self::Embed(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for StageError {}

#[derive(Clone)]
struct Hit {
    depth: Option<usize>,
    id: String,
    row: Option<MemoryRow>,
    score: f64,
    source: &'static str,
}

/// Run embed through graph hydration, then the deferred slice and the final ACL.
///
/// # Errors
///
/// Returns [`StageError`] when the query embedding or a Lance read fails.
pub fn run_through_stage_7(
    input: &StageInput<'_>,
    sink: &dyn DenialSink,
) -> Result<StageSnapshot, StageError> {
    run_observed_stage_7(input, sink, None, None)
}

/// Run the same stages with stage-local observations and an optional emotional state.
pub fn run_observed_stage_7(
    input: &StageInput<'_>,
    sink: &dyn DenialSink,
    trace: Option<TraceLimits>,
    emotion: Option<&dyn score::EmotionalRecallState>,
) -> Result<StageSnapshot, StageError> {
    run_controlled_stage_7(
        input,
        sink,
        trace,
        emotion,
        &mut super::control::RecallControl::unbounded(),
    )
}

/// Run the production stages with a request budget, keeping only authorized partial rows.
/// The control's stop classification distinguishes a soft fast path from timeout/abort.
pub fn run_controlled_stage_7(
    input: &StageInput<'_>,
    sink: &dyn DenialSink,
    trace: Option<TraceLimits>,
    emotion: Option<&dyn score::EmotionalRecallState>,
    control: &mut super::control::RecallControl,
) -> Result<StageSnapshot, StageError> {
    let cancel = control.cancel.clone();
    let embedder = super::control::BoundEmbedder {
        provider: input.embedder,
        cancel: &cancel,
    };
    let bounded = StageInput {
        embedder: &embedder,
        limits: input.limits.clone(),
        flags: input.flags.clone(),
        clocks: input.clocks.clone(),
        ..*input
    };
    run_stages(&bounded, sink, trace, emotion, control)
}

#[derive(Default)]
struct Progress {
    hits: Vec<Hit>,
    vector: Vec<f32>,
    candidates: Vec<String>,
    canonical: Vec<CanonicalHit>,
    rejections: Vec<Rejection>,
    scored: bool,
}

fn run_stages(
    input: &StageInput<'_>,
    sink: &dyn DenialSink,
    trace: Option<TraceLimits>,
    emotion: Option<&dyn score::EmotionalRecallState>,
    control: &mut super::control::RecallControl,
) -> Result<StageSnapshot, StageError> {
    let mut state = Progress::default();
    let mut observations = Observations::new(trace, control.trace_policy.clone());
    macro_rules! phase {
        ($name:literal, $soft:literal, $body:expr) => {{
            if !control.checkpoint($soft) {
                return Ok(finish_progress(input, sink, state, observations, control));
            }
            control.timer.start($name);
            let result = stage_result(|| $body);
            control.timer.end($name);
            if let Err(error) = result {
                control.timer.fail($name);
                // Only cancellation becomes partial success. Store/identity failures still fail closed.
                if matches!(error, StageError::Embed(EmbedError::Cancelled(_)))
                    && !control.checkpoint(false) {
                    return Ok(finish_progress(input, sink, state, observations, control));
                }
                return Err(error);
            }
        }};
    }
    phase!("embedding", false, {
        state.vector = embed_query(input)?;
        Ok(())
    });
    phase!("vector_search", false, {
        state.hits = search_hits(
            input,
            &state.vector,
            "initial-acl",
            sink,
            &mut state.rejections,
        )?;
        observations.rejections(&state.rejections);
        state.candidates = state.hits.iter().map(|hit| hit.id.clone()).collect();
        observe_vectors(&mut observations, &state.hits);
        Ok(())
    });
    phase!("query_refinement", true, {
        if input.flags.query_refiner
            && should_refine_query(&state.hits, input.limits.recall_min_score)
        {
            if let Some(merged) = refine_hits(input, &state.hits, sink, &mut state.rejections)? {
                state.hits = merged;
                observations.rejections(&state.rejections);
                observations.guard(
                    "query-refinement",
                    true,
                    &format!(
                        "refinement triggered; merged {} unique results",
                        state.hits.len()
                    ),
                    None,
                );
            }
        }
        Ok(())
    });
    phase!("temporal", true, {
        state.hits = apply_temporal(input, &mut state.hits, &mut state.rejections)?;
        observations.rejections(&state.rejections);
        Ok(())
    });
    phase!("canonical", true, {
        state.canonical = canonical_hits(input, &state.vector, &control.cancel);
        for hit in &state.canonical {
            observations.canonical(hit);
        }
        Ok(())
    });
    phase!("scoring", true, {
        state.hits = score_hits(std::mem::take(&mut state.hits), emotion);
        state.scored = true;
        observations.scoring(
            state
                .hits
                .iter()
                .filter_map(|hit| hit.row.as_ref().map(|row| (row, hit.score))),
            emotion.is_some(),
        );
        reject_inactive(input, &mut state.hits, &mut state.rejections);
        observations.rejections(&state.rejections);
        Ok(())
    });
    phase!("graph", true, {
        state.hits = spread_graph(
            input,
            std::mem::take(&mut state.hits),
            sink,
            &mut state.rejections,
            &mut observations,
            &control.cancel,
        )?;
        Ok(())
    });
    phase!("graph_hydration", true, {
        state.hits = hydrate(
            input,
            std::mem::take(&mut state.hits),
            &state.vector,
            sink,
            &mut state.rejections,
        )?;
        observations.rejections(&state.rejections);
        Ok(())
    });
    control.checkpoint(true);
    Ok(finish_progress(input, sink, state, observations, control))
}

// Capture `?` inside the phase so timing is closed before propagating its failure.
fn stage_result(run: impl FnOnce() -> Result<(), StageError>) -> Result<(), StageError> {
    run()
}

fn finish_progress(
    input: &StageInput<'_>,
    sink: &dyn DenialSink,
    mut state: Progress,
    mut observations: Observations,
    control: &super::control::RecallControl,
) -> StageSnapshot {
    if control.stopped().is_some() && !state.scored {
        // The pinned early exit applies strength once, without later emotion/epistemic stages.
        for hit in &mut state.hits {
            if let Some(row) = &hit.row {
                hit.score += score::strength_adjustment(lifecycle::number(&row.memory_strength));
            }
        }
        state
            .hits
            .sort_by(|left, right| right.score.total_cmp(&left.score));
    }
    state
        .hits
        .retain(|hit| acl_allows(input, hit, "acl", sink, &mut state.rejections));
    state.hits.truncate(slice_limit(input));
    observations.rejections(&state.rejections);
    if control.stopped() == Some(super::control::Stop::SoftBudget) {
        observations.guard("soft-budget", false, "soft_budget_fallback", None);
        if let Some(guard) = observations.trace.guards.last_mut() {
            guard["phaseSummary"] = control.timer.summary();
        }
    }
    snapshot(
        state.hits,
        state.vector,
        state.candidates,
        state.canonical,
        state.rejections,
        observations.trace,
    )
}

fn snapshot(
    hits: Vec<Hit>,
    query_vector: Vec<f32>,
    candidate_ids: Vec<String>,
    canonical: Vec<CanonicalHit>,
    rejections: Vec<Rejection>,
    trace: NamespaceTrace,
) -> StageSnapshot {
    let hydrated = hits
        .into_iter()
        .filter_map(|hit| {
            hit.row.map(|row| HydratedMemory {
                row,
                score: hit.score,
                source: hit.source,
                depth: hit.depth,
            })
        })
        .collect::<Vec<_>>();
    StageSnapshot {
        ordered_ids: hydrated.iter().map(|hit| hit.row.id.clone()).collect(),
        scores: hydrated.iter().map(|hit| hit.score).collect(),
        hydrated,
        query_vector,
        candidate_ids,
        canonical,
        rejections,
        trace,
    }
}

fn embed_query(input: &StageInput<'_>) -> Result<Vec<f32>, StageError> {
    let query = shorten(input.query);
    let vectors = input
        .embedder
        .embed(&[query], EmbedKind::Query, &Cancel::never())
        .map_err(StageError::Embed)?;
    vectors
        .into_iter()
        .next()
        .ok_or(StageError::Embed(EmbedError::InvalidVector))
}

fn shorten(query: &str) -> String {
    const LIMIT: usize = 20_000;
    if query.chars().count() <= LIMIT {
        return query.to_owned();
    }
    query.chars().skip(query.chars().count() - LIMIT).collect()
}

fn search_hits(
    input: &StageInput<'_>,
    query_vector: &[f32],
    acl_stage: &str,
    sink: &dyn DenialSink,
    rejections: &mut Vec<Rejection>,
) -> Result<Vec<Hit>, StageError> {
    let hits = read_hits(input, query_vector, acl_stage, sink, rejections)?;
    retain_unmasked(input, hits, rejections)
}

/// Vector read, score filter, lifecycle and ACL; the tombstone mask is applied separately.
fn read_hits(
    input: &StageInput<'_>,
    query_vector: &[f32],
    acl_stage: &str,
    sink: &dyn DenialSink,
    rejections: &mut Vec<Rejection>,
) -> Result<Vec<Hit>, StageError> {
    let filter = RowFilter {
        valid_at: input.clocks.valid_at,
        ..RowFilter::default()
    };
    let found = input
        .store
        .search(query_vector, fetch_limit(input), &filter)
        .map_err(StageError::Store)?;
    let mut hits = Vec::new();
    for scored in found {
        let score = distance_to_score(f64::from(scored.distance));
        if score < input.limits.recall_min_score {
            continue;
        }
        hits.push(Hit {
            depth: None,
            id: scored.row.id.clone(),
            row: Some(scored.row),
            score,
            source: "vector",
        });
    }
    reject_inactive(input, &mut hits, rejections);
    hits.retain(|hit| acl_allows(input, hit, acl_stage, sink, rejections));
    Ok(hits)
}

/// RE-D153: drop rows whose owner committed their deletion. Only the id and a fixed
/// reason are recorded. An unreadable registry fails the stage; it never reads unmasked.
fn retain_unmasked(
    input: &StageInput<'_>,
    hits: Vec<Hit>,
    rejections: &mut Vec<Rejection>,
) -> Result<Vec<Hit>, StageError> {
    let mut kept = Vec::with_capacity(hits.len());
    for hit in hits {
        if masked(input, &hit, rejections)? {
            continue;
        }
        kept.push(hit);
    }
    Ok(kept)
}

fn masked(
    input: &StageInput<'_>,
    hit: &Hit,
    rejections: &mut Vec<Rejection>,
) -> Result<bool, StageError> {
    let (Some(mask), Some(row)) = (input.tombstones, hit.row.as_ref()) else {
        return Ok(false);
    };
    if !mask.masks(row).map_err(StageError::Store)? {
        return Ok(false);
    }
    rejections.push(Rejection {
        memory_id: hit.id.clone(),
        stage: "tombstone".to_owned(),
        reason: "tombstoned".to_owned(),
    });
    Ok(true)
}

/// The pin's refined second search. Cancellation escapes; any other embedding or read
/// failure keeps the original hits, as the pin's `catch` does. The tombstone mask has no
/// pin counterpart: an unreadable registry fails the stage, as in every other source.
fn refine_hits(
    input: &StageInput<'_>,
    hits: &[Hit],
    sink: &dyn DenialSink,
    rejections: &mut Vec<Rejection>,
) -> Result<Option<Vec<Hit>>, StageError> {
    let top = hits.first().map(|hit| super::query_refiner::RefinementTop {
        score: Some(hit.score),
        entry: hit
            .row
            .as_ref()
            .map(|row| (row.summary.as_str(), row.text.as_str())),
    });
    let refined = super::query_refiner::refine_query(input.query, top);
    let vector = match input
        .embedder
        .embed(&[refined], EmbedKind::Query, &Cancel::never())
    {
        Ok(vectors) => match vectors.into_iter().next() {
            Some(vector) => vector,
            None => return Ok(None),
        },
        Err(error @ EmbedError::Cancelled(_)) => return Err(StageError::Embed(error)),
        Err(_) => return Ok(None),
    };
    let mut found = Vec::new();
    let refined = match read_hits(input, &vector, "refined-acl", sink, &mut found) {
        Ok(refined) => refined,
        Err(_) => return Ok(None),
    };
    // RE-D153 review N1: a mask failure is not a read failure and is never swallowed.
    let refined = retain_unmasked(input, refined, &mut found)?;
    rejections.extend(found);
    let mut combined = hits.to_vec();
    for hit in refined {
        match combined.iter_mut().find(|existing| existing.id == hit.id) {
            Some(existing) if hit.score > existing.score => *existing = hit,
            Some(_) => {}
            None => combined.push(hit),
        }
    }
    combined.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(Some(combined))
}

fn fetch_limit(input: &StageInput<'_>) -> usize {
    let hard = input.limits.candidate_hard_limit.clamp(1, 100);
    if input.clocks.valid_at.is_some() {
        return hard;
    }
    let top_k = input.limits.candidate_top_k.max(1).min(hard);
    input.limits.top_n.max(top_k).min(hard)
}

fn apply_temporal(
    input: &StageInput<'_>,
    hits: &mut Vec<Hit>,
    rejections: &mut Vec<Rejection>,
) -> Result<Vec<Hit>, StageError> {
    if input.clocks.valid_at.is_some() || hits.is_empty() {
        return Ok(std::mem::take(hits));
    }
    let Some(temporal) = temporal::parse_temporal(input.query, input.clocks.temporal_now_ms) else {
        return Ok(std::mem::take(hits));
    };
    let temporal = resolve_anchor(input, temporal)?;
    let Some(temporal) = temporal else {
        return Ok(std::mem::take(hits));
    };
    let rows = hit_rows(hits);
    let filtered = temporal::apply_temporal_filter_safe(&rows, &temporal);
    if filtered.dropped || filtered.kept.len() == hits.len() {
        return Ok(std::mem::take(hits));
    }
    let reason = match temporal {
        Temporal::Anchor { .. } => "outside resolved temporal range",
        Temporal::Range { .. } => "outside temporal range",
    };
    let kept: std::collections::HashSet<usize> = filtered.kept.iter().copied().collect();
    for (index, hit) in hits.iter().enumerate() {
        if !kept.contains(&index) {
            rejections.push(Rejection {
                memory_id: hit.id.clone(),
                stage: "temporal-filter".to_owned(),
                reason: reason.to_owned(),
            });
        }
    }
    Ok(filtered
        .kept
        .iter()
        .map(|index| hits[*index].clone())
        .collect())
}

fn resolve_anchor(
    input: &StageInput<'_>,
    temporal: Temporal,
) -> Result<Option<Temporal>, StageError> {
    let Temporal::Anchor { reference_query } = temporal else {
        return Ok(Some(temporal));
    };
    let Ok(vectors) =
        input
            .embedder
            .embed(&[reference_query], EmbedKind::Passage, &Cancel::never())
    else {
        return Ok(None);
    };
    let Some(vector) = vectors.into_iter().next() else {
        return Ok(None);
    };
    let found = input
        .store
        .search(&vector, 1, &RowFilter::default())
        .map_err(StageError::Store)?;
    let Some(row) = found.into_iter().next() else {
        return Ok(None);
    };
    Ok(range_from_anchor(epoch(&row.row.created_at)))
}

fn canonical_hits(
    input: &StageInput<'_>,
    query_vector: &[f32],
    cancel: &Cancel,
) -> Vec<CanonicalHit> {
    if !input.flags.canonical {
        return Vec::new();
    }
    let Some(workspace) = input.workspace_dir else {
        return Vec::new();
    };
    let mut hits = knowledge::search_canonical_with_cancel(
        workspace,
        query_vector,
        input.embedder,
        input.limits.canonical_min_score,
        input.limits.canonical_max_items,
        input.flags.persist_knowledge,
        cancel,
    );
    if let Some(mask) = input.tombstones {
        let private = knowledge::search_private(
            input.context,
            query_vector,
            input.embedder,
            (
                input.limits.canonical_min_score,
                input.limits.canonical_max_items,
            ),
            cancel,
            (input.store, mask, input.clocks.now_ms),
        );
        hits.extend(private);
        hits.sort_by(|a, b| b.score.total_cmp(&a.score));
        hits.truncate(input.limits.canonical_max_items);
    }
    hits
}

fn score_hits(mut hits: Vec<Hit>, emotion: Option<&dyn score::EmotionalRecallState>) -> Vec<Hit> {
    for hit in &mut hits {
        let Some(row) = hit.row.as_ref() else {
            continue;
        };
        if let Some(emotion) = emotion {
            hit.score *= emotion.recall_boost(row).clamp(0.9, 1.1);
        }
        let strength = lifecycle::number(&row.memory_strength);
        hit.score += score::strength_adjustment(strength);
        hit.score += score::epistemic_score_boost(&row.epistemic_status);
    }
    hits.sort_by(|left, right| right.score.total_cmp(&left.score));
    hits
}

fn spread_graph(
    input: &StageInput<'_>,
    hits: Vec<Hit>,
    sink: &dyn DenialSink,
    rejections: &mut Vec<Rejection>,
    observations: &mut Observations,
    cancel: &Cancel,
) -> Result<Vec<Hit>, StageError> {
    if !input.flags.associative || hits.is_empty() {
        return Ok(hits);
    }
    let bound_edges = input
        .bound_graph
        .map(|source| {
            source.read_for(
                input.store,
                input.context,
                input.clocks.now_ms,
                input.clocks.valid_at,
                cancel,
            )
        })
        .transpose()?;
    let available = bound_edges.as_deref().unwrap_or(input.edges);
    let seeds: Vec<(String, f64)> = hits
        .iter()
        .take(super::graph::SEED_COUNT)
        .map(|hit| (hit.id.clone(), hit.score))
        .collect();
    let seed_ids: Vec<String> = seeds.iter().map(|(id, _)| id.clone()).collect();
    let endpoints = reachable_endpoint_ids(available, &seed_ids);
    let allowed = allowed_endpoints(input, &endpoints, sink, rejections)?;
    let edges = edges_between(available, &allowed);
    observations.rejections(rejections);
    let traversal = traverse_observed(&seeds, &edges);
    observations.guard(
        "graph-traversal",
        true,
        &format!(
            "visited {} nodes, returned {} associative results",
            traversal.visited,
            traversal.hits.len()
        ),
        None,
    );
    Ok(merge_graph(
        hits,
        traversal.hits,
        slice_limit(input),
        observations,
    ))
}

fn merge_graph(
    hits: Vec<Hit>,
    associative: Vec<super::graph::AssociativeHit>,
    max_total: usize,
    observations: &mut Observations,
) -> Vec<Hit> {
    let max_vector = hits
        .iter()
        .map(|hit| if hit.score == 0.0 { 0.0 } else { hit.score })
        .fold(0.0_f64, f64::max);
    let mut merged = hits;
    for assoc in associative {
        if let Some(existing) = merged.iter_mut().find(|hit| hit.id == assoc.memory_id) {
            observations.overlap(&existing.id, existing.score, assoc.associated_score);
            existing.source = "both";
        } else {
            let capped = cap_graph_score(assoc.associated_score, max_vector);
            observations.graph(
                &assoc.memory_id,
                assoc.associated_score,
                capped,
                max_vector,
                assoc.depth,
                &assoc.seed_id,
            );
            merged.push(Hit {
                depth: Some(assoc.depth),
                id: assoc.memory_id,
                row: None,
                score: cap_graph_score(assoc.associated_score, max_vector),
                source: "graph",
            });
        }
    }
    merged.sort_by(|left, right| right.score.total_cmp(&left.score));
    merged.truncate(max_total);
    merged
}

fn hydrate(
    input: &StageInput<'_>,
    hits: Vec<Hit>,
    query_vector: &[f32],
    sink: &dyn DenialSink,
    rejections: &mut Vec<Rejection>,
) -> Result<Vec<Hit>, StageError> {
    let mut hydrated = Vec::new();
    for hit in hits {
        if graph_shell(&hit) {
            if let Some(kept) = hydrate_one(input, hit, query_vector, sink, rejections)? {
                hydrated.push(kept);
            }
        } else if hit.row.as_ref().is_some_and(|row| {
            lifecycle::is_recall_entry_live(row, input.clocks.now_ms, input.clocks.valid_at)
        }) && acl_allows(input, &hit, "graph-hydration-acl", sink, rejections)
            && !masked(input, &hit, rejections)?
        {
            hydrated.push(hit);
        }
    }
    Ok(hydrated)
}

fn hydrate_one(
    input: &StageInput<'_>,
    hit: Hit,
    query_vector: &[f32],
    sink: &dyn DenialSink,
    rejections: &mut Vec<Rejection>,
) -> Result<Option<Hit>, StageError> {
    let Some(row) = input.store.get(&hit.id).map_err(StageError::Store)? else {
        rejections.push(Rejection {
            memory_id: hit.id,
            stage: "graph-hydration".to_owned(),
            reason: "hydration miss".to_owned(),
        });
        return Ok(None);
    };
    if !lifecycle::is_recall_entry_live(&row, input.clocks.now_ms, input.clocks.valid_at) {
        rejections.push(Rejection {
            memory_id: row.id,
            stage: "graph-hydration".to_owned(),
            reason: "inactive or non-live expiry".to_owned(),
        });
        return Ok(None);
    }
    let kept = Hit {
        depth: hit.depth,
        id: row.id.clone(),
        row: Some(row),
        score: hit.score,
        source: "graph",
    };
    if !acl_allows(input, &kept, "graph-hydration-acl", sink, rejections)
        || masked(input, &kept, rejections)?
    {
        return Ok(None);
    }
    Ok(graph_relevance_allows(input.embedder, query_vector, &kept, rejections).then_some(kept))
}

fn graph_relevance_allows(
    embedder: &dyn EmbeddingProvider,
    query_vector: &[f32],
    kept: &Hit,
    rejections: &mut Vec<Rejection>,
) -> bool {
    if !query_vector.is_empty() {
        let vector = kept
            .row
            .as_ref()
            .map(|row| row.vector.as_slice())
            .unwrap_or_default();
        let Ok(relevance) = hydration_relevance(embedder, vector, query_vector, kept) else {
            rejections.push(Rejection {
                memory_id: kept.id.clone(),
                stage: "graph-hydration".to_owned(),
                reason: "relevance check failed".to_owned(),
            });
            return false;
        };
        if relevance_below_threshold(relevance, HYDRATION_RELEVANCE_THRESHOLD) {
            rejections.push(Rejection {
                memory_id: kept.id.clone(),
                stage: "graph-hydration".to_owned(),
                reason: relevance_reason(relevance, HYDRATION_RELEVANCE_THRESHOLD),
            });
            return false;
        }
    }
    true
}

fn hydration_relevance(
    embedder: &dyn EmbeddingProvider,
    stored: &[f32],
    query_vector: &[f32],
    hit: &Hit,
) -> Result<f64, StageError> {
    let pinned = lance_stored_relevance(stored, query_vector);
    if pinned.is_nan() {
        return Ok(pinned);
    }
    let text = hit
        .row
        .as_ref()
        .map(|row| {
            if row.text.is_empty() {
                row.summary.clone()
            } else {
                row.text.clone()
            }
        })
        .unwrap_or_default();
    let embedded = embedder
        .embed(&[text], EmbedKind::Passage, &Cancel::never())
        .map_err(StageError::Embed)?;
    Ok(embedded
        .into_iter()
        .next()
        .map(|vector| reembedded_relevance(query_vector, &vector))
        .unwrap_or(0.0))
}

fn graph_shell(hit: &Hit) -> bool {
    if hit.source != "graph" {
        return false;
    }
    match &hit.row {
        None => true,
        Some(row) => row.text.is_empty() && row.summary.is_empty(),
    }
}

fn reject_inactive(input: &StageInput<'_>, hits: &mut Vec<Hit>, rejections: &mut Vec<Rejection>) {
    hits.retain(|hit| {
        let live = hit.row.as_ref().is_some_and(|row| {
            lifecycle::is_recall_entry_live(row, input.clocks.now_ms, input.clocks.valid_at)
        });
        if !live {
            rejections.push(Rejection {
                memory_id: hit.id.clone(),
                stage: "lifecycle".to_owned(),
                reason: "inactive or non-live expiry".to_owned(),
            });
        }
        live
    });
}

fn acl_allows(
    input: &StageInput<'_>,
    hit: &Hit,
    stage: &str,
    sink: &dyn DenialSink,
    rejections: &mut Vec<Rejection>,
) -> bool {
    let Some(row) = hit.row.as_ref() else {
        return false;
    };
    match acl::allowed(row, input.context) {
        Ok(()) => true,
        Err(rule) => {
            sink.denied(&hit.id, rule.name(), input.context);
            rejections.push(Rejection {
                memory_id: hit.id.clone(),
                stage: stage.to_owned(),
                reason: rule.name().to_owned(),
            });
            false
        }
    }
}

fn inactive_reason(row: &MemoryRow) -> String {
    if !row.status.is_empty() && row.status != "active" {
        format!("inactive status: {}", row.status)
    } else {
        "non-live expiry".to_owned()
    }
}

fn slice_limit(input: &StageInput<'_>) -> usize {
    let hard = input.limits.candidate_hard_limit.clamp(1, 100);
    if input.flags.defer_final_cap {
        hard
    } else {
        input.limits.top_n
    }
}

/// `shouldRefineQuery`: an empty list, or every score strictly under `min_score`.
fn should_refine_query(hits: &[Hit], min_score: f64) -> bool {
    hits.is_empty() || hits.iter().all(|hit| hit.score < min_score)
}

fn hit_rows(hits: &[Hit]) -> Vec<&MemoryRow> {
    hits.iter().filter_map(|hit| hit.row.as_ref()).collect()
}

/// The hash embedder re-exported for fixtures that materialise row vectors.
pub use super::hash_embed::hash_unit;

fn hydrated_equal(left: &[HydratedMemory], right: &[HydratedMemory]) -> bool {
    matches!((serde_json::to_value(left), serde_json::to_value(right)),
        (Ok(left), Ok(right)) if left == right)
}

fn observe_vectors(observations: &mut Observations, hits: &[Hit]) {
    for hit in hits {
        if let Some(row) = &hit.row {
            observations.vector(row, hit.score);
        }
    }
}

fn allowed_endpoints(
    input: &StageInput<'_>,
    endpoints: &[String],
    sink: &dyn DenialSink,
    rejections: &mut Vec<Rejection>,
) -> Result<Vec<String>, StageError> {
    let mut allowed = Vec::new();
    for endpoint in endpoints {
        match input.store.get(endpoint).map_err(StageError::Store)? {
            None => rejections.push(Rejection {
                memory_id: endpoint.clone(),
                stage: "graph-endpoint-acl".to_owned(),
                reason: "missing endpoint row".to_owned(),
            }),
            Some(row) => {
                if !lifecycle::is_recall_entry_live(
                    &row,
                    input.clocks.now_ms,
                    input.clocks.valid_at,
                ) {
                    rejections.push(Rejection {
                        memory_id: endpoint.clone(),
                        stage: "graph-endpoint-acl".to_owned(),
                        reason: inactive_reason(&row).to_owned(),
                    });
                    continue;
                }
                let shell = Hit {
                    depth: None,
                    id: row.id.clone(),
                    row: Some(row),
                    score: 0.0,
                    source: "graph",
                };
                // A forgotten card is neither an association target nor a bridge (RE-D153).
                if acl_allows(input, &shell, "graph-endpoint-acl", sink, rejections)
                    && !masked(input, &shell, rejections)?
                {
                    allowed.push(endpoint.clone());
                }
            }
        }
    }
    Ok(allowed)
}

#[cfg(test)]
mod hydration_tests {
    use super::*;
    use crate::contract::VectorSpaceIdentity;
    use crate::recall::hash_embed::HashEmbedder;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct FailOnce {
        inner: HashEmbedder,
        failed: AtomicBool,
    }
    impl EmbeddingProvider for FailOnce {
        fn identity(&self) -> &VectorSpaceIdentity {
            self.inner.identity()
        }
        fn embed(
            &self,
            _: &[String],
            _: EmbedKind,
            _: &Cancel,
        ) -> Result<Vec<Vec<f32>>, EmbedError> {
            if !self.failed.swap(true, Ordering::SeqCst) {
                Err(EmbedError::ProviderFailed { status: None })
            } else {
                Ok(vec![vec![1.0, 0.0]])
            }
        }
    }

    #[test]
    fn failed_graph_relevance_drops_only_that_candidate_with_a_content_free_trace() {
        let embedder = FailOnce {
            inner: HashEmbedder::new(),
            failed: AtomicBool::new(false),
        };
        let mut rejected = Vec::new();
        // A missing vector follows the real re-embedding path, unlike the pinned
        // Arrow vector path whose NaN behavior belongs to the existing oracle.
        let first = Hit {
            depth: Some(1),
            id: "first".into(),
            row: None,
            score: 0.8,
            source: "graph",
        };
        assert!(!graph_relevance_allows(
            &embedder,
            &[1.0, 0.0],
            &first,
            &mut rejected
        ));
        let second = Hit {
            id: "second".into(),
            ..first
        };
        assert!(graph_relevance_allows(
            &embedder,
            &[1.0, 0.0],
            &second,
            &mut rejected
        ));
        assert_eq!(rejected.len(), 1);
        assert_eq!(rejected[0].memory_id, "first");
        assert_eq!(rejected[0].stage, "graph-hydration");
        assert_eq!(rejected[0].reason, "relevance check failed");
    }
}
