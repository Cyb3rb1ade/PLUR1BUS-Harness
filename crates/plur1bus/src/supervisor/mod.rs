//! Supervisor: process lifecycle for the core (and, later, modules).
//!
//! `state` is the pure state machine (health, backoff, crash classification) with no I/O. `server` is the
//! supervisor's RPC endpoint, `logfile` the size-rotated log files. [`run`] is `plur1bus supervise`: it claims the
//! home (single instance), writes `run/supervisor.token` and `run/supervisor.pid`, serves `supervisor.auth` and
//! `daemon.*`, spawns and monitors the core (`child`), and stops on `daemon.stop` or SIGTERM/SIGINT (the core first).
#![allow(dead_code)]
pub mod child;
pub mod logfile;
pub mod server;
pub mod state;

use crate::paths::{supervisor_address, Layout};
use logfile::RotatingFile;
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Map, Value};
use state::{Backoff, ChildState};
use std::fs;
use std::io::{self, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// `capabilities.features` of the supervisor's hello.
pub const SUPERVISOR_FEATURES: &[&str] = &["adoption", "lifelines"];

/// Budget for stopping the children when `daemon.stop` names none, and on SIGTERM/SIGINT.
pub const DEFAULT_STOP_BUDGET: Duration = Duration::from_secs(10);

/// Exit code of a supervisor thread that panicked (spec §4: a panic is a bug; the OS restarts the supervisor).
pub const EXIT_PANIC: i32 = 70;

#[derive(Debug, Clone, Default)]
pub struct SuperviseOpts {
    /// Test seam: serve the endpoint but never spawn or adopt a child. Needs `PLUR1BUS_ALLOW_TEST_INTERNALS=1`.
    pub no_core: bool,
}

/// `supervisor.*` and `logs.*` from `config.json`, read once at start (S15).
#[derive(Debug, Clone, PartialEq)]
pub struct SupervisorConfig {
    pub grace_ms: u64,
    pub health_interval_ms: u64,
    pub log_max_bytes: u64,
    pub log_keep: u32,
}

/// What currently keeps the supervised core's lifeline (S4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lifeline {
    /// No child, or the child's lifeline is gone (it is orphaned or has exited).
    None,
    /// A child this supervisor spawned: the supervisor holds the only write end of its stdin.
    Stdin,
    /// An adopted child: the authenticated connection on which `core.adopt` succeeded (Task 7).
    Connection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopSource {
    /// `daemon.stop`.
    Rpc,
    /// SIGTERM or SIGINT (unix), with the signal number.
    Signal(i32),
}

/// A stop in progress: set once, never cleared (the supervisor exits at the end of it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopRequest {
    /// How long the children get to shut down (`daemon.stop { budgetMs }`).
    pub budget: Duration,
    pub source: StopSource,
    pub requested_at: Instant,
}

/// The supervisor's mutable state (ruling H3-R2), behind [`Shared::state`]. Task 6 fills `child`.
#[derive(Debug)]
pub struct SupervisorState {
    /// Fresh UUID per supervisor start; also in `run/supervisor.pid` and the hello.
    pub instance_id: String,
    pub pid: u32,
    /// Monotonic start, for `uptimeMs`.
    pub started: Instant,
    /// Wall-clock start (epoch ms), reported as the supervisor's `process.since`.
    pub started_at_ms: u64,
    /// `--no-core`: never spawn or adopt; `daemon.start` answers `E_NOT_AVAILABLE reason=no-children`.
    pub no_core: bool,
    /// `PLUR1BUS_SUPERVISOR_TIME_SCALE` (1.0 unless the test seam sets it): multiplies every supervisor duration.
    pub time_scale: f64,
    pub config: SupervisorConfig,
    /// The core, once spawned or adopted. Its `health` carries the crash reason (`Health::Crashed { reason }`) and
    /// `last_exit` the last exit with its reason; `adopted` says whether it was adopted (S19).
    pub child: Option<ChildState>,
    /// The core's lifeline source; `Lifeline::None` while there is no child.
    pub lifeline: Lifeline,
    /// Set by `daemon.stop` or a signal; the main thread then stops the children and exits 0.
    pub stopping: Option<StopRequest>,
    /// The core's restart backoff (spec §6.4); `daemon.start` resets it.
    pub backoff: Backoff,
    /// When the main thread's scheduler respawns the core; set by an exit that the backoff allows to retry.
    pub restart_at: Option<Instant>,
    /// `daemon.start` asked for an immediate spawn (a no-op while the core is running).
    pub start_requested: bool,
}

