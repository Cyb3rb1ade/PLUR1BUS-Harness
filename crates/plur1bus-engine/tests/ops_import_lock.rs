//! Import/link lock admission, cancellation and ownership fencing on real files.
#![allow(clippy::unwrap_used, reason = "lock invariants fail immediately")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    contract::{Cancel, EngineError},
    ops::import_lock,
    store::{ledger::JsonlLedger, lock::Lock},
};
use std::{
    fs,
    sync::mpsc,
    time::{Duration, SystemTime},
};
fn code(e: EngineError) -> String {
    match e {
        EngineError::MemoryOp(e) => e.code.to_string(),
        _ => String::new(),
    }
}
#[test]
fn cancelled_waiter_does_not_block_the_next_writer_or_create_on_pre_cancel() {
    let root = support::canonical_tempdir();
    let base = root.path().join("store");
    fs::create_dir(&base).unwrap();
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(matches!(
        import_lock::acquire(&base, "agent", &cancel, Duration::from_secs(2)),
        Err(EngineError::Cancelled(_))
    ));
    assert!(!base.join("_imports").exists());
    let held =
        import_lock::acquire(&base, "agent", &Cancel::never(), Duration::from_secs(2)).unwrap();
    let cancel = Cancel::never();
    let child_cancel = cancel.clone();
    let child_base = base.clone();
    let (tx, rx) = mpsc::channel();
    let child = std::thread::spawn(move || {
        tx.send(
            import_lock::acquire(&child_base, "agent", &child_cancel, Duration::from_secs(5))
                .err()
                .unwrap(),
        )
        .unwrap();
    });
    cancel.cancel();
    assert!(matches!(
        rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        EngineError::Cancelled(_)
    ));
    child.join().unwrap();
    assert!(held.assert_held().is_ok());
    drop(held);
    assert!(import_lock::acquire(&base, "agent", &Cancel::never(), Duration::from_secs(1)).is_ok());
}
#[test]
fn deadline_and_replaced_nonce_fence_all_later_mutations() {
    let root = support::canonical_tempdir();
    let base = root.path().join("store");
    fs::create_dir(&base).unwrap();
    let lease =
        import_lock::acquire(&base, "agent", &Cancel::never(), Duration::from_secs(1)).unwrap();
    let failure = import_lock::acquire(&base, "agent", &Cancel::never(), Duration::from_millis(30))
        .err()
        .unwrap();
    assert_eq!(code(failure), "lock-busy");
    let path = base.join("_imports/.locks/agent.lock");
    let old = fs::read(&path).unwrap();
    let mut foreign: serde_json::Value = serde_json::from_slice(&old).unwrap();
    foreign["nonce"] = serde_json::json!(uuid::Uuid::new_v4().to_string());
    fs::rename(&path, path.with_extension("old")).unwrap();
    let foreign = serde_json::to_vec(&foreign).unwrap();
    fs::write(&path, &foreign).unwrap();
    assert_eq!(code(lease.assert_held().unwrap_err()), "lock-lost");
    drop(lease);
    assert_eq!(fs::read(&path).unwrap(), foreign);
}
#[test]
fn explicit_heartbeat_checks_nonce_and_durable_receipts_preserve_prior_lines() {
    let root = support::canonical_tempdir();
    let path = root.path().join("agent.lock");
    let guard = Lock::try_acquire(&path, Duration::from_secs(30), None)
        .unwrap()
        .unwrap();
    fs::File::open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH))
        .unwrap();
    assert!(guard.heartbeat().unwrap());
    assert!(
        fs::metadata(&path).unwrap().modified().unwrap()
            > SystemTime::UNIX_EPOCH + Duration::from_secs(1)
    );
    let ledger_path = root.path().join("ledger.jsonl");
    fs::write(&ledger_path, b"{\"v\":1}").unwrap();
    let ledger = JsonlLedger::<serde_json::Value>::open(&ledger_path).unwrap();
    ledger.append_durable(&serde_json::json!({"v":2})).unwrap();
    assert_eq!(
        fs::read_to_string(&ledger_path).unwrap(),
        "{\"v\":1}\n{\"v\":2}\n"
    );
    let mut foreign: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    foreign["nonce"] = serde_json::json!(uuid::Uuid::new_v4().to_string());
    fs::write(&path, serde_json::to_vec(&foreign).unwrap()).unwrap();
    fs::File::open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH))
        .unwrap();
    assert!(!guard.heartbeat().unwrap());
    assert_eq!(
        fs::metadata(&path).unwrap().modified().unwrap(),
        SystemTime::UNIX_EPOCH
    );
}
