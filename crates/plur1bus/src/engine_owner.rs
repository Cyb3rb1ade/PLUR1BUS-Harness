//! RE-D173 (RX8 T8b): the Rust engine under `plur1bus core run`, the developer path without a supervisor (ADR-012 §8).
//!
//! With `engine.implementation: "node"` (or none) `core run` stays what it was: on Unix it execs the core, with the same
//! arguments and environment, after one try-lock on `run/engine.process.lock` (Nachtrag 8: a Rust engine still holding
//! the home refuses the start instead of letting a second writer in). With `"rust"` the shared engine specification
//! ([`crate::engine_process::configured_spec`], the one the supervisor's slot runs) makes `core run` stay as a wrapper:
//!
//! 1. It spawns `plur1bus-engine serve --home <home> --lifeline stdin --instance <uuid>` without waiting for it to be
//!    ready. The wrapper holds its stdin (the lifeline); the engine runs in a process group of its own (a terminal's
//!    Ctrl-C does not reach it), tied to the wrapper by the OS where it can be (Linux: parent-death signal, Windows: a
//!    job object that kills on close, plus `CREATE_NO_WINDOW`). Its stdout (its ready line) is drained by a thread in
//!    fixed-size chunks to the wrapper's stderr, so the only ready line on the wrapper's stdout is the core's; its
//!    stderr is inherited.
//! 2. It spawns the core as the Windows branch always did: stdio inherited, the same `core_env`, in the wrapper's
//!    process group.
//! 3. SIGTERM and SIGHUP are forwarded to the core; SIGINT reaches the core from the terminal and does not end the
//!    wrapper. The signal handlers set flags themselves: a stop signal before the engine's spawn starts nothing, one
//!    before the core's spawn starts no core; a SIGINT that came during the core's spawn is handed on to it once.
//! 4. When the core has ended, the engine is stopped: `engine.shutdown` over [`Endpoint::Engine`] with the token in
//!    `run/engine.token` (connect and call each bounded), SIGTERM when that could not be delivered, killed when it has
//!    not ended [`STOP_DEADLINE`] after the stop began (reaped within [`POST_KILL_WAIT`] more). The wrapper exits with the core's exit code (an end by a signal
//!    as [`EXIT_INTERRUPTED`], like the Windows branch).
//!
//! The engine's environment follows the supervisor slot's policy ([`crate::supervisor::child::apply_child_env`]).
//! A missing engine binary or a failed spawn costs one line on stderr; the core starts anyway and reports
//! `engine-unavailable`. An engine that ends while the core runs costs one line as well (exit 3: another engine serves
//! the home, and the core uses that one); the wrapper does not restart it (the supervisor does that). The engine lives exactly as long as the core: a changed configuration reaches it at the
//! next `core run`.
//!
//! macOS residual risk: there is no OS binding. A wrapper ended by SIGKILL leaves the core and the engine running; the
//! engine then sees its lifeline (stdin) close and ends after its orphan grace (`supervisor.graceMs`). With `stty tostop`
//! the engine (a background process group writing to the terminal's stderr) is stopped by SIGTTOU. Windows: only
//! Ctrl+C is ignored; Ctrl+Break or closing the console end the wrapper, and the job object ends the engine unordered.
use crate::output::{child_exit_code, say_err, Out, EXIT_INTERRUPTED};
use crate::paths::Layout;
use crate::supervisor::child::ChildSpec;
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::json;
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// From the start of the engine's stop to its end, `engine.shutdown`'s delivery included; then it is killed.
pub(crate) const STOP_DEADLINE: Duration = Duration::from_secs(5);
/// Bounds the connect and the `engine.auth` handshake of the stop call.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
/// Bounds the `engine.shutdown` call itself.
const CALL_TIMEOUT: Duration = Duration::from_secs(1);
/// The budget `engine.shutdown` asks for: inside [`STOP_DEADLINE`] with room for the delivery.
const SHUTDOWN_BUDGET_MS: u64 = 3_000;
/// How long the reaping after a kill may take.
const POST_KILL_WAIT: Duration = Duration::from_secs(1);
/// The wait loops' period (the engine's exit, its stop).
const POLL: Duration = Duration::from_millis(20);
/// The engine stdout drain's buffer: fixed, whatever the engine writes.
const DRAIN_CHUNK: usize = 8 * 1024;

