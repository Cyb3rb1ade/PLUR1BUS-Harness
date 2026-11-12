//! C3 import identities, durable digest baselines and raw receipt index parity.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "synthetic oracle assertions"
)]
use plur1bus_engine::{
    ops::{
        import_ledger::{ImportIndex, ImportLedger, ImportLine},
        import_primitives::{import_card_id, import_row_digest, ImportDigest},
    },
    text::{
        js::JsString,
        json::{parse_json, write_json},
    },
};
use serde_json::{json, Value};
use std::collections::HashMap;
#[path = "recall_support.rs"]
mod support;

fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/ops/golden/import-primitives.json")).unwrap()
}
fn map_wire(map: &HashMap<JsString, ImportLine>) -> Value {
    Value::Object(
        map.iter()
            .map(|(key, row)| {
                (
                    String::from_utf16(key.as_utf16_units()).unwrap(),
                    serde_json::from_str(&write_json(&row.raw)).unwrap(),
                )
            })
            .collect(),
    )
}
fn index_wire(index: &ImportIndex) -> Value {
    json!({"byKey":map_wire(&index.by_key), "byCardId":map_wire(&index.by_card_id), "unimportedByCardId":map_wire(&index.unimported_by_card_id)})
}

#[test]
fn ids_and_group_digests_match_actual_node() {
    let cases = golden();
    for case in cases["ids"].as_array().unwrap() {
        assert_eq!(
            import_card_id(
                case["agent"].as_str().unwrap(),
                case["key"].as_str().unwrap()
            ),
            case["id"].as_str().unwrap(),
            "{case}"
        );
    }
    for case in cases["digests"].as_array().unwrap() {
        let input = case["rowJson"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| case["row"].to_string());
        let digest = import_row_digest(&parse_json(&input).unwrap());
        assert!(digest.is_valid());
        assert_eq!(
            serde_json::to_value(digest).unwrap(),
            case["digest"],
            "{case}"
        );
    }
    let mut invalid: ImportDigest =
        serde_json::from_value(cases["digests"][0]["digest"].clone()).unwrap();
    invalid.content = "A".repeat(16);
    assert!(!invalid.is_valid());
    invalid.content = "a".repeat(17);
    assert!(!invalid.is_valid());
}

#[test]
fn torn_lines_append_projection_and_unimport_indices_match_actual_node() {
    for case in golden()["ledgers"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let path = root.path().join("_imports/agent.jsonl");
        std::fs::create_dir(path.parent().unwrap()).unwrap();
        let mut initial = case["initial"].as_str().unwrap().to_owned();
        if let Some(extras) = case["extraLines"].as_array() {
            initial.push('\n');
            initial.push_str(
                &extras
                    .iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
        std::fs::write(&path, initial).unwrap();
        let ledger = ImportLedger::new(root.path());
        for row in case["append"].as_array().unwrap() {
            ledger
                .append("agent", &parse_json(&row.to_string()).unwrap())
                .unwrap();
        }
        let lines: Vec<Value> = ledger
            .read_lines("agent")
            .unwrap()
            .iter()
            .map(|row| serde_json::from_str(&write_json(&row.raw)).unwrap())
            .collect();
        assert_eq!(json!(lines), case["lines"], "{}", case["name"]);
        assert_eq!(
            index_wire(&ledger.load("agent").unwrap()),
            case["index"],
            "{}",
            case["name"]
        );
    }
}

#[test]
fn read_is_noncreating_errors_do_not_masquerade_as_empty_and_utf16_is_lossless() {
    let root = support::canonical_tempdir();
    let base = root.path().join("missing");
    let ledger = ImportLedger::new(&base);
    assert!(ledger.read_lines("agent").unwrap().is_empty());
    assert!(ledger.read_lines("../escape").unwrap().is_empty());
    assert!(!base.exists());
    let input = parse_json(r#"{"idempotencyKey":"a\ud800","cardId":"card","opaque":"ignored","sourceRef":"legacy\udfff","digest":{"unknown":"\ud800"}}"#).unwrap();
    assert!(ledger.append("../escape", &input).is_err());
    assert!(!base.exists());
    ledger.append("agent", &input).unwrap();
    let stored = ledger.read_lines("agent").unwrap();
    let raw = write_json(&stored[0].raw);
    assert!(raw.contains(r#""sourceRef":"legacy\udfff""#));
    assert!(raw.contains(r#""digest":{"unknown":"\ud800"}"#));
    assert!(!raw.contains("opaque"));
    let key = JsString::from_utf16_units(vec![u16::from(b'a'), 0xd800]);
    assert!(ledger.load("agent").unwrap().by_key.contains_key(&key));
    std::fs::create_dir(base.join("_imports/blocked.jsonl")).unwrap();
    assert!(ledger.read_lines("blocked").is_err());
    assert!(ledger.load("blocked").is_err());
    assert!(ledger.append("blocked", &input).is_err());
    // A foreign unknown property must survive reading; it never becomes a known field.
    std::fs::write(
        base.join("_imports/foreign.jsonl"),
        r#"{"v":1,"idempotencyKey":"key","cardId":"id","opaque":"\ud800"}"#,
    )
    .unwrap();
    assert!(
        write_json(&ledger.read_lines("foreign").unwrap()[0].raw).contains(r#""opaque":"\ud800""#)
    );
}
