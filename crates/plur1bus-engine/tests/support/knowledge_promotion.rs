//! Actual caller-bound atomic canonical publication, distinct from pure proposal parity.
use super::*;
use plur1bus_engine::ops::knowledge_promotion::NativePromotion;
const SECOND: &str = "00000000-0000-4000-8000-000000000002";
fn document(root: &Path) -> PathBuf {
    root.join("workspace/memory/KNOWLEDGE.md")
}
fn queue_path(root: &Path) -> PathBuf {
    root.join("workspace/.adaptive-learning/knowledge-pending.json")
}
fn setup_promotion() -> Fixture {
    let f = setup();
    f.host.config.lock().unwrap()["schicht15"] = json!({"enabled":true});
    f
}
fn publisher(f: &Fixture) -> NativePromotion {
    NativePromotion::new(f.reader.clone(), f.journal.clone())
}
fn publish(f: &Fixture, ids: &[String]) -> Result<MemoryPromotionResult, EngineError> {
    publisher(f).run(ids, &f.base.principal, &f.base.agent, &Cancel::never())
}
fn pending(f: &Fixture) {
    let state = plur1bus_engine::capture::knowledge_pending::normalize(
        &parse_json(
            &json!({"pending":[
            {"sourceAgent":"alpha","memoryId":SOURCE,"importance":0.8},
            {"sourceAgent":"beta","memoryId":"foreign-evidence","importance":0.9}
            ]})
            .to_string(),
        )
        .unwrap(),
        1735689600000,
        &Cancel::never(),
    )
    .unwrap();
    let path = queue_path(f.base.root.path());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        path,
        plur1bus_engine::capture::knowledge_pending::encode(&state, &Cancel::never()).unwrap(),
    )
    .unwrap();
}
#[test]
fn publishes_marker_and_evidence_once_preserves_markdown_and_other_agent_queue() {
    let f = setup_promotion();
    pending(&f);
    let path = document(f.base.root.path());
    std::fs::create_dir(path.parent().unwrap()).unwrap();
    let before = "# Human knowledge\r\nKeep **verbatim** 🧠.\r\n";
    std::fs::write(&path, before).unwrap();
    let original = serde_json::to_value(f.base.store.get(SOURCE).unwrap().unwrap()).unwrap();
    let result = publish(&f, &[SOURCE.into()]).unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap()["items"][0]["outcome"],
        "promoted"
    );
    let content = std::fs::read_to_string(&path).unwrap();
    assert!(content.starts_with(before));
    assert!(content.contains("> A synthetic decision"));
    assert_eq!(content.matches("<!-- plur1bus-promotion:").count(), 1);
    let q: Value =
        serde_json::from_slice(&std::fs::read(queue_path(f.base.root.path())).unwrap()).unwrap();
    assert_eq!(q["pendingCount"], 1);
    assert_eq!(q["pending"][0]["sourceAgent"], "beta");
    let result = publish(&f, &[SOURCE.into()]).unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap()["items"][0]["reason"],
        "already-promoted"
    );
    assert_eq!(std::fs::read_to_string(path).unwrap(), content);
    assert_eq!(
        serde_json::to_value(f.base.store.get(SOURCE).unwrap().unwrap()).unwrap(),
        original
    );
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 0);
}
#[test]
fn only_foreground_human_or_system_can_publish() {
    for (origin, background, allowed) in [
        ("user", false, true),
        ("system", false, true),
        ("user", true, false),
        ("system", true, false),
        ("cron", false, false),
        ("subagent", false, false),
        ("heartbeat", false, false),
    ] {
        let f = setup_promotion();
        let agent: AgentContext =
            serde_json::from_value(json!({"origin":origin,"background":background})).unwrap();
        let result = publisher(&f).run(
            &[SOURCE.into()],
            &f.base.principal,
            &agent,
            &Cancel::never(),
        );
        assert_eq!(result.is_ok(), allowed, "{origin}/{background}");
        assert_eq!(document(f.base.root.path()).exists(), allowed);
    }
}
#[test]
fn changed_source_policy_config_or_markdown_is_not_overwritten() {
    for kind in ["source", "policy", "config", "markdown", "expiry"] {
        let f = setup_promotion();
        let path = document(f.base.root.path());
        std::fs::create_dir(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "Human bytes\n").unwrap();
        if kind == "expiry" {
            let mut row = f.base.store.get(SOURCE).unwrap().unwrap();
            row.expires_at = 1735689601000_i64.into();
            f.base.store.upsert(&[row]).unwrap();
        }
        let store = f.base.store.clone();
        let policy = f.policy.clone();
        let host = f.host.clone();
        let changed_path = path.clone();
        let writer = publisher(&f).with_observer(Arc::new(move |phase| {
            if phase == "promotion-before-document" {
                match kind {
                    "source" => {
                        let mut row = store.get(SOURCE).unwrap().unwrap();
                        row.text = "Changed source".into();
                        store.upsert(&[row]).unwrap();
                    }
                    "expiry" => host.inner.time.store(1735689602000, Ordering::SeqCst),
                    "policy" => policy.allowed.store(false, Ordering::SeqCst),
                    "config" => {
                        host.config.lock().unwrap()["schicht15"] = json!({"enabled":false});
                    }
                    "markdown" => std::fs::write(&changed_path, "New human bytes\n").unwrap(),
                    _ => unreachable!(),
                }
            }
            Ok(())
        }));
        assert!(
            writer
                .run(
                    &[SOURCE.into()],
                    &f.base.principal,
                    &f.base.agent,
                    &Cancel::never()
                )
                .is_err(),
            "{kind}"
        );
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            if kind == "markdown" {
                "New human bytes\n"
            } else {
                "Human bytes\n"
            }
        );
    }
}
#[test]
fn cap_is_per_invocation_and_invalid_input_never_creates_publication_files() {
    let f = setup_promotion();
    f.host.config.lock().unwrap()["schicht15"] = json!({"enabled":true,"maxPromotionsPerRun":1});
    let first =
        serde_json::to_value(publish(&f, &[SOURCE.into(), SECOND.into()]).unwrap()).unwrap();
    assert_eq!(first["items"][1]["reason"], "cap-reached");
    let second =
        serde_json::to_value(publish(&f, &[SOURCE.into(), SECOND.into()]).unwrap()).unwrap();
    assert_eq!(second["items"][1]["outcome"], "promoted");
    let f = setup_promotion();
    assert!(publish(&f, &["invalid".into()]).is_err());
    assert!(!document(f.base.root.path()).exists());
    assert!(!queue_path(f.base.root.path()).exists());
}

