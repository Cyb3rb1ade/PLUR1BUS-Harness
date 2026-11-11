//! RE-D170: the process snapshot port over this engine's own namespace routes.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "isolated fixture errors are fatal"
)]

use super::*;
use crate::{
    contract::{testing::FakeHost, SnapshotFailure, SnapshotGrant, SnapshotMethod, SnapshotOps},
    rpc::snapshot::ProcessSnapshots,
    store::Store,
};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

const LIVE: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "33333333-3333-4333-8333-333333333333";
const CHILD: &str = "PLUR1BUS_RX_REGISTRY_LOCK_CHILD";

fn temp() -> tempfile::TempDir {
    tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}

fn host(state: &Path, config: Value) -> Arc<FakeHost> {
    let host = Arc::new(FakeHost::new(
        state.to_owned(),
        serde_json::from_value(config).unwrap(),
    ));
    host.set_now_ms(10_000);
    host
}

fn tombstone(id: &str, status: &str, tombstone: &str) -> Value {
    json!({"schemaVersion":1,"tombstoneId":tombstone,"memoryId":id,"canonicalOriginId":id,
        "agentId":"agent","scope":"agent-private","deletedAt":"1970-01-01T00:00:01.000Z",
        "actor":"principal:agent","actorType":"human","reason":"MemoryOps.forget",
        "sourceOp":"forget","contentFingerprint":"a".repeat(64),"status":status})
}

/// The registry of `base`, as `forget` writes it: `<parent of base>/_tombstones/<agent>.jsonl`.
fn registry(base: &Path, lines: &[Value]) -> PathBuf {
    let dir = base.parent().unwrap().join("_tombstones");
    crate::store::paths::secure_dir(&dir).unwrap();
    let path = dir.join("agent.jsonl");
    let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
    std::fs::write(&path, text).unwrap();
    path
}

fn table(path: &Path, identity: &VectorSpaceIdentity, width: usize, ids: &[&str]) -> Store {
    let store = Store::create(path, identity, width).unwrap();
    let rows: Vec<_> = ids
        .iter()
        .map(|id| {
            let mut row = adopt_tests::row(vec![1.; width]);
            row.id = (*id).into();
            row.created_at = 2_000.into();
            row
        })
        .collect();
    store.upsert(&rows).unwrap();
    store
}

fn reapply(snapshots: &ProcessSnapshots) -> Result<Value, SnapshotFailure> {
    snapshots.reapply(&SnapshotGrant::for_test(Cancel::never()), &Cancel::never())
}

fn entry(id: &str) -> Value {
    json!({"agent":"agent","memoryId":id})
}

#[test]
fn reapply_hits_the_selected_generation_and_never_the_legacy_root() {
    let temp = temp();
    let base = temp.path().join("db/current");
    let state = temp.path().join("state");
    let control = ProcessEngine::new(
        host(
            &state,
            json!({"baseDbPath":base,"namespaces":{"activeWriteNamespace":"current"}}),
        ),
        Some(Seam::FlatEmbedder),
    )
    .unwrap();
    let envelope = control.embedding().identities().remove(0);
    let identity = envelope.space.clone().unwrap();
    let width = envelope.dimensions.as_u64().unwrap() as usize;
    let generation = temp.path().join("db/generations/selected");
    let legacy = table(&base.join("agent"), &identity, width, &[LIVE]);
    let selected = table(&generation.join("current/agent"), &identity, width, &[LIVE]);
    std::fs::write(
        generation.join("generation.json"),
        serde_json::to_vec(&json!({"schemaVersion":1,"generation":"selected",
            "fingerprintId":envelope.fingerprint_id,"dimensions":width,
            "tables":{"agent/memories":{"sourceVersion":"1","sourceRows":1,"writtenRows":1}}}))
        .unwrap(),
    )
    .unwrap();
    let file = registry(&base, &[tombstone(LIVE, "committed", LIVE)]);
    let before = std::fs::read(&file).unwrap();
    let host = host(
        &state,
        json!({"baseDbPath":base,"namespaces":{"activeWriteNamespace":"current"},
        "reembedding":{"activeGeneration":"selected","fingerprintId":envelope.fingerprint_id,
            "dimensions":width}}),
    );
    let process = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    let snapshots = ProcessSnapshots::new(host, process.snapshot_routes());
    let first = reapply(&snapshots).unwrap();
    assert_eq!(first["applied"], json!([entry(LIVE)]), "{first}");
    assert_eq!(first["activeAfterReapply"], json!([]));
    let row = selected.get(LIVE).unwrap().unwrap();
    assert_eq!(
        (row.status.as_str(), row.epistemic_status.as_str()),
        ("deleted", "invalidated")
    );
    assert_eq!(legacy.get(LIVE).unwrap().unwrap().status, "active");
    let second = reapply(&snapshots).unwrap();
    assert_eq!(second["alreadyTombstoned"], json!([entry(LIVE)]));
    assert_eq!(second["applied"], json!([]));
    assert_eq!(std::fs::read(&file).unwrap(), before);
    let audit = std::fs::read_to_string(state.join("engine-maintenance.jsonl")).unwrap();
    assert_eq!(audit.lines().count(), 2);
    for line in audit.lines() {
        let line: Value = serde_json::from_str(line).unwrap();
        assert_eq!(line["target"], json!({}));
        assert_eq!(line["coreLink"], "test-core-link");
    }
}

