//! Actual Node workspace policy/guard oracles and cross-instance compare-and-set.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "synthetic oracle tests fail immediately"
)]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::ops::workspace_policy::{PolicyError, PolicyStore};
use serde_json::{json, Value};
fn wire(result: Result<Value, PolicyError>) -> Value {
    match result {
        Ok(value) => json!({"value":value}),
        Err(error) => match &error {
            PolicyError::Conflict { current } => json!({"error":error.code(),"current":current}),
            _ => json!({"error":error.code()}),
        },
    }
}
fn normalize(value: &mut Value) {
    match value {
        Value::Number(n) => *n = serde_json::Number::from_f64(n.as_f64().unwrap()).unwrap(),
        Value::Array(items) => items.iter_mut().for_each(normalize),
        Value::Object(fields) => fields.values_mut().for_each(normalize),
        _ => {}
    }
}
#[test]
fn policies_and_guards_match_actual_node_canonicalization_cas_and_corrupt_state() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/workspace-policy.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let path = root.path().join("control/workspace-policy.json");
        if case.get("raw").is_some() || !case["initialState"].is_null() {
            std::fs::create_dir(path.parent().unwrap()).unwrap();
            std::fs::write(
                &path,
                case["raw"]
                    .as_str()
                    .map_or_else(|| case["initialState"].to_string(), str::to_owned),
            )
            .unwrap();
        }
        let store = PolicyStore::new(root.path()).unwrap();
        let now = golden["now"].as_i64().unwrap();
        let mut results = vec![];
        let mut invalidations = vec![];
        if case["guard"] == true {
            let context = if case["missing"] == true {
                json!({})
            } else {
                json!({"agentId":"agent","workspaceIdentity":"workspace:v1:fixture"})
            };
            if case["disable"] == true {
                results.push(wire(store.set_and_invalidate(&json!({"agentId":"agent","workspaceIdentity":"workspace:v1:fixture","enabled":false,"expectedRevision":0,"actorId":"actor"}),now,|identity|{invalidations.push(identity.clone());Ok(())})));
            }
            results.push(wire(store.decision(&context, case["maintenance"] == true)));
            results.push(wire(
                store.require_enabled(&context, case["maintenance"] == true),
            ));
            results.push(json!({"value":store.automatic(&context,case["maintenance"]==true)}));
        } else {
            for op in case["ops"].as_array().unwrap() {
                results.push(wire(match op["kind"].as_str().unwrap() {
                    "get" => store.get(&op["value"]),
                    "list" => store.list(),
                    "set" => store.set(&op["value"], now),
                    other => panic!("unknown {other}"),
                }));
            }
        }
        let state = std::fs::read_to_string(&path)
            .map(|s| serde_json::from_str::<Value>(&s).unwrap_or_else(|_| json!({"raw":s})))
            .unwrap_or(Value::Null);
        let mut actual = json!({"results":results,"invalidations":invalidations,"state":state});
        let mut expected = json!({"results":case["results"],"invalidations":case["invalidations"],"state":case["state"]});
        normalize(&mut actual);
        normalize(&mut expected);
        assert_eq!(actual, expected, "{}", case["name"]);
    }
}
#[test]
fn independent_handles_cannot_lose_a_revision_and_failed_invalidation_does_not_undo_commit() {
    let root = support::canonical_tempdir();
    let a = PolicyStore::new(root.path()).unwrap();
    let b = PolicyStore::new(root.path()).unwrap();
    let input = json!({"agentId":"agent","workspaceIdentity":"workspace:v1:fixture","enabled":false,"expectedRevision":0,"actorId":"actor"});
    let outcomes = std::thread::scope(|scope| {
        let one = scope.spawn(|| a.set(&input, 10));
        let two = scope.spawn(|| b.set(&input, 10));
        [one.join().unwrap(), two.join().unwrap()]
    });
    assert_eq!(outcomes.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter(|r| matches!(r, Err(PolicyError::Conflict { .. })))
            .count(),
        1
    );
    let patch = json!({"expectedRevision":1,"enabled":true,"agentId":"agent","workspaceIdentity":"workspace:v1:fixture","actorId":"actor"});
    assert!(matches!(
        a.set_and_invalidate(&patch, 11, |_| Err(PolicyError::Storage)),
        Err(PolicyError::Storage)
    ));
    assert_eq!(b.get(&input).unwrap()["revision"], 2);
    assert_eq!(b.get(&input).unwrap()["enabled"], true);
    let state: Value = serde_json::from_slice(
        &std::fs::read(root.path().join("control/workspace-policy.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(state["revision"], 2);
}
