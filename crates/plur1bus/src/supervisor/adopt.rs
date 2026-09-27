//! Adoption of a core that is already running when the supervisor starts (spec §6.4, rulings S3–S6, S19).
//!
//! Before any spawn the supervisor probes the child's address ([`probe_child`]; [`probe_core`] for the core). A core that answers as the one
//! `run/core.pid` names is adopted through `core.adopt { nonce }` ([`adopt`]): the nonce is the content of
//! `run/supervisor.token`, and the connection the call succeeds on becomes the core's lifeline. A core that accepts but
//! does not answer, or that is not the one the pid file names, is terminated ([`terminate_found`]) and a fresh one is
//! spawned.
//!
//! The only pid the supervisor ever signals is one the OS names as the socket's server ([`Stream::peer_pid`]:
//! `SO_PEERCRED`, `LOCAL_PEERPID`, `GetNamedPipeServerProcessId`). [`Peer`] pins that process while the pid is known to
//! be the server: a pidfd on Linux, a process handle on Windows, so a recycled pid is never signalled. macOS has no
//! such handle; there the pid is re-checked as the socket's server right before each signal. `run/core.pid` only
//! serves to recognise a foreign core.
//!
//! Everything here takes the child's [`Role`]: its address and run files come from [`Layout::endpoints`], its calls
//! from [`Role::method`]. Only the core is supervised so far.
use super::state::{Role, RoleKind};
use super::{spawn_guarded, Shared};
#[cfg(test)]
use crate::paths::core_address;
use crate::paths::{Endpoints, Layout};
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

/// What answers on the core's address. `peer` is the socket's server as the OS names it, pinned at the probe.
pub enum Probe {
    /// Nothing listens (no socket or pipe, or a stale socket file that refuses connections).
    Absent,
    /// A core that authenticated with `run/core.token`, whose hello `pid` is the socket's server and whose
    /// `instanceId` is the one in `run/core.pid`. `client` is that authenticated connection: [`adopt`] runs on it.
    Serving {
        peer: Peer,
        hello: Value,
        client: Client,
    },
    /// It accepts connections but `core.auth` got no answer in time, or there is no `run/core.token` to try.
    Hung { peer: Peer },
    /// It answers, but not as the core `run/core.pid` names (or the handshake failed outright).
    Foreign { peer: Peer, reason: String },
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

