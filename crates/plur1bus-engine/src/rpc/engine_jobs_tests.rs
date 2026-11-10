//! Status and the job registry through the actual process engine (RE-D157, RE-D158).
#![allow(clippy::unwrap_used, reason = "synthetic fixture failures are fatal")]
use super::*;
use crate::{contract::testing::FakeHost, store::directory::TrustedDirectory};
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};

/// 2026-01-13T12:00:00Z, the parity clock.
const NOW: i64 = 1_768_305_600_000;

fn engine(root: &Path, neo: bool) -> (Arc<FakeHost>, ProcessEngine) {
    let host = Arc::new(FakeHost::new(
        root.join("state"),
        serde_json::from_value(json!({"baseDbPath":root.join("db"),"neo":{"enabled":neo}}))
            .unwrap(),
    ));
    host.set_now_ms(NOW);
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    (host, engine)
}
fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
fn alpha() -> AgentId {
    serde_json::from_value(json!("alpha")).unwrap()
}
fn options(trigger: &str) -> RunOptions {
    serde_json::from_value(json!({"trigger":trigger})).unwrap()
}
fn history(engine: &ProcessEngine) -> Vec<JobRun> {
    engine
        .jobs()
        .history(&alpha(), serde_json::from_value(json!({})).unwrap())
        .unwrap()
}
fn status(engine: &ProcessEngine) -> Value {
    serde_json::to_value(engine.status()).unwrap()
}
fn refused<T: std::fmt::Debug>(result: Result<T, EngineError>, expected: &str) {
    let detail = format!("{result:?}");
    assert!(
        matches!(result, Err(EngineError::NotAvailable { reason }) if reason == expected),
        "expected not-available/{expected}, got {detail}"
    );
}

#[test]
fn status_reports_journal_jobs_and_schema_from_real_sources_without_creating_files() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (host, engine) = engine(temp.path(), false);
    let first = status(&engine);
    assert!(!base.exists(), "status created the store base");
    assert_eq!(first["ready"], true, "{first}");
    // The pin's model degradation is kept: warming models do not make the engine not ready.
    assert_eq!(
        first["degraded"],
        json!({"reason":"models-warming","capability":"embedding"})
    );
    assert_eq!(first["journal"], Value::Null);
    assert_eq!(first["jobs"], json!({"ledger":"ok","agents":[]}));
    assert_eq!(
        first["storeSchema"],
        json!({"current":"0","expected":"1"}),
        "a missing marker is schema 0, as at the pin"
    );

    host.set_journal_backlog(Some(
        serde_json::from_value(json!({"entries":3,"oldestAt":1700})).unwrap(),
    ));
    engine.models().warm(&Cancel::never(), false).unwrap();
    let handle = engine.open(&alpha()).unwrap();
    fs::write(base.join("_schema.json"), br#"{"schemaVersion":"1"}"#).unwrap();
    let served = status(&engine);
    assert_eq!(served["ready"], true, "{served}");
    assert_eq!(served["degraded"], Value::Null, "{served}");
    assert_eq!(served["agents"], 1);
    assert_eq!(served["journal"], json!({"entries":3,"oldestAt":1700}));
    assert_eq!(served["storeSchema"]["current"], "1");
    assert_eq!(served["jobs"], json!({"ledger":"ok","agents":[]}));
    assert!(!base.join("_jobs").exists(), "status created the jobs root");
    (handle.close)().unwrap();
    engine.close(None).unwrap();
    assert_eq!(status(&engine)["ready"], false);
}

#[test]
fn the_registry_lists_twenty_jobs_and_owner_data_jobs_answer_a_fixed_reason() {
    let temp = scratch();
    let base = temp.path().join("db");
    // Neo is enabled: embedding-drain would read private Neo rows and has no bound authority.
    let (_host, engine) = engine(temp.path(), true);
    let specs = engine.jobs().list();
    assert_eq!(specs.len(), 20);
    for spec in specs {
        let expected = if spec.needs_llm {
            "not-implemented"
        } else {
            "job-authority-unbound"
        };
        // The cron context is no owner evidence, and an agent ID is no grant (F13).
        for trigger in ["manual", "cron"] {
            refused(
                engine
                    .jobs()
                    .run(spec.name, &alpha(), options(trigger), &Cancel::never()),
                expected,
            );
        }
    }
    assert!(history(&engine).is_empty());
    assert!(!base.exists(), "a refused job created files");
    assert_eq!(status(&engine)["jobs"], json!({"ledger":"ok","agents":[]}));
    assert_eq!(status(&engine)["ready"], true);
    engine.close(None).unwrap();
    refused(
        engine.jobs().run(
            JobName::GcRun,
            &alpha(),
            options("manual"),
            &Cancel::never(),
        ),
        "closed",
    );
}