#[test]
fn disabled_and_busy_publishers_do_not_write_document_or_cleanup_queue() {
    use plur1bus_engine::store::lock::Lock;
    use std::time::Duration;
    for disabled in [true, false] {
        let f = setup_promotion();
        pending(&f);
        let before = std::fs::read(queue_path(f.base.root.path())).unwrap();
        let lock = if disabled {
            f.host.config.lock().unwrap()["schicht15"]["enabled"] = json!(false);
            None
        } else {
            Lock::try_acquire(
                &queue_path(f.base.root.path()).with_file_name("knowledge-update.lock"),
                Duration::from_secs(300),
                None,
            )
            .unwrap()
        };
        let result = serde_json::to_value(publish(&f, &[SOURCE.into()]).unwrap()).unwrap();
        assert_eq!(
            result["items"][0]["reason"],
            if disabled { "disabled" } else { "lock-busy" }
        );
        assert_eq!(
            std::fs::read(queue_path(f.base.root.path())).unwrap(),
            before
        );
        assert!(!document(f.base.root.path()).exists());
        drop(lock);
    }
}
#[test]
fn ambiguous_legacy_or_unknown_queue_data_is_never_discarded() {
    for bytes in [
        r#"{"pendingMemoryIds":["legacy"]}"#,
        r#"{"schema":2,"pending":[],"pendingCount":0,"pendingOverflowCount":0,"foreignMetadata":true}"#,
    ] {
        let f = setup_promotion();
        let path = queue_path(f.base.root.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        assert!(publish(&f, &[SOURCE.into()]).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), bytes);
        assert!(!document(f.base.root.path()).exists());
    }
}
#[cfg(unix)]
#[test]
fn linked_documents_are_not_replaced() {
    for hard in [false, true] {
        let f = setup_promotion();
        let path = document(f.base.root.path());
        std::fs::create_dir(path.parent().unwrap()).unwrap();
        let outside = f.base.root.path().join("outside.md");
        std::fs::write(&outside, "Unrelated human bytes").unwrap();
        if hard {
            std::fs::hard_link(&outside, &path).unwrap();
        } else {
            std::os::unix::fs::symlink(&outside, &path).unwrap();
        }
        assert!(publish(&f, &[SOURCE.into()]).is_err());
        assert_eq!(
            std::fs::read_to_string(outside).unwrap(),
            "Unrelated human bytes"
        );
        assert!(!queue_path(f.base.root.path()).exists());
    }
}
#[cfg(unix)]
#[test]
fn knowledge_promotion_sigkill_child() {
    let Some(root) = std::env::var_os("PLUR1BUS_KNOWLEDGE_PROMOTION_TEST_ROOT") else {
        return;
    };
    let point = std::env::var("PLUR1BUS_KNOWLEDGE_PROMOTION_TEST_POINT").unwrap();
    let f = insert_tests::reopen(Path::new(&root));
    f.host.config.lock().unwrap()["schicht15"] = json!({"enabled":true});
    let writer = NativePromotion::new(f.reader, f.journal).with_observer(Arc::new(move |phase| {
        if phase == point {
            unsafe {
                libc::kill(libc::getpid(), libc::SIGKILL);
            }
        }
        Ok(())
    }));
    writer
        .run(
            &[SOURCE.into()],
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    panic!("kill boundary not reached");
}
#[cfg(unix)]
#[test]
fn actual_sigkill_retries_use_atomic_marker_without_providers_or_duplicate_evidence() {
    use std::{
        os::unix::process::ExitStatusExt,
        time::{Duration, SystemTime},
    };
    for point in [
        "promotion-before-document",
        "promotion-document-committed",
        "promotion-queue-committed",
    ] {
        let f = setup_promotion();
        pending(&f);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "promotion_tests::knowledge_promotion_sigkill_child",
                "--nocapture",
            ])
            .env("PLUR1BUS_KNOWLEDGE_PROMOTION_TEST_ROOT", f.base.root.path())
            .env("PLUR1BUS_KNOWLEDGE_PROMOTION_TEST_POINT", point)
            .status()
            .unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        assert_eq!(
            document(f.base.root.path()).exists(),
            point != "promotion-before-document"
        );
        let p = insert_tests::reopen(f.base.root.path());
        p.host.config.lock().unwrap()["schicht15"] = json!({"enabled":true});
        let native = NativePromotion::new(p.reader.clone(), p.journal.clone());
        let busy = serde_json::to_value(
            native
                .run(
                    &[SOURCE.into()],
                    &p.base.principal,
                    &p.base.agent,
                    &Cancel::never(),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(busy["items"][0]["reason"], "lock-busy");
        for (name, seconds) in [
            ("knowledge-update.lock", 301),
            ("knowledge-pending.lock", 61),
        ] {
            // Test-only lease aging: the production Node thresholds remain five minutes/one minute.
            std::fs::File::options()
                .write(true)
                .open(queue_path(f.base.root.path()).with_file_name(name))
                .unwrap()
                .set_times(
                    std::fs::FileTimes::new()
                        .set_modified(SystemTime::now() - Duration::from_secs(seconds)),
                )
                .unwrap();
        }
        let result = serde_json::to_value(
            native
                .run(
                    &[SOURCE.into()],
                    &p.base.principal,
                    &p.base.agent,
                    &Cancel::never(),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            result["items"][0]["reason"],
            if point == "promotion-before-document" {
                "integrated"
            } else {
                "already-promoted"
            }
        );
        let text = std::fs::read_to_string(document(f.base.root.path())).unwrap();
        assert_eq!(text.matches("<!-- plur1bus-promotion:").count(), 1);
        assert_eq!(text.matches("> A synthetic decision").count(), 1);
        let queue: Value =
            serde_json::from_slice(&std::fs::read(queue_path(f.base.root.path())).unwrap())
                .unwrap();
        assert_eq!(queue["pendingCount"], 1);
        assert_eq!(queue["pending"][0]["sourceAgent"], "beta");
        assert_eq!(p.host.calls.load(Ordering::SeqCst), 0);
        assert_eq!(p.embed.calls.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn pending_merge_cannot_be_bypassed_by_canonical_publication() {
    let f = setup_promotion();
    let merge =
        NativeMerge::new(f.reader.clone(), f.journal.clone()).with_observer(Arc::new(|phase| {
            if phase == "prepared" {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
    assert!(merge.merge_normal(SOURCE,&parse_json(r#"{"text":"A synthetic decision","category":"decision","importance":0.8,"ttl":"session"}"#).unwrap(),&f.base.principal,&f.base.agent,&Cancel::never()).is_err());
    assert!(matches!(
        publish(&f, &[SOURCE.into()]),
        Err(EngineError::Store(StoreError::Busy))
    ));
    assert!(!document(f.base.root.path()).exists());
    assert!(!queue_path(f.base.root.path()).exists());
}
#[cfg(unix)]
#[test]
fn replaced_workspace_or_source_directory_is_not_a_publication_target() {
    for source in [false, true] {
        let f = setup_promotion();
        let root = f.base.root.path().to_owned();
        let changed = root.clone();
        let writer = publisher(&f).with_observer(Arc::new(move |phase| {
            if phase == "promotion-before-document" {
                let path = changed.join(if source { "store/alpha" } else { "workspace" });
                std::fs::rename(&path, changed.join("held-original")).unwrap();
                std::fs::create_dir(&path).unwrap();
            }
            Ok(())
        }));
        assert!(writer
            .run(
                &[SOURCE.into()],
                &f.base.principal,
                &f.base.agent,
                &Cancel::never()
            )
            .is_err());
        assert!(!document(&root).exists());
        assert!(!root.join("held-original/memory/KNOWLEDGE.md").exists());
    }
}

#[test]
fn hidden_or_missing_sources_never_authorize_pending_queue_removal() {
    for kind in ["foreign-owner", "missing"] {
        let f = setup_promotion();
        pending(&f);
        let before = std::fs::read(queue_path(f.base.root.path())).unwrap();
        if kind == "foreign-owner" {
            let mut row = f.base.store.get(SOURCE).unwrap().unwrap();
            row.scope = "user".into();
            row.owner_user_id = plur1bus_engine::context::harness_user_principal("foreign");
            f.base.store.upsert(&[row]).unwrap();
        } else {
            f.base.store.delete(&[SOURCE]).unwrap();
        }
        let result = publish(&f, &[SOURCE.into()]).unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap()["items"][0]["reason"],
            "not-found"
        );
        assert_eq!(
            std::fs::read(queue_path(f.base.root.path())).unwrap(),
            before,
            "{kind}"
        );
        assert!(!document(f.base.root.path()).exists());
    }
}

#[test]
fn mixed_publication_removes_only_proved_private_source_entries() {
    let f = setup_promotion();
    pending(&f);
    let mut foreign = f.base.store.get(SOURCE).unwrap().unwrap();
    foreign.id = SECOND.into();
    foreign.scope = "user".into();
    foreign.owner_user_id = plur1bus_engine::context::harness_user_principal("foreign");
    foreign.text = "Other user evidence must remain private".into();
    f.base.store.upsert(&[foreign]).unwrap();
    let missing = "00000000-0000-4000-8000-000000000003";
    let path = queue_path(f.base.root.path());
    let mut before: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for id in [SECOND, missing] {
        before["pending"]
            .as_array_mut()
            .unwrap()
            .push(json!({"sourceAgent":"alpha","memoryId":id,"importance":0.8}));
    }
    let before = plur1bus_engine::capture::knowledge_pending::normalize(
        &parse_json(&before.to_string()).unwrap(),
        1735689600000,
        &Cancel::never(),
    )
    .unwrap();
    let encoded =
        plur1bus_engine::capture::knowledge_pending::encode(&before, &Cancel::never()).unwrap();
    std::fs::write(&path, &encoded).unwrap();
    let before: Value = serde_json::from_str(&encoded).unwrap();
    let result =
        serde_json::to_value(publish(&f, &[SOURCE.into(), SECOND.into(), missing.into()]).unwrap())
            .unwrap();
    assert_eq!(result["items"][0]["outcome"], "promoted");
    assert_eq!(result["items"][1]["reason"], "not-found");
    assert_eq!(result["items"][2]["reason"], "not-found");
    let after: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(after["pendingCount"], 3);
    let expected: Vec<_> = before["pending"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["memoryId"] != SOURCE)
        .cloned()
        .collect();
    assert_eq!(after["pending"], json!(expected));
    let text = std::fs::read_to_string(document(f.base.root.path())).unwrap();
    assert!(text.contains("A synthetic decision"));
    assert!(!text.contains("Other user evidence"));
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 0);
}
