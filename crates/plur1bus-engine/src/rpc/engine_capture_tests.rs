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
    // Capture is served, but the frozen status text stays composition-pending/recall while
    // the journal, job ledger and schema marker are not composed.
    let status = engine.status();
    assert!(!status.ready);
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

#[test]
fn an_unrecoverable_admission_keeps_capture_unserved_and_the_status_not_ready() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    assert_eq!(capture(&engine, turn("agent", "run-1"))["stored"], 2);
    engine.close(None).unwrap();
    drop(engine);
    let corrupt = root
        .join("db/_capture-admissions")
        .join(format!("{}.json", "0".repeat(64)));
    fs::write(&corrupt, b"{\"record\":{\"version\":1}}").unwrap();

    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    // Status reflects capture composition only after the first open or capture.
    assert!(engine.capture.degradation().is_none());
    let handle = engine.open(&"agent".parse().unwrap()).unwrap();
    let status = engine.status();
    assert!(!status.ready);
    let degraded = status.degraded.unwrap();
    assert_eq!(
        (degraded.reason.as_str(), degraded.capability.as_str()),
        ("startup-recovery-incomplete", "capture")
    );
    assert!(matches!(
        engine.capture(turn("agent", "run-2"), options()),
        Err(EngineError::NotAvailable { reason }) if reason == "startup-recovery-incomplete"
    ));
    // Nothing was written past the refused recovery; the original input is retained.
    assert_eq!(rows(root, "agent").len(), 2);
    assert!(corrupt.is_file());
    (handle.close)().unwrap();
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
        if self.phase == "slow" {
            // Slow recovery: every workspace lookup takes long and ignores cancellation.
            fs::write(self.root.join("slow-entered"), "entered").unwrap();
            std::thread::sleep(Duration::from_secs(2));
            return self.inner.workspace_dir(agent);
        }
        let admitted = fs::read_dir(self.root.join("db/_capture-admissions"))
            .into_iter()
            .flatten()
            .flatten()
            .any(|entry| {
                fs::read_to_string(entry.path()).is_ok_and(|text| text.contains("\"record\":{"))
            })
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
    let host = Arc::new(CrashHost {
        inner: host(&root),
        root: root.clone(),
        phase: std::env::var("PLUR1BUS_RX_PROCESS_CAPTURE_CRASH_PHASE").unwrap_or_default(),
    });
    let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    let handle = engine
        .capture(turn("agent", "run-crash"), options())
        .unwrap();
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
    let again = rows(&root, "agent");
    assert_eq!(
        again.iter().map(|row| &row.id).collect::<Vec<_>>(),
        recovered.iter().map(|row| &row.id).collect::<Vec<_>>()
    );
}

/// Admission files whose record is still pending recovery.
fn pending_admissions(root: &Path) -> usize {
    fs::read_dir(root.join("db/_capture-admissions"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter(|entry| {
            let value: Value =
                serde_json::from_slice(&fs::read(entry.path()).unwrap()).unwrap_or(Value::Null);
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
    assert!(engine.capture.degradation().is_none());
    assert_eq!(capture(&engine, turn("agent", "run-after"))["stored"], 2);
    assert_eq!(pending_admissions(root), 0);
}

#[test]
fn an_unfinishable_entry_blocks_only_its_own_agent() {
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
    let degraded = engine.status().degraded.unwrap();
    assert_eq!(
        (degraded.reason.as_str(), degraded.capability.as_str()),
        ("startup-recovery-incomplete", "capture")
    );
    // Another agent captures normally.
    assert_eq!(capture(&engine, turn("other", "run-other"))["stored"], 2);
    // The blocked agent's new turns do not overtake its retained entry.
    assert!(matches!(
        engine.capture(turn("agent", "run-new"), options()),
        Err(EngineError::NotAvailable { reason }) if reason == "startup-recovery-incomplete"
    ));
    let kept = rows(&root, "agent");
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].text, row.text);
    assert_eq!(pending_admissions(&root), 1);
}

#[test]
fn close_during_a_slow_composition_stays_within_its_budget() {
    let scratch = killed("admitted");
    let root = scratch.path().to_path_buf();
    let slow = Arc::new(CrashHost {
        inner: host(&root),
        root: root.clone(),
        phase: "slow".into(),
    });
    let engine = ProcessEngine::new(slow, Some(Seam::FlatEmbedder)).unwrap();
    std::thread::scope(|scope| {
        let opener = scope.spawn(|| engine.open(&"agent".parse().unwrap()));
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
        // Nothing is admitted after close, even while the composition still finishes.
        assert!(matches!(
            engine.capture(turn("agent", "run-late"), options()),
            Err(EngineError::NotAvailable { reason }) if reason == "closed"
        ));
        let _ = opener.join().unwrap();
    });
    drop(engine);
    // The retained input is recovered by the next open.
    assert_eq!(pending_admissions(&root), 1);
    let engine = ProcessEngine::new(host(&root), Some(Seam::FlatEmbedder)).unwrap();
    engine.open(&"agent".parse().unwrap()).unwrap();
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
fn neo_state_exists_only_when_neo_is_enabled() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(host(root), Some(Seam::FlatEmbedder)).unwrap();
    let result = capture(&engine, user_turn(root, "fixture-user", "run-no-neo"));
    assert_eq!(result["stored"], 2, "{result}");
    assert!(!root.join("db/_neo").exists());
}
