//! Replay of the vectors recorded from the stateful parts of the TypeScript secret store
//! (`scripts/parity/export-secrets-store.ts`, `fixtures/parity/secrets-store/*.json`). Recorded, never edited by hand.
use crate::logs::redact::{SecretSet, MAX_REGISTERED_SECRETS};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn load(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/parity/secrets-store/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect()
}

/// `prefix` and four digits, as the exporter's `numbered`.
fn numbered(prefix: &str, i: u64) -> String {
    format!("{prefix}{i:04}")
}

/// Every step of every scenario: the values the registry holds (pinned first, then retired, oldest first), what a subscribed
/// sink heard during the step, and the answer of `mask` and `contains`. A scenario with a `note` is the one place where the
/// Rust registry differs on purpose (P4D-26): there the values are compared as a set.
#[test]
fn the_registry_replays_the_recorded_scenarios() {
    let file = load("registry");
    assert_eq!(file["maxRegistered"], json!(MAX_REGISTERED_SECRETS));
    let mut bad = Vec::new();
    let mut total = 0;
    for scenario in file["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let as_set = scenario.get("note").is_some();
        let set = SecretSet::new();
        let events: Arc<Mutex<Vec<Value>>> = Arc::default();
        let mut sink = None;
        for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            total += 1;
            events.lock().unwrap().clear();
            let op = step["op"].as_array().unwrap();
            let text = |n: usize| op[n].as_str().unwrap();
            let range = || {
                let from = op[2].as_u64().unwrap();
                from..from + op[3].as_u64().unwrap()
            };
            let mut result = None;
            match text(0) {
                "register" => match op[2].as_str() {
                    Some(slot) => set.register_named(text(1), slot),
                    None => set.register(text(1)),
                },
                "many" => range().for_each(|n| set.register(&numbered(text(1), n))),
                "rotate" => {
                    range().for_each(|n| set.register_named(&numbered(text(1), n), text(4)));
                }
                "group" => {
                    let values = strings(&op[2]);
                    let values: Vec<&str> = values.iter().map(String::as_str).collect();
                    set.replace_group(text(1), &values);
                }
                "mask" => result = Some(Value::String(set.mask(text(1)))),
                "contains" => result = Some(Value::Bool(set.contains(text(1)))),
                "subscribe" => {
                    let heard = events.clone();
                    sink = Some(set.subscribe(Box::new(move |value, pinned| {
                        heard.lock().unwrap().push(json!([value, pinned]));
                    })));
                }
                "unsubscribe" => {
                    if let Some(id) = sink.take() {
                        set.unsubscribe(id);
                    }
                }
                other => panic!("{name}: unknown step {other}"),
            }
            let (mut got, mut want) = (set.values(), strings(&step["values"]));
            if as_set {
                got.sort();
                want.sort();
            }
            let heard = Value::Array(events.lock().unwrap().clone());
            if got != want || heard != step["events"] || result.as_ref() != step.get("result") {
                bad.push(format!(
                    "{name} step {i} {}: values {got:?} (recorded {want:?}), events {heard} (recorded {}), result {result:?} (recorded {:?})",
                    step["op"],
                    step["events"],
                    step.get("result")
                ));
            }
        }
    }
    assert!(total > 80, "the grid shrank: {total} steps");
    assert!(
        bad.is_empty(),
        "{} of {total} steps differ:\n{}",
        bad.len(),
        bad.iter().take(5).cloned().collect::<Vec<_>>().join("\n")
    );
}

/// P4D-26, the Rust side of the noted scenario: a retired value that is registered again is the newest retired value, so
/// the bound drops it last, not first.
#[test]
fn a_retired_value_registered_again_is_the_newest_one() {
    let set = SecretSet::new();
    let (a, b, c) = ("alpha-value-one", "bravo-value-two", "charlie-value-three");
    for value in [a, b, a, c] {
        set.register(value);
    }
    assert_eq!(set.values(), [b, a, c]);
    // `a` is in use again and again while other values come and go: it stays, the idle `b` and `c` leave.
    for n in 0..MAX_REGISTERED_SECRETS as u64 {
        set.register(&numbered("passing-value-", n));
        set.register(a);
    }
    assert!(set.contains(a) && !set.contains(b) && !set.contains(c));
    assert_eq!(set.values().len(), MAX_REGISTERED_SECRETS);
}
