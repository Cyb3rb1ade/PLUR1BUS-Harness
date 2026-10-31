//! One recall row after graph hydration.
//!
//! The fields are the ones `applyRecallBudget`, `dedupResults` and the ACL check read.
//! An empty `summary` is falsy, matching `entry.summary || generateSummary(...)`.
//! A whitespace-only summary is kept as written.

use super::acl::AclMemory;
use crate::text::legacy::text_utils::generate_summary;

/// A hydrated memory the post-stage-7 pipeline can reorder.
#[derive(Clone, Debug, PartialEq)]
pub struct RecallCandidate {
    /// Memory id. Empty when the row had none.
    pub id: String,
    /// Stored text. Used when `summary` is empty.
    pub text: String,
    /// Stored summary. Empty falls through to [`Self::document`].
    pub summary: String,
    /// `entry.category`. `project` and `plan` share a budget tier.
    pub category: String,
    /// `entry.coreMemoryScore`. Values at or above 0.7 are core.
    pub core_memory_score: f64,
    /// Stored `agentId`.
    pub agent_id: String,
    /// Stored scope. Empty is treated as `agent-private` by the ACL.
    pub scope: String,
    /// Chunk-group id. Empty is falsy and falls through to [`Self::source_turn_id`].
    pub chunk_group_id: String,
    /// Turn id shared by a whole row and its chunk parts.
    pub source_turn_id: String,
    /// Validity start. `0` means the bound is unknown.
    pub valid_from: f64,
    /// Validity end. `0` means the bound is unknown.
    pub valid_until: f64,
    /// Vector or graph score before rerank. Absent when the row has none.
    pub score: Option<f64>,
    /// `vector` or `graph`.
    pub source: String,
    /// Set when a non-graph source row was still reached through the graph.
    pub graph_source: String,
    /// Ceiling score written by the reranker. Absent when rerank did not apply.
    pub rerank_score: Option<f64>,
}

impl Default for RecallCandidate {
    fn default() -> Self {
        Self {
            id: String::new(),
            text: String::new(),
            summary: String::new(),
            category: String::new(),
            core_memory_score: 0.0,
            agent_id: String::new(),
            scope: String::new(),
            chunk_group_id: String::new(),
            source_turn_id: String::new(),
            valid_from: 0.0,
            valid_until: 0.0,
            score: None,
            source: String::new(),
            graph_source: String::new(),
            rerank_score: None,
        }
    }
}

impl RecallCandidate {
    /// Document text the reranker and the prefilter see.
    #[must_use]
    pub fn document(&self, summary_max_words: usize) -> String {
        if self.summary.is_empty() {
            generate_summary(&self.text, summary_max_words)
        } else {
            self.summary.clone()
        }
    }

    /// Ownership columns for [`super::acl::check_access`].
    #[must_use]
    pub fn acl_memory(&self) -> AclMemory {
        AclMemory {
            id: self.id.clone(),
            scope: self.scope.clone(),
            agent_id: self.agent_id.clone(),
            ..AclMemory::default()
        }
    }
}
