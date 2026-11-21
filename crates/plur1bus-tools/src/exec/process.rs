//! The process port of `exec.run` (R-K-2) and its real implementation (`tools/exec/node-process.ts`).
//!
//! The runner is synchronous: it asks a started process for its next event, with the longest time it is willing to wait,
//! until the event is the exit. A double answers from a script and moves a clock it shares with the test; the real port
//! reads the two pipes on threads and polls the child.
//!
//! **The real port.** No shell: `std::process::Command` with the argument array, a cleared environment and no standard
//! input. On unix the child leads its own process group and the whole group is killed (`SIGKILL`, no grace period: an
//! exec that must stop is stopped), also once more when the child has exited, so a background job it left behind does
//! not live on. On Windows the tree is ended with `taskkill /PID <pid> /T /F`, as the TypeScript port does.
//!
//! Known difference from the TypeScript port: a descendant that left the process group (its own session) and holds a
//! pipe open keeps one reader thread and its pipe alive until it closes the pipe; the output is reported after two
//! seconds without it either way. Node destroys its end of the pipe; `std` cannot close a pipe another thread reads.
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// What to start (`SpawnSpec`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnSpec {
    /// The program: a bare name or an absolute path.
    pub program: String,
    /// The arguments, one element each, passed as they are.
    pub args: Vec<String>,
    /// The working directory (canonical).
    pub cwd: String,
    /// The whole environment of the child.
    pub env: Vec<(String, String)>,
}

/// How a process ended (`ExitInfo`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExitInfo {
    /// The exit code, or `None` when a signal ended it.
    pub code: Option<i32>,
    /// The signal that ended it (`SIGKILL`, ...).
    pub signal: Option<String>,
}

/// What a running process reports next.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// Bytes on standard output.
    Stdout(Vec<u8>),
    /// Bytes on standard error.
    Stderr(Vec<u8>),
    /// Nothing happened within the wait.
    Idle,
    /// The process, and its output, are done.
    Exit(ExitInfo),
}

/// A started process (`ProcessHandle`).
pub trait ProcessHandle {
    /// Native process ID when the port can report one.
    fn pid(&self) -> Option<u32> {
        None
    }
    /// The next event, waiting at most `wait_ms` for it. `Err` is a process that could not be run or waited for.
    fn next(&mut self, wait_ms: f64) -> Result<Event, String>;
    /// End the whole process tree. Idempotent; never fails.
    fn kill_tree(&mut self);
}

/// Starts processes (`ProcessPort`).
pub trait ProcessPort {
    /// Start `spec`. `Err` is the message of the spawn failure.
    fn spawn(&self, spec: &SpawnSpec) -> Result<Box<dyn ProcessHandle>, String>;
}

/// The real port over `std::process`.
#[derive(Clone, Copy, Debug, Default)]
pub struct OsProcessPort;

struct OsProcess {
    child: Child,
    rx: Receiver<(bool, Vec<u8>)>,
    pipes_open: bool,
    exit: Option<ExitInfo>,
    drain_until: Option<Instant>,
    killed: bool,
}

/// Node's name for a spawn or wait failure (`spawn git ENOENT`).
fn spawn_error(program: &str, e: &std::io::Error) -> String {
    format!(
        "spawn {program} {}",
        plur1bus_core::policy::fs_paths::error_code(e).code
    )
}

#[cfg(unix)]
fn signal_name(n: i32) -> String {
    // The numbers that are the same on Linux and macOS; any other is named by its number.
    let name = match n {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        _ => return format!("SIG{n}"),
    };
    name.to_owned()
}

fn exit_info(status: std::process::ExitStatus) -> ExitInfo {
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(signal_name)
    };
    #[cfg(not(unix))]
    let signal = None;
    ExitInfo {
        code: status.code(),
        signal,
    }
}

