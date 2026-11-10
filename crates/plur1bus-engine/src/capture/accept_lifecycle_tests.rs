//! Deterministic admission gate around the capture/shutdown boundary.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "fixture setup and synchronization must succeed"
)]

use super::*;
use crate::{
    capture::queue::{PressureSnapshot, RuntimeConfig},
    contract::testing::FakeHost,
};
use serde_json::json;

struct NoRows;

impl CaptureWorker for NoRows {
    fn capture(
        &self,
        _turn: &TurnRecord,
        _context: &RequestContext,
        _options: &CaptureOptions,
        _replay: ReplayRows,
        _cancel: &Cancel,
    ) -> Result<CaptureResult, EngineError> {
        Ok(counts(0, 0, None))
    }
}

fn turn() -> TurnRecord {
    serde_json::from_value(json!({
        "agentId":"agent",
        "principal":{"agentId":"agent","workspace":"workspace:v1:fixture","channel":"cli",
            "accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"inferred"},
        "agent":{"origin":"user","background":false},
        "messages":[{"role":"user","content":"Keep the archive receipt for every test run."}],
        "incognito":false,
        "runId":"admission-fixture"
    }))
    .unwrap()
}

#[test]
fn close_cannot_finish_before_a_started_admission_is_tracked() {
    let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let host = Arc::new(FakeHost::new(
        root.path().to_owned(),
        serde_json::from_value(json!({})).unwrap(),
    ));
    let queue = Arc::new(
        CaptureQueue::new(
            RuntimeConfig::from_value(&json!({"pressureGateEnabled":false})),
            Arc::new(PressureSnapshot::disabled),
        )
        .unwrap(),
    );
    let replay = ReplayGuard::durable(root.path().join("replay"), Arc::new(|| 0)).unwrap();
    let runtime =
        Arc::new(CaptureRuntime::new(host, Arc::new(NoRows), queue, replay, false).unwrap());

    let gate = lock(&runtime.0.admissions.agents);
    let accepting = runtime.clone();
    let accept = thread::spawn(move || accepting.accept(turn(), CaptureOptions::default()));
    let deadline = Instant::now() + Duration::from_secs(5);
    while runtime.0.admissions.next.load(Ordering::Acquire) == 0 {
        assert!(
            Instant::now() < deadline,
            "admission did not reach the gate"
        );
        thread::yield_now();
    }

    let closing = runtime.clone();
    let (finished, done) = mpsc::channel();
    let close = thread::spawn(move || {
        let drained = closing.close(Duration::from_secs(3));
        finished.send(drained).unwrap();
    });
    let early = done.recv_timeout(Duration::from_millis(200));
    drop(gate);
    let handle = accept.join().unwrap().unwrap();
    close.join().unwrap();
    assert!(
        early.is_err(),
        "close returned while admission was still untracked"
    );
    assert!(done.recv_timeout(Duration::from_secs(1)).unwrap());
    assert!(handle.done.recv_timeout(Duration::from_secs(1)).is_ok());

    let rejected = runtime.accept(turn(), CaptureOptions::default()).unwrap();
    assert_eq!(
        rejected.done.recv().unwrap().reason.as_deref(),
        Some("engine-closed")
    );
}

/// The first workspace lookup never answers until the fixture lets go; later ones answer.
struct HangFirst {
    inner: Arc<FakeHost>,
    hung: AtomicBool,
    entered: Mutex<mpsc::Sender<()>>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl HostServices for HangFirst {
    fn state_dir(&self) -> &std::path::Path {
        self.inner.state_dir()
    }
    fn config(&self) -> crate::contract::EngineConfig {
        self.inner.config()
    }
    fn workspace_dir(
        &self,
        agent: &crate::contract::AgentId,
    ) -> Result<Option<std::path::PathBuf>, HostError> {
        if !self.hung.swap(true, Ordering::AcqRel) {
            let _ = lock(&self.entered).send(());
            let _ = lock(&self.release).recv();
        }
        self.inner.workspace_dir(agent)
    }
    fn llm(&self) -> Option<&dyn crate::contract::LlmPort> {
        self.inner.llm()
    }
    fn secrets(&self) -> Option<&dyn crate::contract::SecretPort> {
        self.inner.secrets()
    }
    fn egress(&self) -> &dyn crate::contract::EgressGate {
        self.inner.egress()
    }
    fn emit(&self, event: &str, payload: serde_json::Value) {
        self.inner.emit(event, payload);
    }
    fn now_ms(&self) -> i64 {
        self.inner.now_ms()
    }
    fn platform(&self) -> &crate::contract::PlatformCapabilities {
        self.inner.platform()
    }
    fn journal_backlog(&self) -> Option<crate::contract::JournalBacklog> {
        self.inner.journal_backlog()
    }
}

/// A worker that only reports whether retained work exists.
struct Retaining(bool);

impl CaptureWorker for Retaining {
    fn has_retained(&self) -> bool {
        self.0
    }
    fn capture(
        &self,
        _turn: &TurnRecord,
        _context: &RequestContext,
        _options: &CaptureOptions,
        _replay: ReplayRows,
        _cancel: &Cancel,
    ) -> Result<CaptureResult, EngineError> {
        Ok(counts(0, 0, None))
    }
}

/// RE-D162 / R2: an identity lookup the host never answers has a deadline. It ends only its
/// own turn, with what a failed lookup reports, and a later turn of the same agent is not
/// held up by it: neither in the admission itself nor while retained work makes turns
/// resolve their owner first.
#[test]
fn an_unanswered_identity_lookup_ends_only_its_own_turn() {
    for retained in [false, true] {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let (entered, hanging) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let host = Arc::new(HangFirst {
            inner: Arc::new(FakeHost::new(
                root.path().to_owned(),
                serde_json::from_value(json!({})).unwrap(),
            )),
            hung: AtomicBool::new(false),
            entered: Mutex::new(entered),
            release: Mutex::new(gate),
        });
        let queue = Arc::new(
            CaptureQueue::new(
                RuntimeConfig::from_value(
                    &json!({"pressureGateEnabled":false,"captureTimeoutMs":1500}),
                ),
                Arc::new(PressureSnapshot::disabled),
            )
            .unwrap(),
        );
        let replay = ReplayGuard::durable(root.path().join("replay"), Arc::new(|| 0)).unwrap();
        let worker = Arc::new(Retaining(retained));
        let runtime = CaptureRuntime::new(host, worker, queue, replay, false).unwrap();

        let first = runtime.accept(turn(), CaptureOptions::default()).unwrap();
        hanging.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut later = turn();
        later.run_id = Some("later".into());
        let second = runtime.accept(later, CaptureOptions::default()).unwrap();

        let passed = second.done.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(passed.reason, None, "retained={retained}");
        let ended = first.done.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(
            ended
                .reason
                .as_deref()
                .is_some_and(|reason| reason.starts_with("Error textLen=")),
            "retained={retained}: {:?}",
            ended.reason
        );
        drop(release);
        assert!(runtime.close(Duration::from_secs(5)), "retained={retained}");
    }
}

/// Every workspace lookup for agent `agent` hangs until the fixture lets go; other agents
/// are answered at once. Counts the lookups that reached the host.
struct HangAgent {
    inner: Arc<FakeHost>,
    entered: std::sync::atomic::AtomicUsize,
    released: AtomicBool,
}

impl HostServices for HangAgent {
    fn state_dir(&self) -> &std::path::Path {
        self.inner.state_dir()
    }
    fn config(&self) -> crate::contract::EngineConfig {
        self.inner.config()
    }
    fn workspace_dir(
        &self,
        agent: &crate::contract::AgentId,
    ) -> Result<Option<std::path::PathBuf>, HostError> {
        if agent.as_str() == "agent" {
            self.entered.fetch_add(1, Ordering::AcqRel);
            while !self.released.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(5));
            }
        }
        self.inner.workspace_dir(agent)
    }
    fn llm(&self) -> Option<&dyn crate::contract::LlmPort> {
        self.inner.llm()
    }
    fn secrets(&self) -> Option<&dyn crate::contract::SecretPort> {
        self.inner.secrets()
    }
    fn egress(&self) -> &dyn crate::contract::EgressGate {
        self.inner.egress()
    }
    fn emit(&self, event: &str, payload: serde_json::Value) {
        self.inner.emit(event, payload);
    }
    fn now_ms(&self) -> i64 {
        self.inner.now_ms()
    }
    fn platform(&self) -> &crate::contract::PlatformCapabilities {
        self.inner.platform()
    }
    fn journal_backlog(&self) -> Option<crate::contract::JournalBacklog> {
        self.inner.journal_backlog()
    }
}

