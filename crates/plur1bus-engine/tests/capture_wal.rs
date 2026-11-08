//! Durable capture admission: a failed WAL never authorizes a row write.
#![allow(clippy::unwrap_used, clippy::panic)] // Fixture dispatch and failed checkpoint assertions.
use plur1bus_engine::{
    capture::wal::{Admission, CaptureWal},
    contract::Cancel,
};
use std::{fs, sync::Arc};

const ROW: &str = "11111111-1111-1111-1111-111111111111";
fn root() -> tempfile::TempDir {
    tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
}
fn ticket(wal: &CaptureWal, key: &str) -> plur1bus_engine::capture::wal::CaptureTicket {
    match wal.begin("alpha", key, &Cancel::never()).unwrap() {
        Admission::Pending(t) => *t,
        Admission::Completed => panic!("expected a pending turn"),
    }
}

#[test]
fn plan_and_settlement_are_node_bytes_and_survive_reopen() {
    let dir = root();
    let wal = CaptureWal::new(dir.path().join("wal"), Arc::new(|| 1000)).unwrap();
    let t = ticket(&wal, "key");
    assert!(!dir.path().join("wal/alpha.json").exists());
    t.plan(&[ROW.to_owned()], &Cancel::never()).unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("wal/alpha.json")).unwrap(),
        format!(r#"{{"v":1,"entries":[{{"key":"key","at":1000,"pending":["{ROW}"]}}]}}"#)
    );
    drop(t);
    let reopened = CaptureWal::new(dir.path().join("wal"), Arc::new(|| 2000)).unwrap();
    let t = ticket(&reopened, "key");
    assert_eq!(t.pending_rows(), &[ROW.to_owned()]);
    t.settle(&Cancel::never()).unwrap();
    drop(t);
    assert!(matches!(
        reopened.begin("alpha", "key", &Cancel::never()).unwrap(),
        Admission::Completed
    ));
    assert_eq!(
        fs::read_to_string(dir.path().join("wal/alpha.json")).unwrap(),
        r#"{"v":1,"entries":[{"key":"key","at":2000}]}"#
    );
}

#[test]
fn corrupt_and_foreign_alias_state_fail_closed_without_replacement() {
    let dir = root();
    let wal = CaptureWal::new(dir.path().join("wal"), Arc::new(|| 1000)).unwrap();
    fs::create_dir(dir.path().join("wal")).unwrap();
    for raw in [
        "{",
        r#"{"v":1,"entries":[{"key":"x","at":1,"pending":"bad"}]}"#,
        r#"{"v":1,"entries":[{"key":"x","at":1},{"key":"x","at":2}]}"#,
    ] {
        fs::write(dir.path().join("wal/alpha.json"), raw).unwrap();
        assert!(wal.begin("alpha", "key", &Cancel::never()).is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join("wal/alpha.json")).unwrap(),
            raw
        );
    }
    fs::remove_file(dir.path().join("wal/alpha.json")).unwrap();
    let t = match wal.begin("Alpha", "key", &Cancel::never()).unwrap() {
        Admission::Pending(t) => t,
        Admission::Completed => panic!("pending"),
    };
    t.plan(&[ROW.to_owned()], &Cancel::never()).unwrap();
    drop(t);
    if dir.path().join("wal/alpha.json").exists() {
        assert!(wal.begin("alpha", "key", &Cancel::never()).is_err());
    }
}

#[test]
fn failed_plan_returns_an_error_and_cannot_be_settled_as_success() {
    let dir = root();
    let wal = CaptureWal::new(dir.path().join("wal"), Arc::new(|| 1000)).unwrap();
    let t = ticket(&wal, "key");
    fs::create_dir_all(dir.path().join("wal/alpha.json")).unwrap();
    assert!(t.plan(&[ROW.to_owned()], &Cancel::never()).is_err());
    assert!(t.settle(&Cancel::never()).is_err());
    assert!(dir.path().join("wal/alpha.json").is_dir());
}

#[test]
fn independent_tickets_merge_and_pending_rows_do_not_expire() {
    let dir = root();
    let wal = CaptureWal::new(dir.path().join("wal"), Arc::new(|| 1000)).unwrap();
    let a = ticket(&wal, "a");
    let b = ticket(&wal, "b");
    a.plan(&[ROW.to_owned()], &Cancel::never()).unwrap();
    b.plan(
        &["22222222-2222-2222-2222-222222222222".to_owned()],
        &Cancel::never(),
    )
    .unwrap();
    b.settle(&Cancel::never()).unwrap();
    drop(a);
    drop(b);
    let reopened = CaptureWal::new(dir.path().join("wal"), Arc::new(|| 1_000_000_000)).unwrap();
    assert_eq!(ticket(&reopened, "a").pending_rows(), &[ROW.to_owned()]);
    assert!(matches!(
        reopened.begin("alpha", "b", &Cancel::never()).unwrap(),
        Admission::Pending(_)
    ));
}

