//! One blocking byte stream to the core: a Unix socket, or a Windows named pipe opened as a file.
use std::io::{self, Read, Write};
use std::time::Duration;

pub trait Stream: Read + Write + Send {
    fn set_read_timeout(&self, d: Option<Duration>) -> io::Result<()>;
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
