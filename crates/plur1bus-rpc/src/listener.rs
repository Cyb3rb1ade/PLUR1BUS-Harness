//! Owner-only server transport; Windows native operations stay here, outside forbid-unsafe tools code.
use std::io::{Read, Write};
use std::sync::Arc;

/// One accepted native connection, including a cancellable close and bounded output drain.
pub struct Accepted {
    /// Kernel-authenticated peer PID, when the platform provides one.
    pub peer_pid: Option<u32>,
    /// Incoming byte stream.
    pub reader: Box<dyn Read + Send>,
    /// Outgoing byte stream.
    pub writer: Box<dyn Write + Send>,
    /// Interrupts blocked I/O; repeated calls are harmless.
    pub closer: Arc<dyn Fn() + Send + Sync>,
    /// Gives the peer a bounded opportunity to receive the last reply.
    pub drain: Box<dyn FnMut() + Send>,
}

#[cfg(windows)]
pub use crate::listener_windows::Listener;

#[cfg(unix)]
pub use posix::Listener;

#[cfg(unix)]
mod posix {
    use super::Accepted;
    use std::io;
    use std::net::Shutdown;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    /// A Unix listener whose socket is owner-readable and owner-writable only.
    pub struct Listener(UnixListener);

    impl Listener {
        /// Binds a new socket; refuses an existing address, including a live peer.
        pub fn bind(address: &str) -> io::Result<Self> {
            let listener = UnixListener::bind(address)?;
            std::fs::set_permissions(address, std::fs::Permissions::from_mode(0o600))?;
            Ok(Self(listener))
        }

        /// Accepts one peer and provides an independently closable reader and writer.
        pub fn accept(&self) -> io::Result<Accepted> {
            let (stream, _) = self.0.accept()?;
            let peer_pid = crate::transport::unix_peer_pid(&stream);
            let reader = stream.try_clone()?;
            let closer = stream.try_clone()?;
            Ok(Accepted {
                peer_pid,
                reader: Box::new(reader),
                writer: Box::new(stream),
                closer: std::sync::Arc::new(move || {
                    let _ = closer.shutdown(Shutdown::Both);
                }),
                drain: Box::new(|| {}),
            })
        }
    }
}
