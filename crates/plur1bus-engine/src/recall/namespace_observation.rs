//! Stage-local observations; T6 owns wall-clock fields and final trace serialization.

use serde_json::{json, Value};

use crate::contract::MemoryRow;

use super::knowledge::CanonicalHit;
use super::merge::preview;
use super::namespace_trace::{NamespaceTrace, TraceLimits};
use super::stages::Rejection;

const DEFAULT_PREVIEW_CHARS: usize = 160;

pub(crate) struct Observations {
    pub trace: NamespaceTrace,
    limits: Option<TraceLimits>,
    rejected: usize,
}

impl Observations {
    pub(crate) fn new(limits: Option<TraceLimits>) -> Self {
        Self {
            trace: NamespaceTrace::default(),
            limits,
            rejected: 0,
        }
    }

    pub(crate) fn vector(&mut self, row: &MemoryRow, score: f64) {
        if self.limits.is_none() {
            return;
        }
        let summary = if row.summary.is_empty() {
            &row.text
        } else {
            &row.summary
        };
        let mut value = candidate(
            &row.id,
            "vector",
            &row.category,
            &row.status,
            summary,
            score,
        );
        finite(&mut value, "vectorScore", score);
        self.candidate(value);
    }

    pub(crate) fn canonical(&mut self, hit: &CanonicalHit) {
        if self.limits.is_none() {
            return;
        }
        let id = format!("canonical:{}", preview(&hit.heading, 40));
        self.candidate(candidate(
            &id,
            "canonical",
            "",
            "active",
            &hit.heading,
            hit.score,
        ));
        self.decision(
            &id,
            "inclusion",
            "canonical",
            "canonical KNOWLEDGE.md hit",
            Some(hit.score),
            None,
        );
    }

    pub(crate) fn scoring<'a>(
        &mut self,
        rows: impl Iterator<Item = (&'a MemoryRow, f64)>,
        emotion: bool,
    ) {
        if self.limits.is_none() {
            return;
        }
        let rows = rows.collect::<Vec<_>>();
        if rows.is_empty() {
            return;
        }
        // At the pin importance contributes through memory strength, never as a second boost.
        let reason = if emotion {
            "emotion/strength/epistemic re-scoring applied"
        } else {
            "strength/epistemic re-scoring applied"
        };
        self.guard("score-recompute", true, reason, None);
        for (row, score) in rows {
            self.decision(
                &row.id,
                "inclusion",
                "score-recompute",
                "re-scored",
                Some(score),
                None,
            );
        }
    }

    pub(crate) fn rejections(&mut self, rejections: &[Rejection]) {
        for rejection in &rejections[self.rejected..] {
            self.decision(
                &rejection.memory_id,
                "rejection",
                &rejection.stage,
                &rejection.reason,
                None,
                None,
            );
            if rejection.reason.starts_with("acl.") {
                self.guard("acl", false, &rejection.reason, Some(&rejection.memory_id));
            }
        }
        self.rejected = rejections.len();
    }

    pub(crate) fn graph(
        &mut self,
        id: &str,
        raw: f64,
        capped: f64,
        anchor: f64,
        depth: usize,
        seed: &str,
    ) {
        let mut value = candidate(
            id,
            "graph",
            "",
            "active",
            &format!("graph-only via {seed}"),
            capped,
        );
        finite(&mut value, "vectorScore", raw);
        value["graphDepth"] = json!(depth);
        self.candidate(value);
        self.decision(
            id,
            "inclusion",
            "associative-merge",
            "weak-association",
            Some(capped),
            Some(json!({"rawGraphScore":raw,"cappedGraphScore":capped,"maxVectorScore":anchor})),
        );
    }

    pub(crate) fn overlap(&mut self, id: &str, score: f64, graph: f64) {
        self.decision(
            id,
            "merged",
            "associative-merge",
            "graph overlap",
            Some(score),
            Some(json!({"vectorScore":score,"graphScore":graph})),
        );
    }

    pub(crate) fn guard(&mut self, name: &str, passed: bool, reason: &str, id: Option<&str>) {
        let Some(limits) = self.limits else {
            return;
        };
        let mut value =
            json!({"name":name,"passed":passed,"reason":preview(reason, DEFAULT_PREVIEW_CHARS)});
        if let Some(id) = id {
            value["memoryId"] = json!(id);
        }
        push(&mut self.trace.guards, value, limits.guards);
    }

    pub(crate) fn decision(
        &mut self,
        id: &str,
        action: &str,
        stage: &str,
        reason: &str,
        score: Option<f64>,
        breakdown: Option<Value>,
    ) {
        let Some(limits) = self.limits else {
            return;
        };
        let mut value = json!({"memoryId":id,"action":action,"stage":stage,
            "reason":preview(reason, DEFAULT_PREVIEW_CHARS)});
        if let Some(score) = score {
            finite(&mut value, "finalScore", score);
        }
        if let Some(breakdown) = breakdown {
            value["scoreBreakdown"] = breakdown;
        }
        push(&mut self.trace.decisions, value, limits.decisions);
    }

    fn candidate(&mut self, value: Value) {
        if let Some(limits) = self.limits {
            push(&mut self.trace.candidates, value, limits.candidates);
        }
    }
}

fn candidate(
    id: &str,
    source: &str,
    category: &str,
    status: &str,
    text: &str,
    score: f64,
) -> Value {
    let mut value = json!({"id":id,"source":source,"category":category,"status":status,
        "preview":preview(text, DEFAULT_PREVIEW_CHARS)});
    finite(&mut value, "score", score);
    value
}

fn finite(value: &mut Value, field: &str, score: f64) {
    if score.is_finite() {
        value[field] = json!(score);
    }
}

fn push(stream: &mut Vec<Value>, value: Value, limit: usize) {
    stream.push(value);
    let excess = stream.len().saturating_sub(limit.max(1));
    if excess > 0 {
        stream.drain(..excess);
    }
}