#[test]
fn an_allowed_job_runs_and_its_run_is_in_the_ledger_history_and_status() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (host, engine) = engine(temp.path(), false);
    // A dry run takes no session and writes no ledger entry.
    let dry = engine
        .jobs()
        .run(
            JobName::EmbeddingDrain,
            &alpha(),
            serde_json::from_value(json!({"dryRun":true})).unwrap(),
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(dry.reason.as_deref(), Some("dry_run_unsupported"));
    assert!(!base.join("_jobs/alpha").exists());
    let run = engine
        .jobs()
        .run(
            JobName::EmbeddingDrain,
            &alpha(),
            options("cron"),
            &Cancel::never(),
        )
        .unwrap();
    let wire = serde_json::to_value(&run).unwrap();
    assert_eq!(wire["job"], "embedding-drain");
    assert_eq!(wire["agentId"], "alpha");
    assert_eq!(wire["trigger"], "cron");
    assert_eq!(wire["outcome"], "skipped");
    assert_eq!(wire["reason"], "neo_disabled");
    let ledger = fs::read_to_string(base.join("_jobs/alpha/ledger.jsonl")).unwrap();
    assert_eq!(ledger.lines().count(), 1);
    assert!(ledger.contains(run.run_id.as_str()));
    let running = base.join("_jobs/alpha/running");
    assert!(!running.exists() || fs::read_dir(&running).unwrap().next().is_none());
    let listed = history(&engine);
    assert_eq!(listed.len(), 1);
    assert_eq!(serde_json::to_value(&listed[0]).unwrap(), wire);
    assert!(host
        .events()
        .iter()
        .any(|(name, payload)| name == "job.run" && payload["runId"] == wire["runId"]));

    let jobs = status(&engine)["jobs"].clone();
    assert_eq!(
        jobs,
        json!({"ledger":"ok","agents":[{
            "agentId":"alpha",
            "lastRuns":{"embedding-drain":{"runId":wire["runId"],"outcome":"skipped",
                "reason":"neo_disabled","trigger":"cron","startedAt":NOW,"finishedAt":NOW,"attempt":1}},
            "running":[],
            "breaker":{"sweep":"2026-01-13","sessions":0,"limit":3,"open":false},
            "unreadableLines":0}]})
    );
    assert_eq!(status(&engine)["ready"], true);
    // Allowing one job grants nothing else.
    refused(
        engine.jobs().run(
            JobName::KnowledgeUpdate,
            &alpha(),
            options("manual"),
            &Cancel::never(),
        ),
        "job-authority-unbound",
    );
    refused(
        engine.jobs().run(
            JobName::RemDream,
            &alpha(),
            options("manual"),
            &Cancel::never(),
        ),
        "not-implemented",
    );
    engine.close(None).unwrap();
}

#[test]
fn an_unusable_jobs_root_keeps_the_engine_not_ready() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    let handle = engine.open(&alpha()).unwrap();
    assert_eq!(status(&engine)["ready"], true);
    fs::write(base.join("_jobs"), b"not a directory").unwrap();
    let broken = status(&engine);
    assert_eq!(broken["ready"], false, "{broken}");
    assert_eq!(
        broken["degraded"],
        json!({"reason":"composition-invalid","capability":"jobs"})
    );
    assert_eq!(broken["jobs"]["ledger"], "unavailable");
    assert!(engine
        .jobs()
        .run(
            JobName::EmbeddingDrain,
            &alpha(),
            options("manual"),
            &Cancel::never()
        )
        .is_err());
    assert_eq!(fs::read(base.join("_jobs")).unwrap(), b"not a directory");
    fs::remove_file(base.join("_jobs")).unwrap();
    assert_eq!(status(&engine)["ready"], true);
    (handle.close)().unwrap();
    engine.close(None).unwrap();
}

fn beta() -> AgentId {
    serde_json::from_value(json!("beta")).unwrap()
}
fn drain(engine: &ProcessEngine, agent: &AgentId, cancel: &Cancel) -> Result<JobRun, EngineError> {
    engine
        .jobs()
        .run(JobName::EmbeddingDrain, agent, options("manual"), cancel)
}

