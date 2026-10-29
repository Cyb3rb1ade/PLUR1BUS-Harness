//! A held Core remains cancellable until the durable activation boundary; undo never accepts a GUI abort.
use super::*;
use crate::supervisor::{config, import_records as records, imports::RunRecord, Log};
use std::sync::Mutex;

fn fixture() -> (tempfile::TempDir, Layout, Arc<Shared>, Job) {
    let temp = tempfile::tempdir().unwrap();
    let layout = Layout::new(temp.path().to_path_buf());
    let shared = Arc::new(Shared {
        state: Mutex::new(crate::supervisor::test_state()),
        maintenance: Default::default(),
        wake: Default::default(),
        config: Mutex::new(config::initial(&layout)),
        log: Log::none(),
        subscribers: Default::default(),
        out_logs: Default::default(),
    });
    let catalog: std::collections::BTreeMap<String, Value> = serde_json::from_str(include_str!(
        "../../../../packages/core/src/import/source-catalog.json"
    ))
    .unwrap();
    let job = Job {
        invocation_id: uuid::Uuid::new_v4().to_string(),
        run_id: uuid::Uuid::new_v4().to_string(),
        plan_id: uuid::Uuid::new_v4().to_string(),
        plan_sha256: "a".repeat(64),
        owner_id: "local-owner".into(),
        role: "owner".into(),
        source_type: catalog.into_keys().next().unwrap(),
        mode: "apply".into(),
        attempt: 1,
        preflight_id: None,
        target_sha256: None,
        migrate_secrets: false,
        automatic_rollback: false,
    };
    records::directory(&layout, &["imports", &job.run_id]).unwrap();
    let mut state = super::super::relock(&shared.maintenance);
    state.active = Some(job.clone());
    state.runs.insert(job.run_id.clone(), RunRecord { version: 1, job: job.clone(),
        run: json!({"runId":job.run_id,"planId":job.plan_id,"sourceType":job.source_type,
            "state":"restarting-core","attempt":1,"createdAt":"2026-10-29T00:00:00.000Z",
            "updatedAt":"2026-10-29T00:00:00.000Z","restored":false,"resumable":false,"rollbackAvailable":false}) });
    drop(state);
    (temp, layout, shared, job)
}

fn abort(shared: &Arc<Shared>, layout: &Layout, job: &Job) -> Value {
    imports::read_method(
        shared,
        layout,
        "admin.import.abort",
        &json!({"runId":job.run_id}),
        None,
    )
    .unwrap()
}

#[test]
fn held_reembedding_accepts_and_persists_a_gui_abort() {
    let (_temp, layout, shared, job) = fixture();
    assert_eq!(abort(&shared, &layout, &job)["accepted"], true);
    assert!(abort_intent(&layout, &job).unwrap());
    assert!(super::super::relock(&shared.maintenance).abort_requested);
}

#[test]
fn an_accepted_abort_cannot_publish_activation_or_release_the_held_core() {
    let (_temp, layout, shared, mut job) = fixture();
    super::super::relock(&shared.maintenance).abort_requested = true;
    let result = activate(
        &shared,
        &layout,
        "token",
        &mut Monitors::new(),
        &mut job,
        ActivationReady {
            result: &json!({"ok":true,"status":"completed","restored":false,"resumable":false}),
            core: None,
        },
        Instant::now(),
    );
    assert_eq!(result.unwrap_err().reason, Some("import-aborted"));
    assert!(activation(&layout, &job).unwrap().is_none());
}

#[test]
fn waiting_for_a_held_core_observes_abort_before_its_readiness_budget() {
    let (_temp, layout, shared, job) = fixture();
    super::super::relock(&shared.maintenance).abort_requested = true;
    let began = Instant::now();
    let result = complete_runtime(
        &shared,
        &layout,
        "token",
        &mut Monitors::new(),
        &job,
        began + Duration::from_secs(30),
    );
    assert_eq!(result.err().unwrap().reason, Some("import-aborted"));
    assert!(began.elapsed() < Duration::from_secs(1));
}

#[test]
fn activation_wins_before_routing_release_and_a_later_abort_cannot_undo_user_writes() {
    let (_temp, layout, shared, job) = fixture();
    let outcome = json!({"ok":true,"status":"completed","restored":false,"resumable":false});
    assert!(imports::begin_activation(&shared, &layout, &job, &outcome).unwrap());
    let user_data = layout.home.join("new-user-write");
    std::fs::write(&user_data, b"accepted after release").unwrap();
    assert_eq!(abort(&shared, &layout, &job)["accepted"], false);
    assert!(!abort_intent(&layout, &job).unwrap());
    assert_eq!(activation(&layout, &job).unwrap(), Some(outcome));
    assert_eq!(std::fs::read(user_data).unwrap(), b"accepted after release");
}

