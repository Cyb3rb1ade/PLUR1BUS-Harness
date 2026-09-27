//! `plur1bus 1staid check` (spec §6.6, D12, ADR-016 §5): a read-only diagnostic pass over the installation. It
//! never writes, starts or signals anything (S12) and works whether or not the supervisor or the core are running.
//!
//! [`gather`] is pure orchestration over small readers, each producing one [`Check`] in the fixed table order
//! (ruling H3-R5): later tasks insert more checks by name (Task 13 `models.warm` after `core.state`, Task 14
//! `memory.shared` after `models.warm`), so this file never assumes its list is exhaustive going forward. Every
//! network call the checks
//! make is bounded to a 300 ms connect timeout and a 300 ms call timeout, keeping the whole pass under the 3 s
//! budget the brief sets even when nothing answers.
use crate::cli::FirstAidCmd;
use crate::output::Out;
use crate::paths::{core_address, supervisor_address, Layout};
use crate::service::{self, Runner};
use plur1bus_rpc::{Client, ConnectOptions, Endpoint, RpcError};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Bounds every probe this check makes (the brief: "connections use the 300 ms connect timeout"; the whole check
/// budget is < 3 s, so a call deadline of the same order keeps a single unresponsive peer from dominating it).
const CHECK_TIMEOUT: Duration = Duration::from_millis(300);

/// The overall deadline for one `gather()` pass (Minor 4 of the review): bounds every probe together, including the
/// per-agent `jobs.history` calls, so a large or slow agent roster cannot make the whole check run long past what a
/// human waiting on it would expect. Whatever has not run by then is reported `warn` ("time budget exhausted")
/// rather than left to overrun.
const GATHER_BUDGET: Duration = Duration::from_secs(3);

/// Every check id, in the fixed table order (ruling H3-R5) — used to fill in the checks a budget-exhausted `gather`
/// never got to.
const CHECK_IDS: [&str; 14] = [
    "config.valid",
    "run.permissions",
    "run.stale-files",
    "supervisor.state",
    "core.state",
    "models.warm",
    "memory.shared",
    "core.lock",
    "service.registration",
    "agents.activity",
    "journal.backlog",
    "jobs.last-runs",
    "api.deprecations",
    "windows.pipe-acl",
];

/// `true` (after filling `checks` up to [`CHECK_IDS`]'s length with a "time budget exhausted" warning each) once
/// `deadline` has passed; `checks` must already hold exactly the ids `CHECK_IDS` names, in order, up to this point.
fn out_of_budget(deadline: Instant, checks: &mut Vec<Check>) -> bool {
    if Instant::now() < deadline {
        return false;
    }
    for id in &CHECK_IDS[checks.len()..] {
        checks.push(Check::warn(id, "time budget exhausted", None, None));
    }
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Warn,
    Fail,
    Skip,
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub id: &'static str,
    pub status: Status,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl Check {
    fn ok(id: &'static str, summary: impl Into<String>) -> Self {
        Self {
            id,
            status: Status::Ok,
            summary: summary.into(),
            detail: None,
            hint: None,
        }
    }
    fn warn(
        id: &'static str,
        summary: impl Into<String>,
        detail: Option<Value>,
        hint: Option<String>,
    ) -> Self {
        Self {
            id,
            status: Status::Warn,
            summary: summary.into(),
            detail,
            hint,
        }
    }
    fn fail(
        id: &'static str,
        summary: impl Into<String>,
        detail: Option<Value>,
        hint: Option<String>,
    ) -> Self {
        Self {
            id,
            status: Status::Fail,
            summary: summary.into(),
            detail,
            hint,
        }
    }
    fn skip(id: &'static str, summary: impl Into<String>) -> Self {
        Self {
            id,
            status: Status::Skip,
            summary: summary.into(),
            detail: None,
            hint: None,
        }
    }
}

/// What [`gather`] needs beyond the layout: the clock, the platform name (`"windows"`/`"posix"`, matching
/// [`crate::paths`]'s convention) and a [`Runner`] for `service::status` — the same seam `commands::service` and
/// `commands::daemon` use, so a test never has this touch a real systemd/launchd/Task Scheduler.
pub struct Env<'a> {
    pub now: u64,
    pub platform: &'static str,
    pub runner: &'a dyn Runner,
}

impl<'a> Env<'a> {
    pub fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
}

/// One bounded, authenticated probe of `endpoint`: `Err` when there is no token file (`Unavailable { reason:
/// "no-token" }`), the connection is refused, or the handshake or the call itself fails or times out.
fn probe(
    layout: &Layout,
    endpoint: Endpoint,
    platform: &str,
    method: &str,
) -> Result<(Value, Client), RpcError> {
    let token = super::read_token_of(layout, endpoint).ok_or_else(|| RpcError::Unavailable {
        reason: "no-token".into(),
        detail: String::new(),
    })?;
    let address = match endpoint {
        Endpoint::Core => core_address(&layout.home, platform),
        Endpoint::Supervisor => supervisor_address(&layout.home, platform),
    };
    let opts = ConnectOptions {
        connect_timeout: CHECK_TIMEOUT,
        call_timeout: CHECK_TIMEOUT,
        endpoint,
        expected_server_pid: None, // set by connect_recorded
    };
    let mut client = super::connect_recorded(layout, &address, &token, opts)?;
    let result = client.call(method, json!({}))?;
    Ok((result, client))
}

/// What a bounded probe of the supervisor found, classified like `commands::daemon`'s own probe (final review I1).
#[derive(Debug)]
enum SupervisorView {
    /// No `run/supervisor.token`: nothing was ever started here, or it stopped cleanly.
    NoToken,
    /// A token file is left, but nothing listens on the address (refused / no such socket or pipe), or
    /// `run/supervisor.pid` names a process that no longer exists: a supervisor killed by SIGKILL or a power loss.
    Stale,
    /// Something accepts the connection but does not complete the handshake or answer `daemon.status` in time.
    Unresponsive,
    /// `daemon.status`'s result.
    Answered(Value),
}

fn classify_supervisor(
    result: Result<Value, RpcError>,
    recorded_pid_alive: Option<bool>,
) -> SupervisorView {
    match result {
        Ok(v) => SupervisorView::Answered(v),
        Err(RpcError::Unavailable { reason, .. }) if reason == "no-token" => {
            SupervisorView::NoToken
        }
        Err(RpcError::Unavailable { reason, .. }) if reason == "core-unavailable" => {
            SupervisorView::Stale
        }
        Err(_) if recorded_pid_alive == Some(false) => SupervisorView::Stale,
        Err(_) => SupervisorView::Unresponsive,
    }
}

fn probe_supervisor(layout: &Layout, platform: &str) -> SupervisorView {
    let result = probe(layout, Endpoint::Supervisor, platform, "daemon.status").map(|(v, _)| v);
    let recorded_pid_alive = layout.recorded_pid(Endpoint::Supervisor).map(pid_alive);
    classify_supervisor(result, recorded_pid_alive)
}

/// Pure orchestration over small readers (ruling H3-R5): produces every [`Check`] in the fixed table order the
/// brief specifies, so a later task can insert a row "after core.state" or "after models.warm" by name. Never
/// writes, starts or signals anything.
pub fn gather(layout: &Layout, env: &Env) -> Vec<Check> {
    let deadline = Instant::now() + GATHER_BUDGET;
    let mut checks = Vec::with_capacity(CHECK_IDS.len());
    // The supervisor's own view: `daemon.status` gives the supervisor's health, the core child's (exactly as `daemon
    // status` reports them) and the configuration it runs, which `config.valid` needs first.
    let supervisor = probe_supervisor(layout, env.platform);
    let daemon_status = match &supervisor {
        SupervisorView::Answered(v) => Some(v),
        _ => None,
    };
    checks.push(check_config_valid(
        layout,
        daemon_status.map(|s| &s["config"]),
    ));
    checks.push(check_run_permissions(layout));
    checks.push(check_run_stale_files(layout, env.platform));

    if out_of_budget(deadline, &mut checks) {
        return checks;
    }

    checks.push(check_supervisor_state(&supervisor));
    checks.push(check_core_state(daemon_status));

    if out_of_budget(deadline, &mut checks) {
        return checks;
    }

    // A direct connection to the core: needed for the checks below that read its own state, not the supervisor's
    // view of it.
    let core_probe = probe(layout, Endpoint::Core, env.platform, "core.status");
    // Windows (S11/H3-R18): `connect_recorded` refuses a pipe whose server is not the pid in `run/core.pid`; that
    // refusal is exactly the mismatch `core.lock` reports, not an unreachable core.
    let core_server_mismatch = matches!(&core_probe, Err(e) if super::is_server_mismatch(e));
    let core_probe = core_probe.ok();
    let core_peer_pid = core_probe.as_ref().and_then(|(_, c)| c.peer_pid());
    let core_status = core_probe.as_ref().map(|(v, _)| v.clone());
    let mut core_client = core_probe.map(|(_, c)| c);

    checks.push(check_models_warm(core_status.as_ref()));
    checks.push(check_shared_memory(core_status.as_ref()));
    checks.push(check_core_lock(
        layout,
        core_status.is_some(),
        core_peer_pid,
        core_server_mismatch,
    ));
    checks.push(check_service_registration(layout, env.runner));

    if out_of_budget(deadline, &mut checks) {
        return checks;
    }

    let agents = core_status.as_ref().map(|s| s["agents"].clone());
    checks.push(check_agents_activity(env.now, agents.as_ref()));
    checks.push(check_journal_backlog(layout, core_status.as_ref()));

    if out_of_budget(deadline, &mut checks) {
        return checks;
    }

    checks.push(check_jobs_last_runs(
        core_status.as_ref(),
        core_client.as_mut(),
        agents.as_ref(),
        deadline,
    ));
    checks.push(check_api_deprecations(core_status.as_ref()));

    if out_of_budget(deadline, &mut checks) {
        return checks;
    }

    checks.push(check_windows_pipe_acl(layout));
    checks
}

// ---- config.valid ---------------------------------------------------------------------------

const CURRENT_CONFIG_SCHEMA_VERSION: u64 = 1;

/// Reads and validates `config.json` without ever writing it — unlike [`plur1bus_config::load`], which creates a
/// default file when one is missing (a side effect this read-only check must not have). `supervisor` is the running
/// supervisor's `daemon.status.config`: a hand edit it rejected fails the check with its errors (B4); while no valid
/// configuration runs (B18) the hint does not offer `config set`, which then has nothing to apply against.
fn check_config_valid(layout: &Layout, supervisor: Option<&Value>) -> Check {
    const ID: &str = "config.valid";
    if let Some(rejected) = supervisor.map(|c| &c["rejected"]).filter(|r| r.is_object()) {
        let hint = if supervisor.is_some_and(|c| c["revision"].is_string()) {
            "the supervisor runs the last valid configuration; fix config.json or use plur1bus config set"
        } else {
            "no valid configuration runs, so the core cannot start; fix config.json"
        };
        return Check::fail(
            ID,
            "the supervisor rejected config.json",
            Some(json!({ "errors": rejected["errors"], "at": rejected["at"] })),
            Some(hint.to_string()),
        );
    }
    let path = layout.config_path();
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Check::ok(
                ID,
                "config.json does not exist yet (defaults are created at the next start)",
            );
        }
        Err(e) => return Check::fail(ID, format!("cannot read config.json: {e}"), None, None),
    };
    let parsed: Result<Value, _> = serde_json::from_str(&text);
    let Ok(value) = parsed else {
        return Check::fail(
            ID,
            format!("config.json is not valid JSON: {}", parsed.unwrap_err()),
            None,
            None,
        );
    };
    if let Some(v) = value.get("schemaVersion").and_then(Value::as_u64) {
        if v < CURRENT_CONFIG_SCHEMA_VERSION {
            return Check::warn(
                ID,
                format!(
                    "config.json is schemaVersion {v} (current {CURRENT_CONFIG_SCHEMA_VERSION})"
                ),
                None,
                Some("config migrates at next core start".to_string()),
            );
        }
    }
    match plur1bus_config::load(&path) {
        Ok(_) => Check::ok(ID, "config.json is valid"),
        Err(e) => Check::fail(ID, format!("config.json is invalid: {e}"), None, None),
    }
}

