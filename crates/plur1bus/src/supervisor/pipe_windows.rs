//! The supervisor's named pipe (ruling S11): a byte-mode pipe whose DACL grants full control to the user and SYSTEM
//! only (`D:P(A;;GA;;;<user SID>)(A;;GA;;;SY)`), whose first instance is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`
//! (a pipe of that name that someone else created first makes the bind fail instead of sharing the name), and which
//! refuses remote clients.
//!
//! Every instance is overlapped. That lets the auth-idle watchdog end a connection whose reader is blocked:
//! `CancelIoEx` first (the pending `ReadFile` returns `ERROR_OPERATION_ABORTED`), then `DisconnectNamedPipe`. On a
//! synchronous handle the disconnect would wait behind the pending read instead. `drain` (`FlushFileBuffers`, which
//! waits until the client has read everything) runs with a deadline, so a client that never reads cannot hold up a
//! close or a `daemon.stop`.
use super::server::Accepted;
use plur1bus_rpc::win::{overlapped_op, OverlappedPipe, SecurityDescriptor};
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use windows_sys::Win32::Foundation::{ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE};
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
fn wait_for_client(h: &OwnedHandle) -> io::Result<()> {
    // SAFETY: default security, manual reset, not signalled, unnamed.
    let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if event.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a new handle we own.
    let event = unsafe { OwnedHandle::from_raw_handle(event) };
    let raw = h.as_raw_handle();
    // SAFETY: `raw` is a pipe instance this listener owns; overlapped_op keeps the OVERLAPPED alive until done.
    match overlapped_op(raw, event.as_raw_handle(), INFINITE, |ov| unsafe {
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
    /// Creates the first instance: a pipe of that name that already exists, whoever made it, is an error
    /// (`ERROR_ACCESS_DENIED`), so the supervisor never shares its name with a squatter.
    pub fn bind(address: &str) -> io::Result<Self> {
        let name: Vec<u16> = std::ffi::OsStr::new(address)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let security = SecurityDescriptor::user_and_system()?;
        let first = create_instance(&name, &security, true)?;
        Ok(Self {
            name,
            security,
            next: Mutex::new(Some(first)),
        })
    }

    pub fn accept(&self) -> io::Result<Accepted> {
        let h = match self.next.lock().unwrap_or_else(|e| e.into_inner()).take() {
            Some(h) => h,
            None => create_instance(&self.name, &self.security, false)?,
        };
        wait_for_client(&h)?;
        // Keep an instance listening while this one is served (clients retry on ERROR_PIPE_BUSY meanwhile).
        if let Ok(n) = create_instance(&self.name, &self.security, false) {
            *self.next.lock().unwrap_or_else(|e| e.into_inner()) = Some(n);
        }
        let pipe = Arc::new(OverlappedPipe::new(h)?);
        let closer = pipe.clone();
        let drain = pipe.clone();
        Ok(Accepted {
            reader: Box::new(Pipe(pipe.clone())),
            writer: Box::new(Pipe(pipe)),
            closer: Box::new(move || {
                // Cancel the blocked read first, then disconnect: never disconnect behind a pending read.
                closer.cancel_io();
                // SAFETY: `closer` keeps the handle open for the call.
                unsafe { DisconnectNamedPipe(closer.handle()) };
            }),
            drain: Box::new(move || drain_with_deadline(&drain, DRAIN_DEADLINE)),
        })
    }
}
