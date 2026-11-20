//! ADR-009 candidate decisions and diagnostic fallback.

use crate::js::js_trim;
use crate::policy::js_value::number_to_string;
use icu_normalizer::ComposingNormalizerBorrowed;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Promotion input from the persisted candidate.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// Expiry instant in milliseconds.
    pub expires_at: i64,
    /// Number of measured recalls.
    pub recalls: i64,
    /// Number of distinct measured queries.
    pub unique_queries: i64,
    /// Measured utility score, when available.
    pub score: Option<f64>,
}

/// Thresholds for candidate grading.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateConfig {
    /// Minimum score when the candidate has one.
    pub min_score: f64,
    /// Minimum recalls beyond the required utility signal.
    pub min_recall_count: i64,
    /// Minimum distinct queries.
    pub min_unique_queries: i64,
}

impl Default for GateConfig {
    fn default() -> Self {
        Self {
            min_score: 0.75,
            min_recall_count: 3,
            min_unique_queries: 3,
        }
    }
}

/// Gate names and evaluation order from ADR-009.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Gate {
    /// The candidate is still recent enough.
    Expiry,
    /// At least one recall demonstrates utility.
    Utility,
    /// The minimum recall count.
    RecallCount,
    /// The minimum number of distinct queries.
    UniqueQueries,
    /// A score either clears its threshold or is unavailable.
    Score,
}

/// The evaluated result of one gate.
#[derive(Serialize)]
pub struct GateResult {
    /// Recorded gate.
    pub gate: Gate,
    /// Whether it passed.
    pub passed: bool,
    /// Explanation for a failed gate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Complete evaluation of a candidate at the supplied time.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// Whether every promotion gate passed.
    pub promote: bool,
    /// The first failed gate, if any.
    pub rejected_by: Option<Gate>,
    /// Results in gate order, including failures after the first.
    pub gates: [GateResult; 5],
    /// Decision time in milliseconds.
    pub at: i64,
}

/// Candidate diagnostics for an engine that has no recall statistics.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackInput {
    /// Original source time, if measured.
    pub created_at: Option<f64>,
    /// Importance, if measured.
    pub importance: Option<f64>,
    /// Repetition count, if measured.
    pub repetitions: Option<f64>,
}

/// Diagnostic signals only. This projection does not authorize promotion.
#[derive(Serialize)]
pub struct Fallback {
    /// Age and one of the corroborating signals are present.
    pub eligible: bool,
    /// The candidate is sufficiently old.
    pub age: bool,
    /// Importance meets the threshold.
    pub importance: bool,
    /// Repetitions meet the threshold.
    pub repetition: bool,
}

/// Hashes normalized, trimmed content for ledger deduplication.
pub fn content_hash(text: &str) -> String {
    let normalized = ComposingNormalizerBorrowed::new_nfc().normalize(text);
    format!(
        "{:x}",
        Sha256::digest(js_trim(normalized.as_ref()).as_bytes())
    )
}

fn gate(kind: Gate, passed: bool, reason: impl FnOnce() -> String) -> GateResult {
    GateResult {
        gate: kind,
        passed,
        detail: (!passed).then(reason),
    }
}

/// Evaluate every promotion gate with the supplied thresholds.
pub fn evaluate(candidate: &Candidate, now: i64, config: GateConfig) -> Decision {
    let gates = [
        gate(Gate::Expiry, candidate.expires_at > now, || {
            format!("expired at {}", candidate.expires_at)
        }),
        gate(Gate::Utility, candidate.recalls > 0, || {
            "recalls = 0".to_owned()
        }),
        gate(
            Gate::RecallCount,
            candidate.recalls >= config.min_recall_count,
            || format!("{} < {}", candidate.recalls, config.min_recall_count),
        ),
        gate(
            Gate::UniqueQueries,
            candidate.unique_queries >= config.min_unique_queries,
            || {
                format!(
                    "{} < {}",
                    candidate.unique_queries, config.min_unique_queries
                )
            },
        ),
        gate(
            Gate::Score,
            candidate
                .score
                .is_none_or(|score| score >= config.min_score),
            || {
                format!(
                    "{} < {}",
                    candidate.score.map(number_to_string).unwrap_or_default(),
                    number_to_string(config.min_score),
                )
            },
        ),
    ];
    let rejected_by = gates.iter().find(|gate| !gate.passed).map(|gate| gate.gate);
    Decision {
        promote: rejected_by.is_none(),
        rejected_by,
        gates,
        at: now,
    }
}

/// Evaluate diagnostic fallback signals without upgrading approval.
pub fn evaluate_fallback(candidate: &FallbackInput, now: f64) -> Fallback {
    let age = candidate.created_at.is_some_and(|created| {
        created.is_finite() && created >= 0.0 && now - created >= 86_400_000.0
    });
    let importance = candidate
        .importance
        .is_some_and(|value| value.is_finite() && value >= 0.75);
    let repetition = candidate.repetitions.is_some_and(|value| {
        (2.0..=9_007_199_254_740_991.0).contains(&value) && value.fract() == 0.0
    });
    Fallback {
        eligible: age && (importance || repetition),
        age,
        importance,
        repetition,
    }
}

#[cfg(test)]
#[path = "candidate_vectors.rs"]
mod vectors;
