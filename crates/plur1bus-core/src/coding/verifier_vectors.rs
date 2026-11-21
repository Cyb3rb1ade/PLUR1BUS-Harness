use super::*;
use serde_json::{json, Value};

const FIXTURE: &str = include_str!("../../../../fixtures/parity/coding/verifier-plan.json");

#[test]
fn verifier_plan_vectors() {
    let recorded: Vec<Value> = serde_json::from_str(FIXTURE).unwrap();
    for value in recorded {
        let name = value["name"].as_str().unwrap();
        let files = serde_json::from_value(value["files"].clone()).unwrap();
        let projected = match detect_verifiers(&files, false) {
            Ok(plan) => json!({ "ok": plan }),
            Err(error) if error.raw => json!({ "err": { "raw": true } }),
            Err(error) => {
                json!({ "err": { "code": error.code.as_str(), "message": error.message } })
            }
        };
        let expected = if let Some(expected) = value.get("ok") {
            json!({ "ok": expected })
        } else {
            json!({ "err": value["err"] })
        };
        assert_eq!(projected, expected, "{name}");
    }
}

#[test]
fn node_fallback_uses_the_requested_platform_separator() {
    let files = BTreeMap::from([("package.json".to_owned(), "{}".to_owned())]);
    let plan = detect_verifiers(&files, true).unwrap();
    assert_eq!(plan.commands[0].argv[0], r"node_modules\.bin\prettier");
}
