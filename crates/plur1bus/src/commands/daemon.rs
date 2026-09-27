//! `plur1bus daemon start|stop|restart|status` (spec §6.4/§6.6): the CLI's control surface over the supervisor,
//! and [`supervisor_detail`], the supervisor's view that names *why* the core is unreachable in every
//! `E_CORE_UNAVAILABLE`/`degraded` document (`memory add|recall`, the memory-ops surface, `dreams`).
use crate::cli::DaemonCmd;
use crate::output::Out;
use crate::paths::{supervisor_address, Layout};
use crate::service::{self, Manager, Runner, ServiceError};
use crate::supervisor;
use crate::supervisor::Role;
use plur1bus_rpc::{ConnectOptions, Endpoint, RpcError};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn platform_str() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "posix"
    }
}

/// Bounds a single probe of the supervisor: [`supervisor_detail`]'s "100 ms timeout and a 150 ms call deadline"
/// (the brief); reused for `daemon status`'s own probe, which has the same "answer within a second" requirement.
const PROBE_CONNECT_TIMEOUT: Duration = Duration::from_millis(100);
const PROBE_CALL_TIMEOUT: Duration = Duration::from_millis(150);

/// How long `daemon start` waits for the supervisor's endpoint to answer (the brief: "wait ≤ 10 s for
/// `supervisor.auth`").
const ENDPOINT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long `daemon start` then waits for the core child to become ready, unless `--no-wait`.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// How much longer `daemon stop` waits, on top of the stop budget, for `run/supervisor.pid` to disappear.
const STOP_GRACE: Duration = Duration::from_secs(10);
/// The default `daemon.stop { budgetMs }` when `--budget-ms` is not given (matches the supervisor's own default).
const DEFAULT_STOP_BUDGET_MS: u64 = supervisor::DEFAULT_STOP_BUDGET.as_secs() * 1000;

const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// What a bounded probe of the supervisor's endpoint found.
enum Probe {
    /// No supervisor answers at all: no token file, or the address refuses/has nothing behind it.
    NotRunning,
    /// Something is listening but did not complete the handshake or answer `daemon.status` in time.
    Unresponsive,
    /// `daemon.status`'s result.
    Answered(Value),
}

/// Connects to the supervisor with a bounded budget and calls `daemon.status`; never blocks longer than
/// `connect_timeout + call_timeout` (plus scheduling slack).
fn probe(layout: &Layout, connect_timeout: Duration, call_timeout: Duration) -> Probe {
    let Some(token) = supervisor::read_token(layout) else {
        return Probe::NotRunning;
    };
    let address = supervisor_address(&layout.home, platform_str());
    let opts = ConnectOptions {
        connect_timeout,
        call_timeout,
        endpoint: Endpoint::Supervisor,
        expected_server_pid: None, // set by connect_recorded
    };
    let mut client = match super::connect_recorded(layout, &address, &token, opts) {
        Ok(c) => c,
        Err(RpcError::Unavailable { reason, .. }) if reason == "core-unavailable" => {
            return Probe::NotRunning
        }
        Err(_) => return Probe::Unresponsive,
    };
    match client.call("daemon.status", json!({})) {
        Ok(v) => Probe::Answered(v),
        Err(_) => Probe::Unresponsive,
    }
}

/// A short, bounded probe (used by `daemon status` and [`supervisor_detail`]): `Some` only when the supervisor
/// actually answered.
fn probe_status(layout: &Layout) -> Option<Value> {
    match probe(layout, PROBE_CONNECT_TIMEOUT, PROBE_CALL_TIMEOUT) {
        Probe::Answered(v) => Some(v),
        Probe::NotRunning | Probe::Unresponsive => None,
    }
}

/// The core child of a `daemon.status` result, if any: the first child that is not a module (`kind: "module"`,
/// 1.3.0). A supervisor before 1.3.0 reports no `kind` and only the core.
pub(crate) fn core_child(status: &Value) -> Option<&Value> {
    status["children"]
        .as_array()?
        .iter()
        .find(|c| c["kind"] != "module")
}

