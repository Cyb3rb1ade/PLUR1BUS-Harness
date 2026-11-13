//! RE-D170 / inventory 8: SIGKILL inside tombstone recovery (`reconcile`) and inside the
//! committed-tombstone reapply. A child process (this test binary) halts at a chosen point,
//! the parent kills it and finishes the work in a fresh run; a third run has nothing left.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    contract::{Cancel, StoreError, VectorSpaceIdentity},
    embedding::EmbeddingProvider,
    ops::{
        tombstone_reapply::{reapply, GenerationReapplyTarget, ReapplyMutation, ReapplyTarget},
        tombstones::{reconcile, ActiveGenerationLookup, TombstoneLookup},
    },
    recall::hash_embed::HashEmbedder,
    store::{tombstone::TombstoneRegistry, OpenMode, Store},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

const ROOT: &str = "PLUR1BUS_RX_TOMBSTONE_CRASH_ROOT";
const PHASE: &str = "PLUR1BUS_RX_TOMBSTONE_CRASH_PHASE";
const NOW: i64 = 1_800_000_000_000;
const IDS: [&str; 3] = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
];

fn identity() -> VectorSpaceIdentity {
    let mut identity = HashEmbedder::new().identity().clone();
    identity.dimension = 4.into();
    identity
}

fn base(root: &Path) -> PathBuf {
    root.join("store")
}

fn line(id: &str, status: &str) -> String {
    json!({"schemaVersion":1,"tombstoneId":format!("t-{id}"),"memoryId":id,"canonicalOriginId":id,
        "agentId":"agent","scope":"agent-private","deletedAt":"2026-01-13T12:00:00.000Z",
        "actor":"principal:agent","actorType":"human","reason":"MemoryOps.forget",
        "sourceOp":"forget","contentFingerprint":"a".repeat(64),"status":status,
        "future":"kept"})
    .to_string()
}

/// Three rows and one registry line per row; `deleted` rows model forgets interrupted after
/// their row patch, `active` rows a restored snapshot.
fn setup(root: &Path, row_status: &str, tombstone_status: &str) -> PathBuf {
    let store = Store::create(&base(root).join("agent"), &identity(), 4).unwrap();
    let rows: Vec<_> = IDS
        .iter()
        .map(|id| {
            let mut row = support::memory_row(id, "agent", "agent-private");
            row.vector = vec![0.; 4];
            row.status = row_status.into();
            row
        })
        .collect();
    store.upsert(&rows).unwrap();
    let registry = TombstoneRegistry::new(&base(root), "agent").unwrap();
    let path = registry.path().to_owned();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let text: String = IDS
        .iter()
        .map(|id| line(id, tombstone_status) + "\n")
        .collect();
    fs::write(&path, text).unwrap();
    path
}

/// Halts the child at the `n`-th call of the chosen kind: it writes `checkpoint`, then waits
/// to be killed.
struct Halt<'a, T> {
    inner: &'a T,
    root: &'a Path,
    status_halt: Option<usize>,
    tombstone_halt: Option<usize>,
    statuses: AtomicUsize,
    tombstones: AtomicUsize,
}
impl<T> Halt<'_, T> {
    fn maybe(&self, counter: &AtomicUsize, at: Option<usize>) {
        let call = counter.fetch_add(1, Ordering::SeqCst) + 1;
        if at == Some(call) {
            let staged = self.root.join(".checkpoint");
            fs::write(&staged, call.to_string()).unwrap();
            fs::rename(staged, self.root.join("checkpoint")).unwrap();
            loop {
                std::thread::park();
            }
        }
    }
}
impl<T: TombstoneLookup> TombstoneLookup for Halt<'_, T> {
    fn agent_exists(&self, agent: &str) -> Result<bool, StoreError> {
        self.inner.agent_exists(agent)
    }
    fn status(&self, agent: &str, id: &str) -> Result<Option<String>, StoreError> {
        self.maybe(&self.statuses, self.status_halt);
        self.inner.status(agent, id)
    }
}
impl<T: ReapplyTarget> ReapplyTarget for Halt<'_, T> {
    fn tombstone(&self, agent: &str, id: &str) -> Result<ReapplyMutation, StoreError> {
        self.maybe(&self.tombstones, self.tombstone_halt);
        self.inner.tombstone(agent, id)
    }
}

/// The child half: runs only when the parent selected a phase.
#[test]
fn crash_child() {
    let (Some(root), Ok(phase)) = (std::env::var_os(ROOT), std::env::var(PHASE)) else {
        return;
    };
    let root = PathBuf::from(root);
    let cancel = Cancel::never();
    match phase.as_str() {
        // 1: after the registry read and repair, before the first status.
        // 2: inside the second status, after the first committed append.
        "reconcile-1" | "reconcile-2" => {
            let lookup = ActiveGenerationLookup::open(&base(&root), &identity()).unwrap();
            let halt = Halt {
                inner: &lookup,
                root: &root,
                status_halt: Some(if phase == "reconcile-1" { 1 } else { 2 }),
                tombstone_halt: None,
                statuses: AtomicUsize::new(0),
                tombstones: AtomicUsize::new(0),
            };
            reconcile(&base(&root), &halt, NOW, &cancel).unwrap();
        }
        // After the second applied row, and in the verification loop after all three.
        "reapply-applied" | "reapply-verify" => {
            let target =
                GenerationReapplyTarget::open(&base(&root), &identity(), OpenMode::ReadWrite)
                    .unwrap();
            let halt = Halt {
                inner: &target,
                root: &root,
                status_halt: (phase == "reapply-verify").then_some(1),
                tombstone_halt: (phase == "reapply-applied").then_some(3),
                statuses: AtomicUsize::new(0),
                tombstones: AtomicUsize::new(0),
            };
            reapply(&base(&root), &halt, true, &cancel).unwrap();
        }
        other => panic!("unknown phase {other}"),
    }
    panic!("the child passed its halt point");
}

