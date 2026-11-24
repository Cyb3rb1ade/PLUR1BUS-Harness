//! Pinned score terms and the opt-in RE-D11 cosine scale.

use crate::contract::{EngineError, VectorSpaceIdentity};
use serde_json::Value;

/// Score scale and its query threshold. Legacy remains the default.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum ScoreScale {
    /// The pinned reciprocal squared-distance score.
    #[default]
    Legacy,
    /// Cosine over the same unit-vector search, with a profile-specific threshold.
    Cosine {
        /// Minimum admissible raw cosine before boosts.
        min_score: f64,
    },
}

impl ScoreScale {
    /// Resolve the opt-in against the actual provider identity. Unknown profiles need an explicit floor.
    pub fn configured(recall: &Value, identity: &VectorSpaceIdentity) -> Result<Self, EngineError> {
        let invalid = |field: &str, message: &str| EngineError::Invalid {
            field: field.into(),
            message: message.into(),
        };
        if let Some(value) = recall.get("scoreScale") {
            match value.as_str() {
                Some("legacy") => return Ok(Self::Legacy),
                Some("cosine") => {}
                _ => return Err(invalid("recall.scoreScale", "unknown score scale")),
            }
        } else {
            return Ok(Self::Legacy);
        }
        if identity.normalization != "l2" {
            return Err(invalid(
                "recall.scoreScale",
                "cosine requires an L2-normalized vector space",
            ));
        }
        let min_score = if let Some(value) = recall.get("cosineMinScore") {
            value.as_f64().filter(|score| (-1.0..=1.0).contains(score))
        } else {
            calibrated_floor(identity)
        }
        .ok_or_else(|| {
            invalid(
                "recall.cosineMinScore",
                "supply a cosine threshold for this embedding profile",
            )
        })?;
        Ok(Self::Cosine { min_score })
    }

    /// Convert Lance's squared L2 distance to the configured scale.
    #[must_use]
    pub fn distance_score(self, squared_distance: f64) -> f64 {
        match self {
            Self::Legacy => distance_to_score(squared_distance),
            Self::Cosine { .. } => cosine_from_squared_l2(squared_distance),
        }
    }

    /// Legacy configuration remains on its original scale.
    #[must_use]
    pub fn threshold(self, legacy_floor: f64) -> f64 {
        match self {
            Self::Legacy => legacy_floor,
            Self::Cosine { min_score } => min_score,
        }
    }

    /// Preserve the relative booster weights at the active floor after the scale change.
    #[must_use]
    pub fn boost(self, base: f64, emotion: f64, strength: f64, epistemic: &str) -> f64 {
        let strength = strength_adjustment(strength);
        let epistemic = epistemic_score_boost(epistemic);
        match self {
            Self::Legacy => base * emotion + strength + epistemic,
            Self::Cosine { .. } => {
                let legacy_score = distance_to_score(2.0 * (1.0 - base.clamp(-1.0, 1.0)));
                base + self.boost_weight() * (legacy_score * (emotion - 1.0) + strength + epistemic)
            }
        }
    }

    pub(crate) fn boost_weight(self) -> f64 {
        match self {
            Self::Legacy => 1.0,
            // Inverse derivative of f(c) = 1/(3-2c), evaluated at the calibrated floor.
            Self::Cosine { min_score } => (3.0 - 2.0 * min_score).powi(2) / 2.0,
        }
    }

    pub(crate) fn accepts_vector(self, vector: &[f32]) -> bool {
        self == Self::Legacy || {
            let norm_squared = vector
                .iter()
                .map(|value| f64::from(*value).powi(2))
                .sum::<f64>();
            (0.999..=1.001).contains(&norm_squared)
        }
    }
}

fn calibrated_floor(identity: &VectorSpaceIdentity) -> Option<f64> {
    // RE-D11's frozen E5 corpus, float32 CPU profile. Keep a margin below its weakest labelled hit.
    (identity.provider == "local-transformers"
        && identity.model == "intfloat/multilingual-e5-small"
        && identity.revision == "614241f622f53c4eeff9890bdc4f31cfecc418b3"
        && identity.dtype == "float32"
        && identity.dimension.as_u64() == Some(384))
    .then_some(0.82)
}

/// `1 - d/2` for two unit vectors. Clamp rounding spill at the ends of the cosine range.
#[must_use]
pub fn cosine_from_squared_l2(squared_distance: f64) -> f64 {
    (1.0 - squared_distance / 2.0).clamp(-1.0, 1.0)
}

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
/// Optional emotional state consulted during the pin's scoring stage.
pub trait EmotionalRecallState: Sync {
    /// Return the recall factor; the pipeline clamps it to 0.9–1.1.
    fn recall_boost(&self, row: &crate::contract::MemoryRow) -> f64;
}
