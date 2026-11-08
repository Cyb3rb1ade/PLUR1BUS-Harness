//! `plur1bus-core`: the PLUR1BUS core in Rust (Phase 4, ADR-019, owner decisions D129/D131).
//!
//! P4-10 makes it the **front door**: `plur1bus-core serve` takes the core lock and the run files, starts the TypeScript core
//! behind it as `core-legacy`, listens on `run/core.sock` (or the per-home pipe), authenticates every client itself, and
//! relays every call it does not serve to the legacy core over a link that carries the client's own credentials (plan
//! §2.4). It is opt-in: `core.impl: "rust"` in `config.json`, or `PLUR1BUS_CORE_IMPL=rust`; the TypeScript core alone stays
//! the default until the flip PR.
//!
//! Modules (plan §2.1):
//! - [`server`]: the listener, framing, back-pressure and the route table;
//! - [`relay`]: the per-client links to `core-legacy`;
//! - [`route`]: the method table (native, completed, bridge, relayed) and the native dispatch;
//! - [`auth`]: the credentials, constant-time compares and the `core.auth` checks;
//! - [`lock`]: the single-instance core lock (`state/core.lock`);
//! - [`run_files`]: the run files and their modes;
//! - [`events`]: subscriptions and the front door's own `core.state`;
//! - [`lifecycle`]: process state, lifeline, drain order, timings;
//! - [`legacy`]: spawning the legacy core and its ready line;
//! - [`frame`]: NDJSON lines and error frames.
//!
//! Shared crates: `plur1bus-canon` (canonical JSON, action hash), `plur1bus-store` (SQLite conventions),
//! `plur1bus-tokens` (token counter), `plur1bus-audit` (audit chain and the core lock), `plur1bus-rpc` (types, client,
//! server half).
#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(clippy::print_stdout, clippy::print_stderr)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod auth;
pub mod cli;
pub mod events;
pub mod frame;
pub mod legacy;
pub mod lifecycle;
pub mod lock;
pub mod peek;
pub mod relay;
pub mod route;
pub mod run_files;
pub mod server;

pub use cli::{Cli, Command, ServeArgs};
pub use run_files::RunFiles;

use auth::Secret;
use lifecycle::{relock, Event, ProcessState, Timings};
use plur1bus_rpc::server_transport::Listener;
use serde_json::{json, Value};
use std::fmt;
use std::io::{self, BufReader, Write};
use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

/// What `serve` was asked to do, resolved from the arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServePlan {
    /// The run files under the resolved (absolute) home.
    pub run_files: RunFiles,
    /// Supervised mode: stdin is the lifeline the supervisor holds (`--lifeline stdin`).
    pub lifeline: bool,
    /// The instance id the supervisor assigned, lower-cased (`--instance`).
    pub instance: Option<String>,
}

/// Why `serve` could not start.
#[derive(Debug)]
pub enum ServeError {
    /// The home could not be made absolute.
    Home(io::Error),
    /// Another core holds `state/core.lock` (`E_LOCKED`, exit 3).
    Locked,
    /// Something answers on the core's address already.
    AddressInUse(String),
    /// The legacy core exited before it was ready, with this status.
    LegacyExited(ExitStatus),
    /// The legacy core kept exiting 3: an older legacy core still holds `run/core-legacy.lock` (`E_LOCKED`, exit 3); the
    /// pid `run/core-legacy.pid` names, if any (security review M4).
    LegacyLocked(Option<u32>),
    /// The legacy core could not be started or did not say it was ready properly.
    Legacy(String),
    /// Anything else that stopped the start (run files, schema, the listener).
    Start(String),
    /// A stop was requested while starting (exit with this code).
    Stopped(i32),
}

impl ServeError {
    /// The process exit code, `bin.ts`'s: 3 for a held lock; the legacy core's own 2 (configuration), 3 and 4 (engine
    /// contract); the stop's code for a stop while starting; else 1.
    pub fn exit_code(&self) -> i32 {
        match self {
            ServeError::Locked | ServeError::LegacyLocked(_) => 3,
            ServeError::LegacyExited(s) => s.code().filter(|c| (2..=4).contains(c)).unwrap_or(1),
            ServeError::Stopped(code) => *code,
            _ => 1,
        }
    }
}

