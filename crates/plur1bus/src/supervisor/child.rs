//! Spawning and monitoring a child (spec §6.4): the core in supervised mode, and every module (D14).
//!
//! A [`Monitor`] serves one slot ([`Slot`](super::state::Slot)) of `SupervisorState::slots`, found by its role's name:
//! every state update below goes to that slot's child, lifeline, backoff and restart schedule.
//!
//! Per spawn (a "generation") the supervisor holds the only write end of the child's stdin (its lifeline, S4) and
//! runs three kinds of std threads (S14): the output pumps (stdout and stderr into `logs/<role>.out.log`), a health
//! loop (readiness through the `core.auth` handshake, then `core.status` every `supervisor.healthIntervalMs`), and a
//! waiter that reaps the process and is the only place that decides to kill it (ready timeout, hang). An exit goes
//! through [`classify_exit_for`] and [`Backoff`](super::state::Backoff); a scheduled restart is left in
//! the slot's `restart_at` for the main thread's scheduler, which calls [`Monitor::spawn`]. Every duration below
//! except the 100 ms readiness poll and the 2 s poll deadline is multiplied by the time scale.
//!
//! An adopted core ([`Monitor::adopt`], S4, S19) has no process handle and no stdin: its lifeline is the connection
//! `core.adopt` succeeded on, and its health runs on that connection. Its exit is seen as that connection failing
//! (EOF) plus the process being gone ([`Peer::alive`]), and counts as `Retryable { reason: "adopted-exit" }`. A
//! restart uses the supervisor's own spawn spec.
use super::adopt::Peer;
use super::logfile::RotatingFile;
use super::state::{
    apply_policy, classify_exit_for, ChildState, CrashReason, ExitClass, Health, LastExit,
    RestartDecision, RestartPolicy, Role, RoleKind, Slot,
};
use super::{broadcast_module_state, now_ms, spawn_guarded, Lifeline, Shared, SupervisorState};
use crate::commands::core::{locate_core_js, locate_node};
use crate::modules::Installed;
use crate::paths::Layout;
use plur1bus_rpc::{Client, ConnectOptions};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// How to start one child.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildSpec {
    pub role: String,
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
    /// The working directory; `None` inherits the supervisor's.
    pub cwd: Option<PathBuf>,
}

/// The core in supervised mode: `node <core.js> --home <home> --lifeline stdin --instance <id>`, plus
/// `--test-internals <v>` when `PLUR1BUS_TEST_INTERNALS` is set (exactly like `core run`). Fails when core.js is
/// missing.
pub fn core_spec(layout: &Layout, instance_id: &str) -> Result<ChildSpec, String> {
    let core_js = locate_core_js(layout);
    if !core_js.exists() {
        return Err(format!(
            "core.js not found at {} (set PLUR1BUS_CORE_JS or run setup)",
            core_js.display()
        ));
    }
    let mut args: Vec<OsString> = vec![
        core_js.into(),
        "--home".into(),
        layout.home.clone().into(),
        "--lifeline".into(),
        "stdin".into(),
        "--instance".into(),
        instance_id.into(),
    ];
    if let Some(ti) = std::env::var_os("PLUR1BUS_TEST_INTERNALS") {
        args.push("--test-internals".into());
        args.push(ti);
    }
    Ok(ChildSpec {
        role: "core".into(),
        program: locate_node(layout),
        args,
        env: Vec::new(),
        cwd: None,
    })
}

/// An installed module: `node <dir>/<entry> --home <home> --module <name> [--lifeline stdin] --instance <id>`, run in
/// its own directory (`--lifeline stdin` unless the manifest says `lifeline: false`). Fails when its manifest is
/// invalid.
pub fn module_spec(layout: &Layout, m: &Installed, instance_id: &str) -> Result<ChildSpec, String> {
    let manifest = m
        .manifest
        .as_ref()
        .map_err(|errors| format!("module {}: {}", m.name, errors.join("; ")))?;
    let mut args: Vec<OsString> = vec![
        m.dir.join(&manifest.entry).into(),
        "--home".into(),
        layout.home.clone().into(),
        "--module".into(),
        m.name.clone().into(),
    ];
    // A manifest with `lifeline: false` runs without one (H3B-R25): the module then reads config.json itself and does
    // not end with the supervisor.
    if manifest.lifeline {
        args.extend(["--lifeline".into(), "stdin".into()]);
    }
    args.extend(["--instance".into(), instance_id.into()]);
    Ok(ChildSpec {
        role: m.name.clone(),
        program: locate_node(layout),
        args,
        env: Vec::new(),
        cwd: Some(m.dir.clone()),
    })
}

/// A module as its current `module.json` says to run it: the spawn spec, its restart policy and its `apiVersion`.
/// Read afresh on every spawn (and probe), so an edited or reinstalled manifest is what runs.
pub struct ModulePlan {
    pub spec: ChildSpec,
    pub policy: RestartPolicy,
    pub api_version: String,
}

/// Why a child cannot be spawned: the crash reason it is marked with, and the message logged.
pub type Unspawnable = (CrashReason, String);

/// Reads module `role`'s current manifest: not installed or invalid → `manifest-invalid`; an `apiVersion` this
/// supervisor does not support → `api-version-unsupported` (B12).
pub fn module_plan(
    layout: &Layout,
    role: &Role,
    instance_id: &str,
) -> Result<ModulePlan, Unspawnable> {
    let invalid = |e: String| (CrashReason::ManifestInvalid, e);
    let installed = crate::modules::scan(layout)
        .into_iter()
        .find(|m| m.name == role.name)
        .ok_or_else(|| invalid(format!("module {} is not installed", role.name)))?;
    let spec = module_spec(layout, &installed, instance_id).map_err(invalid)?;
    let manifest = installed
        .manifest
        .as_ref()
        .map_err(|e| invalid(e.join("; ")))?;
    let current = crate::modules::current_api_version();
    if !crate::modules::api_version_supported(&manifest.api_version, current) {
        return Err((
            CrashReason::ApiVersionUnsupported,
            format!(
                "module {}: apiVersion {} is not supported (current {current})",
                role.name, manifest.api_version
            ),
        ));
    }
    Ok(ModulePlan {
        spec,
        policy: RestartPolicy::parse(&manifest.restart),
        api_version: manifest.api_version.clone(),
    })
}

/// How to start `role`'s child: [`core_spec`] (`config-invalid` when it cannot be built), or [`module_plan`]'s spec.
pub fn spec_for(layout: &Layout, role: &Role, instance_id: &str) -> Result<ChildSpec, Unspawnable> {
    match role.kind {
        RoleKind::Core => {
            core_spec(layout, instance_id).map_err(|e| (CrashReason::ConfigInvalid, e))
        }
        RoleKind::Module => module_plan(layout, role, instance_id).map(|p| p.spec),
    }
}

/// The value after `--instance`, if any.
fn instance_of(spec: &ChildSpec) -> Option<String> {
    let i = spec.args.iter().position(|a| a == "--instance")?;
    spec.args
        .get(i + 1)
        .map(|v| v.to_string_lossy().into_owned())
}

/// `spec` with the value after `--instance` replaced: every process gets its own instance id.
fn with_instance(spec: &ChildSpec, instance_id: &str) -> ChildSpec {
    let mut spec = spec.clone();
    if let Some(i) = spec.args.iter().position(|a| a == "--instance") {
        if let Some(v) = spec.args.get_mut(i + 1) {
            *v = instance_id.into();
        }
    }
    spec
}