#[test]
fn reapply_in_namespace_mode_uses_the_named_writer() {
    let temp = temp();
    let base = temp.path().join("db");
    let state = temp.path().join("state");
    let host = host(
        &state,
        json!({"baseDbPath":base,"namespaces":{"activeWriteNamespace":"current",
            "legacyReadOnlyNamespaces":["legacy"],"crossNamespaceRecall":true}}),
    );
    let process = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    let envelope = process.embedding().identities().remove(0);
    let identity = envelope.space.clone().unwrap();
    let width = envelope.dimensions.as_u64().unwrap() as usize;
    let writer = table(
        &base.join("current/agent"),
        &identity,
        width,
        &[LIVE, OTHER],
    );
    let legacy = table(&base.join("legacy/agent"), &identity, width, &[LIVE]);
    let root = table(&base.join("agent"), &identity, width, &[LIVE]);
    registry(
        &base,
        &[
            tombstone(LIVE, "committed", LIVE),
            tombstone(OTHER, "attempted", OTHER),
        ],
    );
    let snapshots = ProcessSnapshots::new(host, process.snapshot_routes());
    let report = reapply(&snapshots).unwrap();
    assert_eq!(report["applied"], json!([entry(LIVE)]), "{report}");
    assert_eq!(writer.get(LIVE).unwrap().unwrap().status, "deleted");
    // An attempted tombstone whose row survived young stays pending: never reapplied.
    assert_eq!(writer.get(OTHER).unwrap().unwrap().status, "active");
    assert_eq!(legacy.get(LIVE).unwrap().unwrap().status, "active");
    assert_eq!(root.get(LIVE).unwrap().unwrap().status, "active");
}

#[test]
fn composition_concurrency_and_close_answer_at_once() {
    let temp = temp();
    let state = temp.path().join("state");
    let reason = |result: Result<Value, SnapshotFailure>| match result.unwrap_err() {
        SnapshotFailure::Engine(EngineError::NotAvailable { reason }) => reason,
        other => panic!("{other:?}"),
    };
    // Without a store base nothing is composed: no audit, no root, no registry read.
    let host_without = host(&state, json!({}));
    let bare = ProcessEngine::new(host_without.clone(), Some(Seam::FlatEmbedder)).unwrap();
    let snapshots = ProcessSnapshots::new(host_without, bare.snapshot_routes());
    let grant = SnapshotGrant::for_test(Cancel::never());
    let out = state.join("backup-staging");
    assert_eq!(
        reason(snapshots.create(&grant, &out, &Cancel::never())),
        "composition-pending"
    );
    assert_eq!(
        reason(snapshots.verify(&grant, &out.join("plur1bus-x"), &Cancel::never())),
        "composition-pending"
    );
    assert_eq!(reason(reapply(&snapshots)), "composition-pending");
    assert!(!state.exists());

    let base = temp.path().join("db");
    let host = host(&state, json!({"baseDbPath":base}));
    let process = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    let snapshots = ProcessSnapshots::new(host, process.snapshot_routes());
    snapshots.set_running(true, true);
    let started = Instant::now();
    assert_eq!(
        reason(snapshots.create(&grant, &out, &Cancel::never())),
        "engine-busy"
    );
    assert_eq!(reason(reapply(&snapshots)), "engine-busy");
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(!state.exists(), "a refused call writes no audit line");
    snapshots.set_running(false, false);
    // No store root yet: nothing is created, the empty registry reports nothing.
    let empty = reapply(&snapshots).unwrap();
    assert_eq!(empty["applied"], json!([]));
    assert!(!base.exists());
    // A revoked grant and a closed engine start nothing.
    let revoked = Cancel::never();
    revoked.cancel();
    assert!(matches!(
        snapshots.reapply(&SnapshotGrant::for_test(revoked), &Cancel::never()),
        Err(SnapshotFailure::Engine(EngineError::Cancelled(_)))
    ));
    let audit = || std::fs::read_to_string(state.join("engine-maintenance.jsonl")).unwrap();
    let audited = audit();
    process.close(None).unwrap();
    // N1: after close an invalid call is refused as closed and writes no audit line.
    for method in [SnapshotMethod::Create, SnapshotMethod::Reapply] {
        let refused = snapshots
            .refuse(&grant, method, &Cancel::never())
            .map(|()| Value::Null);
        assert_eq!(reason(refused), "closed");
    }
    assert_eq!(audit(), audited);
    assert_eq!(reason(reapply(&snapshots)), "closed");
    assert_eq!(
        reason(snapshots.create(&grant, &out, &Cancel::never())),
        "closed"
    );
    assert!(!out.exists());
}

