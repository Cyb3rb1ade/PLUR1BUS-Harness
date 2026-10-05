//! Supervisor: process lifecycle for the core and the installed modules.
//!
//! `state` is the pure state machine (health, backoff, crash classification) with no I/O. `server` is the
//! supervisor's RPC endpoint, `logfile` the size-rotated log files, `config` the owner of `config.json` (`config.*`,
//! the file watcher) and `subscribers` the connections that receive supervisor notifications. [`run`] is `plur1bus supervise`: it claims the
//! home (single instance), writes `run/supervisor.token` and `run/supervisor.pid`, serves `supervisor.auth` and
//! `daemon.*`, adopts a core that is already running or spawns one (`adopt`, `child`), then does the same for every
//! installed module in start order ([`start_modules`], D14), monitors them, and stops on `daemon.stop` or
//! SIGTERM/SIGINT (the modules in reverse start order, then the core, inside one budget).
#![allow(dead_code)]
pub mod adopt;
pub mod child;
pub mod config;
pub mod ext;
pub mod logfile;
pub mod modules;
#[cfg(windows)]
pub mod pipe_windows;
pub mod server;
pub mod state;
pub mod subscribers;

use crate::paths::{supervisor_address, Layout};
use logfile::RotatingFile;
pub use modules::{module_list, ModuleOp, ModuleVerb, OpError};
use modules::{reconcile_start, reconcile_stop, run_module_op, start_modules};
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Map, Value};
pub use state::{next_due, Lifeline, Role, Slot};
use state::{ChildState, RoleKind};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::{self, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use subscribers::Topic;

/// `capabilities.features` of the supervisor's hello.
pub const SUPERVISOR_FEATURES: &[&str] = &["adoption", "config", "lifelines", "modules"];

/// Budget for stopping the children when `daemon.stop` names none, and on SIGTERM/SIGINT.
pub const DEFAULT_STOP_BUDGET: Duration = Duration::from_secs(10);

/// Exit code of a supervisor thread that panicked (spec §4: a panic is a bug; the OS restarts the supervisor).
pub const EXIT_PANIC: i32 = 70;

#[derive(Debug, Clone, Default)]
pub struct SuperviseOpts {
    /// Test seam: serve the endpoint but never spawn or adopt a child. Needs `PLUR1BUS_ALLOW_TEST_INTERNALS=1`.
    pub no_core: bool,
}

/// `supervisor.*` and `logs.*` of the running configuration ([`config::supervisor_config`]); replaced whenever the
/// running configuration changes.
#[derive(Debug, Clone, PartialEq)]
pub struct SupervisorConfig {
    pub grace_ms: u64,
    pub health_interval_ms: u64,
    pub log_max_bytes: u64,
    pub log_keep: u32,
}

/// A requested restart (B8): the units of `plan` are restarted by the main thread, which then sends the ones it
/// restarted on `done` (a caller that stopped waiting has dropped the receiver; the send is then ignored).
#[derive(Debug)]
pub struct RestartJob {
    pub plan: plur1bus_config::Restart,
    pub done: std::sync::mpsc::Sender<Vec<String>>,
    /// When it was queued: a unit spawned after this already runs the configuration that asked for it (M8).
    pub queued_at: Instant,
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

/// The supervisor's mutable state (ruling H3-R2), behind [`Shared::state`].
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
    /// The core's ready timeout has its floor (`child::CORE_READY_FLOOR`): true unless the test seam
    /// `PLUR1BUS_SUPERVISOR_NO_CORE_READY_FLOOR=1` (with test internals) drops it.
    pub core_ready_floor: bool,
    pub config: SupervisorConfig,
    /// One slot per supervised child, the core first: its state, lifeline, backoff and restart schedule.
    pub slots: Vec<Slot>,
    /// Set by `daemon.stop` or a signal; the main thread then stops the children and exits 0.
    pub stopping: Option<StopRequest>,
    /// Requested restarts (`config.set` of a `core` key, a core reporting `restartPending`), run in order by the main
    /// thread (B8), which a push wakes.
    pub restart_jobs: VecDeque<RestartJob>,
    /// The main thread is running a restart job (a core reporting `restartPending` then pushes none).
    pub restart_running: bool,
    /// The last spawn-to-ready time of the core (ms): `config.set`'s `estimates.core`. `None` before one.
    pub core_ready_ms: Option<u64>,
    /// Queued `module.*` control calls, run in order by the main thread after the restart jobs.
    pub module_ops: VecDeque<ModuleOp>,
    /// `run/`'s protected, inheritable ACL was set at start (HB5): every spawned child gets `PLUR1BUS_RUN_ACL=inherited`
    /// ([`child::child_env`]). Always `false` off Windows.
    pub run_acl_inherited: bool,
    /// The held-back overlay of every packaged module that has one (X1-R17): computed at start after `ext::recover`
    /// and again after every ext mutation ([`ext`]); `modules::modules_view` holds such a module back.
    pub ext_overlays: BTreeMap<String, crate::ext::overlays::Overlay>,
    /// Set while a stop waits for an ext mutation in flight ([`drain_ext`]): the module ops that mutation queues through
    /// its host are still run, so it finishes (or rolls back) instead of failing half-way with `stopping`.
    pub ext_draining: bool,
}

impl SupervisorState {
    /// The slot of the child named `name` (`core`, or a module's name).
    pub fn slot(&self, name: &str) -> Option<&Slot> {
        self.slots.iter().find(|s| s.role.name == name)
    }

    pub fn slot_mut(&mut self, name: &str) -> Option<&mut Slot> {
        self.slots.iter_mut().find(|s| s.role.name == name)
    }

    /// Every module child's `$defs/ModuleState`, in slot order (`module.watch`).
    pub fn module_states(&self) -> Vec<Value> {
        self.slots
            .iter()
            .filter(|s| s.role.kind == RoleKind::Module)
            .filter_map(|s| s.child.as_ref())
            .map(ChildState::to_module_state)
            .collect()
    }

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
            "children": self
                .slots
                .iter()
                .filter_map(|s| s.child.as_ref())
                .map(ChildState::to_json)
                .collect::<Vec<_>>(),
        })
    }
}