fn killed(root: &Path, phase: &str) -> usize {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            std::any::type_name_of_val(&crash_child)
                .split_once("::")
                .map_or("", |(_, name)| name),
            "--nocapture",
            "--test-threads=1",
        ])
        .env(ROOT, root)
        .env(PHASE, phase)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let checkpoint = root.join("checkpoint");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !checkpoint.exists() {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("{phase}: the child exited before its halt point: {status}");
        }
        assert!(Instant::now() < deadline, "{phase}: no checkpoint");
        std::thread::sleep(Duration::from_millis(5));
    }
    child.kill().unwrap();
    let status = child.wait().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(libc::SIGKILL), "{phase}");
    }
    #[cfg(not(unix))]
    assert!(!status.success());
    fs::read_to_string(&checkpoint).unwrap().parse().unwrap()
}

fn statuses(path: &Path) -> Vec<(String, String)> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| {
            let value: Value = serde_json::from_str(line).unwrap();
            assert_eq!(value["future"], "kept", "unknown fields survive");
            (
                value["memoryId"].as_str().unwrap().to_owned(),
                value["status"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[test]
fn sigkill_inside_reconcile_is_completed_by_the_next_run_without_duplicates() {
    for (phase, appended_before_kill) in [("reconcile-1", 0), ("reconcile-2", 1)] {
        let temp = support::canonical_tempdir();
        let root = temp.path();
        let registry = setup(root, "deleted", "attempted");
        let before = fs::read(&registry).unwrap();
        killed(root, phase);
        let after_kill = statuses(&registry);
        assert_eq!(after_kill.len(), 3 + appended_before_kill, "{phase}");
        assert!(fs::read(&registry).unwrap().starts_with(&before));
        assert!(!registry.with_extension("jsonl.lock").exists(), "{phase}");

        let lookup = ActiveGenerationLookup::open(&base(root), &identity()).unwrap();
        let second = reconcile(&base(root), &lookup, NOW, &Cancel::never()).unwrap();
        assert_eq!(second.committed.len(), 3 - appended_before_kill, "{phase}");
        assert!(second.errors.is_empty() && second.registry_errors.is_empty());
        let third = reconcile(&base(root), &lookup, NOW, &Cancel::never()).unwrap();
        assert_eq!(
            serde_json::to_value(&third).unwrap(),
            json!({"committed":[],"abandoned":[],"pending":[],"rowMissing":[],"errors":[],
                "registryErrors":[]}),
            "{phase}"
        );
        let mut lines = statuses(&registry);
        lines.sort();
        let mut expected: Vec<_> = IDS
            .iter()
            .flat_map(|id| {
                [
                    (id.to_string(), "attempted".to_owned()),
                    (id.to_string(), "committed".to_owned()),
                ]
            })
            .collect();
        expected.sort();
        assert_eq!(
            lines, expected,
            "{phase}: exactly one committed line per id"
        );
    }
}

#[test]
fn sigkill_inside_reapply_converges_on_the_next_run() {
    for (phase, applied_before_kill) in [("reapply-applied", 2), ("reapply-verify", 3)] {
        let temp = support::canonical_tempdir();
        let root = temp.path();
        let registry = setup(root, "active", "committed");
        let before = fs::read(&registry).unwrap();
        killed(root, phase);
        let store = Store::open(&base(root).join("agent"), OpenMode::ReadOnly, None).unwrap();
        let deleted = IDS
            .iter()
            .filter(|id| store.get(id).unwrap().unwrap().status == "deleted")
            .count();
        assert_eq!(deleted, applied_before_kill, "{phase}");
        drop(store);

        let target =
            GenerationReapplyTarget::open(&base(root), &identity(), OpenMode::ReadWrite).unwrap();
        let second = reapply(&base(root), &target, true, &Cancel::never()).unwrap();
        assert!(!second.failed(), "{phase}: {second:?}");
        assert_eq!(second.applied.len(), 3 - applied_before_kill, "{phase}");
        assert_eq!(
            second.already_tombstoned.len(),
            applied_before_kill,
            "{phase}"
        );
        let third = reapply(&base(root), &target, true, &Cancel::never()).unwrap();
        assert!(third.applied.is_empty() && !third.failed(), "{phase}");
        assert_eq!(third.already_tombstoned.len(), 3);
        // Reapply never writes the registry.
        assert_eq!(fs::read(&registry).unwrap(), before, "{phase}");
        let store = Store::open(&base(root).join("agent"), OpenMode::ReadOnly, None).unwrap();
        for id in IDS {
            let row = store.get(id).unwrap().unwrap();
            assert_eq!(row.status, "deleted");
            assert_eq!(row.epistemic_status, "invalidated");
        }
    }
}
