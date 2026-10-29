//! Metadata-only cancellation reaches native extension work without canceling an undo for a GUI abort.
use super::*;
use crate::supervisor::{import_records as records, Log, StopRequest, StopSource};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

fn shared(layout: &Layout) -> Arc<Shared> {
    records::directory(layout, &["logs"]).unwrap();
    Arc::new(Shared {
        maintenance: Default::default(),
        state: Mutex::new(crate::supervisor::test_state()),
        wake: Condvar::new(),
        log: Log::open(&layout.logs().join("supervisor.log"), 1 << 20, 3),
        config: Mutex::new(config::initial(layout)),
        subscribers: Default::default(),
        out_logs: Mutex::new(Vec::new()),
    })
}

fn job() -> Job {
    Job {
        invocation_id: uuid::Uuid::new_v4().to_string(),
        run_id: uuid::Uuid::new_v4().to_string(),
        plan_id: uuid::Uuid::new_v4().to_string(),
        plan_sha256: "a".repeat(64),
        owner_id: "owner".into(),
        role: "owner".into(),
        source_type: "fixture".into(),
        mode: "apply".into(),
        attempt: 1,
        preflight_id: None,
        target_sha256: None,
        migrate_secrets: false,
        automatic_rollback: false,
    }
}

#[test]
fn abort_cancels_only_the_current_apply_attempt_and_never_a_restoration() {
    let home = tempfile::tempdir().unwrap();
    let layout = Layout::new(home.path().into());
    let shared = shared(&layout);
    let mut job = job();
    {
        let mut state = relock(&shared.maintenance);
        state.active = Some(job.clone());
        state.abort_requested = true;
    }
    let cancelled = |job: &Job| {
        Host {
            shared: &shared,
            layout: &layout,
            job,
            deadline: None,
        }
        .check_cancelled()
    };
    assert!(cancelled(&job).is_err());
    job.attempt = 2;
    assert!(cancelled(&job).is_ok());
    job.attempt = 1;
    let invocation = job.invocation_id.clone();
    job.invocation_id = uuid::Uuid::new_v4().to_string();
    assert!(cancelled(&job).is_ok());
    job.invocation_id = invocation;
    job.automatic_rollback = true;
    assert!(cancelled(&job).is_ok());
    job.automatic_rollback = false;
    for mode in ["rollback", "recover"] {
        job.mode = mode.into();
        assert!(cancelled(&job).is_ok());
    }
}

#[test]
fn a_daemon_stop_or_total_deadline_still_bounds_native_work_while_undoing() {
    let home = tempfile::tempdir().unwrap();
    let layout = Layout::new(home.path().into());
    let shared = shared(&layout);
    let mut job = job();
    job.mode = "rollback".into();
    job.automatic_rollback = true;
    let host = Host {
        shared: &shared,
        layout: &layout,
        job: &job,
        deadline: Some(Instant::now() - Duration::from_millis(1)),
    };
    assert!(host.check_cancelled().is_err());
    let host = Host {
        deadline: None,
        ..host
    };
    assert!(host.check_cancelled().is_ok());
    shared.lock().stopping = Some(StopRequest {
        requested_at: Instant::now() - Duration::from_millis(10),
        budget: Duration::ZERO,
        source: StopSource::Rpc,
    });
    assert!(host.check_cancelled().is_err());
}

#[test]
fn source_model_preparation_removes_only_the_explicit_generation_selection() {
    let home = tempfile::tempdir().unwrap();
    let layout = Layout::new(home.path().into());
    let mut baseline = serde_json::to_value(plur1bus_config::defaults()).unwrap();
    baseline["engine"] = json!({"reembedding":{"activeGeneration":"previous",
        "fingerprintId":"previous-fingerprint","dimensions":384}});
    records::write(&layout, &layout.config_path(), &baseline).unwrap();
    let shared = shared(&layout);
    let job = job();
    let mut host = Host {
        shared: &shared,
        layout: &layout,
        job: &job,
        deadline: None,
    };
    host.request(
        "config.set",
        &json!({"changes":[{"key":"engine.reembedding","value":null}],"dryRun":false}),
    )
    .unwrap();
    let current = relock(&shared.config).running.clone().unwrap();
    assert!(current["engine"].as_object().unwrap().get("reembedding").is_none(),
        "a null generation selection is not a valid Engine configuration; the private control must remove it");
    let before = std::fs::read(layout.config_path()).unwrap();
    assert!(
        host.request(
            "config.set",
            &json!({"changes":[
        {"key":"engine.reembedding","value":null},{"key":"agents.main.provider","value":null}],
        "dryRun":false})
        )
        .is_err(),
        "unrelated null values must never acquire deletion semantics"
    );
    assert_eq!(std::fs::read(layout.config_path()).unwrap(), before);
}
