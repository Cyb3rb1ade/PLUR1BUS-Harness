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

/// A worker whose recovery pass panics, and whose first sweep does too.
#[derive(Default)]
struct Panicking {
    sweeps: std::sync::atomic::AtomicUsize,
}

impl CaptureWorker for Panicking {
    fn recover_retained(self: Arc<Self>, _steps: &RecoverySteps) {
        panic!("fixture: the recovery pass dies");
    }
    fn expire_retained(self: Arc<Self>, _steps: &RecoverySteps) {
        if self.sweeps.fetch_add(1, Ordering::AcqRel) == 0 {
            panic!("fixture: the sweep dies");
        }
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

/// RE-D163 / m5: a panic in the recovery pass is caught. The runtime that waits for the
/// first pass still returns and serves turns, and the hourly sweep goes on: after a sweep
/// that panicked the next one runs an hour of the host's clock later.
#[test]
fn a_panicking_recovery_pass_never_blocks_the_runtime() {
    const HOUR: i64 = 60 * 60 * 1000;
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
    let worker = Arc::new(Panicking::default());
    let (sent, composed) = mpsc::channel();
    let (clock, pass) = (host.clone(), worker.clone());
    thread::spawn(move || {
        let _ = sent.send(CaptureRuntime::new(clock, pass, queue, replay, false));
    });
    let runtime = composed
        .recv_timeout(Duration::from_secs(10))
        .unwrap_or_else(|_| panic!("the runtime waits for a pass that died"))
        .unwrap();
    let handle = runtime.accept(turn(), CaptureOptions::default()).unwrap();
    let result = handle.done.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(result.reason, None);

    let started = host.now_ms();
    let look = || runtime.look_at_clock_for_test(Duration::from_secs(10));
    assert_eq!(look(), Some(false));
    host.set_now_ms(started + HOUR);
    assert_eq!(look(), Some(true));
    assert_eq!(worker.sweeps.load(Ordering::Acquire), 1);
    // The sweep that panicked did not end the pass.
    assert_eq!(look(), Some(false));
    host.set_now_ms(started + 2 * HOUR);
    assert_eq!(look(), Some(true));
    assert_eq!(worker.sweeps.load(Ordering::Acquire), 2);
    assert!(runtime.close(Duration::from_secs(5)));
}

/// Workspace lookups for agent `agent` take `delay`; with `gated` each one also waits for a
/// permit. Counts the lookups that reached the host and how many were inside it at once.
struct Paced {
    inner: Arc<FakeHost>,
    delay: Duration,
    gated: bool,
    permits: Mutex<usize>,
    entered: std::sync::atomic::AtomicUsize,
    inside: std::sync::atomic::AtomicUsize,
    peak: std::sync::atomic::AtomicUsize,
}

impl Paced {
    fn new(root: &std::path::Path, delay: Duration, gated: bool) -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(FakeHost::new(
                root.to_owned(),
                serde_json::from_value(json!({})).unwrap(),
            )),
            delay,
            gated,
            permits: Mutex::new(0),
            entered: std::sync::atomic::AtomicUsize::new(0),
            inside: std::sync::atomic::AtomicUsize::new(0),
            peak: std::sync::atomic::AtomicUsize::new(0),
        })
    }
    fn permit(&self) {
        *lock(&self.permits) += 1;
    }
}

