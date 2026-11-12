//! Normalization of frozen Node deferred-dynamics options.

use std::time::Duration;

/// Queue limits from the Node options; fractional backlog caps retain their comparison semantics.
#[derive(Clone, Copy)]
pub struct DeferredOptions {
    /// Waiting jobs retained per agent; zero/invalid selects twenty, negatives clamp to one.
    pub max_backlog: f64,
    /// Delay before a lane starts if recall never kicks it. Zero starts immediately.
    pub fallback_delay: Duration,
    /// Invalid numeric fallback options disable startup, matching Node NaN comparisons.
    pub fallback_enabled: bool,
}

impl Default for DeferredOptions {
    fn default() -> Self {
        Self {
            max_backlog: 20.0,
            fallback_delay: Duration::from_secs(10),
            fallback_enabled: true,
        }
    }
}

impl DeferredOptions {
    /// Normalize JSON queue options in the same order as the Node constructor.
    #[must_use]
    pub fn from_json(options: &serde_json::Value) -> Self {
        let maximum = js_number(options.get("maxBacklog")).unwrap_or(0.0);
        let maximum = if maximum == 0.0 || maximum.is_nan() {
            20.0
        } else {
            maximum.max(1.0)
        };
        let fallback = options
            .get("fallbackDelayMs")
            .filter(|value| !value.is_null())
            .map_or(10_000.0, |value| js_number(Some(value)).unwrap_or(f64::NAN));
        let bounded = if fallback > 2_147_483_647.0 {
            1.0 // Node setTimeout clamps overflowing delays to one millisecond.
        } else {
            fallback.max(0.0)
        };
        let fallback_delay = Duration::try_from_secs_f64(bounded / 1000.0).unwrap_or_default();
        Self {
            max_backlog: maximum,
            fallback_delay,
            fallback_enabled: !fallback.is_nan(),
        }
    }
}

fn js_number(value: Option<&serde_json::Value>) -> Option<f64> {
    match value {
        Some(serde_json::Value::Number(n)) => n.as_f64(),
        Some(serde_json::Value::Null) => Some(0.0),
        Some(serde_json::Value::Bool(value)) => Some(f64::from(*value)),
        Some(serde_json::Value::String(value)) => {
            if value.trim().is_empty() {
                Some(0.0)
            } else {
                value.trim().parse().ok()
            }
        }
        _ => None,
    }
}
