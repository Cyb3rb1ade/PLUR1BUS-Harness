//! Each admitted duplicate operation owns an audit occurrence, not the existing memory's identity.
use super::*;
use plur1bus_engine::ops::durable_merge::NormalCandidatePlan;
use uuid::Uuid;
fn operation() -> Uuid {
    Uuid::parse_str("33333333-3333-4333-8333-333333333333").unwrap()
}
fn selected(f: &Fixture) -> NormalCandidatePlan {
    let row = f.base.store.get_record(SOURCE).unwrap().unwrap().row;
    let params =
        parse_json(&json!({"text":row.text,"category":"decision","importance":0.8}).to_string())
            .unwrap();
    f.merge
        .select_normal(&params, &f.base.principal, &f.base.agent, &Cancel::never())
        .unwrap()
}
fn log(root: &Path) -> PathBuf {
    root.join("workspace/.adaptive-learning/curation-log.jsonl")
}
#[test]
fn an_admitted_duplicate_publishes_once_without_new_rows_or_knowledge() {
    let f = setup();
    let plan = selected(&f);
    for replay in [false, true] {
        let result = f
            .merge
            .reject_selected_duplicate(
                &plan,
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never(),
            )
            .unwrap();
        assert_eq!(result.replayed, replay);
        assert!(f
            .base
            .store
            .get_record(&result.memory_id)
            .unwrap()
            .is_some());
    }
    assert!(f
        .base
        .store
        .get_record(&operation().to_string())
        .unwrap()
        .is_none());
    assert_eq!(
        std::fs::read_to_string(log(f.base.root.path()))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert!(!log(f.base.root.path())
        .with_file_name("knowledge-pending.json")
        .exists());
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
}
#[test]
fn distinct_operations_keep_distinct_identical_audit_occurrences() {
    let f = setup();
    let plan = selected(&f);
    let other = Uuid::parse_str("44444444-4444-4444-8444-444444444444").unwrap();
    for id in [operation(), other, operation(), other] {
        f.merge
            .reject_selected_duplicate(
                &plan,
                id,
                &f.base.principal,
                &f.base.agent,
                &Cancel::never(),
            )
            .unwrap();
    }
    let lines = std::fs::read_to_string(log(f.base.root.path())).unwrap();
    let rows: Vec<_> = lines.lines().collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0], rows[1]);
}
#[test]
fn duplicate_open_recovers_each_boundary_without_reembedding() {
    for point in [
        "normal-duplicate-prepared",
        "normal-duplicate-write",
        "normal-duplicate-complete",
    ] {
        let mut f = setup();
        let plan = selected(&f);
        f.merge = f.merge.with_observer(Arc::new(move |s| {
            if s == point {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(f
            .merge
            .reject_selected_duplicate(
                &plan,
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never()
            )
            .is_err());
        NativeMerge::open(f.reader.clone(), f.journal.clone()).unwrap();
        assert_eq!(
            std::fs::read_to_string(log(f.base.root.path()))
                .unwrap()
                .lines()
                .count(),
            1
        );
        assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
        assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
    }
}
fn reject(
    f: &Fixture,
    plan: &NormalCandidatePlan,
) -> Result<plur1bus_engine::ops::durable_merge::DuplicateStoreResult, EngineError> {
    f.merge.reject_selected_duplicate(
        plan,
        operation(),
        &f.base.principal,
        &f.base.agent,
        &Cancel::never(),
    )
}
fn id(plan: &NormalCandidatePlan) -> String {
    let plur1bus_engine::ops::durable_merge::NormalCandidateKind::Duplicate { id, .. } =
        plan.kind()
    else {
        panic!("expected duplicate")
    };
    id.clone()
}
#[test]
fn source_owner_current_policy_and_original_input_are_rechecked() {
    for mode in [
        "source", "deleted", "owner", "policy", "config", "chat", "input",
    ] {
        let f = setup();
        let plan = selected(&f);
        reject(&f, &plan).unwrap();
        let before = std::fs::read(log(f.base.root.path())).unwrap();
        let mut principal = serde_json::to_value(&f.base.principal).unwrap();
        match mode {
            "source" => f
                .base
                .store
                .patch(
                    &id(&plan),
                    &RowPatch {
                        text: Some("Changed source".into()),
                        ..Default::default()
                    },
                )
                .unwrap(),
            "deleted" => {
                f.base.store.delete(&[&id(&plan)]).unwrap();
            }
            "owner" => {
                let mut row = f.base.store.get_record(&id(&plan)).unwrap().unwrap().row;
                row.owner_user_id = "different-owner".into();
                f.base.store.upsert(&[row]).unwrap();
            }
            "policy" => f.policy.allowed.store(false, Ordering::SeqCst),
            "config" => f.host.config.lock().unwrap()["summaryMaxWords"] = json!(10),
            "chat" => principal["chat"]["id"] = "different-chat".into(),
            _ => (),
        }
        let principal: Principal = serde_json::from_value(principal).unwrap();
        let altered;
        let actual = if mode == "input" {
            let row = f.base.store.get_record(&id(&plan)).unwrap().unwrap().row;
            let params = parse_json(
                &json!({"text":row.text,"category":"decision","importance":0.9}).to_string(),
            )
            .unwrap();
            altered = f
                .merge
                .select_normal(&params, &f.base.principal, &f.base.agent, &Cancel::never())
                .unwrap();
            &altered
        } else {
            &plan
        };
        assert!(
            f.merge
                .reject_selected_duplicate(
                    actual,
                    operation(),
                    &principal,
                    &f.base.agent,
                    &Cancel::never()
                )
                .is_err(),
            "{mode}"
        );
        assert_eq!(std::fs::read(log(f.base.root.path())).unwrap(), before);
    }
}
#[test]
fn only_duplicate_plans_can_publish_and_admission_rechecks_selection() {
    let f = setup();
    let plan = selected(&f);
    f.base
        .store
        .patch(
            &id(&plan),
            &RowPatch {
                text: Some("Changed after selection".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(reject(&f, &plan).is_err());
    assert!(!log(f.base.root.path()).exists());
    let f = setup();
    f.host.config.lock().unwrap()["duplicateThreshold"] = json!(2);
    f.host.config.lock().unwrap()["merging"]["enabled"] = json!(false);
    let params = parse_json(
        &json!({"text":"Completely different synthetic statement","category":"decision"})
            .to_string(),
    )
    .unwrap();
    let plan = f
        .merge
        .select_normal(&params, &f.base.principal, &f.base.agent, &Cancel::never())
        .unwrap();
    assert!(reject(&f, &plan).is_err());
    assert!(!log(f.base.root.path()).exists());
}
#[test]
fn audit_occurrence_requires_its_prefix_and_line_but_preserves_later_unrelated_lines() {
    for mode in ["append", "missing", "truncated", "prefix", "line"] {
        let f = setup();
        let plan = selected(&f);
        let path = log(f.base.root.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let unrelated = "{\"event\":\"unrelated\"}\n";
        std::fs::write(&path, unrelated).unwrap();
        reject(&f, &plan).unwrap();
        let before = std::fs::read_to_string(&path).unwrap();
        match mode {
            "append" => std::fs::write(&path, format!("{before}{unrelated}")).unwrap(),
            "missing" => std::fs::remove_file(&path).unwrap(),
            "truncated" => std::fs::write(&path, unrelated).unwrap(),
            "prefix" => {
                std::fs::write(&path, before.replacen("unrelated", "different", 1)).unwrap()
            }
            _ => std::fs::write(
                &path,
                before.replace("memory.rejected_duplicate", "memory.changed_duplicate"),
            )
            .unwrap(),
        }
        let bytes = std::fs::read(&path).ok();
        let result = reject(&f, &plan);
        if mode == "append" {
            assert!(result.unwrap().replayed);
        } else {
            assert!(result.is_err(), "{mode}");
        }
        assert_eq!(std::fs::read(&path).ok(), bytes);
    }
}
#[test]
fn an_interposed_foreign_append_is_not_overwritten_or_mistaken_for_our_occurrence() {
    let mut f = setup();
    let plan = selected(&f);
    let path = log(f.base.root.path());
    let target = path.clone();
    f.merge = f.merge.with_observer(Arc::new(move |s| {
        if s == "normal-duplicate-prepared" {
            std::fs::write(&target, "{\"event\":\"interposed\"}\n").unwrap();
        }
        Ok(())
    }));
    assert!(reject(&f, &plan).is_err());
    assert!(NativeMerge::open(f.reader.clone(), f.journal.clone()).is_err());
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "{\"event\":\"interposed\"}\n"
    );
}
#[test]
fn final_boundary_deletion_never_acknowledges_or_recreates_missing_audit() {
    let mut f = setup();
    let plan = selected(&f);
    let path = log(f.base.root.path());
    let target = path.clone();
    f.merge = f.merge.with_observer(Arc::new(move |s| {
        if s == "normal-duplicate-complete" {
            std::fs::remove_file(&target).unwrap();
        }
        Ok(())
    }));
    assert!(reject(&f, &plan).is_err());
    assert!(!path.exists());
    assert!(NativeMerge::new(f.reader.clone(), f.journal.clone())
        .reject_selected_duplicate(
            &plan,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        )
        .is_err());
    assert!(!path.exists());
}
#[test]
fn duplicate_pending_fences_primary_automatic_and_selection_until_original_recovery() {
    let mut f = setup();
    let plan = selected(&f);
    f.merge = f.merge.with_observer(Arc::new(|s| {
        if s == "normal-duplicate-prepared" {
            Err(StoreError::Unavailable.into())
        } else {
            Ok(())
        }
    }));
    assert!(reject(&f, &plan).is_err());
    assert!(f
        .merge
        .select_normal(
            &parse_json("{\"text\":\"New input\"}").unwrap(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        )
        .is_err());
    let turn:TurnRecord=serde_json::from_value(json!({"agentId":"alpha","principal":f.base.principal,"agent":f.base.agent,"runId":"automatic","sessionKey":"automatic","incognito":false,"messages":[{"role":"user","content":"Synthetic automatic capture"}]})).unwrap();
    let ctx = RequestContext::build(&turn.principal, &turn.agent, f.host.as_ref()).unwrap();
    assert!(matches!(
        f.journal.record(&turn, &ctx, &Cancel::never()),
        Err(EngineError::Store(StoreError::Busy))
    ));
    f.policy.allowed.store(false, Ordering::SeqCst);
    assert!(NativeMerge::open(f.reader.clone(), f.journal.clone()).is_err());
    assert!(!log(f.base.root.path()).exists());
    f.policy.allowed.store(true, Ordering::SeqCst);
    NativeMerge::open(f.reader.clone(), f.journal.clone()).unwrap();
    f.journal.record(&turn, &ctx, &Cancel::never()).unwrap();
}
#[test]
fn concurrent_exact_retries_append_one_occurrence() {
    let f = setup();
    let plan = selected(&f);
    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for _ in 0..4 {
            let f = &f;
            let plan = &plan;
            handles.push(scope.spawn(move || reject(f, plan).unwrap()));
        }
        assert_eq!(
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
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
#[cfg(unix)]
#[test]
fn duplicate_sigkill_child() {
    let Some(root) = std::env::var_os("PLUR1BUS_DUPLICATE_TEST_ROOT") else {
        return;
    };
    let point = std::env::var("PLUR1BUS_DUPLICATE_TEST_POINT").unwrap();
    let f = insert_tests::reopen(Path::new(&root));
    let native = NativeMerge::new(f.reader, f.journal).with_observer(Arc::new(move |s| {
        if s == point {
            unsafe {
                libc::kill(libc::getpid(), libc::SIGKILL);
            }
        }
        Ok(())
    }));
    let row = f.base.store.get_record(SOURCE).unwrap().unwrap().row;
    let params =
        parse_json(&json!({"text":row.text,"category":"decision","importance":0.8}).to_string())
            .unwrap();
    let plan = native
        .select_normal(&params, &f.base.principal, &f.base.agent, &Cancel::never())
        .unwrap();
    native
        .reject_selected_duplicate(
            &plan,
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
fn actual_sigkill_duplicate_recovery_keeps_one_original_occurrence_without_providers() {
    use std::os::unix::process::ExitStatusExt;
    for point in [
        "normal-duplicate-prepared",
        "normal-duplicate-write",
        "normal-duplicate-complete",
    ] {
        let f = setup();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "duplicate_tests::duplicate_sigkill_child",
                "--nocapture",
            ])
            .env("PLUR1BUS_DUPLICATE_TEST_ROOT", f.base.root.path())
            .env("PLUR1BUS_DUPLICATE_TEST_POINT", point)
            .status()
            .unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        let p = insert_tests::reopen(f.base.root.path());
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
fn malformed_or_oversized_audit_is_preserved_without_a_duplicate_intent() {
    for oversized in [false, true] {
        let f = setup();
        let plan = selected(&f);
        let path = log(f.base.root.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        if oversized {
            std::fs::File::create(&path)
                .unwrap()
                .set_len(64 * 1024 * 1024 + 1)
                .unwrap();
        } else {
            std::fs::write(&path, b"{\"unfinished\":").unwrap();
        }
        let len = std::fs::metadata(&path).unwrap().len();
        assert!(reject(&f, &plan).is_err());
        assert_eq!(std::fs::metadata(&path).unwrap().len(), len);
    }
}
#[cfg(unix)]
#[test]
fn linked_logs_and_replaced_directory_never_write_through_an_external_target() {
    for mode in ["symlink", "hardlink", "directory"] {
        let mut f = setup();
        let plan = selected(&f);
        let path = log(f.base.root.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let outside = f.base.root.path().join("outside.jsonl");
        std::fs::write(&outside, b"{}\n").unwrap();
        match mode {
            "symlink" => std::os::unix::fs::symlink(&outside, &path).unwrap(),
            "hardlink" => std::fs::hard_link(&outside, &path).unwrap(),
            _ => {
                f.merge = f.merge.with_observer(Arc::new(|s| {
                    if s == "normal-duplicate-prepared" {
                        Err(StoreError::Unavailable.into())
                    } else {
                        Ok(())
                    }
                }));
                assert!(reject(&f, &plan).is_err());
                std::fs::rename(
                    path.parent().unwrap(),
                    f.base.root.path().join("old-log-dir"),
                )
                .unwrap();
                std::fs::create_dir(path.parent().unwrap()).unwrap();
            }
        }
        assert!(reject(&f, &plan).is_err(), "{mode}");
        assert_eq!(std::fs::read(&outside).unwrap(), b"{}\n");
    }
}
fn receipt(root: &Path) -> PathBuf {
    let workspaces = root.join("neo/workspaces");
    for dir in std::fs::read_dir(workspaces).unwrap() {
        for file in std::fs::read_dir(dir.unwrap().path()).unwrap() {
            let file = file.unwrap();
            if file
                .file_name()
                .to_string_lossy()
                .starts_with("native-normal-duplicate-")
            {
                return file.path();
            }
        }
    }
    panic!("receipt absent");
}
#[test]
fn corrupt_or_oversized_pending_receipt_never_recreates_an_audit() {
    for oversized in [false, true] {
        let mut f = setup();
        let plan = selected(&f);
        f.merge = f.merge.with_observer(Arc::new(|s| {
            if s == "normal-duplicate-prepared" {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(reject(&f, &plan).is_err());
        let path = receipt(f.base.root.path());
        if oversized {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_len(8 * 1024 * 1024 + 1)
                .unwrap();
        } else {
            std::fs::write(path, b"{}").unwrap();
        }
        assert!(NativeMerge::open(f.reader.clone(), f.journal.clone()).is_err());
        assert!(!log(f.base.root.path()).exists());
    }
}