fn pump(
    mut pipe: impl Read + Send + 'static,
    stderr: bool,
    tx: std::sync::mpsc::SyncSender<(bool, Vec<u8>)>,
) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    if tx.send((stderr, buf[..n].to_vec())).is_err() {
                        return; // nobody reads any more
                    }
                }
            }
        }
    });
}

impl OsProcess {
    /// Kill everything in the child's process group (unix). The group is gone when the call fails; that is fine.
    fn sweep_group(&self) {
        #[cfg(unix)]
        {
            let pid = i32::try_from(self.child.id())
                .ok()
                .and_then(rustix::process::Pid::from_raw);
            if let Some(pid) = pid {
                let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
            }
        }
    }

    fn chunk(stderr: bool, bytes: Vec<u8>) -> Event {
        if stderr {
            Event::Stderr(bytes)
        } else {
            Event::Stdout(bytes)
        }
    }
}

impl ProcessHandle for OsProcess {
    fn pid(&self) -> Option<u32> {
        Some(self.child.id())
    }

    fn next(&mut self, wait_ms: f64) -> Result<Event, String> {
        // A short tick: the caller checks its deadline and the abort signal between events.
        let tick = Duration::from_millis(20).min(Duration::from_secs_f64(
            (wait_ms.max(1.0) / 1000.0).min(3600.0),
        ));
        if let Some(exit) = &self.exit {
            // Exited: what is still in the pipes is read until they close, for two seconds at most.
            let left = self.drain_until.map_or(Duration::ZERO, |d| {
                d.saturating_duration_since(Instant::now())
            });
            if !self.pipes_open || left.is_zero() {
                return Ok(Event::Exit(exit.clone()));
            }
            return Ok(match self.rx.recv_timeout(tick.min(left)) {
                Ok((stderr, bytes)) => Self::chunk(stderr, bytes),
                Err(RecvTimeoutError::Timeout) => Event::Idle,
                Err(RecvTimeoutError::Disconnected) => {
                    self.pipes_open = false;
                    Event::Exit(exit.clone())
                }
            });
        }
        if self.pipes_open {
            match self.rx.recv_timeout(tick) {
                Ok((stderr, bytes)) => return Ok(Self::chunk(stderr, bytes)),
                Err(RecvTimeoutError::Disconnected) => self.pipes_open = false,
                Err(RecvTimeoutError::Timeout) => {}
            }
        } else {
            std::thread::sleep(tick);
        }
        match self.child.try_wait() {
            Ok(Some(status)) => {
                self.exit = Some(exit_info(status));
                self.drain_until = Some(Instant::now() + Duration::from_secs(2));
                // What the child left running in its group ends with it.
                self.sweep_group();
                Ok(Event::Idle)
            }
            Ok(None) => Ok(Event::Idle),
            Err(e) => Err(spawn_error("wait", &e)),
        }
    }

