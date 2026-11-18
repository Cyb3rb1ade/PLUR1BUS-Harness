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
//! - [`control`]: the front door's own link to `core-legacy` (its handshake, the stop, and since P4-12 flip A2 the
//!   `legacy.*` calls of `docs/phase4/bridge.md`);
//! - [`route`]: the method table (native, completed, bridge, relayed) and the native dispatch;
//! - [`auth`]: the credentials, constant-time compares and the `core.auth` checks;
//! - [`lock`]: the single-instance core lock (`state/core.lock`);
//! - [`run_files`]: the run files and their modes;
//! - [`events`]: subscriptions and the front door's own `core.state`;
//! - [`lifecycle`]: process state, lifeline, drain order, timings;
//! - [`legacy`]: spawning the legacy core and its ready line;
//! - [`frame`]: NDJSON lines and error frames;
//! - [`front_log`]: the front door's own lines in `logs/core.log`, at the configuration's level and rotation (P4D-7);
//! - [`native`]: the RBAC guard in front of every native method and the stores they read and write (P4-12 flip A1: the
//!   first two methods, for the owner connection; flip A2: a person's role and status).
//!
//! Library modules of P4-11 (configuration, logs, doctor, metrics). The running front door uses the log writer and
//! the configuration source for its own lines ([`front_log`]); the P4-11 flip moves `logs.*` and `doctor.*` into the
//! native method set.
//! - [`logs`]: the D111 log writer, sink, redaction surface, query and the `logs.*` handlers;
//! - [`config`]: loading and validating config.json, warnings, the disclosure policy, the engine configuration and the
//!   configuration source (supervisor watch or file);
//! - [`metrics`]: the metrics registry, the core's metrics, the metrics token and the loopback `GET /metrics` endpoint;
//! - [`doctor`]: the doctor report.
//!
//! Library modules of P4-12. The running front door uses the guard, the admin store and the identity service for its
//! native methods ([`native`]); everything else waits for its flip:
//! - [`rbac`]: the RBAC decision (policy table, `authorize`, `can_see`, surface trust levels), replayed against the vectors
//!   recorded from the TypeScript policy (R10: one security decision, two implementations); the rule table of the RPC
//!   methods and the guard's decision; the break-glass registry; the audit line of `logs/audit.log`;
//! - [`identity`]: humans, linked channel identities and pairing (`state/identity.sqlite`), role presets, agent rights and
//!   invitations (`state/admin.sqlite`), desktop attach (`state/desktop-attach.db`), the back-fill and its engine port;
//! - [`exposure`]: memory exposure per channel and principal, the sensitivity scanner, and the card sensitivity store and
//!   service (`state/memory-sensitivity.sqlite`);
//! - [`js`]: the JavaScript semantics the ported code depends on (UTF-16 lengths, `trim`, case mapping, `JSON.stringify`).
//!
//! Library module of P4-20 (nothing calls it yet): [`secrets`], the rules for a secret's name, value and description, the
//! backend trait and the in-memory backend, the lease table, and the pure parts of the secret audit.
//!
//! Shared crates: `plur1bus-canon` (canonical JSON, action hash), `plur1bus-store` (SQLite conventions),
//! `plur1bus-tokens` (token counter), `plur1bus-audit` (audit chain and the core lock), `plur1bus-rpc` (types, client,
//! server half).
#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(clippy::print_stdout, clippy::print_stderr)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod approvals;
pub mod attestation;
pub mod audit;
pub mod auth;
pub mod bridge;
pub mod budget;
pub mod cli;
pub mod config;
pub mod control;
pub mod delivery;
pub mod doctor;
pub mod egress;
pub mod events;
pub mod exposure;
pub mod frame;
pub mod front_log;
pub mod grants;
pub mod handoff;
pub mod home_path;
pub mod identity;
pub mod inbox;
pub mod js;
pub mod legacy;
pub mod lifecycle;
pub mod lock;
pub mod logs;
pub mod metrics;
pub mod native;
pub mod peek;
pub mod policy;
mod private_store;
pub mod provider_auth;
pub mod rbac;
pub mod redaction_mirror;
pub mod relay;
pub mod route;
pub mod run_files;
pub mod secrets;
pub mod secrets_owner;
pub mod server;
pub mod toolcall;

pub use cli::{Cli, Command, ServeArgs};
pub use run_files::RunFiles;

use auth::Secret;
use lifecycle::{relock, Event, ProcessState, Timings};
use plur1bus_rpc::server_transport::Listener;
use serde_json::{json, Value};
use std::fmt;
use std::io::{self, Write};
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