/// State shared by every supervisor thread (S14): one mutex, one condvar that wakes the main thread (a stop, a
/// scheduled restart, `daemon.start`), and the log. `config` has its own mutex, taken before `state` when both are
/// needed.
pub struct Shared {
    pub state: Mutex<SupervisorState>,
    pub wake: Condvar,
    pub log: Log,
    /// `config.json` as the supervisor owns it (B3–B5).
    pub config: Mutex<config::ConfigState>,
    /// Connections subscribed to `config.changed` or `module.state`.
    pub subscribers: subscribers::Subscribers,
    /// The children's out logs, so a `logs.*` change reaches them too.
    pub out_logs: Mutex<Vec<Arc<Mutex<Option<RotatingFile>>>>>,
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
    /// `logs.maxBytes` / `logs.keep` changed: applies from the next write on.
    pub fn set_limits(&self, max_bytes: u64, keep: u32) {
        if let Some(f) = relock(&self.file).as_mut() {
            f.set_limits(max_bytes, keep);
        }
    }
}

/// Broadcasts `module.state` for `slot` when it is a module's and has a child; called with the state locked, right
/// after the change, so the notifications keep the order of the changes (the lock order is state, then subscribers).
pub(crate) fn broadcast_module_state(shared: &Shared, slot: &Slot) {
    if slot.role.kind != RoleKind::Module {
        return;
    }
    if let Some(c) = &slot.child {
        let dropped =
            shared
                .subscribers
                .broadcast(Topic::Modules, "module.state", &c.to_module_state());
        for d in dropped {
            shared.log.warn(
                "module.state subscriber dropped",
                json!({ "subscription": d.id, "reason": d.reason }),
            );
        }
    }
}

/// Locks `m`, using a poisoned mutex anyway: a panicking thread takes the whole process down (exit 70).
pub(crate) fn relock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
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

fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "posix"
    }
}

/// The token in `run/supervisor.token`, when it is there and well formed. Also read by `commands::daemon` (`daemon
/// start|stop|status` and `supervisor_detail`), which needs the same "is a supervisor plausibly running" check.
pub(crate) fn read_token(layout: &Layout) -> Option<String> {
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
        // A squatter's pipe is refused before the token is sent (S11); a dead supervisor's pid never serves.
        expected_server_pid: layout.recorded_pid(Endpoint::Supervisor),
    };
    let client = Client::connect(address, &token, opts).ok()?;
    client.hello()["pid"].as_u64()
}

/// 32 random bytes as lower-case hex (S3).
fn fresh_token() -> io::Result<String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// Writes `content` to `path` through a temporary file and a rename, so a reader (the core's `core.adopt`) never
/// sees a half-written file. Mode `0600` on unix; on Windows a protected DACL for the user and SYSTEM only (S3, S11),
/// set before any content is written. The rename keeps it.
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
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Foundation::GENERIC_WRITE;
        use windows_sys::Win32::Storage::FileSystem::WRITE_DAC;
        o.access_mode(GENERIC_WRITE | WRITE_DAC);
    }
    let mut f = o.open(&tmp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        plur1bus_rpc::win::restrict_to_user(f.as_raw_handle())?;
    }
    f.write_all(content.as_bytes())?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, path)
}

