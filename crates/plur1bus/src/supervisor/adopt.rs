//! Adoption of a core that is already running when the supervisor starts (spec §6.4, rulings S3–S6, S19).
//!
//! Before any spawn the supervisor probes the core's address ([`probe_core`]). A core that answers as the one
//! `run/core.pid` names is adopted through `core.adopt { nonce }` ([`adopt`]): the nonce is the content of
//! `run/supervisor.token`, and the connection the call succeeds on becomes the core's lifeline. A core that accepts but
//! does not answer, or that is not the one the pid file names, is terminated ([`terminate_found`]) and a fresh one is
//! spawned.
//!
//! The only pid the supervisor ever signals is one the OS names as the socket's server ([`Stream::peer_pid`]:
//! `SO_PEERCRED`, `LOCAL_PEERPID`, `GetNamedPipeServerProcessId`), re-checked right before each signal ([`Peer`]).
//! `run/core.pid` only serves to recognise a foreign core.
use super::{spawn_guarded, Shared};
use crate::paths::{core_address, Layout};
use plur1bus_rpc::transport::{self, Stream};
use plur1bus_rpc::{Client, ConnectOptions, Endpoint, RpcError};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The `core.auth` deadline of the start-up probe, and the deadlines of the adoption calls (S6). Not scaled.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// How long [`terminate_found`] waits for the process to go after the final kill.
const POST_KILL_WAIT: Duration = Duration::from_secs(1);
/// How often a termination checks whether the process is gone.
const GONE_TICK: Duration = Duration::from_millis(25);

/// What answers on the core's address.
#[derive(Debug, Clone, PartialEq)]
pub enum Probe {
    /// Nothing listens (no socket or pipe, or a stale socket file that refuses connections).
    Absent,
    /// A core that authenticated with `run/core.token`, whose hello `pid` is the socket's server and whose
    /// `instanceId` is the one in `run/core.pid`.
    Serving { peer_pid: u32, hello: Value },
    /// It accepts connections but `core.auth` got no answer in time, or there is no `run/core.token` to try.
    Hung { peer_pid: u32 },
    /// It answers, but not as the core `run/core.pid` names (or the handshake failed outright).
    Foreign { peer_pid: u32, reason: String },
}

impl Probe {
    /// The name used in `logs/supervisor.log`.
    pub fn name(&self) -> &'static str {
        match self {
            Probe::Absent => "absent",
            Probe::Serving { .. } => "serving",
            Probe::Hung { .. } => "hung",
            Probe::Foreign { .. } => "foreign",
        }
    }
}

fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "posix"
    }
}

fn read_core_token(layout: &Layout) -> Option<String> {
    let t = std::fs::read_to_string(layout.core_token()).ok()?;
    let t = t.trim().to_string();
    (!t.is_empty()).then_some(t)
}

/// The instance id in `run/core.pid` (`<pid> <instanceId>`).
fn pid_file_instance(layout: &Layout) -> Option<String> {
    let s = std::fs::read_to_string(layout.core_pid()).ok()?;
    s.split_whitespace().nth(1).map(str::to_string)
}

fn core_options(timeout: Duration) -> ConnectOptions {
    ConnectOptions {
        connect_timeout: timeout,
        call_timeout: timeout,
        endpoint: Endpoint::Core,
    }
}

/// Probes the core's address (rule S6): a failed connect → `Absent`; connected, but no token file or no `core.auth`
/// answer within `timeout` → `Hung`; hello `pid` ≠ the socket's server, or hello `instanceId` ≠ `run/core.pid` →
/// `Foreign`; otherwise `Serving`. The handshake runs on the very connection whose peer pid was read.
pub fn probe_core(layout: &Layout, timeout: Duration) -> Probe {
    let address = core_address(&layout.home, platform());
    let Ok(stream) = transport::connect(&address, timeout) else {
        return Probe::Absent;
    };
    // Every supported OS names the server. Where one cannot, nothing may be signalled: the fresh core's spawn then
    // fails with `lock-held` and backs off until the address is free.
    let Some(peer_pid) = stream.peer_pid() else {
        return Probe::Absent;
    };
    let Some(token) = read_core_token(layout) else {
        return Probe::Hung { peer_pid };
    };
    let client = match handshake_bounded(stream, token, timeout) {
        Some(Ok(c)) => c,
        None => return Probe::Hung { peer_pid },
        Some(Err(RpcError::Unavailable { reason, .. })) if reason == "handshake-timeout" => {
            return Probe::Hung { peer_pid }
        }
        Some(Err(e)) => {
            return Probe::Foreign {
                peer_pid,
                reason: format!("handshake-failed: {e}"),
            }
        }
    };
    let hello = client.hello().clone();
    if hello["pid"].as_u64() != Some(u64::from(peer_pid)) {
        return Probe::Foreign {
            peer_pid,
            reason: "pid-mismatch".into(),
        };
    }
    match pid_file_instance(layout) {
        None => Probe::Foreign {
            peer_pid,
            reason: "no-pid-file".into(),
        },
        Some(id) if hello["instanceId"].as_str() != Some(id.as_str()) => Probe::Foreign {
            peer_pid,
            reason: "instance-mismatch".into(),
        },
        Some(_) => Probe::Serving { peer_pid, hello },
    }
}