/// The core child's `process.state` in a `daemon.status` result, if there is one.
fn core_state(status: &Value) -> Option<&str> {
    core_child(status)?["process"]["state"].as_str()
}

/// The core's own `engine.sharedMemory` (E4), read directly from it: the supervisor's `daemon.status` result
/// (`$defs/ChildStatus`) does not carry engine detail, so `daemon status` probes the core itself, with the same
/// bounded budget as the supervisor probe. `None` when the core is unreachable or does not report it yet.
fn core_shared_memory(layout: &Layout) -> Option<Value> {
    let token = super::read_token_of(layout, Endpoint::Core)?;
    let address = layout.endpoints(&Role::core(), platform_str()).address;
    let opts = ConnectOptions {
        connect_timeout: PROBE_CONNECT_TIMEOUT,
        call_timeout: PROBE_CALL_TIMEOUT,
        endpoint: Endpoint::Core,
        expected_server_pid: None, // set by connect_recorded
    };
    let mut client = super::connect_recorded(layout, &address, &token, opts).ok()?;
    let status = client.call("core.status", json!({})).ok()?;
    let shared = status["engine"]["sharedMemory"].clone();
    if shared.is_null() {
        None
    } else {
        Some(shared)
    }
}

/// The `daemon status` human line for shared memory: the mode when supported, else `unavailable (<reason>)`.
fn describe_shared_memory(shared: &Value) -> String {
    if shared["supported"].as_bool().unwrap_or(false) {
        shared["mode"].as_str().unwrap_or("unknown").to_string()
    } else {
        format!(
            "unavailable ({})",
            shared["reason"].as_str().unwrap_or("unknown")
        )
    }
}

/// The supervisor's view of why the core is unreachable, for every `E_CORE_UNAVAILABLE`/`degraded` document
/// (`memory add|recall`, the memory-ops surface, `dreams`). Connects with a 100 ms timeout and a 150 ms call
/// deadline, so a degraded answer stays well under the 1 s the callers are held to.
pub(crate) fn supervisor_detail(layout: &Layout) -> String {
    match probe(layout, PROBE_CONNECT_TIMEOUT, PROBE_CALL_TIMEOUT) {
        Probe::NotRunning => "supervisor not running".to_string(),
        Probe::Unresponsive => "supervisor unresponsive".to_string(),
        Probe::Answered(status) => describe_core(&status),
    }
}

/// `core <state>[: reason][; restart in N ms]` for the core child of a `daemon.status` result (ruling H3-R25): the
/// wording of every core-unavailable document and, without the `core ` prefix, of `daemon status`'s `core:` line.
fn describe_core(status: &Value) -> String {
    let Some(child) = core_child(status) else {
        return "core starting".to_string();
    };
    format!("core {}", describe_child_state(child))
}

/// `<state>[: reason][; restart in N ms]` for one `daemon.status` child.
fn describe_child_state(child: &Value) -> String {
    let state = child["process"]["state"].as_str().unwrap_or("starting");
    let mut text = state.to_string();
    if let Some(reason) = child["process"]["reason"].as_str() {
        text.push_str(&format!(": {reason}"));
    } else if state == "crashed" {
        text.push_str(": none");
    }
    if state == "crashed" {
        if let Some(next_at) = child["nextRestartAt"].as_u64() {
            let remaining = next_at.saturating_sub(supervisor::now_ms());
            text.push_str(&format!("; restart in {remaining} ms"));
        }
    }
    text
}