#[test]
fn an_accepted_abort_does_not_interrupt_its_recovery_or_the_aborted_terminal_result() {
    let (_temp, layout, shared, mut job) = fixture();
    assert_eq!(abort(&shared, &layout, &job)["accepted"], true);
    let outcome = json!({"ok":true,"status":"completed","restored":false,"resumable":false});
    assert!(!imports::begin_activation(&shared, &layout, &job, &outcome).unwrap());
    assert!(activation(&layout, &job).unwrap().is_none());
    job.mode = "recover".into();
    imports::stage(&shared, &layout, &job, "restarting-core").unwrap();
    assert_eq!(abort(&shared, &layout, &job)["accepted"], false);
    assert!(!imports::abort_requested(&shared, &job));
    check_abort(&shared, &job).unwrap();
    let restored = json!({"ok":false,"status":"aborted","restored":true,"resumable":true,
        "error":{"code":"E_IMPORT_FAILED","reason":"aborted"}});
    assert!(imports::begin_activation(&shared, &layout, &job, &restored).unwrap());
    imports::finish(&shared, &layout, &job, &restored).unwrap();
    let state = super::super::relock(&shared.maintenance);
    assert_eq!(state.runs[&job.run_id].run["state"], "aborted");
    assert_eq!(state.runs[&job.run_id].run["restored"], true);
    assert!(!state.activating && !state.abort_requested && state.active.is_none());
}

#[test]
fn abort_and_activation_are_exclusive_under_the_real_admission_mutex() {
    for _ in 0..24 {
        let (_temp, layout, shared, job) = fixture();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let cancelling = {
            let (shared, layout, job, barrier) =
                (shared.clone(), layout.clone(), job.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                abort(&shared, &layout, &job)["accepted"] == true
            })
        };
        let activating = {
            let (shared, layout, job, barrier) =
                (shared.clone(), layout.clone(), job.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                imports::begin_activation(
                    &shared,
                    &layout,
                    &job,
                    &json!({"ok":true,"status":"completed","restored":false,"resumable":false}),
                )
                .unwrap()
            })
        };
        barrier.wait();
        let accepted = cancelling.join().unwrap();
        let published = activating.join().unwrap();
        assert_ne!(
            accepted, published,
            "an acknowledged abort and activation can never both win"
        );
        assert_eq!(abort_intent(&layout, &job).unwrap(), accepted);
        assert_eq!(activation(&layout, &job).unwrap().is_some(), published);
    }
}

#[test]
fn a_real_held_child_is_cancelled_and_reaped_before_restoration_can_write() {
    struct Held(Monitors);
    impl Drop for Held {
        fn drop(&mut self) {
            for monitor in self.0.values_mut() {
                monitor.stop(Duration::from_secs(1));
            }
        }
    }
    let (_temp, layout, shared, job) = fixture();
    records::directory(&layout, &["logs"]).unwrap();
    records::directory(&layout, &["run"]).unwrap();
    let pending = layout.home.join("held-core-pending");
    let node = crate::supervisor::spawn_secrets::executable(std::path::Path::new("node"))
        .expect("the pinned Node prerequisite must be installed");
    let monitor = super::super::child::Monitor::start(shared.clone(), &layout, Role::core(),
        super::super::child::ChildSpec { role: "core".into(), program: node,
            args: vec!["-e".into(), "const f=require('fs');setTimeout(()=>f.writeFileSync(process.argv[1],'pending'),100);setInterval(()=>{},1000);process.stdin.resume();process.stdin.on('end',()=>process.exit(0));".into(), pending.clone().into()],
            env: Vec::new(), cwd: None });
    let pid = shared
        .lock()
        .slot("core")
        .unwrap()
        .child
        .as_ref()
        .unwrap()
        .pid
        .unwrap();
    let mut held = Held(Monitors::from([("core".into(), monitor)]));
    let cancelling = {
        let (shared, layout, job) = (shared.clone(), layout.clone(), job.clone());
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !pending.exists() {
                assert!(
                    Instant::now() < deadline,
                    "the real held child must enter its pending phase"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            let result = abort(&shared, &layout, &job);
            (result, Instant::now())
        })
    };
    let result = complete_runtime(
        &shared,
        &layout,
        "token",
        &mut held.0,
        &job,
        Instant::now() + Duration::from_secs(30),
    );
    let reacted = Instant::now();
    let (admitted, at) = cancelling.join().unwrap();
    let stop = stop_writers(&shared, &layout, "token", &mut held.0);
    assert_eq!(admitted["accepted"], true);
    assert_eq!(result.err().unwrap().reason, Some("import-aborted"));
    assert!(
        reacted.saturating_duration_since(at) < Duration::from_secs(1),
        "readiness polling must not consume its 70-second budget"
    );
    stop.unwrap();
    assert!(!held.0["core"].is_running());
    assert!(
        !crate::proc::pid_alive(pid),
        "restoration can start only after the writer is reaped"
    );
}