fn turn_of(agent: &str, run: &str) -> TurnRecord {
    let mut value = serde_json::to_value(turn()).unwrap();
    value["agentId"] = json!(agent);
    value["principal"]["agentId"] = json!(agent);
    value["runId"] = json!(run);
    serde_json::from_value(value).unwrap()
}

/// RE-D163 / I1: lookups the host has not answered are bounded. With a host that never
/// answers for one agent, a hundred turns of that agent leave at most the per-agent bound
/// of lookup threads, every one of them ends with what an unanswered lookup reports, and
/// a turn of another agent with a three-second deadline is captured meanwhile.
#[test]
fn unanswered_lookups_are_bounded_and_never_reach_another_agent() {
    for retained in [false, true] {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let host = Arc::new(HangAgent {
            inner: Arc::new(FakeHost::new(
                root.path().to_owned(),
                serde_json::from_value(json!({})).unwrap(),
            )),
            entered: std::sync::atomic::AtomicUsize::new(0),
            released: AtomicBool::new(false),
        });
        let queue = Arc::new(
            CaptureQueue::new(
                RuntimeConfig::from_value(
                    &json!({"pressureGateEnabled":false,"captureTimeoutMs":1500}),
                ),
                Arc::new(PressureSnapshot::disabled),
            )
            .unwrap(),
        );
        let replay = ReplayGuard::durable(root.path().join("replay"), Arc::new(|| 0)).unwrap();
        let worker = Arc::new(Retaining(retained));
        let runtime = CaptureRuntime::new(host.clone(), worker, queue, replay, false).unwrap();

        let hanging = (0..100)
            .map(|index| {
                runtime
                    .accept(
                        turn_of("agent", &format!("run-{index}")),
                        CaptureOptions::default(),
                    )
                    .unwrap()
            })
            .collect::<Vec<_>>();
        let mut other = turn_of("other", "run-other");
        other.cancel = Cancel::with_deadline(Instant::now() + Duration::from_secs(3));
        let other = runtime.accept(other, CaptureOptions::default()).unwrap();
        let passed = other.done.recv_timeout(Duration::from_secs(4)).unwrap();
        assert_eq!(passed.reason, None, "retained={retained}");

        let end = Instant::now() + Duration::from_secs(20);
        for (index, handle) in hanging.iter().enumerate() {
            let left = end.saturating_duration_since(Instant::now());
            let ended = handle
                .done
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("retained={retained}: turn {index} never ended"));
            assert!(
                ended
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.starts_with("Error textLen=")),
                "retained={retained} {index}: {:?}",
                ended.reason
            );
        }
        // No more lookups reached the host than may be outstanding for one agent, and no
        // more threads wait for it.
        assert!(
            runtime.0.calls.outstanding() <= crate::capture::retained::HOST_CALLS_PER_AGENT,
            "retained={retained}: {} lookup threads",
            runtime.0.calls.outstanding()
        );
        assert!(
            host.entered.load(Ordering::Acquire) <= 2,
            "retained={retained}: {} lookups reached the host",
            host.entered.load(Ordering::Acquire)
        );
        host.released.store(true, Ordering::Release);
        assert!(runtime.close(Duration::from_secs(5)), "retained={retained}");
    }
}