/// Sets `run/`'s DACL to [`plur1bus_rpc::acl::run_dir_sddl`] (HB5): `Ok` when it took, `Err(Some(reason))` when it
/// failed (FAT or network volume, no user SID; `PLUR1BUS_TEST_FAIL_RUN_ACL=1` with test internals acts as a failure),
/// `Err(None)` off Windows, where `create_private_dir`'s `0700` is the whole story.
#[cfg(windows)]
fn secure_run_dir(run: &Path, allow_test_internals: bool) -> Result<(), Option<String>> {
    if allow_test_internals && std::env::var("PLUR1BUS_TEST_FAIL_RUN_ACL").as_deref() == Ok("1") {
        return Err(Some(
            "SetNamedSecurityInfoW failed (PLUR1BUS_TEST_FAIL_RUN_ACL)".into(),
        ));
    }
    plur1bus_rpc::win::user_sid()
        .and_then(|sid| {
            plur1bus_rpc::win::set_path_dacl(run, &plur1bus_rpc::acl::run_dir_sddl(&sid))
        })
        .map_err(|e| Some(e.to_string()))
}

#[cfg(not(windows))]
fn secure_run_dir(_run: &Path, _allow_test_internals: bool) -> Result<(), Option<String>> {
    Err(None)
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

/// Makes this process's own stdin/stdout/stderr handles non-inheritable. Rust's `Command` on Windows calls
/// `CreateProcessW` with `bInheritHandles = TRUE`, so a child inherits every inheritable handle of its parent, not only
/// the three it is given. The std handles a process received are inheritable, so without this a long-lived child
/// (the detached supervisor `daemon start` spawns, the core the supervisor spawns) keeps the caller's pipes open:
/// `plur1bus daemon start | …`, or a test's `Command::output()`, would wait for EOF until the child exits. A child
/// that should inherit a std handle still gets it: `Stdio::inherit()` duplicates the handle as inheritable.
#[cfg(windows)]
pub(crate) fn keep_std_handles_private() {
    use windows_sys::Win32::Foundation::{
        SetHandleInformation, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: GetStdHandle only reads the process parameters; a null or invalid result is skipped, and clearing
        // the inherit flag on a valid handle changes nothing but who inherits it.
        unsafe {
            let h = GetStdHandle(which);
            if !h.is_null() && h != INVALID_HANDLE_VALUE {
                SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

/// Task Scheduler starts the supervisor (a console program) at logon with a console window of its own. A console no
/// other process shares is released, so that window closes; the terminal of a user who ran `supervise` by hand is
/// shared with the shell and kept. Redirected stdio (pipes, files) is unaffected.
#[cfg(windows)]
fn release_own_console() {
    use windows_sys::Win32::System::Console::{FreeConsole, GetConsoleProcessList};
    let mut pids = [0u32; 2];
    // SAFETY: a buffer of two entries; the result is how many processes share this console (0 without one).
    let sharing = unsafe { GetConsoleProcessList(pids.as_mut_ptr(), pids.len() as u32) };
    if sharing == 1 {
        // SAFETY: detaches this process from its console; nothing here holds a console handle.
        unsafe { FreeConsole() };
    }
}

/// Maps a non-transient supervisor exit to 0 under launchd (ruling B16): `KeepAlive.SuccessfulExit = false` would
/// otherwise loop-restart 2 (usage/set-up failure) or 3 (another supervisor already owns the home) forever, and
/// retrying under the same OS service registration can never fix either. Every other `code`, and every other
/// `manager`, passes through unchanged. clap's own exit 2 for a CLI usage error never reaches here: it happens
/// before `supervisor::run` is called.
pub fn exit_code(code: i32, manager: Option<&str>) -> i32 {
    if manager == Some("launchd") && matches!(code, 2 | 3) {
        0
    } else {
        code
    }
}

/// Exits with `code`, remapped through [`exit_code`] using `PLUR1BUS_SERVICE_MANAGER` (set by the launchd plist,
/// `service::launchd::SERVICE_MANAGER_ENV`). When the remap changes the code, the reason is written to stderr and to
/// `logs/supervisor.log` before exiting; every `fail` site that can produce 2 or 3 runs before the shared `Log` is
/// open, so a fresh ad hoc one is opened here (harmless if it happens to race the real one: both append).
fn fail(layout: &Layout, code: i32, msg: &str) -> ! {
    eprintln!("plur1bus supervise: {msg}");
    let manager = std::env::var("PLUR1BUS_SERVICE_MANAGER").ok();
    let mapped = exit_code(code, manager.as_deref());
    if mapped != code {
        let note = format!(
            "exiting {mapped} instead of {code} so launchd does not restart a non-transient failure"
        );
        eprintln!("{note}");
        let log = Log::open(&layout.log_file("supervisor"), u64::MAX, 1);
        log.info(&note, json!({}));
    }
    std::process::exit(mapped)
}

/// `plur1bus supervise`. Never returns: exits 0 after a stop, 2 on a usage error, 3 when another supervisor owns
/// the home (a supervisor answered), 1 when the endpoint cannot be set up or the lock stays held with no supervisor
/// answering, 70 after a panic.
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
        fail(
            layout,
            2,
            "--no-core requires PLUR1BUS_ALLOW_TEST_INTERNALS=1",
        );
    }
    let time_scale = if allow {
        let raw = std::env::var("PLUR1BUS_SUPERVISOR_TIME_SCALE").ok();
        parse_time_scale(raw.as_deref()).unwrap_or_else(|e| fail(layout, 2, &e))
    } else {
        1.0
    };
    let core_ready_floor =
        !(allow && std::env::var(child::NO_CORE_READY_FLOOR_ENV).as_deref() == Ok("1"));
    #[cfg(windows)]
    {
        release_own_console();
        // Before any spawn: the core must inherit only its own stdio (the stdin lifeline, the output pipes).
        keep_std_handles_private();
    }

    if let Err(e) =
        create_private_dir(&layout.run()).and_then(|_| fs::create_dir_all(layout.logs()))
    {
        fail(
            layout,
            1,
            &format!(
                "cannot create run/ and logs/ under {}: {e}",
                layout.home.display()
            ),
        );
    }
    // HB17: one record per start, before anything can fail with a remapped exit, so `1staid repair` can tell a
    // restart loop (under launchd, systemd or Task Scheduler alike) from the log. Opened like `fail`'s ad hoc log.
    Log::open(&layout.log_file("supervisor"), u64::MAX, 1).info(
        "supervisor started",
        json!({ "pid": std::process::id(), "manager": std::env::var("PLUR1BUS_SERVICE_MANAGER").ok() }),
    );
    // HB5: before anything is probed, adopted or spawned, `run/` gets its protected, inheritable user-and-SYSTEM ACL,
    // so every file a child creates in it is private from its first byte. Logged once the log is open.
    let run_acl = secure_run_dir(&layout.run(), allow);
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
                layout,
                1,
                &format!("cannot open {}: {e}", layout.supervisor_lock().display()),
            )
        });
    if let Err(e) = lock.try_lock() {
        match e {
            fs::TryLockError::WouldBlock => already_running(layout, &address, &lock),
            fs::TryLockError::Error(e) => fail(
                layout,
                1,
                &format!("cannot lock {}: {e}", layout.supervisor_lock().display()),
            ),
        }
    }
    // A supervisor that predates the lock, or a squatter, still answers here; a dead socket is removed.
    if let Some(pid) = probe(layout, &address) {
        fail(
            layout,
            3,
            &format!("supervisor already running (pid {pid})"),
        );
    }
    #[cfg(unix)]
    if Path::new(&address).exists() {
        let _ = fs::remove_file(&address);
    }

    // M6 and X1: what a killed module install or uninstall (`modules::install::recover`, run once, inside) and a
    // killed ext command left, before config.json is loaded: an undone restore may put a module's config section back.
    let recovered = crate::ext::recover(layout);
    let config_state = config::initial(layout);
    let config = config::supervisor_config(config_state.running.as_ref());
    let log = Log::open(
        &layout.log_file("supervisor"),
        config.log_max_bytes,
        config.log_keep,
    );
    if let Some(r) = &config_state.rejected {
        // B18: no configuration runs until a valid file appears; a core started now exits 2 (config-invalid).
        log.warn(
            "config.json is invalid; no configuration runs until it is fixed",
            json!({ "errors": r.errors }),
        );
    }
    match &run_acl {
        Ok(()) => log.info(
            "run/ ACL set: protected, inherited by run files, user and SYSTEM only",
            json!({}),
        ),
        Err(Some(e)) => log.warn(
            &format!("run/ ACL not set: {e}; children secure their own run files"),
            json!({ "err": e }),
        ),
        Err(None) => {}
    }
    if !config_state.module_errors.is_empty() {
        log.warn(
            "module configuration does not satisfy its configSchema",
            json!({ "errors": config_state.module_errors }),
        );
    }
    if !recovered.is_empty() {
        log.info(
            "module and extension staging recovered",
            json!({ "actions": recovered }),
        );
    }
    // X1: the integrity of the enabled packaged modules and their overlays, before any module starts.
    let ext_overlays = ext::at_start(layout, config_state.running.as_ref(), &log);
    // A write that crashed before its rename left its temp file; this process owns config.json now.
    let stale = plur1bus_config::remove_stale_temps(&layout.config_path());
    if !stale.is_empty() {
        log.info(
            "removed stale config.json temp files",
            json!({ "files": stale }),
        );
    }

    let instance_id = uuid::Uuid::new_v4().to_string();
    let pid = std::process::id();
    let token =
        fresh_token().unwrap_or_else(|e| fail(layout, 1, &format!("cannot generate a token: {e}")));
    if let Err(e) = write_private(&layout.supervisor_token(), &token)
        .and_then(|_| write_private(&layout.supervisor_pid(), &format!("{pid} {instance_id}\n")))
    {
        fail(layout, 1, &format!("cannot write the run files: {e}"));
    }

    let shared = Arc::new(Shared {
        state: Mutex::new(SupervisorState {
            instance_id: instance_id.clone(),
            pid,
            started: Instant::now(),
            started_at_ms: now_ms(),
            no_core: opts.no_core,
            time_scale,
            core_ready_floor,
            config,
            slots: vec![Slot::new(Role::core(), time_scale)],
            stopping: None,
            restart_jobs: VecDeque::new(),
            restart_running: false,
            core_ready_ms: None,
            module_ops: VecDeque::new(),
            run_acl_inherited: run_acl.is_ok(),
            ext_overlays,
            ext_draining: false,
        }),
        wake: Condvar::new(),
        log,
        config: Mutex::new(config_state),
        subscribers: subscribers::Subscribers::new(),
        out_logs: Mutex::new(Vec::new()),
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
            fail(layout, 1, &format!("cannot listen on {address}: {e}"));
        }
    };
    {
        let shared2 = shared.clone();
        let layout2 = layout.clone();
        spawn_guarded(&shared, "accept", move || server.serve(shared2, layout2))
            .unwrap_or_else(|e| fail(layout, 1, &format!("cannot start the accept thread: {e}")));
    }
    config::spawn_watcher(&shared, layout, time_scale)
        .unwrap_or_else(|e| fail(layout, 1, &format!("cannot start the config watcher: {e}")));
    shared.log.info(
        "supervisor ready",
        json!({ "pid": pid, "instanceId": instance_id, "address": address, "noCore": opts.no_core, "timeScale": time_scale }),
    );

    // Monitors are built lazily, one per slot, keyed by the slot's name: when core.js is missing the supervisor stays
    // up with a fatal child (H3-R11), and `daemon.start` tries again.
    let mut monitors = Monitors::new();
    if !opts.no_core {
        start_child(&shared, layout, &token, &Role::core(), &mut monitors);
        start_modules(&shared, layout);
    }

    // Main thread: the restart scheduler (a requested restart, a slot's `daemon.start` or due `restart_at`) until a
    // stop.
    let stop = loop {
        let next = {
            let mut st = shared.lock();
            loop {
                if let Some(stop) = st.stopping {
                    break Err(stop);
                }
                // Before `daemon.start`: a job restarts a core that is down, and the start that follows is a no-op.
                if !st.restart_jobs.is_empty() {
                    // M8: every job queued by now is coalesced into one run.
                    let jobs: Vec<RestartJob> = st.restart_jobs.drain(..).collect();
                    st.restart_running = true;
                    break Ok(Next::Job(jobs));
                }
                if let Some(op) = st.module_ops.pop_front() {
                    break Ok(Next::Op(op));
                }
                let now = Instant::now();
                // The core first: its start or due restart never waits behind the modules' first starts.
                let core_due = st.slots.first().is_some_and(|s| {
                    s.role.kind == RoleKind::Core
                        && (s.start_requested || s.restart_at.is_some_and(|at| at <= now))
                });
                let due = if core_due {
                    Some(0)
                } else {
                    next_due(&st.slots, now)
                };
                if let Some(i) = due {
                    let slot = &mut st.slots[i];
                    slot.start_requested = false;
                    slot.restart_at = None;
                    break Ok(Next::Due(slot.role.clone()));
                }
                st = match state::next_wake(&st.slots) {
                    Some(at) => match shared
                        .wake
                        .wait_timeout(st, at.saturating_duration_since(now))
                    {
                        Ok((g, _)) => g,
                        Err(e) => e.into_inner().0,
                    },
                    None => shared.wake.wait(st).unwrap_or_else(|e| e.into_inner()),
                };
            }
        };
        match next {
            Err(stop) => break stop,
            Ok(Next::Job(jobs)) => run_restart_jobs(&shared, layout, &token, &mut monitors, jobs),
            Ok(Next::Op(op)) => run_module_op(&shared, layout, &token, &mut monitors, op),
            // A module's first start probes for one to adopt, like the core's at start (S6).
            Ok(Next::Due(role))
                if role.kind == RoleKind::Module && !monitors.contains_key(&role.name) =>
            {
                start_child(&shared, layout, &token, &role, &mut monitors)
            }
            Ok(Next::Due(role)) => restart_child(&shared, layout, &token, &role, &mut monitors),
        }
    };
    // X1: a stage or inspect worker still running is killed and reaped; its caller answers worker-failed and removes
    // what it left (anything a late clean-up misses, `ext::recover` removes at the next start).
    if !crate::ext::worker::stop_all(Duration::from_secs(5)) {
        shared.log.warn(
            "an ext worker was not reaped within 5 s of the stop",
            json!({}),
        );
    }
    // Then an ext mutation still committing finishes or rolls back first, never half-way (its module ops are still
    // run); held to the exit, so no other one starts.
    let _ext_quiet = drain_ext(&shared, layout, &token, &mut monitors, EXT_DRAIN_BOUND);
    // A job or module call still queued is not run: dropping its sender tells the waiting caller so.
    {
        let mut st = shared.lock();
        st.restart_jobs.clear();
        st.module_ops.clear();
    }
    shared.log.info(
        "supervisor stopping",
        json!({ "budgetMs": stop.budget.as_millis() as u64, "source": match stop.source {
            StopSource::Rpc => "daemon.stop".to_string(),
            StopSource::Signal(n) => format!("signal {n}"),
        } }),
    );
    // The slots are the core, then the modules in start order: stopped in reverse, the core last, all inside one
    // budget plus one grace (M3, H3B-R25). A module is asked to finish by the end of the budget and killed there; the
    // grace is the core's reserve: it is asked for what is left of the budget, at least half the grace, and killed at
    // the end of the grace, so a hung module never costs the core its clean stop.
    let order: Vec<(String, RoleKind)> = shared
        .lock()
        .slots
        .iter()
        .rev()
        .map(|s| (s.role.name.clone(), s.role.kind))
        .collect();
    let grace = child::stop_grace(time_scale);
    let budget_end = Instant::now() + stop.budget;
    let deadline = budget_end + grace;
    for (name, kind) in order {
        if let Some(m) = monitors.get_mut(&name) {
            let left = budget_end.saturating_duration_since(Instant::now());
            match kind {
                RoleKind::Module => m.stop_until(left, budget_end),
                RoleKind::Core => m.stop_until(left.max(grace / 2), deadline),
            }
        }
    }
    // The last log line comes before the run files go: `daemon stop` returns once `run/supervisor.pid` is gone, and a
    // line written after that would land in `logs/supervisor.log` after the caller already saw the stop as complete
    // (a race the setup-profile test caught as a changed home).
    shared.log.info("supervisor stopped", json!({}));
    remove_run_files(layout);
    drop(lock);
    0
}