impl SupervisorState {
    /// The `daemon.status` result.
    pub fn status_json(&self) -> Value {
        let process = match self.stopping {
            Some(_) => json!({ "state": "stopping", "since": self.started_at_ms }),
            None => json!({ "state": "ready", "since": self.started_at_ms }),
        };
        json!({
            "supervisor": {
                "process": process,
                "instanceId": self.instance_id,
                "pid": self.pid,
                "uptimeMs": self.started.elapsed().as_millis() as u64,
            },
            "children": self.child.iter().map(ChildState::to_json).collect::<Vec<_>>(),
        })
    }
}

/// State shared by every supervisor thread (S14): one mutex, one condvar that wakes the main thread (a stop, a
/// scheduled restart, `daemon.start`), and the log.
pub struct Shared {
    pub state: Mutex<SupervisorState>,
    pub wake: Condvar,
    pub log: Log,
}

impl Shared {
    /// Locks the state. A poisoned mutex is still used: a panicking thread takes the whole process down (exit 70).
    pub fn lock(&self) -> MutexGuard<'_, SupervisorState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Starts a stop unless one is already running; returns whether this call started it.
    pub fn request_stop(&self, budget: Duration, source: StopSource) -> bool {
        let mut st = self.lock();
        if st.stopping.is_some() {
            return false;
        }
        st.stopping = Some(StopRequest {
            budget,
            source,
            requested_at: Instant::now(),
        });
        self.wake.notify_all();
        true
    }
}

/// `logs/supervisor.log`: JSON lines `{ at, level, role: "supervisor", …fields, msg }` like the core's logger. A log
/// failure never reaches the caller: the line is dropped.
pub struct Log {
    file: Mutex<Option<RotatingFile>>,
}