impl HostServices for Paced {
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
            let inside = self.inside.fetch_add(1, Ordering::AcqRel) + 1;
            self.peak.fetch_max(inside, Ordering::AcqRel);
            self.entered.fetch_add(1, Ordering::AcqRel);
            if self.gated {
                loop {
                    let mut permits = lock(&self.permits);
                    if *permits > 0 {
                        *permits -= 1;
                        break;
                    }
                    drop(permits);
                    thread::sleep(Duration::from_millis(2));
                }
            }
            thread::sleep(self.delay);
            self.inside.fetch_sub(1, Ordering::AcqRel);
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

fn runtime_on(root: &std::path::Path, host: Arc<dyn HostServices>) -> CaptureRuntime {
    let queue = Arc::new(
        CaptureQueue::new(
            RuntimeConfig::from_value(&json!({"pressureGateEnabled":false})),
            Arc::new(PressureSnapshot::disabled),
        )
        .unwrap(),
    );
    let replay = ReplayGuard::durable(root.join("replay"), Arc::new(|| 0)).unwrap();
    CaptureRuntime::new(host, Arc::new(NoRows), queue, replay, false).unwrap()
}

fn owner_turn(owner: &str, run: &str) -> TurnRecord {
    let mut value = serde_json::to_value(turn()).unwrap();
    value["principal"]["user"] = json!(crate::context::harness_user_principal(owner));
    value["principal"]["trust"] = json!("proved");
    value["runId"] = json!(run);
    serde_json::from_value(value).unwrap()
}

/// Poll a state the code under test reaches by itself; a hook, not a timing assumption.
fn eventually(what: &str, mut reached: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(30);
    while !reached() {
        assert!(Instant::now() < end, "{what}");
        thread::sleep(Duration::from_millis(2));
    }
}

/// RE-D163 / I1: a host that answers, but slowly, loses no turn. With two seconds per
/// lookup, four turns of one agent sent together (two owners) are all captured: the third
/// and fourth wait for a place instead of ending unanswered, and waiting takes no thread,
/// so never more than two lookups are inside the host.
#[test]
fn a_slow_host_loses_no_turn_and_never_gets_more_than_two_lookups() {
    let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let host = Paced::new(root.path(), Duration::from_secs(2), false);
    let runtime = runtime_on(root.path(), host.clone());
    let handles = [
        ("owner-a", "run-1"),
        ("owner-a", "run-2"),
        ("owner-b", "run-3"),
        ("owner-b", "run-4"),
    ]
    .map(|(owner, run)| {
        runtime
            .accept(owner_turn(owner, run), CaptureOptions::default())
            .unwrap()
    });
    for (index, handle) in handles.iter().enumerate() {
        let result = handle.done.recv_timeout(Duration::from_secs(60)).unwrap();
        assert_eq!(result.reason, None, "turn {index}");
        assert!(runtime.0.calls.outstanding() <= crate::capture::retained::HOST_CALLS_PER_AGENT);
    }
    assert_eq!(host.entered.load(Ordering::Acquire), 4);
    assert_eq!(host.peak.load(Ordering::Acquire), 2);
    assert!(runtime.close(Duration::from_secs(5)));
}

/// RE-D163 / I2: a turn that waits for a place for its lookup keeps its place in its
/// agent's order for one second at most, then its ticket is parked. A turn of the same
/// agent whose identity is known is therefore not held up by an earlier one that still
/// waits. Places are not handed out in order, so either turn may be the one that gets the
/// freed place; whichever it is, it goes on while the other still waits.
#[test]
fn a_turn_waiting_for_a_lookup_place_parks_its_ticket() {
    let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let host = Paced::new(root.path(), Duration::ZERO, true);
    let runtime = runtime_on(root.path(), host.clone());
    let never = Cancel::never();
    // A busy host: both places of the agent are taken by lookups that are still out.
    let far = Instant::now() + Duration::from_secs(5);
    let first = runtime.0.calls.begin("agent", &never, &never, far);
    let second = runtime.0.calls.begin("agent", &never, &never, far);
    assert_eq!(runtime.0.calls.outstanding(), 2);
    let turns = [("owner-a", "run-1"), ("owner-b", "run-2")].map(|(owner, run)| {
        runtime
            .accept(owner_turn(owner, run), CaptureOptions::default())
            .unwrap()
    });
    eventually("both turns wait for a place", || {
        runtime.0.calls.waiting() == 2
    });
    // After the patience both have stepped aside, though neither has a lookup yet.
    eventually("the waiting turns never parked their tickets", || {
        lock(&runtime.0.admissions.agents).parked.len() == 2
    });
    assert_eq!(host.entered.load(Ordering::Acquire), 0);
    // One place frees: one of the two gets it, and the host answers that one lookup.
    drop(first);
    eventually("no turn took the freed place", || {
        host.entered.load(Ordering::Acquire) == 1
    });
    host.permit();
    // The other turn takes the place that lookup gave back and waits in the host.
    eventually("the other turn never got a place", || {
        host.entered.load(Ordering::Acquire) == 2
    });
    // The turn whose identity is known goes on, whichever of the two it is.
    let mut results = [None, None];
    eventually("the turn with a known identity is held up", || {
        for (result, turn) in results.iter_mut().zip(&turns) {
            if result.is_none() {
                *result = turn.done.try_recv().ok();
            }
        }
        results.iter().any(Option::is_some)
    });
    let finished = results.iter().flatten().collect::<Vec<_>>();
    assert_eq!(finished.len(), 1);
    assert_eq!(finished[0].reason, None);
    host.permit();
    for (result, turn) in results.iter_mut().zip(&turns) {
        let result = result
            .take()
            .unwrap_or_else(|| turn.done.recv_timeout(Duration::from_secs(30)).unwrap());
        assert_eq!(result.reason, None);
    }
    drop(second);
    assert!(runtime.close(Duration::from_secs(5)));
}
