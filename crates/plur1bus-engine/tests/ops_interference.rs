//! Real Lance interference receipts and original-caller recovery.
#![cfg(feature = "testkit")]
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "offline fixture assertions"
)]
#[path = "support/interference.rs"]
mod fixture;
use fixture::*;
use plur1bus_engine::{
    capture::interference::InterferenceOptions,
    contract::{Cancel, StoreError},
    ops::interference::{InterferenceRequest, NativeInterference},
    store::RowPatch,
};
use serde_json::json;
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
#[test]
fn actual_private_rows_weaken_once_under_concurrent_retries() {
    let f = setup();
    std::thread::scope(|scope| {
        let hs = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    f.ledger
                        .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
                })
            })
            .collect::<Vec<_>>();
        for h in hs {
            assert_eq!(h.join().unwrap().unwrap().affected, 1);
        }
    });
    let row = f
        .store
        .get("00000000-0000-4000-8000-000000000002")
        .unwrap()
        .unwrap();
    assert!((row.memory_strength.as_f64().unwrap() - 0.72).abs() < 1e-12);
    assert_eq!(
        f.store.get(&f.request.source.row.id).unwrap().unwrap().text,
        f.request.source.row.text
    );
}
#[test]
fn prepared_and_partial_failures_reuse_frozen_patches() {
    for point in ["prepared", "applied"] {
        let mut f = setup();
        let once = Arc::new(AtomicBool::new(true));
        let fail = once.clone();
        f.ledger = f.ledger.with_observer(Arc::new(move |stage| {
            if stage == point && fail.swap(false, Ordering::SeqCst) {
                return Err(StoreError::Unavailable.into());
            }
            Ok(())
        }));
        assert!(f
            .ledger
            .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
            .is_err());
        assert_eq!(
            f.ledger
                .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
                .unwrap()
                .affected,
            1
        );
        assert!(
            (f.store
                .get("00000000-0000-4000-8000-000000000002")
                .unwrap()
                .unwrap()
                .memory_strength
                .as_f64()
                .unwrap()
                - 0.72)
                .abs()
                < 1e-12
        );
    }
}
#[test]
fn changed_source_or_policy_refuses_before_weakening() {
    for mode in ["source", "policy"] {
        let f = setup();
        if mode == "source" {
            f.store
                .patch(
                    &f.request.source.row.id,
                    &RowPatch {
                        text: Some("changed".into()),
                        ..RowPatch::default()
                    },
                )
                .unwrap();
        } else {
            f.policy.allowed.store(false, Ordering::SeqCst);
        }
        assert!(f
            .ledger
            .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
            .is_err());
        assert_eq!(
            f.store
                .get("00000000-0000-4000-8000-000000000002")
                .unwrap()
                .unwrap()
                .memory_strength
                .as_f64()
                .unwrap(),
            0.8
        );
    }
}
fn receipt(root: &std::path::Path) -> std::path::PathBuf {
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for e in fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                dirs.push(p);
            } else if p
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("native-interference-")
            {
                return p;
            }
        }
    }
    panic!("receipt missing")
}
#[test]
fn shared_foreign_core_and_tombstoned_targets_are_not_weakened() {
    let f = setup();
    let ordinary = f
        .store
        .get("00000000-0000-4000-8000-000000000002")
        .unwrap()
        .unwrap();
    for (i, mode) in ["core", "shared", "foreign", "deleted"].iter().enumerate() {
        let mut row = ordinary.clone();
        row.id = format!("00000000-0000-4000-8000-{:012}", i + 3);
        match *mode {
            "core" => row.memory_class = "core".into(),
            "shared" => row.scope = "user".into(),
            "foreign" => row.owner_user_id = "other-owner".into(),
            _ => row.status = "deleted".into(),
        }
        f.store.upsert(&[row]).unwrap();
    }
    assert_eq!(
        f.ledger
            .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
            .unwrap()
            .affected,
        1
    );
    for i in 3..7 {
        assert_eq!(
            f.store
                .get(&format!("00000000-0000-4000-8000-{i:012}"))
                .unwrap()
                .unwrap()
                .memory_strength
                .as_f64()
                .unwrap(),
            0.8
        );
    }
}
#[test]
fn prepared_receipts_refuse_changed_targets_forged_patches_and_current_policy() {
    for mode in ["target", "forged", "policy"] {
        let mut f = setup();
        let stop = Arc::new(AtomicBool::new(true));
        let trigger = stop.clone();
        f.ledger = f.ledger.with_observer(Arc::new(move |stage| {
            if stage == "prepared" && trigger.load(Ordering::SeqCst) {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(f
            .ledger
            .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
            .is_err());
        stop.store(false, Ordering::SeqCst);
        match mode {
            "target" => f
                .store
                .patch(
                    "00000000-0000-4000-8000-000000000002",
                    &RowPatch {
                        text: Some("changed revision".into()),
                        ..RowPatch::default()
                    },
                )
                .unwrap(),
            "policy" => f.policy.allowed.store(false, Ordering::SeqCst),
            _ => {
                let p = receipt(f.root.path());
                let mut v: serde_json::Value =
                    serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
                v["effects"][0]["after"]["row"]["memoryStrength"] = json!(0.01);
                fs::write(p, serde_json::to_vec(&v).unwrap()).unwrap();
            }
        }
        assert!(
            f.ledger
                .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
                .is_err(),
            "{mode}"
        );
        assert_eq!(
            f.store
                .get("00000000-0000-4000-8000-000000000002")
                .unwrap()
                .unwrap()
                .memory_strength
                .as_f64()
                .unwrap(),
            0.8
        );
    }
}
#[test]
fn completed_receipt_cannot_repeat_after_target_reset_or_options_collision() {
    for mode in ["reset", "options"] {
        let mut f = setup();
        let before = f
            .store
            .get("00000000-0000-4000-8000-000000000002")
            .unwrap()
            .unwrap();
        f.ledger
            .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
            .unwrap();
        if mode == "reset" {
            f.store.upsert(&[before]).unwrap();
        } else {
            f.request.options.multiplier = 0.5;
        }
        let current = f
            .store
            .get("00000000-0000-4000-8000-000000000002")
            .unwrap()
            .unwrap()
            .memory_strength;
        assert!(f
            .ledger
            .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
            .is_err());
        assert_eq!(
            f.store
                .get("00000000-0000-4000-8000-000000000002")
                .unwrap()
                .unwrap()
                .memory_strength,
            current
        );
    }
}
#[cfg(unix)]
#[test]
fn receipt_links_are_refused_without_touching_their_target() {
    for hard in [false, true] {
        let f = setup();
        f.ledger
            .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
            .unwrap();
        let p = receipt(f.root.path());
        let outside = f.root.path().join("outside");
        fs::rename(&p, &outside).unwrap();
        let before = fs::read(&outside).unwrap();
        if hard {
            fs::hard_link(&outside, &p).unwrap();
        } else {
            std::os::unix::fs::symlink(&outside, &p).unwrap();
        }
        assert!(f
            .ledger
            .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
            .is_err());
        assert_eq!(fs::read(&outside).unwrap(), before);
    }
}
#[test]
fn fresh_component_open_recovers_original_caller_without_resubmission_and_keeps_clock() {
    for point in ["prepared", "applied"] {
        let mut f = setup();
        f.ledger = f.ledger.with_observer(Arc::new(move |stage| {
            if stage == point {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(f
            .ledger
            .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
            .is_err());
        let parts = reopen(f.root.path());
        parts
            .host
            .time
            .store(1735689600000 + 30 * 86_400_000, Ordering::SeqCst);
        let opened = NativeInterference::open(parts.reader, parts.journal).unwrap();
        assert_eq!(opened.recover_pending(&Cancel::never()).unwrap(), 0);
        assert!(
            (parts
                .store
                .get("00000000-0000-4000-8000-000000000002")
                .unwrap()
                .unwrap()
                .memory_strength
                .as_f64()
                .unwrap()
                - 0.72)
                .abs()
                < 1e-12
        );
    }
}
#[cfg(unix)]
#[test]
fn interference_sigkill_child() {
    let Some(root) = std::env::var_os("PLUR1BUS_INTERFERENCE_TEST_ROOT") else {
        return;
    };
    let point = std::env::var("PLUR1BUS_INTERFERENCE_TEST_POINT").unwrap();
    let parts = reopen(std::path::Path::new(&root));
    let request = InterferenceRequest {
        operation_id: uuid::Uuid::new_v4(),
        source: parts
            .store
            .get_record("00000000-0000-4000-8000-000000000001")
            .unwrap()
            .unwrap(),
        options: InterferenceOptions::default(),
    };
    let adapter = NativeInterference::new(parts.reader, parts.journal).with_observer(Arc::new(
        move |stage| {
            if stage == point {
                unsafe {
                    libc::kill(libc::getpid(), libc::SIGKILL);
                }
            }
            Ok(())
        },
    ));
    adapter
        .apply(&request, &parts.principal, &parts.agent, &Cancel::never())
        .unwrap();
    panic!("fault boundary not reached");
}
#[cfg(unix)]
#[test]
fn sigkill_after_plan_patch_or_completion_reopens_without_double_weakening() {
    use std::os::unix::process::ExitStatusExt;
    for point in ["prepared", "applied", "complete"] {
        let f = setup();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                std::any::type_name_of_val(&interference_sigkill_child)
                    .split_once("::")
                    .map_or("", |(_, name)| name),
                "--nocapture",
            ])
            .env("PLUR1BUS_INTERFERENCE_TEST_ROOT", f.root.path())
            .env("PLUR1BUS_INTERFERENCE_TEST_POINT", point)
            .status()
            .unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        let parts = reopen(f.root.path());
        let adapter = NativeInterference::open(parts.reader, parts.journal).unwrap();
        assert_eq!(adapter.recover_pending(&Cancel::never()).unwrap(), 0);
        assert!(
            (parts
                .store
                .get("00000000-0000-4000-8000-000000000002")
                .unwrap()
                .unwrap()
                .memory_strength
                .as_f64()
                .unwrap()
                - 0.72)
                .abs()
                < 1e-12,
            "{point}"
        );
    }
}
#[test]
fn another_operation_cannot_prepare_over_an_unfinished_interference_plan() {
    let mut f = setup();
    let stop = Arc::new(AtomicBool::new(true));
    let trigger = stop.clone();
    f.ledger = f.ledger.with_observer(Arc::new(move |stage| {
        if stage == "prepared" && trigger.load(Ordering::SeqCst) {
            Err(StoreError::Unavailable.into())
        } else {
            Ok(())
        }
    }));
    assert!(f
        .ledger
        .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
        .is_err());
    let original = f.request.operation_id;
    f.request.operation_id = uuid::Uuid::new_v4();
    stop.store(false, Ordering::SeqCst);
    assert!(f
        .ledger
        .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
        .is_err());
    f.request.operation_id = original;
    assert_eq!(
        f.ledger
            .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
            .unwrap()
            .affected,
        1
    );
}

#[path = "support/interference_recovery_cases.rs"]
mod recovery_cases;
