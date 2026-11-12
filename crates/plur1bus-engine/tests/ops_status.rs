//! Actual C3 status aggregation, backlog validation and bounded host waits.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "synthetic oracle assertions"
)]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    contract::{
        ContractVersion, EmbeddingIdentity, EngineError, JobsHealth, JournalBacklog, ModelsStatus,
        SharedMemorySupport, StoreError,
    },
    ops::status::{
        normalize_journal, schema_version, JournalSource, StatusReporter, StatusSources,
    },
};
use serde_json::{json, Value};
use std::{
    fs,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
struct Sources {
    case: Value,
    identity: EmbeddingIdentity,
    calls: [AtomicUsize; 4],
}
impl StatusSources for Sources {
    fn jobs(&self) -> Result<JobsHealth, EngineError> {
        self.calls[0].fetch_add(1, Ordering::SeqCst);
        if self.case["jobsFailure"] == true {
            return Err(StoreError::Corrupt.into());
        }
        Ok(serde_json::from_value(self.case["jobs"].clone()).unwrap())
    }
    fn models(&self) -> Result<ModelsStatus, EngineError> {
        self.calls[1].fetch_add(1, Ordering::SeqCst);
        if self.case["modelsFailure"] == true {
            return Err(StoreError::Corrupt.into());
        }
        Ok(serde_json::from_value(self.case["models"].clone()).unwrap())
    }
    fn identity(&self) -> Result<Option<EmbeddingIdentity>, EngineError> {
        self.calls[2].fetch_add(1, Ordering::SeqCst);
        if self.case["identityFailure"] == true {
            return Err(StoreError::Corrupt.into());
        }
        Ok((self.case["noIdentity"] != true).then(|| self.identity.clone()))
    }
    fn shared(&self) -> Result<SharedMemorySupport, EngineError> {
        self.calls[3].fetch_add(1, Ordering::SeqCst);
        if self.case["sharedFailure"] == true {
            return Err(StoreError::Corrupt.into());
        }
        Ok(serde_json::from_value(self.case["shared"].clone()).unwrap())
    }
    fn opened_agents(&self) -> usize {
        self.case["agents"].as_u64().unwrap() as usize
    }
}
fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/ops/golden/status.json")).unwrap()
}
fn sources(g: &Value, c: &Value) -> Arc<Sources> {
    Arc::new(Sources {
        case: c.clone(),
        identity: serde_json::from_value(g["identity"].clone()).unwrap(),
        calls: std::array::from_fn(|_| AtomicUsize::new(0)),
    })
}
fn canonical(v: &mut Value) {
    match v {
        Value::Number(n) => *v = json!(n.as_f64().unwrap()),
        Value::Array(a) => a.iter_mut().for_each(canonical),
        Value::Object(o) => o.values_mut().for_each(canonical),
        _ => {}
    }
}
fn same(mut a: Value, mut b: Value, label: &str) {
    canonical(&mut a);
    canonical(&mut b);
    assert_eq!(a, b, "{label}");
}
#[test]
fn actual_node_status_snapshots_and_raw_journal_validation() {
    let g = golden();
    for c in g["normalizers"].as_array().unwrap() {
        same(
            json!(normalize_journal(&c["input"])),
            c["result"].clone(),
            "normalizer",
        );
    }
    for c in g["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let base = root.path().join("store");
        fs::create_dir(&base).unwrap();
        let path = base.join("_schema.json");
        let marker = if c["current"].is_null() {
            "{broken".to_owned()
        } else {
            json!({"schemaVersion":c["current"]}).to_string()
        };
        fs::write(&path, &marker).unwrap();
        let source = sources(&g, c);
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_worker = calls.clone();
        let case = c.clone();
        let (tx, rx) = mpsc::channel::<()>();
        let rx = Mutex::new(rx);
        let callback: Option<Arc<JournalSource>> = if c["noJournal"] == true {
            None
        } else {
            Some(Arc::new(move || {
                calls_worker.fetch_add(1, Ordering::SeqCst);
                if case["journalFailure"] == true {
                    return Err(StoreError::Corrupt.into());
                }
                if case["journalNever"] == true {
                    let _ = rx.lock().unwrap().recv();
                    return Ok(None);
                }
                Ok(normalize_journal(&case["journal"]))
            }))
        };
        let reporter = StatusReporter::new(
            source.clone(),
            base.clone(),
            ContractVersion::X1170,
            callback,
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "construction starts no host callback"
        );
        let got = reporter.status();
        drop(tx);
        same(json!(got), c["result"].clone(), c["name"].as_str().unwrap());
        for (i, key) in ["jobs", "models", "identity", "shared"].iter().enumerate() {
            assert_eq!(
                source.calls[i].load(Ordering::SeqCst) as u64,
                c["calls"][key].as_u64().unwrap()
            );
        }
        assert_eq!(
            calls.load(Ordering::SeqCst) as u64,
            c["calls"]["journal"].as_u64().unwrap()
        );
        assert_eq!(fs::read_to_string(path).unwrap(), marker);
        assert_eq!(fs::read_dir(base).unwrap().count(), 1);
    }
}
#[test]
fn a_slow_host_callback_is_single_flight_and_later_recovers() {
    let g = golden();
    let c = &g["cases"][0];
    let root = support::canonical_tempdir();
    let base = root.path().join("never-created");
    let source = sources(&g, c);
    let calls = Arc::new(AtomicUsize::new(0));
    let worker_calls = calls.clone();
    let (tx, rx) = mpsc::channel();
    let rx = Mutex::new(rx);
    let callback: Arc<JournalSource> = Arc::new(move || {
        worker_calls.fetch_add(1, Ordering::SeqCst);
        let _ = rx.lock().unwrap().recv();
        Ok(Some(JournalBacklog {
            entries: 3.into(),
            oldest_at: Some(7.into()),
        }))
    });
    let reporter =
        StatusReporter::new(source, base.clone(), ContractVersion::X1170, Some(callback));
    for _ in 0..2 {
        let start = Instant::now();
        assert!(reporter.status().journal.is_none());
        assert!(
            start.elapsed() < Duration::from_millis(500),
            "a blocked host must not block status indefinitely"
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(!base.exists());
    tx.send(()).unwrap();
    let got = reporter.status().journal.unwrap();
    assert_eq!(got.entries.as_u64(), Some(3));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
#[test]
fn schema_status_is_diagnostic_and_never_initializes_or_migrates() {
    let root = support::canonical_tempdir();
    let base = root.path().join("absent");
    assert_eq!(schema_version(&base).as_deref(), Some("0"));
    assert!(!base.exists());
    fs::create_dir(&base).unwrap();
    let p = base.join("_schema.json");
    for (raw, expected) in [
        (r#"{"schemaVersion":"99"}"#, Some("99")),
        (r#"{"schemaVersion":"01"}"#, Some("01")),
        (r#"{"schemaVersion":"0","schemaVersion":"1"}"#, Some("1")),
        (r#"{"schemaVersion":1}"#, None),
        (r#"{"schemaVersion":"-1"}"#, None),
        (r#"{"schemaVersion":""}"#, None),
        (r#"{"schemaVersion":"\\ud800"}"#, None),
        ("{torn", None),
    ] {
        fs::write(&p, raw).unwrap();
        assert_eq!(schema_version(&base).as_deref(), expected);
        assert_eq!(fs::read_to_string(&p).unwrap(), raw);
    }
    fs::remove_file(&p).unwrap();
    fs::create_dir(&p).unwrap();
    assert!(schema_version(&base).is_none());
    assert!(p.is_dir());
}

#[test]
fn overlapping_status_calls_keep_one_timed_out_host_worker() {
    let g = golden();
    assert_eq!(g["concurrent"]["journalCalls"], 4);
    let root = support::canonical_tempdir();
    let calls = Arc::new(AtomicUsize::new(0));
    let worker_calls = calls.clone();
    let (tx, rx) = mpsc::channel::<()>();
    let rx = Mutex::new(rx);
    let callback: Arc<JournalSource> = Arc::new(move || {
        worker_calls.fetch_add(1, Ordering::SeqCst);
        let _ = rx.lock().unwrap().recv();
        Ok(None)
    });
    let reporter = StatusReporter::new(
        sources(&g, &g["cases"][0]),
        root.path().join("absent"),
        ContractVersion::X1170,
        Some(callback),
    );
    let barrier = std::sync::Barrier::new(4);
    let started = Instant::now();
    let journals = std::thread::scope(|scope| {
        let handles = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    reporter.status().journal
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert!(started.elapsed() < Duration::from_millis(500));
    assert_eq!(json!(journals), g["concurrent"]["journals"]);
    // RE-D37: same visible nulls; one bounded outstanding host task instead of four.
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    drop(tx);
}
