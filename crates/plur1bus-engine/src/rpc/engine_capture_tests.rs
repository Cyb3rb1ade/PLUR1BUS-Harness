//! Exercise capture through the real process composition, Lance writer, WAL and recall.
#![allow(clippy::unwrap_used, reason = "isolated fixture errors are fatal")]

use super::*;
use crate::{
    contract::{testing::FakeHost, CaptureResult},
    rpc::methods,
    store::{OpenMode, RowFilter, Store},
};
use std::{
    fs,
    path::{Path, PathBuf},
};

const USER: &str =
    "Please remember that the archive test project always uses green labels for completed builds.";
const ASSISTANT: &str = "I recorded the green labels convention.";

fn host(root: &Path) -> Arc<FakeHost> {
    let config = json!({
        "baseDbPath":root.join("db"),
        "neo":{"enabled":false},
        "namespaces":{"activeWriteNamespace":"current"},
        "duplicateThreshold":1.01
    });
    let host = Arc::new(FakeHost::new(
        root.join("state"),
        serde_json::from_value(config).unwrap(),
    ));
    host.set_now_ms(1_768_305_600_000);
    for agent in ["agent", "other"] {
        let workspace = root.join(format!("workspace-{agent}"));
        fs::create_dir_all(&workspace).unwrap();
        host.set_workspace(&agent.parse().unwrap(), workspace);
    }
    host
}

fn principal(agent: &str) -> Value {
    json!({"agentId":agent,"workspace":"workspace:v1:fixture","channel":"cli",
        "accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"inferred"})
}

fn turn_value(agent: &str, run: &str, messages: &Value) -> Value {
    json!({"agentId":agent,"principal":principal(agent),
        "agent":{"origin":"user","background":false},"sessionKey":format!("agent:{agent}:main"),
        "runId":run,"incognito":false,"messages":messages})
}

fn turn(agent: &str, run: &str) -> TurnRecord {
    serde_json::from_value(turn_value(
        agent,
        run,
        &json!([{"role":"user","content":USER},{"role":"assistant","content":ASSISTANT}]),
    ))
    .unwrap()
}

fn options() -> CaptureOptions {
    serde_json::from_value(json!({})).unwrap()
}

fn done(handle: &CaptureHandle) -> Value {
    let result: CaptureResult = handle.done.recv_timeout(Duration::from_secs(60)).unwrap();
    serde_json::to_value(result).unwrap()
}

fn capture(engine: &ProcessEngine, turn: TurnRecord) -> Value {
    // A refused receipt reports its typed reason, not only the generic message.
    let handle = engine
        .capture(turn, options())
        .map_err(|error| match error {
            EngineError::NotAvailable { reason } => reason,
            other => other.to_string(),
        })
        .unwrap();
    done(&handle)
}

fn rows(root: &Path, agent: &str) -> Vec<MemoryRow> {
    let path = root.join("db/current").join(agent);
    if !path.exists() {
        return Vec::new();
    }
    Store::open(&path, OpenMode::ReadOnly, None)
        .unwrap()
        .scan(&RowFilter::default(), 100)
        .unwrap()
}

/// Wait until the background recovery pass that follows the composition has finished
/// (RE-D162): opening returns after the inventory, recovery runs behind it.
fn recovery_settled(engine: &ProcessEngine) {
    assert!(engine.capture.recovered_for_test(Duration::from_secs(180)));
}

#[path = "engine_capture_isolation_tests.rs"]
mod isolation;

#[path = "engine_capture_compaction_tests.rs"]
mod compaction;

/// Every file below the admission root: top-level files and the files inside each owner
/// scope's directory (RE-D162). Lease files are left out.
fn admission_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in fs::read_dir(root.join("db/_capture-admissions"))
        .into_iter()
        .flatten()
        .flatten()
    {
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if entry.path().is_dir() {
            files.extend(
                fs::read_dir(entry.path())
                    .into_iter()
                    .flatten()
                    .flatten()
                    .map(|file| file.path()),
            );
        } else {
            files.push(entry.path());
        }
    }
    files
}

fn memory_params(agent: &str) -> Value {
    json!({"p":principal(agent),"a":{"origin":"user","background":false}})
}

#[test]
fn a_captured_turn_is_visible_through_list_show_and_recall() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let host = host(root);
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    assert_eq!(
        capture(&engine, turn("agent", "run-1")),
        json!({"stored":2,"skipped":0})
    );
    let stored = rows(root, "agent");
    assert_eq!(stored.len(), 2);
    assert!(stored.iter().any(|row| row.text == USER));
    assert!(stored.iter().all(|row| row.stored_by == "agent"));

    let mut request = memory_params("agent");
    request["q"] = json!({"since":0});
    let list =
        methods::dispatch(&engine, "engine.memory.list", &request, &Cancel::never()).unwrap();
    let items = list["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "{list}");
    let mut request = memory_params("agent");
    request["id"] = items[0]["id"].clone();
    let card =
        methods::dispatch(&engine, "engine.memory.show", &request, &Cancel::never()).unwrap();
    assert_eq!(card["id"], items[0]["id"]);

    let recall = methods::dispatch(
        &engine,
        "engine.recall",
        &json!({"query":{"query":"Which labels does the archive test project use?",
            "principal":principal("agent"),"agent":{"origin":"user","background":false}},
            "options":{"reranker":"off"}}),
        &Cancel::never(),
    )
    .unwrap();
    let memories = recall["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|block| block["name"] == "memories")
        .unwrap()["text"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(memories.contains("green labels"), "{memories}");
    // Capture and recall committed through the same bound mood store.
    assert!(root.join("workspace-agent/.emotional-state.json").is_file());
    // Capture, recall, journal, job registry and schema marker are composed (RE-D157).
    let status = engine.status();
    assert!(status.ready);
    assert!(engine.capture.degradation().is_none());
    assert!(status
        .degraded
        .is_none_or(|degraded| degraded.reason != "startup-recovery-incomplete"));
    engine.close(None).unwrap();
    assert_eq!(engine.status().degraded.unwrap().reason, "closed");
}

#[test]
fn replaying_the_same_run_is_idempotent() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    assert_eq!(capture(&engine, turn("agent", "run-1"))["stored"], 2);
    let ids = rows(root, "agent")
        .into_iter()
        .map(|row| row.id)
        .collect::<Vec<_>>();
    assert_eq!(
        capture(&engine, turn("agent", "run-1")),
        json!({"reason":"duplicate-turn","skipped":1,"stored":0})
    );
    drop(engine);
    // A restarted process still recognizes the settled turn.
    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    assert_eq!(
        capture(&engine, turn("agent", "run-1"))["reason"],
        "duplicate-turn"
    );
    let after = rows(root, "agent")
        .into_iter()
        .map(|row| row.id)
        .collect::<Vec<_>>();
    assert_eq!(after, ids);
}

#[test]
fn incognito_and_a_disabled_workspace_write_nothing() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let host = host(root);
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    let mut value = turn_value(
        "agent",
        "run-incognito",
        &json!([{"role":"user","content":USER}]),
    );
    value["incognito"] = json!(true);
    assert_eq!(
        capture(&engine, serde_json::from_value(value).unwrap()),
        json!({"reason":"incognito","skipped":1,"stored":0})
    );
    assert!(rows(root, "agent").is_empty());
    assert!(!root.join("db/_capture-turns/agent.json").exists());
    assert!(!root.join("workspace-agent/.emotional-state.json").exists());

    let context = crate::context::RequestContext::build(
        &serde_json::from_value(principal("agent")).unwrap(),
        &serde_json::from_value(json!({"origin":"user","background":false})).unwrap(),
        host.as_ref(),
    )
    .unwrap();
    crate::ops::workspace_policy::PolicyStore::new(&root.join("db"))
        .unwrap()
        .set(
            &json!({"agentId":"agent","workspaceIdentity":context.workspace_key,
            "expectedRevision":0,"enabled":false,"actorId":"system"}),
            10_000,
        )
        .unwrap();
    assert_eq!(
        capture(&engine, turn("agent", "run-disabled")),
        json!({"reason":"not_captured","skipped":1,"stored":0})
    );
    // The policy is checked before any admission file is written.
    assert!(admission_files(root).is_empty());
    assert!(rows(root, "agent").is_empty());
    assert!(!root.join("workspace-agent/.emotional-state.json").exists());
}

#[test]
fn a_principal_never_writes_into_another_agents_store() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    // A turn for one agent carried by another agent's principal is refused outright.
    let mut forged = turn_value(
        "agent",
        "run-forged",
        &json!([{"role":"user","content":USER}]),
    );
    forged["principal"] = principal("other");
    assert_eq!(
        capture(&engine, serde_json::from_value(forged).unwrap()),
        json!({"reason":"principal-agent-mismatch","skipped":1,"stored":0})
    );
    assert!(rows(root, "agent").is_empty());
    assert!(rows(root, "other").is_empty());

    // The same run ID under each agent's own principal stays in that agent's store.
    assert_eq!(capture(&engine, turn("agent", "run-1"))["stored"], 2);
    assert_eq!(capture(&engine, turn("other", "run-1"))["stored"], 2);
    for agent in ["agent", "other"] {
        let stored = rows(root, agent);
        assert_eq!(stored.len(), 2);
        assert!(stored.iter().all(|row| row.stored_by == agent));
    }
}

#[test]
fn cancelled_turns_and_a_closed_engine_write_nothing() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    let cancelled = turn("agent", "run-cancelled");
    cancelled.cancel.cancel();
    assert!(matches!(
        engine.capture(cancelled, options()),
        Err(EngineError::Cancelled(_))
    ));
    engine.close(None).unwrap();
    assert!(matches!(
        engine.capture(turn("agent", "run-closed"), options()),
        Err(EngineError::NotAvailable { reason }) if reason == "closed"
    ));
    assert!(!root.join("db").exists());
    assert!(!root.join("workspace-agent/.emotional-state.json").exists());
}

