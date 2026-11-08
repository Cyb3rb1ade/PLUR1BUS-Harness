//! RE-04/T6: automatic item budgets and request time/trace orchestration.
#![allow(clippy::unwrap_used)]

use plur1bus_engine::recall::budget::resolve_runtime_recall_budget;
use serde_json::Value;

#[test]
fn trace_texts_are_capped_at_the_configured_length() {
    use plur1bus_engine::recall::trace::text_preview;
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/recall/golden/runtime-trace.json")).unwrap();
    for (i, input) in fixture["inputs"].as_array().unwrap().iter().enumerate() {
        for (l, limit) in fixture["limits"].as_array().unwrap().iter().enumerate() {
            let limit = limit.as_u64().unwrap() as usize;
            let expected = fixture["expected"][i][l]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as u16)
                .collect::<Vec<_>>();
            let actual = text_preview(input.as_str().unwrap(), limit);
            assert_eq!(actual.as_utf16_units(), expected, "input {i} limit {limit}");
            // The Node helper appends one ellipsis beyond the configured prefix cap.
            assert!(actual.utf16_len() <= limit + 1);
        }
    }
}

#[test]
fn capped_trace_streams_and_recomputed_counts_match_the_actual_node_helpers() {
    use plur1bus_engine::{
        recall::{namespace_trace::NamespaceTrace, trace::TracePolicy},
        text::json::write_json,
    };
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/recall/golden/runtime-trace.json")).unwrap();
    let streams: NamespaceTrace = serde_json::from_value(fixture["streams"].clone()).unwrap();
    let policy = TracePolicy::new(&fixture["config"], &[]);
    let trace = policy.finish("alpha beta gamma delta", &streams, 0);
    let mut actual: Value = serde_json::from_str(&write_json(&trace)).unwrap();
    strip_trace_clocks(&mut actual);
    assert_eq!(actual, fixture["trace"]);
}

fn strip_trace_clocks(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(strip_trace_clocks),
        Value::Object(fields) => {
            for key in ["traceId", "createdAt", "addedAt", "recordedAt"] {
                fields.remove(key);
            }
            fields.values_mut().for_each(strip_trace_clocks);
        }
        _ => {}
    }
}

#[test]
fn outer_result_keeps_cut_surrogates_in_blocks_and_trace() {
    use plur1bus_engine::{
        recall::{
            blocks::{ContextBlock, RenderedRecall},
            runtime::RecallOutcome,
            trace::TracePolicy,
        },
        text::{js::JsString, json::parse_json},
    };
    let trace = TracePolicy::new(&serde_json::json!({"maxTextPreviewChars":1}), &[]).finish(
        "😀😀",
        &Default::default(),
        0,
    );
    let result = RecallOutcome {
        rendered: RenderedRecall {
            blocks: vec![ContextBlock::new(
                "memories".into(),
                JsString::from("😀").utf16_slice(0, 1),
                true,
            )],
            ..Default::default()
        },
        degraded: None,
        timing: serde_json::json!({"phases":null,"totalMs":0}),
        trace: Some(trace),
        diagnostics: vec![],
        ledger_error: None,
    };
    let wire = result.to_json_line().unwrap();
    assert!(wire.contains("\\ud83d"));
    assert!(!wire.contains('\u{fffd}'));
    assert!(parse_json(&wire).is_ok());
    // F3's exact frozen-contract impedance is explicit, not hidden by lossy replacement.
    assert!(serde_json::from_str::<plur1bus_engine::contract::RecallResult>(&wire).is_err());
}

#[test]
fn canonical_diagnostic_ids_are_rebuilt_losslessly_from_the_redacted_heading() {
    use plur1bus_engine::{
        recall::{namespace_trace::NamespaceTrace, trace::TracePolicy},
        text::json::write_json,
    };
    let heading = format!("{}😀 rest", "z".repeat(39));
    // T4's internal serde_json wrapper cannot hold the split high surrogate.
    let legacy_id = format!("canonical:{}�…", "z".repeat(39));
    let streams = NamespaceTrace {
        candidates: vec![
            serde_json::json!({"id":legacy_id,"source":"canonical","preview":heading}),
        ],
        decisions: vec![
            serde_json::json!({"memoryId":legacy_id,"action":"inclusion","stage":"canonical"}),
        ],
        ..Default::default()
    };
    let trace = TracePolicy::new(&serde_json::json!({"maxTextPreviewChars":2}), &[])
        .finish("", &streams, 0);
    let wire = write_json(&trace);
    assert!(!wire.contains('�'));
    assert_eq!(wire.matches("\\ud83d").count(), 2);
}

