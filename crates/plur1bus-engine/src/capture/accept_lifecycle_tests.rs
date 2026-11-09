//! Deterministic admission gate around the capture/shutdown boundary.
#![allow(
    clippy::unwrap_used,
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
