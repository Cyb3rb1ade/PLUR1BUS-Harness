//! Spawning and monitoring a child (spec §6.4): the core in supervised mode.
//!
//! Per spawn (a "generation") the supervisor holds the only write end of the child's stdin (its lifeline, S4) and
//! runs three kinds of std threads (S14): the output pumps (stdout and stderr into `logs/<role>.out.log`), a health
//! loop (readiness through the `core.auth` handshake, then `core.status` every `supervisor.healthIntervalMs`), and a
//! waiter that reaps the process and is the only place that decides to kill it (ready timeout, hang). An exit goes
//! through [`classify_exit`] and [`Backoff`](super::state::Backoff); a scheduled restart is left in
//! `SupervisorState::restart_at` for the main thread's scheduler, which calls [`Monitor::spawn`]. Every duration below
//! except the 100 ms readiness poll and the 2 s poll deadline is multiplied by the time scale.
use super::logfile::RotatingFile;
use super::state::{
    classify_exit, ChildState, CrashReason, ExitClass, Health, LastExit, RestartDecision,
};
use super::{now_ms, spawn_guarded, Lifeline, Shared};
use crate::commands::core::{locate_core_js, locate_node};
use crate::paths::{core_address, Layout};
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
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
    })
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
    /// `supervisor.healthIntervalMs` × scale, and the deadline of each `core.status`.
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
}

/// Consecutive failed polls before `degraded("unresponsive")` (S8).
const UNRESPONSIVE_AFTER: u32 = 3;
/// How often the waiter checks the process and its watchdogs.
const WAITER_TICK: Duration = Duration::from_millis(25);

impl Timing {
    fn new(scale: f64, health_interval_ms: u64) -> Self {
        let s = |ms: u64| Duration::from_secs_f64(ms as f64 / 1000.0 * scale);
        Self {
            ready_poll: Duration::from_millis(100),
            ready_timeout: s(60_000),
            health_interval: s(health_interval_ms),
            poll_deadline: Duration::from_secs(2),
            // A long configured interval must not look like a hang between two healthy polls.
            hang: s(30_000).max(s(health_interval_ms) * UNRESPONSIVE_AFTER),
            term_after: s(2_000),
            kill_after: s(10_000),
            stop_grace: s(5_000),
        }
    }
}

struct Ctx {
    layout: Layout,
    address: String,
    timing: Timing,
    /// `logs/<role>.out.log`, shared by every generation's pumps.
    out: Arc<Mutex<Option<RotatingFile>>>,
}

fn relock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// One spawned process.
struct Gen {
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
}

