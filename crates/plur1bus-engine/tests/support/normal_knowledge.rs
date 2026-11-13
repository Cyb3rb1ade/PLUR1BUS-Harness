//! Actual knowledge staging must originate from an acknowledged ordinary primary and curation.
use super::*;
fn stored(importance: f64) -> Fixture {
    let f = fixture();
    let params=parse_json(&json!({"text":"A synthetic decision","category":"decision","importance":importance,"ttl":"session"}).to_string()).unwrap();
    let plan = f
        .merge
        .select_normal(&params, &f.base.principal, &f.base.agent, &Cancel::never())
        .unwrap();
    f.merge
        .store_selected(
            &plan,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    f.merge
        .publish_store_curation(
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    f
}
fn queue(root: &Path) -> PathBuf {
    root.join("workspace/.adaptive-learning/knowledge-pending.json")
}
#[test]
fn eligible_ordinary_store_stages_once_with_original_publication_time() {
    let f = stored(0.8);
    f.host.inner.time.store(1735689602000, Ordering::SeqCst);
    for replay in [false, true] {
        let result = f
            .merge
            .publish_store_knowledge(
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never(),
            )
            .unwrap();
        assert_eq!(result.memory_id, operation().to_string());
        assert!(result.staged);
        assert_eq!(result.replayed, replay);
        f.host.inner.time.store(1735689620000, Ordering::SeqCst);
    }
    let state: Value =
        serde_json::from_slice(&std::fs::read(queue(f.base.root.path())).unwrap()).unwrap();
    assert_eq!(state["pendingCount"], 1);
    assert_eq!(state["pending"][0]["key"], format!("alpha:{}", operation()));
    assert_eq!(state["pending"][0]["importance"], 0.8);
    assert_eq!(state["pending"][0]["queuedAt"], "2025-01-01T00:00:02.000Z");
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
}
#[test]
fn ineligible_primary_has_a_durable_skip_without_creating_a_queue_or_job() {
    let f = stored(0.5);
    for replay in [false, true] {
        let result = f
            .merge
            .publish_store_knowledge(
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never(),
            )
            .unwrap();
        assert!(!result.staged);
        assert_eq!(result.replayed, replay);
    }
    assert!(!queue(f.base.root.path()).exists());
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
}
#[test]
fn interrupted_queue_publication_recovers_original_caller_and_timestamp() {
    for point in [
        "normal-knowledge-prepared",
        "normal-knowledge-write",
        "normal-knowledge-complete",
    ] {
        let mut f = stored(0.8);
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
            .publish_store_knowledge(
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never()
            )
            .is_err());
        f.host.inner.time.store(1735689610000, Ordering::SeqCst);
        NativeMerge::open(f.reader.clone(), f.journal.clone()).unwrap();
        let result = f
            .merge
            .publish_store_knowledge(
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never(),
            )
            .unwrap();
        assert!(result.replayed && result.staged);
        let state: Value =
            serde_json::from_slice(&std::fs::read(queue(f.base.root.path())).unwrap()).unwrap();
        assert_eq!(state["pendingCount"], 1);
        assert_eq!(state["pending"][0]["queuedAt"], "2025-01-01T00:00:00.000Z");
        assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
    }
}
#[test]
fn foreign_capacity_eviction_and_unknown_legacy_loss_are_not_authorized_by_the_node_projection() {
    for legacy in [false, true] {
        let f = stored(0.9);
        let raw = if legacy {
            json!({"pendingMemoryIds":["unknown-legacy"]})
        } else {
            json!({"pending":(0..200).map(|i|json!({"sourceAgent":"beta","memoryId":format!("foreign-{i}"),"importance":0.7})).collect::<Vec<_>>()})
        };
        let raw = parse_json(&raw.to_string()).unwrap();
        let bytes = if legacy {
            plur1bus_engine::text::json::write_json(&raw)
        } else {
            let state = plur1bus_engine::capture::knowledge_pending::normalize(
                &raw,
                1735689600000,
                &Cancel::never(),
            )
            .unwrap();
            plur1bus_engine::capture::knowledge_pending::encode(&state, &Cancel::never()).unwrap()
        };
        std::fs::write(queue(f.base.root.path()), &bytes).unwrap();
        assert!(f
            .merge
            .publish_store_knowledge(
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never()
            )
            .is_err());
        assert_eq!(
            std::fs::read_to_string(queue(f.base.root.path())).unwrap(),
            bytes
        );
    }
}

#[test]
fn a_completed_staging_receipt_does_not_requeue_consumed_work() {
    for removed_file in [false, true] {
        let f = stored(0.8);
        assert!(
            f.merge
                .publish_store_knowledge(
                    operation(),
                    &f.base.principal,
                    &f.base.agent,
                    &Cancel::never()
                )
                .unwrap()
                .staged
        );
        let path = queue(f.base.root.path());
        let consumed="{\"schema\":2,\"pending\":[],\"pendingCount\":0,\"pendingOverflowCount\":0,\"lastStoreAt\":null,\"lastUpdateAt\":\"2025-01-01T00:01:00.000Z\"}";
        if removed_file {
            std::fs::remove_file(&path).unwrap();
        } else {
            std::fs::write(&path, consumed).unwrap();
        }
        let result = f
            .merge
            .publish_store_knowledge(
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never(),
            )
            .unwrap();
        assert!(result.replayed && result.staged);
        if removed_file {
            assert!(!path.exists());
        } else {
            assert_eq!(std::fs::read_to_string(path).unwrap(), consumed);
        }
    }
}

fn publish(
    f: &Fixture,
) -> Result<plur1bus_engine::ops::durable_merge::StoreKnowledgeResult, EngineError> {
    f.merge.publish_store_knowledge(
        operation(),
        &f.base.principal,
        &f.base.agent,
        &Cancel::never(),
    )
}
fn log(root: &Path) -> PathBuf {
    root.join("workspace/.adaptive-learning/curation-log.jsonl")
}
fn write_queue(f: &Fixture, pending: &[Value]) -> String {
    let raw = parse_json(&json!({"pending":pending}).to_string()).unwrap();
    let state = plur1bus_engine::capture::knowledge_pending::normalize(
        &raw,
        1735689600000,
        &Cancel::never(),
    )
    .unwrap();
    let bytes =
        plur1bus_engine::capture::knowledge_pending::encode(&state, &Cancel::never()).unwrap();
    std::fs::write(queue(f.base.root.path()), &bytes).unwrap();
    bytes
}
fn full(f: &Fixture, own_victim: bool) -> String {
    let mut pending: Vec<_> = (0..if own_victim { 199 } else { 200 })
        .map(|i| json!({"sourceAgent":"beta","memoryId":format!("foreign-{i}"),"importance":1}))
        .collect();
    if own_victim {
        let mut row = f
            .base
            .store
            .get_record(&operation().to_string())
            .unwrap()
            .unwrap()
            .row;
        row.id = SOURCE.into();
        f.base.store.upsert(&[row]).unwrap();
        pending.push(json!({"sourceAgent":"alpha","memoryId":SOURCE,"importance":0.1}));
    }
    write_queue(f, &pending)
}
#[test]
fn retained_foreign_entries_survive_and_only_an_owned_capacity_victim_can_be_removed() {
    let f = stored(0.9);
    let before = full(&f, true);
    assert!(publish(&f).unwrap().staged);
    let old: Value = serde_json::from_str(&before).unwrap();
    let new: Value =
        serde_json::from_slice(&std::fs::read(queue(f.base.root.path())).unwrap()).unwrap();
    assert_eq!(new["pendingCount"], 200);
    assert_eq!(
        &new["pending"].as_array().unwrap()[..199],
        &old["pending"].as_array().unwrap()[..199]
    );
    assert_eq!(new["pending"][199]["memoryId"], operation().to_string());
    assert!(f.base.store.get_record(SOURCE).unwrap().is_some());
    assert_eq!(
        std::fs::read_to_string(log(f.base.root.path()))
            .unwrap()
            .lines()
            .count(),
        2
    );
}
#[test]
fn capacity_dropped_proposal_is_explicitly_not_staged_and_audited_once() {
    let f = stored(0.8);
    let before = full(&f, false);
    for replay in [false, true] {
        let result = publish(&f).unwrap();
        assert_eq!(result.replayed, replay);
        assert!(!result.staged);
    }
    let old: Value = serde_json::from_str(&before).unwrap();
    let new: Value =
        serde_json::from_slice(&std::fs::read(queue(f.base.root.path())).unwrap()).unwrap();
    assert_eq!(old["pending"], new["pending"]);
    let lines = std::fs::read_to_string(log(f.base.root.path())).unwrap();
    assert_eq!(lines.lines().count(), 2);
    let event: Value = serde_json::from_str(lines.lines().nth(1).unwrap()).unwrap();
    assert_eq!(event["event"], "knowledge_pending.overflow");
    assert_eq!(event["reason"], "pending_cap:200, overflow:1");
}
#[test]
fn overflow_audit_recovers_once_at_each_boundary_and_completed_evidence_is_required() {
    for point in [
        "normal-knowledge-prepared",
        "normal-knowledge-write",
        "normal-knowledge-audit-write",
        "normal-knowledge-audited",
        "normal-knowledge-complete",
    ] {
        let mut f = stored(0.9);
        full(&f, true);
        let hit = Arc::new(AtomicBool::new(true));
        let signal = hit.clone();
        f.merge = f.merge.with_observer(Arc::new(move |s| {
            if s == point && signal.swap(false, Ordering::SeqCst) {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(publish(&f).is_err());
        NativeMerge::open(f.reader.clone(), f.journal.clone()).unwrap();
        assert!(publish(&f).unwrap().staged);
        let lines = std::fs::read_to_string(log(f.base.root.path())).unwrap();
        assert_eq!(lines.lines().count(), 2);
        std::fs::write(
            log(f.base.root.path()),
            format!("{}\n", lines.lines().next().unwrap()),
        )
        .unwrap();
        assert!(publish(&f).is_err());
        assert_eq!(
            std::fs::read_to_string(log(f.base.root.path()))
                .unwrap()
                .lines()
                .count(),
            1
        );
    }
}
#[test]
fn knowledge_checks_original_caller_primary_curation_and_current_policy_before_publication() {
    for mode in [
        "absent",
        "primary-only",
        "changed",
        "deleted",
        "policy",
        "config",
        "curation-lost",
        "other-chat",
    ] {
        let f = if mode == "absent" {
            fixture()
        } else {
            stored(0.8)
        };
        let mut principal = serde_json::to_value(&f.base.principal).unwrap();
        match mode {
            "primary-only" => {
                let path = receipt(f.base.root.path());
                let mut r: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                r.as_object_mut().unwrap().remove("curation");
                std::fs::write(path, serde_json::to_vec(&r).unwrap()).unwrap();
            }
            "changed" => f
                .base
                .store
                .patch(
                    &operation().to_string(),
                    &RowPatch {
                        text: Some("Changed row".into()),
                        ..Default::default()
                    },
                )
                .unwrap(),
            "deleted" => {
                f.base.store.delete(&[&operation().to_string()]).unwrap();
            }
            "policy" => f.policy.allowed.store(false, Ordering::SeqCst),
            "config" => f.host.config.lock().unwrap()["schicht15"] = json!({"minImportance":0.9}),
            "curation-lost" => std::fs::remove_file(log(f.base.root.path())).unwrap(),
            "other-chat" => principal["chat"]["id"] = "different-chat".into(),
            _ => (),
        }
        let p: Principal = serde_json::from_value(principal).unwrap();
        assert!(
            f.merge
                .publish_store_knowledge(operation(), &p, &f.base.agent, &Cancel::never())
                .is_err(),
            "{mode}"
        );
        assert!(!queue(f.base.root.path()).exists(), "{mode}");
    }
}
#[test]
fn pending_queue_drift_and_capacity_source_changes_are_never_overwritten() {
    for mode in ["queue", "source", "policy", "config"] {
        let mut f = stored(0.9);
        full(&f, true);
        f.merge = f.merge.with_observer(Arc::new(|s| {
            if s == "normal-knowledge-prepared" {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(publish(&f).is_err());
        match mode {
            "queue" => {
                std::fs::write(queue(f.base.root.path()), "{\"changed\":true}").unwrap();
            }
            "source" => f
                .base
                .store
                .patch(
                    SOURCE,
                    &RowPatch {
                        text: Some("Changed source".into()),
                        ..Default::default()
                    },
                )
                .unwrap(),
            "policy" => f.policy.allowed.store(false, Ordering::SeqCst),
            "config" => f.host.config.lock().unwrap()["summaryMaxWords"] = json!(10),
            _ => (),
        }
        let bytes = std::fs::read(queue(f.base.root.path())).unwrap();
        assert!(
            NativeMerge::open(f.reader.clone(), f.journal.clone()).is_err(),
            "{mode}"
        );
        assert_eq!(std::fs::read(queue(f.base.root.path())).unwrap(), bytes);
        assert_eq!(
            std::fs::read_to_string(log(f.base.root.path()))
                .unwrap()
                .lines()
                .count(),
            1
        );
    }
}
#[test]
fn node_registry_lock_is_respected_and_replacement_prevents_queue_write() {
    use plur1bus_engine::store::lock::Lock;
    use std::time::Duration;
    let mut f = stored(0.8);
    let path = queue(f.base.root.path()).with_file_name("knowledge-pending.lock");
    let guard = Lock::try_acquire(&path, Duration::from_secs(60), None)
        .unwrap()
        .unwrap();
    assert!(publish(&f).is_err());
    assert!(guard.is_owned());
    assert!(!queue(f.base.root.path()).exists());
    drop(guard);
    let replaced = path.clone();
    f.merge = f.merge.with_observer(Arc::new(move |s| {
        if s == "normal-knowledge-prepared" {
            std::fs::remove_file(&replaced).unwrap();
            std::fs::write(&replaced, "{\"foreign\":true}").unwrap();
        }
        Ok(())
    }));
    assert!(publish(&f).is_err());
    assert!(!queue(f.base.root.path()).exists());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "{\"foreign\":true}");
}
#[test]
fn ordinary_curation_loss_during_knowledge_admission_prevents_queue_publication() {
    let mut f = stored(0.8);
    let path = log(f.base.root.path());
    f.merge = f.merge.with_observer(Arc::new(move |s| {
        if s == "normal-knowledge-prepared" {
            std::fs::remove_file(&path).unwrap();
        }
        Ok(())
    }));
    assert!(publish(&f).is_err());
    assert!(!queue(f.base.root.path()).exists());
}

#[test]
fn queue_schema_bounds_and_unknown_metadata_fail_closed_without_losing_bytes() {
    for mode in [
        "torn",
        "oversize",
        "root-extra",
        "entry-extra",
        "duplicate-property",
        "duplicate-entry",
    ] {
        let f = stored(0.8);
        let canonical = write_queue(
            &f,
            &[json!({"sourceAgent":"beta","memoryId":"foreign","importance":1})],
        );
        let path = queue(f.base.root.path());
        let mut value: Value = serde_json::from_str(&canonical).unwrap();
        match mode {
            "torn" => std::fs::write(&path, b"{\"unfinished\":").unwrap(),
            "oversize" => std::fs::File::create(&path)
                .unwrap()
                .set_len(2 * 1024 * 1024 + 1)
                .unwrap(),
            "root-extra" => {
                value["unknown"] = json!(true);
                std::fs::write(&path, value.to_string()).unwrap();
            }
            "entry-extra" => {
                value["pending"][0]["unknown"] = json!(true);
                std::fs::write(&path, value.to_string()).unwrap();
            }
            "duplicate-property" => std::fs::write(
                &path,
                canonical.replacen("\"schema\": 2", "\"schema\": 2, \"schema\": 2", 1),
            )
            .unwrap(),
            _ => {
                let entry = value["pending"][0].clone();
                value["pending"].as_array_mut().unwrap().push(entry);
                value["pendingCount"] = json!(2);
                std::fs::write(&path, value.to_string()).unwrap();
            }
        }
        let bytes = std::fs::read(&path).unwrap();
        assert!(publish(&f).is_err(), "{mode}");
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let r: Value =
            serde_json::from_slice(&std::fs::read(receipt(f.base.root.path())).unwrap()).unwrap();
        assert!(r.get("knowledge").is_none());
    }
}
#[cfg(unix)]
#[test]
fn queue_links_and_replaced_held_directory_are_refused() {
    for mode in ["symlink", "hardlink", "directory"] {
        let mut f = stored(0.8);
        let path = queue(f.base.root.path());
        let outside = f.base.root.path().join("outside.json");
        std::fs::write(&outside, b"{}\n").unwrap();
        match mode {
            "symlink" => std::os::unix::fs::symlink(&outside, &path).unwrap(),
            "hardlink" => std::fs::hard_link(&outside, &path).unwrap(),
            _ => {
                f.merge = f.merge.with_observer(Arc::new(|s| {
                    if s == "normal-knowledge-prepared" {
                        Err(StoreError::Unavailable.into())
                    } else {
                        Ok(())
                    }
                }));
                assert!(publish(&f).is_err());
                let dir = path.parent().unwrap();
                std::fs::rename(dir, f.base.root.path().join("old-adaptive")).unwrap();
                std::fs::create_dir(dir).unwrap();
            }
        }
        assert!(publish(&f).is_err(), "{mode}");
        assert_eq!(std::fs::read(&outside).unwrap(), b"{}\n");
    }
}
#[test]
fn pending_knowledge_fences_other_writers_and_recovers_after_policy_restoration() {
    let mut f = stored(0.8);
    let policy = f.policy.clone();
    f.merge = f.merge.with_observer(Arc::new(move |s| {
        if s == "normal-knowledge-prepared" {
            policy.allowed.store(false, Ordering::SeqCst);
        }
        Ok(())
    }));
    assert!(publish(&f).is_err());
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
}
#[test]
fn four_concurrent_retries_stage_once() {
    let f = stored(0.8);
    std::thread::scope(|scope| {
        let joins: Vec<_> = (0..4)
            .map(|_| {
                let f = &f;
                scope.spawn(move || publish(f).unwrap())
            })
            .collect();
        assert_eq!(
            joins
                .into_iter()
                .map(|j| j.join().unwrap())
                .filter(|r| !r.replayed)
                .count(),
            1
        );
    });
    let state: Value =
        serde_json::from_slice(&std::fs::read(queue(f.base.root.path())).unwrap()).unwrap();
    assert_eq!(state["pendingCount"], 1);
}
#[cfg(unix)]
#[test]
fn knowledge_sigkill_child() {
    let Some(root) = std::env::var_os("PLUR1BUS_KNOWLEDGE_TEST_ROOT") else {
        return;
    };
    let point = std::env::var("PLUR1BUS_KNOWLEDGE_TEST_POINT").unwrap();
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
        .publish_store_knowledge(
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
fn actual_sigkill_knowledge_recovers_after_the_node_stale_lock_threshold_without_providers() {
    use std::{
        os::unix::process::ExitStatusExt,
        time::{Duration, SystemTime},
    };
    for point in [
        "normal-knowledge-prepared",
        "normal-knowledge-write",
        "normal-knowledge-audit-write",
        "normal-knowledge-audited",
        "normal-knowledge-complete",
    ] {
        let f = stored(0.9);
        full(&f, true);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                std::any::type_name_of_val(&knowledge_sigkill_child)
                    .split_once("::")
                    .map_or("", |(_, name)| name),
                "--nocapture",
            ])
            .env("PLUR1BUS_KNOWLEDGE_TEST_ROOT", f.base.root.path())
            .env("PLUR1BUS_KNOWLEDGE_TEST_POINT", point)
            .status()
            .unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        let p = reopen(f.base.root.path());
        p.host.inner.time.store(1735689610000, Ordering::SeqCst);
        if point != "normal-knowledge-complete" {
            assert!(NativeMerge::open(p.reader.clone(), p.journal.clone()).is_err());
            // Explicit test clock seam: the actual pinned file-lock protocol refuses a fresh dead owner.
            let path = queue(f.base.root.path()).with_file_name("knowledge-pending.lock");
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(
                    std::fs::FileTimes::new()
                        .set_modified(SystemTime::now() - Duration::from_secs(61)),
                )
                .unwrap();
        }
        let native = NativeMerge::open(p.reader.clone(), p.journal.clone()).unwrap();
        let result = native
            .publish_store_knowledge(
                operation(),
                &p.base.principal,
                &p.base.agent,
                &Cancel::never(),
            )
            .unwrap();
        assert!(result.replayed && result.staged);
        NativeMerge::open(p.reader, p.journal).unwrap();
        let state: Value =
            serde_json::from_slice(&std::fs::read(queue(f.base.root.path())).unwrap()).unwrap();
        assert_eq!(
            state["pending"][199]["queuedAt"],
            "2025-01-01T00:00:00.000Z"
        );
        assert_eq!(
            std::fs::read_to_string(log(f.base.root.path()))
                .unwrap()
                .lines()
                .count(),
            2
        );
        assert_eq!(p.embed.calls.load(Ordering::SeqCst), 0);
        assert_eq!(p.host.calls.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn completed_acknowledgement_requires_overflow_evidence_even_if_deleted_at_the_last_boundary() {
    let mut f = stored(0.9);
    full(&f, true);
    let path = log(f.base.root.path());
    f.merge = f.merge.with_observer(Arc::new(move |s| {
        if s == "normal-knowledge-complete" {
            let bytes = std::fs::read_to_string(&path).unwrap();
            std::fs::write(&path, format!("{}\n", bytes.lines().next().unwrap())).unwrap();
        }
        Ok(())
    }));
    assert!(publish(&f).is_err());
    assert_eq!(
        std::fs::read_to_string(log(f.base.root.path()))
            .unwrap()
            .lines()
            .count(),
        1
    );
}
#[test]
fn completed_consumed_receipt_needs_no_queue_lock_but_still_rechecks_original_authority() {
    use plur1bus_engine::store::lock::Lock;
    use std::time::Duration;
    let f = stored(0.8);
    publish(&f).unwrap();
    std::fs::remove_file(queue(f.base.root.path())).unwrap();
    let guard = Lock::try_acquire(
        &queue(f.base.root.path()).with_file_name("knowledge-pending.lock"),
        Duration::from_secs(60),
        None,
    )
    .unwrap()
    .unwrap();
    assert!(publish(&f).unwrap().replayed);
    assert!(guard.is_owned());
    assert!(!queue(f.base.root.path()).exists());
    f.policy.allowed.store(false, Ordering::SeqCst);
    assert!(publish(&f).is_err());
    assert!(!queue(f.base.root.path()).exists());
}
#[test]
fn same_agent_queue_label_cannot_authorize_eviction_of_another_owners_memory() {
    let f = stored(0.9);
    let before = full(&f, true);
    let mut row = f.base.store.get_record(SOURCE).unwrap().unwrap().row;
    row.owner_user_id = "another-owner".into();
    f.base.store.upsert(&[row]).unwrap();
    assert!(publish(&f).is_err());
    assert_eq!(
        std::fs::read_to_string(queue(f.base.root.path())).unwrap(),
        before
    );
    assert_eq!(
        std::fs::read_to_string(log(f.base.root.path()))
            .unwrap()
            .lines()
            .count(),
        1
    );
}