/// Child half of the E9 test: hold the registry lock, report it, wait to be killed.
#[test]
fn registry_lock_holder_child() {
    let Some(lock) = std::env::var_os(CHILD).map(PathBuf::from) else {
        return;
    };
    let guard = crate::store::lock::Lock::try_acquire(&lock, Duration::from_secs(10), None)
        .unwrap()
        .unwrap();
    std::fs::write(lock.with_extension("held"), b"").unwrap();
    loop {
        std::thread::park();
        let _ = &guard;
    }
}

/// E9: a registry lock left by a killed process is not stale for `LOCK_STALE` (10 s); recovery
/// then reports `startup-recovery-incomplete` (fail closed). Once the lock is older, the
/// same call recovers. The lock age is set on the file, not waited for.
#[cfg(unix)]
#[test]
fn a_registry_lock_left_by_a_killed_process_blocks_recovery_until_it_is_stale() {
    let temp = temp();
    let base = temp.path().join("db");
    let state = temp.path().join("state");
    let host = host(&state, json!({"baseDbPath":base}));
    let process = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    let envelope = process.embedding().identities().remove(0);
    let identity = envelope.space.clone().unwrap();
    let width = envelope.dimensions.as_u64().unwrap() as usize;
    let store = table(&base.join("agent"), &identity, width, &[LIVE]);
    store
        .patch(
            LIVE,
            &crate::store::RowPatch {
                status: Some("deleted".into()),
                ..crate::store::RowPatch::default()
            },
        )
        .unwrap();
    // An interrupted forget: attempted, the row already deleted, committed still missing.
    let file = registry(&base, &[tombstone(LIVE, "attempted", LIVE)]);
    let lock = file.with_extension("jsonl.lock");
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "rpc::engine::snapshot_tests::registry_lock_holder_child",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD, &lock)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !lock.with_extension("held").exists() {
        assert!(child.try_wait().unwrap().is_none(), "the holder exited");
        assert!(Instant::now() < deadline, "the holder never took the lock");
        std::thread::yield_now();
    }
    child.kill().unwrap();
    let status = child.wait().unwrap();
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(status.signal(), Some(libc::SIGKILL));
    assert!(lock.exists(), "a killed holder leaves its lock behind");
    // As a restart right after the kill: the lock is fresh.
    std::fs::File::open(&lock)
        .unwrap()
        .set_modified(SystemTime::now())
        .unwrap();
    let snapshots = ProcessSnapshots::new(host, process.snapshot_routes());
    match reapply(&snapshots).unwrap_err() {
        SnapshotFailure::Engine(EngineError::NotAvailable { reason }) => {
            assert_eq!(reason, "startup-recovery-incomplete");
        }
        other => panic!("{other:?}"),
    }
    let registry_text = std::fs::read_to_string(&file).unwrap();
    assert_eq!(registry_text.lines().count(), 1, "nothing was appended");
    // Older than LOCK_STALE and its holder gone: the same call recovers.
    std::fs::File::open(&lock)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(11))
        .unwrap();
    let report = reapply(&snapshots).unwrap();
    assert_eq!(
        report["alreadyTombstoned"],
        json!([entry(LIVE)]),
        "{report}"
    );
    let lines: Vec<Value> = std::fs::read_to_string(&file)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        lines
            .iter()
            .map(|l| l["status"].clone())
            .collect::<Vec<_>>(),
        [json!("attempted"), json!("committed")]
    );
    assert!(!lock.exists());
}