#[test]
fn identical_live_ticket_is_exclusive_and_wait_is_cancellable() {
    let dir = root();
    let wal = CaptureWal::new(dir.path().join("wal"), Arc::new(|| 1000)).unwrap();
    let _t = ticket(&wal, "key");
    let cancel =
        Cancel::with_deadline(std::time::Instant::now() + std::time::Duration::from_millis(30));
    assert!(wal.begin("alpha", "key", &cancel).is_err());
    // Another turn may prepare work concurrently; only state mutation takes the agent lock.
    let _other = ticket(&wal, "another");
}

#[test]
fn recorded_node_failure_cases_have_explicit_durable_refusals() {
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/wal-failures.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let root = root();
        let path = root.path().join("wal");
        fs::create_dir(&path).unwrap();
        let file = path.join("alpha.json");
        if case["directory"] == true {
            fs::create_dir(&file).unwrap();
        } else if case["full"] == true {
            let entries = (0..512)
                .map(
                    |i| serde_json::json!({"key":format!("pending-{i}"),"at":1000,"pending":[ROW]}),
                )
                .collect::<Vec<_>>();
            fs::write(
                &file,
                serde_json::json!({"v":1,"entries":entries}).to_string(),
            )
            .unwrap();
        } else {
            fs::write(&file, case["raw"].as_str().unwrap()).unwrap();
        }
        let before = fs::read(&file).ok();
        let now = case["now"].as_i64().unwrap_or(1000);
        let wal = CaptureWal::new(path, Arc::new(move || now)).unwrap();
        match case["name"].as_str().unwrap() {
            "expired-pending" => {
                assert_eq!(case["stale"], serde_json::json!([]));
                assert_eq!(ticket(&wal, "key").pending_rows(), &[ROW.to_owned()]);
            }
            "pending-capacity" => {
                assert_eq!(case["firstKey"], "pending-1");
                let t = ticket(&wal, "key");
                assert!(t.plan(&[ROW.to_owned()], &Cancel::never()).is_err());
            }
            _ => assert!(wal.begin("alpha", "key", &Cancel::never()).is_err()),
        }
        assert_eq!(fs::read(file).ok(), before);
    }
}

#[cfg(unix)]
#[test]
fn replaced_or_linked_kernel_lock_cannot_authorize_a_write() {
    let root = root();
    let wal = CaptureWal::new(root.path().join("wal"), Arc::new(|| 1000)).unwrap();
    let t = ticket(&wal, "key");
    let dir = fs::read_dir(root.path())
        .unwrap()
        .map(Result::unwrap)
        .find(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(".capture-leases-")
        })
        .unwrap()
        .path();
    let lock = fs::read_dir(&dir)
        .unwrap()
        .map(Result::unwrap)
        .find(|e| e.file_name().to_string_lossy().starts_with("turn-"))
        .unwrap()
        .path();
    fs::rename(&lock, dir.join("held-original")).unwrap();
    fs::write(&lock, b"").unwrap();
    assert!(t.plan(&[ROW.to_owned()], &Cancel::never()).is_err());
    assert!(!root.path().join("wal/alpha.json").exists());
    drop(t);
    fs::remove_file(&lock).unwrap();
    std::os::unix::fs::symlink(dir.join("held-original"), &lock).unwrap();
    assert!(wal.begin("alpha", "key", &Cancel::never()).is_err());
}

#[test]
fn durable_runtime_retains_the_lease_after_a_timeout_until_late_settlement() {
    use plur1bus_engine::capture::replay_guard::ReplayGuard;
    let root = root();
    let path = root.path().join("wal");
    let guard = ReplayGuard::durable(path.clone(), Arc::new(|| 1000)).unwrap();
    let mut late = None;
    guard
        .run("alpha", "late", &Cancel::never(), |rows| {
            rows.on_rows_planned(&[ROW.to_owned()])?;
            late = Some(rows);
            Ok(serde_json::from_value(
                serde_json::json!({"stored":0,"skipped":1,"reason":"timeout"}),
            )
            .unwrap())
        })
        .unwrap();
    let second = CaptureWal::new(path, Arc::new(|| 1000)).unwrap();
    let cancel =
        Cancel::with_deadline(std::time::Instant::now() + std::time::Duration::from_millis(30));
    assert!(second.begin("alpha", "late", &cancel).is_err());
    let rows = late.take().unwrap();
    rows.on_rows_settled().unwrap();
    drop(rows);
    assert!(matches!(
        second.begin("alpha", "late", &Cancel::never()).unwrap(),
        Admission::Completed
    ));
}

