//! Private local RPC listeners, shared by the supervisor and engine processes.
//!
//! Callers create and protect the parent `run/` directory and remove only confirmed stale endpoints before binding.
//! Unix sockets are made `0600`; Windows pipes use the explicit user-and-SYSTEM DACL and overlapped I/O.
use std::io::{self, Read, Write};
use std::sync::Arc;
use std::time::Duration;

/// One connection, split so a writer and a watchdog can run while its reader is blocked.
pub struct Accepted {
    /// Kernel-authenticated peer process; never taken from a request or handshake field.
    pub peer_pid: Option<u32>,
    /// The blocking input stream, independent of the writer.
    pub reader: Box<dyn Read + Send>,
    /// The output stream, usable while the reader blocks.
    pub writer: Box<dyn Write + Send>,
    /// Cancels blocked I/O and closes the connection. Safe to call repeatedly, from another thread.
    pub closer: Arc<dyn Fn() + Send + Sync>,
    /// Delivers the last reply before close; the Windows flush has a two-second deadline.
    pub drain: Box<dyn FnMut() + Send>,
    /// Adjusts the reader's deadline after splitting; use `None` to clear the authentication idle deadline.
    pub read_timeout: Box<dyn Fn(Option<Duration>) -> io::Result<()> + Send>,
}

impl Accepted {
    /// The process id the kernel reported when this connection was accepted.
    pub fn peer_pid(&self) -> Option<u32> {
        self.peer_pid
    }

    /// Bounds reads. On Windows this also bounds writes on the shared overlapped pipe handle.
    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        (self.read_timeout)(timeout)
    }
}

impl Read for Accepted {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.reader.read(buf)
    }
}

impl Write for Accepted {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.writer.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

#[cfg(unix)]
#[path = "server_transport_unix.rs"]
mod imp;
#[cfg(windows)]
#[path = "server_transport_windows.rs"]
mod imp;

pub use imp::Listener;
