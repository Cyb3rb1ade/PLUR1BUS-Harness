//! RE-05/T1 acceptance behavior, checked against public pinned-Node result bytes.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "recall_support.rs"]
mod support;

use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use plur1bus_engine::capture::accept::{CaptureRuntime, CaptureWorker};
use plur1bus_engine::capture::queue::{CaptureQueue, PressureSnapshot, RuntimeConfig};
use plur1bus_engine::capture::replay_guard::{ReplayGuard, ReplayRows};
use plur1bus_engine::capture::result::result_json;
use plur1bus_engine::context::RequestContext;
use plur1bus_engine::contract::{
    AgentId, Cancel, CaptureOptions, CaptureResult, EgressGate, EngineConfig, EngineError,
    HostError, HostServices, JournalBacklog, LlmPort, PlatformCapabilities, SecretPort, TurnRecord,
};
use serde_json::{json, Value};

struct Worker {
    rows: Arc<Mutex<Vec<String>>>,
    gate: Mutex<Option<mpsc::Receiver<()>>>,
    started: mpsc::Sender<()>,
    active_cancel: Arc<Mutex<Option<Cancel>>>,
}

impl CaptureWorker for Worker {
    fn capture(
        &self,
        turn: &TurnRecord,
        _context: &RequestContext,
        _options: &CaptureOptions,
        replay: ReplayRows,
        cancel: &Cancel,
    ) -> Result<CaptureResult, EngineError> {
        *self.active_cancel.lock().unwrap() = Some(cancel.clone());
        let _ = self.started.send(());
        if let Some(gate) = self.gate.lock().unwrap().take() {
            gate.recv().unwrap();
        }
        if cancel.is_cancelled() {
            return Ok(
                serde_json::from_value(json!({"stored":0,"skipped":1,"reason":"aborted"})).unwrap(),
            );
        }
        replay.on_rows_planned(&[uuid::Uuid::new_v4().to_string()])?;
        self.rows
            .lock()
            .unwrap()
            .push(turn.run_id.clone().unwrap_or_default());
        replay.on_rows_settled()?;
        Ok(serde_json::from_value(json!({"stored":1,"skipped":0})).unwrap())
    }
}

fn turn(workspace: &str) -> TurnRecord {
    serde_json::from_value(json!({"agentId":"capture-agent",
        "principal":{"agentId":"capture-agent","workspace":workspace,"channel":"telegram","accountId":"default",
            "chat":{"id":"capture-chat","kind":"direct"},"trust":"proved"},
        "agent":{"origin":"user","background":false},"messages":[{"role":"user",
            "content":"The release planning meeting takes place every Thursday morning."}],
        "runId":"completed","sessionKey":"capture-session","incognito":false})).unwrap()
}

struct Fixture {
    runtime: CaptureRuntime,
    rows: Arc<Mutex<Vec<String>>>,
    release: mpsc::Sender<()>,
    started: mpsc::Receiver<()>,
    dir: tempfile::TempDir,
    active_cancel: Arc<Mutex<Option<Cancel>>>,
    lookups: mpsc::Receiver<()>,
}

struct ObservableHost {
    inner: Arc<support::TestHost>,
    lookups: mpsc::Sender<()>,
}

