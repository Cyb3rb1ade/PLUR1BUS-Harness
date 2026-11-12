use super::*;
use std::sync::Arc;
const SOURCE: &str = r#"{"completed":{"rem:alpha:old":{"count":2}}}"#;
const RECEIPT: &str = "native-job-migration-alpha.json";
fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let scratch = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(scratch.path()).unwrap();
    fs::create_dir(root.join("jobs")).unwrap();
    fs::create_dir(root.join("state")).unwrap();
    fs::write(root.join("state/run-state.json"), SOURCE).unwrap();
    (scratch, root)
}
#[test]
fn changed_backup_ledger_and_receipt_stop_before_the_next_effect() {
    for target in ["backup", "backup-identity", "ledger-identity", "receipt"] {
        let (_scratch, root) = fixture();
        let path = root.clone();
        let phase = if target == "ledger-identity" {
            "migration-rows"
        } else if target == "receipt" {
            "migration-prepared"
        } else {
            "migration-backup"
        };
        let observer = Arc::new(move |point: &str| {
            if point != phase {
                return;
            }
            let file = match target {
                "receipt" => path.join("state").join(RECEIPT),
                "ledger-identity" => path.join("jobs/alpha/ledger.jsonl"),
                _ => path.join("state/run-state.json.migrated"),
            };
            if target.ends_with("identity") {
                let bytes = fs::read(&file).unwrap();
                fs::rename(&file, path.join("held-original")).unwrap();
                fs::write(&file, bytes).unwrap();
            } else {
                fs::write(&file, b"tampered").unwrap();
            }
        });
        let mut active = session(&root.join("jobs")).with_observer(observer);
        assert!(
            active
                .migrate_legacy(&root.join("state"), 1000., &Cancel::never())
                .is_err(),
            "{target}"
        );
        assert_eq!(
            fs::read_to_string(root.join("state/run-state.json")).unwrap(),
            SOURCE,
            "{target}"
        );
        if target != "ledger-identity" {
            assert!(!root.join("jobs/alpha/ledger.jsonl").exists(), "{target}");
        }
    }
}