#[test]
fn injected_context_is_never_captured() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    let injected = format!(
        "<relevant-memories untrusted=\"true\">\n- {USER}\n</relevant-memories>\nWhat about it?"
    );
    let result = capture(
        &engine,
        serde_json::from_value(turn_value(
            "agent",
            "run-injected",
            &json!([{"role":"user","content":injected},{"role":"assistant","content":ASSISTANT}]),
        ))
        .unwrap(),
    );
    assert_eq!(result, json!({"stored":1,"skipped":0}));
    let stored = rows(root, "agent");
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].text, ASSISTANT);
}

/// RE-D162 / m4, m5: files of the earlier branch formats are removed; what nobody owns is kept
/// and reported; a malformed file in an owner's own scope defers and reports that scope
/// only. None of it blocks a capture.
#[test]
fn foreign_and_malformed_admission_files_are_reported_and_block_nobody() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    assert_eq!(capture(&engine, turn("agent", "run-1"))["stored"], 2);
    engine.close(None).unwrap();
    drop(engine);
    let admissions = root.join("db/_capture-admissions");
    // The only owner so far: its scope directory.
    let scope = fs::read_dir(&admissions)
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir() && !path.ends_with(".leases"))
        .unwrap();
    let reopened = || {
        let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
        // Status reflects capture composition only after the first open or capture.
        assert!(engine.capture.degradation().is_none());
        engine.open(&"agent".parse().unwrap()).unwrap();
        recovery_settled(&engine);
        engine
    };
    let deferred = Some((
        "capture-recovery-deferred".to_owned(),
        engine_capture::Served::Deferred,
    ));

    // Earlier branch formats are removed without migration, whatever they hold.
    let earlier = [
        format!("{}.json", "0".repeat(64)),
        format!("{}-{}.json", "1".repeat(16), "2".repeat(64)),
    ];
    for name in &earlier {
        fs::write(admissions.join(name), b"{\"record\":{\"version\":1}}").unwrap();
    }
    let engine = reopened();
    assert!(earlier.iter().all(|name| !admissions.join(name).exists()));
    assert_eq!(capture_state(&engine), None);
    engine.close(None).unwrap();
    drop(engine);

    // A top-level file nobody owns: kept and reported; capture is served for everyone.
    let foreign = admissions.join("notes.json");
    fs::write(&foreign, b"{\"record\":{\"version\":1}}").unwrap();
    let engine = reopened();
    assert!(engine.status().ready);
    assert_eq!(capture_state(&engine), deferred);
    assert_eq!(capture(&engine, turn("agent", "run-2"))["stored"], 2);
    assert_eq!(capture(&engine, turn("other", "run-3"))["stored"], 2);
    assert!(foreign.is_file());
    engine.close(None).unwrap();
    drop(engine);
    fs::remove_file(&foreign).unwrap();

    // A malformed file in an owner's own scope (m5): that scope is deferred and reported,
    // its owner and everyone else still capture, and the file stays until it is too old.
    let malformed = scope.join(format!("{}.json", "3".repeat(64)));
    fs::write(&malformed, b"{\"record\":{\"version\":1}}").unwrap();
    let engine = reopened();
    assert!(engine.status().ready);
    assert_eq!(capture_state(&engine), deferred);
    assert_eq!(capture(&engine, turn("agent", "run-4"))["stored"], 2);
    assert_eq!(capture(&engine, turn("other", "run-5"))["stored"], 2);
    assert_eq!(rows(root, "agent").len(), 6);
    assert!(malformed.is_file());
    assert_eq!(capture_state(&engine), deferred);
}

/// RE-D162 / R4: retained input older than seven days is discarded and never resumed. The
/// bound is inclusive (the pin's pending TTL) and the clock is the host's.
#[test]
fn retained_input_older_than_seven_days_is_discarded() {
    const WEEK: i64 = 7 * 24 * 60 * 60 * 1000;
    // The fixture host's clock at admission.
    let admitted_at = 1_768_305_600_000;
    for (age, kept) in [(WEEK, true), (WEEK + 1, false)] {
        let scratch = killed("admitted");
        let root = scratch.path().to_path_buf();
        assert_eq!(admissions_with_content(&root), 1);
        let later = host(&root);
        later.set_now_ms(admitted_at + age);
        let engine = ProcessEngine::new(later, Some(Seam::FlatEmbedder)).unwrap();
        engine.open(&"agent".parse().unwrap()).unwrap();
        recovery_settled(&engine);
        assert_eq!(admissions_with_content(&root), 0, "{age}");
        assert_eq!(
            rows(&root, "agent").len(),
            if kept { 2 } else { 0 },
            "{age}"
        );
        assert_eq!(capture_state(&engine), None, "{age}");
    }
}

/// RE-D162 / R4, m5: a malformed file in an owner's scope is kept and reported until it is
/// seven days old, then removed.
#[test]
fn a_malformed_scope_file_is_removed_once_it_is_seven_days_old() {
    const WEEK: i64 = 7 * 24 * 60 * 60 * 1000;
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    assert_eq!(capture(&engine, turn("agent", "run-1"))["stored"], 2);
    engine.close(None).unwrap();
    drop(engine);
    let scope = fs::read_dir(root.join("db/_capture-admissions"))
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir() && !path.ends_with(".leases"))
        .unwrap();
    let malformed = scope.join(format!("{}.json", "3".repeat(64)));
    fs::write(&malformed, USER).unwrap();
    let modified = fs::metadata(&malformed)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    let modified = i64::try_from(modified.as_millis()).unwrap();
    for (age, kept) in [(WEEK, true), (WEEK + 1, false)] {
        let later = host(root);
        later.set_now_ms(modified + age);
        let engine = ProcessEngine::new(later, Some(Seam::FlatEmbedder)).unwrap();
        engine.open(&"agent".parse().unwrap()).unwrap();
        recovery_settled(&engine);
        assert_eq!(malformed.exists(), kept, "{age}");
        assert_eq!(capture_state(&engine).is_some(), kept, "{age}");
        engine.close(None).unwrap();
    }
    assert_eq!(admissions_with_content(root), 0);
}

