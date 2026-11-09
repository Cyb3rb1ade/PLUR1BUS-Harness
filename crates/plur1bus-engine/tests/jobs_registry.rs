//! Native registry admission, persistence and unported-job refusal.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_engine::{
    contract::{AgentId, Cancel, EngineError, JobName, JobRegistry, RunOptions},
    jobs::registry::{JobBody, JobContext, JobReport, Registry},
};
use std::{fs, sync::Arc};
fn root() -> tempfile::TempDir {
    tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
struct Completed;
impl JobBody for Completed {
    fn name(&self) -> JobName {
        JobName::KnowledgeUpdate
    }
    fn run(&self, _context: &JobContext, _cancel: &Cancel) -> Result<JobReport, EngineError> {
        Ok(JobReport::completed())
    }
}
fn agent() -> AgentId {
    serde_json::from_value(serde_json::json!("alpha")).unwrap()
}
fn options() -> RunOptions {
    serde_json::from_value(serde_json::json!({})).unwrap()
}
#[test]
fn unported_jobs_are_visible_and_refused_without_side_effects() {
    let root = root();
    let registry = Registry::new(root.path(), Arc::new(|| 1800000000000)).unwrap();
    assert_eq!(registry.list().len(), 20);
    let inventory = registry.inventory().unwrap();
    assert!(inventory
        .iter()
        .all(|entry| !entry.available && entry.reason.as_deref() == Some("not-implemented")));
    for spec in registry.list() {
        assert!(
            matches!(registry.run(spec.name, &agent(), options(), &Cancel::never()), Err(EngineError::NotAvailable{reason}) if reason == "not-implemented")
        );
    }
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}
#[test]
fn completed_body_has_a_durable_run_and_dry_run_has_no_persisted_record() {
    let root = root();
    let registry = Registry::new(root.path(), Arc::new(|| 1800000000000)).unwrap();
    registry.bind(Arc::new(Completed)).unwrap();
    assert!(registry.bind(Arc::new(Completed)).is_err());
    let run = registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never(),
        )
        .unwrap();
    let history = registry
        .history(
            &agent(),
            serde_json::from_value(serde_json::json!({})).unwrap(),
        )
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(
        serde_json::to_value(&history[0]).unwrap(),
        serde_json::to_value(run).unwrap()
    );
    let dry = registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            serde_json::from_value(serde_json::json!({"dryRun":true})).unwrap(),
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(dry.reason.as_deref(), Some("dry_run_unsupported"));
    assert_eq!(
        registry
            .history(
                &agent(),
                serde_json::from_value(serde_json::json!({})).unwrap()
            )
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        fs::read_dir(root.path().join("alpha/running"))
            .unwrap()
            .count(),
        0
    );
}

