//! Prepared C4 replay keeps the original caller, time and exact appends across interruption.
use super::*;
use plur1bus_engine::contract::StoreError;

fn reopen(f: &Fixture) -> RevisionStore {
    RevisionStore::new(
        Arc::new(
            CaptureJournal::open(
                &f._root.path().join("neo"),
                f.host.clone(),
                f.policy.clone(),
            )
            .unwrap(),
        ),
        f.host.clone(),
    )
}
fn stop(f: &mut Fixture, phase: &'static str) {
    f.store = reopen(f).with_observer(Arc::new(move |stage| {
        if stage == phase {
            Err(StoreError::Unavailable.into())
        } else {
            Ok(())
        }
    }));
}
#[test]
fn each_durable_boundary_recovers_without_reboosting_or_retimestamping() {
    for phase in ["prepared", "revision", "audit", "queue", "complete"] {
        let (mut f, request) = seeded();
        stop(&mut f, phase);
        assert!(apply(&f, &request).is_err());
        f.host.time.store(1794225600000, Ordering::SeqCst);
        let reopened = reopen(&f);
        let result = reopened
            .recover(&f.principal, &f.agent, &Cancel::never())
            .unwrap();
        assert_eq!(result.is_none(), phase == "complete");
        let actual = rows(f.directory.join("behavior-cards.jsonl"));
        assert_eq!(actual.len(), 2);
        assert_eq!(
            field(&actual[1], "updatedAt"),
            &text("2026-11-08T12:00:00.000Z")
        );
        assert_eq!(
            field(&actual[1], "salience"),
            &Json::Number("0.6000000000000001".into())
        );
        assert_eq!(
            rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl")).len(),
            1
        );
        assert_eq!(rows(f.directory.join("embedding-queue.jsonl")).len(), 1);
        assert!(reopened
            .recover(&f.principal, &f.agent, &Cancel::never())
            .unwrap()
            .is_none());
    }
}
#[test]
fn failed_audit_stops_queue_and_the_original_plan_can_resume() {
    let (mut f, request) = seeded();
    let audit = f.workspace.join(".adaptive-learning/destructive-ops.jsonl");
    let blocked = audit.clone();
    f.store = reopen(&f).with_observer(Arc::new(move |stage| {
        if stage == "revision" {
            fs::create_dir(&blocked).unwrap();
        }
        Ok(())
    }));
    assert!(apply(&f, &request).is_err());
    assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 2);
    assert!(!f.directory.join("embedding-queue.jsonl").exists());
    fs::remove_dir(audit).unwrap();
    reopen(&f)
        .recover(&f.principal, &f.agent, &Cancel::never())
        .unwrap()
        .unwrap();
    assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 2);
    assert_eq!(rows(f.directory.join("embedding-queue.jsonl")).len(), 1);
}

#[test]
fn pending_unaudited_revision_fences_the_actual_embedding_drain() {
    use plur1bus_engine::{
        capture::emotion_pool::EmotionalPool,
        neo::{
            embedding_drain::{DrainOptions, EmbeddingDrain},
            episode_store::EpisodeStore,
        },
    };
    let (mut f, request) = seeded();
    let case = cases().remove(4);
    let Json::Array(queue) = field(&case, "queue") else {
        panic!("queue")
    };
    let mut queued = bound(&f, &queue[0]);
    set(&mut queued, "status", text("pending"));
    set(&mut queued, "scope", text("agent_private"));
    set(&mut queued, "ownerUserId", text(&f.context.owner_user_id));
    append(f.directory.join("embedding-queue.jsonl"), &queued);
    stop(&mut f, "revision");
    assert!(apply(&f, &request).is_err());
    let mood = Arc::new(EmotionalPool::new(f.host.clone(), json!({})));
    let episodes = Arc::new(
        EpisodeStore::open(
            &f._root.path().join("neo"),
            f.host.clone(),
            f.policy.clone(),
            mood,
        )
        .unwrap(),
    );
    let drain = EmbeddingDrain::new(episodes, None).unwrap();
    assert!(drain
        .drain(
            &f.principal,
            &f.agent,
            &DrainOptions::default(),
            &Cancel::never()
        )
        .is_err());
    reopen(&f)
        .recover(&f.principal, &f.agent, &Cancel::never())
        .unwrap()
        .unwrap();
    drain
        .drain(
            &f.principal,
            &f.agent,
            &DrainOptions::default(),
            &Cancel::never(),
        )
        .unwrap();
}