impl fmt::Display for ServeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Home(e) => write!(f, "cannot resolve --home: {e}"),
            Self::Locked => write!(f, "another core holds the lock (database is locked)"),
            Self::AddressInUse(a) => write!(f, "address in use: {a}"),
            Self::LegacyExited(s) => write!(f, "the legacy core exited before it was ready ({s})"),
            Self::LegacyLocked(Some(pid)) => write!(
                f,
                "another legacy core (pid {pid}, run/core-legacy.pid) holds run/core-legacy.lock (database is locked)"
            ),
            Self::LegacyLocked(None) => write!(
                f,
                "another legacy core holds run/core-legacy.lock (database is locked); run/core-legacy.pid names none"
            ),
            Self::Legacy(e) => write!(f, "the legacy core did not start: {e}"),
            Self::Start(e) => write!(f, "start failed: {e}"),
            Self::Stopped(_) => write!(f, "stopped while starting"),
        }
    }
}

impl std::error::Error for ServeError {}

/// Resolves `serve`'s arguments: the home made absolute (against the working directory) and its run files.
pub fn plan(args: &ServeArgs) -> Result<ServePlan, ServeError> {
    let home = std::path::absolute(&args.home).map_err(ServeError::Home)?;
    Ok(ServePlan {
        run_files: RunFiles::new(&home),
        lifeline: args.lifeline.is_some(),
        instance: args.instance.clone(),
    })
}

/// How long a legacy core that exits 3 (a previous legacy core still holds `run/core-legacy.lock` while it stops) is
/// retried, on top of the stop budget.
const LEGACY_LOCK_RETRY_MARGIN: Duration = Duration::from_secs(10);
/// The margin `bin.ts` gives itself beyond the stop budget before it exits on its own.
const LEGACY_STOP_MARGIN: Duration = Duration::from_secs(5);
/// The stop reason of an orphan grace that ran out. That stop ends the legacy core's own lifeline instead of sending it
/// `core.shutdown`: its grace (0) expires at once and it takes the TypeScript core's grace-expiry path, so
/// `logs/core.log` records "orphan grace expired" as it does for a TypeScript core.
const GRACE_EXPIRED: &str = "lifeline grace expired";
/// How long the control link's handshake may take.
const CONTROL_AUTH_TIMEOUT: Duration = Duration::from_secs(30);