#[cfg(feature = "testkit")]
struct Scripted {
    name: JobName,
    mode: String,
    calls: std::sync::atomic::AtomicUsize,
    entered: std::sync::mpsc::Sender<()>,
    gate: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
}
#[cfg(feature = "testkit")]
impl JobBody for Scripted {
    fn name(&self) -> JobName {
        self.name
    }
    fn run(&self, _context: &JobContext, _cancel: &Cancel) -> Result<JobReport, EngineError> {
        use plur1bus_engine::contract::{JobOutcome, StoreError};
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        match self.mode.as_str() {
            "failed" => Err(StoreError::Unavailable.into()),
            "skipped" => Ok(JobReport {
                outcome: JobOutcome::Skipped,
                reason: Some("disabled".into()),
            }),
            "incomplete" => Ok(JobReport {
                outcome: JobOutcome::Incomplete,
                reason: Some("pending".into()),
            }),
            "concurrent" => {
                self.entered.send(()).unwrap();
                let guard = self.gate.0.lock().unwrap();
                drop(self.gate.1.wait_while(guard, |open| !*open).unwrap());
                Ok(JobReport::completed())
            }
            _ => Ok(JobReport::completed()),
        }
    }
}
#[cfg(feature = "testkit")]
#[test]
fn ten_actual_node_run_scenarios_match_results_rows_and_events() {
    use plur1bus_engine::{jobs::ledger::JobLedger, text::json::write_json};
    use serde_json::Value;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Condvar, Mutex,
    };
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/job-runs.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let root = root();
        let ids = AtomicUsize::new(0);
        let events = Arc::new(Mutex::new(Vec::new()));
        let observed = events.clone();
        let registry = Arc::new(
            Registry::new(root.path(), Arc::new(|| 1800000000000))
                .unwrap()
                .with_id_factory(Arc::new(move || {
                    format!("run-{}", ids.fetch_add(1, Ordering::SeqCst) + 1)
                }))
                .with_events(Arc::new(move |run| {
                    observed
                        .lock()
                        .unwrap()
                        .push(serde_json::to_value(run).unwrap());
                    Ok(())
                })),
        );
        let (send, receive) = std::sync::mpsc::channel();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let job: JobName = serde_json::from_value(
            case["input"]
                .get("job")
                .cloned()
                .unwrap_or(serde_json::json!("knowledge-update")),
        )
        .unwrap();
        let body = Arc::new(Scripted {
            name: job,
            mode: case["input"]["body"].as_str().unwrap().into(),
            calls: AtomicUsize::new(0),
            entered: send,
            gate: gate.clone(),
        });
        registry.bind(body.clone()).unwrap();
        let opts: RunOptions = serde_json::from_value(case["input"]["options"].clone()).unwrap();
        let results = if body.mode == "concurrent" {
            let first = registry.clone();
            let handle = std::thread::spawn(move || {
                first.run(job, &agent(), opts, &Cancel::never()).unwrap()
            });
            receive
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap();
            let second = registry
                .run(job, &agent(), options(), &Cancel::never())
                .unwrap();
            *gate.0.lock().unwrap() = true;
            gate.1.notify_all();
            vec![handle.join().unwrap(), second]
        } else {
            (0..case["input"]["repeat"].as_u64().unwrap_or(1))
                .map(|_| {
                    registry
                        .run(job, &agent(), opts.clone(), &Cancel::never())
                        .unwrap()
                })
                .collect()
        };
        let expected: Vec<Value> = case["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| serde_json::from_str(v.as_str().unwrap()).unwrap())
            .collect();
        assert_eq!(
            serde_json::to_value(results).unwrap(),
            serde_json::to_value(expected).unwrap(),
            "{}",
            case["input"]["name"]
        );
        assert_eq!(
            body.calls.load(Ordering::SeqCst),
            case["calls"].as_u64().unwrap() as usize
        );
        let ledger = JobLedger::open(root.path(), "alpha").unwrap();
        let rows: Vec<_> = ledger
            .snapshot(&Cancel::never())
            .unwrap()
            .rows
            .iter()
            .map(write_json)
            .collect();
        let expected: Vec<_> = case["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_owned())
            .collect();
        assert_eq!(rows, expected, "{}", case["input"]["name"]);
        assert!(ledger.orphan_markers(&Cancel::never()).unwrap().is_empty());
        let expected: Vec<Value> = case["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| {
                assert_eq!(v["name"], "job.run");
                serde_json::from_str(v["value"].as_str().unwrap()).unwrap()
            })
            .collect();
        assert_eq!(*events.lock().unwrap(), expected);
        if case["input"]["name"] == "dry-run" {
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        }
    }
}