    fn kill_tree(&mut self) {
        if self.killed {
            return;
        }
        self.killed = true;
        #[cfg(unix)]
        self.sweep_group();
        #[cfg(not(unix))]
        if self.exit.is_none() {
            // No job object without `unsafe`: the tree is ended the way the TypeScript port ends it.
            let _ = Command::new("taskkill")
                .args(["/PID", &self.child.id().to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = self.child.kill();
    }
}

impl Drop for OsProcess {
    fn drop(&mut self) {
        // A handle that is dropped while its process runs (a panic, an early return) leaves nothing behind.
        if self.exit.is_none() {
            self.kill_tree();
            let _ = self.child.wait();
        }
    }
}

impl ProcessPort for OsProcessPort {
    fn spawn(&self, spec: &SpawnSpec) -> Result<Box<dyn ProcessHandle>, String> {
        let mut c = Command::new(&spec.program);
        c.args(&spec.args)
            .current_dir(&spec.cwd)
            .env_clear()
            .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            c.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = c.spawn().map_err(|e| spawn_error(&spec.program, &e))?;
        let (tx, rx) = sync_channel(16);
        if let Some(out) = child.stdout.take() {
            pump(out, false, tx.clone());
        }
        if let Some(err) = child.stderr.take() {
            pump(err, true, tx);
        }
        Ok(Box::new(OsProcess {
            child,
            rx,
            pipes_open: true,
            exit: None,
            drain_until: None,
            killed: false,
        }))
    }
}

/// A scripted process port for tests: every spawn is recorded, and the process plays its script, moving the shared clock.
/// Compiled for this crate's tests only, like the gate's doubles.
#[cfg(test)]
pub(crate) mod doubles {
    use super::{Event, ExitInfo, ProcessHandle, ProcessPort, SpawnSpec};
    use crate::gate::doubles::SetClock;
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;
    use std::rc::Rc;

    /// One step of a scripted process.
    #[derive(Clone, Debug, PartialEq)]
    pub enum Step {
        /// Bytes on standard output.
        Out(Vec<u8>),
        /// Bytes on standard error.
        Err(Vec<u8>),
        /// Time passes.
        Advance(f64),
        /// The process exits with this code.
        Exit(i32),
        /// The caller aborts.
        Abort,
        /// Waiting for the process fails.
        Fail(String),
    }

    /// What a test shares with the port: the clock, the abort flag and the record.
    #[derive(Debug, Default)]
    pub struct Stage {
        /// The clock the processes move.
        pub clock: SetClock,
        /// Set by a script's `Abort`.
        pub aborted: Cell<bool>,
        /// Every spawn, with how often its tree was killed.
        pub spawned: RefCell<Vec<(SpawnSpec, Rc<Cell<u32>>)>>,
    }

    /// A port whose processes all play `script`; `spawn_fails` makes the spawn itself fail.
    pub struct ScriptedPort {
        /// The shared stage.
        pub stage: Rc<Stage>,
        /// The script of every process.
        pub script: Vec<Step>,
        /// The message a spawn fails with.
        pub spawn_fails: Option<String>,
    }

    struct Scripted {
        stage: Rc<Stage>,
        script: VecDeque<Step>,
        kills: Rc<Cell<u32>>,
    }

    impl ProcessHandle for Scripted {
        fn next(&mut self, wait_ms: f64) -> Result<Event, String> {
            // A killed process is gone, whatever its script still held (the TypeScript fake resolves on the kill).
            if self.kills.get() > 0 {
                return Ok(Event::Exit(ExitInfo {
                    code: None,
                    signal: Some("SIGKILL".to_owned()),
                }));
            }
            Ok(match self.script.pop_front() {
                Some(Step::Out(b)) => Event::Stdout(b),
                Some(Step::Err(b)) => Event::Stderr(b),
                Some(Step::Advance(ms)) => {
                    self.stage.clock.advance(ms);
                    Event::Idle
                }
                Some(Step::Exit(code)) => Event::Exit(ExitInfo {
                    code: Some(code),
                    signal: None,
                }),
                Some(Step::Abort) => {
                    self.stage.aborted.set(true);
                    Event::Idle
                }
                Some(Step::Fail(m)) => return Err(m),
                // A process that says nothing more: the wait passes.
                None => {
                    self.stage.clock.advance(wait_ms.max(1.0));
                    Event::Idle
                }
            })
        }
        fn kill_tree(&mut self) {
            self.kills.set(self.kills.get() + 1);
        }
    }

    impl ProcessPort for ScriptedPort {
        fn spawn(&self, spec: &SpawnSpec) -> Result<Box<dyn ProcessHandle>, String> {
            if let Some(m) = &self.spawn_fails {
                return Err(m.clone());
            }
            let kills = Rc::new(Cell::new(0));
            self.stage
                .spawned
                .borrow_mut()
                .push((spec.clone(), Rc::clone(&kills)));
            Ok(Box::new(Scripted {
                stage: Rc::clone(&self.stage),
                script: self.script.iter().cloned().collect(),
                kills,
            }))
        }
    }
}
