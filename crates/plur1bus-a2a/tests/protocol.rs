#![allow(clippy::unwrap_used, reason = "fixture assertions")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_a2a::{events, parts, peer_card};
use plur1bus_providers::Json;
use serde_json::{json, Value};

#[test]
fn parts_replay_typescript_and_omit_unsupported_peer_content_from_errors() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/a2a/parts.json")).unwrap();
    for test in fixture["cases"].as_array().unwrap() {
        let input = Json::parse(test["body"].as_str().unwrap()).unwrap();
        let limits = serde_json::from_value(test["limits"].clone()).unwrap();
        match parts::parse(&input, limits) {
            Ok(parsed) => {
                let parts: Value =
                    serde_json::from_str(&Json::Array(parsed.parts).encode()).unwrap();
                assert_eq!(
                    json!({ "parts": parts, "text": parsed.text }),
                    test["expected"]
                );
            }
            Err(error) => {
                assert_eq!(
                    error.code(),
                    test["expectedError"]["code"].as_str().unwrap()
                );
                let message = if error == parts::Error::Unsupported {
                    "part kind is not supported"
                } else {
                    test["expectedError"]["message"].as_str().unwrap()
                };
                assert_eq!(error.message(), message);
            }
        }
    }
}

#[test]
fn event_frames_replay_typescript_with_exact_json_and_sse_bytes() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/a2a/events.json")).unwrap();
    let task: Json = Json::parse(&fixture["task"].to_string()).unwrap();
    let task = events::TaskRef {
        id: task["id"].text(),
        context_id: task["contextId"].text(),
    };
    let status =
        |state, timestamp, final_event| events::status(task, state, timestamp, None, final_event);
    let frames = [
        events::task(task, events::State::Submitted, "2026-01-01T00:00:00.000Z"),
        status(events::State::Working, "2026-01-01T00:00:01.000Z", false),
        events::artifact(task, "artifact-fixture", "reply", "α\nβ", false, false),
        events::artifact(task, "artifact-fixture", "reply", "🎵", true, true),
        status(events::State::Completed, "2026-01-01T00:00:02.000Z", true),
    ];
    let expected = fixture["chunks"].as_array().unwrap();
    assert_eq!(frames.len(), expected.len());
    for (value, bytes) in frames.into_iter().zip(expected) {
        let actual = events::sse(&Json::from("request-fixture"), value);
        assert_eq!(
            actual.as_bytes(),
            STANDARD.decode(bytes.as_str().unwrap()).unwrap()
        );
    }
}

#[test]
fn verifies_sdk_signed_cards_and_rejects_changed_or_different_origin_cards() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/a2a/peer-cards.json")).unwrap();
    let key = peer_card::PublicKey::parse(&fixture["key"]).unwrap();
    for test in fixture["cases"].as_array().unwrap() {
        let result = peer_card::verify(
            test["card"].to_string().as_bytes(),
            &key,
            test["kid"].as_str().unwrap(),
            test["source"].as_str().unwrap(),
        );
        if test.get("expected").is_some() {
            let verified = result.unwrap();
            assert_eq!(verified.endpoint.as_str(), test["expected"]["endpoint"]);
            assert_eq!(verified.fingerprint, test["expected"]["fingerprint"]);
            assert_eq!(verified.kid, test["expected"]["kid"]);
        } else {
            assert_eq!(result.unwrap_err().code(), test["expectedError"]);
        }
    }
}

#[test]
fn signed_cards_cap_structure_before_the_signature_projection() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/a2a/peer-cards.json")).unwrap();
    let key = peer_card::PublicKey::parse(&fixture["key"]).unwrap();
    let good = &fixture["cases"][0];
    let mut signed = good["card"].clone();
    let check = |value: &Value| {
        peer_card::verify(
            value.to_string().as_bytes(),
            &key,
            good["kid"].as_str().unwrap(),
            good["source"].as_str().unwrap(),
        )
    };
    assert!(check(&signed).is_ok());
    signed["extraDisplay"] = (0..17).fold(json!("public fixture"), |v, _| json!([v]));
    assert_eq!(check(&signed), Err(peer_card::Error::CardSignature));
    signed["extraDisplay"] = json!(vec!["sample"; 257]);
    assert_eq!(check(&signed), Err(peer_card::Error::CardSignature));
}