struct Cancels;
impl JobBody for Cancels {
    fn name(&self) -> JobName {
        JobName::KnowledgeUpdate
    }
    fn run(&self, _context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        cancel.cancel();
        Err(plur1bus_engine::contract::StoreError::Unavailable.into())
    }
}
#[test]
fn cancellation_before_start_is_read_only_and_admitted_cancellation_settles_metadata() {
    let root = root();
    let registry = Registry::new(root.path(), Arc::new(|| 1800000000000)).unwrap();
    registry.bind(Arc::new(Cancels)).unwrap();
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(registry
        .run(JobName::KnowledgeUpdate, &agent(), options(), &cancel)
        .is_err());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    assert!(registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never()
        )
        .is_err());
    let rows = registry
        .history(
            &agent(),
            serde_json::from_value(serde_json::json!({})).unwrap(),
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].reason.as_deref(), Some("aborted"));
    assert_eq!(
        fs::read_dir(root.path().join("alpha/running"))
            .unwrap()
            .count(),
        0
    );
}
#[test]
fn close_releases_idle_sessions_and_event_failure_does_not_erase_a_run() {
    let root = root();
    let registry = Registry::new(root.path(), Arc::new(|| 1800000000000))
        .unwrap()
        .with_events(Arc::new(|_| {
            Err(plur1bus_engine::contract::StoreError::Unavailable.into())
        }));
    registry.bind(Arc::new(Completed)).unwrap();
    registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never(),
        )
        .unwrap();
    registry.close();
    assert!(
        matches!(registry.run(JobName::KnowledgeUpdate, &agent(), options(), &Cancel::never()), Err(EngineError::NotAvailable{reason}) if reason == "closed")
    );
    let next = Registry::new(root.path(), Arc::new(|| 1800000000001)).unwrap();
    next.bind(Arc::new(Completed)).unwrap();
    next.run(
        JobName::KnowledgeUpdate,
        &agent(),
        options(),
        &Cancel::with_deadline(std::time::Instant::now() + std::time::Duration::from_secs(2)),
    )
    .unwrap();
    assert_eq!(
        next.history(
            &agent(),
            serde_json::from_value(serde_json::json!({})).unwrap()
        )
        .unwrap()
        .len(),
        2
    );
}
#[test]
fn history_filters_before_limiting_and_refuses_unrepresentable_legacy_rows() {
    use std::sync::atomic::{AtomicI64, Ordering};
    let root = root();
    let clock = Arc::new(AtomicI64::new(300));
    let current = clock.clone();
    let registry = Registry::new(
        root.path(),
        Arc::new(move || current.load(Ordering::SeqCst)),
    )
    .unwrap();
    registry.bind(Arc::new(Completed)).unwrap();
    for now in [300, 100, 200] {
        clock.store(now, Ordering::SeqCst);
        registry
            .run(
                JobName::KnowledgeUpdate,
                &agent(),
                options(),
                &Cancel::never(),
            )
            .unwrap();
    }
    let rows = registry
        .history(
            &agent(),
            serde_json::from_value(serde_json::json!({"since":200,"limit":1})).unwrap(),
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].started_at.as_i64(), Some(200));
    let beta: AgentId = serde_json::from_value(serde_json::json!("beta")).unwrap();
    assert!(registry
        .history(
            &beta,
            serde_json::from_value(serde_json::json!({})).unwrap()
        )
        .unwrap()
        .is_empty());
    assert!(!root.path().join("beta").exists());
    let ledger = plur1bus_engine::jobs::ledger::JobLedger::open(root.path(), "alpha").unwrap();
    ledger
        .append(
            &plur1bus_engine::text::json::parse_json(r#"{"runId":"legacy","job":"unknown"}"#)
                .unwrap(),
            &Cancel::never(),
        )
        .unwrap();
    assert!(registry
        .history(
            &agent(),
            serde_json::from_value(serde_json::json!({})).unwrap()
        )
        .is_err());
    assert_eq!(ledger.snapshot(&Cancel::never()).unwrap().rows.len(), 4);
}

#[cfg(feature = "testkit")]
#[test]
fn reused_run_identifier_is_refused_before_calling_the_body_again() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Condvar, Mutex,
    };
    let root = root();
    let registry = Registry::new(root.path(), Arc::new(|| 1800000000000))
        .unwrap()
        .with_id_factory(Arc::new(|| "same-run".into()));
    let (send, _) = std::sync::mpsc::channel();
    let body = Arc::new(Scripted {
        name: JobName::KnowledgeUpdate,
        mode: "completed".into(),
        calls: AtomicUsize::new(0),
        entered: send,
        gate: Arc::new((Mutex::new(false), Condvar::new())),
    });
    registry.bind(body.clone()).unwrap();
    registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never(),
        )
        .unwrap();
    assert!(registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never()
        )
        .is_err());
    assert_eq!(body.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        fs::read_dir(root.path().join("alpha/running"))
            .unwrap()
            .count(),
        0
    );
}

