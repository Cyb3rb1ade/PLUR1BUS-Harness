//! The Tailscale status of spec §5 as an injected seam. Package T3 adds the CLI implementation (fixed binary paths,
//! `status --json`), the parser and the peer match.

use futures_util::future::BoxFuture;
use plur1bus_desktop_net::Cidr;
use serde::Serialize;
use std::net::IpAddr;

/// Where the check gets the local Tailscale status from.
pub trait TailscaleSource: Send + Sync {
    fn status(&self) -> BoxFuture<'_, TailscaleStatus>;
}

/// The local Tailscale state (spec §5.3). In memory only: never serialized, logged or persisted (spec §9.4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TailscaleStatus {
    NotInstalled,
    Unavailable(UnavailableWhy),
    DaemonDown,
    NeedsLogin,
    Stopped,
    Running(TailnetView),
}

/// Why the status could not be read (`tailscale-check-unavailable`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnavailableWhy {
    Spawn,
    Timeout,
    TooLarge,
    Unparseable,
    Flatpak,
}

/// The minimal view of `tailscale status --json` (spec §5.2 step 3). Deliberately not `Serialize`: it lists every
/// device of the tailnet.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TailnetView {
    pub self_ips: Vec<IpAddr>,
    pub magic_suffix: Option<String>,
    pub peers: Vec<PeerView>,
}

/// One peer of the minimal view.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerView {
    pub dns_name: String,
    pub host_name: String,
    pub ips: Vec<IpAddr>,
    pub online: bool,
    pub expired: bool,
    pub routes: Vec<Cidr>,
}

/// What the shell may learn about Tailscale for one check (spec §9.4): the state code (`tailscale-*`, spec §5.3), the
/// matched peer's label (first `DNSName` label) and its online flag. Nothing else of the status leaves Rust.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleView {
    pub state: &'static str,
    pub peer: Option<String>,
    pub online: Option<bool>,
}