/// What the scheduler runs next.
enum Next {
    /// The requested restarts queued so far (B8), run as one (M8).
    Job(Vec<RestartJob>),
    /// A slot whose `daemon.start` or scheduled restart is due.
    Due(Role),
    /// A `module.*` control call.
    Op(ModuleOp),
}

/// The monitors of the main thread, one per slot that has been spawned or adopted, keyed by the slot's name.
type Monitors = BTreeMap<String, child::Monitor>;

/// Spawns `role`'s child: through its monitor, or by building the monitor (and its spawn spec) first. A spec that
/// cannot be built marks the child unspawnable (H3-R11).
/// How long a stop waits for an ext mutation in flight ([`drain_ext`]): its commit's module ops each have their own
/// stop budget, so this bounds the whole wait.
const EXT_DRAIN_BOUND: Duration = Duration::from_secs(60);

/// Waits, at most `bound`, until no ext mutation holds the ext mutation lock (X1-R15), and returns the lock, held for
/// the rest of the stop so no other mutation starts. While it waits, the module ops the mutation queues (a module put
/// in place or moved aside, `ModuleHost`) are still run here, so the commit finishes or its rollback completes instead
/// of failing with `stopping` and leaving code without its record. `None` when the bound passed (logged).
fn drain_ext(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    monitors: &mut Monitors,
    bound: Duration,
) -> Option<crate::ext::MutationGuard> {
    let start = Instant::now();
    shared.lock().ext_draining = true;
    let mut logged = false;
    let guard = loop {
        if let Ok(g) = crate::ext::try_mutation() {
            break Some(g);
        }
        if !logged {
            shared.log.info(
                "waiting for the extension change in flight before stopping",
                json!({ "boundMs": bound.as_millis() as u64 }),
            );
            logged = true;
        }
        if start.elapsed() >= bound {
            shared.log.warn(
                "an extension change was still running when the stop stopped waiting for it",
                json!({ "boundMs": bound.as_millis() as u64 }),
            );
            break None;
        }
        let op = {
            let st = shared.lock();
            let mut st = if st.module_ops.is_empty() {
                match shared.wake.wait_timeout(st, Duration::from_millis(20)) {
                    Ok((g, _)) => g,
                    Err(e) => e.into_inner().0,
                }
            } else {
                st
            };
            st.module_ops.pop_front()
        };
        if let Some(op) = op {
            run_module_op(shared, layout, token, monitors, op);
        }
    };
    shared.lock().ext_draining = false;
    guard
}

