//! The main scheduler owns all writer stops, fixed workers and the transition back to a usable Core.
use super::import_recovery::{abort_intent, activation, block};
pub use super::import_recovery::{initial, scheduled};
use super::imports::Job;
use super::{imports, Monitors, Role, RoleKind, Shared};
use crate::{
    ext::ExtError,
    paths::{core_address, Layout},
};
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    sync::Arc,
    time::{Duration, Instant},
};

fn failed() -> ExtError {
    ExtError::new(
        "E_INTERNAL",
        "maintenance-recovery-required",
        "import maintenance requires recovery",
    )
}

fn stopping(shared: &Shared) -> bool {
    shared.lock().stopping.is_some()
}

fn check_abort(shared: &Shared, job: &Job) -> Result<(), ExtError> {
    if imports::abort_requested(shared, job) {
        return Err(ExtError::new(
            "E_IMPORT_FAILED",
            "import-aborted",
            "import was aborted before activation",
        ));
    }
    Ok(())
}

fn stop_writers(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    monitors: &mut Monitors,
) -> Result<BTreeSet<String>, ExtError> {
    let roles: Vec<Role> = shared
        .lock()
        .slots
        .iter()
        .filter(|slot| slot.role.kind != RoleKind::Api)
        .map(|slot| slot.role.clone())
        .collect();
    // Also adopt surviving children after a killed supervisor, without spawning any writer.
    for role in &roles {
        if !monitors.contains_key(&role.name) {
            super::probe_and_adopt(shared, layout, token, role, monitors);
        }
    }
    let running: BTreeSet<String> = roles
        .iter()
        .filter(|role| {
            role.kind == RoleKind::Module
                && monitors
                    .get(&role.name)
                    .is_some_and(super::child::Monitor::is_running)
        })
        .map(|role| role.name.clone())
        .collect();
    let mut end = Instant::now() + Duration::from_secs(30);
    if let Some(stop) = shared.lock().stopping {
        end = end.min(stop.requested_at + stop.budget);
    }
    for role in roles.iter().rev() {
        if let Some(monitor) = monitors.get_mut(&role.name) {
            monitor.stop_until(
                end.saturating_duration_since(Instant::now())
                    .min(super::DEFAULT_STOP_BUDGET),
                end,
            );
            if monitor.is_running() {
                return Err(failed());
            }
        }
    }
    Ok(running)
}

fn connect_core(shared: &Shared, layout: &Layout) -> Result<Client, ExtError> {
    let pid = shared
        .lock()
        .slot("core")
        .and_then(|slot| slot.child.as_ref())
        .and_then(|child| child.pid)
        .ok_or_else(failed)?;
    let token = layout
        .read_token_file(&layout.core_token())
        .map_err(|_| failed())?;
    Client::connect(
        &core_address(
            &layout.home,
            if cfg!(windows) { "windows" } else { "posix" },
        ),
        token.trim(),
        ConnectOptions {
            endpoint: Endpoint::Core,
            expected_server_pid: Some(pid),
            connect_timeout: Duration::from_secs(2),
            call_timeout: Duration::from_secs(2),
        },
    )
    .map_err(|_| failed())
}

