//! Frozen state/classification decisions; no push adapter or background model jobs.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use plur1bus_engine::{
    capture::critical,
    contract::{Cancel, HostError, LlmParams, LlmPort, LlmResult},
    text::json::parse_json,
};
use serde_json::{json, Value};
use std::sync::Mutex;
struct Port {
    answer: String,
    fail: bool,
    cancel: bool,
    calls: Mutex<Vec<LlmParams>>,
}
impl LlmPort for Port {
    fn complete(&self, params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError> {
        self.calls.lock().unwrap().push(params);
        if self.cancel {
            cancel.cancel();
        }
        if self.fail {
            Err(HostError::Unavailable)
        } else {
            Ok(LlmResult {
                text: self.answer.clone(),
                usage: None,
                model: None,
            })
        }
    }
}
#[test]
fn state_and_source_role_match_frozen_node() {
    let f: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/critical-state.json")).unwrap();
    use sha2::{Digest, Sha256};
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("../src/capture/critical-data.json"))
        ),
        f["dataSha256"]
    );
    for case in f["state"].as_array().unwrap() {
        let card = parse_json(&case["card"].to_string()).unwrap();
        assert_eq!(
            json!({"role":critical::source_role(&card),"assistant":critical::is_assistant(&card),"explicit":critical::explicit_importance(&card),"dream":critical::is_dream(&card),"eligible":critical::eligible(&card)}),
            json!({"role":case["role"],"assistant":case["assistant"],"explicit":case["explicit"],"dream":case["dream"],"eligible":case["eligible"]}),
            "{}",
            case["card"]
        );
    }
}
#[test]
fn exact_prompt_and_strict_type_responses_match_node() {
    let f: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/critical-state.json")).unwrap();
    for case in f["classification"].as_array().unwrap() {
        let port = Port {
            answer: case["response"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    if case["response"].is_null() {
                        String::new()
                    } else {
                        case["response"].to_string()
                    }
                }),
            fail: case["kind"] == "reject",
            cancel: false,
            calls: Mutex::new(Vec::new()),
        };
        let result = critical::classify(
            case["content"].as_str().unwrap(),
            if case["kind"] == "absent" {
                None
            } else {
                Some(&port)
            },
            &Cancel::never(),
        );
        let actual = if case.get("kind").is_some() {
            match result {
                Ok(value) => json!({"value":value}),
                Err(_) => json!({"error":true}),
            }
        } else {
            json!(result.unwrap())
        };
        assert_eq!(actual, case["result"]);
        let calls = port.calls.lock().unwrap();
        assert_eq!(calls.len(), case["calls"].as_array().unwrap().len());
        for (call, expected) in calls.iter().zip(case["calls"].as_array().unwrap()) {
            assert_eq!(call.messages.len(), 1);
            assert_eq!(call.messages[0].content, expected["prompt"]);
            assert!(
                call.model.is_none() && call.temperature.is_none() && call.max_tokens.is_none()
            );
        }
    }
}
#[test]
fn cancellation_never_becomes_an_ordinary_fact_fallback() {
    let port = Port {
        answer: "gesundheit".into(),
        fail: false,
        cancel: true,
        calls: Mutex::new(Vec::new()),
    };
    assert!(critical::classify("Synthetic memory", Some(&port), &Cancel::never()).is_err());
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(critical::classify("Synthetic memory", Some(&port), &cancel).is_err());
    assert_eq!(port.calls.lock().unwrap().len(), 1);
}

#[test]
fn critical_memory_remains_unconfirmed_through_real_lance_recall_projection() {
    use plur1bus_engine::{
        contract::MemoryRow,
        embedding::EmbeddingProvider,
        recall::{hash_embed::HashEmbedder, namespace_entry::project_entry},
        store::{OpenMode, RowFilter, Store},
    };
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/safe-update.json")).unwrap();
    let original = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "critical")
        .unwrap()["original"]
        .clone();
    let row: MemoryRow = serde_json::from_value(original).unwrap();
    assert_eq!(row.type_, "gesundheit");
    assert!(!row.confirmed);
    let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let path = root.path().join("agent");
    let mut identity = HashEmbedder::new().identity().clone();
    identity.dimension = 4.into();
    let store = Store::create(&path, &identity, 4).unwrap();
    store.upsert(std::slice::from_ref(&row)).unwrap();
    drop(store);
    let store = Store::open(&path, OpenMode::ReadOnly, Some(&identity)).unwrap();
    let hits = store
        .search(
            &row.vector,
            10,
            &RowFilter {
                agent_id: Some("agent".into()),
                status: Some("active".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(hits.len(), 1);
    let projected = project_entry(&hits[0].row);
    assert_eq!(projected["confirmed"], false);
    assert_eq!(projected["id"], row.id);
}
