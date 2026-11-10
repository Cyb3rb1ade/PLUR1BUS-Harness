//! Fragment compaction after capture through the process composition (RE-D161).
use super::*;
use crate::store::fragment_compactor::{FragmentTables, OptimizePlan, OptimizeResult};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

/// Agent tables that always report enough fragments and record every optimize.
struct Tables {
    counts: AtomicUsize,
    optimized: Mutex<Vec<String>>,
    result: Mutex<OptimizeResult>,
    /// Block every optimize until released (or, when `honor`, until cancelled).
    block: AtomicBool,
    honor: bool,
    entered: AtomicBool,
    released: AtomicBool,
}

impl Tables {
    fn new(result: OptimizeResult) -> Arc<Self> {
        Self::with(result, false, false)
    }
    fn with(result: OptimizeResult, block: bool, honor: bool) -> Arc<Self> {
        Arc::new(Self {
            counts: AtomicUsize::new(0),
            optimized: Mutex::new(Vec::new()),
            result: Mutex::new(result),
            block: AtomicBool::new(block),
            honor,
            entered: AtomicBool::new(false),
            released: AtomicBool::new(false),
        })
    }
    fn optimized(&self) -> Vec<String> {
        self.optimized.lock().unwrap().clone()
    }
}

impl FragmentTables for Tables {
    fn fragment_count(&self, _agent: &str, _cancel: &Cancel) -> Option<u64> {
        self.counts.fetch_add(1, Ordering::SeqCst);
        Some(64)
    }
    fn optimize(&self, agent: &str, _plan: &OptimizePlan, cancel: &Cancel) -> OptimizeResult {
        self.optimized.lock().unwrap().push(agent.to_owned());
        if self.block.load(Ordering::SeqCst) {
            self.entered.store(true, Ordering::SeqCst);
            while !self.released.load(Ordering::SeqCst) {
                if self.honor && cancel.is_cancelled() {
                    return OptimizeResult::Shutdown;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        self.result.lock().unwrap().clone()
    }
}

fn compaction_host(root: &Path, compaction: &Value) -> Arc<FakeHost> {
    let host = host(root);
    let mut config = serde_json::to_value(host.config()).unwrap();
    config["runtime"] = json!({ "lancedbCompaction": compaction });
    host.set_config(serde_json::from_value(config).unwrap());
    host
}

fn engine_with(root: &Path, compaction: &Value, tables: Option<Arc<Tables>>) -> ProcessEngine {
    let engine =
        ProcessEngine::new(compaction_host(root, compaction), Some(Seam::FlatEmbedder)).unwrap();
    if let Some(tables) = tables {
        engine.capture.compact_with_for_test(tables);
    }
    engine
}

fn every_write() -> Value {
    json!({"fragmentThreshold":8,"checkEveryWrites":1})
}

fn eventually(what: &str, done: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(std::time::Instant::now() < deadline, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}

#[test]
fn a_stored_turn_compacts_its_agent_table_once_and_an_empty_one_never() {
    let scratch = scratch();
    let root = scratch.path();
    let tables = Tables::new(OptimizeResult::Compacted);
    let engine = engine_with(root, &every_write(), Some(tables.clone()));
    // No message: nothing stored, nothing noted.
    let empty = serde_json::from_value(turn_value("agent", "run-empty", &json!([]))).unwrap();
    assert_eq!(capture(&engine, empty)["stored"], 0);
    // A replayed turn stores nothing either.
    assert_eq!(capture(&engine, turn("agent", "run-1"))["stored"], 2);
    eventually("first compaction", || tables.optimized().len() == 1);
    assert_eq!(capture(&engine, turn("agent", "run-1"))["stored"], 0);
    std::thread::sleep(Duration::from_millis(200));
    // One turn with two rows crosses two due points and still compacts once.
    assert_eq!(tables.optimized(), ["agent"]);
    assert_eq!(tables.counts.load(Ordering::SeqCst), 2);
    engine.close(None).unwrap();
}

#[test]
fn a_failing_compaction_never_fails_capture_and_is_retried_at_the_next_due_point() {
    let scratch = scratch();
    let root = scratch.path();
    let tables = Tables::new(OptimizeResult::Failed(Some("backend".into())));
    let engine = engine_with(root, &every_write(), Some(tables.clone()));
    assert_eq!(capture(&engine, turn("agent", "run-1"))["stored"], 2);
    eventually("first attempt", || tables.optimized().len() == 1);
    assert_eq!(pending_admissions(root), 0);
    assert_eq!(capture(&engine, turn("agent", "run-2"))["stored"], 2);
    eventually("second attempt", || tables.optimized().len() == 2);
    assert_eq!(rows(root, "agent").len(), 4);
    // No status degradation is reported for compaction.
    assert!(engine.capture.degradation().is_none());
    engine.close(None).unwrap();
}

#[test]
fn disabled_compaction_never_runs_and_tracks_nothing() {
    let scratch = scratch();
    let root = scratch.path();
    let tables = Tables::new(OptimizeResult::Compacted);
    let mut compaction = every_write();
    compaction["enabled"] = json!(false);
    let engine = engine_with(root, &compaction, Some(tables.clone()));
    for run in ["run-1", "run-2", "run-3"] {
        assert_eq!(capture(&engine, turn("agent", run))["stored"], 2);
    }
    std::thread::sleep(Duration::from_millis(200));
    assert!(tables.optimized().is_empty());
    assert_eq!(tables.counts.load(Ordering::SeqCst), 0);
    assert_eq!(engine.capture.compaction_load_for_test(), (0, 0));
    engine.close(None).unwrap();
}

#[test]
fn parallel_turns_of_one_agent_run_one_compaction_at_a_time() {
    let scratch = scratch();
    let root = scratch.path();
    let tables = Tables::with(OptimizeResult::Compacted, true, false);
    let engine = Arc::new(engine_with(root, &every_write(), Some(tables.clone())));
    let handles = (0..4)
        .map(|index| {
            let engine = engine.clone();
            std::thread::spawn(move || capture(&engine, turn("agent", &format!("run-{index}"))))
        })
        .collect::<Vec<_>>();
    for handle in handles {
        assert_eq!(handle.join().unwrap()["stored"], 2);
    }
    eventually("compaction running", || {
        tables.entered.load(Ordering::SeqCst)
    });
    // Every turn answered while the one compaction runs; at most one check per agent waits.
    assert_eq!(tables.optimized(), ["agent"]);
    assert_eq!(engine.capture.compaction_load_for_test(), (1, 1));
    tables.block.store(false, Ordering::SeqCst);
    tables.released.store(true, Ordering::SeqCst);
    engine.close(None).unwrap();
}

#[test]
fn another_owner_captures_and_recalls_while_a_compaction_hangs() {
    let scratch = scratch();
    let root = scratch.path();
    let tables = Tables::with(OptimizeResult::Compacted, true, false);
    let engine = engine_with(root, &every_write(), Some(tables.clone()));
    assert_eq!(capture(&engine, turn("agent", "run-1"))["stored"], 2);
    eventually("compaction running", || {
        tables.entered.load(Ordering::SeqCst)
    });
    tables.block.store(false, Ordering::SeqCst);
    let started = std::time::Instant::now();
    // Another agent, and another owner of the same agent, are served at once.
    assert_eq!(capture(&engine, turn("other", "run-other"))["stored"], 2);
    let second = capture(&engine, user_turn(root, "owner-b", "run-owner-b"));
    assert_eq!(second["stored"], 2, "{second}");
    let recalled = methods::dispatch(
        &engine,
        "engine.recall",
        &json!({"query":{"query":"Which labels does the archive test project use?",
            "principal":principal("other"),"agent":{"origin":"user","background":false}},
            "options":{"reranker":"off"}}),
        &Cancel::never(),
    );
    assert!(recalled.is_ok(), "{recalled:?}");
    assert!(started.elapsed() < Duration::from_secs(10));
    // The other agent's check waits behind the hanging one (the pin's one-at-a-time
    // chain); the same agent's due point joins the check in flight.
    assert_eq!(tables.optimized(), ["agent"]);
    tables.released.store(true, Ordering::SeqCst);
    eventually("queued check", || tables.optimized().len() == 2);
    assert_eq!(tables.optimized(), ["agent", "other"]);
    engine.close(None).unwrap();
}

#[test]
fn close_ends_a_running_compaction_within_its_budget() {
    let scratch = scratch();
    let root = scratch.path();
    let tables = Tables::with(OptimizeResult::Compacted, true, true);
    let engine = engine_with(root, &every_write(), Some(tables.clone()));
    assert_eq!(capture(&engine, turn("agent", "run-1"))["stored"], 2);
    eventually("compaction running", || {
        tables.entered.load(Ordering::SeqCst)
    });
    let started = std::time::Instant::now();
    engine.close(Some(Duration::from_millis(500))).unwrap();
    assert!(started.elapsed() < Duration::from_millis(1500));
    // No run after close.
    assert_eq!(tables.optimized(), ["agent"]);
    assert!(matches!(
        engine.capture(turn("agent", "run-late"), options()),
        Err(EngineError::NotAvailable { reason }) if reason == "closed"
    ));
}

#[test]
fn close_never_waits_past_its_budget_for_a_compaction_that_ignores_it() {
    let scratch = scratch();
    let root = scratch.path();
    let tables = Tables::with(OptimizeResult::Compacted, true, false);
    let engine = engine_with(root, &every_write(), Some(tables.clone()));
    assert_eq!(capture(&engine, turn("agent", "run-1"))["stored"], 2);
    eventually("compaction running", || {
        tables.entered.load(Ordering::SeqCst)
    });
    let started = std::time::Instant::now();
    let closed = engine.close(Some(Duration::from_millis(300)));
    assert!(started.elapsed() < Duration::from_millis(1500));
    assert!(matches!(
        closed,
        Err(EngineError::NotAvailable { reason }) if reason == "capture-drain-incomplete"
    ));
    tables.released.store(true, Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(tables.optimized(), ["agent"]);
}

fn fragments(root: &Path, agent: &str) -> u64 {
    Store::open(
        &root.join("db/current").join(agent),
        OpenMode::ReadOnly,
        None,
    )
    .unwrap()
    .fragment_count(&Cancel::never())
    .unwrap()
}

#[test]
fn compaction_merges_capture_fragments_without_losing_rows() {
    let scratch = scratch();
    let root = scratch.path();
    // A disabled compactor shows the growth the pin's compactor exists for.
    let mut off = every_write();
    off["enabled"] = json!(false);
    let engine = engine_with(root, &off, None);
    for index in 0..5 {
        let stored = capture(&engine, turn("agent", &format!("run-off-{index}")));
        assert_eq!(stored["stored"], 2);
    }
    engine.close(None).unwrap();
    let grown = fragments(root, "agent");
    assert!(grown >= 8, "{grown}");
    // The real compactor on the real table: the next turn reaches the threshold.
    let engine = engine_with(root, &every_write(), None);
    assert_eq!(capture(&engine, turn("agent", "run-on"))["stored"], 2);
    eventually("compacted table", || fragments(root, "agent") < 4);
    assert_eq!(rows(root, "agent").len(), 12);
    engine.close(None).unwrap();
}