fn spawn_child(shared: &Arc<Shared>, layout: &Layout, role: &Role, monitors: &mut Monitors) {
    match monitors.get_mut(&role.name) {
        Some(m) => m.spawn(),
        None => match child::spec_for(layout, role, &uuid::Uuid::new_v4().to_string()) {
            Ok(spec) => {
                let m = child::Monitor::start(shared.clone(), layout, role.clone(), spec);
                monitors.insert(role.name.clone(), m);
            }
            Err(e) => child::mark_unspawnable(shared, &role.name, &e),
        },
    }
}

/// Runs the requested restarts queued so far as one (B8, M8). The modules a plan names, and every module whose
/// `enabled` or `needs` situation changed with it, are stopped first (reverse start order); then the core, when a plan
/// names it, through [`child::Monitor::restart_requested`] (or a first spawn when there has been no process); then the
/// modules are started in start order ([`reconcile_stop`], [`reconcile_start`]). A unit whose process spawned after the
/// oldest job was queued already runs the configuration that asked for the restart and is left alone (M8). Every job
/// is sent the units restarted.
fn run_restart_jobs(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    monitors: &mut Monitors,
    jobs: Vec<RestartJob>,
) {
    let mut restarted = Vec::new();
    let no_core = shared.lock().no_core;
    let core_wanted = jobs.iter().any(|j| j.plan.core);
    let oldest = jobs.iter().map(|j| j.queued_at).min();
    let modules: BTreeSet<String> = jobs
        .iter()
        .flat_map(|j| j.plan.modules.iter().cloned())
        .collect();
    let reconcile = (!no_core && !modules.is_empty())
        .then(|| reconcile_stop(shared, layout, monitors, &modules, oldest));
    if core_wanted && !no_core {
        let core = Role::core();
        let fresh = state::restart_already_done(
            monitors
                .get(&core.name)
                .and_then(child::Monitor::running_since),
            oldest,
        );
        match monitors.get_mut(&core.name) {
            Some(_) if fresh => shared.log.info(
                "core restart skipped: the running core started after it was requested",
                json!({ "jobs": jobs.len() }),
            ),
            Some(m) => m.restart_requested(DEFAULT_STOP_BUDGET),
            None => {
                if let Some(slot) = shared.lock().slot_mut(&core.name) {
                    slot.backoff.reset();
                }
                spawn_child(shared, layout, &core, monitors);
            }
        }
        if monitors
            .get(&core.name)
            .is_some_and(child::Monitor::is_running)
        {
            restarted.push(core.name);
        }
    }
    if let Some(r) = reconcile {
        restarted.extend(reconcile_start(shared, layout, token, monitors, r));
    }
    shared.lock().restart_running = false;
    for job in jobs {
        let _ = job.done.send(restarted.clone());
    }
}