#[test]
fn valid_durable_runtime_states_match_existing_node_goldens_byte_for_byte() {
    use plur1bus_engine::capture::{replay_guard::ReplayGuard, result::result_json};
    use std::sync::atomic::{AtomicI64, Ordering};
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/replay-guard.json")).unwrap();
    for case in golden["scenarios"].as_array().unwrap().iter().filter(|c| {
        matches!(
            c["name"].as_str(),
            Some("done-replay" | "failed-retry" | "partial-rows-kept" | "ttl-inclusive")
        )
    }) {
        let root = root();
        let path = root.path().join("wal");
        let now = Arc::new(AtomicI64::new(1000));
        let time = now.clone();
        let clock: Arc<dyn Fn() -> i64 + Send + Sync> =
            Arc::new(move || time.load(Ordering::SeqCst));
        let mut guard = ReplayGuard::durable(path.clone(), clock.clone()).unwrap();
        for step in case["steps"].as_array().unwrap() {
            if step["kind"] == "reopen" {
                guard = ReplayGuard::durable(path.clone(), clock.clone()).unwrap();
                continue;
            }
            now.store(step["at"].as_i64().unwrap(), Ordering::SeqCst);
            let mut called = false;
            let result = guard
                .run(
                    case["agent"].as_str().unwrap(),
                    step["key"].as_str().unwrap(),
                    &Cancel::never(),
                    |rows| {
                        called = true;
                        for action in step["actions"].as_array().unwrap() {
                            match action["kind"].as_str().unwrap() {
                                "planned" => rows.on_rows_planned(
                                    &action["ids"]
                                        .as_array()
                                        .unwrap()
                                        .iter()
                                        .map(|s| s.as_str().unwrap().to_owned())
                                        .collect::<Vec<_>>(),
                                )?,
                                "kept" => rows.on_rows_kept()?,
                                "settled" => rows.on_rows_settled()?,
                                _ => panic!("unexpected fixture action"),
                            }
                        }
                        Ok(serde_json::from_value(step["result"].clone()).unwrap())
                    },
                )
                .unwrap();
            assert_eq!(called, step["called"].as_bool().unwrap());
            assert_eq!(
                result_json(&result).unwrap(),
                step["rawResult"].as_str().unwrap()
            );
            assert_eq!(
                fs::read_to_string(path.join("Agent.alpha%3A_-0.json")).ok(),
                step["raw"].as_str().map(str::to_owned)
            );
        }
    }
}

#[test]
fn wal_crash_child() {
    let Ok(path) = std::env::var("PLUR1BUS_RX_WAL_CRASH_ROOT") else {
        return;
    };
    let phase = std::env::var("PLUR1BUS_RX_WAL_CRASH_PHASE").unwrap();
    let root = std::path::PathBuf::from(path);
    let wal = CaptureWal::new(root.join("wal"), Arc::new(|| 1000)).unwrap();
    let t = ticket(&wal, "crash");
    if phase != "before-plan" {
        t.plan(&[ROW.to_owned()], &Cancel::never()).unwrap();
    }
    if phase == "after-settle" {
        t.settle(&Cancel::never()).unwrap();
    }
    fs::write(root.join("checkpoint"), phase).unwrap();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[test]
fn process_kill_releases_ownership_and_retains_only_acknowledged_state() {
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    for phase in ["before-plan", "after-plan", "after-settle"] {
        let root = root();
        let mut child = Child(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "wal_crash_child", "--nocapture"])
                .env("PLUR1BUS_RX_WAL_CRASH_ROOT", root.path())
                .env("PLUR1BUS_RX_WAL_CRASH_PHASE", phase)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !root.path().join("checkpoint").exists() {
            assert!(child.0.try_wait().unwrap().is_none());
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        child.0.kill().unwrap();
        let status = child.0.wait().unwrap();
        assert!(!status.success());
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(libc::SIGKILL));
        }
        let wal = CaptureWal::new(root.path().join("wal"), Arc::new(|| 1000)).unwrap();
        let cancel =
            Cancel::with_deadline(std::time::Instant::now() + std::time::Duration::from_secs(5));
        match wal.begin("alpha", "crash", &cancel).unwrap() {
            Admission::Completed => assert_eq!(phase, "after-settle"),
            Admission::Pending(t) => {
                assert_ne!(phase, "after-settle");
                assert_eq!(
                    t.pending_rows(),
                    if phase == "after-plan" {
                        vec![ROW.to_owned()]
                    } else {
                        vec![]
                    }
                );
            }
        }
    }
}
