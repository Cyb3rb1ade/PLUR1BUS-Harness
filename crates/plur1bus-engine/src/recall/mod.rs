//! Recall pipeline.
//!
//! T1 wires request ACL. T2 runs stages through graph hydration. Rendering, namespaces
//! and budgets arrive in later RE-04 tasks.

/// Row visibility and denial reporting for recall.
pub mod acl;
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
