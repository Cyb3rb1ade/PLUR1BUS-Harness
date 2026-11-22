//! `session/checkpoint-git-process.ts` and the error vocabulary of the rewind half: Git as a process behind a port
//! ([`GitProcess`]), the cancellation token ([`Cancel`]) and the error all rewind and checkpoint code returns
//! ([`RewindError`]).
//!
//! **Git is only ever a child process with an argument list.** The arguments are a `Vec<String>` and the environment a full
//! list of pairs; nothing here builds or accepts a shell line. [`SystemGit`] is the real port over `std::process::Command`
//! (`env_clear`, so the child sees exactly the environment the caller built: the TypeScript spawn passes `env` the same way);
//! the tests also use a recording wrapper and a scripted double.
//!
//! Differences from the TypeScript child, each deliberate:
//! - The TypeScript code stops a child with `SIGTERM`, then `SIGKILL` after one second. `std` has no `SIGTERM` and this crate
//!   forbids `unsafe`, so on unix [`SystemGit`] sends `SIGTERM` through the `kill` utility and falls back to
//!   [`std::process::Child::kill`] after the same grace; on Windows it kills at once, as Node's `kill` does there.
//! - The 32 MiB bound counts raw bytes of both streams. Node counts the UTF-8 length of the decoded chunk, which is larger
//!   only where the child wrote invalid UTF-8 (each bad byte decodes to three bytes there).
//! - The abort signal is polled every few milliseconds instead of waking on an event.
use super::SessionError;
use crate::policy::fs_paths::FsError;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// The bound on the output of one Git child (`MAX_BYTES`).
pub const MAX_BYTES: usize = 32 * 1024 * 1024;
/// The time one Git child may run (`TIMEOUT_MS`).
pub const TIMEOUT: Duration = Duration::from_millis(30_000);
/// The time between `SIGTERM` and `SIGKILL` (`KILL_GRACE_MS`).
pub const KILL_GRACE: Duration = Duration::from_millis(1_000);
const POLL: Duration = Duration::from_millis(5);

/// What an `AbortSignal` carries as its `reason`.
#[derive(Clone, Debug, PartialEq)]
pub enum AbortReason {
    /// A plain `controller.abort()`: the default `AbortError` of the platform.
    Caller,
    /// `Error("checkpoint-lifecycle-closed")`: the owner closed the lifecycle.
    Closed,
    /// A `SessionError` given as the reason (an archived session, an ended card).
    Session(SessionError),
}

struct CancelInner {
    reason: Mutex<Option<AbortReason>>,
    parents: Vec<Cancel>,
}

/// An `AbortSignal` with its `AbortController`: one handle both aborts and observes. [`Cancel::any`] is `AbortSignal.any`.
/// Observers poll [`Cancel::reason`]; there are no listeners, because everything here is synchronous.
#[derive(Clone)]
pub struct Cancel(Arc<CancelInner>);

impl Default for Cancel {
    fn default() -> Self {
        Cancel::new()
    }
}

impl Cancel {
    /// A signal that has not been aborted.
    pub fn new() -> Cancel {
        Cancel(Arc::new(CancelInner {
            reason: Mutex::new(None),
            parents: Vec::new(),
        }))
    }

    /// `AbortSignal.any(signals)`: aborted as soon as one of them is, with that one's reason (the first in list order).
    pub fn any(signals: &[&Cancel]) -> Cancel {
        Cancel(Arc::new(CancelInner {
            reason: Mutex::new(None),
            parents: signals.iter().map(|s| (*s).clone()).collect(),
        }))
    }

    /// `controller.abort(reason)`: the first abort wins.
    pub fn abort(&self, reason: AbortReason) {
        let mut slot = self.0.reason.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.is_none() {
            *slot = Some(reason);
        }
    }

    /// `signal.reason`, or `None` while the signal is not aborted.
    pub fn reason(&self) -> Option<AbortReason> {
        if let Some(r) = self
            .0
            .reason
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
        {
            return Some(r);
        }
        self.0.parents.iter().find_map(Cancel::reason)
    }

    /// `signal.aborted`.
    pub fn is_aborted(&self) -> bool {
        self.reason().is_some()
    }