/// Resolves `serve`'s arguments: the home in the form the TypeScript core gives it ([`home_path`]: absolute against the
/// working directory, normalized as text) and its run files.
pub fn plan(args: &ServeArgs) -> Result<ServePlan, ServeError> {
    let home = home_path::resolve_here(&args.home).map_err(ServeError::Home)?;
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
    // Something answers on the address (a squatter, a fixture that takes no lock): refused before this start touches a
    // run file, so whatever answers keeps its files and socket (final review FR-M1; the TypeScript core's `wroteRunFiles`).
    probe_address(&files.address)?;
    // Under the lock, before anything is written: what a killed front door left behind (security review L6), its legacy
    // core's record included unless that is still alive (final review FR-M2: then it is the holder named below).
    let older_legacy = run_files::clear_leftovers(&files);
    // From here on the front door's lines go to `logs/core.log` as well (P4D-7); the guard withdraws that on every
    // way out, after the last line.
    // The secret values this process masks (P4-20 flip A): the mirror fills the set from the legacy core's registry;
    // the front door's own lines and the records of a native `logs.query` are masked with it.
    let mirror = Arc::new(redaction_mirror::RedactionMirror::new(Arc::new(
        logs::redact::SecretSet::new(),
    )));
    // `secrets.fileFallback.enabled` for a store this process may own (P4-20 flip B1): what config.json says now, then
    // whatever the log's configuration source reads.
    let file_fallback = Arc::new(AtomicBool::new(secrets_owner::file_fallback_on_disk(
        &files.config,
    )));
    let fallback_observer: front_log::ConfigObserver = {
        let flag = file_fallback.clone();
        Arc::new(move |config: &Value| {
            flag.store(secrets_owner::file_fallback_in(config), Ordering::SeqCst);
        })
    };
    let _front_log = FrontLogGuard::install(front_log::FrontLog::open_masking(
        &files,
        front_log::Follow {
            supervised: plan.lifeline,
            file_poll: None,
            observer: Some(fallback_observer),
        },
        Arc::new(mirror.set().redactor(false, false)),
    ));
    let timings = Timings::read(&files.config);
    let (events_tx, events) = mpsc::channel::<Event>();
    lifecycle::watch_signals(events_tx.clone())
        .map_err(|e| ServeError::Start(format!("signal handlers: {e}")))?;
    let mut attempt = Attempt {
        written: Vec::new(),
        older_legacy,
        redaction: mirror.set().clone(),
        file_fallback,
    };
    let (front, listener, legacy, control, secrets) = match start(
        plan,
        &files,
        checks,
        timings,
        capacity,
        (&events_tx, &events),
        &mut attempt,
    ) {
        Ok(parts) => parts,
        Err(e) => {
            // A failed start removes what it wrote and nothing else (an earlier core's stale tokens stay, as the
            // TypeScript core leaves them; final review FR-M1); the lock goes last.
            for path in &attempt.written {
                let _ = std::fs::remove_file(path);
            }
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
    // The legacy core's redaction registry, before anybody is served (P4-20 flip A; the listener is bound, nobody accepts
    // yet): asked until nothing is waiting. When that fails the front door serves all the same; `logs.query` then goes
    // to the legacy core until the mirror is in step.
    mirror.set_source(control.clone());
    if let Err(code) = mirror.catch_up(redaction_mirror::START_WAIT) {
        server::log(
            "warn",
            "the redaction mirror is not in step; logs.query is relayed",
            json!({ "code": code }),
        );
    }
    follow_redaction(&mirror, &control);
    front.set_redaction(mirror.clone());
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
    // The legacy core is gone: nobody calls the bridge any more. The store is closed and its helpers end.
    drop(secrets);
    // Reaped by now (the waiter or `stop`): its record goes unless it already removed it itself (security review L5).
    legacy::forget_record(&files.legacy_pid, legacy_pid);
    binding.release();
    run_files::remove_owned(&files);
    drop(lock);
    Ok(code)
}

/// The front door's log, installed for [`server::log`] while it lives; dropping it withdraws and closes the log.
struct FrontLogGuard(Option<Arc<front_log::FrontLog>>);

impl FrontLogGuard {
    fn install(log: Option<front_log::FrontLog>) -> FrontLogGuard {
        let log = log.map(Arc::new);
        server::set_front_log(log.clone());
        FrontLogGuard(log)
    }
}

impl Drop for FrontLogGuard {
    fn drop(&mut self) {
        server::set_front_log(None);
        if let Some(log) = self.0.take() {
            log.close();
        }
    }
}

type Started = (
    Arc<server::FrontDoor>,
    Listener,
    legacy::Legacy,
    Arc<control::Control>,
    Option<secrets_owner::OwnedSecrets>,
);

/// What one start knows besides its plan: the run files it has written ([`start`]) and the record of an older legacy core
/// that was still alive at start ([`run_files::clear_leftovers`]).
struct Attempt {
    written: Vec<std::path::PathBuf>,
    older_legacy: Option<String>,
    /// The registry this process masks with; a store the front door owns registers its values there.
    redaction: Arc<logs::redact::SecretSet>,
    /// `secrets.fileFallback.enabled`, kept current by the log's configuration source.
    file_fallback: Arc<AtomicBool>,
}

/// Everything between the lock and `ready`: run files, the legacy core, the control link, the listener.
///
/// Starts the legacy core and binds the address; every run file it writes goes into `attempt.written` first, so a failed
/// start removes exactly those (the bound socket never needs it: nothing can fail after the bind).
#[allow(clippy::too_many_arguments)]
/// The thread that keeps the redaction mirror in step for as long as the control link lives.
fn follow_redaction(
    mirror: &Arc<redaction_mirror::RedactionMirror>,
    control: &Arc<control::Control>,
) {
    let (mirror, control) = (mirror.clone(), control.clone());
    let spawned = std::thread::Builder::new()
        .name("core-redaction".into())
        .spawn(move || {
            mirror.follow(&|| control.gone.load(Ordering::SeqCst), &|code| {
                server::log(
                    "warn",
                    "the redaction mirror missed a call; logs.query is relayed until it is in step",
                    json!({ "code": code }),
                );
            });
        });
    if spawned.is_err() {
        server::log(
            "warn",
            "the redaction mirror has no thread; it is brought in step by each logs.query",
            Value::Null,
        );
    }
}

fn start(
    plan: &ServePlan,
    files: &RunFiles,
    checks: server::Checks,
    timings: Timings,
    capacity: server::Capacity,
    (events_tx, events): (&mpsc::Sender<Event>, &mpsc::Receiver<Event>),
    attempt: &mut Attempt,
) -> Result<Started, ServeError> {
    let Attempt {
        written,
        older_legacy,
        redaction,
        file_fallback,
    } = attempt;
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
    // Recorded once it is in place: a write that failed left the file at that path as it was (its temporary is removed).
    let mut write = |path: &std::path::Path, text: &str| {
        run_files::write_private(path, text)
            .map(|()| written.push(path.to_owned()))
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

    // Who owns the secret store of this run (P4-20 flip B1). The front door, unless a test's switch or a macOS
    // keychain whose items still belong to `node` says otherwise; then nothing changes for the legacy core. A keyring
    // seam or a switch this process may not use stops the start: it must never go on with another keyring, or with
    // none, than the one its environment names.
    let keyring = secrets_owner::keyring_choice_of_the_front_door()
        .map_err(|refused| ServeError::Start(refused.0))?;
    let secrets = match secrets_owner::decide_for(files, &keyring).map_err(ServeError::Start)? {
        secrets_owner::Owner::FrontDoor => Some(
            secrets_owner::OwnedSecrets::open(
                files,
                keyring,
                redaction.clone(),
                file_fallback.clone(),
                &credentials.link,
                &instance,
            )
            .map_err(|e| ServeError::Start(format!("the secret store: {e}")))?,
        ),
        secrets_owner::Owner::Legacy(why) => {
            server::log(
                "info",
                "the secret store stays with the legacy core",
                json!({ "why": why }),
            );
            None
        }
    };
    let mut spec = legacy::LegacySpec::from_env(&files.home, plan.lifeline);
    spec.secrets_at_front_door = secrets.is_some();
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
                    let holder = legacy_holder(files, older_legacy.as_deref());
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
                return Err(ServeError::LegacyLocked(
                    legacy_holder(files, older_legacy.as_deref()).map(|h| h.0),
                ))
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
    let control = match control::connect(files, &credentials, legacy.pid) {
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
    // Started for an import maintenance (R-20-34): the legacy core, which inherited the variable, holds its methods
    // until the job releases them, and the front door must not answer one it would have held. Read once, before a
    // client is accepted; this process relays every native method until it is started again.
    if native::import_maintenance_named(std::env::var_os(native::IMPORT_MAINTENANCE).as_deref()) {
        front.hold_for_import_maintenance();
        server::log(
            "info",
            "started for an import maintenance: every native method is relayed until the next start",
            Value::Null,
        );
    }
    // What a native write asks of the legacy core afterwards goes over the control link (P4-12 flip A2).
    front.set_legacy(control.0.clone());
    // The `secret.*` methods are native from here on, while this process owns the store (P4-20 flip B2).
    if let Some(owned) = &secrets {
        front.set_secrets(owned.store.clone());
    }
    Ok((front, listener, legacy, control.0, secrets))
}

/// The pid and instance `run/core-legacy.pid` records (the legacy core that holds `run/core-legacy.lock`, when another
/// one's start exits 3), or else `older`, the live record the start cleared ([`run_files::clear_leftovers`]).
fn legacy_holder(files: &RunFiles, older: Option<&str>) -> Option<(u32, String)> {
    let text = std::fs::read_to_string(&files.legacy_pid)
        .ok()
        .or_else(|| older.map(str::to_owned))?;
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

/// The stop (ADR-012 §3, see [`lifecycle`]). `request` is `None` when the legacy core exited on its own.
fn stop(
    front: &Arc<server::FrontDoor>,
    child: &Arc<Mutex<Child>>,
    control: &control::Control,
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