/// The supervisor's durations for one child (S8, spec §6.4).
#[derive(Debug, Clone, Copy)]
struct Timing {
    /// Readiness: connect + `core.auth` every `ready_poll`, give up after `ready_timeout` (60 s × scale).
    ready_poll: Duration,
    ready_timeout: Duration,
    /// `supervisor.healthIntervalMs` × scale, and the deadline of each `core.status`. The interval is a live key:
    /// the loops re-derive it from the running configuration ([`Timing::current`]).
    health_interval: Duration,
    poll_deadline: Duration,
    /// No successful poll for this long (30 s × scale, or three health intervals if that is longer) → hung.
    hang: Duration,
    /// Hang termination: `core.shutdown` at once, SIGTERM (unix) after `term_after` (2 s × scale), kill after
    /// `kill_after` (10 s × scale) more.
    term_after: Duration,
    kill_after: Duration,
    /// `daemon.stop`: wait `budgetMs` + this (5 s × scale), then kill.
    stop_grace: Duration,
    /// The time scale everything above was multiplied by.
    scale: f64,
}

/// Consecutive failed polls before `degraded("unresponsive")` (S8).
const UNRESPONSIVE_AFTER: u32 = 3;
/// How long a stop waits for the waiter to reap a killed process.
const POST_KILL_WAIT: Duration = Duration::from_secs(1);
/// How often the waiter checks the process and its watchdogs.
const WAITER_TICK: Duration = Duration::from_millis(25);
/// The ready timeout before the time scale (60 s, spec §6.4).
pub const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// The shortest ready timeout a module gets whatever the time scale. A module secures its run directory and its token
/// and pid files before it listens; on Windows that is several synchronous `icacls` runs (plus `whoami`), about a
/// second or more on a CI runner, on top of Node's start-up. The tests' scale (0.02) would leave 1.2 s for all of it.
/// At time scale 1 (production: the scale is a test seam) the timeout is 60 s and this floor never applies.
pub const MODULE_READY_FLOOR: Duration = Duration::from_secs(10);

/// The ready timeout of a spawned child of `kind` at time scale `scale`: 60 s × scale, for a module at least
/// [`MODULE_READY_FLOOR`].
pub fn ready_timeout(kind: RoleKind, scale: f64) -> Duration {
    let scaled = READY_TIMEOUT.mul_f64(scale);
    match kind {
        RoleKind::Core => scaled,
        RoleKind::Module => scaled.max(MODULE_READY_FLOOR),
    }
}

impl Timing {
    fn new(scale: f64, health_interval_ms: u64) -> Self {
        let s = |ms: u64| Duration::from_secs_f64(ms as f64 / 1000.0 * scale);
        Self {
            ready_poll: Duration::from_millis(100),
            ready_timeout: ready_timeout(RoleKind::Core, scale),
            health_interval: s(health_interval_ms),
            poll_deadline: Duration::from_secs(2),
            // A long configured interval must not look like a hang between two healthy polls.
            hang: s(30_000).max(s(health_interval_ms) * UNRESPONSIVE_AFTER),
            term_after: s(2_000),
            kill_after: s(10_000),
            stop_grace: s(5_000),
            scale,
        }
    }

    /// This timing for a child of `kind`: a module's ready timeout has a floor ([`ready_timeout`]).
    fn for_kind(self, kind: RoleKind) -> Self {
        Timing {
            ready_timeout: ready_timeout(kind, self.scale),
            ..self
        }
    }

    /// This timing with the health interval (and the hang threshold derived from it) of the running configuration:
    /// `supervisor.healthIntervalMs` is live, so it is read before each poll.
    fn current(self, shared: &Shared) -> Self {
        let ms = shared.lock().config.health_interval_ms;
        Timing {
            health_interval: Timing::new(self.scale, ms).health_interval,
            hang: Timing::new(self.scale, ms).hang,
            ..self
        }
    }
}

struct Ctx {
    layout: Layout,
    /// The slot this monitor serves.
    role: Role,
    address: String,
    /// The child's token file (`run/core.token` for the core).
    token: PathBuf,
    timing: Timing,
    /// `logs/<role>.out.log` (`logs/module-<name>.out.log` for a module), shared by every generation's pumps.
    out: Arc<Mutex<Option<RotatingFile>>>,
}

fn relock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The slot named `name`. Every monitor's slot exists from the supervisor's start on.
fn slot_mut<'a>(st: &'a mut SupervisorState, name: &str) -> Option<&'a mut Slot> {
    st.slot_mut(name)
}

/// One spawned process.
struct Gen {
    /// The name of its slot: always the monitor's `ctx.role.name` (M1), never the spec's.
    role: String,
    pid: u32,
    started: Instant,
    /// `None` once the waiter has reaped it (the pid may be reused from then on, so nothing signals it).
    process: Mutex<Option<Child>>,
    /// The lifeline: dropped only when the process has exited (or the supervisor dies).
    stdin: Mutex<Option<ChildStdin>>,
    /// The authenticated control connection: `core.status` polls and `core.shutdown` on a stop.
    control: Mutex<Option<Client>>,
    /// The supervisor asked it to stop (`daemon.stop`): its exit is `Requested`.
    requested: AtomicBool,
    ready: AtomicBool,
    /// Set together with the exit's state update, under the state lock.
    exited: AtomicBool,
    kill_reason: Mutex<Option<CrashReason>>,
    last_ok: Mutex<Instant>,
    /// `Some` for an adopted core (then `process` and `stdin` are `None`): the pid the OS named as its server.
    peer: Option<Peer>,
    /// Adopted core: `control` still holds the lifeline connection.
    lifeline_in_control: AtomicBool,
    /// Adopted core: the lifeline failed (EOF, timeout, I/O error), so the waiter checks whether the process is gone.
    lifeline_lost: AtomicBool,
    /// Adopted core: the lifeline once it can no longer carry calls. Kept open until the exit, because closing it
    /// would orphan a core that is still alive.
    parked: Mutex<Option<Client>>,
    /// Stopped for a requested restart ([`Monitor::restart_requested`]): its exit's reason is `none`.
    restarting: AtomicBool,
    /// This process reported `config.restartPending` and a restart job was queued for it (once per generation).
    pending_pushed: AtomicBool,
}

impl Gen {
    /// `Some(status)` once the process has exited (std caches it, so asking twice is fine).
    fn try_wait(&self) -> std::io::Result<Option<ExitStatus>> {
        match relock(&self.process).as_mut() {
            Some(c) => c.try_wait(),
            None => Ok(None),
        }
    }
    /// SIGKILL / TerminateProcess, unless it has already exited. An adopted core only while the OS still names its
    /// pid as the core socket's server ([`Peer::kill`]).
    fn kill(&self) {
        if let Some(p) = &self.peer {
            p.kill();
            return;
        }
        if let Some(c) = relock(&self.process).as_mut() {
            let _ = c.kill();
        }
    }
    /// SIGTERM, unless it has already exited. The process is not reaped while the lock is held, so the pid is
    /// still ours.
    #[cfg(unix)]
    fn terminate(&self) {
        if let Some(p) = &self.peer {
            p.terminate();
            return;
        }
        if let Some(c) = relock(&self.process).as_mut() {
            if matches!(c.try_wait(), Ok(None)) {
                // SAFETY: plain kill(2) on our own unreaped child.
                unsafe {
                    libc::kill(self.pid as libc::pid_t, libc::SIGTERM);
                }
            }
        }
    }
}

/// Spawns and monitors one child. Lives on the supervisor's main thread; the threads it starts share only
/// [`Shared`] and the current generation.
pub struct Monitor {
    shared: Arc<Shared>,
    ctx: Arc<Ctx>,
    /// `None` after an adoption whose spawn spec could not be built (core.js missing): [`Monitor::spawn`] retries it.
    spec: Option<ChildSpec>,
    current: Option<Arc<Gen>>,
    spawned: bool,
}