    /// `signal.throwIfAborted()`.
    pub fn throw_if_aborted(&self) -> Result<(), RewindError> {
        match self.reason() {
            Some(r) => Err(RewindError::Aborted(r)),
            None => Ok(()),
        }
    }
}

/// Why a Git child did not return its output.
#[derive(Clone, Debug, PartialEq)]
pub enum GitFailure {
    /// The signal was aborted; the child was stopped and reaped first (`AbortError`).
    Aborted(AbortReason),
    /// The child ran longer than [`TIMEOUT`] (`TimeoutError`).
    Timeout,
    /// More than [`MAX_BYTES`] of output (`checkpoint Git output limit exceeded`).
    OutputLimit,
    /// The child could not be started: the Node error code (`ENOENT`, `EACCES`, ...).
    Spawn(String),
    /// A non-zero exit (`checkpoint Git failed`). `code` is `None` when a signal ended the child.
    Exit {
        /// The exit status.
        code: Option<i32>,
    },
}

/// The error of the rewind half. `Session` carries the `SessionError` the TypeScript code throws, and the `cause` of a failed
/// Git child where there is one (the exit status is read from it, see [`RewindError::git_exit`]).
#[derive(Clone, Debug, PartialEq)]
pub enum RewindError {
    /// A `SessionError`, with the Git failure it wraps.
    Session {
        /// The error.
        error: SessionError,
        /// `error.cause`.
        cause: Option<GitFailure>,
    },
    /// A signal was aborted; the reason is what `signal.reason` holds.
    Aborted(AbortReason),
    /// A raw error of the file system (`ENOENT`, ...), as `node:fs` throws it.
    Fs(FsError),
    /// Any other error a port threw (its message).
    Other(String),
}

impl From<SessionError> for RewindError {
    fn from(error: SessionError) -> Self {
        RewindError::Session { error, cause: None }
    }
}

impl From<FsError> for RewindError {
    fn from(e: FsError) -> Self {
        RewindError::Fs(e)
    }
}

impl RewindError {
    /// The `SessionError` of this error, if it is one.
    pub fn session(&self) -> Option<&SessionError> {
        match self {
            RewindError::Session { error, .. }
            | RewindError::Aborted(AbortReason::Session(error)) => Some(error),
            _ => None,
        }
    }

    /// `error.reason` of a `SessionError`.
    pub fn reason(&self) -> Option<&str> {
        self.session().and_then(|e| e.reason.as_deref())
    }

    /// `gitExit`: the numeric `code` of the error or of its cause, if the Git child exited with one.
    pub fn git_exit(&self) -> Option<i32> {
        match self {
            RewindError::Session {
                cause: Some(GitFailure::Exit { code }),
                ..
            } => *code,
            _ => None,
        }
    }

    /// `missingPath`: a raw `ENOENT` or `ENOTDIR`. A `SessionError` is never one, whatever its cause.
    pub fn missing_path(&self) -> bool {
        matches!(self, RewindError::Fs(e) if e.code == "ENOENT" || e.code == "ENOTDIR")
    }
}

impl std::fmt::Display for RewindError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RewindError::Session { error, .. } => write!(f, "{error}"),
            RewindError::Aborted(r) => write!(f, "aborted: {r:?}"),
            RewindError::Fs(e) => write!(f, "{}", e.code),
            RewindError::Other(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for RewindError {}

/// The Git child of one checkpoint operation (R-K-2: the process start is a port).
pub trait GitProcess {
    /// `process.env`: the environment the policy of `checkpointEnvironment` filters.
    fn base_env(&self) -> Vec<(String, String)>;
    /// Runs `git` with exactly these arguments and this environment (the child inherits nothing else) and returns its
    /// standard output. A signal that is already aborted is [`GitFailure::Aborted`] without a spawn.
    fn run(
        &self,
        args: &[String],
        env: &[(String, String)],
        cancel: &Cancel,
    ) -> Result<String, GitFailure>;
}

/// [`GitProcess`] over `std::process::Command` (`git` found through the `PATH` of the given environment). The limits are
/// fields so a test can shorten them; the defaults are the TypeScript constants.
#[derive(Clone, Copy, Debug)]
pub struct SystemGit {
    /// How long a child may run.
    pub timeout: Duration,
    /// The time between the polite stop and the kill.
    pub kill_grace: Duration,
}

impl Default for SystemGit {
    fn default() -> Self {
        SystemGit {
            timeout: TIMEOUT,
            kill_grace: KILL_GRACE,
        }
    }
}

fn spawn_code(e: &std::io::Error) -> String {
    crate::policy::fs_paths::error_code(e).code
}

#[cfg(unix)]
fn terminate(child: &mut std::process::Child) {
    // `std` has no SIGTERM and `unsafe` is forbidden: the `kill` utility sends it. A failure to send is not an error here;
    // the SIGKILL after the grace period is the backstop.
    let _ = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(unix))]
