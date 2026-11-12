//! Actual Node ledger observations and durable native file boundaries.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_engine::{
    contract::Cancel,
    jobs::ledger::JobLedger,
    text::json::{parse_json, write_json},
};
use serde_json::{json, Value};
use std::{fs, path::Path};
fn root() -> tempfile::TempDir {
    tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
fn state(ledger: &JobLedger, root: &Path) -> Value {
    let snapshot = ledger.snapshot(&Cancel::never()).unwrap();
    let mut markers = ledger.orphan_markers(&Cancel::never()).unwrap();
    markers.sort_by_key(write_json);
    json!({"rowsJson": snapshot.rows.iter().map(write_json).collect::<Vec<_>>(),
        "unreadable": snapshot.unreadable,
        "markersJson": markers.iter().map(write_json).collect::<Vec<_>>(),
        "raw": fs::read_to_string(root.join("alpha/ledger.jsonl")).ok()})
}
#[test]
fn file_transitions_match_sixteen_actual_node_scenarios() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/job-ledger.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let root = root();
        let ledger = JobLedger::open(root.path(), "alpha").unwrap();
        let scenario = &case["scenario"];
        let dir = root.path().join("alpha");
        if let Some(initial) = scenario["initial"].as_str() {
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("ledger.jsonl"), initial).unwrap();
        }
        if let Some(markers) = scenario["markers"].as_object() {
            fs::create_dir_all(dir.join("running")).unwrap();
            for (name, raw) in markers {
                fs::write(dir.join("running").join(name), raw.as_str().unwrap()).unwrap();
            }
        }
        assert_eq!(
            state(&ledger, root.path()),
            case["before"],
            "{} before",
            scenario["name"]
        );
        for (action, step) in scenario["actions"]
            .as_array()
            .unwrap()
            .iter()
            .zip(case["steps"].as_array().unwrap())
        {
            let result = if let Some(raw) = action["append"].as_str() {
                ledger.append(&parse_json(raw).unwrap(), &Cancel::never())
            } else if action.get("marker").is_some() {
                ledger.write_marker(
                    &parse_json(&action["marker"].to_string()).unwrap(),
                    &Cancel::never(),
                )
            } else if let Some(id) = action["remove"].as_str() {
                ledger.remove_marker(id, &Cancel::never())
            } else {
                fs::write(dir.join("ledger.jsonl"), action["raw"].as_str().unwrap()).unwrap();
                Ok(())
            };
            assert_eq!(
                result.is_err(),
                step["error"],
                "{} {action}",
                scenario["name"]
            );
            assert_eq!(
                state(&ledger, root.path()),
                step["state"],
                "{} {action}",
                scenario["name"]
            );
        }
    }
}

