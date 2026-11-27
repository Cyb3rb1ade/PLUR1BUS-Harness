use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Instant;

pub trait TimedStream: Read + Write + Send {
    fn peer_addr(&self) -> io::Result<SocketAddr>;

    /// Bound the underlying socket operation, including any TLS I/O it may perform.
    fn set_deadline(&mut self, deadline: Instant) -> io::Result<()>;
}

impl TimedStream for TcpStream {
    fn peer_addr(&self) -> io::Result<SocketAddr> {
        TcpStream::peer_addr(self)
    }

    fn set_deadline(&mut self, deadline: Instant) -> io::Result<()> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::from(io::ErrorKind::TimedOut));
        }
        self.set_read_timeout(Some(remaining))?;
        self.set_write_timeout(Some(remaining))
    }
}

#[cfg(feature = "email")]
pub(crate) struct DeadlineStream {
    pub(crate) io: Box<dyn TimedStream>,
    pub(crate) deadline: Instant,
}

#[cfg(feature = "email")]
impl Read for DeadlineStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.io.set_deadline(self.deadline)?;
        self.io.read(buffer)
    }
}

#[cfg(feature = "email")]
impl Write for DeadlineStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.io.set_deadline(self.deadline)?;
        self.io.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.io.set_deadline(self.deadline)?;
        self.io.flush()
    }
}
