//! The reachability probe of spec §5.2 step 5: the injected seam and its TCP implementation.

use futures_util::future::BoxFuture;
use std::net::SocketAddr;
use std::time::Duration;

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

/// How long one connect may take (spec §5.2 step 5).
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// At most this many addresses of the connect set are tried (spec §5.2 step 5).
pub const PROBE_ADDRESSES: usize = 4;

/// The TCP probe: tries the first [`PROBE_ADDRESSES`] addresses in order, each for [`PROBE_TIMEOUT`], and stops at the
/// first connect. It writes no byte and closes the socket at once; the kernel's choice of local address is the answer
/// (spec §9.3: an independent signal, not the CLI's word). `Refused` when any tried address answered with a refusal
/// (or the set is empty); `Timeout` when none answered (timed out, or host/network unreachable).
#[derive(Clone, Copy, Debug)]
pub struct TcpProber {
    timeout: Duration,
}

impl Default for TcpProber {
    fn default() -> Self {
        Self {
            timeout: PROBE_TIMEOUT,
        }
    }
}

impl Prober for TcpProber {
    fn probe<'a>(&'a self, addrs: &'a [SocketAddr]) -> BoxFuture<'a, ProbeOutcome> {
        Box::pin(async move {
            let mut refused = addrs.is_empty();
            for remote in addrs.iter().take(PROBE_ADDRESSES) {
                let mut connect = Box::pin(tokio::net::TcpStream::connect(*remote));
                let attempt = tokio::time::timeout(self.timeout, &mut connect).await;
                if attempt.is_err() {
                    // Closing a socket whose connect is still in flight can block (about a second on macOS);
                    // close it on a blocking thread so the time per address stays the timeout.
                    tokio::task::spawn_blocking(move || drop(connect));
                } else {
                    drop(connect);
                }
                match attempt {
                    Ok(Ok(stream)) => {
                        let local = stream.local_addr();
                        drop(stream);
                        match local {
                            Ok(local) => {
                                return ProbeOutcome::Connected {
                                    local,
                                    remote: *remote,
                                }
                            }
                            Err(_) => refused = true,
                        }
                    }
                    // The peer answered with a reset: refused. Anything else (no route, host or network
                    // unreachable) means no answer from the peer, like a timeout.
                    Ok(Err(e)) if is_refusal(e.kind()) => refused = true,
                    Ok(Err(_)) | Err(_) => {}
                }
            }
            if refused {
                ProbeOutcome::Refused
            } else {
                ProbeOutcome::Timeout
            }
        })
    }
}

fn is_refusal(kind: std::io::ErrorKind) -> bool {
    matches!(
        kind,
        std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::ConnectionReset
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::ErrorKind;

    #[test]
    fn only_an_answer_from_the_peer_is_a_refusal() {
        assert!(is_refusal(ErrorKind::ConnectionRefused));
        assert!(is_refusal(ErrorKind::ConnectionReset));
        for kind in [
            ErrorKind::HostUnreachable,
            ErrorKind::NetworkUnreachable,
            ErrorKind::TimedOut,
            ErrorKind::AddrNotAvailable,
            ErrorKind::PermissionDenied,
        ] {
            assert!(!is_refusal(kind), "{kind:?}");
        }
    }
}
