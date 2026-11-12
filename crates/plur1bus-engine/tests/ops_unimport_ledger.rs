//! Node-real undo generations, repair, quarantine and the shared import lock fence.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "recorded fixture assertions"
)]
use plur1bus_engine::{
    contract::{Cancel, EngineError},
    ops::{
        import_lock,
        unimport_ledger::{UndoReceipt, UnimportLedger, UnimportState},
    },
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, time::Duration};
fn canon(j: &mut Json) {
    match j {
        Json::Number(n) => {
            *n = ryu_js::Buffer::new()
                .format(n.parse::<f64>().unwrap())
                .to_owned()
        }
        Json::Array(a) => a.iter_mut().for_each(canon),
        Json::Object(o) => {
            o.iter_mut().for_each(|(_, v)| canon(v));
            o.sort_by(|(a, _), (b, _)| a.as_utf16_units().cmp(b.as_utf16_units()));
        }
        _ => {}
    }
}
fn same(a: &str, b: &str, label: &str) {
    let mut a = parse_json(a).unwrap();
    let mut b = parse_json(b).unwrap();
    canon(&mut a);
    canon(&mut b);
    assert_eq!(a, b, "{label}");
}
fn state(s: UnimportState) -> Json {
    let sorted = |set: std::collections::HashSet<JsString>| {
        let mut a = set.into_iter().collect::<Vec<_>>();
        a.sort_by(|a, b| a.as_utf16_units().cmp(b.as_utf16_units()));
        Json::Array(a.into_iter().map(Json::String).collect())
    };
    Json::Object(vec![
        ("exists".into(), Json::Bool(s.exists)),
        ("header".into(), s.header.unwrap_or(Json::Null)),
        ("intents".into(), sorted(s.intents)),
        ("done".into(), sorted(s.done)),
    ])
}
fn result(r: Result<(), EngineError>) -> Value {
    match r {
        Ok(()) => json!({"ok":true}),
        Err(EngineError::MemoryOp(e)) => json!({"error":e.code}),
        Err(e) => panic!("{e:?}"),
    }
}
#[test]
fn unimport_generations_and_durable_sidecars_match_actual_node() {
    let g: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/unimport-ledger.json")).unwrap();
    let agent = g["agent"].as_str().unwrap();
    let run = g["run"].as_str().unwrap();
    let now = g["now"].as_i64().unwrap();
    for case in g["cases"].as_array().unwrap() {
        let temp = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let base = temp.path().join("store");
        fs::create_dir(&base).unwrap();
        let folder = base.join("_unimports").join(agent);
        if let Some(initial) = case["initial"].as_str() {
            fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join(format!("{run}.jsonl")), initial).unwrap();
        }
        let ledger = UnimportLedger::new(&base);
        let mut results = vec![];
        let ops = case["ops"].as_array().unwrap();
        if !ops.is_empty() {
            let lease =
                import_lock::acquire(&base, agent, &Cancel::never(), Duration::from_secs(1))
                    .unwrap();
            for op in ops {
                if op["loseLock"] == true {
                    fs::write(
                        base.join("_imports/.locks").join(format!("{agent}.lock")),
                        "{\"nonce\":\"synthetic-replacement\"}",
                    )
                    .unwrap();
                }
                let receipt = UndoReceipt {
                    generation: None,
                    card_id: op["cardId"].as_str().unwrap_or("").into(),
                    idempotency_key: op["idempotencyKey"].as_str().unwrap_or("").into(),
                    imported_at: op["importedAt"].as_f64().unwrap_or(0.),
                };
                results.push(result(match op["op"].as_str().unwrap() {
                    "header" => ledger.ensure_header(agent, run, now, &lease),
                    "prepare" => ledger.prepare(agent, run, now, &lease),
                    "intent" => ledger.append_intent(agent, run, &receipt, now, &lease),
                    "done" => ledger.append_done(agent, run, &receipt, now, &lease),
                    _ => panic!("unknown fixture op"),
                }));
            }
        }
        let label = case["name"].as_str().unwrap();
        assert_eq!(json!(results), case["results"], "{label}");
        same(
            &write_json(&state(ledger.load(agent, run).unwrap())),
            case["loadedJson"].as_str().unwrap(),
            label,
        );
        let mut actual = BTreeMap::new();
        if folder.exists() {
            for e in fs::read_dir(&folder).unwrap() {
                let p = e.unwrap().path();
                actual.insert(
                    p.file_name().unwrap().to_str().unwrap().to_owned(),
                    fs::read_to_string(&p).unwrap(),
                );
            }
        }
        let expected: BTreeMap<String, String> =
            serde_json::from_value(case["disk"].clone()).unwrap();
        assert_eq!(
            actual.keys().collect::<Vec<_>>(),
            expected.keys().collect::<Vec<_>>(),
            "{label}"
        );
        for (name, a) in actual {
            let b = &expected[&name];
            assert_eq!(a.ends_with('\n'), b.ends_with('\n'), "{label}/{name}");
            assert_eq!(a.lines().count(), b.lines().count(), "{label}/{name}");
            for (a, b) in a.lines().zip(b.lines()) {
                if parse_json(a).is_ok() && parse_json(b).is_ok() {
                    same(a, b, label)
                } else {
                    assert_eq!(a, b, "{label}/{name}")
                }
            }
        }
        assert_eq!(
            base.join("_unimports").exists(),
            case["rootExists"].as_bool().unwrap(),
            "{label}"
        );
    }
}
#[test]
fn invalid_paths_and_nonfile_journals_fail_without_creating_state() {
    let temp = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let ledger = UnimportLedger::new(temp.path());
    for (agent, run) in [("../agent", "run"), ("agent", "../run"), ("agent", "")] {
        let error = ledger.load(agent, run).err().unwrap();
        assert!(matches!(error, EngineError::MemoryOp(_)));
    }
    assert!(!temp.path().join("_unimports").exists());
    let file = temp.path().join("_unimports/agent/run.jsonl");
    fs::create_dir_all(&file).unwrap();
    assert!(ledger.load("agent", "run").is_err());
    assert!(file.is_dir());
}
