//! Recall pipeline.
//!
//! T1 wires request ACL. T2 runs stages through graph hydration. T3 adds the
//! post-hydration budget, optional prefilter, rerank, dedupe and final ACL.
//! Rendering and namespaces arrive in later RE-04 tasks.

/// Row visibility and denial reporting for recall.
pub mod acl;
/// Tier budget and `resolveRecallBudget`.
pub mod budget;
/// One hydrated recall row shared by budget, dedupe and finalisation.
pub mod candidate;
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
/// Distance and epistemic score terms.
pub mod score;
/// Stages 1–7.
pub mod stages;
/// CreatedAt parser and the safe temporal filter.
pub mod temporal;