/// Starts `<bin> --home <home> supervise` detached from this process: on unix in its own session
/// (`setsid`, so the terminal's Ctrl-C and hang-up never reach it), on Windows with no console and its own
/// process group. Inherits this process's environment (the test seams included).
fn spawn_supervise(bin: &Path, layout: &Layout) -> std::io::Result<std::process::Child> {
    let mut cmd = Command::new(bin);
    cmd.arg("--home")
        .arg(&layout.home)
        .arg("supervise")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid() is async-signal-safe and touches only the child's own new process.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
        // The detached supervisor outlives this CLI: it must not inherit the CLI's stdout/stderr (a pipe to the
        // caller), or the caller waits for EOF for as long as the supervisor runs.
        crate::supervisor::keep_std_handles_private();
    }
    cmd.spawn()
}

/// Starts the supervisor through its registered OS service (`systemctl --user start`, `launchctl kickstart`
/// (falling back to `bootstrap`, see [`start_launchd`]), `schtasks /Run`).
fn start_via_manager(
    r: &dyn Runner,
    manager: Manager,
    name: &str,
    path: &Path,
) -> Result<(), ServiceError> {
    match manager {
        Manager::Systemd => service::exec_ok(
            r,
            "systemctl",
            &service::os_args(&["--user", "start", &format!("{name}.service")]),
        ),
        Manager::Launchd => start_launchd(r, name, path),
        Manager::TaskScheduler => {
            service::exec_ok(r, "schtasks", &service::os_args(&["/Run", "/TN", name]))
        }
    }
}

/// `launchctl kickstart gui/<uid>/<label>` starts an *already-loaded* agent. `service install --no-start` writes
/// the plist (so `service status` reports it `registered`) but never loads it into launchd — real launchd only
/// picks it up at the next login — so `kickstart` on such a service fails with ESRCH (3, "not loaded"), not
/// success. Falling back to `bootstrap`ing the plist directly in that case loads *and* starts it at once
/// (`RunAtLoad`), matching what `service install` (without `--no-start`) itself does.
fn start_launchd(r: &dyn Runner, name: &str, path: &Path) -> Result<(), ServiceError> {
    let domain = service::launchd::gui_domain();
    match service::exec_ok(
        r,
        "launchctl",
        &service::os_args(&["kickstart", &format!("{domain}/{name}")]),
    ) {
        Err(ServiceError::Command { code: Some(3), .. }) => {
            let args = vec![
                OsString::from("bootstrap"),
                OsString::from(&domain),
                path.as_os_str().to_os_string(),
            ];
            service::exec_ok(r, "launchctl", &args)
        }
        other => other,
    }
}

fn fail_service(out: &Out, e: &ServiceError) -> ! {
    out.fail(
        "E_INTERNAL",
        &e.to_string(),
        json!({ "reason": "service-manager" }),
        1,
    )
}

/// The core child's `process` (`{ state: "crashed", reason, since }`) when it crashed in a way the supervisor will
/// not retry on its own: `nextRestartAt: null` (`config-invalid`, `engine-contract`, or a give-up).
fn fatal_crash(status: &Value) -> Option<&Value> {
    let child = core_child(status)?;
    let process = &child["process"];
    (process["state"] == "crashed" && child["nextRestartAt"].is_null()).then_some(process)
}

/// Polls `daemon.status` until the core child is `ready` or `deadline` passes; `E_CORE_UNAVAILABLE
/// reason=not-ready` on timeout, with the last known status in the document (the brief). A crash the supervisor will
/// not retry fails at once with `reason=core-crashed` and the crash reason (final review M3) instead of waiting out
/// the timeout — except the crash `reset` names (its `process`, `since` included): the one `daemon.start` has just
/// reset, which the supervisor still reports until its scheduler has respawned the core.
fn wait_for_ready(
    out: &Out,
    layout: &Layout,
    timeout: Duration,
    mut last: Value,
    reset: Option<Value>,
) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        if core_state(&last) == Some("ready") {
            return last;
        }
        if let Some(process) = fatal_crash(&last).filter(|p| Some(*p) != reset.as_ref()) {
            let reason = process["reason"].as_str().unwrap_or("none").to_string();
            out.fail(
                "E_CORE_UNAVAILABLE",
                &format!("the core crashed: {reason}"),
                json!({ "reason": "core-crashed", "detail": reason, "status": last }),
                1,
            );
        }
        if Instant::now() >= deadline {
            out.fail(
                "E_CORE_UNAVAILABLE",
                "the core did not become ready in time",
                json!({ "reason": "not-ready", "status": last }),
                1,
            );
        }
        std::thread::sleep(POLL_INTERVAL);
        if let Some(s) = probe_status(layout) {
            last = s;
        }
    }
}

