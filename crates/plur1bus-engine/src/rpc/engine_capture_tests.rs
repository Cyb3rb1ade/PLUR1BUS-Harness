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
    let admissions = fs::read_dir(root.join("db/_capture-admissions"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .count();
    assert_eq!(admissions, 0);
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
fn a_malformed_admission_file_is_kept_reported_and_blocks_nobody() {
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
    // RE-D159: capture is served; the unattributable file is a deferred state, not unready.
    assert!(engine.status().ready);
    let (degraded, served) = engine.capture.degradation().unwrap();
    assert_eq!(
        (
            degraded.reason.as_str(),
            degraded.capability.as_str(),
            served
        ),
        (
            "capture-recovery-deferred",
            "capture",
            engine_capture::Served::Deferred
        )
    );
    // RE-D156: an unreadable file is kept and reported, but blocks no capture.
    assert_eq!(capture(&engine, turn("agent", "run-2"))["stored"], 2);
    assert_eq!(capture(&engine, turn("other", "run-3"))["stored"], 2);
    assert_eq!(rows(root, "agent").len(), 4);
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
    let phase = std::env::var("PLUR1BUS_RX_PROCESS_CAPTURE_CRASH_PHASE").unwrap_or_default();
    let neo = phase == "neo-plan";
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
    let handle = engine.capture(turn, options()).unwrap();
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
fn a_turn_killed_after_its_first_row_is_completed_without_duplicates() {
    let scratch = killed("first-row");
    let root = scratch.path().to_path_buf();
    let before = rows(&root, "agent");
    assert_eq!(before.len(), 1);
    let engine = ProcessEngine::new(host(&root), Some(Seam::FlatEmbedder)).unwrap();
    engine.open(&"agent".parse().unwrap()).unwrap();
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
        let other = capture(&engine, turn("other", "run-other-live"));
        assert_eq!(other["stored"], 2, "{drift}: {other}");
        let foreign = capture(&engine, foreign_owner_turn(&root, "run-foreign-live"));
        assert_eq!(foreign["stored"], 2, "{drift}: {foreign}");
        engine.close(None).unwrap();
        drop(engine);
        let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
        engine.open(&"agent".parse().unwrap()).unwrap();
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
    // Another duplicate threshold: closed, the retained turn is not written.
    assert_eq!(pending_admissions(&root), 0);
    assert!(rows(&root, "agent").is_empty());
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
    assert!(engine.status().ready);
    assert_eq!(
        capture_state(&engine),
        Some((
            "capture-recovery-deferred".into(),
            engine_capture::Served::Deferred
        ))
    );
    let retained: Value = serde_json::from_str(
        &fs::read_dir(root.join("db/_capture-admissions"))
            .unwrap()
            .flatten()
            .find_map(|entry| {
                fs::read_to_string(entry.path())
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
    fs::read_dir(root.join("db/_capture-admissions"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| fs::read_to_string(entry.path()).is_ok_and(|text| text.contains(USER)))
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
    let files = fs::read_dir(root.join("db/_capture-admissions"))
        .unwrap()
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .count();
    assert_eq!(files, 0);
}

/// RE-D159 / K2: a directory full of closed entries never refuses capture.
#[test]
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
    let file = fs::read_dir(root.join("db/_capture-admissions"))
        .unwrap()
        .flatten()
        .find(|entry| fs::read_to_string(entry.path()).is_ok_and(|text| text.contains(USER)))
        .unwrap()
        .file_name()
        .to_string_lossy()
        .into_owned();
    let stem = file.strip_suffix(".json").unwrap();
    stem.split_once('-')
        .map_or(stem, |(scope, _)| scope)
        .to_owned()
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
        engine.close(None).unwrap();
    }
    fs::remove_file(root.join("fail")).unwrap();
    let engine = ProcessEngine::new(host(&root), Some(Seam::FlatEmbedder)).unwrap();
    engine_capture::ProcessCapture::open(&engine, &root.join("db")).unwrap();
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

/// RE-D159 / Ruling 10: for every retained kind and trigger, other owners capture on every
/// open, the affected owner is free again after at most five attempts, and no turn text
/// stays after a revocation.
#[test]
fn every_retained_kind_and_trigger_stays_isolated_and_bounded() {
    for kind in ["admission", "neo"] {
        for trigger in [
            "revoked",
            "maintenance",
            "config",
            "identity",
            "transient",
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
                "transient" => fs::write(root.join("fail"), "").unwrap(),
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
            // Six opens: one more than the attempt bound.
            for round in 0..6 {
                let host = Arc::new(CrashHost {
                    inner: base(),
                    root: root.clone(),
                    phase: "toggle".into(),
                });
                let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
                engine_capture::ProcessCapture::open(&engine, &root.join("db")).unwrap();
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
                engine.close(None).unwrap();
                if trigger == "revoked" {
                    assert_eq!(admissions_with_content(&root), 0, "{case} {round}");
                    assert_eq!(neo_plans_with_content(&root), 0, "{case} {round}");
                }
            }
            if trigger == "transient" {
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