impl Monitor {
    /// Spawns `role`'s child at once. The first process gets the spec's own `--instance`, each later one a fresh id.
    pub fn start(shared: Arc<Shared>, layout: &Layout, role: Role, spec: ChildSpec) -> Monitor {
        let mut m = Monitor::new(shared, layout, Some(spec), role);
        m.spawn();
        m
    }

    /// Supervises a core adopted through `core.adopt` (S4, S19): `peer` is the socket's server as the probe pinned
    /// it, `lifeline` the connection the call succeeded on and `status` its `CoreStatus`. Nothing is spawned; after
    /// the adopted core exits, a restart uses `spec` (or builds it then, when it could not be built now).
    pub fn adopt(
        shared: Arc<Shared>,
        layout: &Layout,
        role: Role,
        spec: Option<ChildSpec>,
        peer: Peer,
        lifeline: Client,
        status: &Value,
    ) -> Monitor {
        let mut m = Monitor::new(shared, layout, spec, role);
        m.attach_adopted(peer, lifeline, status);
        m
    }

    /// Makes an adopted core the current process of this monitor (at start, or instead of a restart whose last exit
    /// was `lock-held`). The child keeps its `restarts` and `lastExit`. Call only while no process is running.
    pub fn attach_adopted(&mut self, peer: Peer, lifeline: Client, status: &Value) {
        self.spawned = true; // the adopted core counts as a process: a respawn gets a fresh instance id
        let hello = lifeline.hello().clone();
        let pid = peer.pid;
        if peer.pin_failed() {
            self.shared.log.warn(
                "cannot pin the adopted core's process; liveness and signals fall back to its socket",
                json!({ "pid": pid }),
            );
        }
        let instance_id = hello["instanceId"].as_str().map(str::to_string);
        let now = Instant::now();
        let m = self;
        let name = m.ctx.role.name.clone();
        let gen = Arc::new(Gen {
            role: name.clone(),
            pid,
            started: now,
            process: Mutex::new(None),
            stdin: Mutex::new(None),
            control: Mutex::new(Some(lifeline)),
            requested: AtomicBool::new(false),
            ready: AtomicBool::new(true),
            exited: AtomicBool::new(false),
            kill_reason: Mutex::new(None),
            last_ok: Mutex::new(now),
            peer: Some(peer),
            lifeline_in_control: AtomicBool::new(true),
            lifeline_lost: AtomicBool::new(false),
            parked: Mutex::new(None),
            restarting: AtomicBool::new(false),
            pending_pushed: AtomicBool::new(false),
        });
        if let Some(slot) = slot_mut(&mut m.shared.lock(), &name) {
            slot.backoff.on_ready(now);
            slot.restart_at = None;
            let prev = slot.child.take();
            slot.child = Some(ChildState {
                role: name.clone(),
                kind: m.ctx.role.kind,
                health: health_from(&status["process"]).unwrap_or(Health::Starting),
                since_ms: now_ms(),
                pid: Some(pid),
                instance_id: instance_id.clone(),
                adopted: true,
                restarts: prev.as_ref().map_or(0, |c| c.restarts),
                last_exit: prev.and_then(|c| c.last_exit),
                next_restart_at_ms: None,
            });
            slot.lifeline = Lifeline::Connection;
            slot.detail = module_detail(m.ctx.role.kind, status);
            broadcast_module_state(&m.shared, slot);
        }
        m.shared.log.info(
            &format!("{name} adopted"),
            json!({ "child": name, "pid": pid, "instanceId": instance_id }),
        );
        m.current = Some(gen.clone());
        let (s, c, g) = (m.shared.clone(), m.ctx.clone(), gen.clone());
        m.start_thread(&format!("{name}-health-{pid}"), move || {
            health_loop(&s, &c, &g)
        });
        let (s, c, g) = (m.shared.clone(), m.ctx.clone(), gen);
        m.start_thread(&format!("{name}-waiter-{pid}"), move || waiter(&s, &c, &g));
    }

    fn new(shared: Arc<Shared>, layout: &Layout, spec: Option<ChildSpec>, role: Role) -> Monitor {
        let (timing, max_bytes, keep) = {
            let st = shared.lock();
            (
                Timing::new(st.time_scale, st.config.health_interval_ms).for_kind(role.kind),
                st.config.log_max_bytes,
                st.config.log_keep,
            )
        };
        // `logs/core.out.log`; a module's is `logs/module-<name>.out.log`, beside the `module-<name>.log` it writes.
        let out_path = match role.kind {
            RoleKind::Core => layout.out_log(&role.name),
            RoleKind::Module => layout.out_log(&format!("module-{}", role.name)),
        };
        let out = match RotatingFile::open(&out_path, max_bytes, keep) {
            Ok(f) => Some(f),
            Err(e) => {
                shared.log.warn(
                    "cannot open the child's out log, its output is dropped",
                    json!({ "path": out_path.display().to_string(), "err": e.to_string() }),
                );
                None
            }
        };
        let platform = if cfg!(windows) { "windows" } else { "posix" };
        let out = Arc::new(Mutex::new(out));
        relock(&shared.out_logs).push(out.clone());
        let endpoints = layout.endpoints(&role, platform);
        let ctx = Arc::new(Ctx {
            layout: layout.clone(),
            role,
            address: endpoints.address,
            token: endpoints.token,
            timing,
            out,
        });
        Monitor {
            shared,
            ctx,
            spec,
            current: None,
            spawned: false,
        }
    }

    /// Whether a spawned process has not exited yet.
    pub fn is_running(&self) -> bool {
        self.current
            .as_ref()
            .is_some_and(|g| !g.exited.load(Ordering::SeqCst))
    }

