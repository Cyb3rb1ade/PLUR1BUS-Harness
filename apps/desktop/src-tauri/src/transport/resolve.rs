//! Name resolution through the OS resolver (spec §6.1).

use futures_util::future::BoxFuture;
use std::net::SocketAddr;
use std::time::Duration;

/// How long a lookup may take (spec §6.1). The blocking worker may finish later; its result is dropped.
pub const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);
/// At most this many addresses of one name are used.
pub const MAX_ADDRESSES: usize = 32;

/// Why a name did not resolve (spec §6.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResolveError {
    /// NXDOMAIN, no address, or any other resolver failure.
    NotFound,
    /// No answer within [`LOOKUP_TIMEOUT`].
    Timeout,
}

/// Resolves a host name to socket addresses. Injected into the check so tests never touch DNS.
pub trait Resolver: Send + Sync {
    fn lookup<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> BoxFuture<'a, Result<Vec<SocketAddr>, ResolveError>>;
}

/// The OS resolver (`getaddrinfo` through `tokio::net::lookup_host`), the one the connection would use, so split
/// DNS, VPN DNS, the hosts file and mDNS behave as the person expects. No DoH, no third-party resolver.
#[derive(Clone, Copy, Debug)]
pub struct OsResolver {
    timeout: Duration,
}

impl Default for OsResolver {
    fn default() -> Self {
        Self {
            timeout: LOOKUP_TIMEOUT,
        }
    }
}

impl Resolver for OsResolver {
    fn lookup<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> BoxFuture<'a, Result<Vec<SocketAddr>, ResolveError>> {
        Box::pin(bounded(
            self.timeout,
            port,
            tokio::net::lookup_host((host, port)),
        ))
    }
}

/// Runs a lookup under `budget` and maps its outcome: no answer in time → `Timeout`, an error or no address →
/// `NotFound`, otherwise the [`normalise`]d addresses.
async fn bounded<I: IntoIterator<Item = SocketAddr>>(
    budget: Duration,
    port: u16,
    lookup: impl std::future::Future<Output = std::io::Result<I>>,
) -> Result<Vec<SocketAddr>, ResolveError> {
    match tokio::time::timeout(budget, lookup).await {
        Err(_) => Err(ResolveError::Timeout),
        Ok(Err(_)) => Err(ResolveError::NotFound),
        Ok(Ok(addrs)) => {
            let addrs = normalise(addrs, port);
            if addrs.is_empty() {
                Err(ResolveError::NotFound)
            } else {
                Ok(addrs)
            }
        }
    }
}

/// Sets every address to `port`, removes duplicates (first one kept, order kept) and keeps at most
/// [`MAX_ADDRESSES`]. An IPv6 scope id from the resolver is kept, so a link-local answer stays connectable.
pub(super) fn normalise(addrs: impl IntoIterator<Item = SocketAddr>, port: u16) -> Vec<SocketAddr> {
    let mut out: Vec<SocketAddr> = Vec::new();
    for mut sa in addrs {
        if out.len() == MAX_ADDRESSES {
            break;
        }
        sa.set_port(port);
        if !out.contains(&sa) {
            out.push(sa);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, SocketAddrV6};

    fn sa(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn normalise_dedupes_keeps_order_sets_port_and_caps() {
        let got = normalise(
            [
                sa("10.0.0.2:1"),
                sa("10.0.0.1:2"),
                sa("10.0.0.2:3"),
                sa("[::1]:4"),
            ],
            443,
        );
        assert_eq!(
            got,
            vec![sa("10.0.0.2:443"), sa("10.0.0.1:443"), sa("[::1]:443")]
        );
        let many = (0..100u8).map(|i| SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 0, 1, i)), 1));
        let got = normalise(many, 22);
        assert_eq!(got.len(), MAX_ADDRESSES);
        assert_eq!(got[31], sa("10.0.1.31:22"));
        // Duplicates do not use up the cap.
        let dupes = std::iter::repeat_n(sa("10.0.0.1:1"), 50).chain([sa("10.0.0.2:1")]);
        assert_eq!(
            normalise(dupes, 1),
            vec![sa("10.0.0.1:1"), sa("10.0.0.2:1")]
        );
    }

    #[test]
    fn normalise_keeps_the_scope_id() {
        let scoped = SocketAddr::V6(SocketAddrV6::new("fe80::1".parse().unwrap(), 1, 0, 7));
        let got = normalise([scoped], 22);
        let SocketAddr::V6(v6) = got[0] else {
            panic!("v6")
        };
        assert_eq!((v6.port(), v6.scope_id()), (22, 7));
    }

    #[tokio::test]
    async fn bounded_maps_timeout_error_empty_and_answers() {
        let never = std::future::pending::<std::io::Result<Vec<SocketAddr>>>();
        assert_eq!(
            bounded(Duration::from_millis(20), 443, never).await,
            Err(ResolveError::Timeout)
        );
        let failed = async { Err::<Vec<SocketAddr>, _>(std::io::Error::other("nxdomain")) };
        assert_eq!(
            bounded(LOOKUP_TIMEOUT, 443, failed).await,
            Err(ResolveError::NotFound)
        );
        let empty = async { Ok::<_, std::io::Error>(Vec::<SocketAddr>::new()) };
        assert_eq!(
            bounded(LOOKUP_TIMEOUT, 443, empty).await,
            Err(ResolveError::NotFound)
        );
        let answer = async { Ok::<_, std::io::Error>(vec![sa("10.0.0.1:1"), sa("10.0.0.1:2")]) };
        assert_eq!(
            bounded(LOOKUP_TIMEOUT, 443, answer).await,
            Ok(vec![sa("10.0.0.1:443")])
        );
    }

    #[test]
    fn os_resolver_default_budget_is_five_seconds() {
        assert_eq!(OsResolver::default().timeout, Duration::from_secs(5));
    }
}
