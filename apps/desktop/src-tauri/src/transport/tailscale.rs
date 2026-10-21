//! The Tailscale status of spec §5 as an injected seam. Package T3 adds the CLI implementation (fixed binary paths,
//! `status --json`), the parser and the peer match.

use futures_util::future::BoxFuture;
use plur1bus_desktop_net::Cidr;
use serde::Serialize;
use std::fmt;
use std::net::IpAddr;

/// Where the check gets the local Tailscale status from.
pub trait TailscaleSource: Send + Sync {
    fn status(&self) -> BoxFuture<'_, TailscaleStatus>;
}

/// The local Tailscale state (spec §5.3). In memory only: never serialized, logged or persisted (spec §9.4); its
/// `Debug` prints the state and counts only.
#[derive(Clone, PartialEq, Eq)]
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

/// The minimal view of `tailscale status --json` (spec §5.2 step 3). Deliberately not `Serialize`, and its `Debug`
/// prints counts only: it lists every device of the tailnet.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct TailnetView {
    pub self_ips: Vec<IpAddr>,
    pub magic_suffix: Option<String>,
    pub peers: Vec<PeerView>,
}

/// One peer of the minimal view. Its `Debug` prints counts and flags only, never names or addresses.
#[derive(Clone, PartialEq, Eq)]
pub struct PeerView {
    pub dns_name: String,
    pub host_name: String,
    pub ips: Vec<IpAddr>,
    pub online: bool,
    pub expired: bool,
    pub routes: Vec<Cidr>,
}

impl fmt::Debug for TailscaleStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotInstalled => f.write_str("NotInstalled"),
            Self::Unavailable(why) => f.debug_tuple("Unavailable").field(why).finish(),
            Self::DaemonDown => f.write_str("DaemonDown"),
            Self::NeedsLogin => f.write_str("NeedsLogin"),
            Self::Stopped => f.write_str("Stopped"),
            Self::Running(view) => f.debug_tuple("Running").field(view).finish(),
        }
    }
}

impl fmt::Debug for TailnetView {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TailnetView")
            .field("self_ips", &self.self_ips.len())
            .field("magic_suffix", &self.magic_suffix.is_some())
            .field("peers", &self.peers.len())
            .finish()
    }
}

impl fmt::Debug for PeerView {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PeerView")
            .field("ips", &self.ips.len())
            .field("routes", &self.routes.len())
            .field("online", &self.online)
            .field("expired", &self.expired)
            .finish_non_exhaustive()
    }
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