// ---- run.permissions --------------------------------------------------------------------------

#[cfg(unix)]
fn check_run_permissions(layout: &Layout) -> Check {
    use std::os::unix::fs::PermissionsExt;
    const ID: &str = "run.permissions";
    let run = layout.run();
    if !run.exists() {
        return Check::ok(ID, "run/ has not been created yet");
    }
    let mode_of =
        |p: &Path| -> io::Result<u32> { Ok(std::fs::metadata(p)?.permissions().mode() & 0o777) };
    match mode_of(&run) {
        Ok(0o700) => {}
        Ok(m) => {
            return Check::fail(
                ID,
                format!("run/ is {m:03o}, expected 0700"),
                Some(json!({ "path": "run", "mode": format!("{m:03o}") })),
                None,
            )
        }
        Err(e) => {
            return Check::fail(
                ID,
                format!("cannot read run/'s permissions: {e}"),
                None,
                None,
            )
        }
    }
    for name in ["core.token", "supervisor.token"] {
        let p = run.join(name);
        if !p.exists() {
            continue;
        }
        match mode_of(&p) {
            Ok(0o600) => {}
            Ok(m) => {
                return Check::fail(
                    ID,
                    format!("{name} is {m:03o}, expected 0600"),
                    Some(json!({ "path": name, "mode": format!("{m:03o}") })),
                    None,
                )
            }
            Err(e) => {
                return Check::fail(
                    ID,
                    format!("cannot read {name}'s permissions: {e}"),
                    None,
                    None,
                )
            }
        }
    }
    Check::ok(ID, "run/ is 0700 and its token files are 0600")
}

#[cfg(windows)]
fn check_run_permissions(layout: &Layout) -> Check {
    const ID: &str = "run.permissions";
    let run = layout.run();
    if !run.exists() {
        return Check::ok(ID, "run/ has not been created yet");
    }
    match windows_restricted_to_user_and_system(&run) {
        Ok(true) => {}
        Ok(false) => {
            return Check::fail(
                ID,
                "run/ is not restricted to the user and SYSTEM",
                None,
                None,
            )
        }
        Err(e) => return Check::fail(ID, format!("cannot read run/'s ACL: {e}"), None, None),
    }
    for name in ["core.token", "supervisor.token"] {
        let p = run.join(name);
        if !p.exists() {
            continue;
        }
        match windows_restricted_to_user_and_system(&p) {
            Ok(true) => {}
            Ok(false) => {
                return Check::fail(
                    ID,
                    format!("{name} is not restricted to the user and SYSTEM"),
                    None,
                    None,
                )
            }
            Err(e) => return Check::fail(ID, format!("cannot read {name}'s ACL: {e}"), None, None),
        }
    }
    Check::ok(
        ID,
        "run/ and its token files are restricted to the user and SYSTEM",
    )
}

