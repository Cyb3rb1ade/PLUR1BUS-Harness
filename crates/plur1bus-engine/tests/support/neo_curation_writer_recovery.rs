//! Versioned facade replay after actual process death and authority changes.
use super::*;
#[cfg(unix)]
#[test]
fn sigkill_at_all_publication_boundaries_keeps_exactly_one_effect() {
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    for phase in ["prepared", "revision", "audit", "queue", "complete"] {
        let (f, request) = seeded();
        fs::write(
            f._root.path().join("principal.json"),
            serde_json::to_vec(&f.principal).unwrap(),
        )
        .unwrap();
        fs::write(
            f._root.path().join("expected.json"),
            write_json(&request.expected),
        )
        .unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "curation_writer::recovery::crash_child",
                "--nocapture",
            ])
            .env("PLUR1BUS_TEST_CURATION_ROOT", f._root.path())
            .env("PLUR1BUS_TEST_CURATION_PHASE", phase)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !f._root.path().join("ready").exists() && Instant::now() < deadline {
            assert!(
                child.try_wait().unwrap().is_none(),
                "child exited before {phase}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let ready = f._root.path().join("ready").exists();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(ready, "missing {phase}");
        let journal = Arc::new(
            CaptureJournal::open(
                &f._root.path().join("neo"),
                f.host.clone(),
                f.policy.clone(),
            )
            .unwrap(),
        );
        assert_eq!(
            rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl")).len(),
            usize::from(phase != "prepared")
        );
        assert_eq!(
            rows(f.directory.join("behavior-cards.jsonl")).len(),
            if ["prepared", "audit"].contains(&phase) {
                1
            } else {
                2
            }
        );
        RevisionStore::open(journal, f.host.clone()).unwrap();
        assert_eq!(
            rows(f.directory.join("behavior-cards.jsonl")).len(),
            2,
            "{phase}"
        );
        assert_eq!(
            rows(f.directory.join("embedding-queue.jsonl")).len(),
            0,
            "{phase}"
        );
        assert_eq!(
            rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl")).len(),
            1,
            "{phase}"
        );
    }
}
#[cfg(unix)]
#[test]
fn crash_child() {
    let Some(root) = std::env::var_os("PLUR1BUS_TEST_CURATION_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let phase = std::env::var("PLUR1BUS_TEST_CURATION_PHASE").unwrap();
    let host = Arc::new(support::TestHost::new(root.join("state")));
    host.set_workspace("alpha", root.join("workspace"));
    host.time.store(1794139200000, Ordering::SeqCst);
    let principal: Principal =
        serde_json::from_slice(&fs::read(root.join("principal.json")).unwrap()).unwrap();
    let agent = serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    let expected = parse_json(&fs::read_to_string(root.join("expected.json")).unwrap()).unwrap();
    let journal = Arc::new(
        CaptureJournal::open(
            &root.join("neo"),
            host.clone(),
            Arc::new(Policy(AtomicBool::new(true))),
        )
        .unwrap(),
    );
    let store = RevisionStore::new(journal, host).with_observer(Arc::new(move |stage| {
        if stage == phase {
            fs::write(root.join("ready"), stage).unwrap();
            loop {
                std::thread::park();
            }
        }
        Ok(())
    }));
    store
        .apply_curation(
            &principal,
            &agent,
            &RevisionRequest {
                operation_id: uuid::Uuid::new_v4(),
                expected,
                action: Action::Keep,
            },
            &Cancel::never(),
        )
        .unwrap();
}
#[test]
fn revocation_and_receipt_downgrade_refuse_before_revision() {
    for mode in ["revoked", "downgrade", "other-chat"] {
        let (mut f, request) = seeded();
        f.store = f.store.with_observer(Arc::new(|stage| {
            if stage == "audit" {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(apply(&f, &request).is_err());
        let path = f.directory.join("native-revision-state.json");
        if mode == "downgrade" {
            let mut state = parse_json(&fs::read_to_string(&path).unwrap()).unwrap();
            set(&mut state, "version", Json::Number("1".into()));
            fs::write(&path, write_json(&state)).unwrap();
        }
        let journal = Arc::new(
            CaptureJournal::open(
                &f._root.path().join("neo"),
                f.host.clone(),
                f.policy.clone(),
            )
            .unwrap(),
        );
        let store = RevisionStore::new(journal, f.host.clone());
        let mut principal = serde_json::to_value(&f.principal).unwrap();
        if mode == "other-chat" {
            principal["chat"]["id"] = json!("different");
        }
        if mode == "revoked" {
            f.policy.0.store(false, Ordering::SeqCst);
        }
        assert!(store
            .recover(
                &serde_json::from_value(principal).unwrap(),
                &f.agent,
                &Cancel::never()
            )
            .is_err());
        assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 1);
        assert_eq!(
            rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl")).len(),
            1
        );
    }
}
