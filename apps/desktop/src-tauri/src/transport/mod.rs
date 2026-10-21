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
pub use probe::{ProbeOutcome, Prober, TcpProber, PROBE_ADDRESSES, PROBE_TIMEOUT};
pub use report::{Hint, Severity, TransportReport};
pub use resolve::{OsResolver, ResolveError, Resolver, LOOKUP_TIMEOUT, MAX_ADDRESSES};
pub use store::{StoreMode, TransportEntry, TransportStore, TransportStoreError};
pub use tailscale::{
    candidates, cgnat_candidate, exec_status, match_target, parse_status, usable, usable_with,
    CliTailscale, ExecOutcome, PeerMatch, PeerView, TailnetView, TailscaleSource, TailscaleStatus,
    TailscaleView, UnavailableWhy, EXEC_TIMEOUT, MAX_STATUS_BYTES, MAX_STDERR_BYTES, STATUS_TTL,
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
    /// No connectable address remains (unspecified, multicast, broadcast).
    NotConnectable,
    /// An IPv4 address in a legacy `inet_aton` spelling (`127.1`, `0x7f000001`, `017700000001`).
    NonCanonicalIpv4,
    /// A host string that is not a valid host at all (spec §4.4; see [`HostInput::parse`]).
    HostInvalid,
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
            Self::HostInvalid => "host-invalid",
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

/// Checks one target (spec §4.3, §5, §6): resolve once (never for `localhost` or an IP literal), classify every
/// address, drop the not-connectable ones, aggregate the category and collect the hints. The returned [`ConnectPin`]
/// holds exactly the classified connectable addresses, de-duplicated, in resolver order, at most [`MAX_ADDRESSES`].
///
/// The Tailscale check (spec §5.1) runs when the path is [`Transport::Tailscale`], the host is a `*.ts.net` name or any
/// connectable address is a tailnet address. For the first two the status is read before any lookup: a `*.ts.net` or
/// short name that matches a peer connects to that peer's `TailscaleIPs` (classified like resolver answers) and is
/// never sent to the resolver; without a match the name is resolved as usual. With `probe`, a matched online peer or
/// subnet route is probed through `deps.prober` and the socket's local address compared with this device's Tailscale
/// addresses (spec §5.2 step 5). Without `probe` no reachability is claimed. All I/O goes through `deps`.
pub async fn check_target(
    input: &TargetInput,
    deps: &CheckDeps,
    probe: bool,
) -> Result<CheckedTarget, TransportError> {
    let port = input.port;
    let mut status = if input.transport == Transport::Tailscale || input.host.is_ts_net() {
        Some(deps.tailscale.status().await)
    } else {
        None
    };
    let named = match &status {
        Some(TailscaleStatus::Running(view)) => tailscale::match_name(view, &input.host)
            .filter(|peer| !peer.ips.is_empty())
            .map(|peer| tailscale::peer_match(peer, &input.host)),
        _ => None,
    };
    let resolved: Vec<SocketAddr> = match (&input.host, &named) {
        (_, Some(PeerMatch::Peer { ips, .. })) => {
            ips.iter().map(|ip| SocketAddr::new(*ip, port)).collect()
        }
        (HostInput::Localhost, _) => [
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ]
        .into_iter()
        .map(|ip| SocketAddr::new(ip, port))
        .collect(),
        (HostInput::Ip(ip), _) => vec![SocketAddr::new(*ip, port)],
        (HostInput::Name(name), _) => match deps.resolver.lookup(name, port).await {
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
    let addrs: Vec<SocketAddr> = connect.iter().map(|(sa, _)| *sa).collect();
    let tailnet_target = input.host.is_ts_net() || resolved.iter().any(|sa| is_tailnet(sa.ip()));
    if status.is_none() && tailnet_target {
        status = Some(deps.tailscale.status().await);
    }
    let outcome = match &status {
        Some(status) => Some(
            tailscale_check(
                input,
                status,
                named,
                &addrs,
                tailnet_target,
                deps.prober.as_ref(),
                probe,
            )
            .await,
        ),
        None => None,
    };
    let via_route = outcome.as_ref().is_some_and(|o| o.via_route);
    let mut short_name = None;
    let tailscale = outcome.map(|o| {
        hints.extend(o.hints);
        short_name = o.short_name;
        o.view
    });
    // Spec §5.3: „Über Tailscale“ chosen, but the target is neither a `*.ts.net` name nor any tailnet address — unless
    // it is reached through a peer's subnet route, which is a Tailscale path.
    if input.transport == Transport::Tailscale && !tailnet_target && !via_route {
        let mut params = BTreeMap::new();
        params.insert("host", host.clone());
        hints.push(Hint::new(
            "tailscale-not-tailnet-target",
            Severity::Notice,
            params,
        ));
    }
    hints.extend(short_name);

    let report = TransportReport {
        category: Some(category),
        addresses: addrs
            .iter()
            .take(REPORT_ADDRESSES)
            .map(|sa| show(sa.ip()))
            .collect(),
        hints,
        tailscale,
        needs_public_ack: category == Category::Public,
        classifier: CLASSIFIER_ID,
    };
    Ok(CheckedTarget {
        pin: ConnectPin { host, addrs },
        report,
    })
}

/// The Tailscale part of one check (spec §5.2 steps 4-5, §5.3): the state for the shell and its hints.
struct TailscaleOutcome {
    view: TailscaleView,
    hints: Vec<Hint>,
    /// `tailscale-short-name`, placed after every other hint.
    short_name: Option<Hint>,
    /// The target is reached through a peer's subnet route.
    via_route: bool,
}

/// What the probe found about the path (spec §5.2 step 5).
enum Probed {
    /// Connected from one of this device's Tailscale addresses.
    Tailnet,
    /// Connected, but from another local address: `tailscale-route-mismatch`.
    Mismatch,
    /// Refused or timed out: `tailscale-unreachable`.
    Unreachable,
}

/// Picks the Tailscale state of a check (spec §5.3). Not running → that state's notice. Running → the match: a name
/// match found before the lookup (`named`), else the connect set's addresses. An offline or expired peer is
/// `tailscale-peer-offline` and is not probed; an online peer or subnet route is probed when `probe` is set (ok or
/// subnet route, `tailscale-route-mismatch`, `tailscale-unreachable`); unprobed, an online peer is the state
/// `tailscale-peer-online` with no hint (nothing verified the path) and a subnet route a `tailscale-subnet-route`
/// notice. No match is `tailscale-peer-unknown` for a tailnet target (naming CGNAT for `100.64.0.0/10`) and the state
/// `tailscale-not-tailnet-target` otherwise (its hint is added by the caller).
async fn tailscale_check(
    input: &TargetInput,
    status: &TailscaleStatus,
    named: Option<PeerMatch>,
    addrs: &[SocketAddr],
    tailnet_target: bool,
    prober: &dyn Prober,
    probe: bool,
) -> TailscaleOutcome {
    let host = input.host.to_string();
    let view = match status {
        TailscaleStatus::Running(view) => view,
        TailscaleStatus::NotInstalled => return notice("tailscale-not-installed", None),
        TailscaleStatus::Unavailable(why) => {
            let note = (*why == UnavailableWhy::Flatpak).then_some("flatpak");
            return notice("tailscale-check-unavailable", note);
        }
        TailscaleStatus::DaemonDown => return notice("tailscale-daemon-down", None),
        TailscaleStatus::NeedsLogin => return notice("tailscale-needs-login", None),
        TailscaleStatus::Stopped => return notice("tailscale-stopped", None),
    };
    let ips: Vec<IpAddr> = addrs.iter().map(|sa| sa.ip()).collect();
    let matched = named.unwrap_or_else(|| tailscale::match_addrs(view, &input.host, &ips));
    let state = |state, peer: Option<&String>, online| TailscaleView {
        state,
        peer: peer.cloned(),
        online,
    };
    let mut out = TailscaleOutcome {
        view: state("tailscale-not-tailnet-target", None, None),
        hints: Vec::new(),
        short_name: None,
        via_route: false,
    };
    match &matched {
        PeerMatch::Peer {
            label,
            online: false,
            ..
        } => {
            out.view = state("tailscale-peer-offline", Some(label), Some(false));
            out.hints.push(hint(
                "tailscale-peer-offline",
                Severity::Notice,
                [("peer", label.clone())],
            ));
        }
        PeerMatch::Peer {
            label,
            online: true,
            ..
        } => {
            let code = if probe {
                match probe_path(prober, addrs, &view.self_ips).await {
                    Probed::Tailnet => {
                        out.hints.push(hint(
                            "tailscale-ok",
                            Severity::Info,
                            [("peer", label.clone())],
                        ));
                        "tailscale-ok"
                    }
                    Probed::Mismatch => {
                        out.hints.push(hint(
                            "tailscale-route-mismatch",
                            Severity::Notice,
                            [("host", host.clone())],
                        ));
                        "tailscale-route-mismatch"
                    }
                    Probed::Unreachable => {
                        out.hints.push(unreachable(label, input.port));
                        "tailscale-unreachable"
                    }
                }
            } else {
                "tailscale-peer-online"
            };
            out.view = state(code, Some(label), Some(true));
        }
        PeerMatch::SelfNode => {
            out.view = state("tailscale-self", None, None);
            out.hints.push(hint("tailscale-self", Severity::Info, []));
        }
        PeerMatch::SubnetRoute { label, online } => {
            out.via_route = true;
            let code = if probe {
                match probe_path(prober, addrs, &view.self_ips).await {
                    Probed::Tailnet => {
                        out.hints.push(hint(
                            "tailscale-subnet-route",
                            Severity::Info,
                            [("peer", label.clone())],
                        ));
                        "tailscale-subnet-route"
                    }
                    Probed::Mismatch => {
                        out.hints.push(hint(
                            "tailscale-route-mismatch",
                            Severity::Notice,
                            [("host", host.clone())],
                        ));
                        "tailscale-route-mismatch"
                    }
                    Probed::Unreachable => {
                        out.hints.push(unreachable(label, input.port));
                        "tailscale-unreachable"
                    }
                }
            } else {
                out.hints.push(hint(
                    "tailscale-subnet-route",
                    Severity::Notice,
                    [("peer", label.clone())],
                ));
                "tailscale-subnet-route"
            };
            out.view = state(code, Some(label), Some(*online));
        }
        PeerMatch::None if tailnet_target => {
            out.view = state("tailscale-peer-unknown", None, None);
            let mut h = hint(
                "tailscale-peer-unknown",
                Severity::Notice,
                [("host", host.clone())],
            );
            if tailscale::cgnat_candidate(&ips) {
                h.params.insert("note", "cgnat".to_owned());
            }
            out.hints.push(h);
        }
        PeerMatch::None => {}
    }
    // Spec §7.2 `transport.tailscale.short-name`: HTTPS needs the full MagicDNS name of a short name.
    if let (PeerMatch::Peer { .. }, HostInput::Name(name), Purpose::Remote, Some(suffix)) = (
        &matched,
        &input.host,
        input.purpose,
        view.magic_suffix.as_deref(),
    ) {
        let bare = name.strip_suffix('.').unwrap_or(name);
        if !bare.contains('.') {
            out.short_name = Some(hint(
                "tailscale-short-name",
                Severity::Info,
                [("suggestion", format!("{bare}.{suffix}"))],
            ));
        }
    }
    out
}

/// A state that is only its notice (spec §5.3), with the optional text variant in `note`.
fn notice(code: &'static str, note: Option<&'static str>) -> TailscaleOutcome {
    let mut h = hint(code, Severity::Notice, []);
    if let Some(note) = note {
        h.params.insert("note", note.to_owned());
    }
    TailscaleOutcome {
        view: TailscaleView {
            state: code,
            peer: None,
            online: None,
        },
        hints: vec![h],
        short_name: None,
        via_route: false,
    }
}

fn hint<const N: usize>(
    code: &'static str,
    severity: Severity,
    params: [(&'static str, String); N],
) -> Hint {
    Hint::new(code, severity, params.into_iter().collect())
}

fn unreachable(peer: &str, port: u16) -> Hint {
    hint(
        "tailscale-unreachable",
        Severity::Notice,
        [("peer", peer.to_owned()), ("port", port.to_string())],
    )
}

/// Probes at most [`PROBE_ADDRESSES`] of the connect set and compares the local address with `self_ips`.
async fn probe_path(prober: &dyn Prober, addrs: &[SocketAddr], self_ips: &[IpAddr]) -> Probed {
    let addrs = &addrs[..addrs.len().min(PROBE_ADDRESSES)];
    match prober.probe(addrs).await {
        ProbeOutcome::Connected { local, .. } => {
            let local = canonical(local.ip());
            if self_ips.iter().any(|ip| canonical(*ip) == local) {
                Probed::Tailnet
            } else {
                Probed::Mismatch
            }
        }
        ProbeOutcome::Refused | ProbeOutcome::Timeout => Probed::Unreachable,
    }
}

/// Lets a connect go ahead unless the fresh report is public and there is no valid confirmation (spec §2 T10, §7.1,
/// §8). A confirmation is valid only under the classifier snapshot of the report: after a snapshot update the person
/// confirms again (fails closed). The resolved addresses play no part. The confirmation may come from the store or,
/// while the store cannot persist it, from memory for the app session (spec §3.2; package T4).
///
/// A stored confirmation exists only for a target that was public when it was given (package T4 stores it that way
/// and clears it on a host or transport change), so a target that turned public later meets no confirmation here.
pub fn gate(report: &TransportReport, ack: Option<&PublicAck>) -> Result<(), TransportError> {
    let valid = ack.is_some_and(|a| a.classifier == report.classifier);
    if report.needs_public_ack && !valid {
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
