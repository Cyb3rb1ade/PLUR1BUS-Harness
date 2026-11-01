//! One blocking byte stream to the core: a Unix socket, or a Windows named pipe opened as a file.
use std::io::{self, Read, Write};
use std::time::Duration;

pub trait Stream: Read + Write + Send {
    fn set_read_timeout(&self, d: Option<Duration>) -> io::Result<()>;
    /// Optional duplex support. Existing test streams need not implement background-client I/O.
    fn try_clone_stream(&self) -> io::Result<Box<dyn Stream>> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "stream cannot be cloned",
        ))
    }
    /// Bounds writes independently where the transport supports it.
    fn set_write_timeout(&self, _d: Option<Duration>) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "stream has no write deadline",
        ))
    }
    /// Aborts in-flight I/O on every clone of this connection.
    fn shutdown(&self) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "stream cannot be shut down",
        ))
    }
    /// The pid the OS names as the process at the other end (ruling S6): `SO_PEERCRED` (Linux), `LOCAL_PEERPID`
    /// (macOS), `GetNamedPipeServerProcessId` (Windows). `None` where the OS cannot tell. Unlike a pid file, this is
    /// the process that owns the socket now, so it is the only pid a supervisor may signal.
    fn peer_pid(&self) -> Option<u32>;
    /// The uid the OS names as the process at the other end of a Unix socket (`SO_PEERCRED` on Linux, `getpeereid`
    /// on macOS); `None` where the OS cannot tell and on Windows. A client refuses a server of another uid before it
    /// sends anything (audit M2, [`crate::trust::check_peer_uid`]).
    fn peer_uid(&self) -> Option<u32> {
        None
    }
}

