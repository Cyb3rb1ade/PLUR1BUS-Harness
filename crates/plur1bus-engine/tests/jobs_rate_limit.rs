//! Pure rate-limit proposals against actual frozen Node file transitions.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_engine::{
    contract::Cancel,
    jobs::rate_limit::{check, record, Key},
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};

#[test]
fn twenty_three_actual_node_state_transitions_match() {
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/job-rate-limit.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let key = Key::new("gc-run", case["agent"].as_str(), case["workspace"].as_str()).unwrap();
        let mut state = case["initialJson"]
            .as_str()
            .map(|raw| parse_json(raw).unwrap());
        for (index, snapshot) in case["snapshots"].as_array().unwrap().iter().enumerate() {
            if index != 0 {
                state = Some(record(state.as_ref(), &key, 10000.0, &Cancel::never()).unwrap());
            }
            let result = check(state.as_ref(), &key, 1000.0, 10000.0, &Cancel::never()).unwrap();
            assert_eq!(
                write_json(&result),
                snapshot["checkJson"].as_str().unwrap(),
                "{} {index}",
                case["name"]
            );
            assert_eq!(
                state.as_ref().map(write_json).as_deref(),
                snapshot["file"].as_str(),
                "{} {index}",
                case["name"]
            );
        }
    }
}

#[test]
fn invalid_shapes_limits_and_cancel_do_not_propose_replacement() {
    let key = Key::new("gc-run", None, None).unwrap();
    assert!(Key::new("", None, None).is_err());
    assert!(Key::new("gc-run", None, Some(&"x".repeat(1025))).is_err());
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(record(None, &key, 100.0, &cancel).is_err());
    assert!(check(None, &key, 1.0, 100.0, &cancel).is_err());
    for raw in [
        "[]",
        "null",
        r#"{"jobRateLimits":[]}"#,
        r#"{"jobRateLimits":"unsafe"}"#,
        r#"{"jobRateLimits":{},"jobRateLimits":{}}"#,
    ] {
        let state = parse_json(raw).unwrap();
        assert!(
            record(Some(&state), &key, 100.0, &Cancel::never()).is_err(),
            "{raw}"
        );
        assert!(
            check(Some(&state), &key, 1.0, 100.0, &Cancel::never()).is_err(),
            "{raw}"
        );
    }
    for interval in [-1.0, f64::NAN, f64::INFINITY] {
        assert!(check(None, &key, interval, 100.0, &Cancel::never()).is_err());
    }
    assert!(record(None, &key, f64::NAN, &Cancel::never()).is_err());
    let huge = Json::Object(vec![(
        "other".into(),
        Json::String("x".repeat(1_048_577).as_str().into()),
    )]);
    assert!(record(Some(&huge), &key, 100.0, &Cancel::never()).is_err());
}
