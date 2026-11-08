//! Shared continuity taste gate for validated native scores and session counters.
//!
//! This gate does not authorize records: the caller must perform ACL filtering
//! before supplying candidates. Session state belongs to a single recall request.

use super::emotion_json::{num, object, string};
use crate::text::{
    js::{js_to_lower_case, JsString},
    json::TolerantJsonValue as Json,
};

/// Node defaults for direct gate calls; list callers explicitly set threshold zero.
#[derive(Clone, Copy, Debug)]
pub struct ContinuityGate {
    /// Associations must be strictly above this score.
    pub assoc_threshold: f64,
    /// Patterns must be strictly above this score.
    pub pattern_threshold: f64,
    /// Association count limit, retaining fractional comparison semantics.
    pub max_associations: f64,
    /// Pattern count limit.
    pub max_patterns: f64,
}
impl Default for ContinuityGate {
    fn default() -> Self {
        Self {
            assoc_threshold: 0.75,
            pattern_threshold: 0.70,
            max_associations: 1.0,
            max_patterns: 1.0,
        }
    }
}

/// Caller-local counters and insertion-ordered set of surfaced IDs.
#[derive(Default, Debug)]
pub struct SessionState {
    /// Number of accepted associations.
    pub associative_surfaced_count: f64,
    /// Number of accepted patterns.
    pub pattern_surfaced_count: f64,
    /// An absent set stays absent until an ID is recorded, matching Node.
    pub surfaced_ids: Option<Vec<JsString>>,
}
impl SessionState {
    /// Record only after the caller accepts a gate decision.
    pub fn record(&mut self, kind: &str, id: Option<&JsString>) {
        match kind {
            "associative" => self.associative_surfaced_count += 1.0,
            "pattern" => self.pattern_surfaced_count += 1.0,
            _ => {}
        }
        if let Some(id) = id {
            let ids = self.surfaced_ids.get_or_insert_with(Vec::new);
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
    }
    /// Ordered JSON projection used by the parity oracle.
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut fields = vec![
            (
                "associativeSurfacedCount",
                num(self.associative_surfaced_count),
            ),
            ("patternSurfacedCount", num(self.pattern_surfaced_count)),
        ];
        if let Some(ids) = &self.surfaced_ids {
            fields.push((
                "surfacedIds",
                Json::Array(ids.iter().cloned().map(Json::String).collect()),
            ));
        }
        object(fields)
    }
}

/// Optional checks; missing depth remains missing in trace JSON.
#[derive(Default)]
pub struct SurfaceOptions {
    /// Graph traversal depth.
    pub depth: Option<f64>,
    /// Candidate ID, with original UTF-16 preserved for exact identity comparison.
    pub id: Option<JsString>,
    /// IDs already in vector recall.
    pub vector_top_ids: Option<Vec<JsString>>,
    /// Pattern emotional trajectory.
    pub emotional_trajectory: Option<JsString>,
    /// Current emotional register.
    pub current_register: Option<JsString>,
}

/// Decision and the exact ordered Node detail for diagnostics.
pub struct Decision {
    /// Whether this item may be surfaced.
    pub allow: bool,
    /// Stable reason, with direct/list precedence preserved.
    pub reason: &'static str,
    /// Ordered raw detail; external traces must still use the trace redactor.
    pub trace_detail: Json,
}
impl Decision {
    fn new(reason: &'static str, fields: Vec<(&str, Json)>) -> Self {
        Self {
            allow: reason == "ok",
            reason,
            trace_detail: object(fields),
        }
    }
    /// Exact direct-gate response shape.
    #[must_use]
    pub fn to_json(&self) -> Json {
        object([
            ("allow", Json::Bool(self.allow)),
            ("reason", string(self.reason)),
            ("traceDetail", self.trace_detail.clone()),
        ])
    }
}
impl ContinuityGate {
    fn rate_limit(&self, kind: &str, score: f64, state: &SessionState) -> Option<Decision> {
        let (count, maximum, name) = match kind {
            "associative" => (
                state.associative_surfaced_count,
                self.max_associations,
                "maxAssociations",
            ),
            "pattern" => (
                state.pattern_surfaced_count,
                self.max_patterns,
                "maxPatterns",
            ),
            _ => return None,
        };
        (count >= maximum).then(|| {
            Decision::new(
                "rate_limit",
                vec![
                    ("score", num(score)),
                    (name, num(maximum)),
                    ("surfacedCount", num(count)),
                ],
            )
        })
    }