#[test]
fn revocation_at_each_boundary_stops_the_next_effect() {
    for phase in ["prepared", "revision", "audit"] {
        let (mut f, request) = seeded();
        let policy = f.policy.clone();
        f.store = reopen(&f).with_observer(Arc::new(move |stage| {
            if stage == phase {
                policy.0.store(false, Ordering::SeqCst);
            }
            Ok(())
        }));
        assert!(apply(&f, &request).is_err());
        assert_eq!(
            rows(f.directory.join("behavior-cards.jsonl")).len(),
            if phase == "prepared" { 1 } else { 2 }
        );
        assert_eq!(
            rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl")).len(),
            usize::from(phase == "audit")
        );
        assert!(!f.directory.join("embedding-queue.jsonl").exists());
        f.policy.0.store(true, Ordering::SeqCst);
        reopen(&f)
            .recover(&f.principal, &f.agent, &Cancel::never())
            .unwrap()
            .unwrap();
    }
}
#[test]
fn cancelled_revoked_or_different_chat_cannot_borrow_a_pending_decision() {
    let (mut f, request) = seeded();
    stop(&mut f, "revision");
    assert!(apply(&f, &request).is_err());
    let before = fs::read(f.directory.join("native-revision-state.json")).unwrap();
    let reopened = reopen(&f);
    let mut other = serde_json::to_value(&f.principal).unwrap();
    other["chat"]["id"] = json!("other");
    let other = serde_json::from_value(other).unwrap();
    assert!(reopened
        .recover(&other, &f.agent, &Cancel::never())
        .is_err());
    f.policy.0.store(false, Ordering::SeqCst);
    assert!(reopened
        .recover(&f.principal, &f.agent, &Cancel::never())
        .is_err());
    f.policy.0.store(true, Ordering::SeqCst);
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(reopened.recover(&f.principal, &f.agent, &cancel).is_err());
    assert_eq!(
        fs::read(f.directory.join("native-revision-state.json")).unwrap(),
        before
    );
    assert!(!f.directory.join("embedding-queue.jsonl").exists());
    reopened
        .recover(&f.principal, &f.agent, &Cancel::never())
        .unwrap()
        .unwrap();
}
#[test]
fn changed_latest_source_blocks_replay_without_overwriting_it() {
    let (mut f, request) = seeded();
    stop(&mut f, "revision");
    assert!(apply(&f, &request).is_err());
    let mut changed = rows(f.directory.join("behavior-cards.jsonl"))
        .pop()
        .unwrap();
    set(&mut changed, "updatedAt", text("2026-11-09T12:00:00.000Z"));
    set(
        &mut changed,
        "ownerUserId",
        text(&harness_user_principal("foreign")),
    );
    append(f.directory.join("behavior-cards.jsonl"), &changed);
    assert!(reopen(&f)
        .recover(&f.principal, &f.agent, &Cancel::never())
        .is_err());
    assert_eq!(
        rows(f.directory.join("behavior-cards.jsonl")).last(),
        Some(&changed)
    );
    assert!(!f.directory.join("embedding-queue.jsonl").exists());
}
#[test]
fn only_the_exact_planned_partial_append_is_repaired() {
    for (index, phase) in [(0, "prepared"), (1, "revision"), (2, "audit")] {
        for valid in [true, false] {
            let (mut f, request) = seeded();
            stop(&mut f, phase);
            assert!(apply(&f, &request).is_err());
            let state = parse_json(
                &fs::read_to_string(f.directory.join("native-revision-state.json")).unwrap(),
            )
            .unwrap();
            let Json::Array(appends) = field(&state, "appends") else {
                panic!("appends")
            };
            let planned = &appends[index];
            let base = if index == 1 {
                f.workspace.join(".adaptive-learning")
            } else {
                f.directory.clone()
            };
            let path = base.join(string(field(planned, "file")));
            let line = format!("{}\n", write_json(field(planned, "row")));
            let partial = if valid {
                &line.as_bytes()[..line.len() / 2]
            } else {
                b"invalid-tail".as_slice()
            };
            use std::io::Write;
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .unwrap()
                .write_all(partial)
                .unwrap();
            let before = fs::read(&path).unwrap();
            let result = reopen(&f).recover(&f.principal, &f.agent, &Cancel::never());
            if valid {
                result.unwrap().unwrap();
                assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 2);
                assert_eq!(rows(f.directory.join("embedding-queue.jsonl")).len(), 1);
                assert_eq!(
                    rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl")).len(),
                    1
                );
            } else {
                assert!(result.is_err());
                assert_eq!(fs::read(&path).unwrap(), before);
            }
        }
    }
}
#[test]
fn pending_source_and_queue_changes_or_tampered_plan_fail_closed() {
    for mode in ["source-prefix", "audit-row", "scope", "operation"] {
        let (mut f, request) = seeded();
        stop(&mut f, "prepared");
        assert!(apply(&f, &request).is_err());
        let path = f.directory.join("native-revision-state.json");
        let mut state = parse_json(&fs::read_to_string(&path).unwrap()).unwrap();
        if mode == "source-prefix" {
            append(f.directory.join("behavior-cards.jsonl"), &request.expected);
        } else if mode == "operation" {
            set(
                &mut state,
                "operation",
                text(&uuid::Uuid::nil().to_string()),
            );
        } else {
            let mut appends = field(&state, "appends").clone();
            let Json::Array(entries) = &mut appends else {
                panic!("appends")
            };
            let index = usize::from(mode == "audit-row");
            let mut row = field(&entries[index], "row").clone();
            set(&mut row, "scope", text("global_user"));
            set(&mut entries[index], "row", row);
            set(&mut state, "appends", appends);
        }
        fs::write(&path, write_json(&state)).unwrap();
        assert!(reopen(&f)
            .recover(&f.principal, &f.agent, &Cancel::never())
            .is_err());
        assert!(!f.directory.join("embedding-queue.jsonl").exists());
    }
}

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
            .args(["--exact", "edges::recovery::crash_child", "--nocapture"])
            .env("PLUR1BUS_TEST_REVISION_ROOT", f._root.path())
            .env("PLUR1BUS_TEST_REVISION_PHASE", phase)
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
        reopen(&f)
            .recover(&f.principal, &f.agent, &Cancel::never())
            .unwrap();
        assert_eq!(
            rows(f.directory.join("behavior-cards.jsonl")).len(),
            2,
            "{phase}"
        );
        assert_eq!(
            rows(f.directory.join("embedding-queue.jsonl")).len(),
            1,
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
    let Some(root) = std::env::var_os("PLUR1BUS_TEST_REVISION_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let phase = std::env::var("PLUR1BUS_TEST_REVISION_PHASE").unwrap();
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
        .apply(
            &principal,
            &agent,
            &RevisionRequest {
                operation_id: uuid::Uuid::new_v4(),
                expected,
                action: Action::Promote,
            },
            &Cancel::never(),
        )
        .unwrap();
}
