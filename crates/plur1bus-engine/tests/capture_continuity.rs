//! Actual frozen-Node continuity decisions and session evolution.
#![allow(clippy::unwrap_used, reason = "golden assertions")]
use plur1bus_engine::{
    capture::continuity::{ContinuityGate, SessionState, SurfaceOptions},
    text::{js::JsString, json::write_json},
};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/capture/golden/continuity.json")).unwrap()
}
fn gate(config: &Value) -> ContinuityGate {
    ContinuityGate {
        assoc_threshold: config["assocThreshold"].as_f64().unwrap_or(0.75),
        pattern_threshold: config["patternThreshold"].as_f64().unwrap_or(0.7),
        max_associations: config["maxAssociations"].as_f64().unwrap_or(1.0),
        max_patterns: config["maxPatterns"].as_f64().unwrap_or(1.0),
    }
}
fn state(value: &Value) -> SessionState {
    SessionState {
        associative_surfaced_count: value["associativeSurfacedCount"].as_f64().unwrap_or(0.0),
        pattern_surfaced_count: value["patternSurfacedCount"].as_f64().unwrap_or(0.0),
        surfaced_ids: None,
    }
}
fn options(value: &Value) -> SurfaceOptions {
    SurfaceOptions {
        depth: value["depth"].as_f64(),
        id: value["id"].as_str().map(JsString::from),
        vector_top_ids: value["vectorTopIds"].as_array().map(|v| {
            v.iter()
                .map(|s| JsString::from(s.as_str().unwrap()))
                .collect()
        }),
        emotional_trajectory: value["emotionalTrajectory"].as_str().map(JsString::from),
        current_register: value["currentRegister"].as_str().map(JsString::from),
    }
}
fn assert_state(state: &SessionState, expected: &Value) {
    let actual: Value = serde_json::from_str(&write_json(&state.to_json())).unwrap();
    assert_eq!(&actual, expected);
}
#[test]
fn direct_gate_decisions_match_node_bytes_and_boundary_order() {
    for case in fixture()["direct"].as_array().unwrap() {
        let input = &case["input"];
        let decision = gate(&input["config"]).should_surface(
            input["type"].as_str().unwrap(),
            input["score"].as_f64().unwrap(),
            &state(&input["state"]),
            &options(&input["options"]),
        );
        assert_eq!(
            write_json(&decision.to_json()),
            case["line"].as_str().unwrap(),
            "{input}"
        );
    }
}
#[test]
fn accepted_items_alone_update_session_counters_and_ordered_ids() {
    for case in fixture()["sequences"].as_array().unwrap() {
        let gate = gate(&case["config"]);
        let mut state = SessionState::default();
        for step in case["steps"].as_array().unwrap() {
            let options = options(step);
            let kind = step["type"].as_str().unwrap();
            let decision =
                gate.should_surface(kind, step["score"].as_f64().unwrap(), &state, &options);
            assert_eq!(
                write_json(&decision.to_json()),
                step["line"].as_str().unwrap()
            );
            if decision.allow {
                state.record(kind, options.id.as_ref());
            }
            assert_state(&state, &step["state"]);
        }
    }
}
#[test]
fn association_list_preserves_non_graph_items_and_node_score_fallbacks() {
    for case in fixture()["lists"].as_array().unwrap() {
        let gate = ContinuityGate {
            assoc_threshold: 0.0,
            max_associations: case["maximum"].as_f64().unwrap(),
            ..ContinuityGate::default()
        };
        let mut state = SessionState {
            associative_surfaced_count: case["count"].as_f64().unwrap(),
            ..SessionState::default()
        };
        let mut kept = Vec::new();
        for item in case["candidates"].as_array().unwrap() {
            if item["graphSource"] != "graph" {
                kept.push(item.clone());
                continue;
            }
            let score = ["relevanceScore", "associatedScore", "associationStrength"]
                .iter()
                .find_map(|key| item[*key].as_f64())
                .unwrap_or(0.0);
            let options = options(item);
            let decision = gate.filter_decision("associative", score, &state, &options);
            if decision.allow {
                state.record("associative", options.id.as_ref());
                kept.push(item.clone());
            }
        }
        assert_eq!(Value::Array(kept), case["result"]);
        assert_state(&state, &case["state"]);
    }
}
#[test]
fn pattern_gate_blocks_opposite_emotions_before_recording() {
    for case in fixture()["patterns"].as_array().unwrap() {
        let gate = ContinuityGate {
            pattern_threshold: 0.0,
            max_patterns: case["maximum"].as_f64().unwrap(),
            ..ContinuityGate::default()
        };
        let mut state = SessionState {
            pattern_surfaced_count: case["count"].as_f64().unwrap(),
            ..SessionState::default()
        };
        let matched = &case["matched"];
        let options = SurfaceOptions {
            emotional_trajectory: matched["pattern"]["emotionalTrajectory"]
                .as_str()
                .map(JsString::from),
            current_register: Some(JsString::from("celebration")),
            ..SurfaceOptions::default()
        };
        let decision = gate.filter_decision(
            "pattern",
            matched["score"].as_f64().unwrap(),
            &state,
            &options,
        );
        let result = if decision.allow {
            state.record(
                "pattern",
                Some(&JsString::from(
                    matched["pattern"]["patternKey"].as_str().unwrap(),
                )),
            );
            matched.clone()
        } else {
            Value::Null
        };
        assert_eq!(result, case["result"]);
        assert_state(&state, &case["state"]);
    }
}
#[test]
fn list_budget_precedes_score_while_direct_gate_checks_score_first() {
    let gate = ContinuityGate::default();
    let state = SessionState {
        associative_surfaced_count: 1.0,
        ..SessionState::default()
    };
    let options = SurfaceOptions::default();
    assert_eq!(
        gate.should_surface("associative", 0.0, &state, &options)
            .reason,
        "score_below_threshold"
    );
    assert_eq!(
        gate.filter_decision("associative", 0.0, &state, &options)
            .reason,
        "rate_limit"
    );
}