impl Gen {
    /// `Some(status)` once the process has exited (std caches it, so asking twice is fine).
    fn try_wait(&self) -> std::io::Result<Option<ExitStatus>> {
        match relock(&self.process).as_mut() {
            Some(c) => c.try_wait(),
            None => Ok(None),
        }
    }
    /// SIGKILL / TerminateProcess, unless it has already exited.
    fn kill(&self) {
        if let Some(c) = relock(&self.process).as_mut() {
            let _ = c.kill();
        }
    }
    /// SIGTERM, unless it has already exited. The process is not reaped while the lock is held, so the pid is
    /// still ours.
    #[cfg(unix)]
    fn terminate(&self) {
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
    spec: ChildSpec,
    current: Option<Arc<Gen>>,
    spawned: bool,
}

impl Monitor {
    /// Spawns the child at once. The first process gets the spec's own `--instance`, each later one a fresh id.
    pub fn start(shared: Arc<Shared>, layout: &Layout, spec: ChildSpec) -> Monitor {
        let (timing, max_bytes, keep) = {
            let st = shared.lock();
            (
                Timing::new(st.time_scale, st.config.health_interval_ms),
                st.config.log_max_bytes,
                st.config.log_keep,
            )
        };
        let out = RotatingFile::open(layout.out_log(&spec.role), max_bytes, keep).ok();
        let platform = if cfg!(windows) { "windows" } else { "posix" };
        let ctx = Arc::new(Ctx {
            layout: layout.clone(),
            address: core_address(&layout.home, platform),
            timing,
            out: Arc::new(Mutex::new(out)),
        });
        let mut m = Monitor {
            shared,
            ctx,
            spec,
            current: None,
            spawned: false,
        };
        m.spawn();
        m
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
        let instance_id = match (self.spawned, instance_of(&self.spec)) {
            (false, Some(id)) => id,
            _ => uuid::Uuid::new_v4().to_string(),
        };
        let restart = self.spawned;
        self.spawned = true;
        let spec = with_instance(&self.spec, &instance_id);
        let mut cmd = Command::new(&spec.program);
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
                    "core spawn failed",
                    json!({ "child": spec.role, "program": spec.program.display().to_string(), "err": e.to_string() }),
                );
                {
                    let mut st = self.shared.lock();
                    let restarts = st
                        .child
                        .as_ref()
                        .map_or(0, |c| c.restarts + u32::from(restart));
                    st.child
                        .get_or_insert_with(|| fresh_child(&spec.role))
                        .restarts = restarts;
                }
                record_exit(&self.shared, None, None, None, false, None);
                return;
            }
        };
        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let gen = Arc::new(Gen {
            role: spec.role.clone(),
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
        });
        {
            let mut st = self.shared.lock();
            let prev = st.child.take();
            st.child = Some(ChildState {
                role: spec.role.clone(),
                health: Health::Starting,
                since_ms: now_ms(),
                pid: Some(pid),
                instance_id: Some(instance_id.clone()),
                adopted: false,
                restarts: prev.as_ref().map_or(0, |c| c.restarts + u32::from(restart)),
                last_exit: prev.and_then(|c| c.last_exit),
                next_restart_at_ms: None,
            });
            st.lifeline = Lifeline::Stdin;
        }
        self.shared.log.info(
            "core spawned",
            json!({ "child": spec.role, "pid": pid, "instanceId": instance_id }),
        );
        self.current = Some(gen.clone());
        for (name, stream) in [
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
                self.start_thread(&format!("{}-{name}-{pid}", spec.role), move || {
                    pump(stream, &out)
                });
            }
        }
        let (s, c, g) = (self.shared.clone(), self.ctx.clone(), gen.clone());
        self.start_thread(&format!("{}-health-{pid}", spec.role), move || {
            health_loop(&s, &c, &g)
        });
        let (s, c, g) = (self.shared.clone(), self.ctx.clone(), gen);
        self.start_thread(&format!("{}-waiter-{pid}", spec.role), move || {
            waiter(&s, &c, &g)
        });
    }

    fn start_thread<F: FnOnce() + Send + 'static>(&self, name: &str, f: F) {
        if let Err(e) = spawn_guarded(&self.shared, name, f) {
            self.shared.log.error(
                "cannot start a child thread",
                json!({ "thread": name, "err": e.to_string() }),
            );
        }
    }

    /// The stop sequence: `core.shutdown { budgetMs }` on the control connection (or a fresh one), wait `budget` +
    /// 5 s × scale, then kill. Returns once the process has exited (or could not be made to).
    pub fn stop(&mut self, budget: Duration) {
        {
            let mut st = self.shared.lock();
            st.restart_at = None;
            if let Some(c) = st.child.as_mut() {
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
        let budget_ms = budget.as_millis().min(120_000) as u64;
        self.shared.log.info(
            "stopping core",
            json!({ "pid": gen.pid, "budgetMs": budget_ms }),
        );
        // On a helper thread, bounded here: a Windows read has no deadline yet, and a hung core must not block the
        // stop (it is killed below instead).
        let (tx, rx) = std::sync::mpsc::channel();
        let (c, g) = (self.ctx.clone(), gen.clone());
        self.start_thread(&format!("{}-shutdown-{}", gen.role, gen.pid), move || {
            let params = json!({ "budgetMs": budget_ms });
            let mut sent = false;
            if let Ok(mut ctl) = g.control.try_lock() {
                if let Some(client) = ctl.as_mut() {
                    sent = client.call("core.shutdown", params.clone()).is_ok();
                }
            }
            if !sent {
                if let Some(mut client) = connect(&c, g.pid) {
                    sent = client.call("core.shutdown", params).is_ok();
                }
            }
            let _ = tx.send(sent);
        });
        let sent = rx
            .recv_timeout(self.ctx.timing.poll_deadline * 2)
            .unwrap_or(false);
        if !sent {
            self.shared
                .log
                .warn("core.shutdown not delivered", json!({ "pid": gen.pid }));
            #[cfg(unix)]
            gen.terminate();
            #[cfg(windows)]
            gen.kill();
        }
        if !wait_exited(&gen, Instant::now() + budget + self.ctx.timing.stop_grace) {
            self.shared.log.warn(
                "core did not stop in time, killing",
                json!({ "pid": gen.pid }),
            );
            gen.kill();
            wait_exited(&gen, Instant::now() + Duration::from_secs(5));
        }
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

fn fresh_child(role: &str) -> ChildState {
    ChildState {
        role: role.to_string(),
        health: Health::Starting,
        since_ms: now_ms(),
        pid: None,
        instance_id: None,
        adopted: false,
        restarts: 0,
        last_exit: None,
        next_restart_at_ms: None,
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

/// Connects to the core and authenticates with `run/core.token`; accepts only a core whose hello names `pid`.
fn connect(ctx: &Ctx, pid: u32) -> Option<Client> {
    let token = std::fs::read_to_string(ctx.layout.core_token()).ok()?;
    let opts = ConnectOptions {
        connect_timeout: ctx.timing.poll_deadline,
        call_timeout: ctx.timing.poll_deadline,
        endpoint: Endpoint::Core,
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

/// Updates the child's health if `gen` is still the current process. Once a stop was requested only `Stopping`
/// (`force`) is written.
fn set_health(shared: &Shared, gen: &Gen, health: Health, force: bool) {
    let mut st = shared.lock();
    if !force && gen.requested.load(Ordering::SeqCst) {
        return;
    }
    if let Some(c) = st.child.as_mut().filter(|c| c.pid == Some(gen.pid)) {
        if c.health != health {
            c.health = health;
            c.since_ms = now_ms();
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
    let first = client
        .call("core.status", json!({}))
        .ok()
        .and_then(|s| health_from(&s["process"]))
        .unwrap_or(Health::Ready);
    let now = Instant::now();
    *relock(&gen.last_ok) = now;
    gen.ready.store(true, Ordering::SeqCst);
    shared.lock().backoff.on_ready(now);
    set_health(shared, gen, first, false);
    shared.log.info(
        "core ready",
        json!({ "child": gen.role, "pid": gen.pid, "readyMs": gen.started.elapsed().as_millis() as u64 }),
    );
    *relock(&gen.control) = Some(client);

    let mut failures: u32 = 0;
    loop {
        if !sleep_while_alive(gen, t.health_interval) {
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
                    let r = c.call("core.status", json!({})).map_err(|e| e.to_string());
                    if c.is_poisoned() {
                        *ctl = None; // reconnect at the next poll
                    }
                    r
                }
            }
        };
        match result {
            Ok(status) => {
                if failures >= UNRESPONSIVE_AFTER {
                    shared
                        .log
                        .info("core responsive again", json!({ "pid": gen.pid }));
                }
                failures = 0;
                *relock(&gen.last_ok) = Instant::now();
                if let Some(h) = health_from(&status["process"]) {
                    set_health(shared, gen, h, false);
                }
            }
            Err(e) => {
                if gen.exited.load(Ordering::SeqCst) {
                    break;
                }
                failures += 1;
                shared.log.warn(
                    "health poll failed",
                    json!({ "pid": gen.pid, "failures": failures, "err": e }),
                );
                if failures == UNRESPONSIVE_AFTER {
                    shared
                        .log
                        .warn("core unresponsive", json!({ "pid": gen.pid }));
                    set_health(shared, gen, Health::Degraded("unresponsive".into()), false);
                }
            }
        }
    }
    *relock(&gen.control) = None;
}

/// Reaps the process and enforces the ready timeout and the hang threshold (S8).
fn waiter(shared: &Arc<Shared>, ctx: &Arc<Ctx>, gen: &Arc<Gen>) {
    let t = ctx.timing;
    let mut hung_since: Option<Instant> = None;
    let (mut terminated, mut killed) = (false, false);
    let status = loop {
        match gen.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {}
            Err(e) => {
                shared.log.error(
                    "cannot wait for the core",
                    json!({ "pid": gen.pid, "err": e.to_string() }),
                );
                gen.kill();
                break relock(&gen.process).as_mut().and_then(|c| c.wait().ok());
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
                        "core not ready in time, killing",
                        json!({ "pid": gen.pid, "readyTimeoutMs": t.ready_timeout.as_millis() as u64 }),
                    );
                    gen.kill();
                }
            }
            if ready && hung_since.is_none() {
                let silent = relock(&gen.last_ok).elapsed();
                if silent >= t.hang {
                    hung_since = Some(Instant::now());
                    shared.log.warn(
                        "core hung, terminating",
                        json!({ "pid": gen.pid, "silentMs": silent.as_millis() as u64, "step": "shutdown" }),
                    );
                    let (c, g) = (ctx.clone(), gen.clone());
                    let _ =
                        spawn_guarded(shared, &format!("core-shutdown-{}", gen.pid), move || {
                            if let Some(mut client) = connect(&c, g.pid) {
                                let _ = client.call("core.shutdown", json!({}));
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
                        shared.log.warn(
                            "core hung, terminating",
                            json!({ "pid": gen.pid, "step": "terminate" }),
                        );
                        gen.terminate();
                    }
                }
                if !killed && since >= t.term_after + t.kill_after {
                    killed = true;
                    shared.log.warn(
                        "core hung, terminating",
                        json!({ "pid": gen.pid, "step": "kill" }),
                    );
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
    let forced = *relock(&gen.kill_reason);
    record_exit(shared, Some(gen), code, signal, requested, forced);
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

/// Classifies an exit (S9) and updates the child: `Requested` → stopped; `Fatal` → crashed, no restart;
/// `Retryable` → crashed with a restart scheduled in `restart_at`, or crashed for good once the backoff gives up.
/// `gen.exited` flips under the same lock, so the scheduler and the stop sequence see the final state. `gen` is
/// `None` for a spawn that failed.
fn record_exit(
    shared: &Shared,
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
    let signal_str = signal.map(signal_name);
    let crashed = |reason: &Option<String>| Health::Crashed {
        code,
        signal: signal_str.clone(),
        at,
        reason: reason.clone(),
    };
    let (health, reason, next) = match classify_exit(code, signal, requested) {
        ExitClass::Requested => (Health::Stopped { reason: None }, None, None),
        ExitClass::Fatal { reason } => {
            let reason = Some(reason);
            (crashed(&reason), reason, None)
        }
        ExitClass::Retryable { reason } => {
            let reason = forced.map(|r| r.to_string()).or(reason);
            let next = match st.backoff.on_exit(now) {
                RestartDecision::After(d) => {
                    st.restart_at = Some(now + d);
                    Some(at + d.as_millis() as u64)
                }
                RestartDecision::GiveUp => None,
            };
            (crashed(&reason), reason, next)
        }
    };
    let state = health.to_process_state(at)["state"].clone();
    let role = gen.map_or("core".to_string(), |g| g.role.clone());
    let c = st.child.get_or_insert_with(|| fresh_child(&role));
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
    st.lifeline = Lifeline::None;
    if let Some(g) = gen {
        g.exited.store(true, Ordering::SeqCst);
        relock(&g.stdin).take();
        relock(&g.process).take();
    }
    shared.log.info(
        "core exited",
        json!({
            "child": role, "pid": gen.map(|g| g.pid), "code": code, "signal": signal_str,
            "state": state, "reason": reason, "nextRestartAt": next,
        }),
    );
    shared.wake.notify_all();
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
}