/// The fixture host blocks the capture worker once its durable admission exists.
struct CrashHost {
    inner: Arc<FakeHost>,
    root: PathBuf,
    /// `admitted`: before the first row; `first-row`: one row written, the turn unsettled.
    phase: String,
}
impl CrashHost {
    fn first_row_written(&self) -> bool {
        let path = self.root.join("db/current/agent");
        path.join("memories.lance").exists()
            && Store::open(&path, OpenMode::ReadOnly, None)
                .and_then(|store| store.count(&RowFilter::default()))
                .is_ok_and(|count| count > 0)
    }
}
impl HostServices for CrashHost {
    fn state_dir(&self) -> &Path {
        self.inner.state_dir()
    }
    fn config(&self) -> EngineConfig {
        self.inner.config()
    }
    fn workspace_dir(&self, agent: &AgentId) -> Result<Option<PathBuf>, HostError> {
        if self.phase == "host-error" {
            return Err(HostError::Unavailable);
        }
        if self.phase == "slow" {
            // Slow recovery: every workspace lookup takes long and ignores cancellation.
            fs::write(self.root.join("slow-entered"), "entered").unwrap();
            std::thread::sleep(Duration::from_secs(2));
            return self.inner.workspace_dir(agent);
        }
        if self.phase == "toggle" {
            // A transient host failure of `agent` for as long as the `fail` marker exists.
            if agent.as_str() == "agent" && self.root.join("fail").exists() {
                return Err(HostError::Unavailable);
            }
            return self.inner.workspace_dir(agent);
        }
        if self.phase == "recovery-fails" || self.phase == "recovery-refused" {
            // A transient host failure for recovery attempts only, for as long as the `fail`
            // marker exists: it hits the owner whose work is retained, never a turn.
            let recovering = matches!(
                std::thread::current().name(),
                Some("capture-recovery" | "neo-recovery")
            );
            if recovering && self.root.join("fail").exists() {
                return Err(if self.phase == "recovery-fails" {
                    HostError::Unavailable
                } else {
                    HostError::Failed
                });
            }
            return self.inner.workspace_dir(agent);
        }
        if self.phase == "hang-under-lease" {
            // A recovery attempt's lookup made while that attempt holds the Neo workspace
            // lease never returns (RE-D163 / I2). The lease is held when it cannot be taken.
            let recovering = std::thread::current().name() == Some("neo-recovery");
            let leases = fs::read_dir(self.root.join("db/_neo/workspaces"))
                .into_iter()
                .flatten()
                .flatten()
                .map(|entry| entry.path().join(".native-capture-leases"))
                .find(|path| path.is_dir());
            if let (true, true, Some(leases)) =
                (recovering, self.root.join("hang").exists(), leases)
            {
                let leases = crate::store::directory::TrustedDirectory::open(&leases).unwrap();
                if matches!(
                    crate::store::kernel_lease::try_acquire(&leases, "workspace"),
                    Ok(None)
                ) {
                    fs::write(self.root.join("hang-entered"), "").unwrap();
                    while self.root.join("hang").exists() {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
            }
            return self.inner.workspace_dir(agent);
        }
        if self.phase == "hang-first" {
            // Note that the host was asked; the first lookup for `agent` hangs while `hang`
            // exists. A turn asks hundreds of times, so later lookups only look.
            let calls = self.root.join("host-calls");
            if !calls.exists() {
                fs::write(calls, ".").unwrap();
            }
            if agent.as_str() == "agent"
                && !self.root.join("hang-entered").exists()
                && self.root.join("hang").exists()
                && fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(self.root.join("hang-entered"))
                    .is_ok()
            {
                while self.root.join("hang").exists() {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            return self.inner.workspace_dir(agent);
        }
        if self.phase == "neo-plan" {
            // Stop once a prepared Neo capture plan with content is durable.
            if neo_plans_with_content(&self.root) > 0 {
                fs::write(self.root.join("checkpoint"), "neo-plan").unwrap();
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
            return self.inner.workspace_dir(agent);
        }
        let admitted = admission_files(&self.root)
            .iter()
            .any(|path| fs::read_to_string(path).is_ok_and(|text| text.contains("\"record\":{")))
            && (self.phase != "first-row" || self.first_row_written());
        if admitted {
            fs::write(self.root.join("checkpoint"), "admitted").unwrap();
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        self.inner.workspace_dir(agent)
    }
    fn llm(&self) -> Option<&dyn LlmPort> {
        self.inner.llm()
    }
    fn secrets(&self) -> Option<&dyn SecretPort> {
        self.inner.secrets()
    }
    fn egress(&self) -> &dyn EgressGate {
        self.inner.egress()
    }
    fn emit(&self, event: &str, payload: Value) {
        self.inner.emit(event, payload);
    }
    fn now_ms(&self) -> i64 {
        self.inner.now_ms()
    }
    fn platform(&self) -> &PlatformCapabilities {
        self.inner.platform()
    }
    fn journal_backlog(&self) -> Option<JournalBacklog> {
        self.inner.journal_backlog()
    }
}

#[test]
fn capture_crash_child() {
    let Some(root) = std::env::var_os("PLUR1BUS_RX_PROCESS_CAPTURE_CRASH_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let phase = std::env::var("PLUR1BUS_RX_PROCESS_CAPTURE_CRASH_PHASE").unwrap_or_default();
    // `admitted-user`: a user's turn with Neo, killed at its admission, before any Neo plan.
    let with_metadata = phase == "admitted-metadata";
    let neo = phase == "neo-plan" || phase == "admitted-user" || with_metadata;
    let host = Arc::new(CrashHost {
        inner: if neo { neo_host(&root) } else { host(&root) },
        root: root.clone(),
        phase,
    });
    let turn = if neo {
        user_turn(&root, "owner-a", "run-crash")
    } else {
        turn("agent", "run-crash")
    };
    let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    let handle = if with_metadata {
        let mut turn = turn;
        turn.messages.insert(
            1,
            Message {
                role: MessageRole::Tool,
                content: "fixture dispatch failure".into(),
            },
        );
        let metadata = vec![
            crate::neo::turn_batch::MessageMetadata {
                timestamp_ms: Some(1_768_305_600_125),
                ..Default::default()
            },
            crate::neo::turn_batch::MessageMetadata {
                timestamp_ms: Some(1_768_305_600_500),
                tool_name: Some("read".into()),
                is_error: true,
                tool_call_id: Some("fixture-call".into()),
            },
            crate::neo::turn_batch::MessageMetadata::default(),
        ];
        engine
            .capture_host_turn(turn, options(), Some(metadata))
            .unwrap()
    } else {
        engine.capture(turn, options()).unwrap()
    };
    // The worker never settles; the parent kills this process.
    let _ = handle.done.recv();
}

/// Run `capture_crash_child` in a real child process and SIGKILL it at the given phase.
fn killed(phase: &str) -> tempfile::TempDir {
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path().to_path_buf();
    let mut child = Child(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "rpc::engine::capture_tests::capture_crash_child",
                "--nocapture",
            ])
            .env("PLUR1BUS_RX_PROCESS_CAPTURE_CRASH_ROOT", &root)
            .env("PLUR1BUS_RX_PROCESS_CAPTURE_CRASH_PHASE", phase)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while !root.join("checkpoint").exists() {
        assert!(child.0.try_wait().unwrap().is_none(), "{phase}");
        assert!(std::time::Instant::now() < deadline, "{phase}");
        std::thread::sleep(Duration::from_millis(10));
    }
    child.0.kill().unwrap();
    assert!(!child.0.wait().unwrap().success());
    scratch
}

#[test]
fn a_turn_killed_after_admission_is_recovered_exactly_once_on_the_next_open() {
    let scratch = killed("admitted");
    let root = scratch.path().to_path_buf();
    assert!(rows(&root, "agent").is_empty());

    // Opening the agent recovers the original admission before any new turn.
    let engine = ProcessEngine::new(host(&root), Some(Seam::FlatEmbedder)).unwrap();
    let handle = engine.open(&"agent".parse().unwrap()).unwrap();
    recovery_settled(&engine);
    let recovered = rows(&root, "agent");
    assert_eq!(recovered.len(), 2);
    assert!(recovered.iter().any(|row| row.text == USER));
    assert_eq!(
        capture(&engine, turn("agent", "run-crash"))["reason"],
        "duplicate-turn"
    );
    (handle.close)().unwrap();
    engine.close(None).unwrap();
    drop(engine);
    let engine = ProcessEngine::new(host(&root), Some(Seam::FlatEmbedder)).unwrap();
    engine.open(&"agent".parse().unwrap()).unwrap();
    recovery_settled(&engine);
    let again = rows(&root, "agent");
    assert_eq!(
        again.iter().map(|row| &row.id).collect::<Vec<_>>(),
        recovered.iter().map(|row| &row.id).collect::<Vec<_>>()
    );
}

/// Admission files whose record is still pending recovery.
fn pending_admissions(root: &Path) -> usize {
    admission_files(root)
        .iter()
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .filter(|path| {
            let value: Value =
                serde_json::from_slice(&fs::read(path).unwrap()).unwrap_or(Value::Null);
            !value["record"].is_null()
        })
        .count()
}

fn neo_host(root: &Path) -> Arc<FakeHost> {
    let host = host(root);
    let mut config = serde_json::to_value(host.config()).unwrap();
    config["neo"] = json!({"enabled":true,"embeddingDrain":{"enabled":false}});
    host.set_config(serde_json::from_value(config).unwrap());
    host
}

#[test]
fn no_deterministic_input_keeps_an_admission_open() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(neo_host(root), Some(Seam::FlatEmbedder)).unwrap();
    let media = format!("<!-- media-output-id: 0a1b2c3d-4e5f -->\n{USER}");
    let mut user = turn_value(
        "agent",
        "run-user-no-workspace",
        &json!([{"role":"user","content":USER}]),
    );
    user["agentId"] = json!("lonely");
    user["principal"]["agentId"] = json!("lonely");
    user["principal"]["user"] = json!(crate::context::harness_user_principal("fixture-user"));
    user["principal"]["trust"] = json!("proved");
    user["principal"]["channel"] = json!("telegram");
    let inputs = [
        // F11: a diarization media ID without proven provenance (speaker step refused).
        turn_value(
            "agent",
            "run-media",
            &json!([{"role":"user","content":media}]),
        ),
        // An owner the native Neo journal has no partition for, with Neo enabled.
        turn_value(
            "agent",
            "run-ownerless",
            &json!([{"role":"user","content":USER}]),
        ),
        // A user principal whose agent has no host workspace directory.
        user,
    ];
    for (index, input) in inputs.into_iter().enumerate() {
        let result = capture(&engine, serde_json::from_value(input).unwrap());
        assert!(
            result
                .get("reason")
                .is_none_or(|reason| reason != "duplicate-turn"),
            "{index}: {result}"
        );
        assert_eq!(pending_admissions(root), 0, "{index}: {result}");
    }
    // The media turn and the ownerless turn were stored; their skipped steps hold nothing open.
    assert_eq!(rows(root, "agent").len(), 2);
    engine.close(None).unwrap();
    drop(engine);
    // After a restart, recovery has nothing pending and capture is served.
    let engine = ProcessEngine::new(neo_host(root), Some(Seam::FlatEmbedder)).unwrap();
    engine.open(&"agent".parse().unwrap()).unwrap();
    recovery_settled(&engine);
    assert!(engine.capture.degradation().is_none());
    assert_eq!(capture(&engine, turn("agent", "run-after"))["stored"], 2);
    assert_eq!(pending_admissions(root), 0);
}

#[test]
fn a_turn_killed_after_its_first_row_is_completed_without_duplicates() {
    let scratch = killed("first-row");
    let root = scratch.path().to_path_buf();
    let before = rows(&root, "agent");
    assert_eq!(before.len(), 1);
    let engine = ProcessEngine::new(host(&root), Some(Seam::FlatEmbedder)).unwrap();
    engine.open(&"agent".parse().unwrap()).unwrap();
    recovery_settled(&engine);
    let after = rows(&root, "agent");
    assert_eq!(after.len(), 2);
    assert!(after.iter().any(|row| row.text == USER));
    assert!(after.iter().any(|row| row.text == ASSISTANT));
    // The unsettled row is replaced, never kept next to its rewrite.
    assert!(after.iter().all(|row| row.id != before[0].id));
    assert_eq!(
        capture(&engine, turn("agent", "run-crash"))["reason"],
        "duplicate-turn"
    );
    assert_eq!(pending_admissions(&root), 0);
}

#[test]
fn a_human_edited_unsettled_row_closes_its_entry_and_blocks_nobody() {
    let scratch = killed("first-row");
    let root = scratch.path().to_path_buf();
    // A human edit of the unsettled row: recovery must not delete or overwrite it.
    let path = root.join("db/current/agent");
    let store = Store::open(&path, OpenMode::ReadWrite, None).unwrap();
    let mut row = store.scan(&RowFilter::default(), 10).unwrap().remove(0);
    row.text.push_str(" Human revision.");
    store.upsert(std::slice::from_ref(&row)).unwrap();
    drop(store);

    let engine = ProcessEngine::new(host(&root), Some(Seam::FlatEmbedder)).unwrap();
    engine.open(&"agent".parse().unwrap()).unwrap();
    recovery_settled(&engine);
    // RE-D156: the edit makes the entry unrecoverable, so it is closed terminally.
    assert_eq!(pending_admissions(&root), 0);
    assert!(engine.capture.degradation().is_none());
    let kept = rows(&root, "agent");
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].text, row.text);
    // Nobody is blocked: the same and another agent capture normally.
    assert_eq!(capture(&engine, turn("other", "run-other"))["stored"], 2);
    assert_eq!(capture(&engine, turn("agent", "run-new"))["stored"], 2);
}

/// RE-D162: the composition returns at once; what is slow is one owner's recovery behind it.
/// Close ends it within its budget, starts no further step, and the input stays retained.
#[test]
fn close_during_a_slow_recovery_stays_within_its_budget() {
    let scratch = killed("admitted");
    let root = scratch.path().to_path_buf();
    let slow = Arc::new(CrashHost {
        inner: host(&root),
        root: root.clone(),
        phase: "slow".into(),
    });
    let engine = ProcessEngine::new(slow, Some(Seam::FlatEmbedder)).unwrap();
    // The slow host call belongs to the recovery attempt, not to the composition.
    engine_capture::ProcessCapture::open(&engine, &root.join("db")).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !root.join("slow-entered").exists() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let started = std::time::Instant::now();
    let closed = engine.close(Some(Duration::from_millis(300)));
    assert!(started.elapsed() < Duration::from_millis(1500));
    assert!(matches!(
        closed,
        Err(EngineError::NotAvailable { reason }) if reason == "capture-drain-incomplete"
    ));
    // Nothing is admitted after close, even while the attempt still finishes its host call.
    assert!(matches!(
        engine.capture(turn("agent", "run-late"), options()),
        Err(EngineError::NotAvailable { reason }) if reason == "closed"
    ));
    drop(engine);
    // The retained input is recovered by the next open.
    assert_eq!(pending_admissions(&root), 1);
    let engine = ProcessEngine::new(host(&root), Some(Seam::FlatEmbedder)).unwrap();
    engine.open(&"agent".parse().unwrap()).unwrap();
    recovery_settled(&engine);
    assert_eq!(rows(&root, "agent").len(), 2);
    assert_eq!(pending_admissions(&root), 0);
}

fn user_turn(root: &Path, owner: &str, run: &str) -> TurnRecord {
    let mut value = turn_value(
        "agent",
        run,
        &json!([{"role":"user","content":USER},{"role":"assistant","content":ASSISTANT}]),
    );
    value["principal"]["user"] = json!(crate::context::harness_user_principal(owner));
    value["principal"]["trust"] = json!("proved");
    value["principal"]["channel"] = json!("telegram");
    let workspace = fs::canonicalize(root.join("workspace-agent")).unwrap();
    value["principal"]["workspace"] = json!(format!("workspace-dir:v1:{}", workspace.display()));
    serde_json::from_value(value).unwrap()
}

#[test]
fn a_user_principal_writes_neo_through_the_process() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(neo_host(root), Some(Seam::FlatEmbedder)).unwrap();
    assert_eq!(
        capture(&engine, user_turn(root, "fixture-user", "run-neo"))["stored"],
        2
    );
    assert_eq!(pending_admissions(root), 0);
    let neo = fs::read_dir(root.join("db/_neo")).unwrap().count();
    assert!(neo > 0);
}

#[test]
fn neo_state_exists_only_when_neo_is_enabled() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    let result = capture(&engine, user_turn(root, "fixture-user", "run-no-neo"));
    assert_eq!(result["stored"], 2, "{result}");
    assert!(!root.join("db/_neo").exists());
}

#[test]
fn a_second_owner_of_the_same_agent_never_uses_the_first_owners_mood() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    let recall = |owner: &str| {
        let principal = serde_json::to_value(&user_turn(root, owner, "recall").principal).unwrap();
        methods::dispatch(
            &engine,
            "engine.recall",
            &json!({"query":{"query":"Which labels does the archive test project use?",
                "principal":principal,"agent":{"origin":"user","background":false}},
                "options":{"reranker":"off"}}),
            &Cancel::never(),
        )
        .unwrap()
    };
    assert_eq!(
        capture(&engine, user_turn(root, "owner-a", "run-a"))["stored"],
        2
    );
    // Owner A's recall commits the turn's mood, bound to owner A (RE-D51).
    recall("owner-a");
    let mood = root.join("workspace-agent/.emotional-state.json");
    let owned = fs::read(&mood).unwrap();
    // Owner B of the same agent neither reads nor overwrites it, in capture or recall.
    let result = capture(&engine, user_turn(root, "owner-b", "run-b"));
    recall("owner-b");
    assert_eq!(fs::read(&mood).unwrap(), owned, "{result}");
    assert_eq!(pending_admissions(root), 0);
}

