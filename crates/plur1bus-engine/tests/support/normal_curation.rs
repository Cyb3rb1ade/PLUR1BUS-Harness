//! Ordinary primary receipts authorize their own curation entry, never caller-supplied audit text.
use super::*;
fn stored() -> Fixture {
    let f = fixture();
    let selected = select(&f);
    f.merge
        .store_selected(
            &selected,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    f
}
fn log(root: &Path) -> PathBuf {
    root.join("workspace/.adaptive-learning/curation-log.jsonl")
}
#[test]
fn ordinary_curation_is_original_operation_bound_and_exactly_once() {
    let f = stored();
    assert!(!log(f.base.root.path()).exists());
    for replay in [false, true] {
        let result = f
            .merge
            .publish_store_curation(
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never(),
            )
            .unwrap();
        assert_eq!(result.memory_id, operation().to_string());
        assert_eq!(result.replayed, replay);
    }
    let bytes = std::fs::read_to_string(log(f.base.root.path())).unwrap();
    assert_eq!(bytes.lines().count(), 1);
    let event: Value = serde_json::from_str(bytes.trim()).unwrap();
    assert_eq!(event["event"], "memory.stored");
    assert_eq!(event["memoryId"], operation().to_string());
    assert_eq!(event["text"], "A synthetic decision");
    assert_eq!(event["timestamp"], "2025-01-01T00:00:00.000Z");
    assert!(!f
        .base
        .root
        .path()
        .join("workspace/.adaptive-learning/knowledge-pending.json")
        .exists());
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
}
#[test]
fn curation_publication_resumes_frozen_time_at_each_durable_boundary() {
    for point in [
        "normal-curation-prepared",
        "normal-curation-write",
        "normal-curation-complete",
    ] {
        let mut f = stored();
        let hit = Arc::new(AtomicBool::new(true));
        let signal = hit.clone();
        f.merge = f.merge.with_observer(Arc::new(move |s| {
            if s == point && signal.swap(false, Ordering::SeqCst) {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(f
            .merge
            .publish_store_curation(
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never()
            )
            .is_err());
        f.host.inner.time.store(1735689610000, Ordering::SeqCst);
        NativeMerge::open(f.reader.clone(), f.journal.clone()).unwrap();
        assert!(
            f.merge
                .publish_store_curation(
                    operation(),
                    &f.base.principal,
                    &f.base.agent,
                    &Cancel::never()
                )
                .unwrap()
                .replayed
        );
        let bytes = std::fs::read_to_string(log(f.base.root.path())).unwrap();
        assert_eq!(bytes.lines().count(), 1);
        let event: Value = serde_json::from_str(bytes.trim()).unwrap();
        assert_eq!(event["timestamp"], "2025-01-01T00:00:00.000Z");
    }
}
#[test]
fn curation_never_invents_a_primary_or_ignores_changed_rows_and_policy() {
    for mode in ["absent", "changed", "deleted", "policy", "config"] {
        let f = if mode == "absent" {
            fixture()
        } else {
            stored()
        };
        match mode {
            "changed" => f
                .base
                .store
                .patch(
                    &operation().to_string(),
                    &RowPatch {
                        text: Some("A different row".into()),
                        ..Default::default()
                    },
                )
                .unwrap(),
            "deleted" => {
                f.base.store.delete(&[&operation().to_string()]).unwrap();
            }
            "policy" => f.policy.allowed.store(false, Ordering::SeqCst),
            "config" => f.host.config.lock().unwrap()["summaryMaxWords"] = json!(10),
            _ => (),
        }
        assert!(
            f.merge
                .publish_store_curation(
                    operation(),
                    &f.base.principal,
                    &f.base.agent,
                    &Cancel::never()
                )
                .is_err(),
            "{mode}"
        );
        assert!(!log(f.base.root.path()).exists());
    }
}

#[test]
fn completed_curation_never_recreates_deleted_or_changed_evidence() {
    for mode in ["deleted", "changed", "duplicated", "during-replay"] {
        let mut f = stored();
        f.merge
            .publish_store_curation(
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never(),
            )
            .unwrap();
        let path = log(f.base.root.path());
        let bytes = std::fs::read(&path).unwrap();
        match mode {
            "deleted" => std::fs::remove_file(&path).unwrap(),
            "changed" => {
                let mut event: Value = serde_json::from_slice(&bytes).unwrap();
                event["reason"] = "changed".into();
                std::fs::write(&path, format!("{event}\n")).unwrap();
            }
            "duplicated" => {
                let mut both = bytes.clone();
                both.extend_from_slice(&bytes);
                std::fs::write(&path, both).unwrap();
            }
            _ => {
                let path = path.clone();
                f.merge = f.merge.with_observer(Arc::new(move |s| {
                    if s == "normal-prepared" {
                        std::fs::remove_file(&path).unwrap();
                    }
                    Ok(())
                }));
            }
        }
        assert!(
            f.merge
                .publish_store_curation(
                    operation(),
                    &f.base.principal,
                    &f.base.agent,
                    &Cancel::never()
                )
                .is_err(),
            "{mode}"
        );
        if mode == "deleted" || mode == "during-replay" {
            assert!(!path.exists());
        }
    }
}
#[test]
fn curation_preserves_unrelated_bytes_and_refuses_torn_or_oversized_logs() {
    for mode in ["unrelated", "torn", "oversized"] {
        let f = stored();
        let path = log(f.base.root.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let unrelated = b"{\"event\": \"unrelated\", \"agentId\": \"another\"}\n";
        match mode {
            "unrelated" => std::fs::write(&path, unrelated).unwrap(),
            "torn" => std::fs::write(&path, b"{\"unfinished\":").unwrap(),
            _ => std::fs::File::create(&path)
                .unwrap()
                .set_len(64 * 1024 * 1024 + 1)
                .unwrap(),
        }
        let result = f.merge.publish_store_curation(
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        );
        if mode == "unrelated" {
            result.unwrap();
            let bytes = std::fs::read(path).unwrap();
            assert!(bytes.starts_with(unrelated));
            assert_eq!(bytes.iter().filter(|b| **b == b'\n').count(), 2);
        } else {
            assert!(result.is_err(), "{mode}");
        }
    }
}
#[cfg(unix)]
#[test]
fn curation_refuses_linked_logs_and_replaced_held_directories() {
    for mode in ["symlink", "hardlink", "directory"] {
        let mut f = stored();
        f.merge = f.merge.with_observer(Arc::new(|s| {
            if s == "normal-curation-prepared" {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(f
            .merge
            .publish_store_curation(
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never()
            )
            .is_err());
        let path = log(f.base.root.path());
        let outside = f.base.root.path().join("outside.jsonl");
        std::fs::write(&outside, b"{}\n").unwrap();
        match mode {
            "symlink" => std::os::unix::fs::symlink(&outside, &path).unwrap(),
            "hardlink" => std::fs::hard_link(&outside, &path).unwrap(),
            _ => {
                let dir = path.parent().unwrap();
                std::fs::rename(dir, f.base.root.path().join("old-curation")).unwrap();
                std::fs::create_dir(dir).unwrap();
            }
        }
        assert!(
            NativeMerge::open(f.reader.clone(), f.journal.clone()).is_err(),
            "{mode}"
        );
        assert_eq!(std::fs::read(&outside).unwrap(), b"{}\n");
    }
}
#[test]
fn pending_curation_fences_other_writers_and_rechecks_revoked_policy() {
    let mut f = stored();
    let policy = f.policy.clone();
    f.merge = f.merge.with_observer(Arc::new(move |s| {
        if s == "normal-curation-prepared" {
            policy.allowed.store(false, Ordering::SeqCst);
        }
        Ok(())
    }));
    assert!(f
        .merge
        .publish_store_curation(
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        )
        .is_err());
    assert!(!log(f.base.root.path()).exists());
    assert!(NativeMerge::open(f.reader.clone(), f.journal.clone()).is_err());
    f.policy.allowed.store(true, Ordering::SeqCst);
    assert!(matches!(
        f.merge.select_normal(
            &params(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        ),
        Err(EngineError::Store(StoreError::Busy))
    ));
    let turn:TurnRecord=serde_json::from_value(json!({"agentId":"alpha","principal":f.base.principal,"agent":f.base.agent,"runId":"automatic","sessionKey":"automatic","incognito":false,"messages":[{"role":"user","content":"Synthetic automatic capture"}]})).unwrap();
    let ctx = RequestContext::build(&turn.principal, &turn.agent, f.host.as_ref()).unwrap();
    assert!(matches!(
        f.journal.record(&turn, &ctx, &Cancel::never()),
        Err(EngineError::Store(StoreError::Busy))
    ));
    NativeMerge::open(f.reader.clone(), f.journal.clone()).unwrap();
    f.journal.record(&turn, &ctx, &Cancel::never()).unwrap();
    assert!(log(f.base.root.path()).is_file());
}
#[cfg(unix)]
#[test]
fn curation_sigkill_child() {
    let Some(root) = std::env::var_os("PLUR1BUS_CURATION_TEST_ROOT") else {
        return;
    };
    let point = std::env::var("PLUR1BUS_CURATION_TEST_POINT").unwrap();
    let f = reopen(Path::new(&root));
    let native = NativeMerge::new(f.reader, f.journal).with_observer(Arc::new(move |s| {
        if s == point {
            unsafe {
                libc::kill(libc::getpid(), libc::SIGKILL);
            }
        }
        Ok(())
    }));
    native
        .publish_store_curation(
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    panic!("kill boundary not reached");
}
#[cfg(unix)]
#[test]
fn actual_sigkill_curation_recovers_one_event_without_providers() {
    use std::os::unix::process::ExitStatusExt;
    for point in [
        "normal-curation-prepared",
        "normal-curation-write",
        "normal-curation-complete",
    ] {
        let f = stored();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "insert_tests::curation_tests::curation_sigkill_child",
                "--nocapture",
            ])
            .env("PLUR1BUS_CURATION_TEST_ROOT", f.base.root.path())
            .env("PLUR1BUS_CURATION_TEST_POINT", point)
            .status()
            .unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        let p = reopen(f.base.root.path());
        p.host.inner.time.store(1735689610000, Ordering::SeqCst);
        NativeMerge::open(p.reader.clone(), p.journal.clone()).unwrap();
        NativeMerge::open(p.reader, p.journal).unwrap();
        let bytes = std::fs::read_to_string(log(f.base.root.path())).unwrap();
        assert_eq!(bytes.lines().count(), 1);
        let event: Value = serde_json::from_str(bytes.trim()).unwrap();
        assert_eq!(event["timestamp"], "2025-01-01T00:00:00.000Z");
        assert_eq!(p.embed.calls.load(Ordering::SeqCst), 0);
        assert_eq!(p.host.calls.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn concurrent_curation_retries_publish_once_and_a_different_chat_cannot_borrow_the_intent() {
    let f = stored();
    let mut value = serde_json::to_value(&f.base.principal).unwrap();
    value["chat"]["id"] = "different-chat".into();
    let other: Principal = serde_json::from_value(value).unwrap();
    assert!(f
        .merge
        .publish_store_curation(operation(), &other, &f.base.agent, &Cancel::never())
        .is_err());
    assert!(!log(f.base.root.path()).exists());
    std::thread::scope(|scope| {
        let mut joins = Vec::new();
        for _ in 0..4 {
            let f = &f;
            joins.push(scope.spawn(move || {
                f.merge
                    .publish_store_curation(
                        operation(),
                        &f.base.principal,
                        &f.base.agent,
                        &Cancel::never(),
                    )
                    .unwrap()
            }));
        }
        assert_eq!(
            joins
                .into_iter()
                .map(|j| j.join().unwrap())
                .filter(|r| !r.replayed)
                .count(),
            1
        );
    });
    assert_eq!(
        std::fs::read_to_string(log(f.base.root.path()))
            .unwrap()
            .lines()
            .count(),
        1
    );
}