impl Log {
    pub fn open(path: &Path, max_bytes: u64, keep: u32) -> Self {
        Self {
            file: Mutex::new(RotatingFile::open(path, max_bytes, keep).ok()),
        }
    }
    /// A log that writes nowhere (before `logs/` exists).
    pub fn none() -> Self {
        Self {
            file: Mutex::new(None),
        }
    }
    pub fn write(&self, level: &str, msg: &str, fields: Value) {
        let mut rec = Map::new();
        rec.insert("at".into(), json!(iso8601(now_ms())));
        rec.insert("level".into(), json!(level));
        rec.insert("role".into(), json!("supervisor"));
        if let Value::Object(f) = fields {
            rec.extend(f);
        }
        rec.insert("msg".into(), json!(msg));
        let mut line = Value::Object(rec).to_string();
        line.push('\n');
        let mut file = self.file.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(f) = file.as_mut() {
            let _ = f.write_all(line.as_bytes()).and_then(|_| f.flush());
        }
    }
    pub fn info(&self, msg: &str, fields: Value) {
        self.write("info", msg, fields)
    }
    pub fn warn(&self, msg: &str, fields: Value) {
        self.write("warn", msg, fields)
    }
    pub fn error(&self, msg: &str, fields: Value) {
        self.write("error", msg, fields)
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` for an epoch-ms instant (the format of JavaScript's `toISOString`).
fn iso8601(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        ms % 1000
    )
}

/// Runs `f` on a new named thread. A panic in it is logged and ends the process with [`EXIT_PANIC`].
pub fn spawn_guarded<F>(shared: &Arc<Shared>, name: &str, f: F) -> io::Result<()>
where
    F: FnOnce() + Send + 'static,
{
    let shared = shared.clone();
    let thread = name.to_string();
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            if let Err(p) = catch_unwind(AssertUnwindSafe(f)) {
                die_of_panic(&shared.log, &thread, p.as_ref());
            }
        })
        .map(drop)
}

fn die_of_panic(log: &Log, thread: &str, p: &(dyn std::any::Any + Send)) -> ! {
    let panic = p
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into());
    log.error(
        "thread panicked",
        json!({ "thread": thread, "panic": panic }),
    );
    std::process::exit(EXIT_PANIC)
}

fn allow_test_internals() -> bool {
    std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Ok("1")
}

/// Largest accepted `PLUR1BUS_SUPERVISOR_TIME_SCALE`.
pub const MAX_TIME_SCALE: f64 = 1000.0;

/// Parses `PLUR1BUS_SUPERVISOR_TIME_SCALE`. Unset → 1.0. A value that is not a finite number above 0 is refused,
/// because every duration is multiplied by it (and `Backoff::new` requires a positive finite scale).
pub fn parse_time_scale(raw: Option<&str>) -> Result<f64, String> {
    let Some(raw) = raw else { return Ok(1.0) };
    match raw.trim().parse::<f64>() {
        // The upper bound keeps every scaled duration far from Duration::from_secs_f64's overflow panic.
        Ok(v) if v.is_finite() && v > 0.0 && v <= MAX_TIME_SCALE => Ok(v),
        _ => Err(format!(
            "PLUR1BUS_SUPERVISOR_TIME_SCALE must be a number above 0 and at most {MAX_TIME_SCALE}, got {raw:?}"
        )),
    }
}

/// Reads `supervisor.*` and `logs.*`. The supervisor never writes `config.json` (S15): a missing file means the
/// defaults, and an unreadable or invalid one means the defaults plus a warning in the returned string.
fn read_config(layout: &Layout) -> (SupervisorConfig, Option<String>) {
    let path = layout.config_path();
    let (config, warning) = if path.exists() {
        match plur1bus_config::load(&path) {
            Ok(l) => (l.config, None),
            Err(e) => (plur1bus_config::defaults(), Some(e.to_string())),
        }
    } else {
        (plur1bus_config::defaults(), None)
    };
    let num =
        |section: &str, key: &str, fallback: u64| config[section][key].as_u64().unwrap_or(fallback);
    (
        SupervisorConfig {
            grace_ms: num("supervisor", "graceMs", 60_000),
            health_interval_ms: num("supervisor", "healthIntervalMs", 5_000),
            log_max_bytes: num("logs", "maxBytes", 20 * 1024 * 1024),
            log_keep: num("logs", "keep", 5).clamp(1, u32::MAX as u64) as u32,
        },
        warning,
    )
}

fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "posix"
    }
}

/// The token in `run/supervisor.token`, when it is there and well formed.
fn read_token(layout: &Layout) -> Option<String> {
    let t = fs::read_to_string(layout.supervisor_token()).ok()?;
    let t = t.trim().to_string();
    (t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit())).then_some(t)
}

/// Connects to `address` and authenticates with the token from the file (300 ms connect and handshake). Returns the
/// answering supervisor's pid.
fn probe(layout: &Layout, address: &str) -> Option<u64> {
    let token = read_token(layout)?;
    let opts = ConnectOptions {
        connect_timeout: Duration::from_millis(300),
        call_timeout: Duration::from_millis(300),
        endpoint: Endpoint::Supervisor,
    };
    let client = Client::connect(address, &token, opts).ok()?;
    client.hello()["pid"].as_u64()
}

/// The pid in `run/supervisor.pid` (`<pid> <instanceId>`), if any.
fn pid_from_file(layout: &Layout) -> Option<u64> {
    fs::read_to_string(layout.supervisor_pid())
        .ok()?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

/// 32 random bytes as lower-case hex (S3).
fn fresh_token() -> io::Result<String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// Writes `content` to `path` through a temporary file and a rename, so a reader (the core's `core.adopt`) never
/// sees a half-written file. Mode `0600` on unix; the Windows ACL comes with Task 10.
fn write_private(path: &Path, content: &str) -> io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(&tmp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    f.write_all(content.as_bytes())?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, path)
}

fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn fail(code: i32, msg: &str) -> ! {
    eprintln!("plur1bus supervise: {msg}");
    std::process::exit(code)
}

/// `plur1bus supervise`. Never returns: exits 0 after a stop, 2 on a usage error, 3 when another supervisor owns
/// the home, 1 when the endpoint cannot be set up, 70 after a panic.
pub fn run(layout: &Layout, opts: SuperviseOpts) -> ! {
    match catch_unwind(AssertUnwindSafe(|| run_inner(layout, opts))) {
        Ok(code) => std::process::exit(code),
        Err(p) => {
            // The shared log went down with the panicking frame; append the one line that matters through a new one.
            let log = Log::open(&layout.log_file("supervisor"), u64::MAX, 1);
            die_of_panic(&log, "main", p.as_ref())
        }
    }
}

/// Everything up to the stop; returns the exit code (usage and set-up failures exit directly through `fail`).
fn run_inner(layout: &Layout, opts: SuperviseOpts) -> i32 {
    let allow = allow_test_internals();
    if opts.no_core && !allow {
        fail(2, "--no-core requires PLUR1BUS_ALLOW_TEST_INTERNALS=1");
    }
    let time_scale = if allow {
        let raw = std::env::var("PLUR1BUS_SUPERVISOR_TIME_SCALE").ok();
        parse_time_scale(raw.as_deref()).unwrap_or_else(|e| fail(2, &e))
    } else {
        1.0
    };

    if let Err(e) =
        create_private_dir(&layout.run()).and_then(|_| fs::create_dir_all(layout.logs()))
    {
        fail(
            1,
            &format!(
                "cannot create run/ and logs/ under {}: {e}",
                layout.home.display()
            ),
        );
    }
    let address = supervisor_address(&layout.home, platform());

    // Single instance: an exclusive lock on run/supervisor.lock, held until the process ends (the OS drops it
    // even after a SIGKILL). The file is never removed, so two starters always lock the same inode. Rust opens it
    // close-on-exec / non-inheritable, so a spawned core never holds it.
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(layout.supervisor_lock())
        .unwrap_or_else(|e| {
            fail(
                1,
                &format!("cannot open {}: {e}", layout.supervisor_lock().display()),
            )
        });
    if let Err(e) = lock.try_lock() {
        match e {
            fs::TryLockError::WouldBlock => already_running(layout, &address),
            fs::TryLockError::Error(e) => fail(
                1,
                &format!("cannot lock {}: {e}", layout.supervisor_lock().display()),
            ),
        }
    }
    // A supervisor that predates the lock, or a squatter, still answers here; a dead socket is removed.
    if let Some(pid) = probe(layout, &address) {
        fail(3, &format!("supervisor already running (pid {pid})"));
    }
    #[cfg(unix)]
    if Path::new(&address).exists() {
        let _ = fs::remove_file(&address);
    }

    let (config, config_warning) = read_config(layout);
    let log = Log::open(
        &layout.log_file("supervisor"),
        config.log_max_bytes,
        config.log_keep,
    );
    if let Some(w) = config_warning {
        log.warn(
            "config.json unreadable, using defaults",
            json!({ "detail": w }),
        );
    }

    let instance_id = uuid::Uuid::new_v4().to_string();
    let pid = std::process::id();
    let token = fresh_token().unwrap_or_else(|e| fail(1, &format!("cannot generate a token: {e}")));
    if let Err(e) = write_private(&layout.supervisor_token(), &token)
        .and_then(|_| write_private(&layout.supervisor_pid(), &format!("{pid} {instance_id}\n")))
    {
        fail(1, &format!("cannot write the run files: {e}"));
    }

    let shared = Arc::new(Shared {
        state: Mutex::new(SupervisorState {
            instance_id: instance_id.clone(),
            pid,
            started: Instant::now(),
            started_at_ms: now_ms(),
            no_core: opts.no_core,
            time_scale,
            config,
            child: None,
            lifeline: Lifeline::None,
            stopping: None,
            backoff: Backoff::new(time_scale),
            restart_at: None,
            start_requested: false,
        }),
        wake: Condvar::new(),
        log,
    });

    // Before the bind: from here on a SIGTERM takes the clean-stop path (the main loop below removes the files).
    #[cfg(unix)]
    watch_signals(&shared);
    let server = match server::SupervisorServer::bind(layout, &token) {
        Ok(s) => s,
        Err(e) => {
            shared.log.error(
                "bind failed",
                json!({ "address": address, "err": e.to_string() }),
            );
            remove_run_files(layout);
            fail(1, &format!("cannot listen on {address}: {e}"));
        }
    };
    {
        let shared2 = shared.clone();
        spawn_guarded(&shared, "accept", move || server.serve(shared2))
            .unwrap_or_else(|e| fail(1, &format!("cannot start the accept thread: {e}")));
    }
    shared.log.info(
        "supervisor ready",
        json!({ "pid": pid, "instanceId": instance_id, "address": address, "noCore": opts.no_core, "timeScale": time_scale }),
    );

    // Built lazily: when core.js is missing the supervisor stays up with a fatal child (H3-R11), and `daemon.start`
    // tries again.
    let mut monitor: Option<child::Monitor> = None;
    let spawn_core = |monitor: &mut Option<child::Monitor>| match monitor {
        Some(m) => m.spawn(),
        None => match child::core_spec(layout, &uuid::Uuid::new_v4().to_string()) {
            Ok(spec) => *monitor = Some(child::Monitor::start(shared.clone(), layout, spec)),
            Err(e) => child::mark_unspawnable(&shared, "core", &e),
        },
    };
    if !opts.no_core {
        spawn_core(&mut monitor);
    }

    // Main thread: the restart scheduler (a due `restart_at`, `daemon.start`) until a stop.
    let stop = loop {
        let spawn = {
            let mut st = shared.lock();
            loop {
                if let Some(stop) = st.stopping {
                    break Err(stop);
                }
                if std::mem::take(&mut st.start_requested) {
                    st.restart_at = None;
                    break Ok(());
                }
                let now = Instant::now();
                st = match st.restart_at {
                    Some(at) if at <= now => {
                        st.restart_at = None;
                        break Ok(());
                    }
                    Some(at) => match shared.wake.wait_timeout(st, at - now) {
                        Ok((g, _)) => g,
                        Err(e) => e.into_inner().0,
                    },
                    None => shared.wake.wait(st).unwrap_or_else(|e| e.into_inner()),
                };
            }
        };
        match spawn {
            Err(stop) => break stop,
            Ok(()) => spawn_core(&mut monitor),
        }
    };
    shared.log.info(
        "supervisor stopping",
        json!({ "budgetMs": stop.budget.as_millis() as u64, "source": match stop.source {
            StopSource::Rpc => "daemon.stop".to_string(),
            StopSource::Signal(n) => format!("signal {n}"),
        } }),
    );
    if let Some(m) = monitor.as_mut() {
        m.stop(stop.budget);
    }
    remove_run_files(layout);
    shared.log.info("supervisor stopped", json!({}));
    drop(lock);
    0
}

/// Another process holds the lock: it is a supervisor that is running or still starting. Report its pid (from
/// its hello, else from its pid file) and exit 3.
fn already_running(layout: &Layout, address: &str) -> ! {
    let deadline = Instant::now() + Duration::from_secs(3);
    let pid = loop {
        if let Some(pid) = probe(layout, address) {
            break Some(pid);
        }
        if Instant::now() >= deadline {
            break pid_from_file(layout);
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    match pid {
        Some(pid) => fail(3, &format!("supervisor already running (pid {pid})")),
        None => fail(3, "supervisor already running (pid unknown)"),
    }
}

/// Removes the socket (unix), the token and the pid file. The lock file stays (see `run_inner`).
fn remove_run_files(layout: &Layout) {
    #[cfg(unix)]
    let _ = fs::remove_file(supervisor_address(&layout.home, platform()));
    let _ = fs::remove_file(layout.supervisor_token());
    let _ = fs::remove_file(layout.supervisor_pid());
}

/// SIGTERM and SIGINT take the `daemon.stop` path with the default budget.
#[cfg(unix)]
fn watch_signals(shared: &Arc<Shared>) {
    use signal_hook::consts::{SIGINT, SIGTERM};
    let mut signals = match signal_hook::iterator::Signals::new([SIGTERM, SIGINT]) {
        Ok(s) => s,
        Err(e) => {
            shared.log.error(
                "cannot install signal handlers",
                json!({ "err": e.to_string() }),
            );
            return;
        }
    };
    let s2 = shared.clone();
    let spawned = spawn_guarded(shared, "signals", move || {
        if let Some(sig) = signals.forever().next() {
            s2.request_stop(DEFAULT_STOP_BUDGET, StopSource::Signal(sig));
        }
    });
    if let Err(e) = spawned {
        shared.log.error(
            "cannot start the signal thread",
            json!({ "err": e.to_string() }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_scale_must_be_finite_and_positive() {
        assert_eq!(parse_time_scale(None), Ok(1.0));
        assert_eq!(parse_time_scale(Some("0.02")), Ok(0.02));
        assert_eq!(parse_time_scale(Some("1000")), Ok(1000.0));
        for bad in [
            "0", "-1", "NaN", "inf", "-inf", "", "fast", "1000.5", "1e300",
        ] {
            assert!(parse_time_scale(Some(bad)).is_err(), "{bad:?} accepted");
        }
    }

    #[test]
    fn iso8601_matches_javascript_to_iso_string() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
        // new Date(1790000000123).toISOString()
        assert_eq!(iso8601(1_790_000_000_123), "2026-09-21T14:13:20.123Z");
        assert_eq!(iso8601(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn status_json_validates_against_the_schema() {
        let schema: Value = serde_json::from_str(plur1bus_rpc::SCHEMA_JSON).unwrap();
        let doc = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$ref": "#/$defs/methods/daemon.status/result",
            "$defs": schema["$defs"],
        });
        let v = jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .build(&doc)
            .unwrap();
        let mut st = SupervisorState {
            instance_id: uuid::Uuid::new_v4().to_string(),
            pid: 42,
            started: Instant::now(),
            started_at_ms: now_ms(),
            no_core: true,
            time_scale: 1.0,
            config: read_config(&Layout::new("/nonexistent-p1b-home".into())).0,
            child: None,
            lifeline: Lifeline::None,
            stopping: None,
            backoff: Backoff::new(1.0),
            restart_at: None,
            start_requested: false,
        };
        assert!(v.is_valid(&st.status_json()), "{}", st.status_json());
        st.stopping = Some(StopRequest {
            budget: DEFAULT_STOP_BUDGET,
            source: StopSource::Rpc,
            requested_at: Instant::now(),
        });
        assert_eq!(
            st.status_json()["supervisor"]["process"]["state"],
            "stopping"
        );
        assert!(v.is_valid(&st.status_json()));
    }
}
