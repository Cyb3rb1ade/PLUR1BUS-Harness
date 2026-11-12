//! Actual bounded atomic run-state persistence under cooperating native writer leases.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_engine::{
    contract::Cancel,
    jobs::rate_limit::{Key, RateLimitStore},
    text::json::write_json,
};
use std::{fs, sync::Arc};
fn root() -> tempfile::TempDir {
    tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
fn key() -> Key {
    Key::new("gc-run", Some("agent"), Some("workspace")).unwrap()
}
fn open(root: &std::path::Path) -> RateLimitStore {
    RateLimitStore::open(root, Arc::new(|| 10000.0)).unwrap()
}
#[test]
fn actual_files_match_all_twenty_three_node_transition_sequences() {
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/job-rate-limit.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let root = root();
        let file = root.path().join("run-state.json");
        if let Some(raw) = case["initialJson"].as_str() {
            fs::write(&file, raw).unwrap();
        }
        let store = open(root.path());
        let key = Key::new("gc-run", case["agent"].as_str(), case["workspace"].as_str()).unwrap();
        for (index, snapshot) in case["snapshots"].as_array().unwrap().iter().enumerate() {
            if index != 0 {
                store.record(&key, &Cancel::never()).unwrap();
            }
            assert_eq!(
                write_json(&store.check(&key, 1000.0, &Cancel::never()).unwrap()),
                snapshot["checkJson"].as_str().unwrap()
            );
            assert_eq!(
                fs::read_to_string(&file).ok().as_deref(),
                snapshot["file"].as_str(),
                "{}",
                case["name"]
            );
        }
        assert!(fs::read_dir(root.path()).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".native-run-state-")));
    }
}
#[test]
fn absent_reads_cancel_and_corrupt_state_never_erase_evidence() {
    let root = root();
    let store = open(root.path());
    store.check(&key(), 1000.0, &Cancel::never()).unwrap();
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    let cancelled = Cancel::never();
    cancelled.cancel();
    assert!(store.record(&key(), &cancelled).is_err());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    for raw in [
        "{",
        "[]",
        r#"{"jobRateLimits":[]}"#,
        r#"{"jobRateLimits":{},"jobRateLimits":{}}"#,
    ] {
        fs::write(root.path().join("run-state.json"), raw).unwrap();
        assert!(store.check(&key(), 1000.0, &Cancel::never()).is_err());
        assert!(store.record(&key(), &Cancel::never()).is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("run-state.json")).unwrap(),
            raw
        );
    }
    let file = fs::File::create(root.path().join("run-state.json")).unwrap();
    file.set_len(2 * 1024 * 1024 + 1).unwrap();
    assert!(store.record(&key(), &Cancel::never()).is_err());
    assert_eq!(file.metadata().unwrap().len(), 2 * 1024 * 1024 + 1);
}
#[test]
fn four_writers_preserve_every_successful_increment_and_unrelated_state() {
    let root = root();
    fs::write(
        root.path().join("run-state.json"),
        r#"{"human":{"text":"keep \\ud800"}}"#,
    )
    .unwrap();
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let store = open(root.path());
            std::thread::spawn(move || {
                for _ in 0..10 {
                    store.record(&key(), &Cancel::never()).unwrap();
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    let state: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("run-state.json")).unwrap()).unwrap();
    assert_eq!(
        state["jobRateLimits"]["gc-run:agent:workspace"]["runCount"],
        40
    );
    assert_eq!(state["human"]["text"], "keep \\ud800");
}
#[cfg(unix)]
#[cfg(feature = "testkit")]
#[test]
fn links_rebound_roots_and_replaced_state_do_not_redirect_commit() {
    use std::os::unix::fs::symlink;
    for mode in [
        "symlink", "hardlink", "root", "file", "lock", "stage", "cancel",
    ] {
        let root = root();
        let outside = root.path().join("outside");
        fs::write(&outside, b"{}").unwrap();
        let selected = root.path().join("selected");
        fs::create_dir(&selected).unwrap();
        let path = selected.join("run-state.json");
        if mode == "symlink" {
            symlink(&outside, &path).unwrap();
        } else if mode == "hardlink" {
            fs::hard_link(&outside, &path).unwrap();
        } else {
            fs::write(&path, b"{}").unwrap();
        }
        let old = root.path().join("old");
        let moved = selected.clone();
        let old_path = path.clone();
        let cancelled = Cancel::never();
        let token = cancelled.clone();
        let store = open(&selected).with_observer(Arc::new(move |stage| {
            if stage == "prepared" {
                if mode == "root" {
                    fs::rename(&moved, &old).unwrap();
                    fs::create_dir(&moved).unwrap();
                }
                if mode == "file" {
                    fs::rename(&old_path, moved.join("old-state")).unwrap();
                    fs::write(&old_path, b"{}").unwrap();
                }
                if mode == "lock" {
                    fs::rename(moved.join("run-state-writer.lock"), moved.join("old-lock"))
                        .unwrap();
                    fs::write(moved.join("run-state-writer.lock"), b"").unwrap();
                }
                if mode == "stage" {
                    let staged = fs::read_dir(&moved)
                        .unwrap()
                        .map(|e| e.unwrap())
                        .find(|e| {
                            e.file_name()
                                .to_string_lossy()
                                .starts_with(".native-run-state-")
                        })
                        .unwrap();
                    fs::write(staged.path(), b"changed staging bytes").unwrap();
                }
                if mode == "cancel" {
                    token.cancel();
                }
            }
            Ok(())
        }));
        assert!(store.record(&key(), &cancelled).is_err(), "{mode}");
        assert_eq!(fs::read(&outside).unwrap(), b"{}");
        if mode == "root" {
            assert_eq!(fs::read_dir(selected).unwrap().count(), 0);
        } else {
            assert_eq!(fs::read(path).unwrap(), b"{}");
        }
    }
}

#[test]
fn abandoned_staging_bound_preserves_evidence_instead_of_pruning_it() {
    let root = root();
    for i in 0..128 {
        fs::write(
            root.path().join(format!(".native-run-state-{i}.tmp")),
            b"retained evidence",
        )
        .unwrap();
    }
    let store = open(root.path());
    assert!(store.record(&key(), &Cancel::never()).is_err());
    assert!(!root.path().join("run-state.json").exists());
    for i in 0..128 {
        assert_eq!(
            fs::read(root.path().join(format!(".native-run-state-{i}.tmp"))).unwrap(),
            b"retained evidence"
        );
    }
}

#[cfg(feature = "testkit")]
#[test]
fn jobs_rate_limit_store_child() {
    let Ok(path) = std::env::var("PLUR1BUS_JOB_RATE_TEST_ROOT") else {
        return;
    };
    let point = std::env::var("PLUR1BUS_JOB_RATE_TEST_POINT").unwrap();
    let root = std::path::PathBuf::from(path);
    let ready = root.join("ready");
    let store = open(&root).with_observer(Arc::new(move |stage| {
        if stage == point {
            fs::write(&ready, b"ready").unwrap();
            loop {
                std::thread::park();
            }
        }
        Ok(())
    }));
    store.record(&key(), &Cancel::never()).unwrap();
    assert!(root.join("ready").exists());
}
#[cfg(unix)]
#[cfg(feature = "testkit")]
#[test]
fn sigkill_keeps_exactly_the_old_or_new_state_and_releases_writer_lease() {
    use std::{
        os::unix::process::ExitStatusExt,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    for point in ["prepared", "committed"] {
        let root = root();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "jobs_rate_limit_store_child"])
            .env("PLUR1BUS_JOB_RATE_TEST_ROOT", root.path())
            .env("PLUR1BUS_JOB_RATE_TEST_POINT", point)
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
        let path = root.path().join("run-state.json");
        assert_eq!(path.exists(), point == "committed");
        let store = open(root.path());
        store
            .record(
                &key(),
                &Cancel::with_deadline(Instant::now() + Duration::from_secs(2)),
            )
            .unwrap();
        let state: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(
            state["jobRateLimits"]["gc-run:agent:workspace"]["runCount"],
            if point == "committed" { 2 } else { 1 }
        );
    }
}
