//! Ordinary primary insertion must retain its original private intent across failure/recovery.
use super::*;
fn fixture() -> Fixture {
    let f = setup();
    f.base
        .store
        .delete(&[SOURCE, "00000000-0000-4000-8000-000000000002"])
        .unwrap();
    f
}
fn params() -> plur1bus_engine::text::json::TolerantJsonValue {
    parse_json(r#"{"text":"A synthetic decision","category":"decision","ttl":"session"}"#).unwrap()
}
fn operation() -> uuid::Uuid {
    uuid::Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap()
}
fn select(f: &Fixture) -> plur1bus_engine::ops::durable_merge::NormalCandidatePlan {
    f.merge
        .select_normal(
            &params(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap()
}
#[test]
fn ordinary_primary_commit_and_exact_retry_retain_one_original_row() {
    let f = fixture();
    let selected = select(&f);
    let id = operation();
    for replay in [false, true] {
        let result = f
            .merge
            .store_selected(
                &selected,
                id,
                &f.base.principal,
                &f.base.agent,
                &Cancel::never(),
            )
            .unwrap();
        assert_eq!(result.memory_id, id.to_string());
        assert_eq!(result.replayed, replay);
    }
    let row = f.base.store.get(&id.to_string()).unwrap().unwrap();
    assert_eq!(row.text, "A synthetic decision");
    assert_eq!(row.owner_user_id, f.base.request.source.row.owner_user_id);
    assert_eq!(row.epistemic_status, "untrusted");
    assert_eq!(row.vector, vec![1., 0., 0., 0.]);
    assert_eq!(row.created_at.as_f64(), Some(1735689600000.));
    assert_eq!(row.expires_at.as_f64(), Some(1735689600000. + 86400000.));
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
}
#[test]
fn partial_primary_insert_reuses_original_time_without_inference() {
    for point in [
        "normal-prepared",
        "normal-row-write",
        "normal-verified",
        "normal-complete",
    ] {
        let mut f = fixture();
        let selected = select(&f);
        let hit = Arc::new(AtomicBool::new(true));
        let signal = hit.clone();
        f.merge = f.merge.with_observer(Arc::new(move |stage| {
            if stage == point && signal.swap(false, Ordering::SeqCst) {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(
            f.merge
                .store_selected(
                    &selected,
                    operation(),
                    &f.base.principal,
                    &f.base.agent,
                    &Cancel::never()
                )
                .is_err(),
            "{point}"
        );
        f.host.inner.time.store(1735689610000, Ordering::SeqCst);
        assert!(
            f.merge
                .store_selected(
                    &selected,
                    operation(),
                    &f.base.principal,
                    &f.base.agent,
                    &Cancel::never()
                )
                .unwrap()
                .replayed
        );
        let row = f.base.store.get(&operation().to_string()).unwrap().unwrap();
        assert_eq!(row.created_at.as_f64(), Some(1735689600000.));
        assert_eq!(row.expires_at.as_f64(), Some(1735689600000. + 86400000.));
        assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
        assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn fresh_component_open_restores_original_intent_under_current_policy() {
    let mut f = fixture();
    let selected = select(&f);
    f.merge = f.merge.with_observer(Arc::new(|stage| {
        if stage == "normal-prepared" {
            Err(StoreError::Unavailable.into())
        } else {
            Ok(())
        }
    }));
    assert!(f
        .merge
        .store_selected(
            &selected,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        )
        .is_err());
    f.policy.allowed.store(false, Ordering::SeqCst);
    assert!(NativeMerge::open(f.reader.clone(), f.journal.clone()).is_err());
    assert!(f
        .base
        .store
        .get(&operation().to_string())
        .unwrap()
        .is_none());
    f.policy.allowed.store(true, Ordering::SeqCst);
    f.host.inner.time.store(1735689610000, Ordering::SeqCst);
    NativeMerge::open(f.reader.clone(), f.journal.clone()).unwrap();
    let row = f.base.store.get(&operation().to_string()).unwrap().unwrap();
    assert_eq!(row.created_at.as_f64(), Some(1735689600000.));
    assert_eq!(row.vector, vec![1., 0., 0., 0.]);
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
}
#[test]
fn a_colliding_id_or_changed_completed_row_never_gets_overwritten_or_recreated() {
    for mode in ["collision", "changed", "deleted"] {
        let f = fixture();
        let selected = select(&f);
        if mode == "collision" {
            let mut row = f.base.request.source.row.clone();
            row.id = operation().to_string();
            row.text = "Unrelated preexisting card".into();
            f.base.store.upsert(&[row]).unwrap();
        } else {
            f.merge
                .store_selected(
                    &selected,
                    operation(),
                    &f.base.principal,
                    &f.base.agent,
                    &Cancel::never(),
                )
                .unwrap();
            if mode == "changed" {
                f.base
                    .store
                    .patch(
                        &operation().to_string(),
                        &RowPatch {
                            text: Some("Changed by another operation".into()),
                            ..Default::default()
                        },
                    )
                    .unwrap();
            } else {
                f.base.store.delete(&[&operation().to_string()]).unwrap();
            }
        }
        assert!(
            f.merge
                .store_selected(
                    &selected,
                    operation(),
                    &f.base.principal,
                    &f.base.agent,
                    &Cancel::never()
                )
                .is_err(),
            "{mode}"
        );
        if mode == "deleted" {
            assert!(f
                .base
                .store
                .get(&operation().to_string())
                .unwrap()
                .is_none());
        } else {
            assert_ne!(
                f.base
                    .store
                    .get(&operation().to_string())
                    .unwrap()
                    .unwrap()
                    .text,
                "A synthetic decision"
            );
        }
    }
}
#[test]
fn pending_ordinary_primary_fences_selection_and_changed_configuration() {
    let mut f = fixture();
    let selected = select(&f);
    f.merge = f.merge.with_observer(Arc::new(|stage| {
        if stage == "normal-prepared" {
            Err(StoreError::Unavailable.into())
        } else {
            Ok(())
        }
    }));
    assert!(f
        .merge
        .store_selected(
            &selected,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        )
        .is_err());
    assert!(matches!(
        f.merge.select_normal(
            &params(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        ),
        Err(EngineError::Store(StoreError::Busy))
    ));
    f.host.config.lock().unwrap()["merging"]["autoApply"] = false.into();
    assert!(NativeMerge::open(f.reader.clone(), f.journal.clone()).is_err());
    assert!(f
        .base
        .store
        .get(&operation().to_string())
        .unwrap()
        .is_none());
}

fn receipt(root: &Path) -> PathBuf {
    for dir in std::fs::read_dir(root.join("neo/workspaces")).unwrap() {
        for entry in std::fs::read_dir(dir.unwrap().path()).unwrap() {
            let path = entry.unwrap().path();
            if path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("native-normal-store-")
            {
                return path;
            }
        }
    }
    panic!("missing ordinary-store receipt")
}
#[test]
fn drift_after_selection_refuses_before_an_intent_is_created() {
    for mode in ["policy", "config", "caller", "duplicate"] {
        let f = fixture();
        let selected = select(&f);
        let mut principal = f.base.principal.clone();
        match mode {
            "policy" => f.policy.allowed.store(false, Ordering::SeqCst),
            "config" => f.host.config.lock().unwrap()["summaryMaxWords"] = json!(12),
            "caller" => {
                principal.user = Some(
                    serde_json::from_value(json!(
                        plur1bus_engine::context::harness_user_principal("changed")
                    ))
                    .unwrap(),
                )
            }
            _ => {
                let mut row = f.base.request.source.row.clone();
                row.text = "A synthetic decision".into();
                row.vector = vec![1., 0., 0., 0.];
                f.base.store.upsert(&[row]).unwrap();
            }
        }
        assert!(
            f.merge
                .store_selected(
                    &selected,
                    operation(),
                    &principal,
                    &f.base.agent,
                    &Cancel::never()
                )
                .is_err(),
            "{mode}"
        );
        assert!(f
            .base
            .store
            .get(&operation().to_string())
            .unwrap()
            .is_none());
        assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
    }
}
#[test]
fn expired_pending_intent_never_extends_its_original_ttl() {
    let mut f = fixture();
    let selected = select(&f);
    f.merge = f.merge.with_observer(Arc::new(|s| {
        if s == "normal-prepared" {
            Err(StoreError::Unavailable.into())
        } else {
            Ok(())
        }
    }));
    assert!(f
        .merge
        .store_selected(
            &selected,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        )
        .is_err());
    f.host
        .inner
        .time
        .store(1735689600000 + 2 * 86400000, Ordering::SeqCst);
    assert!(NativeMerge::open(f.reader.clone(), f.journal.clone()).is_err());
    assert!(f
        .base
        .store
        .get(&operation().to_string())
        .unwrap()
        .is_none());
}
#[test]
fn completed_intent_loss_and_corrupt_or_oversized_receipts_fail_closed() {
    for mode in ["lost", "corrupt", "oversized"] {
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
        let path = receipt(f.base.root.path());
        match mode {
            "lost" => std::fs::remove_file(path).unwrap(),
            "corrupt" => std::fs::write(path, b"{}").unwrap(),
            _ => std::fs::OpenOptions::new()
                .write(true)
                .open(path)
                .unwrap()
                .set_len(8 * 1024 * 1024 + 1)
                .unwrap(),
        }
        assert!(
            f.merge
                .store_selected(
                    &selected,
                    operation(),
                    &f.base.principal,
                    &f.base.agent,
                    &Cancel::never()
                )
                .is_err(),
            "{mode}"
        );
        assert_eq!(
            f.base
                .store
                .get(&operation().to_string())
                .unwrap()
                .unwrap()
                .text,
            "A synthetic decision"
        );
    }
}
#[cfg(unix)]
#[test]
fn receipt_links_never_change_the_external_target() {
    for hard in [false, true] {
        let mut f = fixture();
        let selected = select(&f);
        f.merge = f.merge.with_observer(Arc::new(|s| {
            if s == "normal-prepared" {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(f
            .merge
            .store_selected(
                &selected,
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never()
            )
            .is_err());
        let path = receipt(f.base.root.path());
        let bytes = std::fs::read(&path).unwrap();
        let outside = f.base.root.path().join("outside.json");
        std::fs::write(&outside, &bytes).unwrap();
        std::fs::remove_file(&path).unwrap();
        if hard {
            std::fs::hard_link(&outside, &path).unwrap();
        } else {
            std::os::unix::fs::symlink(&outside, &path).unwrap();
        }
        assert!(NativeMerge::open(f.reader.clone(), f.journal.clone()).is_err());
        assert_eq!(std::fs::read(outside).unwrap(), bytes);
        assert!(f
            .base
            .store
            .get(&operation().to_string())
            .unwrap()
            .is_none());
    }
}
struct Reopened {
    base: fixture::Reopened,
    host: Arc<Host>,
    embed: Arc<Embed>,
    reader: Arc<MemoryReader>,
    journal: Arc<CaptureJournal>,
}
fn reopen(root: &Path) -> Reopened {
    let base = fixture::reopen(root);
    let inner = support::TestHost::new(root.join("state"));
    inner.set_workspace("alpha", root.join("workspace"));
    inner.time.store(1735689600000, Ordering::SeqCst);
    let host = Arc::new(Host {
        inner,
        config: Mutex::new(
            json!({"merging":{"enabled":true,"autoApply":true,"model":"synthetic/model"}}),
        ),
        calls: AtomicUsize::new(0),
        answer: Mutex::new(Err(HostError::Unavailable)),
        effect: Mutex::new(None),
        route: AtomicBool::new(true),
        params: Mutex::new(vec![]),
    });
    let embed = Arc::new(Embed {
        identity: base.store.identity().unwrap().clone(),
        calls: AtomicUsize::new(0),
        effect: Mutex::new(None),
        vector: Mutex::new(vec![1., 0., 0., 0.]),
    });
    let journal = Arc::new(
        CaptureJournal::open(
            &root.join("neo"),
            host.clone(),
            Arc::new(fixture::Policy {
                allowed: AtomicBool::new(true),
            }),
        )
        .unwrap(),
    );
    let reader = Arc::new(MemoryReader::new(
        Arc::new(OperationContext::new(host.clone())),
        Arc::new(Sources(base.store.clone())),
        embed.clone(),
        root.join("store"),
    ));
    Reopened {
        base,
        host,
        embed,
        reader,
        journal,
    }
}
#[cfg(unix)]
#[test]
fn normal_insert_sigkill_child() {
    let Some(root) = std::env::var_os("PLUR1BUS_NORMAL_INSERT_TEST_ROOT") else {
        return;
    };
    let point = std::env::var("PLUR1BUS_NORMAL_INSERT_TEST_POINT").unwrap();
    let f = reopen(Path::new(&root));
    let native = NativeMerge::new(f.reader, f.journal).with_observer(Arc::new(move |s| {
        if s == point {
            unsafe {
                libc::kill(libc::getpid(), libc::SIGKILL);
            }
        }
        Ok(())
    }));
    let selected = native
        .select_normal(
            &params(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    native
        .store_selected(
            &selected,
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
fn actual_sigkill_reopens_the_original_primary_row_without_provider_work() {
    use std::os::unix::process::ExitStatusExt;
    for point in [
        "normal-prepared",
        "normal-row-write",
        "normal-verified",
        "normal-complete",
    ] {
        let f = fixture();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "insert_tests::normal_insert_sigkill_child",
                "--nocapture",
            ])
            .env("PLUR1BUS_NORMAL_INSERT_TEST_ROOT", f.base.root.path())
            .env("PLUR1BUS_NORMAL_INSERT_TEST_POINT", point)
            .status()
            .unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        let p = reopen(f.base.root.path());
        p.host.inner.time.store(1735689610000, Ordering::SeqCst);
        NativeMerge::open(p.reader.clone(), p.journal.clone()).unwrap();
        NativeMerge::open(p.reader, p.journal).unwrap();
        let row = p.base.store.get(&operation().to_string()).unwrap().unwrap();
        assert_eq!(row.created_at.as_f64(), Some(1735689600000.));
        assert_eq!(row.expires_at.as_f64(), Some(1735689600000. + 86400000.));
        assert_eq!(row.vector, vec![1., 0., 0., 0.]);
        assert_eq!(p.embed.calls.load(Ordering::SeqCst), 0);
        assert_eq!(p.host.calls.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn fresh_duplicate_selection_replays_only_the_original_input_and_id() {
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
    f.host.inner.time.store(1735689610000, Ordering::SeqCst);
    let duplicate = select(&f);
    assert!(matches!(
        duplicate.kind(),
        plur1bus_engine::ops::durable_merge::NormalCandidateKind::Duplicate { .. }
    ));
    assert!(
        f.merge
            .store_selected(
                &duplicate,
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never()
            )
            .unwrap()
            .replayed
    );
    assert!(f
        .merge
        .store_selected(
            &duplicate,
            uuid::Uuid::new_v4(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        )
        .is_err());
    let changed = parse_json(
        r#"{"text":"A different synthetic decision","category":"decision","ttl":"session"}"#,
    )
    .unwrap();
    let changed = f
        .merge
        .select_normal(&changed, &f.base.principal, &f.base.agent, &Cancel::never())
        .unwrap();
    assert!(f
        .merge
        .store_selected(
            &changed,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        )
        .is_err());
    assert_eq!(
        f.base
            .store
            .get(&operation().to_string())
            .unwrap()
            .unwrap()
            .created_at
            .as_f64(),
        Some(1735689600000.)
    );
}
#[test]
fn declined_merge_can_store_separately_without_deleting_or_reembedding_the_source() {
    let f = selection_tests::setup_selection(true);
    *f.host.answer.lock().unwrap() =
        Ok(r#"{"merge":false,"reason":"keep separate","mergedText":""}"#.into());
    let selected = select(&f);
    assert!(matches!(
        selected.kind(),
        plur1bus_engine::ops::durable_merge::NormalCandidateKind::Merge { .. }
    ));
    assert!(f
        .merge
        .merge_selected(
            &selected,
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        )
        .unwrap()
        .is_none());
    f.merge
        .store_selected(
            &selected,
            operation(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(
        f.base.store.get(SOURCE).unwrap().unwrap().text,
        "A synthetic decision with context"
    );
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 1);
}
#[test]
fn policy_loss_at_publication_boundaries_refuses_acknowledgement_and_recovery() {
    for point in ["normal-prepared", "normal-row-write", "normal-verified"] {
        let mut f = fixture();
        let selected = select(&f);
        let policy = f.policy.clone();
        f.merge = f.merge.with_observer(Arc::new(move |s| {
            if s == point {
                policy.allowed.store(false, Ordering::SeqCst);
            }
            Ok(())
        }));
        assert!(
            f.merge
                .store_selected(
                    &selected,
                    operation(),
                    &f.base.principal,
                    &f.base.agent,
                    &Cancel::never()
                )
                .is_err(),
            "{point}"
        );
        assert!(NativeMerge::open(f.reader.clone(), f.journal.clone()).is_err());
        if point == "normal-prepared" {
            assert!(f
                .base
                .store
                .get(&operation().to_string())
                .unwrap()
                .is_none());
        }
        f.policy.allowed.store(true, Ordering::SeqCst);
        NativeMerge::open(f.reader.clone(), f.journal.clone()).unwrap();
        assert!(f
            .base
            .store
            .get(&operation().to_string())
            .unwrap()
            .is_some());
    }
}
#[test]
fn replacement_of_saved_physical_roots_blocks_startup_before_primary_insertion() {
    for name in ["state", "store", "workspace"] {
        let mut f = fixture();
        let selected = select(&f);
        f.merge = f.merge.with_observer(Arc::new(|s| {
            if s == "normal-prepared" {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(f
            .merge
            .store_selected(
                &selected,
                operation(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never()
            )
            .is_err());
        let path = f.base.root.path().join(name);
        let old = f.base.root.path().join(format!("old-{name}"));
        std::fs::rename(&path, &old).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(
            NativeMerge::open(f.reader.clone(), f.journal.clone()).is_err(),
            "{name}"
        );
        std::fs::remove_dir(&path).unwrap();
        std::fs::rename(old, path).unwrap();
        assert!(f
            .base
            .store
            .get(&operation().to_string())
            .unwrap()
            .is_none());
    }
}

#[test]
fn pending_primary_fences_automatic_merge_and_interference_writers() {
    let mut f = selection_tests::setup_selection(true);
    let selected = select(&f);
    f.merge = f.merge.with_observer(Arc::new(|s| {
        if s == "normal-prepared" {
            Err(StoreError::Unavailable.into())
        } else {
            Ok(())
        }
    }));
    assert!(f
        .merge
        .store_selected(
            &selected,
            operation(),
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
    assert!(matches!(
        run(&f, &Cancel::never()),
        Err(EngineError::Store(StoreError::Busy))
    ));
    assert!(matches!(
        f.base.ledger.apply(
            &f.base.request,
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        ),
        Err(EngineError::Store(StoreError::Busy))
    ));
    NativeMerge::open(f.reader.clone(), f.journal.clone()).unwrap();
    f.journal.record(&turn, &ctx, &Cancel::never()).unwrap();
}
#[test]
fn four_concurrent_retries_share_the_single_primary_intent() {
    let f = fixture();
    let selected = select(&f);
    std::thread::scope(|scope| {
        let mut joins = Vec::new();
        for _ in 0..4 {
            let f = &f;
            let selected = &selected;
            joins.push(scope.spawn(move || {
                f.merge
                    .store_selected(
                        selected,
                        operation(),
                        &f.base.principal,
                        &f.base.agent,
                        &Cancel::never(),
                    )
                    .unwrap()
            }));
        }
        let results: Vec<_> = joins.into_iter().map(|j| j.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| !r.replayed).count(), 1);
        assert!(results
            .iter()
            .all(|r| r.memory_id == operation().to_string()));
    });
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
}

#[path = "normal_curation.rs"]
mod curation_tests;

#[path = "normal_knowledge.rs"]
mod knowledge_tests;

#[path = "normal_publication_chain.rs"]
mod publication_chain_tests;