#[test]
fn the_shared_emotion_engines_evict_the_least_recently_used_binding() {
    use crate::capture::classify::{Binding, EmotionEngines};
    let engines = EmotionEngines::new(json!({}), Arc::new(|| 0));
    let binding = |index: usize| Binding {
        agent: format!("agent-{index}"),
        owner: String::new(),
        workspace: "fixture".into(),
        directory: None,
    };
    let first = engines.engine(binding(0)).unwrap();
    let second = engines.engine(binding(1)).unwrap();
    for index in 2..256 {
        engines.engine(binding(index)).unwrap();
    }
    // Using the oldest binding again keeps it; the next insert evicts binding 1 instead.
    assert!(Arc::ptr_eq(&first, &engines.engine(binding(0)).unwrap()));
    engines.engine(binding(256)).unwrap();
    assert!(Arc::ptr_eq(&first, &engines.engine(binding(0)).unwrap()));
    assert!(!Arc::ptr_eq(&second, &engines.engine(binding(1)).unwrap()));
}

/// Disable automatic capture for one agent's workspace through the canonical policy store.
fn revoke_policy(root: &Path, agent: &str) {
    let host = host(root);
    let context = crate::context::RequestContext::build(
        &serde_json::from_value(principal(agent)).unwrap(),
        &serde_json::from_value(json!({"origin":"user","background":false})).unwrap(),
        host.as_ref(),
    )
    .unwrap();
    crate::ops::workspace_policy::PolicyStore::new(&root.join("db"))
        .unwrap()
        .set(
            &json!({"agentId":agent,"workspaceIdentity":context.workspace_key,
            "expectedRevision":0,"enabled":false,"actorId":"system"}),
            10_000,
        )
        .unwrap();
}

fn host_with_threshold(root: &Path, threshold: f64) -> Arc<FakeHost> {
    let host = host(root);
    let mut config = serde_json::to_value(host.config()).unwrap();
    config["duplicateThreshold"] = json!(threshold);
    host.set_config(serde_json::from_value(config).unwrap());
    host
}

fn foreign_owner_turn(root: &Path, run: &str) -> TurnRecord {
    let mut value = turn_value(
        "other",
        run,
        &json!([{"role":"user","content":USER},{"role":"assistant","content":ASSISTANT}]),
    );
    value["principal"]["user"] = json!(crate::context::harness_user_principal("foreign-owner"));
    value["principal"]["trust"] = json!("proved");
    value["principal"]["channel"] = json!("telegram");
    let workspace = fs::canonicalize(root.join("workspace-other")).unwrap();
    value["principal"]["workspace"] = json!(format!("workspace-dir:v1:{}", workspace.display()));
    serde_json::from_value(value).unwrap()
}

/// RE-D156 / C1: one agent's retained entry never stops anyone else's capture.
#[test]
fn a_retained_entry_with_revoked_policy_never_blocks_other_owners() {
    retained_entry_case("policy");
}

#[test]
fn a_retained_entry_with_config_drift_never_blocks_other_owners() {
    retained_entry_case("config");
}

#[test]
fn a_retained_entry_with_a_changed_workspace_never_blocks_other_owners() {
    retained_entry_case("workspace");
}

fn retained_entry_case(drift: &str) {
    {
        let scratch = killed("first-row");
        let root = scratch.path().to_path_buf();
        let host = match drift {
            "policy" => {
                revoke_policy(&root, "agent");
                host(&root)
            }
            "config" => host_with_threshold(&root, 1.02),
            _ => {
                let workspace = root.join("workspace-agent");
                fs::rename(&workspace, root.join("workspace-agent-old")).unwrap();
                fs::create_dir(&workspace).unwrap();
                host(&root)
            }
        };
        let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
        engine.open(&"agent".parse().unwrap()).unwrap();
        recovery_settled(&engine);
        let other = capture(&engine, turn("other", "run-other-live"));
        assert_eq!(other["stored"], 2, "{drift}: {other}");
        let foreign = capture(&engine, foreign_owner_turn(&root, "run-foreign-live"));
        assert_eq!(foreign["stored"], 2, "{drift}: {foreign}");
        engine.close(None).unwrap();
        drop(engine);
        let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
        engine.open(&"agent".parse().unwrap()).unwrap();
        recovery_settled(&engine);
        let again = capture(&engine, turn("other", "run-other-restart"));
        assert_eq!(again["stored"], 2, "{drift}: {again}");
        let foreign = capture(&engine, foreign_owner_turn(&root, "run-foreign-restart"));
        assert_eq!(foreign["stored"], 2, "{drift}: {foreign}");
        // Revocation, config drift and a changed workspace close the entry terminally.
        assert_eq!(pending_admissions(&root), 0, "{drift}");
        // The row written before the crash stays, as at the pin; nothing is rewritten.
        assert_eq!(rows(&root, "agent").len(), 1, "{drift}");
    }
}