/// Queues a requested restart of `plan`'s units and wakes the main thread; `None` (nothing queued) during a stop, or
/// when the plan names only the core and there is none to restart (`--no-core`). The receiver yields the units
/// restarted.
pub fn push_restart(
    shared: &Shared,
    plan: plur1bus_config::Restart,
) -> Option<std::sync::mpsc::Receiver<Vec<String>>> {
    let mut st = shared.lock();
    if st.stopping.is_some() || (st.no_core && plan.modules.is_empty()) {
        return None;
    }
    let (done, rx) = std::sync::mpsc::channel();
    st.restart_jobs.push_back(RestartJob {
        plan,
        done,
        queued_at: Instant::now(),
    });
    shared.wake.notify_all();
    Some(rx)
}

/// A child at start (spec §6.4, S6): probe its address before any spawn ([`probe_and_adopt`]), and spawn only when
/// nothing was adopted.
fn start_child(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    role: &Role,
    monitors: &mut Monitors,
) {
    if !probe_and_adopt(shared, layout, token, role, monitors) && shared.lock().stopping.is_none() {
        spawn_child(shared, layout, role, monitors);
    }
}

/// A due restart or `daemon.start` of `role`. When the last exit was `lock-held`, another process holds the child's
/// lock (`state/core.lock` for the core): most likely one still starting (the core takes the lock seconds before it
/// listens). So the address is probed again first, and a child that now serves is adopted instead of spawning yet
/// another one that would exit 3.
fn restart_child(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    role: &Role,
    monitors: &mut Monitors,
) {
    let running = monitors
        .get(&role.name)
        .is_some_and(child::Monitor::is_running);
    let lock_held = {
        let st = shared.lock();
        st.slot(&role.name)
            .and_then(|s| s.child.as_ref())
            .and_then(|c| c.last_exit.as_ref())
            .and_then(|e| e.reason.as_deref())
            == Some(state::CrashReason::LockHeld.as_str())
    };
    if !running
        && lock_held
        && (probe_and_adopt(shared, layout, token, role, monitors)
            || shared.lock().stopping.is_some())
    {
        return;
    }
    spawn_child(shared, layout, role, monitors);
}