    /// Spawns a new process unless one is running (a restart, or `daemon.start`).
    pub fn spawn(&mut self) {
        if self.is_running() {
            return;
        }
        let name = self.ctx.role.name.clone();
        if self.ctx.role.kind == RoleKind::Module {
            // Minor 3: every spawn runs the manifest as it is now; the slot's policy and apiVersion follow it.
            let id = self
                .spec
                .as_ref()
                .and_then(instance_of)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            match module_plan(&self.ctx.layout, &self.ctx.role, &id) {
                Ok(plan) => {
                    if let Some(slot) = slot_mut(&mut self.shared.lock(), &name) {
                        slot.policy = plan.policy;
                        slot.api_version = Some(plan.api_version);
                    }
                    self.spec = Some(plan.spec);
                }
                Err(e) => return mark_unspawnable(&self.shared, &name, &e),
            }
        } else if self.spec.is_none() {
            match spec_for(
                &self.ctx.layout,
                &self.ctx.role,
                &uuid::Uuid::new_v4().to_string(),
            ) {
                Ok(spec) => self.spec = Some(spec),
                Err(e) => return mark_unspawnable(&self.shared, &name, &e),
            }
        }
        let Some(base) = self.spec.as_ref() else {
            return;
        };
        let instance_id = match (self.spawned, instance_of(base)) {
            (false, Some(id)) => id,
            _ => uuid::Uuid::new_v4().to_string(),
        };
        let restart = self.spawned;
        self.spawned = true;
        let spec = with_instance(base, &instance_id);
        let mut cmd = Command::new(&spec.program);
        if let Some(dir) = &spec.cwd {
            cmd.current_dir(dir);
        }
        cmd.args(&spec.args)
            .envs(spec.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            // Its own process group: a terminal's Ctrl-C reaches the supervisor, which stops the core cleanly.
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                self.shared.log.error(
                    &format!("{name} spawn failed"),
                    json!({ "child": name, "program": spec.program.display().to_string(), "err": e.to_string() }),
                );
                if let Some(slot) = slot_mut(&mut self.shared.lock(), &name) {
                    let restarts = slot
                        .child
                        .as_ref()
                        .map_or(0, |c| c.restarts + u32::from(restart));
                    slot.child
                        .get_or_insert_with(|| fresh_child(&self.ctx.role))
                        .restarts = restarts;
                }
                record_exit(&self.shared, &name, None, None, None, false, None);
                return;
            }
        };
        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let gen = Arc::new(Gen {
            role: name.clone(),
            pid,
            started: Instant::now(),
            process: Mutex::new(Some(child)),
            stdin: Mutex::new(stdin),
            control: Mutex::new(None),
            requested: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            kill_reason: Mutex::new(None),
            last_ok: Mutex::new(Instant::now()),
            peer: None,
            lifeline_in_control: AtomicBool::new(false),
            lifeline_lost: AtomicBool::new(false),
            parked: Mutex::new(None),
            restarting: AtomicBool::new(false),
            pending_pushed: AtomicBool::new(false),
        });
        if let Some(slot) = slot_mut(&mut self.shared.lock(), &name) {
            let prev = slot.child.take();
            slot.child = Some(ChildState {
                role: name.clone(),
                kind: self.ctx.role.kind,
                health: Health::Starting,
                since_ms: now_ms(),
                pid: Some(pid),
                instance_id: Some(instance_id.clone()),
                adopted: false,
                restarts: prev.as_ref().map_or(0, |c| c.restarts + u32::from(restart)),
                last_exit: prev.and_then(|c| c.last_exit),
                next_restart_at_ms: None,
            });
            slot.lifeline = Lifeline::Stdin;
            slot.detail = None;
            broadcast_module_state(&self.shared, slot);
        }
        self.shared.log.info(
            &format!("{name} spawned"),
            json!({ "child": name, "pid": pid, "instanceId": instance_id }),
        );
        self.current = Some(gen.clone());
        for (stream_name, stream) in [
            (
                "stdout",
                stdout.map(|s| Box::new(s) as Box<dyn Read + Send>),
            ),
            (
                "stderr",
                stderr.map(|s| Box::new(s) as Box<dyn Read + Send>),
            ),
        ] {
            if let Some(stream) = stream {
                let out = self.ctx.out.clone();
                self.start_thread(&format!("{name}-{stream_name}-{pid}"), move || {
                    pump(stream, &out)
                });
            }
        }
        let (s, c, g) = (self.shared.clone(), self.ctx.clone(), gen.clone());
        self.start_thread(&format!("{name}-health-{pid}"), move || {
            health_loop(&s, &c, &g)
        });
        let (s, c, g) = (self.shared.clone(), self.ctx.clone(), gen);
        self.start_thread(&format!("{name}-waiter-{pid}"), move || waiter(&s, &c, &g));
    }

    fn start_thread<F: FnOnce() + Send + 'static>(&self, name: &str, f: F) {
        if let Err(e) = spawn_guarded(&self.shared, name, f) {
            self.shared.log.error(
                "cannot start a child thread",
                json!({ "thread": name, "err": e.to_string() }),
            );
        }
    }

    /// The stop sequence: `core.shutdown { budgetMs }` on the control connection (or a fresh one), wait until
    /// `budget` + 5 s × scale after the call, then kill. Returns once the process has exited (or could not be made to).
    pub fn stop(&mut self, budget: Duration) {
        let deadline = Instant::now() + budget + self.ctx.timing.stop_grace;
        self.stop_until(budget, deadline);
    }

    /// [`Monitor::stop`] against a `deadline` shared with other children (`daemon.stop` stops every child inside one
    /// budget, M3): the child is asked to finish within `budget` and killed at `deadline`.
    pub fn stop_until(&mut self, budget: Duration, deadline: Instant) {
        // A hard limit: everything below, delivery of `core.shutdown` included, fits before the deadline; only the
        // reaping after a kill may add up to POST_KILL_WAIT.
        let name = self.ctx.role.name.clone();
        if let Some(slot) = slot_mut(&mut self.shared.lock(), &name) {
            slot.restart_at = None;
            if let Some(c) = slot.child.as_mut() {
                c.next_restart_at_ms = None;
            }
        }
        let Some(gen) = self.current.clone() else {
            return;
        };
        if gen.exited.load(Ordering::SeqCst) {
            return;
        }
        gen.requested.store(true, Ordering::SeqCst);
        set_health(&self.shared, &gen, Health::Stopping, true);
        // Whole milliseconds, rounded up: a budget that has only lost microseconds on its way here stays what the
        // caller gave.
        let budget_ms = budget.as_micros().div_ceil(1000).min(120_000) as u64;
        self.shared.log.info(
            &format!("stopping {name}"),
            json!({ "pid": gen.pid, "budgetMs": budget_ms }),
        );
        // On a helper thread, bounded here: the calls have their own read deadlines, but the stop must stay within its
        // budget whatever they add up to; a hung core is killed below instead.
        let (tx, rx) = std::sync::mpsc::channel();
        let (c, g) = (self.ctx.clone(), gen.clone());
        self.start_thread(&format!("{}-shutdown-{}", gen.role, gen.pid), move || {
            let params = json!({ "budgetMs": budget_ms });
            let method = c.role.method("shutdown");
            let mut sent = false;
            if let Ok(mut ctl) = g.control.try_lock() {
                if let Some(client) = ctl.as_mut() {
                    sent = client.call(&method, params.clone()).is_ok();
                }
            }
            if !sent {
                if let Some(mut client) = connect(&c, g.pid) {
                    sent = client.call(&method, params).is_ok();
                }
            }
            let _ = tx.send(sent);
        });
        let wait = (self.ctx.timing.poll_deadline * 2)
            .min(deadline.saturating_duration_since(Instant::now()));
        let sent = rx.recv_timeout(wait).unwrap_or(false);
        if !sent {
            self.shared.log.warn(
                &format!("{} not delivered", self.ctx.role.method("shutdown")),
                json!({ "pid": gen.pid }),
            );
            #[cfg(unix)]
            gen.terminate();
            #[cfg(windows)]
            gen.kill();
        }
        if !wait_exited(&gen, deadline) {
            self.shared.log.warn(
                &format!("{name} did not stop in time, killing"),
                json!({ "pid": gen.pid }),
            );
            gen.kill();
            if !wait_exited(&gen, Instant::now() + POST_KILL_WAIT) {
                self.shared.log.error(
                    &format!("{name} not reaped after the kill"),
                    json!({ "pid": gen.pid }),
                );
            }
        }
    }
}

impl Monitor {
    /// When the running process was spawned (or adopted); `None` while none runs.
    pub fn running_since(&self) -> Option<Instant> {
        self.current
            .as_ref()
            .filter(|g| !g.exited.load(Ordering::SeqCst))
            .map(|g| g.started)
    }

    /// The stop half of a requested restart (B8: a plan stops its modules before the core and starts them after):
    /// like [`Monitor::stop`], but the exit is recorded as a requested restart's (reason `none`).
    pub fn stop_restarting(&mut self, budget: Duration) {
        if let Some(g) = self
            .current
            .as_ref()
            .filter(|g| !g.exited.load(Ordering::SeqCst))
        {
            g.restarting.store(true, Ordering::SeqCst);
        }
        self.stop(budget);
    }