/// RE-D162 / D1: an operational key never closes a retained record; a capture-semantic one
/// closes it as `config-changed`.
#[test]
fn only_capture_semantics_close_a_retained_record_as_config_changed() {
    let scratch = killed("admitted");
    let root = scratch.path().to_path_buf();
    let changed = host(&root);
    let mut config = serde_json::to_value(changed.config()).unwrap();
    config["runtime"] = json!({"captureTimeoutMs":45_000,"maxQueueDepthCapturePerAgent":7});
    config["embeddingBatchSize"] = json!(3);
    config["llmRouter"] = json!({"defaultModel":"another-model"});
    changed.set_config(serde_json::from_value(config).unwrap());
    let engine = ProcessEngine::new(changed, Some(Seam::FlatEmbedder)).unwrap();
    engine.open(&"agent".parse().unwrap()).unwrap();
    recovery_settled(&engine);
    // Another capture timeout, queue depth, batch size or model: the record is completed.
    assert_eq!(rows(&root, "agent").len(), 2);
    assert_eq!(pending_admissions(&root), 0);
    engine.close(None).unwrap();
    drop(engine);

    let scratch = killed("admitted");
    let root = scratch.path().to_path_buf();
    let engine =
        ProcessEngine::new(host_with_threshold(&root, 1.02), Some(Seam::FlatEmbedder)).unwrap();
    engine.open(&"agent".parse().unwrap()).unwrap();
    recovery_settled(&engine);
    // Another duplicate threshold: closed, the retained turn is not written.
    assert_eq!(pending_admissions(&root), 0);
    assert!(rows(&root, "agent").is_empty());
}

/// A file's modification time in milliseconds since the epoch.
fn modified_ms(path: &Path) -> i64 {
    let modified = fs::symlink_metadata(path)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    i64::try_from(modified.as_millis()).unwrap()
}

/// The prepared Neo plan files that still hold turn text.
fn neo_plan_files(root: &Path) -> Vec<PathBuf> {
    fs::read_dir(root.join("db/_neo/workspaces"))
        .into_iter()
        .flatten()
        .flatten()
        .flat_map(|workspace| {
            fs::read_dir(workspace.path())
                .into_iter()
                .flatten()
                .flatten()
        })
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            name.starts_with("native-") && name.contains("-pending-") && name.ends_with(".json")
        })
        .filter(|path| fs::read_to_string(path).is_ok_and(|text| text.contains(USER)))
        .collect()
}

/// Make every workspace wait for maintenance: retained work is deferred without an attempt.
fn start_maintenance(root: &Path) -> PathBuf {
    let control = root.join("db/control");
    fs::create_dir_all(&control).unwrap();
    let state = control.join("reembedding-state.json");
    fs::write(&state, b"{").unwrap();
    state
}

/// RE-D163 / R4: the Neo switch is no capture semantics. A restart with Neo switched off
/// completes the retained turn; its Neo step follows the current switch.
#[test]
fn a_restart_with_another_neo_switch_completes_the_retained_turn() {
    let scratch = killed("neo-plan");
    let root = scratch.path().to_path_buf();
    assert_eq!(admissions_with_content(&root), 1);
    // Neo is disabled now (`host` has `neo.enabled: false`).
    let engine = ProcessEngine::new(host(&root), Some(Seam::FlatEmbedder)).unwrap();
    engine_capture::ProcessCapture::open(&engine, &root.join("db")).unwrap();
    recovery_settled(&engine);
    assert_eq!(admissions_with_content(&root), 0);
    assert_eq!(rows(&root, "agent").len(), 2);
    // No Neo step ran: the plan prepared before the kill is untouched.
    assert_eq!(neo_plans_with_content(&root), 1);
    assert_eq!(capture_state(&engine), None);
}

/// RE-D163 / R3: a prepared Neo plan with turn text that is older than seven days is
/// discarded, whatever its attempt count; the bound is inclusive and the clock is the host's.
/// It is discarded as well while Neo is switched off, when nothing else of Neo runs.
#[test]
fn a_neo_plan_older_than_seven_days_is_discarded() {
    const WEEK: i64 = 7 * 24 * 60 * 60 * 1000;
    for (age, kept, neo) in [
        (WEEK, true, true),
        (WEEK + 1, false, true),
        (WEEK, true, false),
        (WEEK + 1, false, false),
    ] {
        let scratch = killed("neo-plan");
        let root = scratch.path().to_path_buf();
        // Maintenance: the plan is not simply recovered, and no attempt is counted.
        start_maintenance(&root);
        let written = neo_plan_files(&root)
            .iter()
            .map(|path| modified_ms(path))
            .min()
            .unwrap();
        let later = if neo { neo_host(&root) } else { host(&root) };
        later.set_now_ms(written + age);
        let engine = ProcessEngine::new(later, Some(Seam::FlatEmbedder)).unwrap();
        engine_capture::ProcessCapture::open(&engine, &root.join("db")).unwrap();
        recovery_settled(&engine);
        assert_eq!(
            neo_plans_with_content(&root),
            usize::from(kept),
            "{age} neo={neo}"
        );
        // Journals written before the kill stay.
        assert!(
            fs::read_dir(root.join("db/_neo/workspaces"))
                .unwrap()
                .count()
                > 0
        );
        engine.close(None).unwrap();
    }
}

/// RE-D163 / m1: the age bound is applied per plan file, read again under the workspace
/// lease. An old plan and a fresh one of the same owner: only the old one is discarded.
#[test]
fn only_the_old_plan_of_a_binding_is_discarded() {
    const DAY: u64 = 24 * 60 * 60;
    let scratch = killed("neo-plan");
    let root = scratch.path().to_path_buf();
    // Maintenance: nothing is resumed, so what stays is what the age bound left.
    start_maintenance(&root);
    let fresh = neo_plan_files(&root).pop().unwrap();
    let plan: Value = serde_json::from_str(&fs::read_to_string(&fresh).unwrap()).unwrap();
    // An episode plan of the same binding that was prepared eight days ago.
    let old = fresh.with_file_name(
        fresh
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .replace("native-capture-pending-", "native-episode-pending-"),
    );
    let episode = json!({
        "ownership": plan["ownership"],
        "plan": {"caller": plan["caller"], "session": "fixture", "content": USER},
    });
    fs::write(&old, serde_json::to_vec(&episode).unwrap()).unwrap();
    let now = std::time::SystemTime::now();
    fs::File::options()
        .write(true)
        .open(&old)
        .unwrap()
        .set_modified(now - Duration::from_secs(8 * DAY))
        .unwrap();
    assert_eq!(neo_plan_files(&root).len(), 2);
    let later = neo_host(&root);
    later.set_now_ms(modified_ms(&fresh) + 1000);
    let engine = ProcessEngine::new(later, Some(Seam::FlatEmbedder)).unwrap();
    engine_capture::ProcessCapture::open(&engine, &root.join("db")).unwrap();
    recovery_settled(&engine);
    assert!(!old.exists());
    assert!(fresh.exists());
    assert_eq!(neo_plan_files(&root), [fresh]);
    engine.close(None).unwrap();
}

/// RE-D163 / R5: a temporary file an interrupted atomic write left behind holds a whole
/// record or plan. Older than an hour, it is removed at the inventory; only the atomic
/// writer's own name pattern is touched.
#[test]
fn stale_temporary_files_with_turn_text_are_removed_after_an_hour() {
    const HOUR: i64 = 60 * 60 * 1000;
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(neo_host(root), Some(Seam::FlatEmbedder)).unwrap();
    assert_eq!(
        capture(&engine, user_turn(root, "owner-a", "run-1"))["stored"],
        2
    );
    engine.close(None).unwrap();
    drop(engine);
    let scope = fs::read_dir(root.join("db/_capture-admissions"))
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir() && !path.ends_with(".leases"))
        .unwrap();
    let workspace = fs::read_dir(root.join("db/_neo/workspaces"))
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir())
        .unwrap();
    let hash = "3".repeat(64);
    let stale = [
        scope.join(format!(".{hash}.json.4242.0123456789ab.tmp")),
        workspace.join(format!(
            ".native-capture-pending-{hash}.json.4242.0123456789ab.tmp"
        )),
        workspace.join(format!(
            ".native-episode-pending-{hash}.json.4242.0123456789ab.tmp"
        )),
        workspace.join(".candidate-index.jsonl.4242.0123456789ab.tmp"),
    ];
    let foreign = [
        scope.join("notes.tmp"),
        scope.join(format!(".{hash}.json.4242.tmp")),
        workspace.join(".candidate-index.jsonl.4242.tmp"),
        workspace.join("native-capture-pending-notes.tmp"),
    ];
    for path in stale.iter().chain(&foreign) {
        fs::write(path, USER).unwrap();
    }
    // Exactly an hour after the oldest was written nothing is stale; one millisecond more
    // than an hour after the youngest, all of them are.
    let times = stale.iter().map(|path| modified_ms(path));
    let (oldest, youngest) = (times.clone().min().unwrap(), times.max().unwrap());
    for (now, kept) in [(oldest + HOUR, true), (youngest + HOUR + 1, false)] {
        let age = now - oldest;
        let later = neo_host(root);
        later.set_now_ms(now);
        let engine = ProcessEngine::new(later, Some(Seam::FlatEmbedder)).unwrap();
        engine_capture::ProcessCapture::open(&engine, &root.join("db")).unwrap();
        recovery_settled(&engine);
        for path in &stale {
            assert_eq!(path.exists(), kept, "{age}: {}", path.display());
        }
        for path in &foreign {
            assert!(path.exists(), "{age}: {}", path.display());
        }
        engine.close(None).unwrap();
    }
}