/// Probes `role`'s address (S6). A serving child is adopted on the probe's own connection with the current token as
/// nonce, and becomes its monitor's process; a hung or foreign one is terminated through the pin the probe took on the
/// socket's server. Returns whether a child was adopted. A failed adoption (a child that is stopping) returns false:
/// the spawn that follows exits 3 while it still holds the lock, and backs off.
fn probe_and_adopt(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    role: &Role,
    monitors: &mut Monitors,
) -> bool {
    let found = match role.kind {
        RoleKind::Core => adopt::probe_child(layout, role, adopt::PROBE_TIMEOUT),
        RoleKind::Module => {
            // The manifest as it is now (minor 3), else what the slot last saw.
            let api = child::module_plan(layout, role, "probe")
                .ok()
                .map(|p| p.api_version)
                .or_else(|| {
                    shared
                        .lock()
                        .slot(&role.name)
                        .and_then(|s| s.api_version.clone())
                });
            adopt::probe_module(layout, role, api.as_deref(), adopt::PROBE_TIMEOUT)
        }
    };
    let name = found.name();
    let reason = match &found {
        adopt::Probe::Foreign { reason, .. } => Some(reason.clone()),
        _ => None,
    };
    shared.log.info(
        &format!("{} probe", role.name),
        json!({ "result": name, "peerPid": found.peer_pid(), "reason": reason }),
    );
    match found {
        adopt::Probe::Absent => false,
        adopt::Probe::Serving { peer, client, .. } => match adopt::adopt(client, role, token) {
            Ok((lifeline, status)) => {
                match monitors.get_mut(&role.name) {
                    Some(m) => m.attach_adopted(peer, lifeline, &status),
                    None => {
                        let spec =
                            child::spec_for(layout, role, &uuid::Uuid::new_v4().to_string()).ok();
                        let m = child::Monitor::adopt(
                            shared.clone(),
                            layout,
                            role.clone(),
                            spec,
                            peer,
                            lifeline,
                            &status,
                        );
                        monitors.insert(role.name.clone(), m);
                    }
                }
                true
            }
            Err(e) => {
                shared.log.warn(
                    &format!("adoption failed, spawning a {}", role.name),
                    json!({ "err": e.to_string() }),
                );
                false
            }
        },
        adopt::Probe::Hung { peer } | adopt::Probe::Foreign { peer, .. } => {
            adopt::terminate_found(shared, layout, role, peer, name);
            false
        }
    }
}

