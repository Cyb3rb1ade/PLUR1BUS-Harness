//! Actual pinned normal-store helper outputs; workflow recordings remain source evidence.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "frozen Node fixture assertions"
)]
use plur1bus_engine::{
    capture::durable_merge,
    contract::Cancel,
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
fn field<'a>(v: &'a Json, key: &str) -> &'a Json {
    let Json::Object(fields) = v else {
        panic!("object")
    };
    &fields
        .iter()
        .find(|(name, _)| name == &JsString::from(key))
        .unwrap()
        .1
}
fn array(v: &Json) -> &[Json] {
    let Json::Array(values) = v else {
        panic!("array")
    };
    values
}
fn string(v: &Json) -> &JsString {
    let Json::String(value) = v else {
        panic!("string")
    };
    value
}
#[test]
fn actual_node_write_keys_lineage_and_epistemic_projections_are_byte_exact() {
    let golden = parse_json(include_str!("fixtures/capture/golden/durable-merge.json")).unwrap();
    for case in array(field(&golden, "keys")) {
        assert_eq!(
            durable_merge::write_key(field(case, "input"), &Cancel::never()).unwrap(),
            *string(field(case, "value"))
        );
    }
    for case in array(field(&golden, "lineages")) {
        assert_eq!(
            write_json(
                &durable_merge::lineage(field(case, "candidate"), &Cancel::never()).unwrap()
            ),
            write_json(field(case, "value"))
        );
    }
    for case in array(field(&golden, "metadata")) {
        assert_eq!(
            write_json(
                &durable_merge::epistemic_metadata(
                    field(case, "candidate"),
                    1735689600000,
                    &Cancel::never()
                )
                .unwrap()
            ),
            write_json(field(case, "value"))
        );
    }
}
#[test]
fn actual_node_replacement_ids_and_success_idempotency_key_match() {
    let golden = parse_json(include_str!("fixtures/capture/golden/durable-merge.json")).unwrap();
    for case in array(field(&golden, "identities")) {
        let actual = durable_merge::identity(
            &string(field(case, "agentId")).to_utf8_lossy(),
            &string(field(case, "candidateId")).to_utf8_lossy(),
            string(field(case, "effectiveWriteKey")),
            &Cancel::never(),
        )
        .unwrap();
        assert_eq!(
            actual.replacement_id,
            string(field(case, "replacementId")).to_utf8_lossy()
        );
    }
    for case in array(field(&golden, "cases")).iter().filter(|case| {
        ["success", "existing-exact"]
            .contains(&string(field(case, "name")).to_utf8_lossy().as_str())
    }) {
        let actual = durable_merge::identity(
            "alpha",
            &string(field(field(case, "original"), "id")).to_utf8_lossy(),
            string(field(case, "writeKey")),
            &Cancel::never(),
        )
        .unwrap();
        assert_eq!(
            actual.idempotency_key,
            string(field(field(case, "result"), "idempotencyKey")).to_utf8_lossy()
        );
    }
}
#[test]
fn cancellation_and_resource_bounds_refuse_without_an_identity() {
    let cancel = Cancel::never();
    cancel.cancel();
    let empty = parse_json("{}").unwrap();
    assert!(durable_merge::write_key(&empty, &cancel).is_err());
    assert!(durable_merge::lineage(&empty, &cancel).is_err());
    assert!(durable_merge::epistemic_metadata(&empty, 0, &cancel).is_err());
    let huge = Json::Object(vec![(
        "text".into(),
        Json::String("x".repeat(1_048_577).as_str().into()),
    )]);
    assert!(durable_merge::write_key(&huge, &Cancel::never()).is_err());
    let escaped = Json::Object(vec![(
        "text".into(),
        Json::String(JsString::from_utf16_units(vec![0; 200_000])),
    )]);
    assert!(durable_merge::write_key(&escaped, &Cancel::never()).is_err());
    assert!(durable_merge::identity(
        "alpha",
        "11111111111141118111111111111111",
        &"fixture".into(),
        &Cancel::never()
    )
    .is_err());

    assert!(durable_merge::identity(
        "../foreign",
        "11111111-1111-4111-8111-111111111111",
        &"fixture".into(),
        &Cancel::never()
    )
    .is_err());
    assert!(
        durable_merge::identity("alpha", "invalid-id", &"fixture".into(), &Cancel::never())
            .is_err()
    );
    assert!(durable_merge::identity(
        "alpha",
        "11111111-1111-4111-8111-111111111111",
        &JsString::from("x".repeat(1_048_577).as_str()),
        &Cancel::never()
    )
    .is_err());
}