/// `CREATE_NO_WINDOW`: the engine gets a console of its own without a window, so `core run`'s console events reach the
/// core and the wrapper, not the engine.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn relock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// What `core run` does about the engine before it starts the core: the engine's spec when the Rust engine is selected
/// and can be started (the wrapper then runs, [`run`]); `None` to exec the core as before. With the Node engine selected,
/// a `run/engine.process.lock` held by a live process, or one that cannot be checked, refuses the start
/// (`E_CORE_UNAVAILABLE`, reason `engine-lock-held`, the message says which). The node path's extra work before the exec
/// is one read of `config.json` (the selector), one UUID and one try-lock (no lock file: one failed open); nothing
/// waits. With the Rust engine selected but not startable (no binary, an unauthorized test seam), one line on stderr and
/// the core starts without it.
pub(crate) fn prepare(out: &Out, layout: &Layout) -> Option<ChildSpec> {
    use crate::engine_process::LockState;
    let instance = uuid::Uuid::new_v4().to_string();
    match crate::engine_process::configured_spec(layout, &instance) {
        Ok(Some(spec)) => Some(spec),
        Ok(None) => {
            let message = match crate::engine_process::lock_state(layout) {
                LockState::Free => return None,
                LockState::Held => "run/engine.process.lock is held by a running Rust engine although the node engine is selected; stop that engine (the `core run` or supervisor that owns it) first, then start the core again".to_owned(),
                LockState::Unverifiable(e) => format!(
                    "run/engine.process.lock cannot be checked ({e}); the core does not start beside a Rust engine it cannot rule out: check that file (a regular file this user can read and write, or none), then start the core again"
                ),
            };
            out.fail(
                "E_CORE_UNAVAILABLE",
                &message,
                json!({ "reason": "engine-lock-held" }),
            );
        }
        // config.json cannot be read: the core reports that itself, as before.
        Err(_) if !rust_selected(layout) => None,
        Err(e) => {
            say_err(&format!(
                "plur1bus: the Rust engine is not started ({e}); the core runs without it and reports engine-unavailable"
            ));
            None
        }
    }
}

fn rust_selected(layout: &Layout) -> bool {
    plur1bus_config::read(&layout.config_path())
        .ok()
        .and_then(|config| crate::engine_process::selected(&config).ok())
        == Some(true)
}

/// The wrapper (module docs): engine, core, wait for the core, stop the engine, exit with the core's code. `core` is
/// the core's command as `core run` built it; `program` names it in a spawn failure.
pub(crate) fn run(
    out: &Out,
    layout: &Layout,
    spec: ChildSpec,
    mut core: Command,
    program: &Path,
) -> ! {
    let forwarder = Forwarder::install();
    let pause = Pause::from_env();
    pause.at("engine");
    // A stop signal before this point: no engine, no core (the flag is set in the signal handler itself).
    if forwarder.stop_requested() {
        forwarder.close();
        std::process::exit(EXIT_INTERRUPTED);
    }
    let engine = match Engine::spawn(&spec) {
        Ok(engine) => Some(engine),
        Err(e) => {
            say_err(&format!(
                "plur1bus: cannot start the Rust engine {} ({e}); the core runs without it and reports engine-unavailable",
                spec.program.display()
            ));
            None
        }
    };
    core.stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    pause.at("core");
    let code = match forwarder.spawn_core(&mut core, &pause) {
        Ok(Some(mut child)) => forwarder
            .wait_core(&mut child)
            .map_or(1, |status| child_exit_code(&status)),
        // A stop signal came before the core was spawned: no further step.
        Ok(None) => EXIT_INTERRUPTED,
        Err(e) => {
            if let Some(engine) = engine {
                engine.stop(layout);
            }
            forwarder.close();
            out.fail(
                "E_CORE_UNAVAILABLE",
                &format!("cannot start {}: {e}", program.display()),
                json!({}),
            );
        }
    };
    if let Some(engine) = engine {
        engine.stop(layout);
    }
    forwarder.close();
    std::process::exit(code)
}

/// The engine child and what ties it to the wrapper.
struct Engine {
    child: Arc<Mutex<Child>>,
    pid: u32,
    /// Its stdin: the lifeline, held until it has ended.
    lifeline: Option<ChildStdin>,
    /// Set when the wrapper stops it: its exit is then expected and not reported.
    ending: Arc<AtomicBool>,
    #[cfg(windows)]
    _job: Option<plur1bus_rpc::win::KillOnClose>,
}

