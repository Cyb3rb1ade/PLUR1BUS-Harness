//! The relay (plan §2.4, P4-03 review §7): every client connection of the front door gets its own link, a connection to
//! the legacy core's address authenticated with the client's own credentials plus the front door's link credential
//! (`core.auth.frontDoor`). The front door decides native or relay from its route table *before* it dispatches, so a
//! relayed request goes to the legacy core as the client wrote it (its id, `_meta`, params and number spellings), and
//! the legacy core's ajv stays the authority on params and results of the methods it serves.
//!
//! A link carries one client's identity only: the legacy core binds it at the link's `core.auth` and checks RBAC on every
//! relayed call itself until the cut. Requests the front door must see the answer of (`core.status`, `core.adopt`,
//! `core.shutdown`, `events.subscribe`, `events.unsubscribe`, a re-authentication) are sent with an id of the front door's
//! own ([`Link::next_id`]) and mapped back to the client's id when the answer comes.
use plur1bus_rpc::transport::{self, Stream};
use std::io::{self, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// How long connecting to the legacy core may take.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

/// The writing half of a link and the means to close it.
pub struct Link {
    writer: Mutex<Box<dyn Stream>>,
    closer: Mutex<Box<dyn Stream>>,
    nonce: String,
    next: AtomicU64,
}

impl Link {
    /// Connects to the legacy core at `address` and checks that the process serving it is `legacy_pid` (the OS's peer
    /// credentials: `SO_PEERCRED`/`LOCAL_PEERPID`, or the pipe's server process on Windows), before any credential is
    /// sent. Returns the link and the reading half.
    pub fn connect(address: &str, legacy_pid: u32) -> io::Result<(Link, Box<dyn Stream>)> {
        let stream = transport::connect(address, CONNECT_TIMEOUT)?;
        if stream.peer_pid() != Some(legacy_pid) {
            let _ = stream.shutdown();
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the legacy address is served by another process",
            ));
        }
        stream.set_read_timeout(None)?;
        let reader = stream.try_clone_stream()?;
        let closer = stream.try_clone_stream()?;
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).map_err(|_| io::Error::other("no entropy"))?;
        Ok((
            Link {
                writer: Mutex::new(stream),
                closer: Mutex::new(closer),
                nonce: nonce.iter().map(|b| format!("{b:02x}")).collect(),
                next: AtomicU64::new(1),
            },
            reader,
        ))
    }

    /// Writes one complete line (with its newline).
    pub fn send(&self, line: &[u8]) -> io::Result<()> {
        let mut writer = self.writer.lock().unwrap_or_else(|p| p.into_inner());
        writer.write_all(line)?;
        writer.flush()
    }

    /// Writes `line` and its newline as one line (no other line can come between them).
    pub fn send_line(&self, line: &[u8]) -> io::Result<()> {
        let mut writer = self.writer.lock().unwrap_or_else(|p| p.into_inner());
        writer.write_all(line)?;
        writer.write_all(b"\n")?;
        writer.flush()
    }

    /// A request id of the front door's own on this link: `fd-<per-link random>-<n>`, so a client's ids never collide
    /// with it.
    pub fn next_id(&self) -> String {
        format!(
            "fd-{}-{}",
            self.nonce,
            self.next.fetch_add(1, Ordering::Relaxed)
        )
    }

    /// Whether `id` is one of this link's own ids.
    pub fn owns(&self, id: &str) -> bool {
        id.strip_prefix("fd-")
            .and_then(|rest| rest.strip_prefix(self.nonce.as_str()))
            .is_some_and(|rest| rest.starts_with('-'))
    }

    /// Closes the link (both directions; the legacy core sees the client go).
    pub fn close(&self) {
        let closer = self.closer.lock().unwrap_or_else(|p| p.into_inner());
        let _ = closer.shutdown();
    }
}