/// `core.auth` on `stream`, bounded by `timeout` plus a margin even where a read has no deadline yet (Windows until
/// Task 10): `None` when the bound expires. A thread left behind ends when the core answers or goes away.
fn handshake_bounded(
    stream: Box<dyn Stream>,
    token: String,
    timeout: Duration,
) -> Option<Result<Client, RpcError>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("core-probe".into())
        .spawn(move || {
            let _ = tx.send(Client::handshake(stream, &token, core_options(timeout)));
        });
    if spawned.is_err() {
        return None;
    }
    rx.recv_timeout(timeout + Duration::from_millis(500)).ok()
}

/// Adopts the running core: `core.auth` with `run/core.token`, then `core.adopt { nonce: supervisor_token }`. Returns
/// the connection, which is now the core's lifeline and must stay open for as long as the core is supervised, and
/// the core's `CoreStatus`. A core whose hello `pid` is not the socket's server is refused.
pub fn adopt(layout: &Layout, supervisor_token: &str) -> Result<(Client, Value), RpcError> {
    let address = core_address(&layout.home, platform());
    let token = read_core_token(layout).ok_or_else(|| RpcError::Unavailable {
        reason: "no-core-token".into(),
        detail: format!("{} is missing", layout.core_token().display()),
    })?;
    let mut client = Client::connect(&address, &token, core_options(PROBE_TIMEOUT))?;
    let hello_pid = client.hello()["pid"].as_u64();
    if client.peer_pid().map(u64::from) != hello_pid {
        return Err(RpcError::Protocol(format!(
            "the core's hello pid {hello_pid:?} is not the socket's server {:?}",
            client.peer_pid()
        )));
    }
    let result = client.call("core.adopt", json!({ "nonce": supervisor_token }))?;
    let status = result
        .get("status")
        .cloned()
        .ok_or_else(|| RpcError::Protocol("core.adopt result: missing status".into()))?;
    Ok((client, status))
}

/// A core process the supervisor did not spawn, identified by the pid the OS named as its socket's server. On
/// Windows it also holds a process handle opened while that was true, so the pid cannot be recycled under it.
pub struct Peer {
    pub pid: u32,
    /// The core's address: on unix a signal is sent only while the OS still names `pid` as its server.
    #[cfg_attr(windows, allow(dead_code))]
    address: String,
    #[cfg(windows)]
    handle: isize,
}

impl Peer {
    /// Call this while the pid is known to be the server (right after the probe, or with the lifeline open).
    pub fn open(pid: u32, layout: &Layout) -> Peer {
        let address = core_address(&layout.home, platform());
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Threading::{
                OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
                PROCESS_TERMINATE,
            };
            // SAFETY: plain OpenProcess; a null handle means the process is gone (or not ours to open).
            let handle = unsafe {
                OpenProcess(
                    PROCESS_TERMINATE | PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                    0,
                    pid,
                )
            } as isize;
            Peer {
                pid,
                address,
                handle,
            }
        }
        #[cfg(not(windows))]
        Peer { pid, address }
    }

    /// Whether the process still exists: `kill(pid, 0)` (a zombie counts as gone), or the Windows handle not signalled.
    pub fn alive(&self) -> bool {
        #[cfg(unix)]
        {
            // SAFETY: signal 0 only checks that the pid exists.
            let r = unsafe { libc::kill(self.pid as libc::pid_t, 0) };
            let exists =
                r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
            exists && !is_zombie(self.pid)
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
            use windows_sys::Win32::System::Threading::WaitForSingleObject;
            if self.handle == 0 {
                return false;
            }
            // SAFETY: a handle this struct owns.
            unsafe { WaitForSingleObject(self.handle as _, 0) == WAIT_TIMEOUT }
        }
    }

    /// Whether the OS names `pid` as the server of the core's socket right now.
    #[cfg(unix)]
    fn still_serves(&self) -> bool {
        transport::connect(&self.address, Duration::from_millis(300))
            .ok()
            .and_then(|s| s.peer_pid())
            == Some(self.pid)
    }

    #[cfg(unix)]
    fn signal(&self, sig: libc::c_int) -> bool {
        if !(self.alive() && self.still_serves()) {
            return false;
        }
        // SAFETY: kill(2) on the pid the OS has just named as the core socket's server.
        unsafe { libc::kill(self.pid as libc::pid_t, sig) == 0 }
    }

    /// SIGTERM (unix); Windows has none. Returns whether a signal was sent.
    pub fn terminate(&self) -> bool {
        #[cfg(unix)]
        {
            self.signal(libc::SIGTERM)
        }
        #[cfg(windows)]
        {
            false
        }
    }

    /// SIGKILL / TerminateProcess. Returns whether it was sent.
    pub fn kill(&self) -> bool {
        #[cfg(unix)]
        {
            self.signal(libc::SIGKILL)
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Threading::TerminateProcess;
            // SAFETY: a handle this struct owns, opened with PROCESS_TERMINATE.
            self.alive() && unsafe { TerminateProcess(self.handle as _, 1) != 0 }
        }
    }
}

