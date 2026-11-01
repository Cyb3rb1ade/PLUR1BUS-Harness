//! The shared named pipe (ruling S11): a byte-mode pipe whose DACL grants full control to the user and SYSTEM
//! only (`D:P(A;;GA;;;<user SID>)(A;;GA;;;SY)`), whose first instance is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`
//! (a pipe of that name that someone else created first makes the bind fail instead of sharing the name), and which
//! refuses remote clients.
//!
//! Every instance is overlapped. That lets the auth-idle watchdog end a connection whose reader is blocked:
//! `CancelIoEx` first (the pending `ReadFile` returns `ERROR_OPERATION_ABORTED`), then `DisconnectNamedPipe`. On a
//! synchronous handle the disconnect would wait behind the pending read instead. `drain` (`FlushFileBuffers`, which
//! waits until the client has read everything) runs with a deadline, so a client that never reads cannot hold up a
//! close or a `daemon.stop`.
use super::Accepted;
use crate::win::{overlapped_op, pipe_client_pid, OverlappedPipe, SecurityDescriptor};
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    FlushFileBuffers, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{CreateEventW, INFINITE};
use windows_sys::Win32::System::IO::CancelSynchronousIo;

/// How long a close or a stop waits for the client to read the last reply.
const DRAIN_DEADLINE: Duration = Duration::from_secs(2);
const FIRST_INSTANCE_RETRY_DEADLINE: Duration = Duration::from_secs(1);
const FIRST_INSTANCE_RETRY_INTERVAL: Duration = Duration::from_millis(10);
const ACCEPT_LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(1);

/// A local byte-mode pipe restricted to the current user and SYSTEM (S11).
pub struct Listener {
    name: Vec<u16>,
    security: SecurityDescriptor,
    /// The instance the next `accept` waits on.
    next: Mutex<Option<OwnedHandle>>,
}

fn create_instance(
    name: &[u16],
    security: &SecurityDescriptor,
    first: bool,
) -> io::Result<OwnedHandle> {
    let attributes = security.attributes();
    let mode = PIPE_ACCESS_DUPLEX
        | FILE_FLAG_OVERLAPPED
        | if first {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        };
    // SAFETY: `name` is NUL-terminated; `attributes` points into `security`, which outlives the call.
    let h = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            &attributes,
        )
    };
    if h == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `h` is a valid handle we own.
    Ok(unsafe { OwnedHandle::from_raw_handle(h) })
}

/// Waits for a client on the overlapped instance `h`.
fn wait_for_client(h: &OwnedHandle, timeout: Option<Duration>) -> io::Result<()> {
    // SAFETY: default security, manual reset, not signalled, unnamed.
    let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if event.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a new handle we own.
    let event = unsafe { OwnedHandle::from_raw_handle(event) };
    let raw = h.as_raw_handle();
    // SAFETY: `raw` is a pipe instance this listener owns; overlapped_op keeps the OVERLAPPED alive until done.
    let timeout_ms = timeout.map_or(INFINITE, |d| {
        d.as_millis().clamp(1, u128::from(INFINITE - 1)) as u32
    });
    match overlapped_op(raw, event.as_raw_handle(), timeout_ms, |ov| unsafe {
        ConnectNamedPipe(raw, ov)
    }) {
        Ok(_) => Ok(()),
        // A client that connected between CreateNamedPipeW and ConnectNamedPipe.
        Err(e) if e.raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32) => Ok(()),
        Err(e) => Err(e),
    }
}

struct Pipe(Arc<OverlappedPipe>);
impl Read for Pipe {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        self.0.read(b)
    }
}
impl Write for Pipe {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.write(b)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// `FlushFileBuffers` on a helper thread, awaited for at most `deadline`. After that its I/O is cancelled (both
/// ways, since whether the flush counts as synchronous I/O on an overlapped handle is the driver's business) and the
/// connection is closed anyway.
fn drain_with_deadline(pipe: &Arc<OverlappedPipe>, deadline: Duration) {
    let (tx, rx) = mpsc::channel();
    let p = pipe.clone();
    let spawned = std::thread::Builder::new()
        .name("pipe-drain".into())
        .spawn(move || {
            // SAFETY: `p` keeps the handle open for the call.
            unsafe { FlushFileBuffers(p.handle()) };
            let _ = tx.send(());
        });
    let Ok(thread) = spawned else {
        return;
    };
    if rx.recv_timeout(deadline).is_err() {
        pipe.cancel_io();
        // SAFETY: the JoinHandle keeps the thread handle valid; cancelling I/O of a thread that has none is a no-op.
        unsafe { CancelSynchronousIo(thread.as_raw_handle()) };
    }
}

impl Listener {
    /// Creates the first instance. A short-lived existing instance can belong to a supervisor that has released its
    /// single-instance lock but has not finished exiting yet; retry that teardown window, then refuse the name
    /// (`ERROR_ACCESS_DENIED`) rather than sharing it with a squatter.
    pub fn bind(address: &str) -> io::Result<Self> {
        let name: Vec<u16> = std::ffi::OsStr::new(address)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let security = SecurityDescriptor::user_and_system()?;
        let deadline = Instant::now() + FIRST_INSTANCE_RETRY_DEADLINE;
        let first = loop {
            match create_instance(&name, &security, true) {
                Ok(first) => break first,
                Err(e)
                    if e.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32)
                        && Instant::now() < deadline =>
                {
                    std::thread::sleep(FIRST_INSTANCE_RETRY_INTERVAL);
                }
                Err(e) => return Err(e),
            }
        };
        Ok(Self {
            name,
            security,
            next: Mutex::new(Some(first)),
        })
    }

