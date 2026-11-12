//! The unchanged diagnostic schema must retain each tagged branch's constant fields.
#![allow(clippy::unwrap_used)]

use plur1bus_engine::contract::PerCallDiagnostic;
use serde_json::json;

#[test]
fn both_diagnostic_branches_roundtrip_without_reusing_the_other_branches_enum() {
    for value in [
        json!({"feature":"postTurnLlm","reason":"post-turn-refine-unscheduled","fallback":"inline"}),
        json!({"feature":"reranker","reason":"reranker-not-configured","fallback":"unreranked"}),
    ] {
        let diagnostic: PerCallDiagnostic = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(diagnostic).unwrap(), value);
    }
}

#[test]
fn an_inline_diagnostic_rejects_reranker_fields_and_extra_properties() {
    for value in [
        json!({"feature":"reranker","reason":"reranker-not-configured","fallback":"inline"}),
        json!({"feature":"postTurnLlm","reason":"post-turn-refine-unscheduled","fallback":"unreranked"}),
        json!({"feature":"postTurnLlm","reason":"post-turn-refine-unscheduled","fallback":"inline","extra":true}),
    ] {
        assert!(serde_json::from_value::<PerCallDiagnostic>(value).is_err());
    }
}
