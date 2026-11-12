//! The publication obligation exists before primary persistence, including the gaps between children.
use super::*;
fn input(importance: f64) -> plur1bus_engine::text::json::TolerantJsonValue {
    parse_json(&json!({"text":"A synthetic decision","category":"decision","importance":importance,"ttl":"session"}).to_string()).unwrap()
}
fn log(root: &Path) -> PathBuf {
    root.join("workspace/.adaptive-learning/curation-log.jsonl")
}
fn queue(root: &Path) -> PathBuf {
    root.join("workspace/.adaptive-learning/knowledge-pending.json")
}
#[test]
fn one_call_persists_primary_curation_and_explicit_knowledge_outcome() {
    for importance in [0.5, 0.8] {
        let f = fixture();
        let params = input(importance);
        let plan = f
            .merge
            .select_normal(&params, &f.base.principal, &f.base.agent, &Cancel::never())
            .unwrap();
        for replayed in [false, true] {
            let result = f
                .merge
                .store_selected_with_publication(
                    &plan,
                    operation(),
                    &f.base.principal,
                    &f.base.agent,
                    &Cancel::never(),
                )
                .unwrap();
            assert_eq!(result.memory_id, operation().to_string());
            assert_eq!(result.replayed, replayed);
            assert_eq!(result.knowledge_staged, importance >= 0.7);
        }
        assert_eq!(
            std::fs::read_to_string(log(f.base.root.path()))
                .unwrap()
                .lines()
                .count(),
            1
        );
        assert_eq!(queue(f.base.root.path()).exists(), importance >= 0.7);
        let r: Value =
            serde_json::from_slice(&std::fs::read(receipt(f.base.root.path())).unwrap()).unwrap();
        assert_eq!(r["publication_requested"], true);
        assert_eq!(r["curation"]["complete"], true);
        assert_eq!(r["knowledge"]["stage"], 3);
        assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
        assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn primary_only_receipts_remain_primary_only_until_explicitly_upgraded() {
    let f = fixture();
    let plan = select(&f);
    f.merge
        .store_selected(
            &plan,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    NativeMerge::open(f.reader.clone(), f.journal.clone()).unwrap();
    assert!(!log(f.base.root.path()).exists());
    let result = f
        .merge
        .store_selected_with_publication(
            &plan,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    assert!(result.replayed && !result.knowledge_staged);
    assert_eq!(
        std::fs::read_to_string(log(f.base.root.path()))
            .unwrap()
            .lines()
            .count(),
        1
    );
}
#[test]
fn every_interrupted_gap_retains_the_obligation_and_open_finishes_without_providers() {
    for point in [
        "normal-prepared",
        "normal-row-write",
        "normal-complete",
        "normal-curation-prepared",
        "normal-curation-write",
        "normal-curation-complete",
        "normal-knowledge-prepared",
        "normal-knowledge-write",
    ] {
        let mut f = fixture();
        let params = input(0.8);
        let plan = f
            .merge
            .select_normal(&params, &f.base.principal, &f.base.agent, &Cancel::never())
            .unwrap();
        f.merge = f.merge.with_observer(Arc::new(move |s| {
            if s == point {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(f
            .merge
            .store_selected_with_publication(
                &plan,
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never()
            )
            .is_err());
        let p = reopen(f.base.root.path());
        NativeMerge::open(p.reader.clone(), p.journal.clone()).unwrap();
        assert_eq!(
            std::fs::read_to_string(log(f.base.root.path()))
                .unwrap()
                .lines()
                .count(),
            1
        );
        let value: Value =
            serde_json::from_slice(&std::fs::read(queue(f.base.root.path())).unwrap()).unwrap();
        assert_eq!(value["pendingCount"], 1);
        assert_eq!(p.embed.calls.load(Ordering::SeqCst), 0);
        assert_eq!(p.host.calls.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn completed_primary_gap_remains_fenced_and_revoked_authority_stops_recovery() {
    let mut f = fixture();
    let params = input(0.8);
    let plan = f
        .merge
        .select_normal(&params, &f.base.principal, &f.base.agent, &Cancel::never())
        .unwrap();
    f.merge = f.merge.with_observer(Arc::new(|s| {
        if s == "normal-complete" {
            Err(StoreError::Unavailable.into())
        } else {
            Ok(())
        }
    }));
    assert!(f
        .merge
        .store_selected_with_publication(
            &plan,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        )
        .is_err());
    assert!(f
        .base
        .store
        .get_record(&operation().to_string())
        .unwrap()
        .is_some());
    assert!(!log(f.base.root.path()).exists());
    assert!(matches!(
        f.merge
            .select_normal(&params, &f.base.principal, &f.base.agent, &Cancel::never()),
        Err(EngineError::Store(StoreError::Busy))
    ));
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
fn old_primary_api_resumes_an_explicit_retained_publication_obligation() {
    let mut f = fixture();
    let plan = select(&f);
    f.merge = f.merge.with_observer(Arc::new(|s| {
        if s == "normal-complete" {
            Err(StoreError::Unavailable.into())
        } else {
            Ok(())
        }
    }));
    assert!(f
        .merge
        .store_selected_with_publication(
            &plan,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        )
        .is_err());
    let native = NativeMerge::new(f.reader.clone(), f.journal.clone());
    assert!(
        native
            .store_selected(
                &plan,
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never()
            )
            .unwrap()
            .replayed
    );
    assert_eq!(
        std::fs::read_to_string(log(f.base.root.path()))
            .unwrap()
            .lines()
            .count(),
        1
    );
    let r: Value =
        serde_json::from_slice(&std::fs::read(receipt(f.base.root.path())).unwrap()).unwrap();
    assert_eq!(r["knowledge"]["stage"], 3);
    assert_eq!(r["knowledge"]["staged"], false);
}
#[test]
fn completed_chain_keeps_consumed_queue_absent_and_rejects_other_chat_and_config() {
    let f = fixture();
    let params = input(0.8);
    let plan = f
        .merge
        .select_normal(&params, &f.base.principal, &f.base.agent, &Cancel::never())
        .unwrap();
    f.merge
        .store_selected_with_publication(
            &plan,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    std::fs::remove_file(queue(f.base.root.path())).unwrap();
    let result = f
        .merge
        .store_selected_with_publication(
            &plan,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    assert!(result.replayed && result.knowledge_staged);
    assert!(!queue(f.base.root.path()).exists());
    let mut p = serde_json::to_value(&f.base.principal).unwrap();
    p["chat"]["id"] = "another-chat".into();
    let p: Principal = serde_json::from_value(p).unwrap();
    assert!(f
        .merge
        .store_selected_with_publication(&plan, operation(), &p, &f.base.agent, &Cancel::never())
        .is_err());
    f.host.config.lock().unwrap()["summaryMaxWords"] = json!(10);
    assert!(f
        .merge
        .store_selected_with_publication(
            &plan,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        )
        .is_err());
    assert!(!queue(f.base.root.path()).exists());
}
#[test]
fn concurrent_chains_publish_one_curation_event_and_one_queue_entry() {
    let f = fixture();
    let params = input(0.8);
    let plan = f
        .merge
        .select_normal(&params, &f.base.principal, &f.base.agent, &Cancel::never())
        .unwrap();
    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for _ in 0..4 {
            let f = &f;
            let plan = &plan;
            handles.push(scope.spawn(move || {
                f.merge
                    .store_selected_with_publication(
                        plan,
                        operation(),
                        &f.base.principal,
                        &f.base.agent,
                        &Cancel::never(),
                    )
                    .unwrap()
            }));
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
    let value: Value =
        serde_json::from_slice(&std::fs::read(queue(f.base.root.path())).unwrap()).unwrap();
    assert_eq!(value["pendingCount"], 1);
}
#[cfg(unix)]
#[test]
fn publication_chain_sigkill_child() {
    let Some(root) = std::env::var_os("PLUR1BUS_PUBLICATION_CHAIN_TEST_ROOT") else {
        return;
    };
    let point = std::env::var("PLUR1BUS_PUBLICATION_CHAIN_TEST_POINT").unwrap();
    let f = reopen(Path::new(&root));
    let native = NativeMerge::new(f.reader, f.journal).with_observer(Arc::new(move |s| {
        if s == point {
            unsafe {
                libc::kill(libc::getpid(), libc::SIGKILL);
            }
        }
        Ok(())
    }));
    let plan = native
        .select_normal(
            &input(0.8),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    native
        .store_selected_with_publication(
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
fn actual_sigkill_across_child_gaps_recovers_the_retained_chain_with_no_providers() {
    use std::{
        os::unix::process::ExitStatusExt,
        time::{Duration, SystemTime},
    };
    for point in [
        "normal-prepared",
        "normal-row-write",
        "normal-complete",
        "normal-curation-prepared",
        "normal-curation-write",
        "normal-curation-complete",
        "normal-knowledge-prepared",
        "normal-knowledge-write",
    ] {
        let f = fixture();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                std::any::type_name_of_val(&publication_chain_sigkill_child)
                    .split_once("::")
                    .map_or("", |(_, name)| name),
                "--nocapture",
            ])
            .env("PLUR1BUS_PUBLICATION_CHAIN_TEST_ROOT", f.base.root.path())
            .env("PLUR1BUS_PUBLICATION_CHAIN_TEST_POINT", point)
            .status()
            .unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        let p = reopen(f.base.root.path());
        p.host.inner.time.store(1735689610000, Ordering::SeqCst);
        if point.starts_with("normal-knowledge") {
            assert!(NativeMerge::open(p.reader.clone(), p.journal.clone()).is_err());
            // Actual Node stale-lock protocol; explicit clock seam only in the test.
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
        NativeMerge::open(p.reader.clone(), p.journal.clone()).unwrap();
        NativeMerge::open(p.reader, p.journal).unwrap();
        let lines = std::fs::read_to_string(log(f.base.root.path())).unwrap();
        assert_eq!(lines.lines().count(), 1);
        let curation: Value = serde_json::from_str(lines.trim()).unwrap();
        let value: Value =
            serde_json::from_slice(&std::fs::read(queue(f.base.root.path())).unwrap()).unwrap();
        assert_eq!(value["pendingCount"], 1);
        let curation_prepared =
            point.starts_with("normal-curation") || point.starts_with("normal-knowledge");
        assert_eq!(
            curation["timestamp"],
            if curation_prepared {
                "2025-01-01T00:00:00.000Z"
            } else {
                "2025-01-01T00:00:10.000Z"
            }
        );
        assert_eq!(
            value["pending"][0]["queuedAt"],
            if point.starts_with("normal-knowledge") {
                "2025-01-01T00:00:00.000Z"
            } else {
                "2025-01-01T00:00:10.000Z"
            }
        );
        assert_eq!(p.embed.calls.load(Ordering::SeqCst), 0);
        assert_eq!(p.host.calls.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn an_interrupted_upgrade_persists_the_new_obligation_before_starting_children() {
    let f = fixture();
    let plan = select(&f);
    f.merge
        .store_selected(
            &plan,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    let native =
        NativeMerge::new(f.reader.clone(), f.journal.clone()).with_observer(Arc::new(|s| {
            if s == "normal-prepared" {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
    assert!(native
        .store_selected_with_publication(
            &plan,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        )
        .is_err());
    assert!(!log(f.base.root.path()).exists());
    let r: Value =
        serde_json::from_slice(&std::fs::read(receipt(f.base.root.path())).unwrap()).unwrap();
    assert_eq!(r["publication_requested"], true);
    NativeMerge::open(f.reader.clone(), f.journal.clone()).unwrap();
    assert_eq!(
        std::fs::read_to_string(log(f.base.root.path()))
            .unwrap()
            .lines()
            .count(),
        1
    );
}