/// Reads `path`'s DACL through the Win32 API (`GetNamedSecurityInfoW`, [`plur1bus_rpc::win::file_dacl_report`]) and
/// checks it the same way `windows.pipe-acl` checks a pipe's — [`plur1bus_rpc::acl::run_writable_by_others`] — except
/// that `run/`'s own ACL (ruling S11: `icacls <p> /inheritance:r /grant:r *<user SID>:(F) *S-1-5-18:(F)`) never names
/// Administrators, so unlike a pipe's default DACL, an Administrators entry here is itself reported (ruling H3-R17).
/// Replaces an earlier `icacls` text-output parse, which mis-split localized/multi-word account names such as
/// `NT AUTHORITY\SYSTEM` and so failed on every normal install; the SID comparison this delegates to is
/// platform-neutral and unit-tested on Linux in `crates/plur1bus-rpc/src/acl.rs`.
#[cfg(windows)]
fn windows_restricted_to_user_and_system(path: &Path) -> io::Result<bool> {
    let user_sid = plur1bus_rpc::win::user_sid()?;
    let entries = plur1bus_rpc::win::file_dacl_report(path)?;
    Ok(plur1bus_rpc::acl::run_writable_by_others(&entries, &user_sid).is_empty())
}

// ---- run.stale-files --------------------------------------------------------------------------

/// Whether `pid` names a live process (`kill(pid, 0)` / `OpenProcess`). Also used by `config` routing (B6).
pub(crate) fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the pid exists; no signal is actually delivered.
        let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
        r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        // SAFETY: a standard open/close pair; a null handle means the process could not be opened.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return false;
            }
            CloseHandle(h);
            true
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

/// A socket/pipe or pid file with no live peer behind it (Review Focus 3): `run/supervisor.lock` is never checked
/// here (H3-R9: it is expected to exist and to be held for the supervisor's whole life), and neither are any
/// `*.tmp` files a crash left behind (also expected, H3-R9) — this only looks at the four named run files.
fn check_run_stale_files(layout: &Layout, platform: &str) -> Check {
    const ID: &str = "run.stale-files";
    let run = layout.run();
    let mut stale: Vec<String> = Vec::new();

    for (name, path, endpoint) in [
        ("core.pid", layout.core_pid(), Endpoint::Core),
        (
            "supervisor.pid",
            layout.supervisor_pid(),
            Endpoint::Supervisor,
        ),
    ] {
        if path.exists() {
            let alive = layout.recorded_pid(endpoint).is_some_and(pid_alive);
            if !alive {
                stale.push(name.to_string());
            }
        }
    }

    if platform != "windows" {
        for (name, path, endpoint) in [
            ("core.sock", run.join("core.sock"), Endpoint::Core),
            (
                "supervisor.sock",
                run.join("supervisor.sock"),
                Endpoint::Supervisor,
            ),
        ] {
            if path.exists() {
                let address = match endpoint {
                    Endpoint::Core => core_address(&layout.home, platform),
                    Endpoint::Supervisor => supervisor_address(&layout.home, platform),
                };
                let alive = plur1bus_rpc::transport::connect(&address, CHECK_TIMEOUT).is_ok();
                if !alive && !stale.iter().any(|s| s == name) {
                    stale.push(name.to_string());
                }
            }
        }
    }

    if stale.is_empty() {
        Check::ok(ID, "no stale run files")
    } else {
        stale.sort();
        Check::warn(
            ID,
            format!("stale run file(s): {}", stale.join(", ")),
            Some(json!({ "files": stale })),
            None,
        )
    }
}

// ---- supervisor.state / core.state -------------------------------------------------------------

fn check_supervisor_state(view: &SupervisorView) -> Check {
    const ID: &str = "supervisor.state";
    let start_hint = || Some("plur1bus daemon start".to_string());
    match view {
        SupervisorView::Answered(_) => Check::ok(ID, "supervisor answers"),
        SupervisorView::NoToken => Check::warn(ID, "supervisor is not running", None, start_hint()),
        // Review Focus 3: a crash or power loss leaves `run/supervisor.token` behind; the next `supervise` replaces
        // it, so this is the same "not running" warning, never a failure.
        SupervisorView::Stale => Check::warn(
            ID,
            "supervisor is not running (stale run files)",
            None,
            start_hint(),
        ),
        SupervisorView::Unresponsive => Check::fail(
            ID,
            "supervisor is unresponsive",
            None,
            Some("plur1bus daemon restart".to_string()),
        ),
    }
}

/// A crashed child the supervisor will restart (`nextRestartAt` set) is a warning; only a crash it will not retry
/// on its own — fatal (`config-invalid`, `engine-contract`) or a give-up after repeated crashes, both with
/// `nextRestartAt: null` until `daemon start` — is a failure (final review M2).
fn describe_child(child: &Value) -> (Status, String, Option<Value>) {
    let state = child["process"]["state"].as_str().unwrap_or("starting");
    match state {
        "ready" => (Status::Ok, "core is ready".to_string(), None),
        "crashed" => {
            let reason = child["process"]["reason"].as_str().unwrap_or("none");
            let restarts = child["restarts"].as_u64().unwrap_or(0);
            match child["nextRestartAt"].as_u64() {
                Some(next) => (
                    Status::Warn,
                    format!("core restarting (crashed: {reason}, restart {restarts})"),
                    Some(json!({ "reason": reason, "restarts": restarts, "nextRestartAt": next })),
                ),
                None => (
                    Status::Fail,
                    format!("core crashed: {reason}"),
                    Some(json!({ "reason": reason, "restarts": restarts })),
                ),
            }
        }
        other => (Status::Warn, format!("core is {other}"), None),
    }
}

fn check_core_state(daemon_status: Option<&Value>) -> Check {
    const ID: &str = "core.state";
    let Some(status) = daemon_status else {
        // No supervisor answered: there is nothing to ask about the core (an unresponsive supervisor is already a
        // failure in `supervisor.state`).
        return Check::warn(ID, "core is not running (no supervisor to ask)", None, None);
    };
    let Some(child) = status["children"].get(0) else {
        return Check::warn(ID, "core is not running", None, None);
    };
    let (status, summary, detail) = describe_child(child);
    Check {
        id: ID,
        status,
        summary,
        detail,
        hint: None,
    }
}

// ---- models.warm ----------------------------------------------------------------------------------

/// Spec §6.3 / ruling S7: `core.status.engine.degraded` carries the engine's model-derived state (E4). `null` → ok;
/// `models-warming` → warn (the models load in the background, recall falls back meanwhile); `model-failed` → fail
/// with the failed capability and the model's error. Core absent → skip.
fn check_models_warm(core_status: Option<&Value>) -> Check {
    const ID: &str = "models.warm";
    let Some(status) = core_status else {
        return Check::skip(ID, "core is not reachable");
    };
    let engine = &status["engine"];
    let degraded = &engine["degraded"];
    if degraded.is_null() {
        return Check::ok(ID, "models are ready");
    }
    let capability = degraded["capability"].as_str().unwrap_or("unknown");
    // The engine's capability names the model: "embedding" → the embedder, "reranker" → the reranker.
    let model = if capability == "embedding" {
        "embedder"
    } else {
        capability
    };
    match degraded["reason"].as_str().unwrap_or("unknown") {
        "models-warming" => Check::warn(
            ID,
            format!("models are warming up ({model})"),
            Some(json!({ "capability": capability })),
            Some("recall falls back until the models are loaded".to_string()),
        ),
        "model-failed" => {
            let error = engine["models"][model]["error"]
                .as_str()
                .unwrap_or("unknown")
                .to_string();
            Check::fail(
                ID,
                format!("the {model} failed to load: {error}"),
                Some(json!({ "capability": capability, "error": error })),
                Some(
                    "see logs/core.log; check the model download or the provider credentials"
                        .to_string(),
                ),
            )
        }
        other => Check::warn(
            ID,
            format!("engine is degraded: {other}"),
            Some(json!({ "capability": capability, "reason": other })),
            None,
        ),
    }
}

