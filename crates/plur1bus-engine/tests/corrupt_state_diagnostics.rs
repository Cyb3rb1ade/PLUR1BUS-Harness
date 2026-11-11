//! RX9/T9a: a damaged state file or registry must never leak its content through an error, a log line or a wire reply.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::contract::{Cancel, EngineError, StoreError};
use plur1bus_engine::ops::workspace_policy::{PolicyError, PolicyStore};
use plur1bus_engine::store::recall_stats::RecallStats;
use plur1bus_engine::store::state_file::StateFile;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;

/// A conspicuous marker that must never be copied out of a damaged file.
const MARKER: &str = "CORRUPT-FILE-MARKER-5c1e9a7d-DO-NOT-ECHO";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    revision: u32,
}

/// Every textual form an operator or a client could receive for this error.
fn surfaces(error: &dyn std::fmt::Debug, display: &dyn std::fmt::Display) -> String {
    format!("{error:?}\n{error:#?}\n{display}")
}

fn assert_clean(case: &str, text: &str) {
    assert!(
        !text.contains(MARKER),
        "{case}: marker leaked into {text:?}"
    );
    // The marker must not survive in pieces either (truncation, quoting or lossy decoding).
    assert!(
        !text.contains("5c1e9a7d"),
        "{case}: marker fragment in {text:?}"
    );
}

#[test]
fn corrupt_warnings_carry_no_file_content() {
    let root = support::canonical_tempdir();

    // 1. The shared state-file reader: broken JSON, well-formed JSON of the wrong shape (the marker as a value, as a
    //    key and as an unknown field) and bytes that are not UTF-8.
    let state = root.path().join("record.json");
    let mut non_utf8 = MARKER.as_bytes().to_vec();
    non_utf8.extend_from_slice(&[0xff, 0xfe, 0xfd]);
    for (case, bytes) in [
        (
            "broken json",
            format!("{{\"revision\": \"{MARKER}").into_bytes(),
        ),
        (
            "marker as value",
            format!("{{\"revision\":\"{MARKER}\"}}").into_bytes(),
        ),
        ("marker as key", format!("{{\"{MARKER}\":1}}").into_bytes()),
        (
            "unknown field",
            format!("{{\"revision\":1,\"{MARKER}\":true}}").into_bytes(),
        ),
        ("marker as array", format!("[\"{MARKER}\"]").into_bytes()),
        ("not utf-8", non_utf8),
    ] {
        fs::write(&state, bytes).unwrap();
        let error = StateFile::<Record>::load(&state).unwrap_err();
        assert_eq!(error, StoreError::Corrupt, "{case}");
        assert_clean(case, &surfaces(&error, &error));
        // The same error as it leaves the engine core.
        let engine = EngineError::from(error);
        assert_clean(case, &surfaces(&engine, &engine));
    }

    // 2. The workspace-policy registry: the operator-facing reply is the fixed machine code only.
    let policy_root = support::canonical_tempdir();
    let policy_file = policy_root.path().join("control/workspace-policy.json");
    fs::create_dir(policy_file.parent().unwrap()).unwrap();
    let query = json!({"agentId":"alpha","workspaceIdentity":"/synthetic/workspace"});
    for (case, raw) in [
        ("policy broken json", format!("{{\"policies\": \"{MARKER}")),
        (
            "policy wrong schema",
            json!({"schemaVersion":1,"revision":0,"policies":{MARKER:{"enabled":MARKER}}})
                .to_string(),
        ),
        (
            "policy wrong version",
            json!({"schemaVersion":MARKER,"revision":0,"policies":{}}).to_string(),
        ),
    ] {
        fs::write(&policy_file, raw).unwrap();
        let store = PolicyStore::new(policy_root.path()).unwrap();
        for result in [store.get(&query), store.list()] {
            let error = result.unwrap_err();
            assert_eq!(error.code(), "workspace_policy_state_invalid", "{case}");
            let wire = json!({"error": error.code()}).to_string();
            assert_clean(case, &wire);
            assert_clean(case, &surfaces(&error, &error));
            assert!(matches!(error, PolicyError::InvalidState), "{case}");
        }
    }

    // 3. The recall-stats SQLite sidecar: a file that is no database, and a database with a damaged header.
    let stats_root = support::canonical_tempdir();
    let stats = RecallStats::new(stats_root.path()).unwrap();
    stats.read("alpha", Some(&[]), &Cancel::never()).unwrap();
    let path = stats.path("alpha").unwrap();
    let healthy = fs::read(&path).unwrap();
    let mut damaged_header = healthy.clone();
    damaged_header[..MARKER.len().min(16)]
        .copy_from_slice(&MARKER.as_bytes()[..MARKER.len().min(16)]);
    for (case, bytes) in [
        (
            "sqlite: marker text",
            format!("{MARKER}\n").repeat(64).into_bytes(),
        ),
        ("sqlite: damaged header", damaged_header),
    ] {
        fs::write(&path, bytes).unwrap();
        let stats = RecallStats::new(stats_root.path()).unwrap();
        for error in [
            stats.read("alpha", None, &Cancel::never()).unwrap_err(),
            stats
                .record(
                    "alpha",
                    &["00000000-0000-4000-8000-000000000001".into()],
                    "synthetic query",
                    1.0,
                    &Cancel::never(),
                )
                .unwrap_err(),
        ] {
            // These methods already return the engine-level error.
            let engine: EngineError = error;
            assert_clean(case, &surfaces(&engine, &engine));
        }
    }

    // The error types themselves carry no payload that could hold file text.
    let unit: Value = json!(format!("{:?}", StoreError::Corrupt));
    assert_eq!(unit, "Corrupt");
}
