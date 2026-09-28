//! The repair steps of 2a-H3b-b Task 8: a hung unit, a stale store schema, and the two HB17 reports.
//!
//! | step | trigger | action | risk |
//! |---|---|---|---|
//! | `unit.terminate-hung` | no supervisor answers, and the core's or a module's socket accepts but does not answer its handshake or `*.status` within [`HUNG_TIMEOUT`] | terminate through the pinned peer, then remove its run files | high |
//! | `store.migrate` | `core.status.engine.storeSchema.current != expected` | `admin.migrate { from, to }` over the core (G5) | high |
//! | `service.silent-exit` | the last `logs/supervisor.log` record is `exiting 0 instead of <code>`, no supervisor answers | report | none |
//! | `service.restart-loop` | at least [`LOOP_MIN_STARTS`] `supervisor started` records within [`LOOP_WINDOW_MS`], no supervisor answers | report | none |
//!
//! **Pinned peer** (ADR-012 §10.7, Review Focus 3): the process a hung-unit step terminates is the one the OS names as
//! the server of the unit's socket or pipe ([`adopt::probe_child`]), and only while `run/<unit>.pid` names that same
//! pid with the instance id recorded when the plan was made. Right before the termination the unit is probed again
//! and both are compared; the signal then goes through [`Peer`] (a pidfd on Linux, a process handle and
//! `TerminateProcess` on Windows, a fresh peer check on macOS), so a recycled pid is never hit. A pid file that names
//! any other process, or no pid file at all, is a `peer-mismatch`: listed, `skipped`, nothing signalled.
//!
//! The RPC schema calls the version the core needs `storeSchema.expected`; the plan's `required` is read as a
//! fallback.
use super::{Ctx, Risk, Step};
use crate::commands::firstaid::{Check, Status, BUDGET_EXHAUSTED};
use crate::paths::{Endpoints, Layout};
use crate::supervisor::adopt::{self, Peer, Probe};
use crate::supervisor::state::RoleKind;
use crate::supervisor::Role;
use plur1bus_rpc::{Client, RpcError};
use serde_json::{json, Value};
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{Duration, Instant};

/// How long a unit's socket may take to answer its handshake, and then `*.status`, before it counts as hung.
pub const HUNG_TIMEOUT: Duration = Duration::from_secs(2);
/// After SIGTERM (unix), how long the process has before SIGKILL. Windows has no SIGTERM: `TerminateProcess` at once.
const TERM_GRACE: Duration = Duration::from_secs(2);
/// After the kill, how long to wait for the process to be gone.
const KILL_WAIT: Duration = Duration::from_secs(5);
/// How often a termination checks whether the process is gone.
const GONE_TICK: Duration = Duration::from_millis(25);
/// How long a run file another process still holds (Windows) is retried before it is left in place.
const RUN_FILE_WAIT: Duration = Duration::from_secs(2);
/// HB17: this many `supervisor started` records …
pub const LOOP_MIN_STARTS: usize = 5;
/// … within this window make a restart loop.
pub const LOOP_WINDOW_MS: u64 = 10 * 60 * 1000;
/// Only the end of `logs/supervisor.log` is read.
const LOG_TAIL_BYTES: u64 = 1024 * 1024;

const TERMINATE_ACTION: &str =
    "terminate the hung process through its pinned peer and remove its run files";

fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "posix"
    }
}

/// Whether the check pass found no supervisor answering (`supervisor.state` reached and not `ok`). A row the pass
/// never reached counts as "cannot tell", so nothing that needs a silent supervisor is planned.
fn no_supervisor_answers(checks: &[Check]) -> bool {
    checks
        .iter()
        .find(|c| c.id == "supervisor.state")
        .is_some_and(|c| c.summary != BUDGET_EXHAUSTED && c.status != Status::Ok)
}