    /// Waits for one connection without a deadline.
    pub fn accept(&self) -> io::Result<Accepted> {
        self.accept_inner(None)?
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "accept deadline passed"))
    }

    /// Cancels only the pending overlapped connect at the deadline, retaining the instance for the next accept.
    /// A connect that completed during cancellation is accepted by `overlapped_op`, never discarded.
    pub fn accept_timeout(&self, timeout: Duration) -> io::Result<Option<Accepted>> {
        self.accept_inner(Some(timeout))
    }

    fn accept_inner(&self, timeout: Option<Duration>) -> io::Result<Option<Accepted>> {
        let start = Instant::now();
        // Keep concurrent accepts serialized without allowing an unbounded accept to defeat another's deadline.
        let mut next = match timeout {
            None => self.next.lock().unwrap_or_else(|e| e.into_inner()),
            Some(timeout) => loop {
                match self.next.try_lock() {
                    Ok(next) => break next,
                    Err(TryLockError::Poisoned(error)) => break error.into_inner(),
                    Err(TryLockError::WouldBlock) => {
                        let remaining = timeout.saturating_sub(start.elapsed());
                        if remaining.is_zero() {
                            return Ok(None);
                        }
                        std::thread::sleep(remaining.min(ACCEPT_LOCK_RETRY_INTERVAL));
                    }
                }
            },
        };
        let h = match next.take() {
            Some(h) => h,
            None => create_instance(&self.name, &self.security, false)?,
        };
        let remaining = timeout.map(|timeout| timeout.saturating_sub(start.elapsed()));
        if let Err(error) = wait_for_client(&h, remaining) {
            if error.kind() == io::ErrorKind::TimedOut {
                *next = Some(h);
                return Ok(None);
            }
            return Err(error);
        }
        // Keep an instance listening while this one is served (clients retry on ERROR_PIPE_BUSY meanwhile).
        if let Ok(n) = create_instance(&self.name, &self.security, false) {
            *next = Some(n);
        }
        let pipe = Arc::new(OverlappedPipe::new(h)?);
        let peer_pid = pipe_client_pid(pipe.handle());
        let closer = pipe.clone();
        let drain = pipe.clone();
        let timer = pipe.clone();
        Ok(Some(Accepted {
            peer_pid,
            reader: Box::new(Pipe(pipe.clone())),
            writer: Box::new(Pipe(pipe)),
            closer: Arc::new(move || {
                // Cancel the blocked read first, then disconnect: never disconnect behind a pending read.
                closer.cancel_io();
                // SAFETY: `closer` keeps the handle open for the call.
                unsafe { DisconnectNamedPipe(closer.handle()) };
            }),
            drain: Box::new(move || drain_with_deadline(&drain, DRAIN_DEADLINE)),
            read_timeout: Box::new(move |timeout| {
                timer.set_timeout(timeout);
                Ok(())
            }),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address() -> String {
        format!(
            r"\\.\pipe\plur1bus-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    #[test]
    fn accept_deadline_includes_waiting_for_another_accept_to_release_the_instance() {
        let listener = Listener::bind(&address()).unwrap();
        let _held = listener.next.lock().unwrap();
        let start = Instant::now();
        assert!(listener
            .accept_timeout(Duration::from_millis(20))
            .unwrap()
            .is_none());
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn bind_retries_a_transient_first_instance_collision() {
        let address = address();
        let name: Vec<u16> = std::ffi::OsStr::new(&address)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let security = SecurityDescriptor::user_and_system().unwrap();
        let held = create_instance(&name, &security, true).unwrap();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            drop(held);
        });

        let started = Instant::now();
        let listener = Listener::bind(&address).unwrap();
        assert!(started.elapsed() >= Duration::from_millis(100));

        drop(listener);
        releaser.join().unwrap();
    }
}
