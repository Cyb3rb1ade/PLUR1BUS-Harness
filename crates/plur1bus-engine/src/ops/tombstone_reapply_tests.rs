//! RE-D170: the namespace reapply target takes the engine-wide mutation gate per row patch,
//! waits for it at most once per run, and does nothing after close.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "fixture errors are fatal"
)]
use super::*;
use crate::{
    contract::{testing::FakeHost, MemoryRow},
    embedding::EmbeddingProvider,
    ops::context::OperationContext,
    recall::{hash_embed::HashEmbedder, namespaces::NamespaceStores},
    store::Store,
};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const IDS: [&str; 3] = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
];
const CRASH_ROOT: &str = "PLUR1BUS_RX_NAMESPACE_REAPPLY_CRASH_ROOT";

fn row(id: &str) -> MemoryRow {
    let schema: Value =
        serde_json::from_str(include_str!("../../schema/engine-contract.schema.json")).unwrap();
    let mut fields = serde_json::Map::new();
    for (name, definition) in schema["$defs"]["MemoryRow"]["properties"]
        .as_object()
        .unwrap()
    {
        fields.insert(
            name.clone(),
            match definition["type"].as_str().unwrap() {
                "string" => json!(""),
                "number" => json!(0),
                "boolean" => json!(false),
                "array" => json!([]),
                _ => Value::Null,
            },
        );
    }
    let mut row: MemoryRow = serde_json::from_value(Value::Object(fields)).unwrap();
    row.id = id.into();
    row.agent_id = "agent".into();
    row.scope = "agent-private".into();
    row.status = "active".into();
    row.vector = vec![0.; 384];
    row
}

/// Three active rows in the named writer and one committed tombstone per row.
fn populate(root: &Path) -> PathBuf {
    let base = root.join("db");
    let store = Store::create(
        &base.join("current/agent"),
        HashEmbedder::new().identity(),
        384,
    )
    .unwrap();
    store.upsert(&IDS.map(row)).unwrap();
    let registry = root.join("_tombstones");
    crate::store::paths::secure_dir(&registry).unwrap();
    let lines: String = IDS
        .iter()
        .map(|id| {
            format!(
                "{}\n",
                json!({"schemaVersion":1,"tombstoneId":id,"memoryId":id,"agentId":"agent",
                    "scope":"agent-private","contentFingerprint":"a".repeat(64),
                    "status":"committed"})
            )
        })
        .collect();
    fs::write(registry.join("agent.jsonl"), lines).unwrap();
    base
}

fn routes(root: &Path, base: &Path) -> (Arc<NamespaceStores>, Arc<OperationContext>) {
    let config =
        serde_json::from_value(json!({"namespaces":{"activeWriteNamespace":"current"}})).unwrap();
    let stores =
        Arc::new(NamespaceStores::open(base, &config, HashEmbedder::new().identity(), 8).unwrap());
    let host = Arc::new(FakeHost::new(
        root.join("state"),
        serde_json::from_value(json!({})).unwrap(),
    ));
    (stores, Arc::new(OperationContext::new(host)))
}

struct Fixture {
    temp: tempfile::TempDir,
    base: PathBuf,
    stores: Arc<NamespaceStores>,
    gate: Arc<OperationContext>,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let base = populate(temp.path());
        Self::open(temp, base)
    }
    fn open(temp: tempfile::TempDir, base: PathBuf) -> Self {
        let (stores, gate) = routes(temp.path(), &base);
        Self {
            temp,
            base,
            stores,
            gate,
        }
    }
    /// A new target per run, as the process builds one per call.
    fn run(&self) -> ReapplyReport {
        let target = NamespaceReapplyTarget::new(self.stores.clone(), self.gate.clone());
        reapply(&self.base, &target, true, &Cancel::never()).unwrap()
    }
    fn status(&self, id: &str) -> String {
        self.stores
            .existing_write_store("agent")
            .unwrap()
            .unwrap()
            .get(id)
            .unwrap()
            .unwrap()
            .status
    }
    fn registry(&self) -> Vec<u8> {
        fs::read(self.temp.path().join("_tombstones/agent.jsonl")).unwrap()
    }
}

fn errors(report: &ReapplyReport) -> Value {
    serde_json::to_value(&report.errors).unwrap()
}

fn all(error: &str) -> Vec<Value> {
    IDS.iter()
        .map(|id| json!({"agent":"agent","memoryId":id,"error":error}))
        .collect()
}

#[test]
fn a_held_gate_is_one_busy_entry_per_id_and_a_new_run_converges() {
    let fixture = Fixture::new();
    fixture.gate.set_mutation_wait(Duration::from_millis(20));
    let held = fixture.gate.mutation().unwrap();
    let report = fixture.run();
    assert!(report.failed());
    assert_eq!(errors(&report), json!(all("busy")));
    assert_eq!(report.active_after_reapply.len(), 3);
    assert_eq!(
        fixture.gate.mutation_waiters(),
        0,
        "no caller is left waiting"
    );
    assert_eq!(fixture.status(IDS[0]), "active");
    drop(held);

    let retry = fixture.run();
    assert!(!retry.failed(), "{retry:?}");
    assert_eq!(retry.applied.len(), 3);
    assert!(IDS.iter().all(|id| fixture.status(id) == "deleted"));
}