#[test]
fn request_budget_uses_config_defaults_and_preserves_zero_character_cap_semantics() {
    use plur1bus_engine::recall::budget::RecallBudget;
    use serde_json::json;
    let config = json!({"runtime":{"recallTimeoutMs":600},"recall":{"softBudgetMs":300,"globalInjectMaxChars":800}});
    let configured = RecallBudget::resolve(&Value::Null, &config);
    assert_eq!(
        (configured.soft_ms, configured.hard_ms, configured.cap_chars),
        (300.0, 600.0, 800.0)
    );
    let overridden =
        RecallBudget::resolve(&json!({"softMs":25,"hardMs":400,"capChars":0}), &config);
    assert_eq!(
        (overridden.soft_ms, overridden.hard_ms, overridden.cap_chars),
        (25.0, 400.0, 0.0)
    );
    let invalid = RecallBudget::resolve(&json!({"softMs":-1,"hardMs":"bad"}), &config);
    assert_eq!((invalid.soft_ms, invalid.hard_ms), (300.0, 600.0));
}

#[test]
fn request_deadline_never_extends_parent_or_cancels_other_callers() {
    use plur1bus_engine::contract::{Cancel, CancelReason};
    use std::time::{Duration, Instant};
    let parent = Cancel::never();
    let expired = parent.limited_to(Instant::now() - Duration::from_millis(1));
    assert_eq!(expired.check().unwrap_err().reason, CancelReason::Deadline);
    assert!(parent.check().is_ok());
    let extended = expired.limited_to(Instant::now() + Duration::from_secs(1));
    assert_eq!(extended.check().unwrap_err().reason, CancelReason::Deadline);
    parent.cancel();
    assert_eq!(expired.check().unwrap_err().reason, CancelReason::Caller);
}

#[test]
fn phase_timer_keeps_namespace_workers_independent_and_bounds_summaries() {
    use plur1bus_engine::recall::timing::PhaseTimer;
    use std::time::Instant;
    let started = Instant::now();
    let mut outer = PhaseTimer::new(started, 100.0, 200.0);
    let mut child = PhaseTimer::new(started, 100.0, 200.0);
    outer.start("namespace-recall");
    child.start("embedding");
    child.end("vector_search");
    assert_eq!(child.summary()["activePhase"], "embedding");
    child.end("embedding");
    assert_eq!(outer.summary()["activePhase"], "namespace-recall");
    for _ in 0..40 {
        child.record("vector_search", 1.0);
    }
    assert_eq!(child.completed().len(), 32);
    outer.end("namespace-recall");
    assert_eq!(outer.completed().len(), 1);
    child.start("rerank");
    child.fail("rerank");
    assert!(child.summary()["activePhase"].is_null());
    assert_eq!(child.summary()["errors"][0]["error"], "phase failed");
}

#[test]
fn runtime_item_budget_matches_node_for_defaults_limits_and_project_signals() {
    let fixture: Value = serde_json::from_str(include_str!(
        "fixtures/recall/golden/runtime-item-budget.json"
    ))
    .unwrap();
    for (q, query) in fixture["queries"].as_array().unwrap().iter().enumerate() {
        for (c, ceiling) in fixture["ceilings"].as_array().unwrap().iter().enumerate() {
            for (a, adaptive) in fixture["adaptations"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
            {
                let actual = resolve_runtime_recall_budget(
                    query.as_str().unwrap(),
                    ceiling.as_f64().unwrap_or(f64::NAN),
                    adaptive,
                );
                assert_eq!(
                    actual as u64,
                    fixture["expected"][q][c][a].as_u64().unwrap(),
                    "query {q}, ceiling {c}, adaptation {a}"
                );
            }
        }
    }
}