#[test]
fn one_agents_incomplete_job_recovery_affects_only_that_agent_and_is_retried() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    let blocked = base.join("_jobs/alpha/ledger.jsonl");
    fs::create_dir_all(&blocked).unwrap();
    refused(
        drain(&engine, &alpha(), &Cancel::never()),
        "startup-recovery-incomplete",
    );
    // Isolation (RE-D160): the engine stays ready and another agent's jobs run.
    let after = status(&engine);
    assert_eq!(after["ready"], true, "{after}");
    assert_ne!(after["degraded"]["capability"], "jobs", "{after}");
    // The pin reports an unreadable ledger as `unavailable`; that is display, not readiness.
    assert_eq!(after["jobs"]["ledger"], "unavailable");
    drain(&engine, &beta(), &Cancel::never()).unwrap();
    // The same agent is retried on its next call.
    refused(
        drain(&engine, &alpha(), &Cancel::never()),
        "startup-recovery-incomplete",
    );
    fs::remove_dir(&blocked).unwrap();
    drain(&engine, &alpha(), &Cancel::never()).unwrap();
    let repaired = status(&engine);
    assert_eq!(repaired["ready"], true, "{repaired}");
    assert_eq!(repaired["jobs"]["ledger"], "ok");
    engine.close(None).unwrap();
}

#[test]
fn an_unsupported_or_malformed_schema_marker_keeps_the_engine_not_ready() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    // A missing marker on a store that does not exist yet is legacy 0, as at the pin.
    assert_eq!(status(&engine)["ready"], true);
    let handle = engine.open(&alpha()).unwrap();
    let marker = base.join("_schema.json");
    for (bytes, current) in [
        (&br#"{"schemaVersion":"2"}"#[..], json!("2")),
        (&b"{not json"[..], Value::Null),
    ] {
        fs::write(&marker, bytes).unwrap();
        let broken = status(&engine);
        assert_eq!(broken["ready"], false, "{broken}");
        assert_eq!(
            broken["degraded"],
            json!({"reason":"schema-unsupported","capability":"store"})
        );
        assert_eq!(broken["storeSchema"]["current"], current);
    }
    fs::write(&marker, br#"{"schemaVersion":"1"}"#).unwrap();
    assert_eq!(status(&engine)["ready"], true);
    fs::remove_file(&marker).unwrap();
    assert_eq!(status(&engine)["ready"], true);
    (handle.close)().unwrap();
    engine.close(None).unwrap();
}

#[test]
fn a_held_session_lease_bounds_runs_and_never_blocks_history() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    drain(&engine, &alpha(), &Cancel::never()).unwrap();
    let engine = Arc::new(engine);
    let agent_dir = base.join("_jobs/beta");
    fs::create_dir_all(&agent_dir).unwrap();
    // Another process holds beta's registry session lease.
    let held = TrustedDirectory::open(&agent_dir).unwrap();
    let lease = crate::store::kernel_lease::acquire(
        &held,
        "job-registry-session",
        &Cancel::never(),
        &mut || {},
    )
    .unwrap();
    // A run without a deadline ends with a fixed error after the session-start budget.
    let (done, finished) = mpsc::channel();
    let runner = engine.clone();
    let started = Instant::now();
    let worker = std::thread::spawn(move || {
        let _ = done.send(drain(&runner, &beta(), &Cancel::never()).map(|run| run.run_id));
    });
    std::thread::sleep(Duration::from_millis(200));
    // History of the waiting agent answers at once.
    let (sent, listed) = mpsc::channel();
    let reader = engine.clone();
    std::thread::spawn(move || {
        let _ = sent.send(
            reader
                .jobs()
                .history(&beta(), serde_json::from_value(json!({})).unwrap())
                .map(|runs| runs.len()),
        );
    });
    let listed = listed.recv_timeout(Duration::from_millis(500));
    assert!(
        matches!(listed, Ok(Ok(0))),
        "history waited or failed: {listed:?}"
    );
    let result = finished.recv_timeout(Duration::from_secs(8));
    assert!(started.elapsed() < Duration::from_secs(8));
    let result = result.unwrap();
    refused(result, "job-session-busy");
    worker.join().unwrap();
    // A cancelled (disconnected) caller ends its wait.
    let cancel = Cancel::never();
    let (done, finished) = mpsc::channel();
    let runner = engine.clone();
    let token = cancel.clone();
    let worker = std::thread::spawn(move || {
        let _ = done.send(drain(&runner, &beta(), &token).map(|run| run.run_id));
    });
    std::thread::sleep(Duration::from_millis(200));
    cancel.cancel();
    let result = finished.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(
        matches!(result, Err(EngineError::Cancelled(_))),
        "{result:?}"
    );
    worker.join().unwrap();
    // Nothing is left that blocks the next attempt, and alpha is unaffected.
    drop(lease);
    drain(&engine, &beta(), &Cancel::never()).unwrap();
    assert_eq!(history(&engine).len(), 1);
    assert_eq!(status(&engine)["ready"], true);
    engine.close(None).unwrap();
}