// ---- memory.shared ----------------------------------------------------------------------------------

/// Whether explicit shared memory (share/proposals) is available on this platform (E4, `core.status.engine.
/// sharedMemory`). Unsupported is a **warning**, not a failure: agent-private memory works fully either way (S12).
/// Absent (an older engine before this field, or the core unreachable) → skip.
fn check_shared_memory(core_status: Option<&Value>) -> Check {
    const ID: &str = "memory.shared";
    let Some(status) = core_status else {
        return Check::skip(ID, "core is not reachable");
    };
    let shared = &status["engine"]["sharedMemory"];
    if shared.is_null() {
        return Check::skip(ID, "engine does not report shared-memory support");
    }
    let mode = shared["mode"].as_str().unwrap_or("unknown");
    if shared["supported"].as_bool().unwrap_or(false) {
        return Check::ok(ID, format!("shared memory available ({mode})"));
    }
    let reason = shared["reason"].as_str().unwrap_or("unknown");
    Check::warn(
        ID,
        format!("explicit shared memory unavailable ({reason})"),
        Some(json!({ "mode": mode, "reason": reason })),
        Some("share and proposals answer E_NOT_AVAILABLE on this platform".to_string()),
    )
}

// ---- core.lock ----------------------------------------------------------------------------------

fn check_core_lock(
    layout: &Layout,
    core_reachable: bool,
    core_peer_pid: Option<u32>,
    server_mismatch: bool,
) -> Check {
    const ID: &str = "core.lock";
    let recorded = layout.recorded_pid(Endpoint::Core);
    if server_mismatch {
        // Windows: the client refused the core pipe because its server is not the process `run/core.pid` names
        // (S11, `pipe-server-mismatch`) — the same mismatch as below, seen before any request could be sent.
        return Check::fail(
            ID,
            "run/core.pid does not match the core that is actually serving",
            Some(json!({ "recorded": recorded, "reason": "pipe-server-mismatch" })),
            None,
        );
    }
    if !core_reachable {
        return Check::skip(ID, "core is not reachable");
    }
    match (recorded, core_peer_pid) {
        (Some(r), Some(p)) if r == p => Check::ok(ID, "run/core.pid matches the serving core"),
        // Ruling H3-R18: the core answers but `run/core.pid` was never recorded (a start-up race, or a core that
        // never wrote it) — this is a gap, not evidence of a wrong pid, so it only warns.
        (None, Some(_)) => Check::warn(
            ID,
            "core is serving but run/core.pid is missing",
            Some(json!({ "recorded": recorded, "serving": core_peer_pid })),
            None,
        ),
        // A pid file that names a different core than the one actually serving is a real mismatch.
        _ => Check::fail(
            ID,
            "run/core.pid does not match the core that is actually serving",
            Some(json!({ "recorded": recorded, "serving": core_peer_pid })),
            None,
        ),
    }
}

// ---- service.registration -------------------------------------------------------------------------

fn check_service_registration(layout: &Layout, runner: &dyn Runner) -> Check {
    const ID: &str = "service.registration";
    let st = service::status(runner, layout);
    if st.registered && st.running {
        Check::ok(ID, format!("{} is registered and running", st.name))
    } else if !st.registered {
        Check::warn(
            ID,
            format!("{} is not registered", st.name),
            None,
            Some("plur1bus service install".to_string()),
        )
    } else {
        Check::warn(
            ID,
            format!("{} is registered but not running", st.name),
            None,
            None,
        )
    }
}

// ---- agents.activity ---------------------------------------------------------------------------

/// Thresholds from spec §6.3: a live-facing activity (recall/capture/checkpoint) is stale past 30 s; a
/// background one (dreaming/consolidating/maintenance) past 10 min.
fn stale_threshold_ms(state: &str) -> Option<u64> {
    match state {
        "recalling" | "capturing" | "checkpointing" => Some(30_000),
        "dreaming" | "consolidating" | "maintenance" => Some(600_000),
        _ => None,
    }
}

fn check_agents_activity(now: u64, agents: Option<&Value>) -> Check {
    const ID: &str = "agents.activity";
    let Some(agents) = agents.and_then(Value::as_array) else {
        return Check::skip(ID, "core is not reachable");
    };
    let mut stale = Vec::new();
    for a in agents {
        let id = a["agentId"].as_str().unwrap_or("?");
        let state = a["activity"]["state"].as_str().unwrap_or("idle");
        let Some(threshold) = stale_threshold_ms(state) else {
            continue;
        };
        let since = a["activity"]["since"].as_u64().unwrap_or(now);
        if now.saturating_sub(since) > threshold {
            stale.push(id.to_string());
        }
    }
    if stale.is_empty() {
        Check::ok(ID, "no stale agent activity")
    } else {
        Check::warn(
            ID,
            format!("stale activity: {}", stale.join(", ")),
            Some(json!({ "agents": stale })),
            None,
        )
    }
}

// ---- journal.backlog ------------------------------------------------------------------------------

fn count_journal_lines(layout: &Layout) -> u64 {
    let Ok(entries) = std::fs::read_dir(layout.journal()) else {
        return 0;
    };
    let mut n = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        // A replay in progress (or one a killed core left behind) has renamed `<agent>.jsonl` to
        // `<agent>.jsonl.replaying-<pid>`: those lines are still backlog.
        if !is_journal_file(&entry.file_name().to_string_lossy()) {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&path) {
            n += complete_lines(&text);
        }
    }
    n
}

/// Non-blank `\n`-terminated lines, as the core's `journalBacklog` counts them: the bytes after the last `\n` are a
/// line still being written (or a torn tail), not a backlogged turn.
fn complete_lines(text: &str) -> u64 {
    let Some(end) = text.rfind('\n') else {
        return 0;
    };
    text[..end]
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .count() as u64
}

fn is_journal_file(name: &str) -> bool {
    if name.ends_with(".jsonl") {
        return true;
    }
    match name.rsplit_once(".jsonl.replaying-") {
        Some((stem, pid)) => {
            !stem.is_empty() && !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit())
        }
        None => false,
    }
}