    /// Direct gate checks score before rate limit; unknown types are refused.
    #[must_use]
    pub fn should_surface(
        &self,
        kind: &str,
        score: f64,
        state: &SessionState,
        options: &SurfaceOptions,
    ) -> Decision {
        let threshold = match kind {
            "associative" => self.assoc_threshold,
            "pattern" => self.pattern_threshold,
            _ => return Decision::new("invalid_type", vec![("type", string(kind))]),
        };
        if score <= threshold {
            return Decision::new(
                "score_below_threshold",
                vec![("score", num(score)), ("threshold", num(threshold))],
            );
        }
        if let Some(decision) = self.rate_limit(kind, score, state) {
            return decision;
        }
        if kind == "associative" {
            if let Some(depth) = options.depth.filter(|depth| *depth > 2.0) {
                return Decision::new(
                    "depth_too_deep",
                    vec![
                        ("score", num(score)),
                        ("depth", num(depth)),
                        ("maxDepth", num(2.0)),
                    ],
                );
            }
            if let (Some(ids), Some(id)) = (&options.vector_top_ids, &options.id) {
                if ids.contains(id) {
                    return Decision::new(
                        "already_in_vector_recall",
                        vec![
                            ("score", num(score)),
                            ("id", Json::String(id.clone())),
                            (
                                "vectorTopIds",
                                Json::Array(ids.iter().cloned().map(Json::String).collect()),
                            ),
                        ],
                    );
                }
            }
        } else if let (Some(trajectory), Some(register)) =
            (&options.emotional_trajectory, &options.current_register)
        {
            if emotional_mismatch(&trajectory.to_utf8_lossy(), &register.to_utf8_lossy()) {
                return Decision::new(
                    "emotional_mismatch",
                    vec![
                        ("score", num(score)),
                        ("emotionalTrajectory", Json::String(trajectory.clone())),
                        ("currentRegister", Json::String(register.clone())),
                    ],
                );
            }
        }
        let mut fields = vec![("score", num(score)), ("threshold", num(threshold))];
        if kind == "associative" {
            if let Some(depth) = options.depth {
                fields.push(("depth", num(depth)));
            }
        }
        Decision::new("ok", fields)
    }

    /// List helpers check the budget before invoking the direct gate.
    /// Does not mutate state: the caller records only accepted, actually used items.
    #[must_use]
    pub fn filter_decision(
        &self,
        kind: &str,
        score: f64,
        state: &SessionState,
        options: &SurfaceOptions,
    ) -> Decision {
        self.rate_limit(kind, score, state)
            .unwrap_or_else(|| self.should_surface(kind, score, state, options))
    }
}

/// Deliberately substring-based, case-insensitive legacy emotional mismatch rule.
#[must_use]
pub fn emotional_mismatch(trajectory: &str, register: &str) -> bool {
    let negative = ["grief", "conflict", "loss", "anger", "anguish"];
    let positive = ["celebration", "joy", "triumph", "delight", "elation"];
    let trajectory = js_to_lower_case(trajectory);
    let register = js_to_lower_case(register);
    (negative.iter().any(|w| trajectory.contains(w))
        && positive.iter().any(|w| register.contains(w)))
        || (positive.iter().any(|w| trajectory.contains(w))
            && negative.iter().any(|w| register.contains(w)))
}