    /// A requested restart (B8): the stop sequence with `budget`, then a spawn. Its exit is `Requested` (reason
    /// `none`), so it never counts toward the give-up budget. A core that is `crashed` for good (fatal or given up)
    /// has its backoff reset first.
    pub fn restart_requested(&mut self, budget: Duration) {
        let pid = self
            .current
            .as_ref()
            .filter(|g| !g.exited.load(Ordering::SeqCst))
            .map(|g| {
                g.restarting.store(true, Ordering::SeqCst);
                g.pid
            });
        let name = self.ctx.role.name.clone();
        if let Some(slot) = slot_mut(&mut self.shared.lock(), &name) {
            // B8 (M2): only a fatal crash (no restart scheduled) or a given-up backoff; a retryable crash waiting in
            // backoff keeps its attempt count.
            if super::state::crashed_for_good(slot.child.as_ref(), slot.backoff.given_up()) {
                slot.backoff.reset();
            }
        }
        self.shared.log.info(
            &format!("restarting {name} (requested)"),
            json!({ "pid": pid }),
        );
        self.stop(budget);
        if self.shared.lock().stopping.is_some() {
            return;
        }
        self.spawn();
    }
}

fn wait_exited(gen: &Gen, deadline: Instant) -> bool {
    while !gen.exited.load(Ordering::SeqCst) {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

/// How long [`Monitor::stop`] waits past the budget before it kills (5 s × `scale`).
pub fn stop_grace(scale: f64) -> Duration {
    Timing::new(scale, 5_000).stop_grace
}

/// H3-R11: the child cannot be spawned at all (core.js missing: `config-invalid`; a module whose manifest is invalid
/// or whose apiVersion is unsupported). The supervisor stays up and shows the child as crashed for good with that
/// reason, no restart scheduled, until `daemon.start` (or `module.start`) finds it spawnable.
pub fn mark_unspawnable(shared: &Shared, role: &str, (reason, err): &Unspawnable) {
    shared.log.error(
        "cannot spawn the child",
        json!({ "child": role, "err": err, "reason": reason.as_str() }),
    );
    let at = now_ms();
    let mut st = shared.lock();
    let Some(slot) = slot_mut(&mut st, role) else {
        return;
    };
    slot.restart_at = None;
    let role = slot.role.clone();
    let c = slot.child.get_or_insert_with(|| fresh_child(&role));
    c.health = Health::Crashed {
        code: None,
        signal: None,
        at,
        reason: Some(reason.to_string()),
    };
    c.since_ms = at;
    c.pid = None;
    c.instance_id = None;
    c.next_restart_at_ms = None;
    slot.lifeline = Lifeline::None;
    broadcast_module_state(shared, slot);
}

fn fresh_child(role: &Role) -> ChildState {
    ChildState {
        since_ms: now_ms(),
        ..ChildState::fresh(role)
    }
}

/// Copies one of the child's output streams into the out log until EOF.
fn pump(mut stream: Box<dyn Read + Send>, out: &Mutex<Option<RotatingFile>>) {
    let mut buf = [0u8; 8192];
    loop {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                if let Some(f) = relock(out).as_mut() {
                    let _ = f.write_all(&buf[..n]).and_then(|_| f.flush());
                }
            }
        }
    }
}

/// Connects to the child and authenticates with its token (`run/core.token`); accepts only a child whose hello names
/// `pid`.
fn connect(ctx: &Ctx, pid: u32) -> Option<Client> {
    let token = std::fs::read_to_string(&ctx.token).ok()?;
    let opts = ConnectOptions {
        connect_timeout: ctx.timing.poll_deadline,
        call_timeout: ctx.timing.poll_deadline,
        endpoint: super::adopt::rpc_endpoint(&ctx.role),
        expected_server_pid: Some(pid),
    };
    let client = Client::connect(&ctx.address, token.trim(), opts).ok()?;
    (client.hello()["pid"].as_u64() == Some(u64::from(pid))).then_some(client)
}

/// The core's own `process` state as a [`Health`].
fn health_from(process: &Value) -> Option<Health> {
    let reason = process["reason"].as_str().map(str::to_string);
    Some(match process["state"].as_str()? {
        "starting" => Health::Starting,
        "ready" => Health::Ready,
        "degraded" => Health::Degraded(reason.unwrap_or_else(|| "unknown".into())),
        "orphaned" => Health::Orphaned {
            since: process["since"].as_u64().unwrap_or_else(now_ms),
        },
        "stopping" => Health::Stopping,
        _ => return None,
    })
}

/// A module's `module.status.detail` (`None` for the core, or when the module reports none).
fn module_detail(kind: RoleKind, status: &Value) -> Option<Value> {
    (kind == RoleKind::Module)
        .then(|| status.get("detail").filter(|d| d.is_object()).cloned())
        .flatten()
}

/// Keeps a module's polled `module.status.detail` in its slot (`module.list`), while `gen` is the current process.
fn record_detail(shared: &Shared, ctx: &Ctx, gen: &Gen, status: &Value) {
    if ctx.role.kind != RoleKind::Module {
        return;
    }
    let mut st = shared.lock();
    if let Some(slot) = slot_mut(&mut st, &gen.role) {
        if slot.child.as_ref().is_some_and(|c| c.pid == Some(gen.pid)) {
            slot.detail = module_detail(RoleKind::Module, status);
        }
    }
}

/// Updates the child's health if `gen` is still the current process. Once a stop was requested only `Stopping`
/// (`force`) is written.
fn set_health(shared: &Shared, gen: &Gen, health: Health, force: bool) {
    let mut st = shared.lock();
    if !force && gen.requested.load(Ordering::SeqCst) {
        return;
    }
    let Some(slot) = slot_mut(&mut st, &gen.role) else {
        return;
    };
    if let Some(c) = slot.child.as_mut().filter(|c| c.pid == Some(gen.pid)) {
        if c.health != health {
            c.health = health;
            c.since_ms = now_ms();
            broadcast_module_state(shared, slot);
        }
    }
}

/// Sleeps `d` in short steps; returns false when the process exited meanwhile.
fn sleep_while_alive(gen: &Gen, d: Duration) -> bool {
    let until = Instant::now() + d;
    loop {
        if gen.exited.load(Ordering::SeqCst) {
            return false;
        }
        let now = Instant::now();
        if now >= until {
            return true;
        }
        std::thread::sleep((until - now).min(WAITER_TICK));
    }
}

/// Readiness (connect + `core.auth` every 100 ms), then `core.status` every health interval. It only observes:
/// the waiter enforces the ready timeout and the hang threshold.
fn health_loop(shared: &Shared, ctx: &Ctx, gen: &Gen) {
    if gen.peer.is_none() {
        wait_ready(shared, ctx, gen);
    }
    poll_loop(shared, ctx, gen);
    // An adopted core keeps its lifeline until it has exited; closing it now would orphan a core being stopped.
    let last = relock(&gen.control).take();
    if gen.lifeline_in_control.swap(false, Ordering::SeqCst) {
        *relock(&gen.parked) = last;
    }
}

/// Readiness of a spawned core: connect + `core.auth` every 100 ms, then one `core.status`; the connection becomes
/// the control connection.
fn wait_ready(shared: &Shared, ctx: &Ctx, gen: &Gen) {
    let t = ctx.timing;
    let mut client = loop {
        if gen.exited.load(Ordering::SeqCst) || gen.requested.load(Ordering::SeqCst) {
            return;
        }
        if let Some(c) = connect(ctx, gen.pid) {
            break c;
        }
        if !sleep_while_alive(gen, t.ready_poll) {
            return;
        }
    };
    // B12: a module must say it is the module the manifest describes; one that does not is killed, and the exit is
    // fatal `manifest-invalid` (a retry would report the same identity).
    if ctx.role.kind == RoleKind::Module {
        let api = shared
            .lock()
            .slot(&ctx.role.name)
            .and_then(|s| s.api_version.clone());
        if let Some(reason) =
            super::adopt::identity_mismatch(client.hello(), &ctx.role, api.as_deref())
        {
            shared.log.warn(
                &format!("{} reports another identity, killing", gen.role),
                json!({ "pid": gen.pid, "reason": reason, "hello": client.hello()["module"] }),
            );
            *relock(&gen.kill_reason) = Some(CrashReason::ManifestInvalid);
            gen.kill();
            return;
        }
    }
    let status = client.call(&ctx.role.method("status"), json!({})).ok();
    let first = (
        status
            .as_ref()
            .and_then(|s| health_from(&s["process"]))
            // Authenticated but no state yet: stay `starting` until a poll reports one.
            .unwrap_or(Health::Starting),
        status,
    );
    let now = Instant::now();
    *relock(&gen.last_ok) = now;
    gen.ready.store(true, Ordering::SeqCst);
    {
        let mut st = shared.lock();
        if let Some(slot) = slot_mut(&mut st, &gen.role) {
            slot.backoff.on_ready(now);
        }
        if ctx.role.kind == RoleKind::Core {
            st.core_ready_ms = Some(gen.started.elapsed().as_millis() as u64);
        }
    }
    if let Some(status) = &first.1 {
        record_detail(shared, ctx, gen, status);
    }
    set_health(shared, gen, first.0, false);
    if let Some(status) = &first.1 {
        check_restart_pending(shared, ctx, gen, status);
    }
    shared.log.info(
        &format!("{} ready", gen.role),
        json!({ "child": gen.role, "pid": gen.pid, "readyMs": gen.started.elapsed().as_millis() as u64 }),
    );
    *relock(&gen.control) = Some(client);
}