/// `daemon start` (the brief, ruling H3-R4): a supervisor that already answers gets `daemon.start` (a no-op
/// reset unless the core is crashed) and is reported `via: "running"`; otherwise a registered service is
/// started through its manager (`via: "service"`), or a fresh supervisor is spawned detached (`via: "spawn"`).
/// A spawn that loses the single-instance race waits for the winner's endpoint instead and answers
/// `started: false, via: "running"`.
fn do_start(out: &Out, layout: &Layout, no_wait: bool) -> (bool, &'static str, Value) {
    if let Probe::Answered(status) = probe(layout, PROBE_CONNECT_TIMEOUT, PROBE_CALL_TIMEOUT) {
        let already_ready = core_state(&status) == Some("ready");
        // A fatal crash reported before the reset below is the one being reset, not a new one.
        let reset = fatal_crash(&status).cloned();
        if !already_ready {
            // Resets a crashed core's backoff and asks for an immediate spawn; a no-op while the core is
            // already up (Monitor::spawn is idempotent), so this is safe to call unconditionally here too.
            let _ = call_daemon_start(layout);
        }
        let status = if already_ready || no_wait {
            status
        } else {
            wait_for_ready(out, layout, READY_TIMEOUT, status, reset)
        };
        return (!already_ready, "running", status);
    }

    let runner = super::service::runner(out);
    let svc = service::status(runner.as_ref(), layout);
    let mut via = "spawn";
    let mut spawned: Option<std::process::Child> = None;
    if svc.registered {
        via = "service";
        if let Err(e) = start_via_manager(runner.as_ref(), svc.manager, &svc.name, &svc.path) {
            fail_service(out, &e);
        }
    } else {
        let bin = std::env::current_exe().unwrap_or_else(|e| {
            out.fail(
                "E_INTERNAL",
                &format!("cannot locate the plur1bus binary: {e}"),
                json!({}),
                1,
            )
        });
        spawned = Some(spawn_supervise(&bin, layout).unwrap_or_else(|e| {
            out.fail(
                "E_INTERNAL",
                &format!("cannot spawn the supervisor: {e}"),
                json!({}),
                1,
            )
        }));
    }

    let deadline = Instant::now() + ENDPOINT_TIMEOUT;
    let mut lost_race = false;
    let status = loop {
        if let Probe::Answered(s) = probe(layout, PROBE_CONNECT_TIMEOUT, PROBE_CALL_TIMEOUT) {
            // H3-R4: the endpoint may be up because *we* won the race, or because a concurrent `daemon
            // start`/service start won it first — the winner's pid in the answer tells us which.
            if let Some(child) = spawned.as_ref() {
                if s["supervisor"]["pid"].as_u64() != Some(child.id() as u64) {
                    lost_race = true;
                    via = "running";
                }
            }
            break Some(s);
        }
        if let Some(child) = spawned.as_mut() {
            if let Ok(Some(exit)) = child.try_wait() {
                match exit.code() {
                    Some(3) => {
                        // Our own spawn lost the single-instance race before the winner's endpoint was even
                        // up yet. Keep waiting for it (below) and report as if we had merely found it
                        // running.
                        lost_race = true;
                        via = "running";
                    }
                    other => {
                        // Any other exit (a usage error, a set-up failure, a panic) means this spawn is not
                        // going to become the supervisor: say so now instead of waiting out the full
                        // endpoint timeout on an already-dead process.
                        let detail = match other {
                            Some(code) => format!("supervise exited with code {code}"),
                            None => "supervise exited via a signal".to_string(),
                        };
                        out.fail(
                            "E_CORE_UNAVAILABLE",
                            &format!("the spawned supervisor did not start: {detail}"),
                            json!({ "reason": "supervisor-exited", "detail": detail }),
                            1,
                        );
                    }
                }
            }
        }
        if Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(POLL_INTERVAL);
    };
    let Some(status) = status else {
        out.fail(
            "E_CORE_UNAVAILABLE",
            "the supervisor did not become reachable in time",
            json!({ "reason": "not-ready" }),
            1,
        );
    };

    let started = !lost_race;
    let status = if no_wait || core_state(&status) == Some("ready") {
        status
    } else {
        wait_for_ready(out, layout, READY_TIMEOUT, status, None)
    };
    (started, via, status)
}