#[cfg(windows)]
impl Drop for Peer {
    fn drop(&mut self) {
        if self.handle != 0 {
            // SAFETY: closes the handle this struct owns, once.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle as _) };
        }
    }
}

/// A zombie has exited but is not reaped yet (its parent may not be a reaper): `/proc/<pid>/stat` state `Z`.
#[cfg(target_os = "linux")]
fn is_zombie(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|s| {
            let rest = &s[s.rfind(')')? + 1..];
            rest.trim_start().chars().next()
        })
        == Some('Z')
}

#[cfg(all(unix, not(target_os = "linux")))]
fn is_zombie(_pid: u32) -> bool {
    false
}

/// Terminates a hung or foreign core found at start (S6, S8): `core.shutdown` on a fresh connection to that same
/// server, SIGTERM (unix) after 2 s, SIGKILL / TerminateProcess 10 s later (both × the time scale). Returns once the
/// process is gone, or after the kill plus a short wait.
pub fn terminate_found(shared: &Arc<Shared>, layout: &Layout, pid: u32, probe: &str) {
    let scale = shared.lock().time_scale;
    let s = |ms: u64| Duration::from_secs_f64(ms as f64 / 1000.0 * scale);
    let peer = Peer::open(pid, layout);
    let t0 = Instant::now();
    let log = |step: &str| {
        shared.log.warn(
            "terminating a core found at start",
            json!({ "pid": pid, "probe": probe, "step": step }),
        )
    };
    log("shutdown");
    // On its own thread: a hung core never answers, and the escalation below must not wait for it.
    let layout2 = layout.clone();
    let spawned = spawn_guarded(shared, &format!("core-shutdown-{pid}"), move || {
        let address = core_address(&layout2.home, platform());
        let Some(token) = read_core_token(&layout2) else {
            return;
        };
        let Ok(stream) = transport::connect(&address, PROBE_TIMEOUT) else {
            return;
        };
        if stream.peer_pid() != Some(pid) {
            return;
        }
        if let Ok(mut c) = Client::handshake(stream, &token, core_options(PROBE_TIMEOUT)) {
            let _ = c.call("core.shutdown", json!({}));
        }
    });
    if let Err(e) = spawned {
        shared.log.error(
            "cannot start the shutdown thread",
            json!({ "err": e.to_string() }),
        );
    }
    let term_at = t0 + s(2_000);
    if wait_gone(&peer, term_at) {
        return;
    }
    if cfg!(unix) {
        log("terminate");
        peer.terminate();
    }
    if wait_gone(&peer, term_at + s(10_000)) {
        return;
    }
    log("kill");
    peer.kill();
    if !wait_gone(&peer, Instant::now() + POST_KILL_WAIT) {
        shared.log.error(
            "core found at start still running after the kill",
            json!({ "pid": pid }),
        );
    }
}

/// Waits until the process is gone or `deadline` passes; returns whether it is gone.
fn wait_gone(peer: &Peer, deadline: Instant) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_listening_probes_absent() {
        let dir = std::env::temp_dir().join(format!("p1b-probe-{}", std::process::id()));
        let layout = Layout::new(dir.clone());
        assert_eq!(probe_core(&layout, PROBE_TIMEOUT), Probe::Absent);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_listener_without_a_token_file_probes_hung_with_its_own_pid() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(layout.run()).unwrap();
        let address = core_address(&layout.home, "posix");
        let _listener = std::os::unix::net::UnixListener::bind(&address).unwrap();
        assert_eq!(
            probe_core(&layout, PROBE_TIMEOUT),
            Probe::Hung {
                peer_pid: std::process::id()
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn our_own_process_is_alive_and_a_reaped_child_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        assert!(Peer::open(std::process::id(), &layout).alive());
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        // Exited but not reaped: on Linux a zombie counts as gone.
        #[cfg(target_os = "linux")]
        {
            let deadline = Instant::now() + Duration::from_secs(5);
            while Peer::open(pid, &layout).alive() {
                assert!(Instant::now() < deadline, "zombie still alive");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        child.wait().unwrap();
        assert!(!Peer::open(pid, &layout).alive());
        // A pid that serves no socket is never signalled.
        assert!(!Peer::open(std::process::id(), &layout).terminate());
    }
}