impl HostServices for ObservableHost {
    fn state_dir(&self) -> &Path {
        self.inner.state_dir()
    }
    fn config(&self) -> EngineConfig {
        self.inner.config()
    }
    fn workspace_dir(&self, agent: &AgentId) -> Result<Option<PathBuf>, HostError> {
        let result = self.inner.workspace_dir(agent);
        let _ = self.lookups.send(());
        result
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
    fn emit(&self, event: &str, value: Value) {
        self.inner.emit(event, value);
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

impl Fixture {
    fn turn(&self) -> TurnRecord {
        turn(&format!(
            "workspace-dir:v1:{}",
            self.dir
                .path()
                .join("workspace")
                .canonicalize()
                .unwrap()
                .display()
        ))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.release.send(());
        let _ = self.runtime.close(Duration::from_secs(3));
    }
}

fn fixture(block: bool) -> Fixture {
    let dir = physical_tempdir();
    let host = Arc::new(support::TestHost::new(dir.path().into()));
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    host.set_workspace("capture-agent", workspace);
    let (lookup_tx, lookups) = mpsc::channel();
    let host = Arc::new(ObservableHost {
        inner: host,
        lookups: lookup_tx,
    });
    let (release, gate) = mpsc::channel();
    let (started_tx, started) = mpsc::channel();
    let rows = Arc::new(Mutex::new(Vec::new()));
    let active_cancel = Arc::new(Mutex::new(None));
    let worker = Arc::new(Worker {
        rows: rows.clone(),
        gate: Mutex::new(block.then_some(gate)),
        started: started_tx,
        active_cancel: active_cancel.clone(),
    });
    let queue = Arc::new(
        CaptureQueue::new(
            RuntimeConfig::from_value(&json!({"pressureGateEnabled":false})),
            Arc::new(PressureSnapshot::disabled),
        )
        .unwrap(),
    );
    let guard = ReplayGuard::durable(dir.path().join("_capture-turns"), Arc::new(|| 0)).unwrap();
    let runtime = CaptureRuntime::new(host, worker, queue, guard, false).unwrap();
    Fixture {
        runtime,
        rows,
        release,
        started,
        dir,
        active_cancel,
        lookups,
    }
}

fn line(result: &CaptureResult) -> String {
    result_json(result).unwrap()
}

fn golden(name: &str) -> Vec<String> {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/accept.json")).unwrap();
    fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap()["resultLines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|line| line.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn accept_returns_at_once_and_done_resolves_with_counts() {
    let fixture = fixture(true);
    let receipt = fixture
        .runtime
        .accept(fixture.turn(), CaptureOptions::default())
        .unwrap();
    fixture
        .started
        .recv_timeout(Duration::from_secs(3))
        .unwrap();
    assert!(
        receipt.done.try_recv().is_err(),
        "receipt must be observable while the worker is blocked"
    );
    assert_eq!(receipt.accepted_at, 0);
    assert!(uuid::Uuid::parse_str(&receipt.id).is_ok());
    fixture.release.send(()).unwrap();
    assert_eq!(
        line(&receipt.done.recv_timeout(Duration::from_secs(3)).unwrap()),
        golden("completed")[0]
    );
    assert!(fixture.runtime.close(Duration::from_secs(3)));
}

#[test]
fn the_same_run_id_twice_stores_once() {
    let fixture = fixture(false);
    let mut actual = Vec::new();
    for _ in 0..2 {
        let handle = fixture
            .runtime
            .accept(fixture.turn(), CaptureOptions::default())
            .unwrap();
        actual.push(line(
            &handle.done.recv_timeout(Duration::from_secs(3)).unwrap(),
        ));
    }
    assert_eq!(actual, golden("completed"));
    assert_eq!(fixture.rows.lock().unwrap().len(), 1);
    assert!(fixture.runtime.close(Duration::from_secs(3)));
}

#[test]
fn incognito_stores_nothing_and_writes_no_journal_line() {
    let fixture = fixture(false);
    let mut turn = fixture.turn();
    turn.incognito = true;
    let receipt = fixture
        .runtime
        .accept(turn, CaptureOptions::default())
        .unwrap();
    assert_eq!(line(&receipt.done.recv().unwrap()), golden("incognito")[0]);
    assert!(fixture.rows.lock().unwrap().is_empty());
    assert!(!fixture.dir.path().join("_capture-turns").exists());
    assert!(fixture.runtime.close(Duration::from_secs(3)));
}

#[test]
fn abort_before_the_commit_stores_nothing_and_resolves_aborted() {
    let fixture = fixture(true);
    let original = fixture.turn();
    let caller = original.cancel.clone();
    let receipt = fixture
        .runtime
        .accept(original, CaptureOptions::default())
        .unwrap();
    fixture
        .started
        .recv_timeout(Duration::from_secs(3))
        .unwrap();
    (receipt.abort)(Some("synthetic private cancellation detail".into()));
    assert!(
        !caller.is_cancelled(),
        "aborting a receipt must not cancel the caller's input token"
    );
    fixture.release.send(()).unwrap();
    assert_eq!(line(&receipt.done.recv().unwrap()), golden("aborted")[0]);
    assert!(fixture.rows.lock().unwrap().is_empty());
    assert!(!fixture.dir.path().join("_capture-turns").exists());
    assert!(fixture.runtime.close(Duration::from_secs(3)));
}

#[test]
fn two_captures_for_one_agent_run_in_order() {
    let fixture = fixture(true);
    let first = fixture
        .runtime
        .accept(fixture.turn(), CaptureOptions::default())
        .unwrap();
    fixture
        .started
        .recv_timeout(Duration::from_secs(3))
        .unwrap();
    let mut second_turn = fixture.turn();
    second_turn.run_id = Some("second".into());
    let second = fixture
        .runtime
        .accept(second_turn, CaptureOptions::default())
        .unwrap();
    fixture.release.send(()).unwrap();
    first.done.recv_timeout(Duration::from_secs(3)).unwrap();
    second.done.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(*fixture.rows.lock().unwrap(), ["completed", "second"]);
    assert!(fixture.runtime.close(Duration::from_secs(3)));
}

#[test]
fn internal_and_mismatched_principals_match_node_and_never_call_the_worker() {
    for name in ["internal", "principal-mismatch"] {
        let fixture = fixture(false);
        let mut input = serde_json::to_value(fixture.turn()).unwrap();
        if name == "internal" {
            input["agent"] = json!({"origin":"cron","background":true});
        } else {
            input["principal"]["agentId"] = json!("other");
        }
        let receipt = fixture
            .runtime
            .accept(
                serde_json::from_value(input).unwrap(),
                CaptureOptions::default(),
            )
            .unwrap();
        assert_eq!(line(&receipt.done.recv().unwrap()), golden(name)[0]);
        assert!(fixture.rows.lock().unwrap().is_empty());
        assert!(!fixture.dir.path().join("_capture-turns").exists());
        assert!(fixture.runtime.close(Duration::from_secs(3)));
    }
}

#[test]
fn caller_cancellation_reaches_an_active_capture() {
    let fixture = fixture(true);
    let input = fixture.turn();
    let caller = input.cancel.clone();
    let receipt = fixture
        .runtime
        .accept(input, CaptureOptions::default())
        .unwrap();
    fixture
        .started
        .recv_timeout(Duration::from_secs(3))
        .unwrap();
    caller.cancel();
    // The bridge must settle cancellation before the blocked worker is released.
    let deadline = Instant::now() + Duration::from_secs(2);
    while !fixture
        .active_cancel
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .is_cancelled()
        && Instant::now() < deadline
    {
        std::thread::yield_now();
    }
    assert!(fixture
        .active_cancel
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .is_cancelled());
    fixture.release.send(()).unwrap();
    assert_eq!(line(&receipt.done.recv().unwrap()), golden("aborted")[0]);
    assert!(fixture.runtime.close(Duration::from_secs(3)));
}

#[test]
fn unblocked_back_to_back_accepts_enqueue_in_call_order() {
    let fixture = fixture(false);
    let mut receipts = Vec::new();
    let mut expected = Vec::new();
    for index in 0..64 {
        let mut turn = fixture.turn();
        let run = format!("ordered-{index:03}");
        turn.run_id = Some(run.clone());
        receipts.push(
            fixture
                .runtime
                .accept(turn, CaptureOptions::default())
                .unwrap(),
        );
        expected.push(run);
    }
    for receipt in receipts {
        assert_eq!(
            line(&receipt.done.recv_timeout(Duration::from_secs(5)).unwrap()),
            golden("completed")[0]
        );
    }
    assert_eq!(*fixture.rows.lock().unwrap(), expected);
    assert!(fixture.runtime.close(Duration::from_secs(3)));
}

#[test]
fn an_identical_waiter_does_not_block_admission_of_another_turn() {
    let fixture = fixture(true);
    let first = fixture
        .runtime
        .accept(fixture.turn(), CaptureOptions::default())
        .unwrap();
    fixture
        .started
        .recv_timeout(Duration::from_secs(3))
        .unwrap();
    fixture
        .lookups
        .recv_timeout(Duration::from_secs(3))
        .unwrap();
    let duplicate = fixture
        .runtime
        .accept(fixture.turn(), CaptureOptions::default())
        .unwrap();
    let mut other = fixture.turn();
    other.run_id = Some("other-free-turn".into());
    let other = fixture
        .runtime
        .accept(other, CaptureOptions::default())
        .unwrap();
    // The first worker is still blocked: this signal can only come from the other unique turn.
    fixture
        .lookups
        .recv_timeout(Duration::from_secs(3))
        .unwrap();
    assert!(first.done.try_recv().is_err());
    fixture.release.send(()).unwrap();
    assert_eq!(
        line(&first.done.recv_timeout(Duration::from_secs(3)).unwrap()),
        golden("completed")[0]
    );
    assert_eq!(
        line(&duplicate.done.recv_timeout(Duration::from_secs(3)).unwrap()),
        golden("completed")[1]
    );
    assert_eq!(
        line(&other.done.recv_timeout(Duration::from_secs(3)).unwrap()),
        golden("completed")[0]
    );
    assert_eq!(
        *fixture.rows.lock().unwrap(),
        vec!["completed", "other-free-turn"]
    );
    assert!(fixture.runtime.close(Duration::from_secs(3)));
}

#[test]
fn an_unscheduled_deferral_keeps_the_required_node_inline_diagnostic() {
    let fixture = fixture(false);
    let options = serde_json::from_value(json!({ "deferPostTurnLlm": true })).unwrap();
    let receipt = fixture.runtime.accept(fixture.turn(), options).unwrap();
    assert_eq!(
        line(&receipt.done.recv_timeout(Duration::from_secs(3)).unwrap()),
        golden("defer-unscheduled")[0]
    );
    assert!(fixture.runtime.close(Duration::from_secs(3)));
}

// Production rejects symlinks; use the physical system temporary root on macOS too.
fn physical_tempdir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap()
}
