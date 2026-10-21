//! Transport choice for remote connections and SSH hosts (spec
//! `docs/superpowers/specs/2026-10-21-desktop-transport-choice-design.md`).
//!
//! [`check_target`] is the one place that decides a target's category, its hints and the exact address set a client
//! may connect to ([`ConnectPin`]); [`gate`] turns a public target without a confirmation into
//! [`TransportError::ConfirmNeeded`]. [`TransportStore`] keeps the person's choice in `connection-transport.json`
//! beside `connections.json`, which it never writes. Classification itself is `plur1bus-desktop-net` (spec §4).
//!
//! The check is never a trust signal (spec §9.1): nothing here relaxes TLS, pins, pairing or host keys.

mod host;
mod probe;
mod report;
mod resolve;
mod store;
mod tailscale;

pub use host::HostInput;
pub use plur1bus_desktop_net::Category;
pub use probe::{ProbeOutcome, Prober};
pub use report::{Hint, Severity, TransportReport};
pub use resolve::{OsResolver, ResolveError, Resolver, LOOKUP_TIMEOUT, MAX_ADDRESSES};
pub use store::{StoreMode, TransportEntry, TransportStore, TransportStoreError};
pub use tailscale::{
    PeerView, TailnetView, TailscaleSource, TailscaleStatus, TailscaleView, UnavailableWhy,
};

use plur1bus_desktop_net::{
    aggregate, canonical, is_tailnet, target_class, AddrClass, CLASSIFIER_ID,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;

/// The path the person chose (spec §2 T1). It selects checks and notices; it never changes trust rules (T4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Tailscale,
    Direct,
}

/// What the target is for; it picks the banner text in the UI (spec §7.2) and does not change the check.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Purpose {
    Remote,
    Ssh,
    SshJump,
}

/// The confirmation for a public direct target (spec §2 T10): when and under which classifier snapshot, never which
/// addresses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicAck {
    pub at_ms: u64,
    pub classifier: String,
}

impl PublicAck {
    /// A confirmation given now, under the current snapshot [`CLASSIFIER_ID`].
    pub fn now() -> Self {
        let at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
        Self {
            at_ms,
            classifier: CLASSIFIER_ID.to_owned(),
        }
    }
}

/// One target to check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetInput {
    pub host: HostInput,
    pub port: u16,
    pub transport: Transport,
    pub purpose: Purpose,
}

/// What clients must use for this open (spec §9.2): `host` for TLS SNI and certificate checks, and exactly `addrs` for
/// every socket, so nothing resolves the host a second time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectPin {
    pub host: String,
    pub addrs: Vec<SocketAddr>,
}

/// A successful check: the pin to connect with and the report for the UI.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckedTarget {
    pub pin: ConnectPin,
    pub report: TransportReport,
}

/// The injected seams of a check. [`check_target`] does no I/O except through these.
#[derive(Clone)]
pub struct CheckDeps {
    pub resolver: Arc<dyn Resolver>,
    pub tailscale: Arc<dyn TailscaleSource>,
    pub prober: Arc<dyn Prober>,
}

/// Refusals and command errors (spec §8). Only invalid input refuses; everything else is a hint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportError {
    /// No connectable address (unspecified, multicast, broadcast), or a host string that is not a valid host at all.
    NotConnectable,
    /// An IPv4 address in a legacy `inet_aton` spelling (`127.1`, `0x7f000001`, `017700000001`).
    NonCanonicalIpv4,
    /// NXDOMAIN or no address.
    Unresolved,
    /// The resolver did not answer within [`LOOKUP_TIMEOUT`].
    DnsTimeout,
    /// The target is public and there is no confirmation.
    ConfirmNeeded,
    /// A newer check superseded this one.
    Busy,
}

impl TransportError {
    /// The stable code the shell translates (spec §8).
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotConnectable => "target-not-connectable",
            Self::NonCanonicalIpv4 => "host-ipv4-noncanonical",
            Self::Unresolved => "target-unresolved",
            Self::DnsTimeout => "target-dns-timeout",
            Self::ConfirmNeeded => "transport-confirm-needed",
            Self::Busy => "transport-check-busy",
        }
    }
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for TransportError {}

/// At most this many addresses go into the report (the banner shows them; spec §9.5).
const REPORT_ADDRESSES: usize = 8;

