//! Optional model enrichment for a compatible deterministic proposal.
use super::{selection, Run};
use crate::{
    capture::merge_decision,
    contract::{EngineError, LlmParams, MemoryRow, StoreError},
    jobs::llm::JobCompletion,
    text::json::{parse_json, write_json},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

pub(super) fn fingerprint(action: &Value) -> String {
    let mut rows = action["expectedRows"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    rows.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let kind = match action["type"].as_str() {
        Some("merge" | "mark_redundant") => "compatible",
        Some(other) => other,
        None => "",
    };
    json!([kind, rows]).to_string()
}

pub(super) fn enrich(
    run: &Run<'_>,
    rows: &HashMap<&str, &MemoryRow>,
    actions: &mut [Value],
) -> Result<(), EngineError> {
    if !actions.iter().any(is_merge_candidate) {
        return Ok(());
    }
    let host = run.job.scope.operations.host_handle();
    let config = serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?;
    let settings = &config["merging"];
    if settings["enabled"] != true {
        return Ok(());
    }
    let Some(route) = JobCompletion::resolve(
        run.authority,
        run.job.completion.as_deref(),
        host,
        &config,
        "merging",
        settings,
    ) else {
        return Ok(());
    };
    for action in actions
        .iter_mut()
        .filter(|action| is_merge_candidate(action))
        .take(20)
    {
        let find = |field: &str| {
            action[field]
                .as_str()
                .and_then(|id| rows.get(id))
                .copied()
                .ok_or(StoreError::Corrupt)
        };
        let elected = find("targetId")?;
        let other = find("id")?;
        run.current(&[elected, other])?;
        let fragments = [elected, other].map(|row| parse_json(&json!(row.text).to_string()));
        let [Ok(a), Ok(b)] = fragments else {
            continue;
        };
        let raw = merge_decision::messages(&a, &b, run.cancel)?;
        let Ok(messages) = serde_json::from_str(&write_json(&raw)) else {
            continue;
        };
        let params = LlmParams {
            messages,
            temperature: Some(0.into()),
            max_tokens: Some(300.into()),
            model: None,
        };
        let short = run
            .cancel
            .limited_to(Instant::now() + Duration::from_secs(30));
        let answer = route.complete_json(params, &short);
        run.cancel.check()?;
        run.current(&[elected, other])?;
        let Ok(answer) = answer else {
            continue;
        };
        let Ok(Some(answer)) = merge_decision::parse_response(&answer.text, run.cancel) else {
            continue;
        };
        let Ok(answer) = serde_json::from_str::<Value>(&write_json(&answer)) else {
            continue;
        };
        let Some(text) = answer["mergedText"]
            .as_str()
            .filter(|v| !v.trim().is_empty() && v.len() <= 16_384)
        else {
            continue;
        };
        if answer["merge"] != true
            || text.encode_utf16().count()
                <= elected
                    .text
                    .encode_utf16()
                    .count()
                    .min(other.text.encode_utf16().count())
        {
            continue;
        }
        *action = json!({"type":"merge","id":elected.id,"targetId":other.id,"mergedText":text,
            "reason":format!("llm_merge: {}",answer["reason"].as_str().unwrap_or_default()),
            "similarity":selection::cosine(&elected.vector,&other.vector),
            "aclBindings":selection::bindings(elected),"expectedRows":[selection::snapshot(elected),selection::snapshot(other)]});
    }
    Ok(())
}

fn is_merge_candidate(action: &Value) -> bool {
    action["reason"] == "compatible_but_not_merged"
}
