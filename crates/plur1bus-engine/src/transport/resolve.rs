//! Deadline-bound name resolution, separate from the HTTP client's pinned resolver.
use super::TransportError;
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::mpsc;
use std::time::Instant;

/// Resolve all records for one hop, without opening a connection.
pub trait Resolver: Send + Sync {
    /// Return every address; the caller validates all records before selecting one.
    fn resolve(
        &self,
        host: &str,
        port: u16,
        deadline: Instant,
    ) -> Result<Vec<IpAddr>, TransportError>;
}

/// Operating-system resolver with a bounded waiting time.
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve(
        &self,
        host: &str,
        port: u16,
        deadline: Instant,
    ) -> Result<Vec<IpAddr>, TransportError> {
        deadline
            .checked_duration_since(Instant::now())
            .ok_or(TransportError::Timeout)?;
        if let Ok(ip) = host.parse::<IpAddr>() {
            return Ok(vec![ip]);
        }
        let host = host.to_owned();
        let (send, receive) = mpsc::sync_channel(1);
        // getaddrinfo has no portable cancellation API. The worker only resolves: it never dials,
        // and a late result is discarded when the receiver's absolute deadline expires.
        std::thread::spawn(move || {
            let addresses = (host.as_str(), port)
                .to_socket_addrs()
                .map(|all| all.map(|address| address.ip()).collect());
            let _ = send.send(addresses);
        });
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(TransportError::Timeout)?;
        match receive.recv_timeout(remaining) {
            Ok(Ok(addresses)) => Ok(addresses),
            Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => Err(TransportError::Network),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(TransportError::Timeout),
        }
    }
}