fn check_journal_backlog(layout: &Layout, core_status: Option<&Value>) -> Check {
    const ID: &str = "journal.backlog";
    let from_core = core_status
        .and_then(|s| s["journalBacklog"].as_u64())
        .unwrap_or(0);
    let from_files = count_journal_lines(layout);
    let total = from_core.max(from_files);
    // B2: the core serves while its journal replays in the background; the lines still waiting are progress, not a
    // stuck backlog.
    let replay = core_status.map(|s| &s["journalReplay"]);
    if replay.and_then(|r| r["state"].as_str()) == Some("replaying") {
        let replayed = replay.and_then(|r| r["replayed"].as_u64()).unwrap_or(0);
        // Replayed lines stay in the `.replaying-*` file in progress (both counts above include them) until the
        // replay finishes that file.
        let pending = replay
            .and_then(|r| r["pendingRemoval"].as_u64())
            .unwrap_or(0);
        let left = total.saturating_sub(pending);
        return Check::warn(
            ID,
            format!("replaying: {replayed} replayed, {left} left"),
            Some(json!({ "replayed": replayed, "left": left })),
            None,
        );
    }
    if total == 0 {
        Check::ok(ID, "no journal backlog")
    } else {
        Check::warn(
            ID,
            format!("{total} backlogged journal line(s)"),
            Some(json!({ "count": total })),
            None,
        )
    }
}

// ---- jobs.last-runs -----------------------------------------------------------------------------

/// `deadline` bounds the whole loop (Minor 4 of the review): a large agent roster, or one whose `jobs.history` calls
/// are each slow, stops at the deadline rather than running past it — reported as "time budget exhausted" rather
/// than a partial, silently-incomplete result.
fn check_jobs_last_runs(
    core_status: Option<&Value>,
    core_client: Option<&mut Client>,
    agents: Option<&Value>,
    deadline: Instant,
) -> Check {
    const ID: &str = "jobs.last-runs";
    // E4 (Task 15): the core reports job health itself; `jobs.history` per agent is the fallback for a core without it.
    if let Some(jobs) = core_status
        .and_then(|s| s.get("jobs"))
        .filter(|j| j.is_object())
    {
        return check_jobs_from_status(jobs);
    }
    let (Some(client), Some(agents)) = (core_client, agents.and_then(Value::as_array)) else {
        return Check::skip(ID, "core is not reachable");
    };
    let mut bad = Vec::new();
    for a in agents {
        if Instant::now() >= deadline {
            return Check::warn(ID, "time budget exhausted", None, None);
        }
        let Some(agent_id) = a["agentId"].as_str() else {
            continue;
        };
        let Ok(history) = client.call(
            "jobs.history",
            json!({ "agentId": agent_id, "limit": 1000 }),
        ) else {
            continue;
        };
        let mut seen_jobs: HashSet<String> = HashSet::new();
        let mut runs = history["runs"].as_array().cloned().unwrap_or_default();
        // Newest first, so "limit 1 per job" keeps each job's most recent run.
        runs.sort_by_key(|r| std::cmp::Reverse(r["startedAt"].as_u64().unwrap_or(0)));
        for run in runs {
            let Some(job) = run["job"].as_str() else {
                continue;
            };
            if !seen_jobs.insert(job.to_string()) {
                continue;
            }
            let outcome = run["outcome"].as_str().unwrap_or("");
            if matches!(outcome, "failed" | "abandoned" | "incomplete") {
                bad.push(json!({
                    "agentId": agent_id,
                    "job": job,
                    "outcome": outcome,
                    "runId": run["runId"],
                }));
            }
        }
    }
    if bad.is_empty() {
        Check::ok(ID, "every job's last run succeeded or was skipped")
    } else {
        Check::warn(
            ID,
            format!(
                "{} job(s) last ran failed, abandoned or incomplete",
                bad.len()
            ),
            Some(json!({ "jobs": bad })),
            None,
        )
    }
}

/// `core.status.jobs` (`$defs/JobsStatus`): a failed, abandoned or incomplete last run, an open rem/deep breaker, or unreadable
/// ledger lines are each a warning; an unavailable ledger is one too (the engine could not read job health at all).
fn check_jobs_from_status(jobs: &Value) -> Check {
    const ID: &str = "jobs.last-runs";
    let mut bad = Vec::new();
    let mut breakers = Vec::new();
    let mut unreadable = Vec::new();
    for a in jobs["agents"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let agent_id = &a["agentId"];
        if let Some(runs) = a["lastRuns"].as_object() {
            for (job, run) in runs {
                let outcome = run["outcome"].as_str().unwrap_or("");
                if matches!(outcome, "failed" | "abandoned" | "incomplete") {
                    bad.push(json!({ "agentId": agent_id, "job": job, "outcome": outcome, "reason": run["reason"] }));
                }
            }
        }
        if a["breakerOpen"] == json!(true) {
            breakers.push(agent_id.clone());
        }
        let lines = a["unreadableLines"].as_u64().unwrap_or(0);
        if lines > 0 {
            unreadable.push(json!({ "agentId": agent_id, "lines": lines }));
        }
    }
    let ledger_ok = jobs["ledger"] == json!("ok");
    if bad.is_empty() && breakers.is_empty() && unreadable.is_empty() && ledger_ok {
        return Check::ok(ID, "every job's last run succeeded or was skipped");
    }
    let mut parts = Vec::new();
    if !ledger_ok {
        parts.push("job ledger unavailable".to_string());
    }
    if !bad.is_empty() {
        parts.push(format!(
            "{} job(s) last ran failed, abandoned or incomplete",
            bad.len()
        ));
    }
    if !breakers.is_empty() {
        parts.push(format!(
            "rem/deep session breaker open for {} agent(s)",
            breakers.len()
        ));
    }
    if !unreadable.is_empty() {
        parts.push(format!(
            "unreadable job ledger lines for {} agent(s)",
            unreadable.len()
        ));
    }
    let mut detail = json!({ "jobs": bad });
    if !breakers.is_empty() {
        detail["breakerOpen"] = json!(breakers);
    }
    if !unreadable.is_empty() {
        detail["unreadableLines"] = json!(unreadable);
    }
    if !ledger_ok {
        detail["ledger"] = jobs["ledger"].clone();
    }
    let hint = (!breakers.is_empty()).then(|| {
        "the rem/deep LLM-session limit for the current UTC sweep is reached; those runs skip until the next sweep"
            .to_string()
    });
    Check::warn(ID, parts.join("; "), Some(detail), hint)
}

// ---- api.deprecations ---------------------------------------------------------------------------

fn check_api_deprecations(core_status: Option<&Value>) -> Check {
    const ID: &str = "api.deprecations";
    let used: HashSet<String> = core_status
        .and_then(|s| s["deprecationsUsed"].as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let mut entries = Vec::new();
    for server in ["core", "supervisor"] {
        let caps = plur1bus_rpc::capabilities(server, &[]);
        for (kind, prefix) in [("methods", "method"), ("notifications", "notification")] {
            let Some(map) = caps[kind].as_object() else {
                continue;
            };
            for (name, entry) in map {
                let Some(dep) = entry.get("deprecated") else {
                    continue;
                };
                let key = format!("{prefix}:{name}");
                entries.push(json!({
                    "name": name,
                    "since": dep["since"],
                    "removeAfter": dep["removeAfter"],
                    "replacement": dep["replacement"],
                    "used": used.contains(&key),
                }));
            }
        }
    }
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));

    if entries.is_empty() {
        return Check::ok(ID, "no deprecated API surface");
    }
    let used_count = entries.iter().filter(|e| e["used"] == json!(true)).count();
    let summary = format!(
        "{} deprecated entr{} ({used_count} used)",
        entries.len(),
        if entries.len() == 1 { "y" } else { "ies" }
    );
    let detail = Some(json!({ "deprecations": entries }));
    if used_count == 0 {
        // Ruling H3-R16: a deprecated surface existing is not itself a problem — only warn once something actually
        // called it. The full list is still shown so an install can see what to watch for.
        Check {
            id: ID,
            status: Status::Ok,
            summary,
            detail,
            hint: None,
        }
    } else {
        Check::warn(ID, summary, detail, None)
    }
}

