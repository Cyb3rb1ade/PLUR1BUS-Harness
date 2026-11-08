//! Pure retrieval reinforcement used by the foreground correction path.
use crate::{contract::MemoryRow, store::RowPatch};
fn number(value: &serde_json::Number) -> f64 {
    value.as_f64().unwrap_or(0.)
}
fn timestamp(values: [&serde_json::Number; 3]) -> f64 {
    values
        .into_iter()
        .map(number)
        .find(|value| value.is_finite() && *value > 0.)
        .unwrap_or(0.)
}
pub(super) fn reinforcement(row: &MemoryRow, now: i64) -> RowPatch {
    let now = now as f64;
    let mut patch = RowPatch {
        retrieval_count: Some(number(&row.retrieval_count) + 1.),
        last_retrieved_at: Some(now),
        last_strengthened_at: Some(now),
        last_dynamics_at: Some(now),
        ..RowPatch::default()
    };
    if row.memory_class == "core" || number(&row.never_forget) == 1. {
        patch.memory_strength = Some(1.);
        return patch;
    }
    let initial = number(&row.memory_strength).clamp(0.01, 1.);
    let half = number(&row.half_life_days).max(1.);
    let elapsed = now
        - timestamp([
            &row.last_dynamics_at,
            &row.last_strengthened_at,
            &row.created_at,
        ]);
    let decayed = if elapsed > 0. {
        (initial * 0.5_f64.powf(elapsed / (half * 86_400_000.))).clamp(0.01, 1.)
    } else {
        initial
    };
    patch.memory_strength = Some((decayed + 0.15).clamp(0.01, 0.99));
    let current = if number(&row.half_life_days) > 0. {
        number(&row.half_life_days)
    } else {
        30.
    };
    let elapsed = now
        - timestamp([
            &row.last_strengthened_at,
            &row.last_dynamics_at,
            &row.created_at,
        ]);
    patch.half_life_days = Some(if elapsed >= 86_400_000. {
        current.max((current * 1.15).min(600.))
    } else {
        current
    });
    patch
}