const PHASES: [&str; 5] = [
    "migration-prepared",
    "migration-backup",
    "migration-rows",
    "migration-state",
    "migration-complete",
];
fn verify(root: &Path) {
    let receipt: Value =
        serde_json::from_slice(&fs::read(root.join("state").join(RECEIPT)).unwrap()).unwrap();
    assert_eq!(receipt["complete"], true);
    assert_eq!(receipt["now"], 1000.);
    assert_eq!(
        fs::read_to_string(root.join("state/run-state.json.migrated")).unwrap(),
        SOURCE
    );
    let expected = receipt["suffix"].as_str().unwrap();
    assert!(!expected.is_empty());
    assert_eq!(
        fs::read_to_string(root.join("jobs/alpha/ledger.jsonl")).unwrap(),
        expected
    );
    assert_eq!(
        fs::read_to_string(root.join("state/run-state.json")).unwrap(),
        receipt["after"].as_str().unwrap()
    );
}
#[test]
fn cancellation_at_each_publication_recovers_with_the_original_clock() {
    for phase in PHASES {
        let (_scratch, root) = fixture();
        let cancel = Cancel::never();
        let cancelled = cancel.clone();
        let mut active = session(&root.join("jobs")).with_observer(Arc::new(move |point| {
            if point == phase {
                cancelled.cancel();
            }
        }));
        assert!(active
            .migrate_legacy(&root.join("state"), 1000., &cancel)
            .is_err());
        drop(active);
        let mut restarted = session(&root.join("jobs"));
        let result = restarted
            .migrate_legacy(&root.join("state"), 9999., &Cancel::never())
            .unwrap();
        assert_eq!(result.recovered, phase != "migration-complete");
        verify(&root);
        assert_eq!(
            restarted
                .migrate_legacy(&root.join("state"), 20000., &Cancel::never())
                .unwrap()
                .status
                .as_str(),
            "already"
        );
        verify(&root);
    }
}
#[test]
fn exact_partial_append_resumes_but_divergent_bytes_remain_untouched() {
    for mode in ["first-byte", "half", "complete", "divergent"] {
        let (_scratch, root) = fixture();
        let cancel = Cancel::never();
        let cancelled = cancel.clone();
        let mut active = session(&root.join("jobs")).with_observer(Arc::new(move |point| {
            if point == "migration-backup" {
                cancelled.cancel();
            }
        }));
        assert!(active
            .migrate_legacy(&root.join("state"), 1000., &cancel)
            .is_err());
        drop(active);
        let receipt: Value =
            serde_json::from_slice(&fs::read(root.join("state").join(RECEIPT)).unwrap()).unwrap();
        let suffix = receipt["suffix"].as_str().unwrap();
        let bytes = match mode {
            "first-byte" => &suffix.as_bytes()[..1],
            "half" => &suffix.as_bytes()[..suffix.len() / 2],
            "complete" => suffix.as_bytes(),
            _ => b"foreign append",
        };
        fs::write(root.join("jobs/alpha/ledger.jsonl"), bytes).unwrap();
        let mut active = session(&root.join("jobs"));
        let result = active.migrate_legacy(&root.join("state"), 9000., &Cancel::never());
        if mode == "divergent" {
            assert!(result.is_err());
            assert_eq!(
                fs::read(root.join("jobs/alpha/ledger.jsonl")).unwrap(),
                bytes
            );
            assert_eq!(
                fs::read_to_string(root.join("state/run-state.json")).unwrap(),
                SOURCE
            );
        } else {
            assert!(result.unwrap().recovered);
            verify(&root);
        }
    }
}
#[cfg(unix)]
#[test]
fn migration_child() {
    let Some(root) = std::env::var_os("PLUR1BUS_MIGRATION_TEST_ROOT") else {
        return;
    };
    let phase = std::env::var("PLUR1BUS_MIGRATION_TEST_POINT").unwrap();
    let root = std::path::PathBuf::from(root);
    let ready = root.join("ready");
    let mut active = session(&root.join("jobs")).with_observer(Arc::new(move |point| {
        if point == phase {
            fs::write(&ready, b"ready").unwrap();
            loop {
                std::thread::park();
            }
        }
    }));
    active
        .migrate_legacy(&root.join("state"), 1000., &Cancel::never())
        .unwrap();
    panic!("migration boundary not reached");
}
#[cfg(unix)]
#[test]
fn sigkill_at_five_publications_recovers_without_duplicate_imports() {
    use std::{
        os::unix::process::ExitStatusExt,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    for phase in PHASES {
        let (_scratch, root) = fixture();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                std::any::type_name_of_val(&migration_child)
                    .split_once("::")
                    .map_or("", |(_, name)| name),
            ])
            .env("PLUR1BUS_MIGRATION_TEST_ROOT", &root)
            .env("PLUR1BUS_MIGRATION_TEST_POINT", phase)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !root.join("ready").exists() && Instant::now() < deadline {
            assert!(child.try_wait().unwrap().is_none(), "{phase}");
            std::thread::sleep(Duration::from_millis(5));
        }
        let ready = root.join("ready").exists();
        child.kill().unwrap();
        assert_eq!(child.wait().unwrap().signal(), Some(9));
        assert!(ready, "{phase}");
        let mut restarted = session(&root.join("jobs"));
        restarted
            .migrate_legacy(&root.join("state"), 9000., &Cancel::never())
            .unwrap();
        verify(&root);
        restarted
            .migrate_legacy(&root.join("state"), 20000., &Cancel::never())
            .unwrap();
        verify(&root);
    }
}

#[test]
fn another_agent_waits_for_the_active_migration_of_a_shared_state_file() {
    let (_scratch, root) = fixture();
    let cancel = Cancel::never();
    let cancelled = cancel.clone();
    let mut active = session(&root.join("jobs")).with_observer(Arc::new(move |point| {
        if point == "migration-prepared" {
            cancelled.cancel();
        }
    }));
    assert!(active
        .migrate_legacy(&root.join("state"), 1000., &cancel)
        .is_err());
    drop(active);
    let mut other = JobLedger::open(&root.join("jobs"), "beta")
        .unwrap()
        .session(&Cancel::never())
        .unwrap();
    other.recover(2000., &Cancel::never()).unwrap();
    assert!(other
        .migrate_legacy(&root.join("state"), 2000., &Cancel::never())
        .is_err());
    assert_eq!(
        fs::read_to_string(root.join("state/run-state.json")).unwrap(),
        SOURCE
    );
    let mut restarted = session(&root.join("jobs"));
    restarted
        .migrate_legacy(&root.join("state"), 9000., &Cancel::never())
        .unwrap();
    verify(&root);
    other
        .migrate_legacy(&root.join("state"), 2000., &Cancel::never())
        .unwrap();
    let current: Value =
        serde_json::from_slice(&fs::read(root.join("state/run-state.json")).unwrap()).unwrap();
    assert!(current["plur1busLedgerMigratedAt"]["alpha"].is_string());
    assert!(current["plur1busLedgerMigratedAt"]["beta"].is_string());
    assert_eq!(
        fs::read_to_string(root.join("state/run-state.json.migrated")).unwrap(),
        SOURCE
    );
}
