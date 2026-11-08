//! Capture duplicate decisions on Lance's pinned native-distance score (RE-D11).
//!
//! Node capture asks `MemoryDB.search(vector, 1, threshold)`; it does not use cosine.
//! The caller owns active-row filtering and verifies each store's embedding identity.

use crate::contract::MemoryRow;
use crate::store::row::Scored;

/// Convert the native Lance distance with Node's `distanceToScore` formula.
/// Missing distance is zero, matching JS `distance ?? 0`; non-finite values are retained.
#[must_use]
pub fn distance_to_score(distance: Option<f64>) -> f64 {
    1.0 / (1.0 + distance.unwrap_or(0.0))
}

/// The inclusive comparison used after Node maps nearest-neighbor distances to scores.
#[must_use]
pub fn score_is_duplicate(score: f64, threshold: f64) -> bool {
    score >= threshold
}

/// Decide whether a Node-active-filtered nearest-neighbor result blocks a new capture.
/// Feed the nearest row only, as Node's capture asks for one neighbor before thresholding.
#[must_use]
pub fn is_duplicate(nearest: Option<&Scored<MemoryRow>>, threshold: f64) -> bool {
    nearest.is_some_and(|row| {
        score_is_duplicate(distance_to_score(Some(f64::from(row.distance))), threshold)
    })
}
