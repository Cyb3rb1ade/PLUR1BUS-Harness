//! `plur1bus 1staid check` (spec §6.6, D12, ADR-016 §5): a read-only diagnostic pass over the installation. It
//! never writes, starts or signals anything (S12) and works whether or not the supervisor or the core are running.
//!
//! [`gather`] is pure orchestration over small readers, each producing one [`Check`] in the fixed table order
//! (ruling H3-R5): a later task inserts more checks by name (Task 13 "after models.warm", Task 14 "after
//! core.state"), so this file never assumes its list is exhaustive going forward. Every network call the checks
//! make is bounded to a 300 ms connect timeout and a 300 ms call timeout, keeping the whole pass under the 3 s
//! budget the brief sets even when nothing answers.
use crate::cli::FirstAidCmd;
use crate::output::Out;
use crate::paths::{core_address, supervisor_address, Layout};
use crate::service::{self, Runner};
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
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
const CHECK_IDS: [&str; 12] = [
    "config.valid",
    "run.permissions",
    "run.stale-files",
    "supervisor.state",
    "core.state",
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

/// One bounded, authenticated probe of `endpoint`: `None` when there is no token file, the connection is refused, or
/// the call itself fails or times out.
fn probe(
    layout: &Layout,
    endpoint: Endpoint,
    platform: &str,
    method: &str,
) -> Option<(Value, Client)> {
    let token = super::read_token_of(layout, endpoint)?;
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
    let mut client = super::connect_recorded(layout, &address, &token, opts).ok()?;
    let result = client.call(method, json!({})).ok()?;
    Some((result, client))
}

/// Pure orchestration over small readers (ruling H3-R5): produces every [`Check`] in the fixed table order the
/// brief specifies, so a later task can insert a row "after core.state" or "after models.warm" by name. Never
/// writes, starts or signals anything.
pub fn gather(layout: &Layout, env: &Env) -> Vec<Check> {
    let deadline = Instant::now() + GATHER_BUDGET;
    let mut checks = Vec::with_capacity(CHECK_IDS.len());
    checks.push(check_config_valid(layout));
    checks.push(check_run_permissions(layout));
    checks.push(check_run_stale_files(layout, env.platform));

    if out_of_budget(deadline, &mut checks) {
        return checks;
    }

    // The supervisor's own view: `daemon.status` gives both the supervisor's health and the core child's, exactly
    // as `daemon status` reports them.
    let sup_token = super::read_token_of(layout, Endpoint::Supervisor);
    let daemon_status = if sup_token.is_some() {
        probe(layout, Endpoint::Supervisor, env.platform, "daemon.status").map(|(v, _)| v)
    } else {
        None
    };
    checks.push(check_supervisor_state(sup_token.is_some(), &daemon_status));
    checks.push(check_core_state(sup_token.is_some(), &daemon_status));

    if out_of_budget(deadline, &mut checks) {
        return checks;
    }

    // A direct connection to the core: needed for the checks below that read its own state, not the supervisor's
    // view of it.
    let core_probe = probe(layout, Endpoint::Core, env.platform, "core.status");
    let core_peer_pid = core_probe.as_ref().and_then(|(_, c)| c.peer_pid());
    let core_status = core_probe.as_ref().map(|(v, _)| v.clone());
    let mut core_client = core_probe.map(|(_, c)| c);

    checks.push(check_core_lock(
        layout,
        core_status.is_some(),
        core_peer_pid,
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
/// default file when one is missing (a side effect this read-only check must not have).
fn check_config_valid(layout: &Layout) -> Check {
    const ID: &str = "config.valid";
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

fn pid_alive(pid: u32) -> bool {
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

fn check_supervisor_state(has_token: bool, daemon_status: &Option<Value>) -> Check {
    const ID: &str = "supervisor.state";
    match daemon_status {
        Some(_) => Check::ok(ID, "supervisor answers"),
        None if !has_token => Check::warn(
            ID,
            "supervisor is not running",
            None,
            Some("plur1bus daemon start".to_string()),
        ),
        None => Check::fail(ID, "supervisor is unresponsive", None, None),
    }
}

fn describe_child(child: &Value) -> (Status, String, Option<Value>) {
    let state = child["process"]["state"].as_str().unwrap_or("starting");
    match state {
        "ready" => (Status::Ok, "core is ready".to_string(), None),
        "crashed" => {
            let reason = child["process"]["reason"].as_str().unwrap_or("none");
            (
                Status::Fail,
                format!("core crashed: {reason}"),
                Some(json!({ "reason": reason })),
            )
        }
        other => (Status::Warn, format!("core is {other}"), None),
    }
}

fn check_core_state(has_token: bool, daemon_status: &Option<Value>) -> Check {
    const ID: &str = "core.state";
    let Some(status) = daemon_status else {
        // No supervisor answered: warn regardless of `has_token`, since either way there is nothing to ask about
        // the core (a stale token with an unresponsive supervisor is covered by `supervisor.state` already).
        let _ = has_token;
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

// ---- core.lock ----------------------------------------------------------------------------------

fn check_core_lock(layout: &Layout, core_reachable: bool, core_peer_pid: Option<u32>) -> Check {
    const ID: &str = "core.lock";
    if !core_reachable {
        return Check::skip(ID, "core is not reachable");
    }
    let recorded = layout.recorded_pid(Endpoint::Core);
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
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&path) {
            n += text.lines().filter(|l| !l.trim().is_empty()).count() as u64;
        }
    }
    n
}

fn check_journal_backlog(layout: &Layout, core_status: Option<&Value>) -> Check {
    const ID: &str = "journal.backlog";
    let from_core = core_status
        .and_then(|s| s["journalBacklog"].as_u64())
        .unwrap_or(0);
    let from_files = count_journal_lines(layout);
    let total = from_core.max(from_files);
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
    core_client: Option<&mut Client>,
    agents: Option<&Value>,
    deadline: Instant,
) -> Check {
    const ID: &str = "jobs.last-runs";
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
            if matches!(outcome, "failed" | "abandoned") {
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
            format!("{} job(s) last ran failed or abandoned", bad.len()),
            Some(json!({ "jobs": bad })),
            None,
        )
    }
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
        let check = check_core_lock(&layout, true, Some(4242));
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
        let check = check_core_lock(&layout, true, Some(4242));
        assert_eq!(check.status, Status::Fail, "{check:?}");
        assert_eq!(check.detail.as_ref().unwrap()["recorded"], 1111);
        assert_eq!(check.detail.unwrap()["serving"], 4242);
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
        let check = check_core_lock(&layout, true, Some(4242));
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
    fn out_of_budget_fills_every_remaining_id_with_a_time_budget_warning() {
        // Minor 4 of the review.
        let mut checks = vec![
            check_config_valid(&Layout::new(
                tempfile::tempdir().unwrap().path().to_path_buf(),
            )),
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
        let check = check_config_valid(&layout);
        assert_eq!(check.status, Status::Ok);
        assert!(!layout.config_path().exists());
    }
}
