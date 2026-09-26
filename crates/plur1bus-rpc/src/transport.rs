//! One blocking byte stream to the core: a Unix socket, or a Windows named pipe opened as a file.
use std::io::{self, Read, Write};
use std::time::Duration;

pub trait Stream: Read + Write + Send {
    fn set_read_timeout(&self, d: Option<Duration>) -> io::Result<()>;
    /// The pid the OS names as the process at the other end (ruling S6): `SO_PEERCRED` (Linux), `LOCAL_PEERPID`
    /// (macOS), `GetNamedPipeServerProcessId` (Windows). `None` where the OS cannot tell. Unlike a pid file, this is
    /// the process that owns the socket now, so it is the only pid a supervisor may signal.
    fn peer_pid(&self) -> Option<u32>;
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
    use super::*;
    use std::fs::{File, OpenOptions};
    use std::time::Instant;
    pub struct S(File);
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
    // H2: overlapped I/O with timeouts; until then a Windows read blocks without a deadline.
    impl Stream for S {
        fn set_read_timeout(&self, _d: Option<Duration>) -> io::Result<()> {
            Ok(())
        }
        fn peer_pid(&self) -> Option<u32> {
            use std::os::windows::io::AsRawHandle;
            let mut pid: u32 = 0;
            // SAFETY: the handle is the open pipe client this `File` owns; `pid` is a live local.
            let ok = unsafe {
                windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId(
                    self.0.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE,
                    &mut pid,
                )
            };
            (ok != 0 && pid != 0).then_some(pid)
        }
    }
    pub fn connect(address: &str, connect_timeout: Duration) -> io::Result<Box<dyn Stream>> {
        let start = Instant::now();
        loop {
            match OpenOptions::new().read(true).write(true).open(address) {
                Ok(f) => return Ok(Box::new(S(f))),
                // 231 = ERROR_PIPE_BUSY: every server instance is taken; retry until the connect timeout.
                Err(e) if e.raw_os_error() == Some(231) && start.elapsed() < connect_timeout => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(e) => return Err(e),
            }
        }
    }
}

pub use imp::connect;
