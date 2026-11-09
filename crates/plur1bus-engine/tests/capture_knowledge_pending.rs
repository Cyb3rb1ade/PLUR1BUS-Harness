//! Actual pinned file transitions; a pure result does not authorize publishing or dropping entries.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "offline golden assertions"
)]
use plur1bus_engine::{
    capture::knowledge_pending as pending,
    contract::Cancel,
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue as Json},
    },
};
fn get<'a>(v: &'a Json, key: &str) -> &'a Json {
    if let Json::Object(fields) = v {
        fields
            .iter()
            .find(|(k, _)| k == &JsString::from(key))
            .map(|(_, v)| v)
            .unwrap_or(&Json::Null)
    } else {
        &Json::Null
    }
}
fn array(v: &Json) -> &[Json] {
    if let Json::Array(v) = v {
        v
    } else {
        &[]
    }
}
fn text(v: &Json) -> &JsString {
    let Json::String(v) = v else { panic!("string") };
    v
}
#[test]
fn actual_node_normalization_tracking_removal_and_overflow_match() {
    let golden = parse_json(include_str!(
        "fixtures/capture/golden/knowledge-pending.json"
    ))
    .unwrap();
    for case in array(get(&golden, "cases")) {
        let scenario = get(case, "scenario");
        let name = text(get(scenario, "name"));
        let mut raw = get(scenario, "raw").clone();
        assert_eq!(
            &pending::normalize(&raw, 1735689600000, &Cancel::never()).unwrap(),
            get(case, "initial"),
            "{name:?}"
        );
        let mut curation = Vec::new();
        for step in array(get(case, "steps")) {
            let Json::Number(now) = get(step, "now") else {
                panic!("now")
            };
            let now = now.parse().unwrap();
            let action = get(step, "action");
            let mut changed = false;
            if text(get(action, "kind")) == &JsString::from("track") {
                if let Some(change) =
                    pending::track(&raw, get(action, "memory"), now, &Cancel::never()).unwrap()
                {
                    changed = true;
                    raw = change.state;
                    if let Some(event) = change.curation {
                        curation.push(event);
                    }
                }
            } else {
                let keys: Vec<_> = array(get(action, "keys"))
                    .iter()
                    .map(|v| text(v).clone())
                    .collect();
                let legacy: Vec<_> = array(get(action, "legacy"))
                    .iter()
                    .map(|v| text(v).clone())
                    .collect();
                changed = true;
                raw = pending::remove(&raw, &keys, &legacy, now, &Cancel::never()).unwrap();
            }
            assert_eq!(&raw, get(step, "persisted"), "persisted {name:?}");
            if changed {
                assert_eq!(
                    pending::encode(&raw, &Cancel::never()).unwrap(),
                    text(get(step, "persistedText")).to_utf8_lossy(),
                    "bytes {name:?}"
                );
            }
            assert_eq!(
                &pending::normalize(&raw, now, &Cancel::never()).unwrap(),
                get(step, "snapshot"),
                "snapshot {name:?}"
            );
            assert_eq!(curation, array(get(step, "curation")), "curation {name:?}");
        }
    }
}
#[test]
fn unsupported_identifiers_nonfinite_priority_bounds_and_cancellation_refuse() {
    for raw in [
        r#"{"pending":[{"sourceAgent":true,"memoryId":"id"}]}"#,
        r#"{"pending":[{"sourceAgent":"alpha","memoryId":"id","importance":"NaN"}]}"#,
        r#"{"pendingMemoryIds":[42]}"#,
    ] {
        assert!(
            pending::normalize(&parse_json(raw).unwrap(), 1735689600000, &Cancel::never()).is_err()
        );
    }
    assert!(pending::normalize(&Json::Null, -1, &Cancel::never()).is_err());
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(pending::normalize(&Json::Null, 1735689600000, &cancel).is_err());
    let large = Json::Array(vec![Json::Null; 50001]);
    assert!(pending::normalize(&large, 1735689600000, &Cancel::never()).is_err());
    assert!(pending::remove(
        &Json::Null,
        &vec![JsString::from("key"); 50001],
        &[],
        1735689600000,
        &Cancel::never()
    )
    .is_err());
}