/// RE-D163 / m8: while the engine runs, the recovery pass sweeps once per hour of the
/// host's clock. A retained admission that grew older than seven days is discarded then,
/// without an attempt; before the hour has passed nothing is swept.
#[test]
fn the_hourly_sweep_discards_an_admission_that_grew_too_old() {
    const WEEK: i64 = 7 * 24 * 60 * 60 * 1000;
    const HOUR: i64 = 60 * 60 * 1000;
    // The fixture host's clock at admission.
    let admitted_at = 1_768_305_600_000;
    let scratch = killed("admitted");
    let root = scratch.path().to_path_buf();
    // Maintenance: the record is not simply recovered, and no attempt is counted.
    start_maintenance(&root);
    let clock = host(&root);
    clock.set_now_ms(admitted_at + WEEK);
    let engine = ProcessEngine::new(clock.clone(), Some(Seam::FlatEmbedder)).unwrap();
    engine_capture::ProcessCapture::open(&engine, &root.join("db")).unwrap();
    recovery_settled(&engine);
    assert_eq!(admissions_with_content(&root), 1);
    let look = || {
        engine
            .capture
            .look_at_clock_for_test(Duration::from_secs(60))
    };
    // Not an hour later: the pass looks at the clock and leaves everything alone.
    clock.set_now_ms(admitted_at + WEEK + HOUR - 1);
    assert_eq!(look(), Some(false));
    assert_eq!(admissions_with_content(&root), 1);
    clock.set_now_ms(admitted_at + WEEK + HOUR);
    assert_eq!(look(), Some(true));
    assert_eq!(admissions_with_content(&root), 0);
    assert_eq!(rows(&root, "agent").len(), 0);
    assert_eq!(capture_state(&engine), None);
    // The next sweep is due an hour after this one.
    assert_eq!(look(), Some(false));
    engine.close(None).unwrap();
}

/// RE-D163 / R3, R5, m8: the hourly sweep also discards a prepared Neo plan that grew older
/// than seven days and removes temporary files that interrupted writes left behind.
#[test]
fn the_hourly_sweep_discards_an_old_neo_plan_and_stale_temporary_files() {
    const WEEK: i64 = 7 * 24 * 60 * 60 * 1000;
    const HOUR: i64 = 60 * 60 * 1000;
    let scratch = killed("neo-plan");
    let root = scratch.path().to_path_buf();
    start_maintenance(&root);
    let plans = neo_plan_files(&root);
    let written = plans.iter().map(|path| modified_ms(path)).min().unwrap();
    let clock = neo_host(&root);
    clock.set_now_ms(written + WEEK);
    let engine = ProcessEngine::new(clock.clone(), Some(Seam::FlatEmbedder)).unwrap();
    engine_capture::ProcessCapture::open(&engine, &root.join("db")).unwrap();
    recovery_settled(&engine);
    assert_eq!(neo_plans_with_content(&root), 1);
    // A writer is killed between writing and renaming while the engine runs.
    let left = plans[0]
        .parent()
        .unwrap()
        .join(".candidate-index.jsonl.4242.0123456789ab.tmp");
    fs::write(&left, USER).unwrap();
    let look = || {
        engine
            .capture
            .look_at_clock_for_test(Duration::from_secs(60))
    };
    assert_eq!(look(), Some(false));
    assert_eq!(neo_plans_with_content(&root), 1);
    assert!(left.exists());
    clock.set_now_ms(written + WEEK + HOUR);
    assert_eq!(look(), Some(true));
    assert_eq!(neo_plans_with_content(&root), 0);
    assert!(!left.exists());
    assert_eq!(capture_state(&engine), None);
    engine.close(None).unwrap();
}

/// RE-D163 / m4: a resumed record writes its Neo journal with the time of the turn (its
/// admission), not with the time of the recovery. A later turn of the owner that is
/// captured first therefore stays the later one in the journal.
#[test]
fn a_resumed_turn_writes_its_neo_journal_with_the_original_turn_time() {
    const DAY: i64 = 24 * 60 * 60 * 1000;
    let scratch = killed("admitted-user");
    let root = scratch.path().to_path_buf();
    assert_eq!(admissions_with_content(&root), 1);
    assert_eq!(neo_plans_with_content(&root), 0);
    // The fixture host's clock at admission is 2026-01-13T12:00:00.000Z; recovery runs a
    // day later.
    let later = neo_host(&root);
    later.set_now_ms(1_768_305_600_000 + DAY);
    let engine = ProcessEngine::new(later, Some(Seam::FlatEmbedder)).unwrap();
    engine_capture::ProcessCapture::open(&engine, &root.join("db")).unwrap();
    recovery_settled(&engine);
    assert_eq!(admissions_with_content(&root), 0);
    assert_eq!(rows(&root, "agent").len(), 2);
    let workspace = fs::read_dir(root.join("db/_neo/workspaces"))
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir())
        .unwrap();
    let journal = fs::read_to_string(workspace.join("turn-journal.jsonl")).unwrap();
    assert!(journal.contains("2026-01-13T12:00:00.000Z"), "{journal}");
    assert!(!journal.contains("2026-01-14T12:00:00.000Z"), "{journal}");
    engine.close(None).unwrap();
}

#[test]
fn resumed_neo_capture_uses_the_metadata_retained_at_admission() {
    const DAY: i64 = 24 * 60 * 60 * 1000;
    let scratch = killed("admitted-metadata");
    let root = scratch.path();
    assert_eq!(admissions_with_content(root), 1);
    assert_eq!(neo_plans_with_content(root), 0);
    let later = neo_host(root);
    later.set_now_ms(1_768_305_600_000 + DAY);
    let engine = ProcessEngine::new(later, Some(Seam::FlatEmbedder)).unwrap();
    engine_capture::ProcessCapture::open(&engine, &root.join("db")).unwrap();
    recovery_settled(&engine);
    assert_eq!(admissions_with_content(root), 0);
    assert_eq!(rows(root, "agent").len(), 2);
    let workspace = fs::read_dir(root.join("db/_neo/workspaces"))
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir())
        .unwrap();
    let journal = fs::read_to_string(workspace.join("turn-journal.jsonl")).unwrap();
    let turns: Vec<Value> = journal
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(turns.len(), 3, "{journal}");
    assert_eq!(turns[0]["createdAt"], "2026-01-13T12:00:00.125Z");
    assert_eq!(turns[1]["createdAt"], "2026-01-13T12:00:00.500Z");
    assert_eq!(
        turns[1]["origin"]["sourceToolCallIds"],
        json!(["fixture-call"])
    );
    assert_eq!(turns[2]["createdAt"], "2026-01-13T12:00:00.000Z");
    engine.close(None).unwrap();
}

/// RE-D156 / I1: content of a chat message never keeps an admission open.
#[test]
fn an_out_of_range_reminder_never_keeps_an_admission_open() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    let text = "Erinnere mich in 99999999999 Tagen an den Arzttermin in der Praxis.";
    let result = capture(
        &engine,
        serde_json::from_value(turn_value(
            "agent",
            "run-far-reminder",
            &json!([{"role":"user","content":text}]),
        ))
        .unwrap(),
    );
    assert_eq!(result["stored"], 1, "{result}");
    assert_eq!(pending_admissions(root), 0, "{result}");
    engine.close(None).unwrap();
    drop(engine);
    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    engine.open(&"agent".parse().unwrap()).unwrap();
    recovery_settled(&engine);
    assert!(engine.capture.degradation().is_none());
    assert_eq!(capture(&engine, turn("agent", "run-next"))["stored"], 2);
}

/// RE-D156 / I3: a host failure while resolving the workspace is transient for Neo.
#[test]
fn a_host_failure_never_makes_neo_not_applicable() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let healthy = host(root);
    let turn = user_turn(root, "fixture-user", "run-neo-host");
    let context =
        crate::context::RequestContext::build(&turn.principal, &turn.agent, healthy.as_ref())
            .unwrap();
    assert!(engine_capture::neo_applies(healthy.as_ref(), &turn, &context).unwrap());
    let failing = CrashHost {
        inner: healthy.clone(),
        root: root.to_path_buf(),
        phase: "host-error".into(),
    };
    let error = engine_capture::neo_applies(&failing, &turn, &context).unwrap_err();
    assert_eq!(
        crate::capture::failure::classify(&error),
        crate::capture::failure::FailureClass::Transient
    );
    // Only a caller without a user principal is not applicable.
    let ownerless = turn_value("agent", "run-ownerless", &json!([]));
    let ownerless: TurnRecord = serde_json::from_value(ownerless).unwrap();
    let context = crate::context::RequestContext::build(
        &ownerless.principal,
        &ownerless.agent,
        healthy.as_ref(),
    )
    .unwrap();
    assert!(!engine_capture::neo_applies(&failing, &ownerless, &context).unwrap());
}

/// The capture part of the status: reason and how far capture is served.
fn capture_state(engine: &ProcessEngine) -> Option<(String, engine_capture::Served)> {
    engine
        .capture
        .degradation()
        .map(|(degraded, served)| (degraded.reason, served))
}

