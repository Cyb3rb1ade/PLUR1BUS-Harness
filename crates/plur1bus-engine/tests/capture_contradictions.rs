//! Actual Node pair ordering and prompt hashes, with no live model calls.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use plur1bus_engine::{
    capture::contradiction::Detector,
    contract::{Cancel, HostError, LlmParams, LlmPort, LlmResult},
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Mutex;

struct Port {
    response: String,
    fail: bool,
    abort: bool,
    calls: Mutex<Vec<LlmParams>>,
}
impl LlmPort for Port {
    fn complete(&self, params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError> {
        self.calls.lock().unwrap().push(params);
        if self.abort {
            cancel.cancel();
        }
        if self.fail {
            return Err(HostError::Unavailable);
        }
        Ok(LlmResult {
            text: self.response.clone(),
            usage: None,
            model: None,
        })
    }
}
fn frozen(value: &Value) -> Json {
    parse_json(&value.to_string()).unwrap()
}
fn records(rows: Vec<Json>) -> Value {
    let mut rows: Value = serde_json::from_str(&write_json(&Json::Array(rows))).unwrap();
    for row in rows.as_array_mut().unwrap() {
        assert!(uuid::Uuid::parse_str(row["id"].as_str().unwrap()).is_ok());
        row["id"] = json!("__UUID__");
    }
    rows
}
#[test]
fn fifty_actual_node_scenarios_match_results_pair_order_and_prompt_hashes() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/contradictions.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let port = Port {
            response: case["response"].as_str().unwrap().into(),
            fail: case["port"] == "reject",
            abort: false,
            calls: Mutex::new(vec![]),
        };
        let detector = Detector::new(
            if case["port"] == "absent" {
                None
            } else {
                Some(&port)
            },
            case["constructorMaxPairs"].as_f64(),
            golden["now"].as_i64().unwrap(),
        );
        let input = &case["input"];
        let limit = case.get("maxPairs").and_then(Value::as_f64);
        let cancel = Cancel::never();
        let result = match case["method"].as_str().unwrap() {
            "pair" => json!(detector
                .detect(&frozen(&input[0]), &frozen(&input[1]), &cancel)
                .unwrap()),
            "overlays" => records(detector.find(&frozen(input), limit, &cancel).unwrap()),
            "new" => records(
                detector
                    .find_for_new(&frozen(&input[0]), &frozen(&input[1]), limit, &cancel)
                    .unwrap(),
            ),
            "texts" => records(
                detector
                    .find_memory_text(&frozen(input), limit, &cancel)
                    .unwrap(),
            ),
            other => panic!("unknown method {other}"),
        };
        assert_eq!(result, case["result"], "{}", case["name"]);
        let calls = port.calls.lock().unwrap();
        assert_eq!(
            calls.len(),
            case["calls"].as_array().unwrap().len(),
            "{}",
            case["name"]
        );
        for (actual, expected) in calls.iter().zip(case["calls"].as_array().unwrap()) {
            let messages: Value = serde_json::to_value(&actual.messages).unwrap();
            assert_eq!(messages, expected["messages"], "{}", case["name"]);
            // Preserve the Node message object's insertion order in its hashed JSON.
            let ordered = Json::Array(
                actual
                    .messages
                    .iter()
                    .map(|message| {
                        Json::Object(vec![
                            (
                                "role".into(),
                                frozen(&serde_json::to_value(message.role).unwrap()),
                            ),
                            (
                                "content".into(),
                                Json::String(message.content.as_str().into()),
                            ),
                        ])
                    })
                    .collect(),
            );
            assert_eq!(
                format!("{:x}", Sha256::digest(write_json(&ordered).as_bytes())),
                expected["sha256"]
            );
            assert!(
                actual.model.is_none()
                    && actual.temperature.is_none()
                    && actual.max_tokens.is_none()
            );
        }
    }
}

#[test]
fn cancellation_before_or_during_the_model_call_never_becomes_no_conflict() {
    let a = frozen(
        &json!({"id":"a","targetMemoryId":"m","shiftType":"meaning","shiftDescription":"A"}),
    );
    let b = frozen(
        &json!({"id":"b","targetMemoryId":"m","shiftType":"meaning","shiftDescription":"B"}),
    );
    let port = Port {
        response: "yes".into(),
        fail: true,
        abort: true,
        calls: Mutex::new(vec![]),
    };
    let detector = Detector::new(Some(&port), None, 0);
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(detector.detect(&a, &b, &cancel).is_err());
    assert_eq!(port.calls.lock().unwrap().len(), 0);
    assert!(detector.detect(&a, &b, &Cancel::never()).is_err());
    assert_eq!(port.calls.lock().unwrap().len(), 1);
}

#[test]
fn excessive_inputs_and_descriptions_refuse_before_model_egress() {
    let port = Port {
        response: "yes".into(),
        fail: false,
        abort: false,
        calls: Mutex::new(vec![]),
    };
    let detector = Detector::new(Some(&port), Some(f64::INFINITY), 0);
    let row = frozen(
        &json!({"id":"a","targetMemoryId":"m","shiftType":"meaning","shiftDescription":"A"}),
    );
    assert!(detector
        .find(&Json::Array(vec![row; 513]), None, &Cancel::never())
        .is_err());
    let large = frozen(
        &json!({"id":"a","targetMemoryId":"m","shiftType":"meaning","shiftDescription":"x".repeat(65537)}),
    );
    assert!(detector.detect(&large, &large, &Cancel::never()).is_err());
    assert_eq!(port.calls.lock().unwrap().len(), 0);
}

#[test]
fn native_pair_cap_does_not_allow_an_unbounded_configured_scan() {
    let port = Port {
        response: "no".into(),
        fail: false,
        abort: false,
        calls: Mutex::new(vec![]),
    };
    let detector = Detector::new(Some(&port), Some(10_000.), 0);
    let rows = Json::Array((0..48).map(|id| frozen(&json!({
        "id":id.to_string(),"targetMemoryId":"memory","shiftType":"meaning","shiftDescription":"Synthetic interpretation"
    }))).collect());
    assert!(detector
        .find(&rows, Some(10_000.), &Cancel::never())
        .unwrap()
        .is_empty());
    assert_eq!(port.calls.lock().unwrap().len(), 1000);
}

#[test]
fn an_unpaired_source_unit_is_refused_instead_of_silently_rewriting_the_prompt() {
    let port = Port {
        response: "yes".into(),
        fail: false,
        abort: false,
        calls: Mutex::new(vec![]),
    };
    let detector = Detector::new(Some(&port), None, 0);
    let source = parse_json(r#"{"id":"a","targetMemoryId":"memory","shiftType":"meaning","shiftDescription":"text\ud800"}"#).unwrap();
    assert!(detector.detect(&source, &source, &Cancel::never()).is_err());
    assert_eq!(port.calls.lock().unwrap().len(), 0);
}
