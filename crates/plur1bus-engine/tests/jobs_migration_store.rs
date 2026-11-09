//! Real session-bound legacy migration, preserving rollback bytes and stable import IDs.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use plur1bus_engine::{
    contract::Cancel,
    jobs::ledger::{JobLedger, JobSession},
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
use serde_json::Value;
use std::{fs, path::Path};
fn session(root: &Path) -> JobSession {
    let mut session = JobLedger::open(root, "alpha")
        .unwrap()
        .session(&Cancel::never())
        .unwrap();
    session.recover(1794225600123., &Cancel::never()).unwrap();
    session
}
fn versioned(row: Json) -> Json {
    let Json::Object(mut fields) = row else {
        panic!("row")
    };
    fields.insert(0, ("v".into(), Json::Number("1".into())));
    Json::Object(fields)
}
#[test]
fn twenty_seven_node_file_sequences_preserve_first_copy_and_import_once() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/job-migration.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let scratch = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(scratch.path()).unwrap();
        let jobs = root.join("jobs");
        let state = root.join("state");
        fs::create_dir(&jobs).unwrap();
        fs::create_dir(&state).unwrap();
        let mut active = session(&jobs);
        let mut expected = Vec::new();
        for (index, run) in case["runs"].as_array().unwrap().iter().enumerate() {
            if index == 0 || case["name"] == "corrupt-then-repaired" {
                if let Some(raw) = run["rawBefore"].as_str() {
                    fs::write(state.join("run-state.json"), raw).unwrap();
                }
            }
            let result = active
                .migrate_legacy(&state, golden["now"].as_f64().unwrap(), &Cancel::never())
                .unwrap();
            assert_eq!(
                result.status.as_str(),
                run["result"]["status"].as_str().unwrap(),
                "{} / {index}",
                case["name"]
            );
            assert_eq!(
                result.migrated,
                run["result"]["migrated"].as_u64().unwrap() as usize
            );
            let Json::Array(rows) = parse_json(run["appendedJson"].as_str().unwrap()).unwrap()
            else {
                panic!("rows")
            };
            expected.extend(rows.into_iter().map(versioned));
            let actual = JobLedger::open(&jobs, "alpha")
                .unwrap()
                .snapshot(&Cancel::never())
                .unwrap();
            assert_eq!(actual.unreadable, 0);
            assert_eq!(actual.rows, expected);
            assert_eq!(
                fs::read_to_string(state.join("run-state.json.migrated"))
                    .ok()
                    .as_deref(),
                run["backup"].as_str()
            );
            assert_eq!(
                fs::read_to_string(state.join("run-state.json"))
                    .ok()
                    .as_deref(),
                run["newStateJson"].as_str().or(run["rawBefore"].as_str())
            );
        }
    }
}
#[test]
fn unrecovered_session_and_precancel_refuse_before_state_writes() {
    let scratch = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(scratch.path()).unwrap();
    let jobs = root.join("jobs");
    let state = root.join("state");
    fs::create_dir(&jobs).unwrap();
    fs::create_dir(&state).unwrap();
    fs::write(state.join("run-state.json"), "{}").unwrap();
    let mut active = JobLedger::open(&jobs, "alpha")
        .unwrap()
        .session(&Cancel::never())
        .unwrap();
    assert!(active.migrate_legacy(&state, 1., &Cancel::never()).is_err());
    active.recover(1., &Cancel::never()).unwrap();
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(active.migrate_legacy(&state, 1., &cancel).is_err());
    assert_eq!(fs::read_dir(&state).unwrap().count(), 1);
    assert_eq!(
        fs::read_to_string(state.join("run-state.json")).unwrap(),
        "{}"
    );
}
#[test]
fn duplicate_existing_import_is_verified_instead_of_appended_again() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/job-migration.json")).unwrap();
    let run = &golden["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "single")
        .unwrap()["runs"][0];
    let Json::Array(rows) = parse_json(run["appendedJson"].as_str().unwrap()).unwrap() else {
        panic!("rows")
    };
    for collision in [false, true] {
        let scratch = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(scratch.path()).unwrap();
        let jobs = root.join("jobs");
        let state = root.join("state");
        fs::create_dir(&jobs).unwrap();
        fs::create_dir(&state).unwrap();
        fs::write(
            state.join("run-state.json"),
            run["rawBefore"].as_str().unwrap(),
        )
        .unwrap();
        let ledger = JobLedger::open(&jobs, "alpha").unwrap();
        let mut row = rows[0].clone();
        if collision {
            let Json::Object(fields) = &mut row else {
                panic!("object")
            };
            fields.push(("foreign".into(), Json::Bool(true)));
        }
        ledger.append(&row, &Cancel::never()).unwrap();
        let before = fs::read(jobs.join("alpha/ledger.jsonl")).unwrap();
        let mut active = session(&jobs);
        let result =
            active.migrate_legacy(&state, golden["now"].as_f64().unwrap(), &Cancel::never());
        if collision {
            assert!(result.is_err());
            assert_eq!(
                fs::read_to_string(state.join("run-state.json")).unwrap(),
                run["rawBefore"].as_str().unwrap()
            );
        } else {
            result.unwrap();
        }
        assert_eq!(fs::read(jobs.join("alpha/ledger.jsonl")).unwrap(), before);
        assert_eq!(
            write_json(&ledger.snapshot(&Cancel::never()).unwrap().rows[0]),
            write_json(&versioned(row))
        );
    }
}