/// `core.status` every health interval, on the control connection (an adopted core's lifeline while it works).
fn poll_loop(shared: &Shared, ctx: &Ctx, gen: &Gen) {
    let mut failures: u32 = 0;
    loop {
        let t = ctx.timing.current(shared);
        if !sleep_while_alive(gen, t.health_interval) || gen.requested.load(Ordering::SeqCst) {
            break;
        }
        let result = {
            let mut ctl = relock(&gen.control);
            if ctl.is_none() {
                *ctl = connect(ctx, gen.pid);
            }
            match ctl.as_mut() {
                None => Err("cannot connect".to_string()),
                Some(c) => {
                    let r = c
                        .call(&ctx.role.method("status"), json!({}))
                        .map_err(|e| e.to_string());
                    if c.is_poisoned() {
                        let old = ctl.take(); // reconnect at the next poll
                        if gen.lifeline_in_control.swap(false, Ordering::SeqCst) {
                            // The adopted core's lifeline hit EOF or an error: keep it open, poll on fresh
                            // connections, and let the waiter check whether the core is gone.
                            *relock(&gen.parked) = old;
                            gen.lifeline_lost.store(true, Ordering::SeqCst);
                        }
                    }
                    r
                }
            }
        };
        match result {
            Ok(status) => {
                if failures >= UNRESPONSIVE_AFTER {
                    shared.log.info(
                        &format!("{} responsive again", gen.role),
                        json!({ "pid": gen.pid }),
                    );
                }
                failures = 0;
                *relock(&gen.last_ok) = Instant::now();
                record_detail(shared, ctx, gen, &status);
                if let Some(h) = health_from(&status["process"]) {
                    set_health(shared, gen, h, false);
                }
                check_restart_pending(shared, ctx, gen, &status);
            }
            Err(e) => {
                if gen.exited.load(Ordering::SeqCst) || gen.requested.load(Ordering::SeqCst) {
                    break;
                }
                failures += 1;
                shared.log.warn(
                    "health poll failed",
                    json!({ "pid": gen.pid, "failures": failures, "err": e }),
                );
                if failures == UNRESPONSIVE_AFTER {
                    shared.log.warn(
                        &format!("{} unresponsive", gen.role),
                        json!({ "pid": gen.pid }),
                    );
                    set_health(shared, gen, Health::Degraded("unresponsive".into()), false);
                }
            }
        }
    }
}

/// B7: a core whose configuration differs from the one it started with in a `core`-class key reports
/// `config.restartPending`; one requested restart is queued per generation (none while a stop or another restart job
/// is on its way: that one replaces this process anyway).
fn check_restart_pending(shared: &Shared, ctx: &Ctx, gen: &Gen, status: &Value) {
    // Only the core reports `config.restartPending`; a module's config changes are restarted by the plan (Task 10).
    if ctx.role.kind != RoleKind::Core
        || status["config"]["restartPending"] != true
        || gen.requested.load(Ordering::SeqCst)
        || gen.pending_pushed.load(Ordering::SeqCst)
    {
        return;
    }
    {
        let st = shared.lock();
        if st.restart_running || !st.restart_jobs.is_empty() || st.stopping.is_some() {
            return;
        }
    }
    let plan = plur1bus_config::Restart {
        core: true,
        ..Default::default()
    };
    if super::push_restart(shared, plan).is_some() {
        gen.pending_pushed.store(true, Ordering::SeqCst);
        shared.log.info(
            &format!("{} reports a pending core-class config change", gen.role),
            json!({ "pid": gen.pid }),
        );
    }
}

/// Reaps the process and enforces the ready timeout and the hang threshold (S8).
fn waiter(shared: &Arc<Shared>, ctx: &Arc<Ctx>, gen: &Arc<Gen>) {
    let t = ctx.timing;
    let hung = format!("{} hung, terminating", gen.role);
    let mut hung_since: Option<Instant> = None;
    let (mut terminated, mut killed) = (false, false);
    let status = loop {
        if let Some(peer) = &gen.peer {
            // An adopted core is not our child: its exit is its lifeline failing plus the process being gone. During
            // a requested stop the health loop no longer polls, so liveness alone decides.
            let watch =
                gen.lifeline_lost.load(Ordering::SeqCst) || gen.requested.load(Ordering::SeqCst);
            if watch && !peer.alive() {
                break None;
            }
        } else {
            match gen.try_wait() {
                Ok(Some(s)) => break Some(s),
                Ok(None) => {}
                Err(e) => {
                    shared.log.error(
                        &format!("cannot wait for the {}", gen.role),
                        json!({ "pid": gen.pid, "err": e.to_string() }),
                    );
                    gen.kill();
                    break relock(&gen.process).as_mut().and_then(|c| c.wait().ok());
                }
            }
        }
        if !gen.requested.load(Ordering::SeqCst) {
            let ready = gen.ready.load(Ordering::SeqCst);
            if !ready && gen.started.elapsed() >= t.ready_timeout {
                let mut reason = relock(&gen.kill_reason);
                if reason.is_none() {
                    *reason = Some(CrashReason::ReadyTimeout);
                    drop(reason);
                    shared.log.warn(
                        &format!("{} not ready in time, killing", gen.role),
                        json!({ "pid": gen.pid, "readyTimeoutMs": t.ready_timeout.as_millis() as u64 }),
                    );
                    gen.kill();
                }
            }
            if ready && hung_since.is_none() {
                let silent = relock(&gen.last_ok).elapsed();
                if silent >= t.current(shared).hang {
                    hung_since = Some(Instant::now());
                    shared.log.warn(
                        &hung,
                        json!({ "pid": gen.pid, "silentMs": silent.as_millis() as u64, "step": "shutdown" }),
                    );
                    let (c, g) = (ctx.clone(), gen.clone());
                    let thread = format!("{}-shutdown-{}", gen.role, gen.pid);
                    let _ = spawn_guarded(shared, &thread, move || {
                        if let Some(mut client) = connect(&c, g.pid) {
                            let _ = client.call(&c.role.method("shutdown"), json!({}));
                        }
                    });
                }
            }
            if let Some(t0) = hung_since {
                let since = t0.elapsed();
                if !terminated && since >= t.term_after {
                    terminated = true;
                    #[cfg(unix)]
                    {
                        shared
                            .log
                            .warn(&hung, json!({ "pid": gen.pid, "step": "terminate" }));
                        gen.terminate();
                    }
                }
                if !killed && since >= t.term_after + t.kill_after {
                    killed = true;
                    shared
                        .log
                        .warn(&hung, json!({ "pid": gen.pid, "step": "kill" }));
                    gen.kill();
                }
            }
        }
        std::thread::sleep(WAITER_TICK);
    };
    let (code, signal) = match status {
        Some(s) => exit_parts(&s),
        None => (None, None),
    };
    let requested = gen.requested.load(Ordering::SeqCst);
    let killed_for = *relock(&gen.kill_reason);
    let forced = match gen.peer {
        Some(_) => killed_for.or(Some(CrashReason::AdoptedExit)),
        None => killed_for,
    };
    record_exit(
        shared,
        &gen.role,
        Some(gen),
        code,
        signal,
        requested,
        forced,
    );
}