#[test]
fn ledgers_are_isolated_per_agent_and_damaged_ledgers_are_reported_not_fatal() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    drain(&engine, &alpha(), &Cancel::never()).unwrap();
    assert!(engine
        .jobs()
        .history(&beta(), serde_json::from_value(json!({})).unwrap())
        .unwrap()
        .is_empty());
    let jobs = status(&engine)["jobs"].clone();
    assert_eq!(jobs["agents"].as_array().unwrap().len(), 1);
    assert_eq!(jobs["agents"][0]["agentId"], "alpha");
    // Corrupt lines are counted, not fatal.
    let ledger = base.join("_jobs/alpha/ledger.jsonl");
    let mut text = fs::read_to_string(&ledger).unwrap();
    text.push_str("{broken\n[1]\n");
    fs::write(&ledger, &text).unwrap();
    let damaged = status(&engine);
    assert_eq!(damaged["jobs"]["ledger"], "ok");
    assert_eq!(damaged["jobs"]["agents"][0]["unreadableLines"], 2);
    assert_eq!(damaged["ready"], true);
    // An over-limit ledger is unavailable for display; readiness stays (pin).
    fs::create_dir_all(base.join("_jobs/beta")).unwrap();
    fs::write(base.join("_jobs/beta/ledger.jsonl"), "{}\n".repeat(50_002)).unwrap();
    let over = status(&engine);
    assert_eq!(over["jobs"]["ledger"], "unavailable");
    assert_eq!(over["ready"], true);
    engine.close(None).unwrap();
}

#[test]
fn status_after_close_makes_no_host_callback_and_dry_runs_create_nothing() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (host, engine) = engine(temp.path(), false);
    let dry = engine
        .jobs()
        .run(
            JobName::EmbeddingDrain,
            &alpha(),
            serde_json::from_value(json!({"dryRun":true})).unwrap(),
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(dry.reason.as_deref(), Some("dry_run_unsupported"));
    assert!(!base.exists(), "a dry run created files");
    host.set_journal_backlog(Some(
        serde_json::from_value(json!({"entries":1,"oldestAt":null})).unwrap(),
    ));
    assert_eq!(status(&engine)["journal"]["entries"], 1);
    engine.close(None).unwrap();
    let closed = status(&engine);
    assert_eq!(closed["ready"], false);
    assert_eq!(closed["journal"], Value::Null, "{closed}");
    assert_eq!(
        closed["degraded"],
        json!({"reason":"closed","capability":"engine"})
    );
}

#[test]
fn close_during_job_recovery_stays_within_its_budget() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    let agent_dir = base.join("_jobs/alpha");
    fs::create_dir_all(&agent_dir).unwrap();
    // A previous registry session (another process) still holds this agent's lifecycle lease.
    let held = TrustedDirectory::open(&agent_dir).unwrap();
    let lease = crate::store::kernel_lease::acquire(
        &held,
        "job-registry-session",
        &Cancel::never(),
        &mut || {},
    )
    .unwrap();
    let engine = Arc::new(engine);
    let (done, finished) = mpsc::channel();
    let runner = engine.clone();
    let worker = std::thread::spawn(move || {
        let result = runner.jobs().run(
            JobName::EmbeddingDrain,
            &alpha(),
            options("manual"),
            &Cancel::never(),
        );
        let _ = done.send(result.map(|run| run.run_id));
    });
    // The run waits in its session start (recovery) for the held lease.
    assert!(finished.recv_timeout(Duration::from_millis(300)).is_err());
    let started = Instant::now();
    let _ = engine.close(Some(Duration::from_millis(300)));
    assert!(started.elapsed() < Duration::from_millis(1500));
    let result = finished.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(result.is_err(), "a run admitted after close: {result:?}");
    worker.join().unwrap();
    assert!(!agent_dir.join("ledger.jsonl").exists());
    assert!(!agent_dir.join("running").exists());
    drop(lease);
}
