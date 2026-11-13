//! Recovery may classify an orphan only while owning the agent registry's process-lifetime lease.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_engine::{
    contract::Cancel,
    jobs::ledger::JobLedger,
    text::json::{parse_json, write_json},
};
use std::{
    fs,
    time::{Duration, Instant},
};
fn root() -> tempfile::TempDir {
    tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
fn marker(id: &str) -> plur1bus_engine::text::json::TolerantJsonValue {
    parse_json(&format!(
        r#"{{"runId":"{id}","job":"rem-dream","phase":"rem","trigger":"cron","startedAt":100}}"#
    ))
    .unwrap()
}
#[test]
fn exclusive_session_recovers_once_and_never_reclassifies_live_markers() {
    let root = root();
    let ledger = JobLedger::open(root.path(), "alpha").unwrap();
    ledger
        .write_marker(&marker("old"), &Cancel::never())
        .unwrap();
    let mut session = JobLedger::open(root.path(), "alpha")
        .unwrap()
        .session(&Cancel::never())
        .unwrap();
    let blocked = JobLedger::open(root.path(), "alpha")
        .unwrap()
        .session(&Cancel::with_deadline(
            Instant::now() + Duration::from_millis(10),
        ));
    assert!(blocked.is_err());
    let report = session.recover(200.0, &Cancel::never()).unwrap();
    assert_eq!((report.appended, report.retired), (1, 1));
    let rows = ledger.snapshot(&Cancel::never()).unwrap().rows;
    assert_eq!(rows.len(), 1);
    assert!(write_json(&rows[0]).contains(r#""reason":"crash""#));
    assert!(write_json(&rows[0]).contains(r#""llmSession":true"#));
    ledger
        .write_marker(&marker("live"), &Cancel::never())
        .unwrap();
    let report = session.recover(300.0, &Cancel::never()).unwrap();
    assert_eq!((report.appended, report.retired), (0, 0));
    assert_eq!(ledger.orphan_markers(&Cancel::never()).unwrap().len(), 1);
    drop(session);
    let mut restarted = JobLedger::open(root.path(), "alpha")
        .unwrap()
        .session(&Cancel::never())
        .unwrap();
    assert_eq!(
        restarted.recover(400.0, &Cancel::never()).unwrap().appended,
        1
    );
    assert_eq!(ledger.snapshot(&Cancel::never()).unwrap().rows.len(), 2);
}

#[test]
fn existing_receipts_corrupt_markers_and_torn_bytes_remain_distinguishable() {
    let root = root();
    let ledger = JobLedger::open(root.path(), "alpha").unwrap();
    ledger
        .write_marker(&marker("existing"), &Cancel::never())
        .unwrap();
    fs::write(root.path().join("alpha/ledger.jsonl"), "{\"torn\":\n").unwrap();
    ledger
        .append(
            &parse_json(r#"{"runId":"existing","outcome":"completed"}"#).unwrap(),
            &Cancel::never(),
        )
        .unwrap();
    fs::write(root.path().join("alpha/running/corrupt.started"), b"{").unwrap();
    let mut session = JobLedger::open(root.path(), "alpha")
        .unwrap()
        .session(&Cancel::never())
        .unwrap();
    let report = session.recover(200.0, &Cancel::never()).unwrap();
    assert_eq!((report.appended, report.retired), (1, 2));
    let snapshot = ledger.snapshot(&Cancel::never()).unwrap();
    assert_eq!(snapshot.unreadable, 1);
    assert_eq!(snapshot.rows.len(), 2);
    let diagnostic = write_json(&snapshot.rows[1]);
    assert!(diagnostic.contains(r#""job":"unknown""#));
    assert!(diagnostic.contains(r#""trigger":"unknown""#));
    assert!(fs::read_to_string(root.path().join("alpha/ledger.jsonl"))
        .unwrap()
        .starts_with("{\"torn\":\n"));
    assert!(ledger.orphan_markers(&Cancel::never()).unwrap().is_empty());
}
#[cfg(feature = "testkit")]
#[test]
fn changed_row_or_marker_prevents_retirement_and_leaves_recovery_retryable() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    for target in ["row", "marker", "replacement"] {
        let root = root();
        let ledger = JobLedger::open(root.path(), "alpha").unwrap();
        ledger
            .write_marker(&marker("old"), &Cancel::never())
            .unwrap();
        let path = root.path().to_owned();
        let changed = AtomicBool::new(false);
        let observer = Arc::new(move |point: &str| {
            if point == "recovery-row-committed" && !changed.swap(true, Ordering::SeqCst) {
                if target == "row" {
                    fs::write(path.join("alpha/ledger.jsonl"), b"corrupt evidence\n").unwrap();
                } else if target == "replacement" {
                    let ledger = path.join("alpha/ledger.jsonl");
                    let bytes = fs::read(&ledger).unwrap();
                    fs::rename(&ledger, path.join("original-ledger")).unwrap();
                    fs::write(&ledger, bytes).unwrap();
                } else {
                    fs::write(
                        path.join("alpha/running/old.started"),
                        write_json(&marker("old")) + " ",
                    )
                    .unwrap();
                }
            }
        });
        let mut session = JobLedger::open(root.path(), "alpha")
            .unwrap()
            .session(&Cancel::never())
            .unwrap()
            .with_observer(observer);
        assert!(session.recover(200.0, &Cancel::never()).is_err());
        assert_eq!(ledger.orphan_markers(&Cancel::never()).unwrap().len(), 1);
        let report = session.recover(300.0, &Cancel::never()).unwrap();
        assert_eq!(report.retired, 1);
        let snapshot = ledger.snapshot(&Cancel::never()).unwrap();
        assert_eq!(snapshot.rows.len(), 1);
        assert_eq!(snapshot.unreadable, usize::from(target == "row"));
    }
}
#[cfg(unix)]
#[test]
fn session_refuses_replaced_directory_or_lifecycle_lock() {
    for target in ["directory", "lock"] {
        let root = root();
        let ledger = JobLedger::open(root.path(), "alpha").unwrap();
        ledger
            .write_marker(&marker("old"), &Cancel::never())
            .unwrap();
        let mut session = JobLedger::open(root.path(), "alpha")
            .unwrap()
            .session(&Cancel::never())
            .unwrap();
        if target == "directory" {
            fs::rename(root.path().join("alpha"), root.path().join("original")).unwrap();
            fs::create_dir(root.path().join("alpha")).unwrap();
        } else {
            let path = root.path().join("alpha/job-registry-session.lock");
            fs::rename(&path, root.path().join("old-lock")).unwrap();
            fs::write(&path, []).unwrap();
        }
        assert!(session.recover(200.0, &Cancel::never()).is_err());
        assert!(!root.path().join("alpha/ledger.jsonl").exists());
        if target == "directory" {
            assert!(root.path().join("original/running/old.started").exists());
        } else {
            assert!(root.path().join("alpha/running/old.started").exists());
        }
    }
}
#[cfg(feature = "testkit")]
#[test]
fn jobs_recovery_child() {
    use std::{path::Path, sync::Arc};
    let Ok(path) = std::env::var("PLUR1BUS_JOB_RECOVERY_TEST_ROOT") else {
        return;
    };
    let point = std::env::var("PLUR1BUS_JOB_RECOVERY_TEST_POINT").unwrap();
    let ready = Path::new(&path).join("ready");
    let observer = Arc::new(move |phase: &str| {
        if phase == point {
            fs::write(&ready, b"ready").unwrap();
            loop {
                std::thread::park();
            }
        }
    });
    let mut session = JobLedger::open(Path::new(&path), "alpha")
        .unwrap()
        .session(&Cancel::never())
        .unwrap()
        .with_observer(observer);
    session.recover(200.0, &Cancel::never()).unwrap();
    assert!(
        Path::new(&path).join("ready").exists(),
        "expected recovery observer was never reached"
    );
}
#[cfg(unix)]
#[cfg(feature = "testkit")]
#[test]
fn sigkill_releases_lifetime_lease_and_recovers_each_run_exactly_once() {
    use std::{
        os::unix::process::ExitStatusExt,
        process::{Command, Stdio},
    };
    for phase in [
        "recovery-before-row",
        "recovery-row-committed",
        "recovery-marker-removed",
    ] {
        let root = root();
        let ledger = JobLedger::open(root.path(), "alpha").unwrap();
        ledger
            .write_marker(&marker("old"), &Cancel::never())
            .unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                std::any::type_name_of_val(&jobs_recovery_child)
                    .split_once("::")
                    .map_or("", |(_, name)| name),
            ])
            .env("PLUR1BUS_JOB_RECOVERY_TEST_ROOT", root.path())
            .env("PLUR1BUS_JOB_RECOVERY_TEST_POINT", phase)
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
        let mut session = JobLedger::open(root.path(), "alpha")
            .unwrap()
            .session(&Cancel::with_deadline(
                Instant::now() + Duration::from_secs(1),
            ))
            .unwrap();
        let report = session.recover(300.0, &Cancel::never()).unwrap();
        assert_eq!(report.appended, usize::from(phase == "recovery-before-row"));
        assert_eq!(ledger.snapshot(&Cancel::never()).unwrap().rows.len(), 1);
        assert!(ledger.orphan_markers(&Cancel::never()).unwrap().is_empty());
        assert_eq!(
            session.recover(400.0, &Cancel::never()).unwrap().appended,
            0
        );
    }
}

#[cfg(feature = "testkit")]
#[test]
fn cancellation_after_durable_row_keeps_marker_until_a_successful_retry() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let root = root();
    let ledger = JobLedger::open(root.path(), "alpha").unwrap();
    ledger
        .write_marker(&marker("old"), &Cancel::never())
        .unwrap();
    let cancel = Cancel::never();
    let cancelled = cancel.clone();
    let once = AtomicBool::new(false);
    let observer = Arc::new(move |point: &str| {
        if point == "recovery-row-committed" && !once.swap(true, Ordering::SeqCst) {
            cancelled.cancel();
        }
    });
    let mut session = JobLedger::open(root.path(), "alpha")
        .unwrap()
        .session(&Cancel::never())
        .unwrap()
        .with_observer(observer);
    assert!(session.recover(200.0, &cancel).is_err());
    assert_eq!(ledger.snapshot(&Cancel::never()).unwrap().rows.len(), 1);
    assert_eq!(ledger.orphan_markers(&Cancel::never()).unwrap().len(), 1);
    let report = session.recover(300.0, &Cancel::never()).unwrap();
    assert_eq!((report.appended, report.retired), (0, 1));
    assert_eq!(ledger.snapshot(&Cancel::never()).unwrap().rows.len(), 1);
}