/// Another process holds the lock: a supervisor that is running or still starting, or a short-lived CLI holding it
/// for an offline module mutation (`commands::module::offline_lock`). Probe for up to 3 s: a supervisor that answers
/// is reported by pid and this process exits 3 (a non-transient refusal, 0 under launchd). When nothing answered,
/// the lock is tried once more; on success this process continues as the supervisor. Otherwise it exits 1, a
/// transient failure that launchd's `KeepAlive{SuccessfulExit:false}` retries after its throttle interval, so a
/// supervisor started while an offline `module install` held the lock is not lost (final review I1).
fn already_running(layout: &Layout, address: &str, lock: &fs::File) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(pid) = probe(layout, address) {
            fail(
                layout,
                3,
                &format!("supervisor already running (pid {pid})"),
            );
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    match lock.try_lock() {
        Ok(()) => {}
        Err(fs::TryLockError::WouldBlock) => fail(
            layout,
            1,
            &format!(
                "{} is held but no supervisor answered (an offline module change, or a supervisor still \
                 starting or stopping); try again",
                layout.supervisor_lock().display()
            ),
        ),
        Err(fs::TryLockError::Error(e)) => fail(
            layout,
            1,
            &format!("cannot lock {}: {e}", layout.supervisor_lock().display()),
        ),
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

/// A `SupervisorState` for unit tests: `--no-core`, scale 1, default configuration.
#[cfg(test)]
pub(crate) fn test_state() -> SupervisorState {
    SupervisorState {
        instance_id: uuid::Uuid::new_v4().to_string(),
        pid: 42,
        started: Instant::now(),
        started_at_ms: now_ms(),
        no_core: true,
        time_scale: 1.0,
        core_ready_floor: true,
        config: config::supervisor_config(None),
        slots: vec![Slot::new(Role::core(), 1.0)],
        stopping: None,
        restart_jobs: VecDeque::new(),
        restart_running: false,
        core_ready_ms: None,
        module_ops: VecDeque::new(),
        run_acl_inherited: false,
        ext_overlays: BTreeMap::new(),
        ext_draining: false,
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
    fn non_transient_exits_are_0_under_launchd_only() {
        // 2 (usage/setup) and 3 (already running) are non-transient: retrying under the same OS service
        // registration cannot succeed, so launchd must not loop-restart them (ruling B16).
        assert_eq!(exit_code(2, Some("launchd")), 0);
        assert_eq!(exit_code(3, Some("launchd")), 0);
        // A transient or fatal exit is never masked, even under launchd.
        assert_eq!(exit_code(1, Some("launchd")), 1);
        assert_eq!(exit_code(70, Some("launchd")), 70);
        // No other manager remaps anything.
        assert_eq!(exit_code(2, None), 2);
        assert_eq!(exit_code(3, None), 3);
        assert_eq!(exit_code(2, Some("systemd")), 2);
        assert_eq!(exit_code(3, Some("systemd")), 3);
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
            core_ready_floor: true,
            config: config::supervisor_config(None),
            slots: vec![Slot::new(Role::core(), 1.0)],
            stopping: None,
            restart_jobs: VecDeque::new(),
            restart_running: false,
            core_ready_ms: None,
            module_ops: VecDeque::new(),
            run_acl_inherited: false,
            ext_overlays: BTreeMap::new(),
            ext_draining: false,
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