/// The steps of this module for `checks`, limited to the ids `wanted` keeps (a probe nobody asked for is not made).
pub fn plan(checks: &[Check], ctx: &Ctx, wanted: &dyn Fn(&str) -> bool) -> Vec<Step> {
    let silent = no_supervisor_answers(checks);
    let hung_wanted = silent && wanted("unit.terminate-hung");
    let mut steps = Vec::new();
    if hung_wanted || wanted("store.migrate") {
        let core = Role::core();
        match inspect(ctx.layout, &core) {
            Finding::Answers {
                status: Some(status),
                ..
            } if wanted("store.migrate") => steps.extend(store_step(&status)),
            f if hung_wanted => steps.extend(hung_step(&core, f)),
            _ => {}
        }
    }
    if hung_wanted {
        for m in crate::modules::scan(ctx.layout) {
            if !valid_module_name(&m.name) {
                continue;
            }
            let role = Role::module(&m.name);
            steps.extend(hung_step(&role, inspect(ctx.layout, &role)));
        }
    }
    if silent && (wanted("service.silent-exit") || wanted("service.restart-loop")) {
        let records = read_log_tail(&ctx.layout.log_file("supervisor"));
        if wanted("service.silent-exit") {
            if let Some((code, at)) = silent_exit(&records) {
                steps.push(report_step(
                    "service.silent-exit",
                    json!({ "code": code, "at": at }),
                ));
            }
        }
        if wanted("service.restart-loop") {
            if let Some(evidence) = restart_loop(&records) {
                steps.push(report_step("service.restart-loop", evidence));
            }
        }
    }
    steps
}

/// A module directory name that can be a run file's stem (the same rule as `run.stale-files.remove`).
fn valid_module_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

// ---- unit.terminate-hung -------------------------------------------------------------------------------------------

/// What answers on a unit's address.
enum Finding {
    /// Nothing listens.
    Absent,
    /// It accepts, and `run/<unit>.pid` names the server with `instance`, but the handshake (`probe: "handshake"`)
    /// or `*.status` (`"status"`) got no answer in time. `peer` is pinned.
    Hung {
        peer: Peer,
        instance: String,
        probe: &'static str,
    },
    /// Something serves, but the pid file does not pin it (another pid, no pid file, another instance).
    Mismatch {
        pid: u32,
        recorded: Option<u32>,
        why: String,
    },
    /// It answers (`status` when `*.status` succeeded).
    Answers {
        status: Option<Value>,
        #[allow(dead_code)] // kept open until the finding is dropped
        client: Option<Client>,
    },
}

/// `<pid> <instanceId>` from a unit's pid file.
fn pid_file(ep: &Endpoints) -> Option<(u32, Option<String>)> {
    let text = fs::read_to_string(&ep.pid).ok()?;
    let mut fields = text.split_whitespace();
    let pid = fields.next()?.parse().ok()?;
    Some((pid, fields.next().map(str::to_string)))
}

fn is_timeout(e: &RpcError) -> bool {
    matches!(e, RpcError::Unavailable { reason, .. } if reason == "call-timeout" || reason == "handshake-timeout")
}

fn inspect(layout: &Layout, role: &Role) -> Finding {
    let ep = layout.endpoints(role, platform());
    let pinned = |peer: Peer, probe: &'static str| match pid_file(&ep) {
        Some((pid, Some(instance))) if pid == peer.pid => Finding::Hung {
            peer,
            instance,
            probe,
        },
        recorded => Finding::Mismatch {
            pid: peer.pid,
            recorded: recorded.as_ref().map(|r| r.0),
            why: match recorded {
                None => "no-pid-file".into(),
                Some((_, None)) => "no-instance-id".into(),
                Some(_) => "server-pid-mismatch".into(),
            },
        },
    };
    match adopt::probe_child(layout, role, HUNG_TIMEOUT) {
        Probe::Absent => Finding::Absent,
        Probe::Hung { peer } => pinned(peer, "handshake"),
        // It answered, if only with an error: not hung.
        Probe::Foreign { reason, .. } if reason.starts_with("handshake-failed") => {
            Finding::Answers {
                status: None,
                client: None,
            }
        }
        Probe::Foreign { peer, reason } => Finding::Mismatch {
            pid: peer.pid,
            recorded: pid_file(&ep).map(|r| r.0),
            why: reason,
        },
        Probe::Serving {
            peer, mut client, ..
        } => match client.call(&role.method("status"), json!({})) {
            Ok(status) => Finding::Answers {
                status: Some(status),
                client: Some(client),
            },
            Err(e) if is_timeout(&e) => {
                drop(client);
                pinned(peer, "status")
            }
            Err(_) => Finding::Answers {
                status: None,
                client: Some(client),
            },
        },
    }
}