/// The OS-authenticated peer of an accepted Unix connection, using the same probe as outbound RPC streams.
/// Unsupported platforms or unavailable credentials return `None`; callers requiring identity must fail closed.
#[cfg(unix)]
pub fn unix_peer_pid(stream: &std::os::unix::net::UnixStream) -> Option<u32> {
    use std::os::fd::AsRawFd;
    imp::peer_pid_of(stream.as_raw_fd())
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::net::{SocketAddr, UnixStream};
    use std::time::Instant;
    pub struct S(UnixStream);
    impl Read for S {
        fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
            self.0.read(b)
        }
    }
    impl Write for S {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0.write(b)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }
    impl Stream for S {
        fn set_read_timeout(&self, d: Option<Duration>) -> io::Result<()> {
            self.0.set_read_timeout(d)
        }
        fn try_clone_stream(&self) -> io::Result<Box<dyn Stream>> {
            Ok(Box::new(S(self.0.try_clone()?)))
        }
        fn set_write_timeout(&self, d: Option<Duration>) -> io::Result<()> {
            self.0.set_write_timeout(d)
        }
        fn shutdown(&self) -> io::Result<()> {
            self.0.shutdown(std::net::Shutdown::Both)
        }
        fn peer_pid(&self) -> Option<u32> {
            use std::os::unix::io::AsRawFd;
            peer_pid_of(self.0.as_raw_fd())
        }
        fn peer_uid(&self) -> Option<u32> {
            use std::os::unix::io::AsRawFd;
            peer_uid_of(self.0.as_raw_fd())
        }
    }

    /// The effective uid the kernel recorded for the listening process (`SO_PEERCRED`).
    #[cfg(any(target_os = "linux", target_os = "android"))]
    fn peer_uid_of(fd: std::os::unix::io::RawFd) -> Option<u32> {
        let mut cred = libc::ucred {
            pid: 0,
            uid: 0,
            gid: 0,
        };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: getsockopt writes at most `len` bytes into `cred`, a live local of that size.
        let r = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut cred as *mut libc::ucred).cast(),
                &mut len,
            )
        };
        (r == 0).then_some(cred.uid)
    }

    /// The effective uid of the peer (`getpeereid`).
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    ))]
    fn peer_uid_of(fd: std::os::unix::io::RawFd) -> Option<u32> {
        let (mut uid, mut gid): (libc::uid_t, libc::gid_t) = (0, 0);
        // SAFETY: getpeereid writes one uid_t and one gid_t into live locals.
        let r = unsafe { libc::getpeereid(fd, &mut uid, &mut gid) };
        (r == 0).then_some(uid)
    }

    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    )))]
    fn peer_uid_of(_fd: std::os::unix::io::RawFd) -> Option<u32> {
        None
    }

    /// The credentials the kernel recorded for the listening process when the connection was made.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    pub(super) fn peer_pid_of(fd: std::os::unix::io::RawFd) -> Option<u32> {
        let mut cred = libc::ucred {
            pid: 0,
            uid: 0,
            gid: 0,
        };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: getsockopt writes at most `len` bytes into `cred`, a live local of that size.
        let r = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut cred as *mut libc::ucred).cast(),
                &mut len,
            )
        };
        (r == 0 && cred.pid > 0).then_some(cred.pid as u32)
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    pub(super) fn peer_pid_of(fd: std::os::unix::io::RawFd) -> Option<u32> {
        let mut pid: libc::pid_t = 0;
        let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
        // SAFETY: getsockopt writes at most `len` bytes into `pid`, a live local of that size.
        let r = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_LOCAL,
                libc::LOCAL_PEERPID,
                (&mut pid as *mut libc::pid_t).cast(),
                &mut len,
            )
        };
        (r == 0 && pid > 0).then_some(pid as u32)
    }

    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    )))]
    pub(super) fn peer_pid_of(_fd: std::os::unix::io::RawFd) -> Option<u32> {
        None
    }
    /// A nonblocking connect also bounds a live listener whose accept backlog is full.
    pub fn connect(address: &str, connect_timeout: Duration) -> io::Result<Box<dyn Stream>> {
        // Keep std's pathname validation, including its rejection of NUL and overlong paths.
        SocketAddr::from_pathname(address)?;
        let start = Instant::now();
        #[cfg(any(
            target_os = "linux",
            target_os = "android",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "openbsd",
            target_os = "dragonfly"
        ))]
        let socket_type = libc::SOCK_STREAM | libc::SOCK_CLOEXEC;
        #[cfg(not(any(
            target_os = "linux",
            target_os = "android",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "openbsd",
            target_os = "dragonfly"
        )))]
        let socket_type = libc::SOCK_STREAM;
        // SAFETY: socket has no pointer arguments; the returned descriptor is owned immediately.
        let fd = unsafe { libc::socket(libc::AF_UNIX, socket_type, 0) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: socket returned a fresh valid descriptor and this is its only owner.
        let stream = unsafe { UnixStream::from_raw_fd(fd) };
        // The fcntl fallback retains close-on-exec on platforms without SOCK_CLOEXEC.
        // SAFETY: fd belongs to the live stream; these commands do not take pointer arguments.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            return Err(io::Error::last_os_error());
        }
        #[cfg(any(
            target_vendor = "apple",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "dragonfly"
        ))]
        {
            // Raw socket construction must preserve std's SIGPIPE suppression on these systems.
            let enabled: libc::c_int = 1;
            // SAFETY: enabled is a live c_int of the supplied length; fd belongs to stream.
            if unsafe {
                libc::setsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    libc::SO_NOSIGPIPE,
                    (&enabled as *const libc::c_int).cast(),
                    std::mem::size_of_val(&enabled) as libc::socklen_t,
                )
            } < 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        stream.set_nonblocking(true)?;
        // SAFETY: a zeroed sockaddr_un is valid storage; every field passed to connect is set below.
        let mut socket_address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        socket_address.sun_family = libc::AF_UNIX as libc::sa_family_t;
        for (destination, byte) in socket_address.sun_path.iter_mut().zip(address.bytes()) {
            *destination = byte as libc::c_char;
        }
        let length = std::mem::offset_of!(libc::sockaddr_un, sun_path)
            + address.len()
            + usize::from(!address.is_empty());
        #[cfg(any(
            target_vendor = "apple",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "openbsd",
            target_os = "dragonfly"
        ))]
        {
            socket_address.sun_len = length as u8;
        }
        // SAFETY: socket_address has a validated pathname and length bounded by its allocation.
        let connected = unsafe {
            libc::connect(
                fd,
                (&socket_address as *const libc::sockaddr_un).cast(),
                length as libc::socklen_t,
            )
        };
        if connected < 0 {
            let error = io::Error::last_os_error();
            // AF_UNIX EAGAIN means no connect was queued (a saturated Linux backlog). Polling that
            // socket can report SO_ERROR=0 while it remains unconnected, so fail promptly instead.
            if !matches!(
                error.raw_os_error(),
                Some(libc::EINPROGRESS) | Some(libc::EALREADY)
            ) {
                return Err(error);
            }
            wait_connected(&stream, start, connect_timeout)?;
        }
        stream.set_nonblocking(false)?;
        Ok(Box::new(S(stream)))
    }

    fn wait_connected(stream: &UnixStream, start: Instant, timeout: Duration) -> io::Result<()> {
        loop {
            let remaining = timeout.saturating_sub(start.elapsed());
            if remaining.is_zero() {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "RPC connect deadline exceeded",
                ));
            }
            let mut descriptor = libc::pollfd {
                fd: stream.as_raw_fd(),
                events: libc::POLLOUT,
                revents: 0,
            };
            let wait_ms = remaining
                .as_nanos()
                .div_ceil(1_000_000)
                .min(i32::MAX as u128) as i32;
            // SAFETY: descriptor is one live pollfd and stream owns its fd for this call.
            let ready = unsafe { libc::poll(&mut descriptor, 1, wait_ms) };
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if ready == 0 {
                continue;
            }
            // take_error reads SO_ERROR, preserving an asynchronous connect failure.
            return match stream.take_error()? {
                Some(error) => Err(error),
                None => Ok(()),
            };
        }
    }
}

