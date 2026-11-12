//! Node field-order projection for capture results; generated contract types stay unchanged.

use serde::Serialize;

use crate::contract::{CaptureResult, EngineError, PerCallDiagnostic};

/// Construct a fixed capture counter result without narrowing its contract type.
#[must_use]
pub fn counts(stored: u64, skipped: u64, reason: Option<&str>) -> CaptureResult {
    CaptureResult {
        stored: stored.into(),
        skipped: skipped.into(),
        reason: reason.map(str::to_owned),
        diagnostics: None,
    }
}

/// Serialize in the public Node capture object's insertion order, including diagnostic order.
/// The schema-generated data type is retained for callers; no global map-order feature is enabled.
pub fn result_json(result: &CaptureResult) -> Result<String, EngineError> {
    #[derive(Serialize)]
    struct Diagnostic<'a> {
        feature: &'a str,
        reason: &'a str,
        fallback: &'a str,
    }
    #[derive(Serialize)]
    struct NodeResult<'a> {
        stored: &'a serde_json::Number,
        skipped: &'a serde_json::Number,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        diagnostics: Option<Vec<Diagnostic<'a>>>,
    }
    let diagnostics = result.diagnostics.as_ref().map(|items| {
        items
            .iter()
            .map(|item| match item {
                PerCallDiagnostic::Inline { .. } => Diagnostic {
                    feature: "postTurnLlm",
                    reason: "post-turn-refine-unscheduled",
                    fallback: "inline",
                },
                PerCallDiagnostic::Unreranked { .. } => Diagnostic {
                    feature: "reranker",
                    reason: "reranker-not-configured",
                    fallback: "unreranked",
                },
            })
            .collect()
    });
    serde_json::to_string(&NodeResult {
        stored: &result.stored,
        skipped: &result.skipped,
        reason: result.reason.as_deref(),
        diagnostics,
    })
    .map_err(|_| EngineError::NotAvailable {
        reason: "capture-result-encoding".into(),
    })
}