fn describe_unit(role: &Role, pid: u32) -> String {
    match role.kind {
        RoleKind::Core => format!("core (pid {pid})"),
        RoleKind::Module => format!("module {} (pid {pid})", role.name),
    }
}

fn unit_json(role: &Role) -> (&'static str, &'static str) {
    match role.kind {
        RoleKind::Core => ("core", "core.lock"),
        RoleKind::Module => ("module", "modules.state"),
    }
}

/// The step for a unit's finding: `planned` for a pinned hung unit, `skipped` `peer-mismatch` for a server the pid
/// file does not pin, none otherwise.
fn hung_step(role: &Role, finding: Finding) -> Option<Step> {
    let (kind, reason) = unit_json(role);
    match finding {
        Finding::Hung {
            peer,
            instance,
            probe,
        } => Some(
            Step::planned(
                "unit.terminate-hung",
                TERMINATE_ACTION,
                describe_unit(role, peer.pid),
                reason,
                Risk::High,
                terminate_hung,
            )
            .with_detail(json!({
                "role": kind, "name": role.name, "pid": peer.pid, "instanceId": instance, "probe": probe,
            })),
        ),
        Finding::Mismatch { pid, recorded, why } => {
            let mut step = Step::planned(
                "unit.terminate-hung",
                TERMINATE_ACTION,
                describe_unit(role, pid),
                reason,
                Risk::High,
                terminate_hung,
            )
            .skipped_because(
                "peer-mismatch",
                &format!(
                    "the {kind}'s pid file does not name the process serving its address ({why}); nothing is terminated"
                ),
            );
            if let Some(d) = step.detail.as_mut().and_then(Value::as_object_mut) {
                d.insert("role".into(), json!(kind));
                d.insert("name".into(), json!(role.name));
                d.insert("pid".into(), json!(pid));
                d.insert("recorded".into(), json!(recorded));
                d.insert("probe".into(), json!(why));
            }
            Some(step)
        }
        Finding::Absent | Finding::Answers { .. } => None,
    }
}

/// A `skipped` outcome of an apply (see `execute`): the step changed nothing, `reason` says why.
fn skip(reason: &str, message: String) -> Result<Value, String> {
    Ok(json!({ "skipped": true, "reason": reason, "message": message }))
}