fn terminate(child: &mut std::process::Child) {
    let _ = child.kill();
}

impl GitProcess for SystemGit {
    fn base_env(&self) -> Vec<(String, String)> {
        std::env::vars_os()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.to_string_lossy().into_owned(),
                )
            })
            .collect()
    }

    fn run(
        &self,
        args: &[String],
        env: &[(String, String)],
        cancel: &Cancel,
    ) -> Result<String, GitFailure> {
        if let Some(r) = cancel.reason() {
            return Err(GitFailure::Aborted(r));
        }
        let mut command = Command::new("git");
        command
            .args(args)
            .env_clear()
            .envs(env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: `windowsHide`
        }
        let mut child = command
            .spawn()
            .map_err(|e| GitFailure::Spawn(spawn_code(&e)))?;
        let total = Arc::new(AtomicUsize::new(0));
        let over = Arc::new(AtomicBool::new(false));
        let mut readers = Vec::new();
        for (stream, keep) in [
            (
                child
                    .stdout
                    .take()
                    .map(|s| Box::new(s) as Box<dyn Read + Send>),
                true,
            ),
            (
                child
                    .stderr
                    .take()
                    .map(|s| Box::new(s) as Box<dyn Read + Send>),
                false,
            ),
        ] {
            let Some(mut stream) = stream else { continue };
            let (total, over) = (total.clone(), over.clone());
            readers.push(std::thread::spawn(move || {
                let mut kept = Vec::new();
                let mut buf = [0_u8; 16 * 1024];
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if total.fetch_add(n, Ordering::SeqCst) + n > MAX_BYTES {
                                over.store(true, Ordering::SeqCst);
                                // Keep draining so the child never blocks on a full pipe; nothing more is kept.
                                kept.clear();
                                continue;
                            }
                            if keep && !over.load(Ordering::SeqCst) {
                                kept.extend_from_slice(&buf[..n]);
                            }
                        }
                    }
                }
                kept
            }));
        }
        let started = Instant::now();
        let mut failure: Option<GitFailure> = None;
        let mut terminated_at: Option<Instant> = None;
        let mut killed = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {}
                Err(_) => break None,
            }
            if failure.is_none() {
                if let Some(r) = cancel.reason() {
                    failure = Some(GitFailure::Aborted(r));
                } else if started.elapsed() >= self.timeout {
                    failure = Some(GitFailure::Timeout);
                } else if over.load(Ordering::SeqCst) {
                    failure = Some(GitFailure::OutputLimit);
                }
                if failure.is_some() {
                    terminate(&mut child);
                    terminated_at = Some(Instant::now());
                }
            } else if !killed && terminated_at.is_some_and(|t| t.elapsed() >= self.kill_grace) {
                let _ = child.kill();
                killed = true;
            }
            std::thread::sleep(POLL);
        };
        let mut stdout = Vec::new();
        for reader in readers {
            if let Ok(kept) = reader.join() {
                if stdout.is_empty() {
                    stdout = kept;
                }
            }
        }
        if failure.is_none() && over.load(Ordering::SeqCst) {
            failure = Some(GitFailure::OutputLimit);
        }
        if let Some(f) = failure {
            return Err(f);
        }
        match status {
            Some(s) if s.success() => Ok(String::from_utf8_lossy(&stdout).into_owned()),
            Some(s) => Err(GitFailure::Exit { code: s.code() }),
            None => Err(GitFailure::Exit { code: None }),
        }
    }
}
