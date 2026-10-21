//! The reachability probe of spec §5.2 step 5, as an injected seam. Package T3 adds the TCP implementation.

use futures_util::future::BoxFuture;
use std::net::SocketAddr;

/// Connects to the connect set (no bytes sent) and reports the socket's local address, which the check compares with
/// this device's Tailscale addresses.
pub trait Prober: Send + Sync {
    fn probe<'a>(&'a self, addrs: &'a [SocketAddr]) -> BoxFuture<'a, ProbeOutcome>;
}

/// What a probe found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeOutcome {
    Connected {
        local: SocketAddr,
        remote: SocketAddr,
    },
    Refused,
    Timeout,
}