fn exit_parts(s: &ExitStatus) -> (Option<i32>, Option<i32>) {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        (s.code(), s.signal())
    }
    #[cfg(not(unix))]
    {
        (s.code(), None)
    }
}

#[cfg(unix)]
fn signal_name(n: i32) -> String {
    let name = match n {
        libc::SIGTERM => "SIGTERM",
        libc::SIGKILL => "SIGKILL",
        libc::SIGINT => "SIGINT",
        libc::SIGHUP => "SIGHUP",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGABRT => "SIGABRT",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGBUS => "SIGBUS",
        libc::SIGILL => "SIGILL",
        libc::SIGFPE => "SIGFPE",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGALRM => "SIGALRM",
        _ => return format!("SIG{n}"),
    };
    name.to_string()
}

#[cfg(not(unix))]
fn signal_name(n: i32) -> String {
    format!("SIG{n}")
}

/// Classifies an exit (S9, per role: [`classify_exit_for`]) and applies the slot's restart policy
/// ([`apply_policy`]), then updates the child: `Requested` or `Exited` → stopped; `Fatal` or `Final` → crashed, no
/// restart; `Retryable` → crashed with a restart scheduled in the slot's `restart_at`, or crashed for good once its
/// backoff gives up. `gen.exited` flips under the same lock, so the scheduler and the stop sequence see the final
/// state. `gen` is `None` for a spawn that failed. `role` names the slot. A module's change is broadcast
/// (`module.state`).
fn record_exit(
    shared: &Shared,
    role: &str,
    gen: Option<&Gen>,
    code: Option<i32>,
    signal: Option<i32>,
    requested: bool,
    forced: Option<CrashReason>,
) {
    let now = Instant::now();
    let at = now_ms();
    let mut st = shared.lock();
    let requested = requested || st.stopping.is_some();
    let Some(slot) = slot_mut(&mut st, role) else {
        // A monitor's slot is never removed; should it be missing, the process still counts as exited, so no stop
        // waits for it.
        if let Some(g) = gen {
            mark_exited(g);
        }
        shared.wake.notify_all();
        return;
    };
    let signal_str = signal.map(signal_name);
    let crashed = |reason: &Option<String>| Health::Crashed {
        code,
        signal: signal_str.clone(),
        at,
        reason: reason.clone(),
    };
    let restarting = gen.is_some_and(|g| g.restarting.load(Ordering::SeqCst));
    let class = match forced {
        // B12: a spawned module that reported another identity was killed for it; retrying cannot fix that.
        Some(CrashReason::ManifestInvalid) if !requested => ExitClass::Fatal {
            reason: CrashReason::ManifestInvalid.to_string(),
        },
        _ => apply_policy(
            classify_exit_for(slot.role.kind, code, signal, requested),
            slot.policy,
            code,
        ),
    };
    // `(health, the exit's own reason, next restart)`: a give-up shows `gave-up` as its state's reason (H3B-R26), while
    // `lastExit.reason` keeps what the exit itself was.
    let (health, reason, next) = match class {
        // A requested restart's exit is recorded with the reason `none`: not a crash, and nothing more specific.
        ExitClass::Requested if restarting => (
            Health::Stopped { reason: None },
            Some(CrashReason::None.to_string()),
            None,
        ),
        ExitClass::Requested => (Health::Stopped { reason: None }, None, None),
        ExitClass::Exited => (Health::Stopped { reason: None }, None, None),
        ExitClass::Fatal { reason } => {
            let reason = Some(reason);
            (crashed(&reason), reason, None)
        }
        ExitClass::Final { reason } => {
            let reason = forced.map(|r| r.to_string()).or(reason);
            (crashed(&reason), reason, None)
        }
        ExitClass::Retryable { reason } => {
            let lock_held = reason.as_deref() == Some(CrashReason::LockHeld.as_str());
            let reason = forced.map(|r| r.to_string()).or(reason);
            let decision = if lock_held {
                slot.backoff.on_lock_held_exit(now)
            } else {
                slot.backoff.on_exit(now)
            };
            match decision {
                RestartDecision::After(d) => {
                    slot.restart_at = Some(now + d);
                    (crashed(&reason), reason, Some(at + d.as_millis() as u64))
                }
                RestartDecision::GiveUp => (
                    crashed(&Some(CrashReason::GaveUp.to_string())),
                    reason,
                    None,
                ),
            }
        }
    };
    let state = health.to_process_state(at)["state"].clone();
    let slot_role = slot.role.clone();
    let c = slot.child.get_or_insert_with(|| fresh_child(&slot_role));
    c.health = health;
    c.since_ms = at;
    c.pid = None;
    c.instance_id = None;
    c.last_exit = Some(LastExit {
        code,
        signal: signal_str.clone(),
        at,
        reason: reason.clone(),
    });
    c.next_restart_at_ms = next;
    slot.lifeline = Lifeline::None;
    broadcast_module_state(shared, slot);
    // Logged before `exited` flips: the stop sequence returns as soon as it sees `exited`, and after `daemon.stop` the
    // supervisor then logs `supervisor stopped` and ends the process, which on Windows could beat this thread's line
    // (a stopped core with no exit logged, or a restart's `spawned` before its `exited`).
    shared.log.info(
        &format!("{role} exited"),
        json!({
            "child": role, "pid": gen.map(|g| g.pid), "code": code, "signal": signal_str,
            "state": state, "reason": reason, "nextRestartAt": next,
        }),
    );
    if let Some(g) = gen {
        mark_exited(g);
    }
    shared.wake.notify_all();
}