fn marker() -> plur1bus_engine::text::json::TolerantJsonValue {
    parse_json(r#"{"runId":"run-001","job":"knowledge-update","phase":null,"trigger":"manual","startedAt":42}"#).unwrap()
}
fn row() -> plur1bus_engine::text::json::TolerantJsonValue {
    parse_json(r#"{"runId":"run-001","job":"knowledge-update","outcome":"completed"}"#).unwrap()
}
#[test]
fn absent_reads_and_cancelled_writes_leave_the_root_empty() {
    let root = root();
    for bad in ["", ".", "..", "../alpha", "a/b", "a\\b", "a b", "ä"] {
        assert!(JobLedger::open(root.path(), bad).is_err());
    }
    let ledger = JobLedger::open(root.path(), "alpha").unwrap();
    assert!(ledger.snapshot(&Cancel::never()).unwrap().rows.is_empty());
    assert!(ledger.orphan_markers(&Cancel::never()).unwrap().is_empty());
    ledger.remove_marker("absent", &Cancel::never()).unwrap();
    let cancelled = Cancel::never();
    cancelled.cancel();
    assert!(ledger.append(&row(), &cancelled).is_err());
    assert!(ledger.write_marker(&marker(), &cancelled).is_err());
    assert!(ledger.remove_marker("run-001", &cancelled).is_err());
    assert!(ledger
        .write_marker(
            &parse_json(r#"{"runId":"../escape"}"#).unwrap(),
            &Cancel::never()
        )
        .is_err());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}
#[test]
fn concurrent_writers_preserve_every_row_and_reopen_keeps_agent_isolation() {
    let root = root();
    let handles: Vec<_> = (0..4)
        .map(|worker| {
            let path = root.path().to_owned();
            std::thread::spawn(move || {
                let ledger = JobLedger::open(&path, "alpha").unwrap();
                for i in 0..10 {
                    ledger
                        .append(
                            &parse_json(&json!({"worker": worker, "i":i}).to_string()).unwrap(),
                            &Cancel::never(),
                        )
                        .unwrap();
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    let ledger = JobLedger::open(root.path(), "alpha").unwrap();
    let snapshot = ledger.snapshot(&Cancel::never()).unwrap();
    assert_eq!(snapshot.rows.len(), 40);
    assert_eq!(snapshot.unreadable, 0);
    let unique: std::collections::BTreeSet<_> = snapshot.rows.iter().map(write_json).collect();
    assert_eq!(unique.len(), 40);
    assert!(JobLedger::open(root.path(), "beta")
        .unwrap()
        .snapshot(&Cancel::never())
        .unwrap()
        .rows
        .is_empty());
    assert!(!root.path().join("beta").exists());
}
#[test]
fn bounded_reads_and_writes_refuse_without_discarding_evidence() {
    let root = root();
    let ledger = JobLedger::open(root.path(), "alpha").unwrap();
    ledger.append(&row(), &Cancel::never()).unwrap();
    let path = root.path().join("alpha/ledger.jsonl");
    let before = fs::read(&path).unwrap();
    let huge = parse_json(&json!({"text":"x".repeat(1024*1024)}).to_string()).unwrap();
    assert!(ledger.append(&huge, &Cancel::never()).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.set_len(64 * 1024 * 1024 + 1).unwrap();
    assert!(ledger.snapshot(&Cancel::never()).is_err());
    assert!(ledger.append(&row(), &Cancel::never()).is_err());
    assert_eq!(fs::metadata(&path).unwrap().len(), 64 * 1024 * 1024 + 1);
    file.set_len(0).unwrap();
    fs::write(&path, "\n".repeat(50_001)).unwrap();
    assert!(ledger.snapshot(&Cancel::never()).is_err());
    assert!(ledger.append(&row(), &Cancel::never()).is_err());
}
#[cfg(unix)]
#[test]
fn links_and_rebound_roots_cannot_redirect_ledger_or_marker_mutation() {
    use std::os::unix::fs::symlink;
    for kind in ["symlink", "hardlink"] {
        let root = root();
        let ledger = JobLedger::open(root.path(), "alpha").unwrap();
        fs::create_dir(root.path().join("alpha")).unwrap();
        let outside = root.path().join("external");
        fs::write(&outside, b"external evidence\n").unwrap();
        let path = root.path().join("alpha/ledger.jsonl");
        if kind == "symlink" {
            symlink(&outside, &path).unwrap();
        } else {
            fs::hard_link(&outside, &path).unwrap();
        }
        assert!(ledger.snapshot(&Cancel::never()).is_err());
        assert!(ledger.append(&row(), &Cancel::never()).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"external evidence\n");
        fs::remove_file(&path).unwrap();
        fs::create_dir(root.path().join("alpha/running")).unwrap();
        let path = root.path().join("alpha/running/run-001.started");
        if kind == "symlink" {
            symlink(&outside, &path).unwrap();
        } else {
            fs::hard_link(&outside, &path).unwrap();
        }
        assert!(ledger.orphan_markers(&Cancel::never()).is_err());
        assert!(ledger.remove_marker("run-001", &Cancel::never()).is_err());
        assert!(ledger.write_marker(&marker(), &Cancel::never()).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"external evidence\n");
    }
    let root = root();
    fs::create_dir(root.path().join("jobs")).unwrap();
    let ledger = JobLedger::open(&root.path().join("jobs"), "alpha").unwrap();
    fs::rename(root.path().join("jobs"), root.path().join("old")).unwrap();
    fs::create_dir(root.path().join("jobs")).unwrap();
    assert!(ledger.snapshot(&Cancel::never()).is_err());
    assert!(ledger.append(&row(), &Cancel::never()).is_err());
    assert_eq!(fs::read_dir(root.path().join("jobs")).unwrap().count(), 0);
    assert_eq!(fs::read_dir(root.path().join("old")).unwrap().count(), 0);
}
#[test]
fn jobs_ledger_child() {
    let Ok(path) = std::env::var("PLUR1BUS_JOB_LEDGER_TEST_ROOT") else {
        return;
    };
    let phase = std::env::var("PLUR1BUS_JOB_LEDGER_TEST_PHASE").unwrap();
    let ledger = JobLedger::open(Path::new(&path), "alpha").unwrap();
    ledger.write_marker(&marker(), &Cancel::never()).unwrap();
    if phase != "marker" {
        ledger.append(&row(), &Cancel::never()).unwrap();
    }
    if phase == "removed" {
        ledger.remove_marker("run-001", &Cancel::never()).unwrap();
    }
    fs::write(Path::new(&path).join("ready"), b"ready").unwrap();
    loop {
        std::thread::park();
    }
}
#[cfg(unix)]
#[test]
fn sigkill_preserves_markers_and_rows_at_all_three_durable_boundaries() {
    use std::{
        os::unix::process::ExitStatusExt,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    for phase in ["marker", "row", "removed"] {
        let root = root();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                std::any::type_name_of_val(&jobs_ledger_child)
                    .split_once("::")
                    .map_or("", |(_, name)| name),
            ])
            .env("PLUR1BUS_JOB_LEDGER_TEST_ROOT", root.path())
            .env("PLUR1BUS_JOB_LEDGER_TEST_PHASE", phase)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !root.path().join("ready").exists() && Instant::now() < deadline {
            assert!(child.try_wait().unwrap().is_none());
            std::thread::sleep(Duration::from_millis(5));
        }
        let ready = root.path().join("ready").exists();
        child.kill().unwrap();
        assert_eq!(child.wait().unwrap().signal(), Some(9));
        assert!(ready);
        let ledger = JobLedger::open(root.path(), "alpha").unwrap();
        assert_eq!(
            ledger.snapshot(&Cancel::never()).unwrap().rows.len(),
            usize::from(phase != "marker")
        );
        assert_eq!(
            ledger.orphan_markers(&Cancel::never()).unwrap().len(),
            usize::from(phase != "removed")
        );
        ledger
            .append(
                &parse_json(r#"{"runId":"next","outcome":"completed"}"#).unwrap(),
                &Cancel::never(),
            )
            .unwrap();
        ledger.remove_marker("run-001", &Cancel::never()).unwrap();
        assert!(ledger.orphan_markers(&Cancel::never()).unwrap().is_empty());
    }
}