    /// The server's pid, when something serves.
    pub fn peer_pid(&self) -> Option<u32> {
        match self {
            Probe::Absent => None,
            Probe::Serving { peer, .. } | Probe::Hung { peer } | Probe::Foreign { peer, .. } => {
                Some(peer.pid)
            }
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

fn endpoints(layout: &Layout, role: &Role) -> Endpoints {
    layout.endpoints(role, platform())
}

fn read_token(ep: &Endpoints) -> Option<String> {
    let t = std::fs::read_to_string(&ep.token).ok()?;
    let t = t.trim().to_string();
    (!t.is_empty()).then_some(t)
}

/// The pid in the child's pid file (`<pid> <instanceId>`), the first field.
fn pid_file_pid(ep: &Endpoints) -> Option<u32> {
    std::fs::read_to_string(&ep.pid)
        .ok()?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

/// The instance id in the child's pid file (`<pid> <instanceId>`).
fn pid_file_instance(ep: &Endpoints) -> Option<String> {
    let s = std::fs::read_to_string(&ep.pid).ok()?;
    s.split_whitespace().nth(1).map(str::to_string)
}

/// The handshake endpoint of `role`: `core.auth` for the core, `module.auth` for a module (B9).
pub(crate) fn rpc_endpoint(role: &Role) -> Endpoint {
    match role.kind {
        RoleKind::Core => Endpoint::Core,
        RoleKind::Module => Endpoint::Module,
    }
}

fn child_options(role: &Role, timeout: Duration) -> ConnectOptions {
    ConnectOptions {
        connect_timeout: timeout,
        call_timeout: timeout,
        endpoint: rpc_endpoint(role),
        // The probe reads the server's pid itself and classifies a mismatch (`Foreign`); callers check it first.
        expected_server_pid: None,
    }
}

/// Probes the core's address: [`probe_child`] for [`Role::core`].
pub fn probe_core(layout: &Layout, timeout: Duration) -> Probe {
    probe_child(layout, &Role::core(), timeout)
}

/// Probes `role`'s address (rule S6): a failed connect → `Absent`; a server other than the pid in its pid file
/// (`run/core.pid` for the core) → `Foreign` before the token is sent (S11); connected, but no token file or no
/// handshake answer within `timeout` → `Hung`; hello `pid` ≠ the socket's server, or hello `instanceId` ≠ the pid
/// file's → `Foreign`; otherwise `Serving`. The handshake runs on the very connection whose peer pid was read.
pub fn probe_child(layout: &Layout, role: &Role, timeout: Duration) -> Probe {
    let ep = endpoints(layout, role);
    let Ok(stream) = transport::connect(&ep.address, timeout) else {
        return Probe::Absent;
    };
    // Every supported OS names the server. Where one cannot, nothing may be signalled: the fresh core's spawn then
    // fails with `lock-held` and backs off until the address is free.
    let Some(peer_pid) = stream.peer_pid() else {
        return Probe::Absent;
    };
    // Pinned now, while the connection names it as the server.
    let peer = Peer::open_at(peer_pid, ep.address.clone());
    // S11: a server other than the process the pid file names never receives the token.
    if let Some(recorded) = pid_file_pid(&ep) {
        if recorded != peer_pid {
            return Probe::Foreign {
                peer,
                reason: "server-pid-mismatch".into(),
            };
        }
    }
    let Some(token) = read_token(&ep) else {
        return Probe::Hung { peer };
    };
    let client = match handshake_bounded(stream, token, child_options(role, timeout)) {
        Some(Ok(c)) => c,
        None => return Probe::Hung { peer },
        Some(Err(RpcError::Unavailable { reason, .. })) if reason == "handshake-timeout" => {
            return Probe::Hung { peer }
        }
        Some(Err(e)) => {
            return Probe::Foreign {
                peer,
                reason: format!("handshake-failed: {e}"),
            }
        }
    };
    let hello = client.hello().clone();
    if hello["pid"].as_u64() != Some(u64::from(peer_pid)) {
        return Probe::Foreign {
            peer,
            reason: "pid-mismatch".into(),
        };
    }
    match pid_file_instance(&ep) {
        None => Probe::Foreign {
            peer,
            reason: "no-pid-file".into(),
        },
        Some(id) if hello["instanceId"].as_str() != Some(id.as_str()) => Probe::Foreign {
            peer,
            reason: "instance-mismatch".into(),
        },
        Some(_) => Probe::Serving {
            peer,
            hello,
            client,
        },
    }
}

/// `core.auth` on `stream`, bounded by `timeout` plus a margin on top of the read deadline the client sets itself
/// (every OS has one now, Windows through overlapped reads): `None` when the bound expires. A thread left behind ends
/// with its read deadline.
fn handshake_bounded(
    stream: Box<dyn Stream>,
    token: String,
    opts: ConnectOptions,
) -> Option<Result<Client, RpcError>> {
    let timeout = opts.call_timeout;
    let (tx, rx) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("core-probe".into())
        .spawn(move || {
            let _ = tx.send(Client::handshake(stream, &token, opts));
        });
    if spawned.is_err() {
        return None;
    }
    rx.recv_timeout(timeout + Duration::from_millis(500)).ok()
}

/// Adopts the child `client` is authenticated with (the probe's own connection, so no other process can slip in
/// between probe and adoption): `core.adopt { nonce: supervisor_token }` (`role`'s own `adopt`). Returns the
/// connection, which is now the child's lifeline and must stay open for as long as the child is supervised, and the
/// child's status. Refused when the OS does not name the socket's server, or names another pid than the hello.
pub fn adopt(
    mut client: Client,
    role: &Role,
    supervisor_token: &str,
) -> Result<(Client, Value), RpcError> {
    let name = &role.name;
    let peer_pid = client.peer_pid().ok_or_else(|| {
        RpcError::Protocol(format!("the OS does not name the {name} socket's server"))
    })?;
    let hello_pid = client.hello()["pid"].as_u64();
    if hello_pid != Some(u64::from(peer_pid)) {
        return Err(RpcError::Protocol(format!(
            "the {name}'s hello pid {hello_pid:?} is not the socket's server {peer_pid}"
        )));
    }
    let method = role.method("adopt");
    let result = client.call(&method, json!({ "nonce": supervisor_token }))?;
    let status = result
        .get("status")
        .cloned()
        .ok_or_else(|| RpcError::Protocol(format!("{method} result: missing status")))?;
    Ok((client, status))
}

/// A core process the supervisor did not spawn, identified by the pid the OS named as its socket's server and pinned
/// while that was true: a pidfd on Linux (kernel >= 5.3), a process handle on Windows. Signals go through the pin, so a
/// recycled pid is never hit. Without a pin (macOS, or when pinning failed) a signal is sent only while a fresh
/// connect still names `pid` as the core socket's server; a core that has closed its listener is then not signalled
/// (its own orphan grace ends it).
pub struct Peer {
    pub pid: u32,
    /// The core's address, for the unpinned fallback.
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    address: String,
    #[cfg(target_os = "linux")]
    pidfd: Option<std::os::fd::OwnedFd>,
    #[cfg(windows)]
    handle: isize,
}

impl Peer {
    /// Call this while the pid is known to be the server (right after the probe read it from the connection).
    pub fn open(pid: u32, layout: &Layout) -> Peer {
        Peer::open_at(pid, endpoints(layout, &Role::core()).address)
    }

    /// [`Peer::open`] for the server of `address` (a child's address, [`Layout::endpoints`]).
    pub fn open_at(pid: u32, address: String) -> Peer {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::FromRawFd;
            // SAFETY: pidfd_open(2) with no flags; a non-negative result is a new fd this struct then owns.
            let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
            let pidfd = (fd >= 0).then(|| unsafe { std::os::fd::OwnedFd::from_raw_fd(fd as i32) });
            Peer {
                pid,
                address,
                pidfd,
            }
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Threading::{
                OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
                PROCESS_TERMINATE,
            };
            // SAFETY: plain OpenProcess; a null handle means it could not be opened (see `pin_failed`).
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
        #[cfg(not(any(target_os = "linux", windows)))]
        Peer { pid, address }
    }

    /// Pinning was possible on this OS but failed (no pidfd, no process handle): liveness and signals fall back to
    /// the socket.
    pub fn pin_failed(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            self.pidfd.is_none()
        }
        #[cfg(windows)]
        {
            self.handle == 0
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        {
            false
        }
    }

    /// Whether the process still exists. Linux: the pidfd is not readable (it becomes readable when the process
    /// exits, zombie included). Windows: the handle is not signalled; without a handle "cannot tell" counts as alive
    /// while the core's pipe still exists. Otherwise `kill(pid, 0)`, with a Linux zombie counted as gone.
    pub fn alive(&self) -> bool {
        #[cfg(target_os = "linux")]
        if let Some(fd) = &self.pidfd {
            use std::os::fd::AsRawFd;
            let mut p = libc::pollfd {
                fd: fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: one pollfd on a live local, zero timeout.
            let r = unsafe { libc::poll(&mut p, 1, 0) };
            if r >= 0 {
                return !(r > 0 && p.revents & libc::POLLIN != 0);
            }
        }
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
                // Cannot tell from the process: alive while its pipe is there (231 = every instance busy).
                return match transport::connect(&self.address, Duration::from_millis(300)) {
                    Ok(s) => s.peer_pid().is_none_or(|p| p == self.pid),
                    Err(e) => e.raw_os_error() == Some(231),
                };
            }
            // SAFETY: a handle this struct owns.
            unsafe { WaitForSingleObject(self.handle as _, 0) == WAIT_TIMEOUT }
        }
    }

    /// Whether the OS names `pid` as the server of the core's socket right now (the unpinned fallback).
    #[cfg(unix)]
    fn still_serves(&self) -> bool {
        transport::connect(&self.address, Duration::from_millis(300))
            .ok()
            .and_then(|s| s.peer_pid())
            == Some(self.pid)
    }

    #[cfg(unix)]
    fn signal(&self, sig: libc::c_int) -> bool {
        if !self.alive() {
            return false;
        }
        #[cfg(target_os = "linux")]
        if let Some(fd) = &self.pidfd {
            use std::os::fd::AsRawFd;
            // SAFETY: pidfd_send_signal(2) on the pinned process; null info, no flags.
            let r = unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    fd.as_raw_fd(),
                    sig,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                )
            };
            return r == 0;
        }
        if !self.still_serves() {
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

    /// SIGKILL / TerminateProcess. Returns whether it was sent (never without a Windows handle).
    pub fn kill(&self) -> bool {
        #[cfg(unix)]
        {
            self.signal(libc::SIGKILL)
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Threading::TerminateProcess;
            // SAFETY: a handle this struct owns, opened with PROCESS_TERMINATE.
            self.handle != 0
                && self.alive()
                && unsafe { TerminateProcess(self.handle as _, 1) != 0 }
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

/// Terminates a hung or foreign child found at start (S6, S8): `core.shutdown` (`role`'s own `shutdown`) on a fresh
/// connection to that same server, SIGTERM (unix) after 2 s, SIGKILL / TerminateProcess 10 s later (both × the time
/// scale). Returns once the process is gone, or after the kill plus a short wait.
pub fn terminate_found(
    shared: &Arc<Shared>,
    layout: &Layout,
    role: &Role,
    peer: Peer,
    probe: &str,
) {
    let scale = shared.lock().time_scale;
    let s = |ms: u64| Duration::from_secs_f64(ms as f64 / 1000.0 * scale);
    let pid = peer.pid;
    let t0 = Instant::now();
    let what = format!("terminating a {} found at start", role.name);
    let log = |step: &str| {
        shared
            .log
            .warn(&what, json!({ "pid": pid, "probe": probe, "step": step }))
    };
    log("shutdown");
    // On its own thread: a hung core never answers, and the escalation below must not wait for it.
    let ep = endpoints(layout, role);
    let role2 = role.clone();
    let spawned = spawn_guarded(
        shared,
        &format!("{}-shutdown-{pid}", role.name),
        move || {
            let Some(token) = read_token(&ep) else {
                return;
            };
            let Ok(stream) = transport::connect(&ep.address, PROBE_TIMEOUT) else {
                return;
            };
            if stream.peer_pid() != Some(pid) {
                return;
            }
            if let Ok(mut c) =
                Client::handshake(stream, &token, child_options(&role2, PROBE_TIMEOUT))
            {
                let _ = c.call(&role2.method("shutdown"), json!({}));
            }
        },
    );
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
            &format!("{} found at start still running after the kill", role.name),
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
        assert!(matches!(probe_core(&layout, PROBE_TIMEOUT), Probe::Absent));
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
        let found = probe_core(&layout, PROBE_TIMEOUT);
        assert_eq!(found.name(), "hung");
        assert_eq!(found.peer_pid(), Some(std::process::id()));
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
    }

    /// Linux (M4): the pin is taken at open; the signal goes through the pidfd, and once the process is gone the
    /// pin refuses to signal anything, whatever process the pid may name by then.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_pinned_peer_is_signalled_through_its_pidfd_and_never_after_its_exit() {
        use std::os::unix::process::ExitStatusExt;
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let peer = Peer::open(child.id(), &layout);
        assert!(!peer.pin_failed());
        assert!(peer.alive());
        assert!(peer.kill(), "no socket is needed with a pin");
        assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGKILL));
        assert!(!peer.alive());
        assert!(!peer.kill() && !peer.terminate());
    }

    /// Without a pin (macOS): a pid that does not serve the core socket is never signalled.
    #[cfg(all(unix, not(target_os = "linux")))]
    #[test]
    fn an_unpinned_peer_that_serves_no_socket_is_not_signalled() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let peer = Peer::open(child.id(), &layout);
        assert!(peer.alive());
        assert!(!peer.terminate() && !peer.kill());
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