/// RE-D159: an owner whose recovery failed transiently is deferred, reported as
/// served-but-deferred without touching `ready`, and recovered before its next turn.
#[test]
fn an_owner_deferred_by_a_transient_failure_is_reported_until_its_next_turn_recovers_it() {
    let scratch = killed("admitted");
    let root = scratch.path().to_path_buf();
    fs::write(root.join("fail"), "").unwrap();
    let host = Arc::new(CrashHost {
        inner: host(&root),
        root: root.clone(),
        phase: "toggle".into(),
    });
    let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    engine_capture::ProcessCapture::open(&engine, &root.join("db")).unwrap();
    recovery_settled(&engine);
    assert!(engine.status().ready);
    assert_eq!(
        capture_state(&engine),
        Some((
            "capture-recovery-deferred".into(),
            engine_capture::Served::Deferred
        ))
    );
    assert_eq!(pending_admissions(&root), 1);
    fs::remove_file(root.join("fail")).unwrap();
    // The owner's next turn first completes the deferred one, then the state clears.
    assert_eq!(capture(&engine, turn("agent", "run-next"))["stored"], 2);
    assert_eq!(pending_admissions(&root), 0);
    assert_eq!(rows(&root, "agent").len(), 4);
    assert_eq!(capture_state(&engine), None);
}

/// RE-D159 / Ruling 8: retained work waiting for maintenance keeps `ready`, has its own
/// state, costs no attempt, and the state disappears once the work is completed.
#[test]
fn work_deferred_by_maintenance_keeps_ready_and_clears_when_completed() {
    let scratch = killed("admitted");
    let root = scratch.path().to_path_buf();
    // An unreadable re-embedding state is a switching store: maintenance (fail closed).
    let control = root.join("db/control");
    fs::create_dir_all(&control).unwrap();
    fs::write(control.join("reembedding-state.json"), b"{").unwrap();
    let engine = ProcessEngine::new(host(&root), Some(Seam::FlatEmbedder)).unwrap();
    engine.open(&"agent".parse().unwrap()).unwrap();
    recovery_settled(&engine);
    assert!(engine.status().ready);
    assert_eq!(
        capture_state(&engine),
        Some((
            "capture-recovery-deferred".into(),
            engine_capture::Served::Deferred
        ))
    );
    let retained: Value = serde_json::from_str(
        &admission_files(&root)
            .iter()
            .find_map(|path| {
                fs::read_to_string(path)
                    .ok()
                    .filter(|text| text.contains(USER))
            })
            .unwrap(),
    )
    .unwrap();
    // Maintenance is no attempt.
    assert!(retained["record"]["recoveryAttempts"].is_null());
    fs::remove_file(control.join("reembedding-state.json")).unwrap();
    assert_eq!(capture(&engine, turn("agent", "run-after"))["stored"], 2);
    assert_eq!(pending_admissions(&root), 0);
    assert_eq!(rows(&root, "agent").len(), 4);
    assert_eq!(capture_state(&engine), None);
}

/// Prepared Neo plan files (capture, episode, embedding) that still hold turn text.
fn neo_plans_with_content(root: &Path) -> usize {
    fs::read_dir(root.join("db/_neo/workspaces"))
        .into_iter()
        .flatten()
        .flatten()
        .flat_map(|workspace| {
            fs::read_dir(workspace.path())
                .into_iter()
                .flatten()
                .flatten()
        })
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with("native-") && name.contains("-pending-") && name.ends_with(".json")
        })
        .filter(|entry| fs::read_to_string(entry.path()).is_ok_and(|text| text.contains(USER)))
        .count()
}

/// Admission files that still hold turn text, whatever their name.
fn admissions_with_content(root: &Path) -> usize {
    admission_files(root)
        .iter()
        .filter(|path| fs::read_to_string(path).is_ok_and(|text| text.contains(USER)))
        .count()
}

/// Disable automatic capture for the workspace a turn's caller resolves to.
fn revoke_for(root: &Path, turn: &TurnRecord) {
    let context =
        crate::context::RequestContext::build(&turn.principal, &turn.agent, host(root).as_ref())
            .unwrap();
    crate::ops::workspace_policy::PolicyStore::new(&root.join("db"))
        .unwrap()
        .set(
            &json!({"agentId":turn.agent_id.as_str(),"workspaceIdentity":context.workspace_key,
            "expectedRevision":0,"enabled":false,"actorId":"system"}),
            10_000,
        )
        .unwrap();
}

/// RE-D159 / K1: an owner's open Neo plan never stops anyone else's capture.
#[test]
fn an_open_neo_plan_with_revoked_policy_never_blocks_other_owners() {
    open_neo_plan_case("policy");
}

#[test]
fn an_open_neo_plan_with_a_changed_workspace_never_blocks_other_owners() {
    open_neo_plan_case("workspace");
}

fn open_neo_plan_case(drift: &str) {
    let scratch = killed("neo-plan");
    let root = scratch.path().to_path_buf();
    assert_eq!(neo_plans_with_content(&root), 1, "{drift}");
    if drift == "policy" {
        revoke_for(&root, &user_turn(&root, "owner-a", "run-crash"));
    } else {
        let workspace = root.join("workspace-agent");
        fs::rename(&workspace, root.join("workspace-agent-old")).unwrap();
        fs::create_dir(&workspace).unwrap();
    }
    for round in ["live", "restart"] {
        let engine = ProcessEngine::new(neo_host(&root), Some(Seam::FlatEmbedder)).unwrap();
        let other = capture(&engine, turn("other", &format!("run-other-{round}")));
        assert_eq!(other["stored"], 2, "{drift} {round}: {other}");
        let foreign = capture(
            &engine,
            foreign_owner_turn(&root, &format!("run-f-{round}")),
        );
        assert_eq!(foreign["stored"], 2, "{drift} {round}: {foreign}");
        let owner_b = capture(
            &engine,
            user_turn(&root, "owner-b", &format!("run-b-{round}")),
        );
        if drift == "policy" {
            // The shared workspace is switched off for owner B as well: refused, not failed.
            assert_eq!(owner_b["reason"], "not_captured", "{round}: {owner_b}");
        } else {
            assert_eq!(owner_b["stored"], 2, "{drift} {round}: {owner_b}");
        }
        recovery_settled(&engine);
        engine.close(None).unwrap();
    }
    // Revocation and a new workspace close the plan; its turn text is gone.
    assert_eq!(neo_plans_with_content(&root), 0, "{drift}");
    assert_eq!(admissions_with_content(&root), 0, "{drift}");
}

/// RE-D159 / K2: completed turns leave no admission file behind.
#[test]
fn completed_turns_leave_no_admission_files() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    for index in 0..20 {
        let result = capture(&engine, turn("agent", &format!("run-{index}")));
        assert_eq!(result["stored"], 2, "{result}");
    }
    assert!(admission_files(root).is_empty());
}

/// RE-D162 / D4: a directory full of earlier-format entries and files nobody owns never
/// refuses capture; the former are removed, the latter kept and reported.
#[test]
fn a_thousand_earlier_entries_and_foreign_files_never_refuse_capture() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let directory = root.join("db/_capture-admissions");
    fs::create_dir_all(&directory).unwrap();
    for index in 0..1000_u32 {
        let content: &[u8] = if index % 2 == 0 {
            br#"{"record":null}"#
        } else {
            USER.as_bytes()
        };
        fs::write(directory.join(format!("{index:064x}.json")), content).unwrap();
    }
    for index in 0..300_u32 {
        fs::write(directory.join(format!("note-{index}.json")), b"kept").unwrap();
    }
    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    let result = capture(&engine, turn("agent", "run-after-history"));
    assert_eq!(result["stored"], 2, "{result}");
    assert_eq!(admissions_with_content(root), 0);
    let kept = fs::read_dir(&directory)
        .unwrap()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("note-"))
        .count();
    assert_eq!(kept, 300);
    assert_eq!(
        capture_state(&engine),
        Some((
            "capture-recovery-deferred".into(),
            engine_capture::Served::Deferred
        ))
    );
}

/// RE-D159 / K2: a directory full of closed entries never refuses capture. Writing and
/// removing 50 001 files takes longer than a normal test should (about 16 s here), so this
/// runs with `--ignored`; the test above and `top_level_classification_has_no_index_bound`
/// cover the behavior in the normal run.
#[test]
#[ignore = "50 001 files: about 16 s; run with --ignored"]
fn fifty_thousand_closed_entries_never_refuse_capture() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let directory = root.join("db/_capture-admissions");
    fs::create_dir_all(&directory).unwrap();
    for index in 0..50_001_u32 {
        fs::write(
            directory.join(format!("{index:064x}.json")),
            br#"{"record":null}"#,
        )
        .unwrap();
    }
    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    let result = capture(&engine, turn("agent", "run-after-history"));
    assert_eq!(result["stored"], 2, "{result}");
}

/// RE-D159 / W1: a slow owner's startup recovery never fails anyone else's turn.
#[test]
fn a_slow_owners_startup_recovery_never_refuses_another_owners_turn() {
    let scratch = killed("admitted");
    let root = scratch.path().to_path_buf();
    let inner = host(&root);
    let mut config = serde_json::to_value(inner.config()).unwrap();
    config["runtime"] = json!({"captureTimeoutMs":1500});
    inner.set_config(serde_json::from_value(config).unwrap());
    // The first owner's record is busy elsewhere for longer than the recovery budget.
    let held = hold_admission(&root);
    let engine = ProcessEngine::new(inner, Some(Seam::FlatEmbedder)).unwrap();
    let other = capture(&engine, turn("other", "run-other"));
    assert_eq!(other["stored"], 2, "{other}");
    // The slow owner's input is deferred, not lost, and capture stays served.
    assert_eq!(pending_admissions(&root), 1);
    assert_eq!(
        capture_state(&engine),
        Some((
            "capture-recovery-deferred".into(),
            engine_capture::Served::Deferred
        ))
    );
    drop(held);
}