/// Serves the core until it is stopped; returns the process exit code. See [`lifecycle`] for the drain order.
pub fn serve(plan: &ServePlan) -> Result<i32, ServeError> {
    // Every client costs descriptors: lift launchd's 256 to the hard limit as Node does (security review M2); the legacy
    // core inherits it.
    let capacity = server::Capacity::for_open_files(plur1bus_rpc::limits::raise_open_files());
    let files = plan.run_files.clone();
    let checks = server::Checks::new().map_err(ServeError::Start)?;
    route::prepare().map_err(ServeError::Start)?;
    // Before anything is written: a home too long for the legacy core's socket (P4D-10).
    run_files::check_socket_paths(&files).map_err(ServeError::Start)?;
    run_files::prepare(&files).map_err(|e| ServeError::Start(e.to_string()))?;
    let lock = match lock::acquire(&files.lock) {
        Ok(lock) => lock,
        Err(lock::LockError::Held) => return Err(ServeError::Locked),
        Err(lock::LockError::Io(e)) => return Err(ServeError::Start(format!("core lock: {e}"))),
    };
    // Under the lock, before anything is written: what a killed front door left behind (security review L6).
    run_files::clear_leftovers(&files);
    let timings = Timings::read(&files.config);
    let (events_tx, events) = mpsc::channel::<Event>();
    lifecycle::watch_signals(events_tx.clone())
        .map_err(|e| ServeError::Start(format!("signal handlers: {e}")))?;
    let (front, listener, legacy, control) =
        match start(plan, &files, checks, timings, capacity, &events_tx, &events) {
            Ok(parts) => parts,
            Err(e) => {
                // A refused or failed start leaves no run file behind; the lock goes last.
                run_files::remove_owned(&files);
                drop(lock);
                return Err(e);
            }
        };
    // `binding` lives until the legacy core is gone: on Windows its drop would end it.
    let legacy::Legacy {
        child,
        pid: legacy_pid,
        lifeline,
        binding,
        ..
    } = legacy;
    // Ready: the state, the ready line (the TypeScript core's shape), then connections and the lifeline.
    front.set_state(ProcessState::now("ready"));
    let ready = json!({"ready": true, "address": files.address, "pid": front.pid});
    {
        let mut out = io::stdout().lock();
        let _ = writeln!(out, "{ready}").and_then(|()| out.flush());
    }
    server::log(
        "info",
        "core ready",
        json!({"instanceId": front.instance, "address": files.address, "supervised": plan.lifeline, "legacyPid": legacy_pid,
            "openFiles": capacity.open_files, "maxConnections": capacity.connections}),
    );
    {
        let f = front.clone();
        std::thread::Builder::new()
            .name("core-accept".into())
            .spawn(move || server::accept_loop(&f, &listener))
            .map_err(|e| ServeError::Start(e.to_string()))?;
    }
    if plan.lifeline {
        let f = front.clone();
        lifecycle::watch_stdin(move || f.stdin_lost());
    }
    let child = Arc::new(Mutex::new(child));
    {
        let (c, tx) = (child.clone(), events_tx.clone());
        std::thread::Builder::new()
            .name("core-legacy-wait".into())
            .spawn(move || loop {
                if let Ok(Some(_)) = relock(&c).try_wait() {
                    let _ = tx.send(Event::LegacyExited);
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            })
            .map_err(|e| ServeError::Start(e.to_string()))?;
    }
    // The main loop: the first stop request, the legacy core's exit, or the end of an orphan grace.
    let request = loop {
        match events.recv() {
            // `core.shutdownBudgetMs` is live: the budget in force when the stop begins (task review M1).
            Ok(Event::Stop {
                budget,
                why,
                ok_code,
            }) => {
                let budget = budget.unwrap_or_else(|| Timings::read(&files.config).shutdown_budget);
                break Some((budget, why, ok_code));
            }
            Ok(Event::GraceExpired(generation)) => {
                if front.grace_applies(generation) {
                    server::log("warn", "orphan grace expired, stopping", Value::Null);
                    break Some((
                        Timings::read(&files.config).shutdown_budget,
                        GRACE_EXPIRED,
                        0,
                    ));
                }
            }
            Ok(Event::LegacyExited) => {
                break lifecycle::queued_stop(&events).map(|(budget, why, ok_code)| {
                    let budget =
                        budget.unwrap_or_else(|| Timings::read(&files.config).shutdown_budget);
                    (budget, why, ok_code)
                })
            }
            Err(_) => break None,
        }
    };
    let code = stop(&front, &child, &control, lifeline, request);
    // Reaped by now (the waiter or `stop`): its record goes unless it already removed it itself (security review L5).
    legacy::forget_record(&files.legacy_pid, legacy_pid);
    binding.release();
    run_files::remove_owned(&files);
    drop(lock);
    Ok(code)
}

type Started = (Arc<server::FrontDoor>, Listener, legacy::Legacy, Control);

/// The front door's own owner link to the legacy core ([`control_link`]).
struct Control {
    link: relay::Link,
    /// Set once the link's reader has seen its end: a stop then cannot reach the legacy core through it.
    gone: Arc<AtomicBool>,
}

/// Everything between the lock and `ready`: run files, the legacy core, the control link, the listener.
#[allow(clippy::too_many_arguments)]
fn start(
    plan: &ServePlan,
    files: &RunFiles,
    checks: server::Checks,
    timings: Timings,
    capacity: server::Capacity,
    events_tx: &mpsc::Sender<Event>,
    events: &mpsc::Receiver<Event>,
) -> Result<Started, ServeError> {
    probe_address(&files.address)?;
    let fresh = || Secret::fresh().map_err(|e| ServeError::Start(e.to_string()));
    let credentials = server::Credentials {
        core: fresh()?,
        api: fresh()?,
        link: fresh()?,
    };
    let instance = plan
        .instance
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let write = |path: &std::path::Path, text: &str| {
        run_files::write_private(path, text)
            .map_err(|e| ServeError::Start(format!("{}: {e}", path.display())))
    };
    // The legacy core reads its credentials from files only it uses. run/core.token and run/api-delegation.token are
    // written once it is ready, right before the bind, as the TypeScript core writes them right before it listens: a
    // client or the API that finds them finds a core about to listen (tests/system's import maintenance relies on it).
    let legacy_credentials = Zeroizing::new(
        json!({"core": credentials.core.expose(), "api": credentials.api.expose()}).to_string(),
    );
    write(&files.legacy_credentials, &legacy_credentials)?;
    write(&files.legacy_token, credentials.link.expose())?;
    write(&files.pid, &format!("{} {instance}\n", std::process::id()))?;

    let spec = legacy::LegacySpec::from_env(&files.home, plan.lifeline);
    let retry_until = Instant::now() + timings.shutdown_budget + LEGACY_LOCK_RETRY_MARGIN;
    let mut stop_code = None;
    let mut holder_reported = false;
    let mut legacy = loop {
        let mut stop_requested = || match events.try_recv() {
            Ok(Event::Stop { ok_code, .. }) => {
                stop_code = Some(ok_code);
                true
            }
            _ => false,
        };
        match legacy::start(&spec, &instance, &files.legacy_address, &mut stop_requested) {
            Ok(legacy) => break legacy,
            Err(legacy::StartError::Exited(status))
                if status.code() == Some(3) && Instant::now() < retry_until =>
            {
                // A legacy core of the previous front door is still stopping and holds its lock: wait for it, and say
                // which one (security review M4: the lock is run/core-legacy.lock, not state/core.lock, held here).
                if !std::mem::replace(&mut holder_reported, true) {
                    let holder = legacy_holder(files);
                    server::log(
                        "warn",
                        "an older legacy core holds run/core-legacy.lock; waiting for it to stop",
                        json!({"lock": "run/core-legacy.lock", "holderPid": holder.as_ref().map(|h| h.0),
                            "holderInstance": holder.as_ref().map(|h| h.1.clone()),
                            "waitMs": u64::try_from(retry_until.saturating_duration_since(Instant::now()).as_millis()).unwrap_or(u64::MAX)}),
                    );
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            Err(legacy::StartError::Exited(status)) if status.code() == Some(3) => {
                return Err(ServeError::LegacyLocked(legacy_holder(files).map(|h| h.0)))
            }
            Err(legacy::StartError::Exited(status)) => {
                return Err(ServeError::LegacyExited(status))
            }
            Err(legacy::StartError::Stopped) => {
                return Err(ServeError::Stopped(stop_code.unwrap_or(0)))
            }
            Err(legacy::StartError::Spawn(e)) => {
                return Err(ServeError::Legacy(format!(
                    "cannot start {}: {e}",
                    spec.node.display()
                )))
            }
            Err(legacy::StartError::BadReady(e)) => return Err(ServeError::Legacy(e)),
        }
    };
    let control = match control_link(files, &credentials, legacy.pid) {
        Ok(pair) => pair,
        Err(e) => {
            legacy.kill();
            return Err(ServeError::Legacy(e));
        }
    };
    let _ = std::fs::remove_file(&files.legacy_credentials);
    let published = write(&files.token, credentials.core.expose())
        .and_then(|()| write(&files.api_token, credentials.api.expose()));
    if let Err(e) = published {
        legacy.kill();
        return Err(e);
    }
    let listener = match Listener::bind(&files.address) {
        Ok(l) => l,
        Err(e) => {
            legacy.kill();
            return Err(ServeError::Start(format!(
                "listen on {}: {e}",
                files.address
            )));
        }
    };
    let front = Arc::new(server::FrontDoor::new(
        files.clone(),
        instance,
        credentials,
        legacy.pid,
        control.1,
        checks,
        events_tx.clone(),
        plan.lifeline,
        capacity,
    ));
    Ok((front, listener, legacy, control.0))
}

/// The pid and instance `run/core-legacy.pid` records (the legacy core that holds `run/core-legacy.lock`, when another
/// one's start exits 3).
fn legacy_holder(files: &RunFiles) -> Option<(u32, String)> {
    let text = std::fs::read_to_string(&files.legacy_pid).ok()?;
    let mut fields = text.split_whitespace();
    let pid = fields.next()?.parse().ok()?;
    Some((pid, fields.next().unwrap_or_default().to_owned()))
}

/// The stale-socket probe (POSIX): a socket file nobody answers on is removed; one that answers refuses the start, as
/// the TypeScript server's `listen()` does. On Windows the first pipe instance flag refuses a taken name at bind.
fn probe_address(address: &str) -> Result<(), ServeError> {
    #[cfg(unix)]
    {
        let path = std::path::Path::new(address);
        if path.symlink_metadata().is_ok() {
            if std::os::unix::net::UnixStream::connect(path).is_ok() {
                return Err(ServeError::AddressInUse(address.to_owned()));
            }
            std::fs::remove_file(path)
                .map_err(|e| ServeError::Start(format!("stale socket {address}: {e}")))?;
        }
    }
    let _ = address;
    Ok(())
}

/// The front door's own owner link to the legacy core: its handshake gives the engine `contract` the front door
/// reports, and `core.shutdown` goes over it at stop. Everything else arriving on it is read and dropped.
fn control_link(
    files: &RunFiles,
    credentials: &server::Credentials,
    legacy_pid: u32,
) -> Result<(Control, String), String> {
    let (link, reader) = relay::Link::connect(&files.legacy_address, legacy_pid)
        .map_err(|e| format!("cannot connect to the legacy core: {e}"))?;
    let id = link.next_id();
    let hello = json!({"jsonrpc":"2.0","id": id,"method":"core.auth","params":{
        "token": credentials.core.expose(),
        "frontDoor": {"token": credentials.link.expose(), "caller": "owner"},
    }});
    reader
        .set_read_timeout(Some(CONTROL_AUTH_TIMEOUT))
        .map_err(|e| e.to_string())?;
    link.send(&frame::encode(&hello))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(reader);
    let reply = match frame::read_line(&mut reader) {
        Ok(frame::Line::Data(bytes)) => {
            serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())?
        }
        _ => return Err("the legacy core closed the control link".into()),
    };
    let contract = reply
        .pointer("/result/contract")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            let reason = reply
                .pointer("/error/data/reason")
                .and_then(Value::as_str)
                .unwrap_or("no result");
            format!("the legacy core refused the control link ({reason})")
        })?
        .to_owned();
    reader
        .get_ref()
        .set_read_timeout(None)
        .map_err(|e| e.to_string())?;
    let gone = Arc::new(AtomicBool::new(false));
    let ended = gone.clone();
    std::thread::Builder::new()
        .name("core-control".into())
        .spawn(move || {
            while let Ok(frame::Line::Data(_)) = frame::read_line(&mut reader) {}
            ended.store(true, Ordering::SeqCst);
        })
        .map_err(|e| e.to_string())?;
    Ok((Control { link, gone }, contract))
}

