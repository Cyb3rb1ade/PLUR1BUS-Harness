//! Knowledge staging after a normal merge uses original input quality and the final merged importance.
use super::*;
const SOURCE2: &str = "00000000-0000-4000-8000-000000000002";
fn queue(root: &Path) -> PathBuf {
    root.join("workspace/.adaptive-learning/knowledge-pending.json")
}
fn merge(
    f: &Fixture,
    category: &str,
) -> Result<Option<plur1bus_engine::ops::durable_merge::MergeResult>, EngineError> {
    f.merge.merge_normal(SOURCE,&parse_json(&json!({"text":"A synthetic decision","category":category,"importance":0.8,"ttl":"session"}).to_string()).unwrap(),&f.base.principal,&f.base.agent,&Cancel::never())
}
#[test]
fn eligible_merged_result_stages_once_without_replaying_providers() {
    let f = setup();
    let result = merge(&f, "decision").unwrap().unwrap();
    let state: Value =
        serde_json::from_slice(&std::fs::read(queue(f.base.root.path())).unwrap()).unwrap();
    assert_eq!(state["pendingCount"], 1);
    assert_eq!(state["pending"][0]["memoryId"], result.replacement_id);
    assert_eq!(state["pending"][0]["importance"], 0.8);
    assert_eq!(state["pending"][0]["category"], "decision");
    let before = std::fs::read(queue(f.base.root.path())).unwrap();
    let req = merge_curation_tests::request(f.base.root.path());
    assert!(
        f.merge
            .apply(&req, &f.base.principal, &f.base.agent, &Cancel::never())
            .unwrap()
            .replayed
    );
    assert_eq!(std::fs::read(queue(f.base.root.path())).unwrap(), before);
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
}
#[test]
fn nonpromotable_original_category_records_an_explicit_skip() {
    let f = setup();
    merge(&f, "preference").unwrap().unwrap();
    assert!(!queue(f.base.root.path()).exists());
    let r: Value = serde_json::from_slice(
        &std::fs::read(merge_curation_tests::receipt(f.base.root.path())).unwrap(),
    )
    .unwrap();
    assert_eq!(r["knowledge"]["stage"], 3);
    assert_eq!(r["knowledge"]["staged"], false);
}
fn log(root: &Path) -> PathBuf {
    queue(root).with_file_name("curation-log.jsonl")
}
fn replay(f: &Fixture) -> Result<plur1bus_engine::ops::durable_merge::MergeResult, EngineError> {
    f.merge.apply(
        &merge_curation_tests::request(f.base.root.path()),
        &f.base.principal,
        &f.base.agent,
        &Cancel::never(),
    )
}
fn full(f: &Fixture, own: bool, priority: f64) -> String {
    let mut pending: Vec<_> = (0..if own {199} else {200}).map(|i| json!({"sourceAgent":"beta","memoryId":format!("foreign-{i}"),"importance":priority})).collect();
    if own {
        pending.push(json!({"sourceAgent":"alpha","memoryId":SOURCE2,"importance":0.1}));
    }
    let state = plur1bus_engine::capture::knowledge_pending::normalize(
        &parse_json(&json!({"pending":pending}).to_string()).unwrap(),
        1735689600000,
        &Cancel::never(),
    )
    .unwrap();
    let bytes =
        plur1bus_engine::capture::knowledge_pending::encode(&state, &Cancel::never()).unwrap();
    std::fs::create_dir_all(queue(f.base.root.path()).parent().unwrap()).unwrap();
    std::fs::write(queue(f.base.root.path()), &bytes).unwrap();
    bytes
}
#[test]
fn final_source_importance_can_promote_eligible_original_input() {
    let f = setup();
    f.base
        .store
        .patch(
            SOURCE,
            &RowPatch {
                importance: Some(0.9),
                ..Default::default()
            },
        )
        .unwrap();
    let result = f.merge.merge_normal(SOURCE,&parse_json(r#"{"text":"A synthetic decision","category":"decision","importance":0.4,"ttl":"session"}"#).unwrap(),&f.base.principal,&f.base.agent,&Cancel::never()).unwrap().unwrap();
    let state: Value =
        serde_json::from_slice(&std::fs::read(queue(f.base.root.path())).unwrap()).unwrap();
    assert_eq!(state["pending"][0]["importance"], 0.9);
    assert_eq!(state["pending"][0]["memoryId"], result.replacement_id);
}
#[test]
fn completed_merged_staging_never_resurrects_consumed_work() {
    let f = setup();
    merge(&f, "decision").unwrap().unwrap();
    std::fs::remove_file(queue(f.base.root.path())).unwrap();
    assert!(replay(&f).unwrap().replayed);
    NativeMerge::open(f.reader.clone(), f.journal.clone()).unwrap();
    assert!(!queue(f.base.root.path()).exists());
}
#[test]
fn legacy_version_one_origin_remains_curation_only() {
    use sha2::{Digest, Sha256};
    let f = setup();
    merge(&f, "decision").unwrap().unwrap();
    let path = merge_curation_tests::receipt(f.base.root.path());
    let mut value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    value["plan"]["normal_origin"]["version"] = json!(1);
    value.as_object_mut().unwrap().remove("knowledge");
    value["fingerprint"] = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&value["plan"]).unwrap())
    )
    .into();
    std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    std::fs::remove_file(queue(f.base.root.path())).unwrap();
    assert!(replay(&f).unwrap().replayed);
    NativeMerge::open(f.reader.clone(), f.journal.clone()).unwrap();
    assert!(!queue(f.base.root.path()).exists());
}
#[test]
fn merged_capacity_eviction_preserves_foreign_entries_and_requires_own_victim() {
    for own in [true, false] {
        let f = setup();
        let before = full(&f, own, if own { 1.0 } else { 0.1 });
        let result = merge(&f, "decision");
        if own {
            let id = result.unwrap().unwrap().replacement_id;
            let state: Value =
                serde_json::from_slice(&std::fs::read(queue(f.base.root.path())).unwrap()).unwrap();
            let old: Value = serde_json::from_str(&before).unwrap();
            assert_eq!(
                &state["pending"].as_array().unwrap()[..199],
                &old["pending"].as_array().unwrap()[..199]
            );
            assert_eq!(state["pending"][199]["memoryId"], id);
            assert!(f.base.store.get_record(SOURCE2).unwrap().is_some());
            assert!(replay(&f).unwrap().replayed);
            let events = std::fs::read_to_string(log(f.base.root.path())).unwrap();
            assert_eq!(events.lines().count(), 2);
            std::fs::write(
                log(f.base.root.path()),
                format!("{}\n", events.lines().next().unwrap()),
            )
            .unwrap();
            assert!(replay(&f).is_err());
            assert_eq!(
                std::fs::read_to_string(log(f.base.root.path()))
                    .unwrap()
                    .lines()
                    .count(),
                1
            );
        } else {
            assert!(result.is_err());
            assert_eq!(
                std::fs::read_to_string(queue(f.base.root.path())).unwrap(),
                before
            );
        }
    }
}
#[test]
fn merged_knowledge_pending_fences_other_writers_and_rechecks_all_primary_evidence() {
    for mode in [
        "policy",
        "config",
        "replacement",
        "archive",
        "destructive-audit",
        "curation",
    ] {
        let mut f = setup();
        f.merge = f.merge.with_observer(Arc::new(|s| {
            if s == "normal-merge-knowledge-prepared" {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(merge(&f, "decision").is_err());
        assert!(!queue(f.base.root.path()).exists());
        assert!(matches!(
            f.merge.select_normal(
                &parse_json(r#"{"text":"Another synthetic input"}"#).unwrap(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never()
            ),
            Err(EngineError::Store(StoreError::Busy))
        ));
        let req = merge_curation_tests::request(f.base.root.path());
        match mode {
            "policy" => f.policy.allowed.store(false, Ordering::SeqCst),
            "config" => f.host.config.lock().unwrap()["summaryMaxWords"] = json!(10),
            "replacement" => f
                .base
                .store
                .patch(
                    &req.replacement.id,
                    &RowPatch {
                        text: Some("changed".into()),
                        ..Default::default()
                    },
                )
                .unwrap(),
            "archive" => {
                let event: Value = serde_json::from_str(
                    std::fs::read_to_string(
                        log(f.base.root.path()).with_file_name("destructive-ops.jsonl"),
                    )
                    .unwrap()
                    .trim(),
                )
                .unwrap();
                std::fs::remove_file(event["archivePath"].as_str().unwrap()).unwrap();
            }
            "destructive-audit" => std::fs::remove_file(
                log(f.base.root.path()).with_file_name("destructive-ops.jsonl"),
            )
            .unwrap(),
            _ => std::fs::remove_file(log(f.base.root.path())).unwrap(),
        }
        assert!(
            NativeMerge::open(f.reader.clone(), f.journal.clone()).is_err(),
            "{mode}"
        );
        assert!(!queue(f.base.root.path()).exists());
        assert_eq!(f.host.calls.load(Ordering::SeqCst), 1);
        assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
    }
}
#[cfg(unix)]
#[test]
fn merged_knowledge_sigkill_child() {
    let Some(root) = std::env::var_os("PLUR1BUS_MERGED_KNOWLEDGE_TEST_ROOT") else {
        return;
    };
    let point = std::env::var("PLUR1BUS_MERGED_KNOWLEDGE_TEST_POINT").unwrap();
    let f = insert_tests::reopen(Path::new(&root));
    *f.host.answer.lock().unwrap()=Ok(r#"{"merge":true,"reason":"fixture","mergedText":"A synthetic decision with additional context"}"#.into());
    let native = NativeMerge::new(f.reader, f.journal).with_observer(Arc::new(move |s| {
        if s == point {
            unsafe {
                libc::kill(libc::getpid(), libc::SIGKILL);
            }
        }
        Ok(())
    }));
    native.merge_normal(SOURCE,&parse_json(r#"{"text":"A synthetic decision","category":"decision","importance":0.8,"ttl":"session"}"#).unwrap(),&f.base.principal,&f.base.agent,&Cancel::never()).unwrap();
    panic!("kill boundary not reached");
}
#[cfg(unix)]
#[test]
fn actual_sigkill_merged_knowledge_recovers_original_phase_time_without_providers() {
    use std::{
        os::unix::process::ExitStatusExt,
        time::{Duration, SystemTime},
    };
    for point in [
        "normal-merge-curation-complete",
        "normal-merge-knowledge-prepared",
        "normal-merge-knowledge-write",
        "normal-merge-knowledge-audit-write",
        "normal-merge-knowledge-complete",
    ] {
        let f = setup();
        full(&f, true, 1.0);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                std::any::type_name_of_val(&merged_knowledge_sigkill_child)
                    .split_once("::")
                    .map_or("", |(_, name)| name),
                "--nocapture",
            ])
            .env("PLUR1BUS_MERGED_KNOWLEDGE_TEST_ROOT", f.base.root.path())
            .env("PLUR1BUS_MERGED_KNOWLEDGE_TEST_POINT", point)
            .status()
            .unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        let p = insert_tests::reopen(f.base.root.path());
        p.host.inner.time.store(1735689610000, Ordering::SeqCst);
        if point != "normal-merge-curation-complete" && point != "normal-merge-knowledge-complete" {
            assert!(NativeMerge::open(p.reader.clone(), p.journal.clone()).is_err());
            // Test-only clock seam: the production Node file-lock lease remains sixty seconds.
            std::fs::File::options()
                .write(true)
                .open(queue(f.base.root.path()).with_file_name("knowledge-pending.lock"))
                .unwrap()
                .set_times(
                    std::fs::FileTimes::new()
                        .set_modified(SystemTime::now() - Duration::from_secs(61)),
                )
                .unwrap();
        }
        let native = NativeMerge::open(p.reader.clone(), p.journal.clone()).unwrap();
        assert!(
            native
                .apply(
                    &merge_curation_tests::request(f.base.root.path()),
                    &p.base.principal,
                    &p.base.agent,
                    &Cancel::never()
                )
                .unwrap()
                .replayed
        );
        NativeMerge::open(p.reader, p.journal).unwrap();
        let state: Value =
            serde_json::from_slice(&std::fs::read(queue(f.base.root.path())).unwrap()).unwrap();
        assert_eq!(state["pendingCount"], 200);
        assert_eq!(
            state["pending"][199]["queuedAt"],
            if point == "normal-merge-curation-complete" {
                "2025-01-01T00:00:10.000Z"
            } else {
                "2025-01-01T00:00:00.000Z"
            }
        );
        assert_eq!(
            std::fs::read_to_string(log(f.base.root.path()))
                .unwrap()
                .lines()
                .count(),
            2
        );
        assert_eq!(p.host.calls.load(Ordering::SeqCst), 0);
        assert_eq!(p.embed.calls.load(Ordering::SeqCst), 0);
    }
}