// ---- windows.pipe-acl ---------------------------------------------------------------------------

#[cfg(windows)]
fn check_windows_pipe_acl(layout: &Layout) -> Check {
    use plur1bus_rpc::win;
    const ID: &str = "windows.pipe-acl";
    let user_sid = match win::user_sid() {
        Ok(s) => s,
        Err(e) => {
            return Check::fail(
                ID,
                format!("cannot read the current user's SID: {e}"),
                None,
                None,
            )
        }
    };
    let mut writable = Vec::new();
    for (name, address) in [
        ("core", core_address(&layout.home, "windows")),
        ("supervisor", supervisor_address(&layout.home, "windows")),
    ] {
        if let Ok(entries) = win::pipe_dacl_report(&address) {
            let sids = win::writable_by_others(&entries, &user_sid);
            if !sids.is_empty() {
                writable.push(json!({ "pipe": name, "sids": sids }));
            }
        }
        // A pipe nobody is currently serving is not this check's concern (`run.stale-files` covers that).
    }
    if writable.is_empty() {
        Check::ok(ID, "no pipe is writable by another account")
    } else {
        Check::fail(
            ID,
            "a pipe is writable by another account",
            Some(json!({ "pipes": writable })),
            None,
        )
    }
}

#[cfg(not(windows))]
fn check_windows_pipe_acl(_layout: &Layout) -> Check {
    Check::skip("windows.pipe-acl", "windows only")
}

// ---- the CLI command -------------------------------------------------------------------------------