/// Waits until `peer` is gone or `within` passes; returns whether it is gone.
fn wait_gone(peer: &Peer, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    loop {
        if !peer.alive() {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        std::thread::sleep((deadline - now).min(GONE_TICK));
    }
}

/// Probes the unit again and terminates it only when the same pid still serves its address with the same instance id
/// in its pid file, and still does not answer. SIGTERM, then SIGKILL after [`TERM_GRACE`] (unix); `TerminateProcess`
/// through the pinned handle (Windows). Then its run files go, unless its pid file names another process by then.
pub fn terminate_hung(ctx: &Ctx, step: &Step) -> Result<Value, String> {
    let d = step.detail.clone().unwrap_or(Value::Null);
    let pid = d["pid"]
        .as_u64()
        .and_then(|p| u32::try_from(p).ok())
        .ok_or("the plan names no pid")?;
    let instance = d["instanceId"]
        .as_str()
        .ok_or("the plan names no instance id")?;
    let name = d["name"].as_str().unwrap_or("core");
    let role = match d["role"].as_str() {
        Some("module") if valid_module_name(name) => Role::module(name),
        Some("core") => Role::core(),
        _ => return Err("the plan names no unit".into()),
    };
    let peer = match inspect(ctx.layout, &role) {
        Finding::Hung {
            peer, instance: i, ..
        } if peer.pid == pid && i == instance => peer,
        Finding::Hung { peer, .. } => {
            return skip(
                "peer-mismatch",
                format!(
                    "pid {} serves now as another instance than planned",
                    peer.pid
                ),
            )
        }
        Finding::Mismatch { pid: now, why, .. } => {
            return skip(
                "peer-mismatch",
                format!("the pid file no longer pins the server (pid {now}, {why})"),
            )
        }
        Finding::Answers { .. } => {
            return skip(
                "not-hung",
                format!("{} answers now", describe_unit(&role, pid)),
            )
        }
        Finding::Absent => {
            return skip(
                "already-gone",
                format!("nothing serves the {} address any more", role.name),
            )
        }
    };
    let t0 = Instant::now();
    let mut signal = "terminate";
    let mut gone = peer.terminate() && wait_gone(&peer, TERM_GRACE);
    if !gone {
        signal = "kill";
        if !peer.kill() && peer.alive() {
            return Err(format!(
                "cannot signal pid {pid}: it is no longer pinned as the server of the {} address",
                role.name
            ));
        }
        gone = wait_gone(&peer, KILL_WAIT);
    }
    if !gone {
        return Err(format!("pid {pid} is still running after the kill"));
    }
    let removed = remove_run_files(ctx.layout, &role, pid)?;
    Ok(json!({
        "role": d["role"], "name": name, "pid": pid, "instanceId": instance, "signal": signal,
        "elapsedMs": t0.elapsed().as_millis() as u64, "removed": removed,
    }))
}

/// Removes `fs::remove_file(path)`, retrying a Windows sharing or lock violation (another process still closing its
/// handle) until [`RUN_FILE_WAIT`] passes. `Ok(false)` when the file was not there.
fn remove_retrying(path: &Path) -> io::Result<bool> {
    let deadline = Instant::now() + RUN_FILE_WAIT;
    loop {
        match fs::remove_file(path) {
            Ok(()) => return Ok(true),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(e) if matches!(e.raw_os_error(), Some(5 | 32 | 33)) && cfg!(windows) => {
                if Instant::now() >= deadline {
                    return Err(e);
                }
                std::thread::sleep(GONE_TICK);
            }
            Err(e) => return Err(e),
        }
    }
}

/// The unit's pid file, token and (unix) socket, when its pid file still names `pid` or is gone; nothing when another
/// process has written it since.
fn remove_run_files(layout: &Layout, role: &Role, pid: u32) -> Result<Vec<String>, String> {
    let ep = layout.endpoints(role, platform());
    if pid_file(&ep).is_some_and(|(p, _)| p != pid) {
        return Ok(Vec::new());
    }
    let mut files = vec![ep.pid.clone(), ep.token.clone()];
    if cfg!(unix) {
        let socket = std::path::PathBuf::from(&ep.address);
        // Only a socket file inside run/, and only while nothing accepts on it.
        if socket.parent() == Some(layout.run().as_path())
            && plur1bus_rpc::transport::connect(&ep.address, Duration::from_millis(300)).is_err()
        {
            files.push(socket);
        }
    }
    let mut removed = Vec::new();
    for f in files {
        match remove_retrying(&f) {
            Ok(true) => removed.push(
                f.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            ),
            Ok(false) => {}
            Err(e) => return Err(format!("{}: {e}", f.display())),
        }
    }
    Ok(removed)
}

// ---- store.migrate -------------------------------------------------------------------------------------------------

/// `store.migrate` when the core's store schema is not the one it expects. A store with no marker yet (`current:
/// null`) plans nothing: the core writes it itself.
fn store_step(status: &Value) -> Option<Step> {
    let schema = &status["engine"]["storeSchema"];
    let current = schema["current"].as_str()?;
    let expected = schema["expected"]
        .as_str()
        .or_else(|| schema["required"].as_str())?;
    (current != expected).then(|| {
        Step::planned(
            "store.migrate",
            "migrate the memory store schema with admin.migrate over the core",
            format!("{current}→{expected}"),
            "core.state",
            Risk::High,
            migrate_store,
        )
        .with_detail(json!({ "from": current, "to": expected }))
    })
}

/// `admin.migrate { from, to }` on the core, with the CLI's own migrate timeout (`admin migrate`, 2a-H3b-a): the
/// engine runs a migration to its end, so the call waits for it rather than leave one it cannot see finishing.
pub fn migrate_store(ctx: &Ctx, step: &Step) -> Result<Value, String> {
    let d = step.detail.clone().unwrap_or(Value::Null);
    let (Some(from), Some(to)) = (d["from"].as_str(), d["to"].as_str()) else {
        return Err("the plan names no versions".into());
    };
    let mut c =
        crate::commands::memory::connect(ctx.layout, crate::commands::admin::MIGRATE_TIMEOUT)
            .map_err(|e| format!("core unavailable: {e}"))?;
    if !c.supports("admin.migrate") {
        return Err("the core does not support admin.migrate".into());
    }
    c.call("admin.migrate", json!({ "from": from, "to": to }))
        .map_err(|e| e.to_string())
}

// ---- service.silent-exit / service.restart-loop ----------------------------------------------------------------------

/// A report step: no change, no confirmation; `evidence` is its detail, before and after it runs.
fn report_step(id: &'static str, evidence: Value) -> Step {
    Step::report(
        id,
        "logs/supervisor.log",
        "supervisor.state",
        report_evidence,
    )
    .with_detail(evidence)
}

fn report_evidence(_ctx: &Ctx, step: &Step) -> Result<Value, String> {
    Ok(step.detail.clone().unwrap_or(Value::Null))
}

/// One `logs/supervisor.log` record: its `at` (milliseconds, when it parses) and `msg`.
#[derive(Debug, Clone, PartialEq)]
struct Record {
    at: Option<String>,
    at_ms: Option<u64>,
    msg: String,
}

/// The records of the last [`LOG_TAIL_BYTES`] of the log, in order. A line that is not a JSON record (a cut first
/// line, a stray write) is skipped; CRLF endings are accepted.
fn read_log_tail(path: &Path) -> Vec<Record> {
    let read = || -> io::Result<String> {
        let mut f = fs::File::open(path)?;
        let len = f.metadata()?.len();
        let start = len.saturating_sub(LOG_TAIL_BYTES);
        f.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::new();
        f.take(LOG_TAIL_BYTES).read_to_end(&mut bytes)?;
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        if start > 0 {
            // The first line is cut.
            text = text
                .split_once('\n')
                .map(|(_, r)| r.to_string())
                .unwrap_or_default();
        }
        Ok(text)
    };
    parse_records(&read().unwrap_or_default())
}

fn parse_records(text: &str) -> Vec<Record> {
    text.lines()
        .filter_map(|l| {
            let v: Value = serde_json::from_str(l.trim_end_matches('\r').trim()).ok()?;
            let msg = v["msg"].as_str()?.to_string();
            let at = v["at"].as_str().map(str::to_string);
            Some(Record {
                at_ms: at.as_deref().and_then(parse_iso8601_ms),
                at,
                msg,
            })
        })
        .collect()
}

/// `exiting <mapped> instead of <code> …` → `(mapped, code)`.
fn remapped_exit(msg: &str) -> Option<(i64, i64)> {
    let rest = msg.strip_prefix("exiting ")?;
    let (mapped, rest) = rest.split_once(" instead of ")?;
    let code: String = rest.chars().take_while(char::is_ascii_digit).collect();
    Some((mapped.trim().parse().ok()?, code.parse().ok()?))
}

/// HB17: the last record is a launchd remap to 0 → `(code, at)`, the code the supervisor meant.
fn silent_exit(records: &[Record]) -> Option<(i64, Option<String>)> {
    let last = records.last()?;
    match remapped_exit(&last.msg)? {
        (0, code) if code != 0 => Some((code, last.at.clone())),
        _ => None,
    }
}

/// How the run that logged `records` (the records after its start) ended, when the log says: a launchd remap gives
/// the code the supervisor meant, a clean stop 0, a panic 70.
fn exit_code_of(records: &[Record]) -> Option<i64> {
    records.iter().rev().find_map(|r| {
        if let Some((_, code)) = remapped_exit(&r.msg) {
            Some(code)
        } else if r.msg == "supervisor stopped" {
            Some(0)
        } else if r.msg == "thread panicked" {
            Some(70)
        } else {
            None
        }
    })
}

/// HB17: at least [`LOOP_MIN_STARTS`] `supervisor started` records within [`LOOP_WINDOW_MS`] of the latest one →
/// `{ starts, windowMs, lastExitCode }` (`windowMs` spans the first to the last of those starts).
fn restart_loop(records: &[Record]) -> Option<Value> {
    let starts: Vec<(usize, u64)> = records
        .iter()
        .enumerate()
        .filter(|(_, r)| r.msg == "supervisor started")
        .filter_map(|(i, r)| Some((i, r.at_ms?)))
        .collect();
    let &(last_index, last) = starts.last()?;
    let in_window: Vec<u64> = starts
        .iter()
        .map(|&(_, at)| at)
        .filter(|&at| at <= last && last - at <= LOOP_WINDOW_MS)
        .collect();
    if in_window.len() < LOOP_MIN_STARTS {
        return None;
    }
    let first = in_window.iter().copied().min().unwrap_or(last);
    Some(json!({
        "starts": in_window.len(),
        "windowMs": last - first,
        "lastExitCode": exit_code_of(&records[last_index + 1..]),
    }))
}

/// `YYYY-MM-DDTHH:MM:SS[.mmm]Z` (what the supervisor's log writes) → milliseconds since the epoch.
fn parse_iso8601_ms(s: &str) -> Option<u64> {
    let s = s.strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut d = date.splitn(3, '-');
    let (y, mo, da): (i64, i64, i64) = (
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
    );
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let mut t = hms.splitn(3, ':');
    let (h, mi, se): (i64, i64, i64) = (
        t.next()?.parse().ok()?,
        t.next()?.parse().ok()?,
        t.next()?.parse().ok()?,
    );
    if !(1..=12).contains(&mo) || !(1..=31).contains(&da) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let digits: String = frac.chars().take(3).collect();
    let ms: i64 = format!("{digits:0<3}").parse().ok()?;
    // Howard Hinnant's days_from_civil.
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let total = ((days * 86_400 + h * 3600 + mi * 60 + se) * 1000) + ms;
    u64::try_from(total).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::setup::Prompter;
    use crate::repair::{execute, Plan, StepStatus};
    use crate::service::fake::FakeRunner;

    fn rec(at: &str, msg: &str) -> Record {
        Record {
            at: Some(at.into()),
            at_ms: parse_iso8601_ms(at),
            msg: msg.into(),
        }
    }

    #[test]
    fn iso8601_parses_what_the_supervisor_log_writes() {
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_iso8601_ms("2026-09-28T10:00:00.120Z"),
            Some(1_790_589_600_120)
        );
        assert_eq!(
            parse_iso8601_ms("2026-09-28T10:00:00Z"),
            Some(1_790_589_600_000)
        );
        for bad in [
            "2026-09-28 10:00:00Z",
            "2026-13-01T00:00:00Z",
            "yesterday",
            "",
        ] {
            assert_eq!(parse_iso8601_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn records_skip_non_json_lines_and_accept_crlf() {
        let text = "{\"at\":\"2026-09-28T10:00:00.000Z\",\"msg\":\"supervisor started\"}\r\n\
                    garbage\n{\"msg\":\"no at\"}\n{\"at\":1}\n";
        let r = parse_records(text);
        assert_eq!(r.len(), 2, "{r:?}");
        assert_eq!(r[0].msg, "supervisor started");
        assert!(r[0].at_ms.is_some());
        assert_eq!(r[1].at_ms, None);
    }

    #[test]
    fn a_silent_exit_is_only_the_last_record_remapped_to_zero() {
        let exit = "exiting 0 instead of 3 so launchd does not restart a non-transient failure";
        let r = vec![
            rec("2026-09-28T10:00:00.000Z", "supervisor started"),
            rec("2026-09-28T10:00:00.100Z", exit),
        ];
        assert_eq!(
            silent_exit(&r),
            Some((3, Some("2026-09-28T10:00:00.100Z".into())))
        );
        let later = [
            r.clone(),
            vec![rec("2026-09-28T10:01:00.000Z", "supervisor ready")],
        ]
        .concat();
        assert_eq!(silent_exit(&later), None);
        assert_eq!(silent_exit(&[]), None);
    }

    #[test]
    fn a_restart_loop_needs_five_starts_within_ten_minutes_of_the_last() {
        let starts = |mins: &[u32]| -> Vec<Record> {
            mins.iter()
                .map(|m| {
                    rec(
                        &format!("2026-09-28T1{}:{:02}:00.000Z", m / 60, m % 60),
                        "supervisor started",
                    )
                })
                .collect()
        };
        assert_eq!(restart_loop(&starts(&[0, 1, 2, 3])), None);
        let v = restart_loop(&starts(&[0, 30, 31, 32, 33, 34])).unwrap();
        assert_eq!(v["starts"], 5);
        assert_eq!(v["windowMs"], 4 * 60_000);
        assert_eq!(v["lastExitCode"], Value::Null);
        // Spread over more than ten minutes: no loop.
        assert_eq!(restart_loop(&starts(&[0, 3, 6, 9, 12])), None);
        // The last run's own end names the exit code.
        let mut r = starts(&[0, 1, 2, 3, 4]);
        r.push(rec("2026-09-28T10:04:01.000Z", "thread panicked"));
        assert_eq!(restart_loop(&r).unwrap()["lastExitCode"], 70);
    }

    #[test]
    fn remapped_exits_parse_both_codes() {
        assert_eq!(
            remapped_exit("exiting 0 instead of 2 so launchd does not restart"),
            Some((0, 2))
        );
        assert_eq!(remapped_exit("supervisor started"), None);
        assert_eq!(remapped_exit("exiting soon instead of 2"), None);
    }

    #[test]
    fn the_store_step_compares_current_with_expected() {
        let status = |s: Value| json!({ "engine": { "ready": true, "storeSchema": s } });
        let s = store_step(&status(json!({ "current": "1", "expected": "2" }))).unwrap();
        assert_eq!(
            (s.id, s.target.as_str(), s.risk),
            ("store.migrate", "1→2", Risk::High)
        );
        assert!(s.needs_confirmation);
        assert!(store_step(&status(json!({ "current": "2", "expected": "2" }))).is_none());
        assert!(store_step(&status(json!({ "current": null, "expected": "2" }))).is_none());
        assert!(store_step(&json!({ "engine": { "ready": true } })).is_none());
        assert!(store_step(&status(json!({ "current": "1", "required": "2" }))).is_some());
    }

    #[test]
    fn nothing_that_needs_a_silent_supervisor_is_planned_while_one_answers_or_unknown() {
        let row = |status, summary: &str| Check {
            id: "supervisor.state",
            status,
            summary: summary.into(),
            detail: None,
            hint: None,
        };
        assert!(no_supervisor_answers(&[row(
            Status::Warn,
            "supervisor is not running"
        )]));
        assert!(no_supervisor_answers(&[row(
            Status::Fail,
            "supervisor is unresponsive"
        )]));
        assert!(!no_supervisor_answers(&[row(
            Status::Ok,
            "supervisor answers"
        )]));
        assert!(!no_supervisor_answers(&[row(
            Status::Warn,
            BUDGET_EXHAUSTED
        )]));
        assert!(!no_supervisor_answers(&[]));
    }

    struct Script {
        answers: Vec<bool>,
        asked: Vec<String>,
    }
    impl Prompter for Script {
        fn ask(&mut self, _key: &str, _question: &str, default: &str) -> String {
            default.to_string()
        }
        fn confirm(&mut self, question: &str) -> bool {
            self.asked.push(question.to_string());
            !self.answers.is_empty() && self.answers.remove(0)
        }
    }

    #[test]
    fn report_steps_never_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().join("h"));
        let runner = FakeRunner::new(dir.path().to_path_buf());
        let ctx = Ctx::for_host(&layout, &runner);
        let mut plan = Plan {
            steps: vec![
                report_step("service.silent-exit", json!({ "code": 3, "at": null })),
                report_step("service.restart-loop", json!({ "starts": 6 })),
            ],
        };
        assert!(!plan.needs_confirmation());
        let mut s = Script {
            answers: vec![],
            asked: vec![],
        };
        execute(&mut plan, &ctx, &mut s, false);
        assert!(s.asked.is_empty(), "{:?}", s.asked);
        assert!(plan.steps.iter().all(|s| s.status == StepStatus::Done));
        assert_eq!(plan.steps[0].detail, Some(json!({ "code": 3, "at": null })));
    }

    /// A hand-started fake core that stops answering (`hang-after:0`), in its own temp home.
    struct HungCore {
        _dir: tempfile::TempDir,
        layout: Layout,
        child: std::process::Child,
    }

    impl HungCore {
        fn start() -> HungCore {
            let dir = tempfile::tempdir().unwrap();
            let layout = Layout::new(dir.path().join("h"));
            fs::create_dir_all(&layout.home).unwrap();
            let events = dir.path().join("events.jsonl");
            let fixture =
                Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-core.mjs");
            let child = std::process::Command::new("node")
                .arg(fixture)
                .arg("--home")
                .arg(&layout.home)
                .env("FAKE_CORE_MODE", "hang-after:0")
                .env("FAKE_CORE_EVENTS", &events)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            // Windows: an icacls child secures the run files after listen; wait for it, so nothing still holds one.
            let ready = |text: &str| {
                text.contains("\"hung\"") && (!cfg!(windows) || text.contains("\"secured\""))
            };
            let deadline = Instant::now() + Duration::from_secs(20);
            while !ready(&fs::read_to_string(&events).unwrap_or_default()) {
                assert!(Instant::now() < deadline, "the fake core never hung");
                std::thread::sleep(Duration::from_millis(20));
            }
            HungCore {
                _dir: dir,
                layout,
                child,
            }
        }
    }

    impl Drop for HungCore {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[test]
    fn declining_leaves_the_hung_core_running() {
        let mut core = HungCore::start();
        let runner = FakeRunner::new(core.layout.home.clone());
        let ctx = Ctx::for_host(&core.layout, &runner);
        let step =
            hung_step(&Role::core(), inspect(&core.layout, &Role::core())).expect("a hung step");
        assert_eq!(step.status, StepStatus::Planned);
        assert_eq!(step.detail.as_ref().unwrap()["pid"], json!(core.child.id()));
        let mut plan = Plan { steps: vec![step] };
        let mut s = Script {
            answers: vec![false],
            asked: vec![],
        };
        execute(&mut plan, &ctx, &mut s, false);
        assert_eq!(s.asked.len(), 1, "{:?}", s.asked);
        assert!(
            s.asked[0].starts_with("Apply unit.terminate-hung (high risk)"),
            "{:?}",
            s.asked
        );
        assert_eq!(plan.steps[0].status, StepStatus::Declined);
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            matches!(core.child.try_wait(), Ok(None)),
            "a declined step terminated the core"
        );
        assert!(core.layout.core_token().exists());
    }

    /// Cross-platform (Windows: `TerminateProcess` through the pinned handle, exit code 1).
    #[test]
    fn a_confirmed_step_terminates_the_pinned_hung_core_and_removes_its_run_files() {
        let mut core = HungCore::start();
        let runner = FakeRunner::new(core.layout.home.clone());
        let ctx = Ctx::for_host(&core.layout, &runner);
        let step =
            hung_step(&Role::core(), inspect(&core.layout, &Role::core())).expect("a hung step");
        let mut plan = Plan { steps: vec![step] };
        let mut s = Script {
            answers: vec![],
            asked: vec![],
        };
        execute(&mut plan, &ctx, &mut s, true);
        assert_eq!(
            plan.steps[0].status,
            StepStatus::Done,
            "{:?}",
            plan.steps[0]
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(st) = core.child.try_wait().unwrap() {
                break st;
            }
            assert!(Instant::now() < deadline, "the hung core is still running");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(!status.success(), "{status:?}");
        assert!(!core.layout.core_token().exists());
        assert!(!core.layout.run().join("core.pid").exists());
        let detail = plan.steps[0].detail.as_ref().unwrap();
        assert_eq!(detail["pid"], json!(core.child.id()));
    }

    #[test]
    fn a_unit_that_changed_since_the_plan_is_skipped() {
        let mut core = HungCore::start();
        let runner = FakeRunner::new(core.layout.home.clone());
        let ctx = Ctx::for_host(&core.layout, &runner);
        let mut step =
            hung_step(&Role::core(), inspect(&core.layout, &Role::core())).expect("a hung step");
        // Another instance id than the one pinned at plan time.
        step.detail.as_mut().unwrap()["instanceId"] = json!("7d3c1b0e-5a4f-4e21-9c8b-2f6a1d0e9b73");
        let mut plan = Plan { steps: vec![step] };
        let mut s = Script {
            answers: vec![],
            asked: vec![],
        };
        execute(&mut plan, &ctx, &mut s, true);
        assert_eq!(
            plan.steps[0].status,
            StepStatus::Skipped,
            "{:?}",
            plan.steps[0]
        );
        assert_eq!(
            plan.steps[0].detail.as_ref().unwrap()["reason"],
            "peer-mismatch"
        );
        assert!(matches!(core.child.try_wait(), Ok(None)));
    }
}