impl Engine {
    fn spawn(spec: &ChildSpec) -> io::Result<Engine> {
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args);
        // The supervisor slot's environment policy (M8). `core run` set no protected ACL on run/ (the core secures its
        // own files), so the engine is never told it was: an inherited PLUR1BUS_RUN_ACL is removed.
        crate::supervisor::child::apply_child_env(&mut cmd, spec, false);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if let Some(dir) = &spec.cwd {
            cmd.current_dir(dir);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Its own process group: a terminal's Ctrl-C reaches the core and the wrapper, which stops it after the core.
            cmd.process_group(0);
            // Spawned from the main thread, which ends only with the process: the parent-death signal (Linux) fires
            // when the wrapper ends, however it ends.
            plur1bus_rpc::process::die_with_parent(&mut cmd);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn()?;
        #[cfg(windows)]
        let job = plur1bus_rpc::win::KillOnClose::assign(&child)
            .map_err(|e| {
                say_err(&format!(
                    "plur1bus: cannot bind the engine to core run (job object: {e}); it may outlive a killed core run"
                ))
            })
            .ok();
        let pid = child.id();
        let lifeline = child.stdin.take();
        let stdout = child.stdout.take();
        let child = Arc::new(Mutex::new(child));
        let ending = Arc::new(AtomicBool::new(false));
        let (c, e) = (child.clone(), ending.clone());
        // Two threads: the end of the engine is watched on its own, so a child of the engine that keeps its stdout
        // open (no EOF on the drain) neither hides the end nor delays anything (M2).
        let spawned = std::thread::Builder::new()
            .name("engine-watch".into())
            .spawn(move || watch(&c, &e, pid))
            .and_then(|_| {
                std::thread::Builder::new()
                    .name("engine-stdout".into())
                    .spawn(move || {
                        if let Some(stdout) = stdout {
                            drain(stdout);
                        }
                    })
            });
        if let Err(e) = spawned {
            ending.store(true, Ordering::SeqCst);
            let mut child = relock(&child);
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
        Ok(Engine {
            child,
            pid,
            lifeline,
            ending,
            #[cfg(windows)]
            _job: job,
        })
    }

    fn exited(&self) -> bool {
        matches!(relock(&self.child).try_wait(), Ok(Some(_)) | Err(_))
    }

    fn wait_until(&self, deadline: Instant) -> bool {
        loop {
            if self.exited() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(POLL);
        }
    }

    /// `engine.shutdown`, SIGTERM when it was not delivered, killed at [`STOP_DEADLINE`]; returns once it has ended (or
    /// could not be reaped within [`POST_KILL_WAIT`] after the kill).
    fn stop(mut self, layout: &Layout) {
        self.ending.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + STOP_DEADLINE;
        if !self.exited() {
            let endpoints =
                layout.engine_endpoints(if cfg!(windows) { "windows" } else { "posix" });
            let pid = self.pid;
            let (tx, rx) = mpsc::channel();
            // On a helper thread: connect and call have their own deadlines, and the wait below bounds them together.
            let started = std::thread::Builder::new()
                .name("engine-shutdown".into())
                .spawn(move || {
                    let _ = tx.send(shutdown(&endpoints.address, &endpoints.token, pid));
                });
            let wait = (CONNECT_TIMEOUT + CALL_TIMEOUT)
                .min(deadline.saturating_duration_since(Instant::now()));
            let sent = started.is_ok() && rx.recv_timeout(wait).unwrap_or(false);
            if !sent {
                self.terminate();
            }
            if !self.wait_until(deadline) {
                say_err(&format!(
                    "plur1bus: the engine (pid {pid}) did not stop within {} s; killing it",
                    STOP_DEADLINE.as_secs()
                ));
                {
                    let mut child = relock(&self.child);
                    if matches!(child.try_wait(), Ok(None)) {
                        let _ = child.kill();
                    }
                }
                if !self.wait_until(Instant::now() + POST_KILL_WAIT) {
                    say_err(&format!(
                        "plur1bus: the engine (pid {pid}) was not reaped after the kill"
                    ));
                }
            }
        }
        drop(self.lifeline.take());
    }

    /// The fallback when `engine.shutdown` was not delivered: SIGTERM (the engine stops within its own deadline);
    /// Windows has none, the engine is killed at once.
    fn terminate(&self) {
        let mut child = relock(&self.child);
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        #[cfg(unix)]
        // SAFETY: the pid is this wrapper's unreaped child (checked under the lock that every reaping takes).
        unsafe {
            libc::kill(self.pid as libc::pid_t, libc::SIGTERM);
        }
        #[cfg(windows)]
        let _ = child.kill();
    }
}

/// `engine.shutdown` on the engine `pid` serves (its hello must name it): the token from `run/engine.token`, the connect
/// and the call each bounded.
fn shutdown(address: &str, token: &Path, pid: u32) -> bool {
    let Ok(token) = std::fs::read_to_string(token) else {
        return false;
    };
    let opts = ConnectOptions {
        connect_timeout: CONNECT_TIMEOUT,
        call_timeout: CALL_TIMEOUT,
        endpoint: Endpoint::Engine,
        expected_server_pid: Some(pid),
    };
    let Ok(mut client) = Client::connect(address, token.trim(), opts) else {
        return false;
    };
    if client.hello()["pid"].as_u64() != Some(u64::from(pid)) {
        return false;
    }
    client
        .call("engine.shutdown", json!({ "budgetMs": SHUTDOWN_BUDGET_MS }))
        .is_ok()
}

/// Copies the engine's stdout to the wrapper's stderr until EOF, in fixed-size chunks (nothing is kept).
fn drain(mut from: ChildStdout) {
    let mut buf = [0u8; DRAIN_CHUNK];
    loop {
        match from.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => {
                let _ = io::stderr().lock().write_all(&buf[..n]);
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

/// From the engine's spawn, independent of its stdout: one line on stderr when the engine ends while the wrapper is not
/// stopping it ([`ended_line`]).
fn watch(child: &Mutex<Child>, ending: &AtomicBool, pid: u32) {
    loop {
        if ending.load(Ordering::SeqCst) {
            return;
        }
        if let Ok(Some(status)) = relock(child).try_wait() {
            if !ending.load(Ordering::SeqCst) {
                say_err(&ended_line(pid, &status));
            }
            return;
        }
        std::thread::sleep(POLL * 5);
    }
}

/// The line for an engine that ended while the core runs. Exit 3 is the engine's "another engine owns this home": the
/// core then talks to that engine (through `run/engine.sock` and `run/engine.token`), so it is not unavailable (M3).
fn ended_line(pid: u32, status: &ExitStatus) -> String {
    if status.code() == Some(3) {
        format!(
            "plur1bus: the Rust engine (pid {pid}) exited 3: another engine serves this home; the core connects to that one, and core run neither stops nor restarts it"
        )
    } else {
        format!(
            "plur1bus: the Rust engine (pid {pid}) ended ({status}) while the core runs; core run does not restart it, the core reports engine-unavailable"
        )
    }
}

/// Test seam (only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`): `PLUR1BUS_TEST_CORE_RUN_PAUSE=<dir>:<point>` stops the
/// wrapper at `point` until a test lets it go, to place a signal exactly: `engine` (before the stop check that precedes
/// the engine's spawn), `core` (before the one that precedes the core's) or `spawn` (after that check, under the
/// forwarder's lock, right before the core's spawn). At the point it writes `<dir>/<point>` and waits for
/// `<dir>/<point>.go`, at most [`PAUSE_LIMIT`]; it also writes the spawned core's pid to `<dir>/spawned`.
struct Pause(Option<(std::path::PathBuf, String)>);

/// How long a [`Pause`] waits for its go file at most.
const PAUSE_LIMIT: Duration = Duration::from_secs(30);

impl Pause {
    fn from_env() -> Pause {
        let allowed = std::env::var_os("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref()
            == Some(std::ffi::OsStr::new("1"));
        let seam = std::env::var("PLUR1BUS_TEST_CORE_RUN_PAUSE").ok();
        Pause(seam.filter(|_| allowed).and_then(|s| {
            s.rsplit_once(':')
                .map(|(dir, point)| (dir.into(), point.to_owned()))
        }))
    }

    fn at(&self, point: &str) {
        let Some((dir, wanted)) = &self.0 else { return };
        if wanted != point {
            return;
        }
        let _ = std::fs::write(dir.join(point), b"");
        let go = dir.join(format!("{point}.go"));
        let deadline = Instant::now() + PAUSE_LIMIT;
        while !go.exists() && Instant::now() < deadline {
            std::thread::sleep(POLL);
        }
    }

    fn spawned(&self, pid: u32) {
        if let Some((dir, _)) = &self.0 {
            let _ = std::fs::write(dir.join("spawned"), pid.to_string());
        }
    }
}

/// The wrapper's signal handling (Unix). Each of SIGTERM, SIGHUP and SIGINT sets its flag in the signal handler itself
/// (async-signal-safe, I2), so a stop is seen at the next check however late the forwarding thread runs: before the
/// engine's spawn and, under the lock, before the core's. While the core runs, SIGTERM and SIGHUP go on to it (the
/// forwarding thread); SIGINT is the terminal's, except one that came after the last check and before the core existed,
/// which is handed on once.
struct Forwarder {
    ctl: Arc<Mutex<Ctl>>,
    /// Set by the handlers: [SIGTERM, SIGHUP, SIGINT] (never set on Windows).
    flags: [Arc<AtomicBool>; 3],
    #[cfg(unix)]
    handle: Option<signal_hook::iterator::Handle>,
}

/// The index of SIGINT's flag in [`Forwarder::flags`].
const SIGINT_FLAG: usize = 2;

#[derive(Default)]
struct Ctl {
    /// The core's pid while it may be signalled (spawned and not reaped).
    core: Option<u32>,
}

impl Forwarder {
    #[cfg(unix)]
    fn install() -> Forwarder {
        use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
        let ctl: Arc<Mutex<Ctl>> = Arc::default();
        let flags: [Arc<AtomicBool>; 3] = Default::default();
        for (signal, flag) in [SIGTERM, SIGHUP, SIGINT].into_iter().zip(&flags) {
            if let Err(e) = signal_hook::flag::register(signal, flag.clone()) {
                say_err(&format!(
                    "plur1bus: cannot watch for signal {signal} ({e}); stop the core itself"
                ));
            }
        }
        let handle = match signal_hook::iterator::Signals::new([SIGTERM, SIGHUP, SIGINT]) {
            Ok(mut signals) => {
                let handle = signals.handle();
                let c = ctl.clone();
                // A thread that cannot start drops `signals`; the flags above stay, so the wrapper still does not die
                // of these signals and still sees a stop before its spawns.
                std::thread::Builder::new()
                    .name("core-run-signals".into())
                    .spawn(move || {
                        for signal in signals.forever() {
                            on_signal(&c, signal);
                        }
                    })
                    .ok()
                    .map(|_| handle)
            }
            Err(e) => {
                say_err(&format!(
                    "plur1bus: cannot forward signals to the core ({e}); stop the core itself"
                ));
                None
            }
        };
        Forwarder { ctl, flags, handle }
    }

    #[cfg(windows)]
    fn install() -> Forwarder {
        Forwarder {
            ctl: Arc::default(),
            flags: Default::default(),
        }
    }

    /// Whether a stop signal has arrived (any of the three flags).
    fn stop_requested(&self) -> bool {
        self.flags.iter().any(|f| f.load(Ordering::SeqCst))
    }

    /// Spawns the core unless a stop signal came first (`Ok(None)`). Check and spawn run under the lock the forwarding
    /// thread takes, so a SIGTERM or SIGHUP is either seen by the check or forwarded to the core; a SIGINT that came
    /// after the check is handed on to the new core here (the terminal delivered it before the core existed; a second
    /// SIGINT does no harm, a lost one would).
    fn spawn_core(&self, cmd: &mut Command, pause: &Pause) -> io::Result<Option<Child>> {
        let mut ctl = relock(&self.ctl);
        if self.stop_requested() {
            return Ok(None);
        }
        pause.at("spawn");
        let child = cmd.spawn()?;
        ctl.core = Some(child.id());
        #[cfg(unix)]
        if self.flags[SIGINT_FLAG].load(Ordering::SeqCst) {
            // SAFETY: the pid is the child spawned just now, not reaped.
            unsafe {
                libc::kill(child.id() as libc::pid_t, libc::SIGINT);
            }
        }
        pause.spawned(child.id());
        drop(ctl);
        #[cfg(windows)]
        {
            // The core shares the console and gets Ctrl+C itself; the wrapper stays to stop the engine after it. Set
            // after the spawn, so the core does not inherit it. Ctrl+Break and closing the console still end the
            // wrapper; the job object then ends the engine without an orderly stop.
            // SAFETY: a null handler with TRUE only changes this process's Ctrl+C disposition.
            unsafe {
                windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 1);
            }
        }
        Ok(Some(child))
    }

    /// Waits for the core's end. Unix: `waitid(WNOWAIT)` first, so its pid stays reserved (a zombie) until the forwarder
    /// can no longer signal it, then the reaping.
    fn wait_core(&self, child: &mut Child) -> Option<ExitStatus> {
        #[cfg(unix)]
        loop {
            // SAFETY: siginfo_t is plain data, zeroed is a valid value; waitid only writes into it.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            // SAFETY: waits for this process's own child without reaping it (WNOWAIT).
            let r = unsafe {
                libc::waitid(
                    libc::P_PID,
                    child.id() as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            };
            if r == 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                break;
            }
        }
        relock(&self.ctl).core = None;
        child.wait().ok()
    }

    fn close(self) {
        #[cfg(unix)]
        if let Some(handle) = self.handle {
            handle.close();
        }
    }
}

#[cfg(unix)]
fn on_signal(ctl: &Mutex<Ctl>, signal: i32) {
    let ctl = relock(ctl);
    if let Some(pid) = forward_to(&ctl, signal) {
        // SAFETY: the pid is the wrapper's core child, not yet reaped (`wait_core` clears it under this lock first).
        unsafe {
            libc::kill(pid as libc::pid_t, signal);
        }
    }
}

/// The core's pid when the forwarding thread passes `signal` on: SIGTERM and SIGHUP while the core runs. A stop before
/// the core exists is the flags' business ([`Forwarder::stop_requested`]).
#[cfg(unix)]
fn forward_to(ctl: &Ctl, signal: i32) -> Option<u32> {
    ctl.core.filter(|_| signal != libc::SIGINT)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn forwarder() -> Forwarder {
        Forwarder {
            ctl: Arc::default(),
            flags: Default::default(),
            handle: None,
        }
    }

    #[test]
    fn a_stop_flag_before_the_core_is_spawned_means_no_core() {
        for i in 0..3 {
            let forwarder = forwarder();
            forwarder.flags[i].store(true, Ordering::SeqCst);
            assert!(forwarder.stop_requested());
            let mut cmd = Command::new("true");
            assert!(forwarder
                .spawn_core(&mut cmd, &Pause(None))
                .unwrap()
                .is_none());
            assert_eq!(relock(&forwarder.ctl).core, None);
        }
    }

    #[test]
    fn sigterm_and_sighup_go_to_the_running_core_and_sigint_does_not() {
        let ctl = Ctl { core: Some(42) };
        assert_eq!(forward_to(&ctl, libc::SIGTERM), Some(42));
        assert_eq!(forward_to(&ctl, libc::SIGHUP), Some(42));
        assert_eq!(forward_to(&ctl, libc::SIGINT), None);
        assert_eq!(forward_to(&Ctl::default(), libc::SIGTERM), None);
    }

    #[test]
    fn the_forwarded_signal_ends_the_core_and_its_pid_is_forgotten_before_the_reaping() {
        let forwarder = forwarder();
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let mut child = forwarder
            .spawn_core(&mut cmd, &Pause(None))
            .unwrap()
            .unwrap();
        assert_eq!(relock(&forwarder.ctl).core, Some(child.id()));
        on_signal(&forwarder.ctl, libc::SIGTERM);
        let status = forwarder.wait_core(&mut child).unwrap();
        assert_eq!(child_exit_code(&status), EXIT_INTERRUPTED);
        assert_eq!(relock(&forwarder.ctl).core, None);
    }

    #[test]
    fn an_exit_3_names_the_other_engine_and_any_other_end_engine_unavailable() {
        use std::os::unix::process::ExitStatusExt;
        let three = ended_line(7, &ExitStatus::from_raw(3 << 8));
        assert!(three.contains("another engine serves this home"), "{three}");
        assert!(!three.contains("engine-unavailable"), "{three}");
        let one = ended_line(7, &ExitStatus::from_raw(1 << 8));
        assert!(one.contains("engine-unavailable"), "{one}");
    }
}
