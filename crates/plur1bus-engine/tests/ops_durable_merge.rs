//! Actual archive-before-replacement-before-delete on Lance, with exact durable retries.
#![cfg(feature = "testkit")]
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    dead_code,
    reason = "offline fixture assertions"
)]
#[path = "support/interference.rs"]
mod fixture;
use plur1bus_engine::{
    capture::durable_merge,
    contract::{Cancel, StoreError},
    ops::durable_merge::{MergeRequest, NativeMerge},
    store::RowPatch,
    text::{
        js::JsString,
        json::{parse_json, write_json},
    },
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
fn request(p: &fixture::Reopened) -> MergeRequest {
    let source = p
        .store
        .get_record("00000000-0000-4000-8000-000000000001")
        .unwrap()
        .unwrap();
    let write_key = "synthetic-merge-key".to_owned();
    let id = durable_merge::identity(
        "alpha",
        &source.row.id,
        &JsString::from(write_key.as_str()),
        &Cancel::never(),
    )
    .unwrap();
    let raw = parse_json(&serde_json::to_string(&source.row).unwrap()).unwrap();
    let mut row = serde_json::to_value(&source.row).unwrap();
    row["id"] = id.replacement_id.into();
    row["text"] = "A synthetic decision with additional context".into();
    row["mergedFrom"] = write_json(&durable_merge::lineage(&raw, &Cancel::never()).unwrap()).into();
    let metadata: serde_json::Value = serde_json::from_str(&write_json(
        &durable_merge::epistemic_metadata(&raw, 1735689600000, &Cancel::never()).unwrap(),
    ))
    .unwrap();
    for (k, v) in metadata.as_object().unwrap() {
        row[k] = v.clone();
    }
    MergeRequest {
        source,
        replacement: serde_json::from_value(row).unwrap(),
        write_key,
        now_ms: 1735689600000,
        identity: p.store.identity().unwrap().clone(),
    }
}
#[test]
fn archive_verified_replacement_and_audit_commit_exactly_once() {
    let f = fixture::setup();
    let p = fixture::reopen(f.root.path());
    let req = request(&p);
    let merge = NativeMerge::new(p.reader, p.journal);
    for _ in 0..2 {
        let result = merge
            .apply(&req, &p.principal, &p.agent, &Cancel::never())
            .unwrap();
        assert_eq!(result.replacement_id, req.replacement.id);
        let archived: serde_json::Value =
            serde_json::from_slice(&std::fs::read(result.archive_path).unwrap()).unwrap();
        assert_eq!(archived, serde_json::to_value(&req.source.row).unwrap());
    }
    assert!(p.store.get(&req.source.row.id).unwrap().is_none());
    assert_eq!(
        p.store.get(&req.replacement.id).unwrap().unwrap().text,
        req.replacement.text
    );
    let audit = std::fs::read_to_string(
        f.root
            .path()
            .join("workspace/.adaptive-learning/destructive-ops.jsonl"),
    )
    .unwrap();
    assert_eq!(audit.lines().count(), 1);
}
#[test]
fn every_partial_durable_boundary_retries_without_duplicate_delete_or_audit() {
    for point in [
        "prepared",
        "archive-write",
        "archived",
        "replacement-write",
        "replaced",
        "delete-intent",
        "delete",
        "deleted",
        "audit-write",
        "audited",
        "complete",
    ] {
        let f = fixture::setup();
        let p = fixture::reopen(f.root.path());
        let req = request(&p);
        let fail = Arc::new(AtomicBool::new(true));
        let trigger = fail.clone();
        let merge = NativeMerge::new(p.reader, p.journal).with_observer(Arc::new(move |stage| {
            if stage == point && trigger.swap(false, Ordering::SeqCst) {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(
            merge
                .apply(&req, &p.principal, &p.agent, &Cancel::never())
                .is_err(),
            "{point}"
        );
        assert!(
            merge
                .apply(&req, &p.principal, &p.agent, &Cancel::never())
                .unwrap()
                .replayed,
            "{point}"
        );
        assert!(p.store.get(&req.source.row.id).unwrap().is_none());
        assert_eq!(
            std::fs::read_to_string(
                f.root
                    .path()
                    .join("workspace/.adaptive-learning/destructive-ops.jsonl")
            )
            .unwrap()
            .lines()
            .count(),
            1
        );
    }
}
#[test]
fn stale_candidate_collision_and_revoked_policy_never_delete_source() {
    for mode in ["stale", "collision", "policy"] {
        let f = fixture::setup();
        let p = fixture::reopen_policy(f.root.path(), mode != "policy");
        let req = request(&p);
        if mode == "stale" {
            p.store
                .patch(
                    &req.source.row.id,
                    &RowPatch {
                        text: Some("changed source".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        if mode == "collision" {
            let mut row = req.replacement.clone();
            row.text = "foreign replacement".into();
            p.store.upsert(&[row]).unwrap();
        }
        let merge = NativeMerge::new(p.reader, p.journal);
        assert!(
            merge
                .apply(&req, &p.principal, &p.agent, &Cancel::never())
                .is_err(),
            "{mode}"
        );
        assert!(p.store.get(&req.source.row.id).unwrap().is_some());
    }
}
#[test]
fn fresh_open_restores_original_caller_and_time_after_every_cut() {
    for point in [
        "prepared",
        "archive-write",
        "replacement-write",
        "delete-intent",
        "delete",
        "audit-write",
        "complete",
    ] {
        let f = fixture::setup();
        let p = fixture::reopen(f.root.path());
        let req = request(&p);
        let merge = NativeMerge::new(p.reader, p.journal).with_observer(Arc::new(move |stage| {
            if stage == point {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(merge
            .apply(&req, &p.principal, &p.agent, &Cancel::never())
            .is_err());
        drop(merge);
        let p = fixture::reopen(f.root.path());
        p.host
            .time
            .store(1735689600000 + 30 * 86400000, Ordering::SeqCst);
        let opened = NativeMerge::open(p.reader, p.journal).unwrap();
        assert_eq!(opened.recover_pending(&Cancel::never()).unwrap(), 0);
        assert!(
            p.store.get(&req.source.row.id).unwrap().is_none(),
            "{point}"
        );
        assert_eq!(
            p.store
                .get(&req.replacement.id)
                .unwrap()
                .unwrap()
                .epistemic_status_updated_at
                .as_f64(),
            Some(1735689600000.)
        );
    }
}
fn receipt(root: &std::path::Path) -> std::path::PathBuf {
    let mut dirs = vec![root.to_owned()];
    while let Some(dir) = dirs.pop() {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                dirs.push(p);
            } else if p
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("native-durable-merge-")
            {
                return p;
            }
        }
    }
    panic!("missing merge receipt")
}
#[test]
fn completed_merge_never_recreates_deleted_or_changed_rows_or_missing_evidence() {
    for mode in [
        "replacement-deleted",
        "replacement-changed",
        "source-restored",
        "archive-deleted",
        "audit-deleted",
        "receipt-deleted",
    ] {
        let f = fixture::setup();
        let p = fixture::reopen(f.root.path());
        let req = request(&p);
        let merge = NativeMerge::new(p.reader, p.journal);
        let done = merge
            .apply(&req, &p.principal, &p.agent, &Cancel::never())
            .unwrap();
        match mode {
            "replacement-deleted" => {
                p.store.delete(&[req.replacement.id.as_str()]).unwrap();
            }
            "replacement-changed" => p
                .store
                .patch(
                    &req.replacement.id,
                    &RowPatch {
                        text: Some("changed".into()),
                        ..Default::default()
                    },
                )
                .unwrap(),
            "source-restored" => p
                .store
                .upsert(std::slice::from_ref(&req.source.row))
                .unwrap(),
            "archive-deleted" => std::fs::remove_file(done.archive_path).unwrap(),
            "audit-deleted" => std::fs::remove_file(
                f.root
                    .path()
                    .join("workspace/.adaptive-learning/destructive-ops.jsonl"),
            )
            .unwrap(),
            _ => std::fs::remove_file(receipt(f.root.path())).unwrap(),
        }
        let before = p
            .store
            .get(&req.replacement.id)
            .unwrap()
            .map(|r| serde_json::to_value(r).unwrap());
        assert!(
            merge
                .apply(&req, &p.principal, &p.agent, &Cancel::never())
                .is_err(),
            "{mode}"
        );
        assert_eq!(
            before,
            p.store
                .get(&req.replacement.id)
                .unwrap()
                .map(|r| serde_json::to_value(r).unwrap())
        );
    }
}
#[test]
fn startup_preflight_refuses_policy_paths_corruption_and_changed_sources() {
    for mode in [
        "revoked",
        "moved",
        "corrupt",
        "oversize",
        "cancel",
        "source",
        "forged-owner",
    ] {
        let f = fixture::setup();
        let p = fixture::reopen(f.root.path());
        let req = request(&p);
        let merge = NativeMerge::new(p.reader, p.journal).with_observer(Arc::new(|s| {
            if s == "prepared" {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(merge
            .apply(&req, &p.principal, &p.agent, &Cancel::never())
            .is_err());
        drop(merge);
        let path = receipt(f.root.path());
        let p = fixture::reopen_policy(f.root.path(), mode != "revoked");
        let cancel = Cancel::never();
        match mode {
            "moved" => {
                let moved = f.root.path().join("moved");
                std::fs::create_dir(&moved).unwrap();
                p.host.set_workspace("alpha", moved);
            }
            "corrupt" => std::fs::write(
                path.parent()
                    .unwrap()
                    .join("native-durable-merge-invalid.json"),
                "{",
            )
            .unwrap(),
            "oversize" => std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_len(8 * 1024 * 1024 + 1)
                .unwrap(),
            "cancel" => cancel.cancel(),
            "source" => p
                .store
                .patch(
                    &req.source.row.id,
                    &RowPatch {
                        text: Some("changed source".into()),
                        ..Default::default()
                    },
                )
                .unwrap(),
            "forged-owner" => {
                use sha2::{Digest, Sha256};
                let mut value: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                value["plan"]["replacement"]["ownerUserId"] = "other".into();
                value["fingerprint"] = format!(
                    "sha256:{:x}",
                    Sha256::digest(serde_json::to_vec(&value["plan"]).unwrap())
                )
                .into();
                std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
            }
            _ => (),
        }
        let merge = NativeMerge::new(p.reader, p.journal);
        assert!(merge.recover_pending(&cancel).is_err(), "{mode}");
        assert!(p.store.get(&req.source.row.id).unwrap().is_some());
        assert!(p.store.get(&req.replacement.id).unwrap().is_none());
    }
}
#[test]
fn pending_merge_fences_automatic_and_other_foreground_writers() {
    let f = fixture::setup();
    let p = fixture::reopen(f.root.path());
    let req = request(&p);
    let merge =
        NativeMerge::new(p.reader.clone(), p.journal.clone()).with_observer(Arc::new(|s| {
            if s == "prepared" {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
    assert!(merge
        .apply(&req, &p.principal, &p.agent, &Cancel::never())
        .is_err());
    let turn:plur1bus_engine::contract::TurnRecord=serde_json::from_value(serde_json::json!({"agentId":"alpha","principal":p.principal,"agent":p.agent,"runId":"automatic","sessionKey":"automatic","incognito":false,"messages":[{"role":"user","content":"Synthetic automatic capture"}]})).unwrap();
    let ctx = plur1bus_engine::context::RequestContext::build(
        &turn.principal,
        &turn.agent,
        p.host.as_ref(),
    )
    .unwrap();
    assert!(p.journal.record(&turn, &ctx, &Cancel::never()).is_err());
    assert!(f
        .ledger
        .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
        .is_err());
    let mut other = req.clone();
    other.write_key = "other-key".into();
    other.replacement.id = durable_merge::identity(
        "alpha",
        &other.source.row.id,
        &JsString::from("other-key"),
        &Cancel::never(),
    )
    .unwrap()
    .replacement_id;
    assert!(merge
        .apply(&other, &p.principal, &p.agent, &Cancel::never())
        .is_err());
    NativeMerge::open(p.reader, p.journal.clone()).unwrap();
    assert!(p.journal.record(&turn, &ctx, &Cancel::never()).is_ok());
}
#[test]
fn four_concurrent_exact_retries_have_one_replacement_and_one_audit() {
    let f = fixture::setup();
    let p = fixture::reopen(f.root.path());
    let req = request(&p);
    let merge = NativeMerge::new(p.reader, p.journal);
    std::thread::scope(|s| {
        let handles = (0..4)
            .map(|_| s.spawn(|| merge.apply(&req, &p.principal, &p.agent, &Cancel::never())))
            .collect::<Vec<_>>();
        for h in handles {
            h.join().unwrap().unwrap();
        }
    });
    assert_eq!(
        std::fs::read_to_string(
            f.root
                .path()
                .join("workspace/.adaptive-learning/destructive-ops.jsonl")
        )
        .unwrap()
        .lines()
        .count(),
        1
    );
}
#[cfg(unix)]
#[test]
fn merge_sigkill_child() {
    let Some(root) = std::env::var_os("PLUR1BUS_MERGE_TEST_ROOT") else {
        return;
    };
    let point = std::env::var("PLUR1BUS_MERGE_TEST_POINT").unwrap();
    let p = fixture::reopen(std::path::Path::new(&root));
    let req = request(&p);
    let merge = NativeMerge::new(p.reader, p.journal).with_observer(Arc::new(move |s| {
        if s == point {
            unsafe {
                libc::kill(libc::getpid(), libc::SIGKILL);
            }
        }
        Ok(())
    }));
    merge
        .apply(&req, &p.principal, &p.agent, &Cancel::never())
        .unwrap();
    panic!("kill boundary not reached");
}
#[cfg(unix)]
#[test]
fn actual_sigkill_recovery_keeps_one_archived_merge() {
    use std::os::unix::process::ExitStatusExt;
    for point in [
        "prepared",
        "archive-write",
        "replacement-write",
        "delete-intent",
        "delete",
        "audit-write",
        "complete",
    ] {
        let f = fixture::setup();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "merge_sigkill_child", "--nocapture"])
            .env("PLUR1BUS_MERGE_TEST_ROOT", f.root.path())
            .env("PLUR1BUS_MERGE_TEST_POINT", point)
            .status()
            .unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        let p = fixture::reopen(f.root.path());
        NativeMerge::open(p.reader, p.journal).unwrap();
        assert!(
            p.store
                .get("00000000-0000-4000-8000-000000000001")
                .unwrap()
                .is_none(),
            "{point}"
        );
        assert_eq!(
            std::fs::read_to_string(
                f.root
                    .path()
                    .join("workspace/.adaptive-learning/destructive-ops.jsonl")
            )
            .unwrap()
            .lines()
            .count(),
            1
        );
    }
}
#[path = "support/durable_merge_security.rs"]
mod security;