/// Checks one target (spec §4.3, §6): resolve once (never for `localhost` or an IP literal), classify every address,
/// drop the not-connectable ones, aggregate the category and collect the hints. The returned [`ConnectPin`] holds
/// exactly the classified connectable addresses, de-duplicated, in resolver order, at most [`MAX_ADDRESSES`].
///
/// The Tailscale status and the reachability probe (spec §5) are wired in by package T3 through
/// `deps.tailscale`/`deps.prober` and `probe`; this version calls neither.
pub async fn check_target(
    input: &TargetInput,
    deps: &CheckDeps,
    probe: bool,
) -> Result<CheckedTarget, TransportError> {
    let _ = probe; // T3: the probe runs on tailnet paths only.
    let port = input.port;
    let resolved: Vec<SocketAddr> = match &input.host {
        HostInput::Localhost => [
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ]
        .into_iter()
        .map(|ip| SocketAddr::new(ip, port))
        .collect(),
        HostInput::Ip(ip) => vec![SocketAddr::new(*ip, port)],
        HostInput::Name(name) => match deps.resolver.lookup(name, port).await {
            Ok(addrs) => addrs,
            Err(ResolveError::NotFound) => return Err(TransportError::Unresolved),
            Err(ResolveError::Timeout) => return Err(TransportError::DnsTimeout),
        },
    };
    let resolved = resolve::normalise(resolved, port);
    if resolved.is_empty() {
        return Err(TransportError::Unresolved);
    }

    let mut connect: Vec<(SocketAddr, Category)> = Vec::with_capacity(resolved.len());
    let mut dropped: Vec<IpAddr> = Vec::new();
    for sa in &resolved {
        match target_class(sa.ip()) {
            AddrClass::Connectable(c) => connect.push((*sa, c)),
            AddrClass::NotConnectable => dropped.push(sa.ip()),
        }
    }
    let category =
        aggregate(connect.iter().map(|(_, c)| *c)).ok_or(TransportError::NotConnectable)?;
    let host = input.host.to_string();
    let mut hints = Vec::new();

    if !dropped.is_empty() {
        let mut params = BTreeMap::new();
        params.insert("address", show(dropped[0]));
        params.insert("addresses", list(dropped.iter().copied()));
        hints.push(Hint::new(
            "target-not-connectable",
            Severity::Notice,
            params,
        ));
    }
    if category == Category::Public {
        let public = connect.iter().filter(|(_, c)| *c == Category::Public);
        let mixed = connect.iter().any(|(_, c)| *c != Category::Public);
        let mut params = BTreeMap::new();
        params.insert("host", host.clone());
        params.insert("addresses", list(public.map(|(sa, _)| sa.ip())));
        let code = if mixed {
            "target-mixed"
        } else {
            "target-public"
        };
        hints.push(Hint::new(code, Severity::Warning, params));
    }
    if let Some((sa, _)) = connect.iter().find(|(_, c)| *c == Category::Special) {
        let mut params = BTreeMap::new();
        params.insert("address", show(sa.ip()));
        hints.push(Hint::new("target-special", Severity::Notice, params));
    }
    // Spec §5.3: „Über Tailscale“ chosen, but the target is neither a `*.ts.net` name nor any tailnet address.
    if input.transport == Transport::Tailscale
        && !input.host.is_ts_net()
        && !resolved.iter().any(|sa| is_tailnet(sa.ip()))
    {
        let mut params = BTreeMap::new();
        params.insert("host", host.clone());
        hints.push(Hint::new(
            "tailscale-not-tailnet-target",
            Severity::Notice,
            params,
        ));
    }

    let report = TransportReport {
        category: Some(category),
        addresses: connect
            .iter()
            .take(REPORT_ADDRESSES)
            .map(|(sa, _)| show(sa.ip()))
            .collect(),
        hints,
        tailscale: None,
        needs_public_ack: category == Category::Public,
        classifier: CLASSIFIER_ID,
    };
    Ok(CheckedTarget {
        pin: ConnectPin {
            host,
            addrs: connect.into_iter().map(|(sa, _)| sa).collect(),
        },
        report,
    })
}

/// Lets a connect go ahead unless the fresh report is public and there is no confirmation (spec §7.1, §8). A stored
/// confirmation exists only for a target that was public when it was given (package T4 stores it that way), so a
/// target that turned public later meets no confirmation here and needs a new one.
pub fn gate(report: &TransportReport, ack: Option<&PublicAck>) -> Result<(), TransportError> {
    if report.needs_public_ack && ack.is_none() {
        return Err(TransportError::ConfirmNeeded);
    }
    Ok(())
}

/// An address as the UI shows it: an IPv4-mapped address as its IPv4 host.
fn show(ip: IpAddr) -> String {
    canonical(ip).to_string()
}

/// Up to [`REPORT_ADDRESSES`] addresses for a hint parameter.
fn list(ips: impl Iterator<Item = IpAddr>) -> String {
    ips.take(REPORT_ADDRESSES)
        .map(show)
        .collect::<Vec<_>>()
        .join(", ")
}