fn wait_core(
    shared: &Shared,
    layout: &Layout,
    monitors: &Monitors,
    job: &Job,
    deadline: Instant,
) -> Result<Client, ExtError> {
    check_abort(shared, job)?;
    let ready_end = deadline.min(Instant::now() + Duration::from_secs(70));
    while Instant::now() < ready_end && !stopping(shared) {
        check_abort(shared, job)?;
        if !monitors
            .get("core")
            .is_some_and(super::child::Monitor::is_running)
        {
            return Err(failed());
        }
        let ready = shared
            .lock()
            .slot("core")
            .and_then(|slot| slot.child.as_ref())
            .is_some_and(|child| matches!(child.health, super::state::Health::Ready));
        if ready {
            if let Ok(mut core) = connect_core(shared, layout) {
                if core.call("core.status", json!({})).is_ok() {
                    return Ok(core);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(failed())
}

fn control(job: &Job) -> Value {
    json!({"runId":job.run_id,"planId":job.plan_id,"planSha256":job.plan_sha256})
}

fn complete_runtime(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    monitors: &mut Monitors,
    job: &Job,
    deadline: Instant,
) -> Result<Client, ExtError> {
    let mut core = wait_core(shared, layout, monitors, job, deadline)?;
    let mut method = "admin.import.runtime.complete";
    let mut restarts = 0;
    let mut last_progress = Value::Null;
    while Instant::now() < deadline && !stopping(shared) {
        check_abort(shared, job)?;
        let status = core.call(method, control(job)).map_err(|_| failed())?;
        if status["runId"] != job.run_id {
            return Err(failed());
        }
        match status["state"].as_str() {
            Some("completed") if status["restartRequired"] == true && restarts < 2 => {
                monitors
                    .get_mut("core")
                    .ok_or_else(failed)?
                    .stop_restarting(super::DEFAULT_STOP_BUDGET);
                if monitors
                    .get("core")
                    .is_some_and(super::child::Monitor::is_running)
                {
                    return Err(failed());
                }
                super::restart_child(shared, layout, token, &Role::core(), monitors);
                core = wait_core(shared, layout, monitors, job, deadline)?;
                restarts += 1;
                method = "admin.import.runtime.complete";
            }
            Some("completed") if status["restartRequired"] == false => return Ok(core),
            Some("pending") => {
                let mut event = json!({"v":1,"type":"progress","runId":job.run_id,
                    "phase":"verify","entity":"memory","completed":status["completed"]});
                if let Some(total) = status.get("total") {
                    event["total"] = total.clone();
                }
                if event != last_progress {
                    imports::progress(shared, layout, job, &event)?;
                    last_progress = event;
                }
                method = "admin.import.runtime.status";
                std::thread::sleep(Duration::from_millis(100));
            }
            _ => return Err(failed()),
        }
    }
    Err(failed())
}

fn restored_worker(
    shared: &Arc<Shared>,
    layout: &Layout,
    job: &mut Job,
) -> Result<Value, ExtError> {
    let deadline = Instant::now() + Duration::from_secs(10 * 60);
    job.mode = "recover".into();
    job.automatic_rollback = false;
    imports::stage(shared, layout, job, "rolling-back")?;
    let mut result = super::import_worker::run_bounded(shared, layout, job, None, deadline)?;
    if result["restored"] != true {
        job.mode = "rollback".into();
        job.automatic_rollback = true;
        imports::stage(shared, layout, job, "rolling-back")?;
        result = super::import_worker::run_bounded(shared, layout, job, None, deadline)?;
    }
    if result["restored"] != true {
        return Err(failed());
    }
    let mut host = super::import_controls::Host {
        shared,
        layout,
        job,
        deadline: Some(deadline),
    };
    super::import_extensions::rollback_run(layout, &mut host, &job.run_id)?;
    Ok(result)
}

fn start_held(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    monitors: &mut Monitors,
    job: &Job,
    deadline: Instant,
) -> Result<Client, ExtError> {
    imports::stage(shared, layout, job, "restarting-core")?;
    super::restart_child(shared, layout, token, &Role::core(), monitors);
    complete_runtime(shared, layout, token, monitors, job, deadline)
}

struct ActivationReady<'a> {
    result: &'a Value,
    core: Option<Client>,
}

fn activate(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    monitors: &mut Monitors,
    job: &mut Job,
    ready: ActivationReady<'_>,
    deadline: Instant,
) -> Result<(), ExtError> {
    let ActivationReady { result, mut core } = ready;
    if stopping(shared) {
        return Err(failed());
    }
    // Durable commit point: after routing is released, newly accepted user writes must never be rolled back.
    if !imports::begin_activation(shared, layout, job, result)? {
        check_abort(shared, job)?;
        return Err(failed());
    }
    if stopping(shared) {
        return Err(failed());
    }
    let released = core.as_mut().is_some_and(|core| {
        core.call("admin.import.runtime.release", control(job))
            .is_ok()
    });
    if !released {
        stop_writers(shared, layout, token, monitors)?;
        job.mode = "activate".into();
        imports::stage(shared, layout, job, "restarting-core")?;
        super::restart_child(shared, layout, token, &Role::core(), monitors);
        wait_core(shared, layout, monitors, job, deadline)?;
    }
    imports::finish(shared, layout, job, result)
}

pub fn run(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    monitors: &mut Monitors,
    mut job: Job,
) {
    let deadline = Instant::now() + super::import_worker::APPLY_DEADLINE;
    let outcome = run_inner(shared, layout, token, monitors, &mut job, deadline);
    if outcome.is_err() {
        let _ = stop_writers(shared, layout, token, monitors);
        block(shared);
    }
}

fn run_inner(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    monitors: &mut Monitors,
    job: &mut Job,
    deadline: Instant,
) -> Result<(), ExtError> {
    let original_apply = job.mode == "apply";
    let secrets = if original_apply && job.migrate_secrets {
        match super::import_secrets::acquire(layout, job).and_then(|lease| lease.frame(job)) {
            Ok(frame) => Some(frame),
            Err(_) => {
                return imports::finish(
                    shared,
                    layout,
                    job,
                    &json!({"ok":false,"status":"failed",
                    "restored":true,"resumable":false,"error":{"code":"E_DENIED","reason":"source-secrets-unavailable"}}),
                );
            }
        }
    } else {
        None
    };
    imports::stage(shared, layout, job, "stopping-core")?;
    let modules = stop_writers(shared, layout, token, monitors)?;
    if stopping(shared) {
        return Err(failed());
    }
    if job.mode == "activate" {
        let result = activation(layout, job)?.ok_or_else(failed)?;
        activate(
            shared,
            layout,
            token,
            monitors,
            job,
            ActivationReady {
                result: &result,
                core: None,
            },
            deadline,
        )?;
    } else {
        let recovering = job.mode == "recover";
        let worked = if recovering {
            restored_worker(shared, layout, job)
        } else {
            super::import_worker::run_bounded(shared, layout, job, secrets, deadline)
        };
        if stopping(shared) {
            return Err(failed());
        }
        let unchanged = super::import_worker::safe_refusal(layout, job, worked.as_ref().ok());
        match &worked {
            Ok(result) if result["ok"] != true => shared.log.warn(
                "import worker did not complete",
                json!({"runId": job.run_id, "mode": job.mode, "status": result["status"], "error": result["error"]}),
            ),
            Err(error) => shared.log.warn(
                "import worker failed",
                json!({"runId": job.run_id, "mode": job.mode, "error": error.code, "reason": error.reason}),
            ),
            _ => {}
        }
        let mut result = match worked {
            Ok(result) if result["ok"] == true || result["restored"] == true => result,
            Ok(result) if unchanged => result,
            _ if unchanged => {
                json!({"ok":false,"status":"failed","restored":false,"resumable":false,
                "error":{"code":"E_IMPORT_FAILED","reason":"target-changed"}})
            }
            _ => {
                let restored = restored_worker(shared, layout, job)?;
                json!({"ok":false,"status":"failed","restored":true,"resumable":restored["resumable"],
                    "error":{"code":"E_IMPORT_FAILED","reason":"worker-failed"}})
            }
        };
        let mut aborted = abort_intent(layout, job)?;
        if recovering && !aborted {
            result["ok"] = json!(false);
            result["status"] = json!("failed");
            result["error"] = json!({"code":"E_IMPORT_FAILED","reason":"recovered"});
        }
        if !imports::begin_restart(shared, layout, job)? {
            aborted = true;
            if !unchanged {
                result = restored_worker(shared, layout, job)?;
            }
            result["status"] = json!("aborted");
            result["ok"] = json!(false);
        }
        if aborted {
            result["status"] = json!("aborted");
            result["ok"] = json!(false);
            result["error"] = json!({"code":"E_IMPORT_FAILED","reason":"aborted"});
        }
        if unchanged {
            // This attempt never mutated the target. An old cold baseline must not replace newer user writes.
            job.mode = "activate".into();
            job.automatic_rollback = false;
            imports::stage(shared, layout, job, "restarting-core")?;
            activate(
                shared,
                layout,
                token,
                monitors,
                job,
                ActivationReady {
                    result: &result,
                    core: None,
                },
                deadline,
            )?;
        } else {
            finish_imported_core(shared, layout, token, monitors, job, &result, deadline)?;
        }
    }
    if !stopping(shared) {
        let reconcile = super::reconcile_stop(shared, layout, monitors, &modules, None);
        super::reconcile_start(shared, layout, token, monitors, reconcile);
    }
    Ok(())
}

fn finish_imported_core(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    monitors: &mut Monitors,
    job: &mut Job,
    result: &Value,
    deadline: Instant,
) -> Result<(), ExtError> {
    if result["restored"] == true {
        job.mode = "recover".into();
        job.automatic_rollback = false;
        imports::stage(shared, layout, job, "restarting-core")?;
    }
    if result["restored"] == true {
        let mut host = super::import_controls::Host {
            shared,
            layout,
            job,
            deadline: Some(deadline),
        };
        super::import_extensions::rollback_run(layout, &mut host, &job.run_id)?;
    }
    let aborted = match start_held(shared, layout, token, monitors, job, deadline) {
        Ok(core) => match activate(
            shared,
            layout,
            token,
            monitors,
            job,
            ActivationReady {
                result,
                core: Some(core),
            },
            deadline,
        ) {
            Ok(()) => return Ok(()),
            Err(error) if error.reason == Some("import-aborted") => true,
            Err(error) => {
                shared.log.warn(
                    "imported core activation failed",
                    json!({"runId": job.run_id, "error": error.code, "reason": error.reason}),
                );
                return Err(error);
            }
        },
        Err(error) => {
            shared.log.warn(
                "imported core did not start",
                json!({"runId": job.run_id, "error": error.code, "reason": error.reason}),
            );
            imports::abort_requested(shared, job)
        }
    };
    stop_writers(shared, layout, token, monitors)?;
    if stopping(shared) {
        return Err(failed());
    }
    let restored = restored_worker(shared, layout, job)?;
    // Abort admission closes when restoration stages its recover job; include an intent accepted during child stop.
    let aborted = aborted || abort_intent(layout, job)?;
    let failure = json!({"ok":false,"status":if aborted {"aborted"} else {"failed"},"restored":true,"resumable":restored["resumable"],
        "error":{"code":"E_IMPORT_FAILED","reason":if aborted {"aborted"} else {"core-restart-failed"}}});
    let recovery_end = Instant::now() + Duration::from_secs(90);
    let core = start_held(shared, layout, token, monitors, job, recovery_end)?;
    activate(
        shared,
        layout,
        token,
        monitors,
        job,
        ActivationReady {
            result: &failure,
            core: Some(core),
        },
        recovery_end,
    )?;
    Ok(())
}

#[cfg(test)]
#[path = "import_abort_tests.rs"]
mod tests;