pub fn run(out: &Out, layout: &Layout, cmd: FirstAidCmd) {
    match cmd {
        FirstAidCmd::Check => {
            let runner = super::service::runner(out);
            let env = Env {
                now: Env::now_ms(),
                platform: if cfg!(windows) { "windows" } else { "posix" },
                runner: runner.as_ref(),
            };
            let checks = gather(layout, &env);
            let ok = !checks.iter().any(|c| c.status == Status::Fail);
            out.ok(
                "1staid.check/1",
                &json!({ "ok": ok, "checks": checks }),
                || {
                    checks
                        .iter()
                        .map(|c| {
                            let mark = match c.status {
                                Status::Ok => "ok",
                                Status::Warn => "warn",
                                Status::Fail => "FAIL",
                                Status::Skip => "skip",
                            };
                            format!("{mark:<5} {:<24} {}", c.id, c.summary)
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                },
            );
            if !ok {
                std::process::exit(1);
            }
        }
        FirstAidCmd::Repair { .. } => {
            super::stubs::milestone(out, "1staid repair", "2a-H3b", "repair (spec §6.6)")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn warm_status(degraded: Value, embedder_error: Option<&str>) -> Value {
        let mut embedder =
            json!({ "state": "failed", "warming": false, "checkedAt": 1, "id": "e5" });
        if let Some(e) = embedder_error {
            embedder["error"] = json!(e);
        }
        json!({ "engine": { "ready": degraded.is_null(), "degraded": degraded, "models": {
            "embedder": embedder,
            "reranker": { "state": "ready", "warming": false, "checkedAt": 1, "id": "local-transformers" } } } })
    }

    #[test]
    fn models_warm_is_ok_when_nothing_is_degraded() {
        let c = check_models_warm(Some(&warm_status(Value::Null, None)));
        assert_eq!(c.status, Status::Ok, "{c:?}");
    }

    #[test]
    fn models_warming_is_a_warning() {
        let s = warm_status(
            json!({ "reason": "models-warming", "capability": "reranker" }),
            None,
        );
        let c = check_models_warm(Some(&s));
        assert_eq!(c.status, Status::Warn, "{c:?}");
        assert_eq!(c.detail, Some(json!({ "capability": "reranker" })));
    }

    #[test]
    fn a_failed_model_is_a_failure_with_capability_and_error() {
        let s = warm_status(
            json!({ "reason": "model-failed", "capability": "embedding" }),
            Some("provider-failed"),
        );
        let c = check_models_warm(Some(&s));
        assert_eq!(c.status, Status::Fail, "{c:?}");
        assert_eq!(
            c.detail,
            Some(json!({ "capability": "embedding", "error": "provider-failed" }))
        );
        assert!(
            c.hint
                .as_deref()
                .is_some_and(|h| h.contains("logs/core.log")),
            "{c:?}"
        );
    }

    #[test]
    fn models_warm_is_skipped_without_a_core() {
        assert_eq!(check_models_warm(None).status, Status::Skip);
    }

    fn shared_memory_status(shared: Value) -> Value {
        json!({ "engine": { "ready": true, "degraded": Value::Null, "sharedMemory": shared } })
    }

    #[test]
    fn shared_memory_supported_is_ok_with_the_mode_in_summary() {
        let s = shared_memory_status(json!({ "supported": true, "mode": "fd-capability" }));
        let c = check_shared_memory(Some(&s));
        assert_eq!(c.status, Status::Ok, "{c:?}");
        assert!(c.summary.contains("fd-capability"), "{c:?}");
    }

    #[test]
    fn shared_memory_unavailable_is_a_warning_not_a_failure() {
        let s = shared_memory_status(
            json!({ "supported": false, "mode": "unavailable", "reason": "platform" }),
        );
        let c = check_shared_memory(Some(&s));
        assert_eq!(c.status, Status::Warn, "{c:?}");
        assert!(c.summary.contains("platform"), "{c:?}");
        assert_eq!(
            c.detail,
            Some(json!({ "mode": "unavailable", "reason": "platform" }))
        );
        assert!(
            c.hint
                .as_deref()
                .is_some_and(|h| h.contains("E_NOT_AVAILABLE")),
            "{c:?}"
        );
    }

    #[test]
    fn shared_memory_is_skipped_when_absent_or_the_core_is_unreachable() {
        assert_eq!(check_shared_memory(None).status, Status::Skip);
        let s = json!({ "engine": { "ready": true, "degraded": Value::Null } });
        assert_eq!(check_shared_memory(Some(&s)).status, Status::Skip);
    }

    #[test]
    fn describe_child_names_every_state() {
        let child = |extra: Value| {
            let mut v = json!({ "process": { "state": "ready" } });
            if let (Some(a), Some(b)) = (v.as_object_mut(), extra.as_object()) {
                for (k, x) in b {
                    a.insert(k.clone(), x.clone());
                }
            }
            v
        };
        let (s, summary, _) = describe_child(&child(json!({})));
        assert_eq!(s, Status::Ok);
        assert_eq!(summary, "core is ready");

        let (s, summary, detail) = describe_child(&child(json!({
            "process": { "state": "crashed", "reason": "config-invalid" }
        })));
        assert_eq!(s, Status::Fail);
        assert_eq!(summary, "core crashed: config-invalid");
        assert_eq!(detail.unwrap()["reason"], "config-invalid");

        let (s, summary, _) = describe_child(&child(json!({
            "process": { "state": "orphaned" }
        })));
        assert_eq!(s, Status::Warn);
        assert_eq!(summary, "core is orphaned");

        // M2: a crash the supervisor will retry on its own is a warning, not a failure.
        let (s, summary, detail) = describe_child(&child(json!({
            "process": { "state": "crashed", "reason": "lock-held" },
            "restarts": 2,
            "nextRestartAt": 1_700_000_000_000u64
        })));
        assert_eq!(s, Status::Warn);
        assert_eq!(summary, "core restarting (crashed: lock-held, restart 2)");
        assert_eq!(detail.unwrap()["nextRestartAt"], 1_700_000_000_000u64);

        // A give-up (repeated crashes) or a fatal crash has `nextRestartAt: null` and stays a failure.
        let (s, summary, _) = describe_child(&child(json!({
            "process": { "state": "crashed", "reason": "none" },
            "restarts": 5,
            "nextRestartAt": Value::Null
        })));
        assert_eq!(s, Status::Fail);
        assert_eq!(summary, "core crashed: none");
    }

    fn unavailable(reason: &str) -> RpcError {
        RpcError::Unavailable {
            reason: reason.into(),
            detail: String::new(),
        }
    }

    #[test]
    fn supervisor_probe_results_are_classified_like_daemon_status() {
        // I1: a refused connection (the stale token of a SIGKILLed supervisor) or a dead recorded pid is "not
        // running", a warning; only a peer that accepts but never answers is a failure.
        let classify = |r, alive| format!("{:?}", classify_supervisor(r, alive));
        assert!(classify(Ok(json!({})), None).starts_with("Answered"));
        assert_eq!(classify(Err(unavailable("no-token")), None), "NoToken");
        assert_eq!(
            classify(Err(unavailable("core-unavailable")), None),
            "Stale"
        );
        assert_eq!(
            classify(Err(unavailable("core-unavailable")), Some(true)),
            "Stale"
        );
        assert_eq!(
            classify(Err(unavailable("handshake-timeout")), Some(false)),
            "Stale"
        );
        assert_eq!(
            classify(Err(unavailable("handshake-timeout")), None),
            "Unresponsive"
        );
        assert_eq!(
            classify(Err(unavailable("call-timeout")), Some(true)),
            "Unresponsive"
        );

        assert_eq!(
            check_supervisor_state(&SupervisorView::Stale).status,
            Status::Warn
        );
        assert_eq!(
            check_supervisor_state(&SupervisorView::Stale).summary,
            "supervisor is not running (stale run files)"
        );
        assert_eq!(
            check_supervisor_state(&SupervisorView::NoToken).status,
            Status::Warn
        );
        assert_eq!(
            check_supervisor_state(&SupervisorView::Unresponsive).status,
            Status::Fail
        );
    }

    #[test]
    fn stale_threshold_ms_matches_spec_6_3() {
        assert_eq!(stale_threshold_ms("recalling"), Some(30_000));
        assert_eq!(stale_threshold_ms("capturing"), Some(30_000));
        assert_eq!(stale_threshold_ms("checkpointing"), Some(30_000));
        assert_eq!(stale_threshold_ms("dreaming"), Some(600_000));
        assert_eq!(stale_threshold_ms("consolidating"), Some(600_000));
        assert_eq!(stale_threshold_ms("maintenance"), Some(600_000));
        assert_eq!(stale_threshold_ms("idle"), None);
    }

    #[test]
    fn api_deprecations_lists_engine_event_unused_by_default() {
        // Ruling H3-R16: a deprecated entry existing is not itself a warning — only ok, with the list still shown,
        // until something has actually used one.
        let check = check_api_deprecations(None);
        assert_eq!(check.status, Status::Ok);
        let deps = check.detail.unwrap()["deprecations"].clone();
        let entry = deps
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["name"] == "engine.event")
            .unwrap();
        assert_eq!(entry["used"], false);
    }

    #[test]
    fn api_deprecations_marks_engine_event_used_from_core_status() {
        let status = json!({ "deprecationsUsed": ["notification:engine.event"] });
        let check = check_api_deprecations(Some(&status));
        let deps = check.detail.unwrap()["deprecations"].clone();
        let entry = deps
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["name"] == "engine.event")
            .unwrap();
        assert_eq!(entry["used"], true);
    }

    #[test]
    fn api_deprecations_warns_only_once_some_entry_is_used() {
        // Ruling H3-R16.
        let unused = check_api_deprecations(None);
        assert_eq!(unused.status, Status::Ok);

        let status = json!({ "deprecationsUsed": ["notification:engine.event"] });
        let used = check_api_deprecations(Some(&status));
        assert_eq!(used.status, Status::Warn);
    }

    #[test]
    fn core_lock_missing_pid_file_is_a_warning_not_a_failure() {
        // Ruling H3-R18: the core answers but `run/core.pid` was never recorded (start-up race, or an unrecorded
        // core) — a gap, not evidence of a wrong pid.
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let check = check_core_lock(&layout, true, Some(4242), false);
        assert_eq!(check.status, Status::Warn, "{check:?}");
        assert_eq!(check.detail.unwrap()["serving"], 4242);
    }

    #[test]
    fn core_lock_pid_file_naming_a_different_core_is_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(layout.run()).unwrap();
        std::fs::write(
            layout.core_pid(),
            "1111 00000000-0000-4000-8000-000000000000\n",
        )
        .unwrap();
        let check = check_core_lock(&layout, true, Some(4242), false);
        assert_eq!(check.status, Status::Fail, "{check:?}");
        assert_eq!(check.detail.as_ref().unwrap()["recorded"], 1111);
        assert_eq!(check.detail.unwrap()["serving"], 4242);
    }

    #[test]
    fn core_lock_pipe_server_mismatch_is_a_failure() {
        // M4 (Windows, H3-R18): `connect_recorded` refuses a core pipe served by another pid than `run/core.pid`, so
        // the core looks unreachable — the check must still report the mismatch instead of skipping.
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(layout.run()).unwrap();
        std::fs::write(
            layout.core_pid(),
            "1111 00000000-0000-4000-8000-000000000000\n",
        )
        .unwrap();
        let check = check_core_lock(&layout, false, None, true);
        assert_eq!(check.status, Status::Fail, "{check:?}");
        let detail = check.detail.unwrap();
        assert_eq!(detail["recorded"], 1111);
        assert_eq!(detail["reason"], "pipe-server-mismatch");
        assert_eq!(
            check_core_lock(&layout, false, None, false).status,
            Status::Skip
        );
    }

    #[test]
    fn core_lock_matching_pid_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(layout.run()).unwrap();
        std::fs::write(
            layout.core_pid(),
            "4242 00000000-0000-4000-8000-000000000000\n",
        )
        .unwrap();
        let check = check_core_lock(&layout, true, Some(4242), false);
        assert_eq!(check.status, Status::Ok, "{check:?}");
    }

    #[test]
    fn journal_backlog_takes_the_larger_of_core_status_and_the_files_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(layout.journal()).unwrap();
        assert_eq!(check_journal_backlog(&layout, None).status, Status::Ok);
        std::fs::write(layout.journal().join("a.jsonl"), "{}\n{}\n").unwrap();
        let check = check_journal_backlog(&layout, None);
        assert_eq!(check.status, Status::Warn);
        assert_eq!(check.detail.unwrap()["count"], 2);
    }

    #[test]
    fn journal_backlog_counts_a_replay_in_progress() {
        // Carry-over of Task 12: while a replay runs, `<agent>.jsonl` is `<agent>.jsonl.replaying-<pid>`.
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(layout.journal()).unwrap();
        std::fs::write(layout.journal().join("a.jsonl.replaying-4242"), "{}\n{}\n").unwrap();
        // The bytes after the last newline are a line still being written: not counted (as in the core).
        std::fs::write(layout.journal().join("b.jsonl"), "{}\n\n{\"v\":1,\"id\"").unwrap();
        std::fs::write(layout.journal().join("c.jsonl.replaying-x"), "{}\n").unwrap();
        std::fs::write(layout.journal().join("notes.txt"), "{}\n").unwrap();
        let check = check_journal_backlog(&layout, None);
        assert_eq!(check.status, Status::Warn);
        assert_eq!(check.detail.unwrap()["count"], 3);
    }

    #[test]
    fn journal_backlog_while_replaying_is_a_warning_with_progress() {
        // One agent, 40 journaled lines: the replay renamed the file and has replayed 30 of them, which stay in the
        // `.replaying-<pid>` file (and in the engine's count) until the file is finished.
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(layout.journal()).unwrap();
        std::fs::write(
            layout.journal().join("bernd.jsonl.replaying-4242"),
            "{}\n".repeat(40),
        )
        .unwrap();
        let status = json!({ "journalBacklog": 40, "journalReplay": { "state": "replaying", "replayed": 30,
            "pendingRemoval": 30, "kept": 0, "passes": 0, "startedAt": 1, "finishedAt": null } });
        let check = check_journal_backlog(&layout, Some(&status));
        assert_eq!(check.status, Status::Warn, "{check:?}");
        assert_eq!(check.summary, "replaying: 30 replayed, 10 left");
        assert_eq!(check.detail.unwrap(), json!({ "replayed": 30, "left": 10 }));
        // A second agent's file waiting for its turn is left too; the first file finished (removed, pending reset).
        std::fs::remove_file(layout.journal().join("bernd.jsonl.replaying-4242")).unwrap();
        std::fs::write(layout.journal().join("anna.jsonl"), "{}\n".repeat(5)).unwrap();
        let next = json!({ "journalBacklog": 5, "journalReplay": { "state": "replaying", "replayed": 40,
            "pendingRemoval": 0, "kept": 0, "passes": 0, "startedAt": 1, "finishedAt": null } });
        assert_eq!(
            check_journal_backlog(&layout, Some(&next)).summary,
            "replaying: 40 replayed, 5 left"
        );
        // A finished replay with nothing left is ok again.
        std::fs::remove_file(layout.journal().join("anna.jsonl")).unwrap();
        let done = json!({ "journalBacklog": 0, "journalReplay": { "state": "done", "replayed": 45,
            "pendingRemoval": 0, "kept": 0, "passes": 1, "startedAt": 1, "finishedAt": 2 } });
        assert_eq!(
            check_journal_backlog(&layout, Some(&done)).status,
            Status::Ok
        );
    }

    #[test]
    fn jobs_from_core_status_warn_on_failures_breaker_and_unreadable_lines() {
        let deadline = Instant::now() + Duration::from_secs(5);
        let healthy = json!({ "jobs": { "ledger": "ok", "agents": [{ "agentId": "bernd", "running": [], "breakerOpen": false,
            "unreadableLines": 0, "lastRuns": { "gc-run": { "outcome": "skipped", "finishedAt": 1 } } }] } });
        let check = check_jobs_last_runs(Some(&healthy), None, None, deadline);
        assert_eq!(check.status, Status::Ok, "{check:?}");

        let sick = json!({ "jobs": { "ledger": "ok", "agents": [{ "agentId": "bernd", "running": ["dream-rem"], "breakerOpen": true,
            "unreadableLines": 2, "lastRuns": { "gc-run": { "outcome": "failed", "reason": "boom", "finishedAt": 1 } } }] } });
        let check = check_jobs_last_runs(Some(&sick), None, None, deadline);
        assert_eq!(check.status, Status::Warn, "{check:?}");
        let detail = check.detail.unwrap();
        assert_eq!(detail["jobs"][0]["job"], "gc-run");
        assert_eq!(detail["breakerOpen"], json!(["bernd"]));
        assert_eq!(detail["unreadableLines"][0]["lines"], 2);

        let incomplete = json!({ "jobs": { "ledger": "ok", "agents": [{ "agentId": "bernd", "running": [], "breakerOpen": false,
            "unreadableLines": 0, "lastRuns": { "consolidate-daily": { "outcome": "incomplete", "finishedAt": 1 } } }] } });
        let check = check_jobs_last_runs(Some(&incomplete), None, None, deadline);
        assert_eq!(check.status, Status::Warn, "{check:?}");
        assert_eq!(check.detail.unwrap()["jobs"][0]["outcome"], "incomplete");

        let no_ledger = json!({ "jobs": { "ledger": "unavailable", "agents": [] } });
        assert_eq!(
            check_jobs_last_runs(Some(&no_ledger), None, None, deadline).status,
            Status::Warn
        );

        // Without `jobs` (an older core) and without a client, the `jobs.history` fallback has nothing to ask.
        assert_eq!(
            check_jobs_last_runs(Some(&json!({})), None, None, deadline).status,
            Status::Skip
        );
    }

    #[test]
    fn out_of_budget_fills_every_remaining_id_with_a_time_budget_warning() {
        // Minor 4 of the review.
        let mut checks = vec![
            check_config_valid(
                &Layout::new(tempfile::tempdir().unwrap().path().to_path_buf()),
                None,
            ),
            Check::ok("run.permissions", "x"),
            Check::ok("run.stale-files", "x"),
        ];
        let past = Instant::now() - Duration::from_millis(1);
        assert!(out_of_budget(past, &mut checks));
        let ids: Vec<&str> = checks.iter().map(|c| c.id).collect();
        assert_eq!(ids, CHECK_IDS);
        for c in &checks[3..] {
            assert_eq!(c.status, Status::Warn, "{c:?}");
            assert_eq!(c.summary, "time budget exhausted");
        }
        // Not yet exhausted: leaves `checks` untouched.
        let mut untouched = vec![Check::ok("config.valid", "x")];
        assert!(!out_of_budget(
            Instant::now() + Duration::from_secs(60),
            &mut untouched
        ));
        assert_eq!(untouched.len(), 1);
    }

    #[test]
    fn config_valid_reports_ok_when_config_json_is_absent_without_creating_it() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let check = check_config_valid(&layout, None);
        assert_eq!(check.status, Status::Ok);
        assert!(!layout.config_path().exists());
    }

    #[test]
    fn config_valid_fails_when_the_supervisor_rejected_an_edit() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let errors = json!(["/core/logLevel \"loud\" is not one of the allowed values"]);
        // A valid configuration still runs: the hint offers both ways out.
        let running =
            json!({ "revision": "0123456789abcdef", "rejected": { "at": 5, "errors": errors } });
        let c = check_config_valid(&layout, Some(&running));
        assert_eq!(c.status, Status::Fail, "{c:?}");
        assert_eq!(c.detail.as_ref().unwrap()["errors"], errors);
        assert_eq!(
            c.hint.as_deref(),
            Some("the supervisor runs the last valid configuration; fix config.json or use plur1bus config set")
        );
        // Nothing runs (invalid at start, B18): `config set` has nothing to apply against, so it is not offered.
        let none = json!({ "revision": null, "rejected": { "at": 5, "errors": errors } });
        let c = check_config_valid(&layout, Some(&none));
        assert_eq!(c.status, Status::Fail);
        assert!(!c.hint.as_deref().unwrap().contains("config set"), "{c:?}");
        // No rejection: the file decides, as without a supervisor.
        let clean = json!({ "revision": "0123456789abcdef", "rejected": null });
        assert_eq!(check_config_valid(&layout, Some(&clean)).status, Status::Ok);
    }
}