#[cfg(windows)]
mod imp {
    //! The pipe is opened with `FILE_FLAG_OVERLAPPED`; every read is `ReadFile` + `WaitForSingleObject(event,
    //! deadline)` + `CancelIoEx` on timeout ([`crate::win::overlapped_op`]), so a read deadline works as on unix: the
    //! timeout surfaces as `call-timeout` and poisons the client.
    use super::*;
    use crate::win::{pipe_server_pid, OverlappedPipe};
    use std::sync::{Arc, Mutex};
    // Exactly one reader and one serialized writer share the pipe's separate overlapped events.
    #[derive(Clone)]
    pub struct S {
        // Revoke every idle clone on shutdown; active operations retain an Arc until cancellation
        // completes, then the last handle closes and the peer observes EOF without requiring Drop.
        pipe: Arc<Mutex<Option<Arc<OverlappedPipe>>>>,
        read_lock: Arc<Mutex<()>>,
        write_lock: Arc<Mutex<()>>,
    }
    impl S {
        fn pipe(&self) -> io::Result<Arc<OverlappedPipe>> {
            self.pipe
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
                .ok_or_else(|| io::Error::new(io::ErrorKind::ConnectionAborted, "RPC pipe closed"))
        }
    }
    impl Read for S {
        fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
            let _read = self.read_lock.lock().unwrap_or_else(|e| e.into_inner());
            self.pipe()?.read(b)
        }
    }
    impl Write for S {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            let _write = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
            self.pipe()?.write(b)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl Stream for S {
        /// Also bounds each write, which on a pipe can block while the server does not read.
        fn set_read_timeout(&self, d: Option<Duration>) -> io::Result<()> {
            self.pipe()?.set_timeout(d);
            Ok(())
        }
        fn try_clone_stream(&self) -> io::Result<Box<dyn Stream>> {
            Ok(Box::new(self.clone()))
        }
        fn set_write_timeout(&self, d: Option<Duration>) -> io::Result<()> {
            // BackgroundClient passes its read tick; synchronous callers retain their full budget.
            self.pipe()?.set_timeout(d);
            Ok(())
        }
        fn shutdown(&self) -> io::Result<()> {
            if let Some(pipe) = self.pipe.lock().unwrap_or_else(|e| e.into_inner()).take() {
                pipe.cancel_io();
            }
            Ok(())
        }
        fn peer_pid(&self) -> Option<u32> {
            self.pipe()
                .ok()
                .and_then(|pipe| pipe_server_pid(pipe.handle()))
        }
    }
    /// Retries while every server instance is busy (`ERROR_PIPE_BUSY`) until the connect timeout.
    pub fn connect(address: &str, connect_timeout: Duration) -> io::Result<Box<dyn Stream>> {
        Ok(Box::new(S {
            pipe: Arc::new(Mutex::new(Some(Arc::new(OverlappedPipe::connect(
                address,
                connect_timeout,
            )?)))),
            read_lock: Arc::new(Mutex::new(())),
            write_lock: Arc::new(Mutex::new(())),
        }))
    }
}

pub use imp::connect;
