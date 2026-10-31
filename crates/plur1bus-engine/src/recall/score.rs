//! Score terms copied from the pinned pipeline.

/// `distanceToScore` from `lib/score.js`. A missing distance is 0.
#[must_use]
pub fn distance_to_score(distance: f64) -> f64 {
    1.0 / (1.0 + distance)
}

/// Scoring-only boost. An absent or unknown value is 0, not the legality default.
///
/// `invalidated` is absent from this table. Legality drops it before scoring.
#[must_use]
pub fn epistemic_score_boost(raw: &str) -> f64 {
    match raw {
        "trusted" => 0.25,
        "corroborated" => 0.15,
        "observed" => 0.0,
        "untrusted" => -0.15,
        "disputed" => -0.4,
        _ => 0.0,
    }
}

/// Legality label. Anything outside the six statuses becomes `untrusted`.
#[must_use]
pub fn normalize_epistemic_status(value: &str) -> &'static str {
    match value {
        "untrusted" => "untrusted",
        "observed" => "observed",
        "corroborated" => "corroborated",
        "trusted" => "trusted",
        "disputed" => "disputed",
        "invalidated" => "invalidated",
        _ => "untrusted",
    }
}

/// Strength term `(memoryStrength ?? 1) - 1`. The importance term stays off.
#[must_use]
pub fn strength_adjustment(memory_strength: f64) -> f64 {
    memory_strength - 1.0
}