/// The stop (ADR-012 §3, see [`lifecycle`]). `request` is `None` when the legacy core exited on its own.
fn stop(
    front: &Arc<server::FrontDoor>,
    child: &Arc<Mutex<Child>>,
    control: &Control,
    mut lifeline: Option<std::process::ChildStdin>,
    request: Option<(Duration, &'static str, i32)>,
) -> i32 {
    let (budget, why, ok_code) = request.unwrap_or((Duration::ZERO, "the legacy core exited", 1));
    server::log(
        "info",
        "core stopping",
        json!({"why": why, "budgetMs": u64::try_from(budget.as_millis()).unwrap_or(u64::MAX)}),
    );
    // Already `stopping` when an accepted `core.shutdown` began the stop (the state went out before its answer).
    front.enter_stopping();
    let mut failed = request.is_none();
    if request.is_some() && why == GRACE_EXPIRED {
        drop(lifeline.take());
    } else if request.is_some() {
        let budget_ms = u64::try_from(budget.as_millis())
            .unwrap_or(u64::MAX)
            .min(120_000);
        let shutdown = json!({"jsonrpc":"2.0","id": control.link.next_id(),"method":"core.shutdown","params":{"budgetMs": budget_ms}});
        // A link whose end was read may still take a write (the peer's reset comes later): its flag decides first.
        let sent = !control.gone.load(Ordering::SeqCst)
            && control.link.send(&frame::encode(&shutdown)).is_ok();
        if !sent {
            // Task review L1: nothing else would tell the legacy core to stop before it is killed without a drain at the
            // end of the budget; its lifeline does (no grace behind a front door).
            server::log(
                "warn",
                "the control link is gone; the legacy core stops on its lifeline",
                Value::Null,
            );
            drop(lifeline.take());
        }
    }
    let status = legacy::wait_until(child, Instant::now() + budget + LEGACY_STOP_MARGIN);
    let code = match status {
        Some(s) => {
            server::log("info", "the legacy core exited", json!({"code": s.code()}));
            match s.code() {
                Some(0 | 130) if request.is_some() => None,
                Some(c @ (2 | 4)) if request.is_none() => Some(c),
                _ => Some(1),
            }
        }
        None => {
            server::log(
                "warn",
                "the legacy core did not stop in time, killing it",
                Value::Null,
            );
            let mut c = relock(child);
            let _ = c.kill();
            let _ = c.wait();
            Some(1)
        }
    };
    if code.is_some() {
        failed = true;
    }
    drop(lifeline);
    control.link.close();
    front.close_connections(Duration::from_secs(1));
    // The writers flush what is queued; a peer that never reads is destroyed after the grace.
    let flushed = Instant::now() + Duration::from_millis(1200);
    while front.open_connections() > 0 && Instant::now() < flushed {
        std::thread::sleep(Duration::from_millis(20));
    }
    server::log("info", "core stopped", json!({"failed": failed}));
    match code {
        Some(c) => c,
        None => ok_code,
    }
}
