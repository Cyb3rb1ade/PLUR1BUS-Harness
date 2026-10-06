//! One blocking byte stream to the core: a Unix socket, or a Windows named pipe opened as a file.
use std::io::{self, Read, Write};
use std::time::Duration;

pub trait Stream: Read + Write + Send {
    fn set_read_timeout(&self, d: Option<Duration>) -> io::Result<()>;
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

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::unix::net::UnixStream;
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
    fn peer_pid_of(fd: std::os::unix::io::RawFd) -> Option<u32> {
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
    fn peer_pid_of(fd: std::os::unix::io::RawFd) -> Option<u32> {
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
    fn peer_pid_of(_fd: std::os::unix::io::RawFd) -> Option<u32> {
        None
    }
    /// A missing socket file fails at once (ENOENT) — that is the "core absent" case the CLI answers in < 300 ms.
    /// A local connect does not wait on a live listener, so the timeout is not needed here; `Client::connect` applies it
    /// to the `core.auth` handshake, which bounds a core that accepts but never answers.
    pub fn connect(address: &str, _connect_timeout: Duration) -> io::Result<Box<dyn Stream>> {
        Ok(Box::new(S(UnixStream::connect(address)?)))
    }
}

#[cfg(windows)]
mod imp {
    //! The pipe is opened with `FILE_FLAG_OVERLAPPED`; every read is `ReadFile` + `WaitForSingleObject(event,
    //! deadline)` + `CancelIoEx` on timeout ([`crate::win::overlapped_op`]), so a read deadline works as on unix: the
    //! timeout surfaces as `call-timeout` and poisons the client.
    use super::*;
    use crate::win::{pipe_server_pid, OverlappedPipe};
    pub struct S(OverlappedPipe);
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
            Ok(())
        }
    }
    impl Stream for S {
        /// Also bounds each write, which on a pipe can block while the server does not read.
        fn set_read_timeout(&self, d: Option<Duration>) -> io::Result<()> {
            self.0.set_timeout(d);
            Ok(())
        }
        fn peer_pid(&self) -> Option<u32> {
            pipe_server_pid(self.0.handle())
        }
    }
    /// Retries while every server instance is busy (`ERROR_PIPE_BUSY`) until the connect timeout.
    pub fn connect(address: &str, connect_timeout: Duration) -> io::Result<Box<dyn Stream>> {
        Ok(Box::new(S(OverlappedPipe::connect(
            address,
            connect_timeout,
        )?)))
    }
}

pub use imp::connect;