#[cfg(feature = "testkit")]
#[test]
fn jobs_registry_child() {
    let Ok(path) = std::env::var("PLUR1BUS_JOB_REGISTRY_TEST_ROOT") else {
        return;
    };
    let point = std::env::var("PLUR1BUS_JOB_REGISTRY_TEST_POINT").unwrap();
    let root = std::path::PathBuf::from(path);
    let ready = root.join("ready");
    let observer: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |phase| {
        if phase == point {
            fs::write(&ready, b"ready").unwrap();
            loop {
                std::thread::park();
            }
        }
    });
    struct Observed(Arc<dyn Fn(&str) + Send + Sync>);
    impl JobBody for Observed {
        fn name(&self) -> JobName {
            JobName::KnowledgeUpdate
        }
        fn run(&self, _: &JobContext, _: &Cancel) -> Result<JobReport, EngineError> {
            self.0("body");
            Ok(JobReport::completed())
        }
    }
    let registry = Registry::new(&root, Arc::new(|| 1800000000000))
        .unwrap()
        .with_id_factory(Arc::new(|| "old".into()))
        .with_observer(observer.clone());
    registry.bind(Arc::new(Observed(observer))).unwrap();
    registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never(),
        )
        .unwrap();
    assert!(
        root.join("ready").exists(),
        "expected run observer was never reached"
    );
}
#[cfg(unix)]
#[cfg(feature = "testkit")]
#[test]
fn sigkill_during_body_or_completion_recovers_without_reexecution_or_duplicate_rows() {
    use plur1bus_engine::contract::JobOutcome;
    use std::{
        os::unix::process::ExitStatusExt,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    for phase in ["body", "run-row-committed", "run-marker-retired"] {
        let root = root();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "jobs_registry_child"])
            .env("PLUR1BUS_JOB_REGISTRY_TEST_ROOT", root.path())
            .env("PLUR1BUS_JOB_REGISTRY_TEST_POINT", phase)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !root.path().join("ready").exists() && Instant::now() < deadline {
            assert!(child.try_wait().unwrap().is_none());
            std::thread::sleep(Duration::from_millis(5));
        }
        let ready = root.path().join("ready").exists();
        child.kill().unwrap();
        assert_eq!(child.wait().unwrap().signal(), Some(9));
        assert!(ready, "{phase}");
        let registry = Registry::new(root.path(), Arc::new(|| 1800000000100)).unwrap();
        registry.bind(Arc::new(Completed)).unwrap();
        let new = registry
            .run(
                JobName::KnowledgeUpdate,
                &agent(),
                options(),
                &Cancel::with_deadline(Instant::now() + Duration::from_secs(5)),
            )
            .unwrap();
        let history = registry
            .history(
                &agent(),
                serde_json::from_value(serde_json::json!({})).unwrap(),
            )
            .unwrap();
        assert_eq!(history.len(), 2, "{phase}");
        assert_eq!(history[0].run_id, new.run_id);
        assert_eq!(history[1].run_id, "old");
        if phase == "body" {
            assert_eq!(history[1].outcome, JobOutcome::Failed);
            assert_eq!(history[1].reason.as_deref(), Some("crash"));
        } else {
            assert_eq!(history[1].outcome, JobOutcome::Completed);
        }
        assert_eq!(
            fs::read_dir(root.path().join("alpha/running"))
                .unwrap()
                .count(),
            0
        );
    }
}

#[test]
fn completion_requires_the_original_session_and_unchanged_marker() {
    use plur1bus_engine::{jobs::ledger::JobLedger, text::json::parse_json};
    let marker = parse_json(
        r#"{"runId":"old","job":"knowledge-update","phase":null,"trigger":"manual","startedAt":100}"#,
    )
    .unwrap();
    let row = parse_json(r#"{"runId":"old","job":"knowledge-update","phase":null,"trigger":"manual","startedAt":100,"agentId":"alpha","outcome":"completed"}"#).unwrap();
    for mode in ["generation", "marker", "agent"] {
        let root = root();
        let mut session = JobLedger::open(root.path(), "alpha")
            .unwrap()
            .session(&Cancel::never())
            .unwrap();
        assert!(session.start(&marker, &Cancel::never()).is_err());
        session.recover(100.0, &Cancel::never()).unwrap();
        let admission = session.start(&marker, &Cancel::never()).unwrap();
        if mode == "generation" {
            drop(session);
            session = JobLedger::open(root.path(), "alpha")
                .unwrap()
                .session(&Cancel::never())
                .unwrap();
        } else if mode == "marker" {
            fs::write(root.path().join("alpha/running/old.started"), b"{}").unwrap();
        }
        let supplied = if mode == "agent" {
            parse_json(r#"{"runId":"old","job":"knowledge-update","phase":null,"trigger":"manual","startedAt":100,"agentId":"beta","outcome":"completed"}"#).unwrap()
        } else {
            row.clone()
        };
        assert!(
            session
                .finish(admission, &supplied, &Cancel::never())
                .is_err(),
            "{mode}"
        );
        assert!(root.path().join("alpha/running/old.started").exists());
        assert!(!root.path().join("alpha/ledger.jsonl").exists());
    }
}
