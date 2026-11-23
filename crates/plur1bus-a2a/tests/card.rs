#![allow(clippy::unwrap_used, reason = "fixture assertions")]

use plur1bus_a2a::card::{build_card, AgentInfo, Error};
use serde_json::{json, Value};

#[test]
fn cards_replay_the_typescript_builders_public_projection() {
    let vectors: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/a2a/cards.json")).unwrap();
    for case in vectors["cases"].as_array().unwrap() {
        let input = &case["input"];
        let features = input
            .get("features")
            .map(|value| serde_json::from_value(value.clone()).unwrap())
            .unwrap_or_default();
        let card = build_card(
            input["id"].as_str().unwrap(),
            &serde_json::from_value(input["info"].clone()).unwrap(),
            input["base"].as_str().unwrap(),
            input["version"].as_str().unwrap(),
            features,
        )
        .unwrap();
        assert_eq!(card, case["expected"]);
        assert!(!card.to_string().contains("synthetic-private-card-marker"));
    }
}

#[test]
fn endpoint_construction_only_exposes_enabled_agents_and_public_fields() {
    let base = "https://agents.example.invalid";
    let disabled: AgentInfo = serde_json::from_value(json!({"optIn": false})).unwrap();
    let enabled: AgentInfo = serde_json::from_value(json!({"optIn": true})).unwrap();
    assert_eq!(
        build_card("example", &disabled, base, "1", Default::default()),
        Err(Error::NotExposed)
    );
    for endpoint in [
        "file:///public",
        "https://user@agents.example.invalid",
        "https://agents.example.invalid?mode=example",
    ] {
        assert_eq!(
            build_card("example", &enabled, endpoint, "1", Default::default()),
            Err(Error::InvalidEndpoint)
        );
    }
    assert_eq!(
        build_card("..", &enabled, base, "1", Default::default()),
        Err(Error::InvalidEndpoint)
    );
}

#[test]
fn a_display_limit_never_splits_a_unicode_scalar() {
    let display = format!("{}📚", "x".repeat(79));
    let info: AgentInfo =
        serde_json::from_value(json!({"optIn": true, "displayName": display})).unwrap();
    let card = build_card(
        "example",
        &info,
        "https://agents.example.invalid",
        "1",
        Default::default(),
    )
    .unwrap();
    assert_eq!(card["name"], "x".repeat(79));
}