fn call_daemon_start(layout: &Layout) -> Result<Value, ()> {
    let token = supervisor::read_token(layout).ok_or(())?;
    let opts = ConnectOptions {
        connect_timeout: PROBE_CONNECT_TIMEOUT,
        call_timeout: PROBE_CALL_TIMEOUT,
        endpoint: Endpoint::Supervisor,
        expected_server_pid: None, // set by connect_recorded
    };
    let address = supervisor_address(&layout.home, platform_str());
    let mut client = super::connect_recorded(layout, &address, &token, opts).map_err(drop)?;
    client.call("daemon.start", json!({})).map_err(drop)
}

/// `daemon stop`: `daemon.stop`, then waits up to `budget + 10 s` for `run/supervisor.pid` to disappear. With no
/// supervisor answering: `{ stopped: false, wasRunning: false }`, exit 0 (the brief).
fn do_stop(out: &Out, layout: &Layout, budget_ms: Option<u64>) -> (bool, bool) {
    match stop_supervisor(layout, budget_ms) {
        None => (false, false),
        Some(Err(e)) => out.from_rpc_error(&e),
        Some(Ok(stopped)) => (stopped, true),
    }
}

/// Asks the running supervisor to stop (`daemon.stop`) and waits up to `budget + 10 s` for `run/supervisor.pid` to
/// disappear. `None`: no supervisor answered; `Some(Err)`: it refused; `Some(Ok(stopped))`: whether it is gone.
/// Also used by `service uninstall` on Windows, where Task Scheduler's own `/End` can only terminate the process.
pub(crate) fn stop_supervisor(
    layout: &Layout,
    budget_ms: Option<u64>,
) -> Option<Result<bool, RpcError>> {
    let token = supervisor::read_token(layout)?;
    let opts = ConnectOptions {
        connect_timeout: PROBE_CONNECT_TIMEOUT,
        call_timeout: Duration::from_secs(5),
        endpoint: Endpoint::Supervisor,
        expected_server_pid: None, // set by connect_recorded
    };
    let address = supervisor_address(&layout.home, platform_str());
    let mut client = super::connect_recorded(layout, &address, &token, opts).ok()?;
    let params = match budget_ms {
        Some(b) => json!({ "budgetMs": b }),
        None => json!({}),
    };
    if let Err(e) = client.call("daemon.stop", params) {
        return Some(Err(e));
    }
    let budget = Duration::from_millis(budget_ms.unwrap_or(DEFAULT_STOP_BUDGET_MS));
    let deadline = Instant::now() + budget + STOP_GRACE;
    let pid_file = layout.supervisor_pid();
    while pid_file.exists() {
        if Instant::now() >= deadline {
            return Some(Ok(false));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    Some(Ok(true))
}

pub fn run(out: &Out, layout: &Layout, cmd: DaemonCmd) {
    match cmd {
        DaemonCmd::Start { no_wait } => {
            let (started, via, status) = do_start(out, layout, no_wait);
            out.ok(
                "daemon.start/1",
                &json!({ "started": started, "via": via, "status": status }),
                || {
                    format!(
                        "{} (via {via})",
                        if started {
                            "started"
                        } else {
                            "already running"
                        }
                    )
                },
            );
        }
        DaemonCmd::Stop { budget_ms } => {
            let (stopped, was_running) = do_stop(out, layout, budget_ms);
            out.ok(
                "daemon.stop/1",
                &json!({ "stopped": stopped, "wasRunning": was_running }),
                || {
                    if !was_running {
                        "not running".to_string()
                    } else if stopped {
                        "stopped".to_string()
                    } else {
                        "stop requested, still shutting down".to_string()
                    }
                },
            );
        }
        DaemonCmd::Restart => {
            let (stopped, was_running) = do_stop(out, layout, None);
            let (started, via, status) = do_start(out, layout, false);
            out.ok(
                "daemon.restart/1",
                &json!({
                    "stopped": stopped,
                    "wasRunning": was_running,
                    "started": started,
                    "via": via,
                    "status": status,
                }),
                || format!("restarted (via {via})"),
            );
        }
        DaemonCmd::Status => {
            let runner = super::service::runner(out);
            let svc = service::status(runner.as_ref(), layout);
            let (supervisor, children) =
                status_parts(probe(layout, PROBE_CONNECT_TIMEOUT, PROBE_CALL_TIMEOUT));
            let shared_memory = core_shared_memory(layout);
            let mut doc = json!({ "supervisor": supervisor, "children": children, "service": svc });
            if let (Some(obj), Some(s)) = (doc.as_object_mut(), &shared_memory) {
                obj.insert("sharedMemory".to_string(), s.clone());
            }
            out.ok("daemon.status/1", &doc, || {
                let mut lines = vec![
                    format!(
                        "supervisor: {}",
                        supervisor["process"]["state"].as_str().unwrap_or("unknown")
                    ),
                    format!("core (core): {}", core_line(&supervisor, &children)),
                ];
                // One line per child with its kind: the core above, then every module.
                lines.extend(
                    children
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|c| c["kind"] == "module")
                        .map(|c| {
                            format!(
                                "{} ({}): {}",
                                c["role"].as_str().unwrap_or("?"),
                                c["kind"].as_str().unwrap_or("module"),
                                describe_child_state(c)
                            )
                        }),
                );
                lines.extend([format!(
                    "service: {} ({})",
                    if svc.registered {
                        "registered"
                    } else {
                        "not registered"
                    },
                    svc.manager.as_str()
                )]);
                if let Some(s) = &shared_memory {
                    lines.push(format!("shared memory: {}", describe_shared_memory(s)));
                }
                lines.join("\n")
            });
        }
    }
}

/// `daemon status --json` (ruling H3-R25): the supervisor's own entry always sits at `supervisor` (`{ process: {
/// state, … }, instanceId?, pid?, uptimeMs? }`) and the children always at `children`, whether the supervisor
/// answered, is not running or is unresponsive — never the nested `daemon.status` result.
fn status_parts(probe: Probe) -> (Value, Value) {
    match probe {
        Probe::Answered(mut v) => {
            let children = match v["children"].take() {
                Value::Null => json!([]),
                c => c,
            };
            (v["supervisor"].take(), children)
        }
        Probe::NotRunning => (json!({ "process": { "state": "stopped" } }), json!([])),
        Probe::Unresponsive => (
            json!({ "process": { "state": "degraded", "reason": "unresponsive" } }),
            json!([]),
        ),
    }
}

/// The `core:` line of `daemon status`: `<state>[: reason][; restart in …]`, the same wording [`describe_core`]
/// gives every core-unavailable document, minus its `core ` prefix. `unknown` while no supervisor answers.
fn core_line(supervisor: &Value, children: &Value) -> String {
    let answered = supervisor.get("pid").is_some();
    if !answered {
        return "unknown (the supervisor is not answering)".to_string();
    }
    let text = describe_core(&json!({ "children": children }));
    text.strip_prefix("core ").unwrap_or(&text).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_core_is_found_among_module_children_whatever_its_position() {
        let status = json!({ "children": [
            { "role": "fixture", "kind": "module", "process": { "state": "crashed", "reason": "manifest-invalid" } },
            { "role": "core", "kind": "core", "process": { "state": "ready" } },
        ] });
        assert_eq!(core_child(&status).unwrap()["role"], "core");
        assert_eq!(describe_core(&status), "core ready");
        assert_eq!(
            describe_child_state(&status["children"][0]),
            "crashed: manifest-invalid"
        );
        // A supervisor before 1.3.0: no kind, only the core.
        let old = json!({ "children": [{ "role": "core", "process": { "state": "ready" } }] });
        assert_eq!(core_child(&old).unwrap()["role"], "core");
        let only_modules = json!({ "children": [{ "role": "fixture", "kind": "module", "process": { "state": "ready" } }] });
        assert!(core_child(&only_modules).is_none());
    }

    #[test]
    fn describe_core_names_every_state() {
        let child = |extra: Value| {
            let mut v = json!({ "process": { "state": "ready" }, "restarts": 0 });
            merge(&mut v, extra);
            json!({ "children": [v] })
        };
        fn merge(a: &mut Value, b: Value) {
            if let (Some(a), Some(b)) = (a.as_object_mut(), b.as_object()) {
                for (k, v) in b {
                    a.insert(k.clone(), v.clone());
                }
            }
        }
        assert_eq!(describe_core(&json!({ "children": [] })), "core starting");
        assert_eq!(
            describe_core(&child(json!({ "process": { "state": "ready" } }))),
            "core ready"
        );
        assert_eq!(
            describe_core(&child(
                json!({ "process": { "state": "degraded", "reason": "unresponsive" } })
            )),
            "core degraded: unresponsive"
        );
        assert_eq!(
            describe_core(&child(json!({
                "process": { "state": "crashed", "reason": "config-invalid" },
                "nextRestartAt": Value::Null
            }))),
            "core crashed: config-invalid"
        );
        let now = supervisor::now_ms();
        let d = describe_core(&child(json!({
            "process": { "state": "crashed", "reason": "lock-held" },
            "restarts": 2,
            "nextRestartAt": now + 500
        })));
        assert!(d.starts_with("core crashed: lock-held; restart in "), "{d}");
        assert!(d.ends_with(" ms"), "{d}");
    }

    #[test]
    fn status_parts_keep_the_same_paths_in_every_case() {
        // Ruling H3-R25: `supervisor.process.state` and `children` sit at the same path whatever the probe found.
        let answered = json!({
            "supervisor": { "process": { "state": "ready", "since": 1 }, "instanceId": "i", "pid": 7, "uptimeMs": 5 },
            "children": [{ "role": "core", "process": { "state": "ready" } }]
        });
        let (sup, children) = status_parts(Probe::Answered(answered));
        assert_eq!(sup["process"]["state"], "ready");
        assert_eq!(sup["pid"], 7);
        assert_eq!(children[0]["role"], "core");
        assert_eq!(core_line(&sup, &children), "ready");

        let (sup, children) = status_parts(Probe::NotRunning);
        assert_eq!(sup["process"]["state"], "stopped");
        assert_eq!(children, json!([]));
        assert!(core_line(&sup, &children).starts_with("unknown"));

        let (sup, children) = status_parts(Probe::Unresponsive);
        assert_eq!(sup["process"]["state"], "degraded");
        assert_eq!(sup["process"]["reason"], "unresponsive");
        assert_eq!(children, json!([]));
    }

    /// A recorded call as `service::fake::FakeRunner`'s `calls.jsonl` stores it.
    fn calls(dir: &Path) -> Vec<Value> {
        std::fs::read_to_string(dir.join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn verbs(dir: &Path) -> Vec<String> {
        calls(dir)
            .iter()
            .map(|c| c["args"][0].as_str().unwrap_or_default().to_string())
            .collect()
    }

    /// `start_via_manager`/`start_launchd` against `FakeRunner` directly (not a subprocess), so this runs
    /// identically on Linux, macOS and Windows CI regardless of which manager the *host* actually has — unlike
    /// `tests/daemon.rs`'s `daemon_start_uses_a_registered_service_instead_of_spawning`, which only ever exercises
    /// the current host's own manager.
    #[test]
    fn start_launchd_falls_back_to_bootstrap_for_a_service_installed_without_start() {
        use crate::service::fake::FakeRunner;

        let tmp = tempfile::tempdir().unwrap();
        let fake = FakeRunner::new(tmp.path().to_path_buf());
        let name = "dev.plur1bus.supervisor-test";
        let plist = tmp.path().join(format!("{name}.plist"));
        std::fs::write(&plist, "x").unwrap();

        // Mirrors `service install --no-start`: the plist exists (so `service::status` reports the service
        // `registered`) but was never loaded into launchd (`launchd::install` only runs `bootout`/`bootstrap`
        // when `start` is true) — a real `launchctl kickstart` on it fails with ESRCH (3, "not loaded").
        assert_eq!(service::launchd::status(&fake, name, &plist), (true, false));

        let before = verbs(tmp.path()).len();
        start_launchd(&fake, name, &plist).unwrap();

        assert_eq!(&verbs(tmp.path())[before..], ["kickstart", "bootstrap"]);
        assert_eq!(service::launchd::status(&fake, name, &plist), (true, true));
    }

    #[test]
    fn start_launchd_kickstarts_an_already_loaded_service_without_a_fallback() {
        use crate::service::fake::FakeRunner;

        let tmp = tempfile::tempdir().unwrap();
        let fake = FakeRunner::new(tmp.path().to_path_buf());
        let name = "dev.plur1bus.supervisor-test";
        let plist = tmp.path().join(format!("{name}.plist"));
        std::fs::write(&plist, "x").unwrap();
        service::launchd::install(&fake, name, &plist, true).unwrap();
        assert_eq!(service::launchd::status(&fake, name, &plist), (true, true));

        let before = verbs(tmp.path()).len();
        start_launchd(&fake, name, &plist).unwrap();

        // No `bootstrap` fallback needed: `kickstart` alone succeeded on an already-loaded agent.
        assert_eq!(&verbs(tmp.path())[before..], ["kickstart"]);
    }

    #[test]
    fn start_via_manager_issues_the_expected_command_per_manager() {
        use crate::service::fake::FakeRunner;

        let systemd_tmp = tempfile::tempdir().unwrap();
        let fake = FakeRunner::new(systemd_tmp.path().to_path_buf());
        fake.run(
            "systemctl",
            &service::os_args(&["--user", "enable", "p1b.service"]),
        )
        .unwrap();
        let path = systemd_tmp.path().join("p1b.service");
        start_via_manager(&fake, Manager::Systemd, "p1b", &path).unwrap();
        assert_eq!(
            calls(systemd_tmp.path()).last().unwrap(),
            &json!({ "program": "systemctl", "args": ["--user", "start", "p1b.service"] })
        );

        let schtasks_tmp = tempfile::tempdir().unwrap();
        let fake = FakeRunner::new(schtasks_tmp.path().to_path_buf());
        fake.run(
            "schtasks",
            &service::os_args(&["/Create", "/XML", "x.xml", "/TN", "p1b", "/F"]),
        )
        .unwrap();
        let path = schtasks_tmp.path().join("p1b.xml");
        start_via_manager(&fake, Manager::TaskScheduler, "p1b", &path).unwrap();
        assert_eq!(
            calls(schtasks_tmp.path()).last().unwrap(),
            &json!({ "program": "schtasks", "args": ["/Run", "/TN", "p1b"] })
        );
    }
}