/// I1: the real gate wait, injected as a small but measurable value. Three ids behind a held
/// gate cost one wait for the run, never one wait per id.
#[test]
fn a_held_gate_costs_one_wait_per_run_not_one_per_id() {
    let fixture = Fixture::new();
    let wait = Duration::from_millis(400);
    fixture.gate.set_mutation_wait(wait);
    let held = fixture.gate.mutation().unwrap();
    let started = Instant::now();
    let report = fixture.run();
    let elapsed = started.elapsed();
    assert!(
        elapsed >= wait,
        "the first id waited for the gate: {elapsed:?}"
    );
    assert!(
        elapsed < 2 * wait,
        "one gate wait per run, took {elapsed:?}"
    );
    assert_eq!(errors(&report), json!(all("busy")));
    drop(held);
    // The latch belongs to that run: the next one takes the gate again.
    assert_eq!(fixture.run().applied.len(), 3);
}

/// M2: a close during the run: no further patch passes and the verification reads no row.
#[test]
fn after_close_neither_the_patch_nor_the_verification_reads_a_row() {
    let fixture = Fixture::new();
    let mut target = NamespaceReapplyTarget::new(fixture.stores.clone(), fixture.gate.clone());
    let gate = fixture.gate.clone();
    // The engine closes while the first patch holds the gate; that patch still completes.
    target.after_gate = Some(Box::new(move || {
        gate.close_within(Duration::ZERO);
    }));
    let report = reapply(&fixture.base, &target, true, &Cancel::never()).unwrap();
    assert_eq!(
        serde_json::to_value(&report.applied).unwrap(),
        json!([{"agent":"agent","memoryId":IDS[0]}])
    );
    let mut expected: Vec<Value> = all("storage").into_iter().skip(1).collect();
    expected.extend(all("verify: storage"));
    assert_eq!(errors(&report), json!(expected));
    assert!(report.active_after_reapply.is_empty());
    assert!(report.failed());
    let stores = &fixture.stores;
    let store = stores.existing_write_store("agent").unwrap().unwrap();
    let states: Vec<_> = IDS
        .iter()
        .map(|id| store.get(id).unwrap().unwrap().status)
        .collect();
    assert_eq!(states, ["deleted", "active", "active"]);
}

/// Fix 2: a reapply after close opens no store and repairs no torn registry tail (a write);
/// the run fails closed and the registry bytes stay unchanged.
#[test]
fn a_reapply_after_close_opens_nothing_and_writes_nothing() {
    let fixture = Fixture::new();
    let registry = fixture.temp.path().join("_tombstones/agent.jsonl");
    let mut torn = fs::read(&registry).unwrap();
    torn.extend_from_slice(b"{\"schemaVersion\":1,\"memoryId\":\"torn");
    fs::write(&registry, &torn).unwrap();
    fixture.gate.close_within(Duration::ZERO);
    let report = fixture.run();
    assert!(report.failed());
    assert!(report.applied.is_empty() && report.already_tombstoned.is_empty());
    assert!(report.errors.is_empty() && report.active_after_reapply.is_empty());
    assert_eq!(report.registry_errors.len(), 1, "{report:?}");
    assert_eq!(fs::read(&registry).unwrap(), torn, "no tail repair");
    assert!(!registry.with_extension("corrupt.log").exists());
    // Without a torn tail the closed target answers before any store is opened.
    let clean = Fixture::new();
    clean.gate.close_within(Duration::ZERO);
    let report = clean.run();
    assert_eq!(
        serde_json::to_value(&report.registry_errors).unwrap(),
        json!([{"agent":"agent","error":"storage"}])
    );
    assert!(report.errors.is_empty() && report.applied.is_empty());
}

/// Child half of M7: the third patch halts after the gate was taken, before the write.
#[test]
fn namespace_reapply_crash_child() {
    let Some(root) = std::env::var_os(CRASH_ROOT).map(PathBuf::from) else {
        return;
    };
    let base = root.join("db");
    let (stores, gate) = routes(&root, &base);
    let mut target = NamespaceReapplyTarget::new(stores, gate);
    let calls = AtomicUsize::new(0);
    let checkpoint = root.join("checkpoint");
    target.after_gate = Some(Box::new(move || {
        if calls.fetch_add(1, Ordering::SeqCst) + 1 == 3 {
            fs::write(&checkpoint, b"").unwrap();
            loop {
                std::thread::park();
            }
        }
    }));
    reapply(&base, &target, true, &Cancel::never()).unwrap();
    panic!("the child passed its halt point");
}

/// M7: SIGKILL with the product target holding the gate, after the second applied row; the
/// next run (a new process, a new gate) converges and a third run has nothing left.
#[test]
fn sigkill_inside_a_gated_namespace_reapply_converges_on_the_next_run() {
    let temp = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let base = populate(temp.path());
    let registry = fs::read(temp.path().join("_tombstones/agent.jsonl")).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "ops::tombstone_reapply::tests::namespace_reapply_crash_child",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CRASH_ROOT, temp.path())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !temp.path().join("checkpoint").exists() {
        assert!(
            child.try_wait().unwrap().is_none(),
            "the child exited early"
        );
        assert!(Instant::now() < deadline, "no checkpoint");
        std::thread::sleep(Duration::from_millis(5));
    }
    child.kill().unwrap();
    let status = child.wait().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(libc::SIGKILL));
    }
    #[cfg(not(unix))]
    assert!(!status.success());

    let fixture = Fixture::open(temp, base);
    assert_eq!(
        IDS.map(|id| fixture.status(id)),
        ["deleted", "deleted", "active"]
    );
    let second = fixture.run();
    assert!(!second.failed(), "{second:?}");
    assert_eq!(second.applied.len(), 1);
    assert_eq!(second.already_tombstoned.len(), 2);
    let third = fixture.run();
    assert!(third.applied.is_empty() && !third.failed());
    assert_eq!(third.already_tombstoned.len(), 3);
    assert_eq!(fixture.registry(), registry);
}
