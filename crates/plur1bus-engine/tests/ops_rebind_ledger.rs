//! Actual Node C3 sidecars plus concurrent global claims and ownership fencing.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use plur1bus_engine::{
    contract::{Cancel, EngineError},
    ops::rebind_ledger::{RebindLedger, RebindRecord},
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    sync::{Arc, Barrier},
    time::Duration,
};
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
fn record(r: RebindRecord) -> Json {
    Json::Object(vec![
        ("header".into(), r.header.unwrap_or(Json::Null)),
        ("cards".into(), Json::Array(r.cards)),
        ("reversed".into(), Json::Bool(r.reversed)),
    ])
}
fn outcome(r: Result<(), EngineError>) -> Value {
    match r {
        Ok(()) => json!({"ok":true}),
        Err(EngineError::MemoryOp(e)) => json!({"error":e.code}),
        Err(e) => panic!("unexpected {e:?}"),
    }
}
fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
fn disk(root: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        if !dir.exists() {
            return;
        }
        for e in fs::read_dir(dir).unwrap() {
            let e = e.unwrap();
            let p = e.path();
            if p.is_dir() {
                walk(root, &p, out)
            } else {
                out.insert(
                    p.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                    fs::read_to_string(p).unwrap(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}
#[test]
fn c3_rebind_ledger_matches_actual_node() {
    let g: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/rebind-ledger.json")).unwrap();
    let id = g["id"].as_str().unwrap();
    let from = g["from"].as_str().unwrap();
    let to = g["to"].as_str().unwrap();
    let now = g["now"].as_i64().unwrap();
    for case in g["cases"].as_array().unwrap() {
        let temp = scratch();
        let base = temp.path().join("store");
        let root = base.join("_rebinds");
        let label = case["name"].as_str().unwrap();
        if let Some(initial) = case["initial"].as_str() {
            fs::create_dir_all(&root).unwrap();
            fs::write(root.join(format!("{id}.jsonl")), initial).unwrap();
        }
        if let Some(claim) = case["initialClaim"].as_str() {
            fs::create_dir_all(root.join("by-identity")).unwrap();
            fs::write(
                root.join("by-identity")
                    .join(format!("{:x}.json", Sha256::digest(from.as_bytes()))),
                claim,
            )
            .unwrap();
        }
        let ledger = RebindLedger::new(&base);
        let ops = case["ops"].as_array().unwrap();
        let mut results = vec![];
        if !ops.is_empty() {
            let lease = ledger
                .acquire(&Cancel::never(), Duration::from_secs(1))
                .unwrap();
            for op in ops {
                let rid = op["id"].as_str().unwrap_or(id);
                results.push(outcome(match op["op"].as_str().unwrap() {
                    "claim" => lease.write_claim(from, op["to"].as_str().unwrap_or(to), now),
                    "header" => {
                        lease.write_header(rid, op["agent"].as_str().unwrap(), from, to, now)
                    }
                    "card" => lease.append_card(
                        rid,
                        op["card"].as_str().unwrap(),
                        from,
                        to,
                        op["updated"].as_f64().unwrap(),
                        now,
                    ),
                    "reverse" => lease.append_reversed(rid, now),
                    "release" => lease.release_claim_if_free(from),
                    _ => panic!("unknown op"),
                }));
            }
        }
        assert_eq!(json!(results), case["results"], "{label}");
        same(
            &write_json(&record(ledger.load(id).unwrap())),
            case["loadedJson"].as_str().unwrap(),
            label,
        );
        let applied = ledger
            .list_applied()
            .unwrap()
            .into_iter()
            .map(|(id, r)| {
                let Json::Object(mut fields) = record(r) else {
                    unreachable!()
                };
                fields.push(("id".into(), Json::String(id.into())));
                Json::Object(fields)
            })
            .collect();
        same(
            &write_json(&Json::Array(applied)),
            case["appliedJson"].as_str().unwrap(),
            label,
        );
        match ledger.read_claim(from) {
            Ok(value) => same(
                &format!("{{\"value\":{}}}", write_json(&value.unwrap_or(Json::Null))),
                &case["claim"].to_string(),
                label,
            ),
            Err(EngineError::MemoryOp(e)) => {
                assert_eq!(json!({"error":e.code}), case["claim"], "{label}")
            }
            Err(e) => panic!("{e:?}"),
        }
        let actual = disk(&root);
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
            let al = a.lines().collect::<Vec<_>>();
            let bl = b.lines().collect::<Vec<_>>();
            assert_eq!(al.len(), bl.len(), "{label}/{name}");
            for (a, b) in al.into_iter().zip(bl) {
                if parse_json(a).is_ok() && parse_json(b).is_ok() {
                    same(a, b, label)
                } else {
                    assert_eq!(a, b, "{label}/{name}")
                }
            }
        }
        assert_eq!(
            root.exists(),
            case["rootExists"].as_bool().unwrap(),
            "{label}"
        );
    }
}
#[test]
fn engine_wide_claim_conflict_and_nonce_loss_are_fenced() {
    let temp = scratch();
    let base = Arc::new(temp.path().join("store"));
    let barrier = Arc::new(Barrier::new(2));
    let mut threads = vec![];
    for to in ["first", "second"] {
        let base = base.clone();
        let barrier = barrier.clone();
        threads.push(std::thread::spawn(move || {
            let ledger = RebindLedger::new(&base);
            barrier.wait();
            let lease = ledger
                .acquire(&Cancel::never(), Duration::from_secs(2))
                .unwrap();
            outcome(lease.write_claim("source", to, 1))
        }));
    }
    let results = threads
        .into_iter()
        .map(|t| t.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|r| r["ok"] == true).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| r["error"] == "identity-already-bound")
            .count(),
        1
    );
    let ledger = RebindLedger::new(&base);
    let lease = ledger
        .acquire(&Cancel::never(), Duration::from_secs(1))
        .unwrap();
    let lock = base.join("_rebinds/.lock");
    let foreign = b"{\"nonce\":\"synthetic-replacement\"}";
    fs::write(&lock, foreign).unwrap();
    assert_eq!(
        outcome(lease.write_claim("new", "target", 1)),
        json!({"error":"lock-lost"})
    );
    drop(lease);
    assert_eq!(fs::read(lock).unwrap(), foreign);
}