/// Hold the kernel lease of the retained admission, as another process would.
fn hold_admission(root: &Path) -> crate::store::kernel_lease::KernelLease {
    let leases = crate::store::directory::TrustedDirectory::open(
        &root.join("db/_capture-admissions/.leases"),
    )
    .unwrap();
    crate::store::kernel_lease::acquire(
        &leases,
        &admission_lease(root),
        &Cancel::never(),
        &mut || {},
    )
    .unwrap()
}

/// The kernel lease name guarding a retained admission file.
fn admission_lease(root: &Path) -> String {
    // The lease is named after the owner scope, the record's directory (RE-D162).
    let file = admission_files(root)
        .into_iter()
        .find(|path| fs::read_to_string(path).is_ok_and(|text| text.contains(USER)))
        .unwrap();
    let scope = file.parent().unwrap().file_name().unwrap();
    scope.to_string_lossy().into_owned()
}

/// RE-D159 / W2: another owner's pending work of the same agent never delays or aborts a turn.
#[test]
fn another_owners_pending_work_never_aborts_a_turn_of_the_same_agent() {
    let scratch = killed("admitted");
    let root = scratch.path().to_path_buf();
    fs::write(root.join("fail"), "").unwrap();
    let host = Arc::new(CrashHost {
        inner: host(&root),
        root: root.clone(),
        phase: "toggle".into(),
    });
    let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    // Startup recovery fails transiently: the first owner's record stays pending.
    let _ = engine_capture::ProcessCapture::open(&engine, &root.join("db"));
    recovery_settled(&engine);
    fs::remove_file(root.join("fail")).unwrap();
    assert_eq!(pending_admissions(&root), 1);
    // The first owner's record is busy elsewhere for longer than the next turn's deadline.
    let held = hold_admission(&root);
    let mut next = user_turn(&root, "owner-b", "run-owner-b");
    next.cancel = Cancel::with_deadline(std::time::Instant::now() + Duration::from_secs(3));
    let result = capture(&engine, next);
    assert_eq!(result["stored"], 2, "{result}");
    assert_eq!(pending_admissions(&root), 1);
    drop(held);
}

/// RE-D159 / W3: failures before a recovery step are counted, so nothing stays open forever.
#[test]
fn a_record_whose_host_keeps_failing_is_closed_after_five_attempts() {
    let scratch = killed("admitted");
    let root = scratch.path().to_path_buf();
    fs::write(root.join("fail"), "").unwrap();
    for _ in 0..6 {
        let host = Arc::new(CrashHost {
            inner: host(&root),
            root: root.clone(),
            phase: "toggle".into(),
        });
        let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
        let _ = engine_capture::ProcessCapture::open(&engine, &root.join("db"));
        recovery_settled(&engine);
        engine.close(None).unwrap();
    }
    fs::remove_file(root.join("fail")).unwrap();
    let engine = ProcessEngine::new(host(&root), Some(Seam::FlatEmbedder)).unwrap();
    engine_capture::ProcessCapture::open(&engine, &root.join("db")).unwrap();
    recovery_settled(&engine);
    assert_eq!(pending_admissions(&root), 0);
    assert_eq!(admissions_with_content(&root), 0);
    assert!(rows(&root, "agent").is_empty());
}

/// Make the first prepared Neo capture plan row foreign: its replay fails deterministically.
fn tamper_neo_plan(root: &Path) {
    let plan = fs::read_dir(root.join("db/_neo/workspaces"))
        .unwrap()
        .flatten()
        .flat_map(|workspace| fs::read_dir(workspace.path()).unwrap().flatten())
        .find(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with("native-capture-pending-")
                && fs::read_to_string(entry.path()).is_ok_and(|text| text.contains(USER))
        })
        .unwrap()
        .path();
    let mut value: Value = serde_json::from_slice(&fs::read(&plan).unwrap()).unwrap();
    value["records"][0][0]["ownerUserId"] = json!("someone-else");
    fs::write(&plan, serde_json::to_vec(&value).unwrap()).unwrap();
}

/// RE-D159 / Ruling 10, RE-D162 / m7: for every retained kind and trigger, other owners
/// capture on every open (another agent, another agent's owner and a second owner of the
/// same agent), the affected owner is free again after at most five attempts, and no turn
/// text stays after a revocation. For the transient triggers the bound is exact: retained
/// after each of five failed attempts, closed by the sixth open without another attempt.
#[test]
fn every_retained_kind_and_trigger_stays_isolated_and_bounded() {
    for kind in ["admission", "neo"] {
        for trigger in [
            "revoked",
            "maintenance",
            "config",
            "identity",
            "transient",
            "host-failed",
            "terminal",
        ] {
            let case = format!("{kind}/{trigger}");
            let neo = kind == "neo";
            let scratch = killed(if neo { "neo-plan" } else { "first-row" });
            let root = scratch.path().to_path_buf();
            let owner = |run: &str| {
                if neo {
                    user_turn(&root, "owner-a", run)
                } else {
                    turn("agent", run)
                }
            };
            let control = root.join("db/control/reembedding-state.json");
            let base = || {
                let host = if neo { neo_host(&root) } else { host(&root) };
                if trigger == "config" {
                    let mut config = serde_json::to_value(host.config()).unwrap();
                    config["duplicateThreshold"] = json!(1.02);
                    host.set_config(serde_json::from_value(config).unwrap());
                }
                host
            };
            match trigger {
                "revoked" => revoke_for(&root, &owner("run-crash")),
                "maintenance" => {
                    fs::create_dir_all(control.parent().unwrap()).unwrap();
                    fs::write(&control, b"{").unwrap();
                }
                "identity" => {
                    let workspace = root.join("workspace-agent");
                    fs::rename(&workspace, root.join("workspace-agent-old")).unwrap();
                    fs::create_dir(&workspace).unwrap();
                }
                // The host fails for recovery attempts only: for the owner with retained
                // work, not for a turn of the second owner of the same agent.
                "transient" | "host-failed" => fs::write(root.join("fail"), "").unwrap(),
                // The host configuration above differs from the recorded one.
                "config" => {}
                // A terminal content error.
                _ if neo => tamper_neo_plan(&root),
                _ => {
                    let store =
                        Store::open(&root.join("db/current/agent"), OpenMode::ReadWrite, None)
                            .unwrap();
                    let mut row = store.scan(&RowFilter::default(), 10).unwrap().remove(0);
                    row.text.push_str(" Human revision.");
                    store.upsert(std::slice::from_ref(&row)).unwrap();
                }
            }
            let counted = matches!(trigger, "transient" | "host-failed");
            // Six opens: one more than the attempt bound.
            for round in 0..6 {
                let host = Arc::new(CrashHost {
                    inner: base(),
                    root: root.clone(),
                    phase: match trigger {
                        "transient" => "recovery-fails",
                        "host-failed" => "recovery-refused",
                        _ => "toggle",
                    }
                    .into(),
                });
                let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
                engine_capture::ProcessCapture::open(&engine, &root.join("db")).unwrap();
                recovery_settled(&engine);
                for result in [
                    capture(&engine, turn("other", &format!("run-other-{round}"))),
                    capture(
                        &engine,
                        foreign_owner_turn(&root, &format!("run-f-{round}")),
                    ),
                ] {
                    if trigger == "maintenance" {
                        // Maintenance switches every workspace off, not only this owner's.
                        assert_eq!(result["reason"], "not_captured", "{case} {round}: {result}");
                    } else {
                        assert_eq!(result["stored"], 2, "{case} {round}: {result}");
                    }
                }
                // A second owner of the same agent (m7). It shares the agent's workspace, so
                // maintenance and a revocation of that workspace refuse it too.
                let second = capture(
                    &engine,
                    user_turn(&root, "owner-b", &format!("run-second-{round}")),
                );
                if matches!(trigger, "maintenance" | "revoked") {
                    assert_eq!(second["reason"], "not_captured", "{case} {round}: {second}");
                } else {
                    assert_eq!(second["stored"], 2, "{case} {round}: {second}");
                }
                engine.close(None).unwrap();
                if counted {
                    // Five failed attempts keep the work, the sixth open closes it.
                    let retained = admissions_with_content(&root) + neo_plans_with_content(&root);
                    assert_eq!(retained > 0, round < 5, "{case} {round}: {retained}");
                }
                if trigger == "revoked" {
                    assert_eq!(admissions_with_content(&root), 0, "{case} {round}");
                    assert_eq!(neo_plans_with_content(&root), 0, "{case} {round}");
                }
            }
            if counted {
                // Closed after five failed attempts, while the host still fails.
                assert_eq!(admissions_with_content(&root), 0, "{case}");
                assert_eq!(neo_plans_with_content(&root), 0, "{case}");
                fs::remove_file(root.join("fail")).unwrap();
            }
            if trigger == "maintenance" {
                fs::remove_file(&control).unwrap();
            }
            // The affected owner is free: its retained work is gone and its next turn runs.
            let engine = ProcessEngine::new(base(), Some(Seam::FlatEmbedder)).unwrap();
            engine_capture::ProcessCapture::open(&engine, &root.join("db")).unwrap();
            recovery_settled(&engine);
            let next = capture(&engine, owner("run-free"));
            if trigger == "revoked" {
                assert_eq!(next["reason"], "not_captured", "{case}: {next}");
            } else {
                assert_eq!(next["stored"], 2, "{case}: {next}");
            }
            assert_eq!(admissions_with_content(&root), 0, "{case}");
            assert_eq!(neo_plans_with_content(&root), 0, "{case}");
            assert_eq!(capture_state(&engine), None, "{case}");
            engine.close(None).unwrap();
        }
    }
}
