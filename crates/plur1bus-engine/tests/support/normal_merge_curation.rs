//! The destructive source-deletion audit does not replace normal memory.merged curation.
use super::*;
fn log(root: &Path) -> PathBuf {
    root.join("workspace/.adaptive-learning/curation-log.jsonl")
}
#[test]
fn normal_merge_publishes_the_original_reason_and_final_text_as_separate_curation() {
    let f = setup();
    let result = run(&f, &Cancel::never()).unwrap().unwrap();
    let bytes = std::fs::read_to_string(log(f.base.root.path())).unwrap();
    assert_eq!(bytes.lines().count(), 1);
    let event: Value = serde_json::from_str(bytes.trim()).unwrap();
    assert_eq!(event["event"], "memory.merged");
    assert_eq!(event["memoryId"], result.replacement_id);
    assert_eq!(event["relatedId"], SOURCE);
    assert_eq!(event["reason"], format!("merged_with:{SOURCE} (fixture)"));
    assert_eq!(
        event["text"],
        "A synthetic decision with additional context"
    );
    assert_eq!(event["category"], "decision");
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
}
#[test]
fn primary_complete_gap_and_curation_boundaries_recover_without_model_replay() {
    for point in [
        "complete",
        "normal-merge-curation-prepared",
        "normal-merge-curation-write",
        "normal-merge-curation-complete",
    ] {
        let mut f = setup();
        f.merge = f.merge.with_observer(Arc::new(move |s| {
            if s == point {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(run(&f, &Cancel::never()).is_err());
        let p = insert_tests::reopen(f.base.root.path());
        p.host.inner.time.store(1735689610000, Ordering::SeqCst);
        NativeMerge::open(p.reader.clone(), p.journal.clone()).unwrap();
        NativeMerge::open(p.reader, p.journal).unwrap();
        let bytes = std::fs::read_to_string(log(f.base.root.path())).unwrap();
        assert_eq!(bytes.lines().count(), 1);
        let event: Value = serde_json::from_str(bytes.trim()).unwrap();
        assert_eq!(event["reason"], format!("merged_with:{SOURCE} (fixture)"));
        assert_eq!(
            event["timestamp"],
            if point == "complete" {
                "2025-01-01T00:00:10.000Z"
            } else {
                "2025-01-01T00:00:00.000Z"
            }
        );
        assert_eq!(p.host.calls.load(Ordering::SeqCst), 0);
        assert_eq!(p.embed.calls.load(Ordering::SeqCst), 0);
    }
}
pub(super) fn receipt(root: &Path) -> PathBuf {
    for dir in std::fs::read_dir(root.join("neo/workspaces")).unwrap() {
        for file in std::fs::read_dir(dir.unwrap().path()).unwrap() {
            let file = file.unwrap();
            if file
                .file_name()
                .to_string_lossy()
                .starts_with("native-durable-merge-")
            {
                return file.path();
            }
        }
    }
    panic!("merge receipt absent");
}
pub(super) fn request(root: &Path) -> plur1bus_engine::ops::durable_merge::MergeRequest {
    let value: Value = serde_json::from_slice(&std::fs::read(receipt(root)).unwrap()).unwrap();
    let p = &value["plan"];
    plur1bus_engine::ops::durable_merge::MergeRequest {
        source: plur1bus_engine::store::shared_row::MemoryRecord {
            row: serde_json::from_value(p["source"]["row"].clone()).unwrap(),
            sharing: serde_json::from_value(p["source"]["sharing"].clone()).unwrap(),
        },
        replacement: serde_json::from_value(p["replacement"].clone()).unwrap(),
        write_key: p["write_key"].as_str().unwrap().into(),
        now_ms: p["now_ms"].as_i64().unwrap(),
        identity: serde_json::from_value(p["identity"].clone()).unwrap(),
    }
}
#[test]
fn completed_merged_curation_evidence_is_required_on_exact_primary_replay() {
    for mode in ["missing", "changed", "append"] {
        let f = setup();
        run(&f, &Cancel::never()).unwrap().unwrap();
        let req = request(f.base.root.path());
        let path = log(f.base.root.path());
        let original = std::fs::read_to_string(&path).unwrap();
        match mode {
            "missing" => std::fs::remove_file(&path).unwrap(),
            "changed" => std::fs::write(&path, original.replace("fixture", "changed")).unwrap(),
            _ => std::fs::write(&path, format!("{original}{{\"event\":\"unrelated\"}}\n")).unwrap(),
        }
        let before = std::fs::read(&path).ok();
        let result = f
            .merge
            .apply(&req, &f.base.principal, &f.base.agent, &Cancel::never());
        if mode == "append" {
            assert!(result.unwrap().replayed);
        } else {
            assert!(result.is_err());
        }
        assert_eq!(std::fs::read(&path).ok(), before);
    }
}
#[test]
fn original_context_config_policy_and_replacement_are_checked_during_primary_gap_recovery() {
    for mode in ["policy", "config", "replacement", "workspace"] {
        let mut f = setup();
        f.merge = f.merge.with_observer(Arc::new(|s| {
            if s == "complete" {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(run(&f, &Cancel::never()).is_err());
        let req = request(f.base.root.path());
        match mode {
            "policy" => f.policy.allowed.store(false, Ordering::SeqCst),
            "config" => f.host.config.lock().unwrap()["summaryMaxWords"] = json!(10),
            "replacement" => f
                .base
                .store
                .patch(
                    &req.replacement.id,
                    &RowPatch {
                        text: Some("Changed replacement".into()),
                        ..Default::default()
                    },
                )
                .unwrap(),
            _ => {
                std::fs::rename(
                    f.base.root.path().join("workspace"),
                    f.base.root.path().join("old-workspace"),
                )
                .unwrap();
                std::fs::create_dir(f.base.root.path().join("workspace")).unwrap();
            }
        }
        assert!(
            NativeMerge::open(f.reader.clone(), f.journal.clone()).is_err(),
            "{mode}"
        );
        assert!(!log(f.base.root.path()).exists());
    }
}
#[test]
fn invalid_model_reason_is_refused_before_archiving_or_deleting_the_source() {
    let f = setup();
    *f.host.answer.lock().unwrap()=Ok(r#"{"merge":true,"reason":"\ud800","mergedText":"A synthetic decision with additional context"}"#.into());
    assert!(run(&f, &Cancel::never()).is_err());
    assert!(f.base.store.get_record(SOURCE).unwrap().is_some());
    assert!(!log(f.base.root.path()).exists());
}
#[test]
fn a_legacy_primary_receipt_without_normal_origin_gains_no_curation_obligation() {
    use sha2::{Digest, Sha256};
    let f = setup();
    run(&f, &Cancel::never()).unwrap().unwrap();
    let req = request(f.base.root.path());
    let path = receipt(f.base.root.path());
    let mut value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    value["plan"]
        .as_object_mut()
        .unwrap()
        .remove("normal_origin");
    value.as_object_mut().unwrap().remove("curation");
    value.as_object_mut().unwrap().remove("knowledge");
    value["fingerprint"] = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&value["plan"]).unwrap())
    )
    .into();
    std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    std::fs::remove_file(log(f.base.root.path())).unwrap();
    assert!(
        f.merge
            .apply(&req, &f.base.principal, &f.base.agent, &Cancel::never())
            .unwrap()
            .replayed
    );
    NativeMerge::open(f.reader.clone(), f.journal.clone()).unwrap();
    assert!(!log(f.base.root.path()).exists());
}
#[test]
fn pending_merged_curation_keeps_other_writers_fenced_until_original_recovery() {
    let mut f = setup();
    f.merge = f.merge.with_observer(Arc::new(|s| {
        if s == "complete" {
            Err(StoreError::Unavailable.into())
        } else {
            Ok(())
        }
    }));
    assert!(run(&f, &Cancel::never()).is_err());
    assert!(matches!(
        f.merge.select_normal(
            &parse_json("{\"text\":\"Another synthetic input\"}").unwrap(),
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
fn final_merged_curation_deletion_is_not_acknowledged() {
    let mut f = setup();
    let path = log(f.base.root.path());
    let target = path.clone();
    f.merge = f.merge.with_observer(Arc::new(move |s| {
        if s == "normal-merge-curation-complete" {
            std::fs::remove_file(&target).unwrap();
        }
        Ok(())
    }));
    assert!(run(&f, &Cancel::never()).is_err());
    assert!(!path.exists());
    let req = request(f.base.root.path());
    assert!(NativeMerge::new(f.reader.clone(), f.journal.clone())
        .apply(&req, &f.base.principal, &f.base.agent, &Cancel::never())
        .is_err());
    assert!(!path.exists());
}
#[cfg(unix)]
#[test]
fn merged_curation_sigkill_child() {
    let Some(root) = std::env::var_os("PLUR1BUS_MERGED_CURATION_TEST_ROOT") else {
        return;
    };
    let point = std::env::var("PLUR1BUS_MERGED_CURATION_TEST_POINT").unwrap();
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
    native
        .merge_normal(
            SOURCE,
            &parse_json(r#"{"text":"A synthetic decision","category":"decision","ttl":"session"}"#)
                .unwrap(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    panic!("kill boundary not reached");
}
#[cfg(unix)]
#[test]
fn actual_sigkill_merge_curation_recovers_retained_reason_without_providers() {
    use std::os::unix::process::ExitStatusExt;
    for point in [
        "complete",
        "normal-merge-curation-prepared",
        "normal-merge-curation-write",
        "normal-merge-curation-complete",
    ] {
        let f = setup();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                std::any::type_name_of_val(&merged_curation_sigkill_child)
                    .split_once("::")
                    .map_or("", |(_, name)| name),
                "--nocapture",
            ])
            .env("PLUR1BUS_MERGED_CURATION_TEST_ROOT", f.base.root.path())
            .env("PLUR1BUS_MERGED_CURATION_TEST_POINT", point)
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
        assert_eq!(event["reason"], format!("merged_with:{SOURCE} (fixture)"));
        assert_eq!(p.host.calls.load(Ordering::SeqCst), 0);
        assert_eq!(p.embed.calls.load(Ordering::SeqCst), 0);
    }
}
