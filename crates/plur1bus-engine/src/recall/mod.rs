//! Recall pipeline.
//!
//! T1 wires request ACL. T2 runs stages through graph hydration. T3 adds the
//! post-hydration budget, optional prefilter, rerank, dedupe and final ACL.
//! T4 adds namespace routes, per-table composition and global merge.
//! T5 renders six blocks and additive boosters; T6 orchestration remains separate.

/// Row visibility and denial reporting for recall.
pub mod acl;
/// Tier budget and `resolveRecallBudget`.
pub mod budget;
/// Production namespace workers sharing one request deadline.
pub mod budgeted_pipeline;
/// One hydrated recall row shared by budget, dedupe and finalisation.
pub mod candidate;
/// Request cancellation and soft-budget fast paths.
pub mod control;
/// Jaccard dedupe and chunk-group caps.
pub mod dedupe;
/// Optional pre-rerank document filter.
pub mod filter;
/// Provider ACL, rerank, budget, dedupe and the final ACL re-assert.
pub mod finalise;
/// Associative spread and Lance hydration relevance.
pub mod graph;
/// Counter-mode hash vectors shared with the stage recorder.
pub mod hash_embed;
/// Canonical `KNOWLEDGE.md` sections and their file cache.
pub mod knowledge;
/// Live-row and valid-time checks.
pub mod lifecycle;
/// Global namespace dedupe, caps and rerank-preserving order.
pub mod merge;
/// The post-merge tier budget used before retrieval-ledger persistence.
pub mod namespace_budget;
/// Vector-free metadata projection at the per-table recall boundary.
pub mod namespace_entry;
mod namespace_fanout;
/// Query routing and rank fusion across independent embedding identities.
pub mod namespace_identity;
mod namespace_observation;
/// Existing stages composed for a physical namespace table.
pub mod namespace_pipeline;
/// Request-local coalescing of the original namespace query embedding.
pub mod namespace_query;
mod namespace_rerank;
mod namespace_routes;
/// Bounded child trace replay into a master trace.
pub mod namespace_trace;
/// Configured physical routes, settle-all fan-out and the global retrieval ledger.
pub mod namespaces;
/// Distance and epistemic score terms.
pub mod score;
/// Stages 1–7.
pub mod stages;
/// CreatedAt parser and the safe temporal filter.
pub mod temporal;
/// Monotonic request and per-namespace phase timing.
pub mod timing;
/// Bounded, redacted, lossless recall decision traces.
pub mod trace;
mod trace_redaction;

/// Lossless prompt blocks and serialized results.
pub mod blocks;
/// Confidence and contradiction helpers.
pub mod boosters;
/// Record-boundary and host aggregate injection caps.
pub mod inject_budget;
/// Authorized injected-behavior conflict policy through CA5 ports.
pub mod injected_conflicts;
/// Canonical-request-bound Semantic Lens hydration.
pub mod lens;
/// Minimal presentation and authorized two-field counter maintenance.
pub mod maintenance;
mod memory_constants;
/// Relevant-memory formatting.
pub mod memory_context;
mod memory_record;
/// Prompt attribute and evidence escaping.
pub mod memory_sanitize;
mod memory_trace;
/// CA5 prelude interface, without a Neo implementation.
pub mod neo_prelude;
/// Pattern scoring, taste and formatting.
pub mod patterns;
/// Observation-time provenance and operational guards.
pub mod provenance;
/// Additive CRR selection and session triggers.
pub mod reactivation;
mod reactivation_acl;
mod reactivation_index;
mod reactivation_memory;
mod reactivation_select;
/// Pure six-block rendering after selected recall.
pub mod render;
mod render_access;
mod render_boosters;
mod render_compression;
mod render_date;
mod render_projection;
mod render_value;
/// Request-level time budgets, diagnostics and lossless result envelope.
pub mod runtime;
/// Pure mood style text.
pub mod style;
mod style_constants;
/// Stable system supplement.
pub mod system_supplement;
mod temporal_constants;
/// Localized activity, temporal and reminder blocks.
pub mod time_context;
/// Read-only warm orchestration.
pub mod warm;
