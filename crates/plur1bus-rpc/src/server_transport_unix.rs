//! Owner-only Unix sockets with bounded, interruptible accept waits.
use super::Accepted;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// An owner-only Unix socket. The caller owns the socket path's cleanup.
pub struct Listener(UnixListener);

/// A socket shared by the halves of one connection; reads and writes go through `&UnixStream` (a socket is duplex).
struct Shared(Arc<UnixStream>);

impl Read for Shared {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        (&*self.0).read(buf)
    }
}

impl Write for Shared {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        (&*self.0).write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        (&*self.0).flush()
    }
}

impl Listener {
    /// Creates a new socket and makes it `0600`; an existing socket path is never removed.
    pub fn bind(address: &str) -> io::Result<Self> {
        let listener = UnixListener::bind(address)?;
        std::fs::set_permissions(address, std::fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        Ok(Self(listener))
    }

    /// Waits for one connection without a deadline.
    pub fn accept(&self) -> io::Result<Accepted> {
        self.accept_inner(None)?
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "accept deadline passed"))
    }

    /// Returns `None` at the deadline so a server can observe its shutdown signal without a dummy connection.
    pub fn accept_timeout(&self, timeout: Duration) -> io::Result<Option<Accepted>> {
        self.accept_inner(Some(timeout))
    }

    fn accept_inner(&self, timeout: Option<Duration>) -> io::Result<Option<Accepted>> {
        let start = Instant::now();
        loop {
            match self.0.accept() {
                Ok((stream, _)) => {
                    // Accepted sockets remain blocking even though the listener polls nonblocking.
                    stream.set_nonblocking(false)?;
                    let peer_pid = crate::transport::unix_peer_pid(&stream);
                    // One descriptor per connection (P4-10 security review M2): the reader and the writer share the
                    // socket, which is closed when both are dropped. The closer and the timer only refer to it
                    // (fix round 1b F2): a closer kept for a grace period never holds a socket open.
                    let socket = Arc::new(stream);
                    let closer = Arc::downgrade(&socket);
                    let timer = Arc::downgrade(&socket);
                    return Ok(Some(Accepted {
                        peer_pid,
                        reader: Box::new(Shared(socket.clone())),
                        writer: Box::new(Shared(socket)),
                        closer: Arc::new(move || {
                            if let Some(socket) = closer.upgrade() {
                                let _ = socket.shutdown(Shutdown::Both);
                            }
                        }),
                        // The kernel delivers what was written before close.
                        drain: Box::new(|| {}),
                        read_timeout: Box::new(move |timeout| match timer.upgrade() {
                            Some(socket) => socket.set_read_timeout(timeout),
                            None => Err(io::Error::from(io::ErrorKind::NotConnected)),
                        }),
                    }));
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    let wait_ms = match timeout {
                        Some(timeout) => {
                            let remaining = timeout.saturating_sub(start.elapsed());
                            if remaining.is_zero() {
                                return Ok(None);
                            }
                            remaining.as_millis().clamp(1, i32::MAX as u128) as i32
                        }
                        None => -1,
                    };
                    let mut descriptor = libc::pollfd {
                        fd: self.0.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    };
                    // SAFETY: `descriptor` is one live pollfd; the listener owns its fd for this call.
                    let ready = unsafe { libc::poll(&mut descriptor, 1, wait_ms) };
                    if ready < 0 {
                        let error = io::Error::last_os_error();
                        if error.kind() != io::ErrorKind::Interrupted {
                            return Err(error);
                        }
                    }
                }
                Err(error) => return Err(error),
            }
        }
    }
}