/// Flips `gen.exited` and drops what it held: the lifeline, the process handle, a parked connection.
fn mark_exited(g: &Gen) {
    g.exited.store(true, Ordering::SeqCst);
    relock(&g.stdin).take();
    relock(&g.process).take();
    relock(&g.parked).take();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_spec_passes_home_lifeline_and_instance() {
        if std::env::var_os("PLUR1BUS_CORE_JS").is_some() {
            return; // the environment overrides the lookup; nothing to check here
        }
        let dir = std::env::temp_dir().join(format!("p1b spec ü {}", std::process::id()));
        let core_js = dir.join("runtime").join("core").join("core.js");
        std::fs::create_dir_all(core_js.parent().unwrap()).unwrap();
        std::fs::write(&core_js, "").unwrap();
        let id = "0b7a6a6e-2f1d-4c1e-9a55-6d7e8f901234";
        let spec = core_spec(&Layout::new(dir.clone()), id);
        let _ = std::fs::remove_dir_all(&dir);
        let spec = spec.unwrap();
        assert_eq!(spec.role, "core");
        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[0], core_js.to_string_lossy());
        assert_eq!(
            &args[1..7],
            &[
                "--home",
                &dir.to_string_lossy(),
                "--lifeline",
                "stdin",
                "--instance",
                id
            ]
        );
        assert_eq!(instance_of(&spec).as_deref(), Some(id));
        let other = with_instance(&spec, "x");
        assert_eq!(instance_of(&other).as_deref(), Some("x"));
    }

    #[test]
    fn module_spec_runs_the_entry_in_its_own_directory_with_home_module_lifeline_and_instance() {
        let home = std::env::temp_dir().join(format!("p1b mod ü {}", std::process::id()));
        let layout = Layout::new(home.clone());
        let dir = home.join("modules").join("fixture");
        let raw = json!({ "name": "fixture", "version": "0.1.0", "apiVersion": "1", "entry": "dist/index.js",
            "scope": "installation", "priority": 500 })
        .to_string();
        let m = Installed {
            name: "fixture".into(),
            dir: dir.clone(),
            manifest: crate::modules::parse_manifest(&raw),
        };
        let id = "0b7a6a6e-2f1d-4c1e-9a55-6d7e8f901234";
        let spec = module_spec(&layout, &m, id).unwrap();
        assert_eq!(spec.role, "fixture");
        assert_eq!(spec.cwd.as_deref(), Some(dir.as_path()));
        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                dir.join("dist/index.js").to_string_lossy().into_owned(),
                "--home".into(),
                home.to_string_lossy().into_owned(),
                "--module".into(),
                "fixture".into(),
                "--lifeline".into(),
                "stdin".into(),
                "--instance".into(),
                id.into(),
            ]
        );
        assert_eq!(instance_of(&spec).as_deref(), Some(id));
        // lifeline: false → no --lifeline stdin (H3B-R25).
        let mut no_lifeline = m.clone();
        if let Ok(man) = no_lifeline.manifest.as_mut() {
            man.lifeline = false;
        }
        let args: Vec<String> = module_spec(&layout, &no_lifeline, id)
            .unwrap()
            .args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(
            !args.iter().any(|a| a == "--lifeline" || a == "stdin"),
            "{args:?}"
        );
        assert_eq!(
            args[args.len() - 2..],
            ["--instance".to_string(), id.to_string()]
        );
        // An invalid manifest cannot be spawned; spec_for says so for a module that is not installed.
        let broken = Installed {
            manifest: Err(vec!["/priority too big".into()]),
            ..m
        };
        assert!(module_spec(&layout, &broken, id)
            .unwrap_err()
            .contains("/priority too big"));
        let (reason, err) = spec_for(&layout, &Role::module("fixture"), id).unwrap_err();
        assert_eq!(reason, CrashReason::ManifestInvalid);
        assert!(err.contains("not installed"), "{err}");
    }

    #[test]
    fn core_spec_fails_without_core_js() {
        if std::env::var_os("PLUR1BUS_CORE_JS").is_some() {
            return;
        }
        let layout = Layout::new(PathBuf::from("/nonexistent-p1b-home"));
        assert!(core_spec(&layout, "id")
            .unwrap_err()
            .contains("core.js not found"));
    }

    #[test]
    fn health_follows_the_core_process_state() {
        assert_eq!(
            health_from(&json!({ "state": "ready" })),
            Some(Health::Ready)
        );
        assert_eq!(
            health_from(&json!({ "state": "degraded", "reason": "x" })),
            Some(Health::Degraded("x".into()))
        );
        assert_eq!(
            health_from(&json!({ "state": "orphaned", "since": 5 })),
            Some(Health::Orphaned { since: 5 })
        );
        assert_eq!(health_from(&json!({ "state": "crashed" })), None);
        assert_eq!(health_from(&json!({})), None);
    }

    #[test]
    fn timing_scales_everything_but_the_poll_cadence_and_deadline() {
        let t = Timing::new(0.02, 5_000);
        assert_eq!(t.health_interval, Duration::from_millis(100));
        assert_eq!(t.ready_timeout, Duration::from_millis(1200));
        assert_eq!(t.hang, Duration::from_millis(600));
        assert_eq!(t.term_after, Duration::from_millis(40));
        assert_eq!(t.kill_after, Duration::from_millis(200));
        assert_eq!(t.stop_grace, Duration::from_millis(100));
        assert_eq!(t.ready_poll, Duration::from_millis(100));
        assert_eq!(t.poll_deadline, Duration::from_secs(2));
        // Three polls always fit in the hang threshold.
        assert_eq!(Timing::new(1.0, 60_000).hang, Duration::from_secs(180));
        assert_eq!(Timing::new(1.0, 5_000).hang, Duration::from_secs(30));
    }

    #[test]
    fn a_module_ready_timeout_has_a_floor_only_below_it() {
        let t = Timing::new(0.02, 5_000);
        assert_eq!(
            t.for_kind(RoleKind::Core).ready_timeout,
            Duration::from_millis(1200)
        );
        assert_eq!(
            t.for_kind(RoleKind::Module).ready_timeout,
            MODULE_READY_FLOOR
        );
        // Production (scale 1): both keep 60 s.
        for kind in [RoleKind::Core, RoleKind::Module] {
            assert_eq!(ready_timeout(kind, 1.0), Duration::from_secs(60));
            assert_eq!(
                Timing::new(1.0, 5_000).for_kind(kind).ready_timeout,
                Duration::from_secs(60)
            );
        }
        assert_eq!(
            ready_timeout(RoleKind::Module, 0.5),
            Duration::from_secs(30)
        );
    }

    /// The stop sequence returns once `gen.exited` is set, and the supervisor then logs `supervisor stopped` and exits
    /// the process. The exit's own log line must be written by then: were `exited` set first, the process could end
    /// (seen on Windows) before the waiter thread wrote `core exited`.
    #[test]
    fn an_exit_is_logged_before_it_is_marked_exited() {
        let shared = Arc::new(Shared {
            state: Mutex::new(crate::supervisor::test_state()),
            wake: std::sync::Condvar::new(),
            log: crate::supervisor::Log::none(),
            config: Mutex::new(Default::default()),
            subscribers: Default::default(),
            out_logs: Mutex::new(Vec::new()),
        });
        let gen = Arc::new(Gen {
            role: "core".into(),
            pid: 1,
            started: Instant::now(),
            process: Mutex::new(None),
            stdin: Mutex::new(None),
            control: Mutex::new(None),
            requested: AtomicBool::new(true),
            ready: AtomicBool::new(true),
            exited: AtomicBool::new(false),
            kill_reason: Mutex::new(None),
            last_ok: Mutex::new(Instant::now()),
            peer: None,
            lifeline_in_control: AtomicBool::new(false),
            lifeline_lost: AtomicBool::new(false),
            parked: Mutex::new(None),
            restarting: AtomicBool::new(false),
            pending_pushed: AtomicBool::new(false),
        });
        // Holding the log's file lock blocks every log line; record_exit must not flip `exited` before its line.
        let held = relock(&shared.log.file);
        let (s, g) = (shared.clone(), gen.clone());
        let t = std::thread::spawn(move || {
            record_exit(&s, "core", Some(&g), Some(0), None, true, None)
        });
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            !gen.exited.load(Ordering::SeqCst),
            "exited was set before the exit was logged"
        );
        drop(held);
        t.join().unwrap();
        assert!(gen.exited.load(Ordering::SeqCst));
    }

    #[test]
    fn the_health_interval_follows_the_running_configuration() {
        let shared = Shared {
            state: Mutex::new(crate::supervisor::test_state()),
            wake: std::sync::Condvar::new(),
            log: crate::supervisor::Log::none(),
            config: Mutex::new(Default::default()),
            subscribers: Default::default(),
            out_logs: Mutex::new(Vec::new()),
        };
        let t = Timing::new(0.02, 5_000);
        shared.lock().config.health_interval_ms = 60_000;
        let now = t.current(&shared);
        assert_eq!(now.health_interval, Duration::from_millis(1200));
        assert_eq!(now.hang, Duration::from_millis(3600));
        assert_eq!(now.ready_timeout, t.ready_timeout);
    }
}
