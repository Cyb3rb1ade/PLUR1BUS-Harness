//! The namespace wrapper's final tier budget, applied before ledger delivery.

use serde_json::Value;

use super::budget::apply_recall_budget;
use super::merge::{candidate_of, NamespaceResult};

/// Normalized caller policy. An absent adaptive-budget object enables this step.
#[derive(Clone, Copy, Debug)]
pub struct MergedBudget {
    /// Only an explicit `enabled: false` skips the merged budget.
    pub enabled: bool,
    /// Node's raw budget; non-finite values default to 12, otherwise floor/clamp 1–100.
    pub limit: f64,
}

impl Default for MergedBudget {
    fn default() -> Self {
        Self {
            enabled: true,
            limit: 12.0,
        }
    }
}

/// Apply `applyMergedRecallBudget`, including CP-5.1's reranked-order preservation.
pub(crate) fn apply(result: &mut NamespaceResult, policy: MergedBudget) {
    if !policy.enabled {
        return;
    }
    let cap = normalize_bounded_recall_integer(
        policy.limit,
        12.0,
        1.0,
        super::namespaces::CANDIDATE_HARD_LIMIT as f64,
    ) as usize;
    result.canonical.truncate(cap);
    let candidates = result.memories.iter().map(candidate_of).collect::<Vec<_>>();
    let preserve_order = candidates.iter().any(|row| row.rerank_score.is_some());
    let selected = apply_recall_budget(
        &candidates,
        &[],
        cap.saturating_sub(result.canonical.len()) as f64,
        preserve_order,
    );
    let mut wrappers = std::mem::take(&mut result.memories)
        .into_iter()
        .map(Some)
        .collect::<Vec<_>>();
    result.memories = selected
        .selected
        .iter()
        .filter_map(|selected| {
            candidates
                .iter()
                .enumerate()
                .find_map(|(index, candidate)| {
                    if candidate == selected {
                        wrappers[index].take()
                    } else {
                        None
                    }
                })
        })
        .collect::<Vec<Value>>();
}

/// The pin's `normalizeBoundedRecallInteger`; non-finite input uses the fallback.
/// Bounds retain JavaScript Math.max/Math.min order, including invalid-bound NaNs.
#[must_use]
pub fn normalize_bounded_recall_integer(
    value: f64,
    fallback: f64,
    minimum: f64,
    maximum: f64,
) -> f64 {
    if !value.is_finite() {
        return fallback;
    }
    if minimum.is_nan() || maximum.is_nan() {
        return f64::NAN;
    }
    value.floor().max(minimum).min(maximum)
}
