//! Frozen A1 migration metadata, with actual first-copy evidence kept by the eventual I/O adapter.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use plur1bus_engine::{contract::Cancel, jobs::migration::plan, text::json::write_json};
use serde_json::Value;
#[test]
fn actual_node_rows_marks_and_repeat_statuses_match() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/job-migration.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let mut first_copy = None;
        for run in case["runs"].as_array().unwrap() {
            let result = plan(
                run["rawBefore"].as_str(),
                "alpha",
                golden["now"].as_f64().unwrap(),
                &Cancel::never(),
            )
            .unwrap();
            assert_eq!(
                result.status.as_str(),
                run["result"]["status"].as_str().unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(
                result.rows.len(),
                run["result"]["migrated"].as_u64().unwrap() as usize
            );
            assert_eq!(
                write_json(&plur1bus_engine::text::json::TolerantJsonValue::Array(
                    result.rows
                )),
                run["appendedJson"].as_str().unwrap()
            );
            assert_eq!(
                result.state.as_ref().map(write_json).as_deref(),
                run["newStateJson"].as_str()
            );
            if result.preserve_original && first_copy.is_none() {
                first_copy = run["rawBefore"].as_str();
            }
            assert_eq!(first_copy, run["backup"].as_str());
        }
    }
}
#[test]
fn ambiguous_unsupported_and_unbounded_metadata_refuse_before_intents() {
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(plan(Some("{}"), "alpha", 1., &cancel).is_err());
    for raw in [
        "{\"completed\":{},\"completed\":{}}",
        "{\"completed\":true}",
        "{\"plur1busLedgerMigratedAt\":[]}",
        "{\"completed\":{\"rem:alpha:x\":{\"completedAt\":\"11/08/2026\"}}}",
    ] {
        assert!(plan(Some(raw), "alpha", 1., &Cancel::never()).is_err());
    }
    assert!(plan(
        Some(&" ".repeat(2 * 1024 * 1024 + 1)),
        "alpha",
        1.,
        &Cancel::never()
    )
    .is_err());
    assert!(plan(Some("{}"), "alpha", f64::NAN, &Cancel::never()).is_err());
    assert!(plan(Some("{}"), "", 1., &Cancel::never()).is_err());
}
