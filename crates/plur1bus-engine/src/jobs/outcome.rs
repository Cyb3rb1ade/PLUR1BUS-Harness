//! Pure REM partition-report classification, not a job body or partition authorization.
use super::metadata::{get, truthy};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    text::json::TolerantJsonValue as Json,
};

/// Classify the caller's already-selected reports with the actual frozen Node decision rules.
/// Raw opaque pending keys and legacy reason values are retained. A future body must validate
/// them at its typed boundary; this helper neither creates JobRun records nor grants data access.
pub fn rem(
    runs: &[Json],
    narrative_expected: bool,
    dry_run: bool,
    cancel: &Cancel,
) -> Result<Json, EngineError> {
    cancel.check()?;
    if runs.len() > 1024 {
        return Err(StoreError::InvalidInput.into());
    }
    let mut budget = (0, 0);
    for run in runs {
        crate::capture::interference::bounded(run, cancel, &mut budget)?;
    }
    let mut pending = Vec::new();
    let mut completed = 0;
    let mut first_skip = None;
    for run in runs {
        cancel.check()?;
        let result = get(run, "result");
        let report = result.and_then(|result| get(result, "report"));
        if truthy(report) {
            if !dry_run
                && narrative_expected
                && !truthy(report.and_then(|report| get(report, "narrative")))
            {
                // JSON.stringify emits null for an undefined array element; keys are not synthesized.
                pending.push(
                    report
                        .and_then(|report| get(report, "runKey"))
                        .cloned()
                        .unwrap_or(Json::Null),
                );
            } else {
                completed += 1;
            }
        } else if truthy(result.and_then(|result| get(result, "skipped"))) && first_skip.is_none() {
            let reason = result.and_then(|result| get(result, "reason"));
            first_skip = Some(
                reason
                    .filter(|reason| truthy(Some(reason)))
                    .cloned()
                    .unwrap_or_else(|| text("skipped")),
            );
        }
    }
    let (outcome, reason) = if !pending.is_empty() {
        ("incomplete", Some(text("no_narrative")))
    } else if completed > 0 {
        ("completed", None)
    } else {
        (
            "skipped",
            Some(first_skip.unwrap_or_else(|| text("no_partition"))),
        )
    };
    let mut fields = vec![("outcome".into(), text(outcome))];
    if let Some(reason) = reason {
        fields.push(("reason".into(), reason));
    }
    fields.push(("pendingKeys".into(), Json::Array(pending)));
    cancel.check()?;
    Ok(Json::Object(fields))
}
fn text(value: &str) -> Json {
    Json::String(value.into())
}