#[cfg(feature = "testkit")]
#[path = "support/jobs_migration_recovery.rs"]
mod recovery;

#[test]
fn unsupported_bytes_oversized_files_and_live_markers_leave_state_unchanged() {
    for mode in ["utf8", "oversized", "live-marker", "corrupt-receipt"] {
        let scratch = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(scratch.path()).unwrap();
        let jobs = root.join("jobs");
        let state = root.join("state");
        fs::create_dir(&jobs).unwrap();
        fs::create_dir(&state).unwrap();
        let bytes = match mode {
            "utf8" => vec![0xff],
            "oversized" => vec![b' '; 2 * 1024 * 1024 + 1],
            _ => b"{}".to_vec(),
        };
        fs::write(state.join("run-state.json"), &bytes).unwrap();
        let mut active = session(&jobs);
        if mode == "live-marker" {
            JobLedger::open(&jobs, "alpha").unwrap().write_marker(&parse_json(r#"{"runId":"live","job":"rem-dream","phase":"rem","trigger":"cron","startedAt":100}"#).unwrap(), &Cancel::never()).unwrap();
        }
        if mode == "corrupt-receipt" {
            fs::write(state.join("native-job-migration-alpha.json"), b"{bad").unwrap();
        }
        assert!(
            active
                .migrate_legacy(&state, 1000., &Cancel::never())
                .is_err(),
            "{mode}"
        );
        assert_eq!(fs::read(state.join("run-state.json")).unwrap(), bytes);
        assert!(!state.join("run-state.json.migrated").exists());
        assert!(!jobs.join("alpha/ledger.jsonl").exists());
    }
}
#[cfg(unix)]
#[test]
fn linked_source_backup_and_receipt_are_never_followed_or_replaced() {
    use std::os::unix::fs::symlink;
    for name in [
        "run-state.json",
        "run-state.json.migrated",
        "native-job-migration-alpha.json",
    ] {
        for hard in [false, true] {
            let scratch = tempfile::tempdir().unwrap();
            let root = fs::canonicalize(scratch.path()).unwrap();
            let jobs = root.join("jobs");
            let state = root.join("state");
            fs::create_dir(&jobs).unwrap();
            fs::create_dir(&state).unwrap();
            fs::write(root.join("outside"), b"{}").unwrap();
            if name != "run-state.json" {
                fs::write(state.join("run-state.json"), b"{}").unwrap();
            }
            if hard {
                fs::hard_link(root.join("outside"), state.join(name)).unwrap();
            } else {
                symlink(root.join("outside"), state.join(name)).unwrap();
            }
            let mut active = session(&jobs);
            assert!(
                active
                    .migrate_legacy(&state, 1000., &Cancel::never())
                    .is_err(),
                "{name} hard={hard}"
            );
            assert_eq!(fs::read(root.join("outside")).unwrap(), b"{}");
            assert!(!jobs.join("alpha/ledger.jsonl").exists());
        }
    }
}
