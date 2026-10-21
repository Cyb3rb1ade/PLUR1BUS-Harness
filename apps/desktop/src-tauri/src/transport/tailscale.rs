//! The local Tailscale status of spec §5: the injected seam, the CLI implementation ([`CliTailscale`]: fixed absolute
//! binary paths, exactly `status --json`, a cleared environment, caps and a timeout), the parser into the minimal view
//! and the peer match.
//!
//! Privacy (spec §9.4): the status lists every device, user and address of the tailnet. It is parsed into
//! [`TailnetView`] in memory, cached at most [`STATUS_TTL`], never logged, persisted or serialized; every type that
//! holds any of it has a hand-written `Debug` that prints states and counts only.

use super::HostInput;
use futures_util::future::BoxFuture;
use plur1bus_desktop_net::{canonical, in_cidr, parse_address, parse_cidr, Cidr};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::time::Instant;

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
    /// This device's own `DNSName` (`Self.DNSName`), empty when absent; only ever compared, never reported.
    pub self_dns_name: String,
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

// ---- parsing (spec §5.2 step 3) ---------------------------------------------------------------------------------

/// The largest `status --json` document read (spec §5.2 step 2); a larger one is `Unavailable(TooLarge)`.
pub const MAX_STATUS_BYTES: usize = 8 * 1024 * 1024;
/// At most this much of stderr is kept; it never decides anything beyond what the exit status already says.
pub const MAX_STDERR_BYTES: usize = 4 * 1024;
/// How long the CLI may run (spec §5.2 step 2).
pub const EXEC_TIMEOUT: Duration = Duration::from_secs(4);
/// How long a status is reused (spec §5.4).
pub const STATUS_TTL: Duration = Duration::from_secs(10);

/// The fields of `tailscale status --json` the check reads; serde ignores everything else (spec §5.2 step 3, the same
/// fields as `packages/remote-access/src/tailscale.ts`).
#[derive(Deserialize)]
struct RawStatus {
    #[serde(rename = "BackendState")]
    backend_state: Option<String>,
    #[serde(rename = "Self")]
    self_node: Option<RawNode>,
    #[serde(rename = "MagicDNSSuffix")]
    magic_dns_suffix: Option<String>,
    #[serde(rename = "CurrentTailnet")]
    current_tailnet: Option<RawTailnet>,
    /// Keyed by node key; the keys are never kept. A sorted map keeps matching deterministic.
    #[serde(rename = "Peer")]
    peer: Option<BTreeMap<String, RawNode>>,
}

#[derive(Deserialize)]
struct RawTailnet {
    #[serde(rename = "MagicDNSSuffix")]
    magic_dns_suffix: Option<String>,
}

#[derive(Deserialize)]
struct RawNode {
    #[serde(rename = "DNSName")]
    dns_name: Option<String>,
    #[serde(rename = "HostName")]
    host_name: Option<String>,
    #[serde(rename = "TailscaleIPs")]
    tailscale_ips: Option<Vec<String>>,
    #[serde(rename = "Online")]
    online: Option<bool>,
    #[serde(rename = "Expired")]
    expired: Option<bool>,
    #[serde(rename = "PrimaryRoutes")]
    primary_routes: Option<Vec<String>>,
}

/// Turns one run of `status --json` into a state (spec §5.3): over [`MAX_STATUS_BYTES`] → `Unavailable(TooLarge)`; a
/// non-zero exit → `DaemonDown` (the CLI cannot reach `tailscaled`), whatever it printed; not JSON, or JSON without a
/// string `BackendState` → `Unavailable(Unparseable)`; `NeedsLogin`/`NeedsMachineAuth` → `NeedsLogin`; `Running` →
/// `Running` with the minimal view; any other backend state → `Stopped`. Addresses and routes that do not parse
/// (strictly, as host input would) are dropped.
pub fn parse_status(success: bool, stdout: &[u8]) -> TailscaleStatus {
    if stdout.len() > MAX_STATUS_BYTES {
        return TailscaleStatus::Unavailable(UnavailableWhy::TooLarge);
    }
    if !success {
        return TailscaleStatus::DaemonDown;
    }
    let Ok(raw) = serde_json::from_slice::<RawStatus>(stdout) else {
        return TailscaleStatus::Unavailable(UnavailableWhy::Unparseable);
    };
    let Some(state) = raw.backend_state.as_deref() else {
        return TailscaleStatus::Unavailable(UnavailableWhy::Unparseable);
    };
    match state {
        "Running" => {}
        "NeedsLogin" | "NeedsMachineAuth" => return TailscaleStatus::NeedsLogin,
        _ => return TailscaleStatus::Stopped,
    }
    let magic_suffix = raw
        .current_tailnet
        .and_then(|t| t.magic_dns_suffix)
        .filter(|s| !s.is_empty())
        .or(raw.magic_dns_suffix)
        .map(|s| s.trim_end_matches('.').to_owned())
        .filter(|s| !s.is_empty());
    let peers = raw
        .peer
        .unwrap_or_default()
        .into_values()
        .map(|p| PeerView {
            dns_name: p.dns_name.unwrap_or_default(),
            host_name: p.host_name.unwrap_or_default(),
            ips: addresses(p.tailscale_ips),
            online: p.online.unwrap_or(false),
            expired: p.expired.unwrap_or(false),
            routes: p
                .primary_routes
                .unwrap_or_default()
                .iter()
                .filter_map(|r| parse_cidr(r))
                .collect(),
        })
        .collect();
    let (self_ips, self_dns_name) = raw
        .self_node
        .map(|s| (addresses(s.tailscale_ips), s.dns_name.unwrap_or_default()))
        .unwrap_or_default();
    TailscaleStatus::Running(TailnetView {
        self_ips,
        self_dns_name,
        magic_suffix,
        peers,
    })
}

fn addresses(raw: Option<Vec<String>>) -> Vec<IpAddr> {
    raw.unwrap_or_default()
        .iter()
        .filter_map(|s| parse_address(s, true))
        .collect()
}

// ---- matching (spec §5.2 step 4) --------------------------------------------------------------------------------

/// What the target is in the tailnet. Labels are the first `DNSName` label (spec §9.4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PeerMatch {
    /// A peer, by name or by one of its `TailscaleIPs`; `online` is `Online && !Expired`.
    Peer {
        label: String,
        ips: Vec<IpAddr>,
        online: bool,
    },
    /// This device: its own MagicDNS name or one of its own Tailscale addresses.
    SelfNode,
    /// An address inside the `PrimaryRoutes` of a peer that is online and not expired.
    SubnetRoute {
        label: String,
        online: bool,
    },
    None,
}

/// Matches a target (spec §5.2 step 4). A name first: a `*.ts.net` name matches the peer, or this device, whose
/// `DNSName` (without trailing dot, any case) equals it; a single-label name matches only the one whose `DNSName` is
/// exactly `<name>.<MagicDNS suffix>`, and nothing when there is no suffix (MagicDNS off). Otherwise, or without a name
/// match, the addresses (`addrs`, compared as IPv4 hosts when IPv4-mapped): the peer whose `TailscaleIPs` contains one,
/// else [`PeerMatch::SelfNode`], else a peer that is online and not expired whose `PrimaryRoutes` contains one.
pub fn match_target(view: &TailnetView, host: &HostInput, addrs: &[IpAddr]) -> PeerMatch {
    if let Some(named) = match_name(view, host) {
        return named.matched;
    }
    match_addrs(view, host, addrs)
}

/// A name match: the peer or this device, the addresses to connect to (its `TailscaleIPs`), and for a peer its own
/// validated MagicDNS name (the `tailscale-short-name` suggestion, spec §7.2/§9.4).
pub(super) struct NameMatch {
    pub(super) matched: PeerMatch,
    pub(super) ips: Vec<IpAddr>,
    pub(super) dns_name: Option<String>,
}

/// The name part of [`match_target`].
pub(super) fn match_name(view: &TailnetView, host: &HostInput) -> Option<NameMatch> {
    let HostInput::Name(name) = host else {
        return None;
    };
    let bare = bare_name(name);
    let wanted = if host.is_ts_net() {
        bare.to_owned()
    } else if !bare.contains('.') {
        format!("{bare}.{}", view.magic_suffix.as_deref()?)
    } else {
        return None;
    };
    let is_wanted = |dns_name: &str| bare_name(dns_name).eq_ignore_ascii_case(&wanted);
    if let Some(peer) = view.peers.iter().find(|p| is_wanted(&p.dns_name)) {
        return Some(NameMatch {
            matched: peer_match(peer, host),
            ips: peer.ips.clone(),
            dns_name: valid_dns_name(&peer.dns_name),
        });
    }
    if is_wanted(&view.self_dns_name) {
        return Some(NameMatch {
            matched: PeerMatch::SelfNode,
            ips: view.self_ips.clone(),
            dns_name: None,
        });
    }
    None
}

/// The address part of [`match_target`].
pub(super) fn match_addrs(view: &TailnetView, host: &HostInput, addrs: &[IpAddr]) -> PeerMatch {
    let addrs: Vec<IpAddr> = addrs.iter().map(|a| canonical(*a)).collect();
    let contains = |ips: &[IpAddr]| ips.iter().any(|ip| addrs.contains(&canonical(*ip)));
    if let Some(peer) = view.peers.iter().find(|p| contains(&p.ips)) {
        return peer_match(peer, host);
    }
    if contains(&view.self_ips) {
        return PeerMatch::SelfNode;
    }
    if let Some(router) = view.peers.iter().find(|p| {
        p.online
            && !p.expired
            && p.routes
                .iter()
                .any(|r| addrs.iter().any(|a| in_cidr(*a, r)))
    }) {
        return PeerMatch::SubnetRoute {
            label: label(router, host),
            online: true,
        };
    }
    PeerMatch::None
}

/// The label and online flag of a matched peer.
fn peer_match(peer: &PeerView, host: &HostInput) -> PeerMatch {
    PeerMatch::Peer {
        label: label(peer, host),
        ips: peer.ips.clone(),
        online: peer.online && !peer.expired,
    }
}

/// Whether the addresses include carrier-grade NAT space (`100.64.0.0/10` as an IPv4 host), so a
/// `tailscale-peer-unknown` notice names CGNAT (spec §5.3).
pub fn cgnat_candidate(addrs: &[IpAddr]) -> bool {
    addrs.iter().any(
        |a| matches!(canonical(*a), IpAddr::V4(v4) if (u32::from(v4) >> 22) == (0x6440_0000 >> 22)),
    )
}

/// The label the shell may show for a peer (spec §9.4): its first `DNSName` label when that is a plain LDH label,
/// otherwise the host the person typed, so nothing unexpected from the CLI output reaches the webview.
fn label(peer: &PeerView, host: &HostInput) -> String {
    let first = first_label(&peer.dns_name);
    if is_ldh_label(first) {
        first.to_ascii_lowercase()
    } else {
        host.to_string()
    }
}

/// A peer's own `DNSName` as the shell may show it: lower case, without the trailing dot, at most 253 bytes of LDH
/// labels; `None` for anything else.
fn valid_dns_name(dns_name: &str) -> Option<String> {
    let bare = bare_name(dns_name);
    (bare.len() <= 253 && bare.split('.').all(is_ldh_label)).then(|| bare.to_ascii_lowercase())
}

fn is_ldh_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !label.starts_with('-')
        && !label.ends_with('-')
}

fn bare_name(name: &str) -> &str {
    name.strip_suffix('.').unwrap_or(name)
}

fn first_label(dns_name: &str) -> &str {
    bare_name(dns_name).split('.').next().unwrap_or_default()
}

// ---- the binary (spec §5.2 step 1) ------------------------------------------------------------------------------

/// The absolute places the Tailscale CLI may live (spec §5.2 step 1), per platform. `PATH` is never consulted.
pub fn candidates() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    let list: Vec<PathBuf> = [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    #[cfg(target_os = "linux")]
    let list: Vec<PathBuf> = [
        "/usr/bin/tailscale",
        "/usr/sbin/tailscale",
        "/usr/local/bin/tailscale",
        "/snap/bin/tailscale",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    #[cfg(windows)]
    let list: Vec<PathBuf> = program_files()
        .map(|root| vec![root.join("Tailscale").join("tailscale.exe")])
        .unwrap_or_default();
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    let list: Vec<PathBuf> = Vec::new();
    list
}

/// Where a symlinked candidate may point (spec §5.2 step 1).
#[cfg(unix)]
const LINK_PREFIXES: [&str; 3] = [
    "/Applications/Tailscale.app",
    "/opt/homebrew/Cellar/tailscale",
    "/usr/local/Cellar/tailscale",
];

/// The one symlink allowed outside [`LINK_PREFIXES`]: snap's `/snap/bin/tailscale` → `/usr/bin/snap`, exactly.
#[cfg(unix)]
const SNAP_LINK: (&str, &str) = ("/snap/bin/tailscale", "/usr/bin/snap");

/// The default allowed places of [`usable`].
fn default_allowed() -> Vec<PathBuf> {
    #[cfg(unix)]
    let allowed: Vec<PathBuf> = LINK_PREFIXES.iter().map(PathBuf::from).collect();
    #[cfg(windows)]
    let allowed: Vec<PathBuf> = program_files().into_iter().collect();
    #[cfg(not(any(unix, windows)))]
    let allowed: Vec<PathBuf> = Vec::new();
    allowed
}

/// Whether a candidate may be run (spec §5.2 step 1, §9.3). POSIX: a regular file, reached through a symlink only
/// when the real path lies under `/Applications/Tailscale.app/`, `/opt/homebrew/Cellar/tailscale/` or
/// `/usr/local/Cellar/tailscale/`, or is exactly `/usr/bin/snap` for `/snap/bin/tailscale`; owned by root or the
/// current user; not group- or other-writable. Windows: a regular file inside the Program Files known folder with no
/// reparse point (symlink, junction) on the way.
pub fn usable(path: &Path) -> bool {
    usable_with(path, &default_allowed())
}

/// [`usable`] with the allowed places given: on POSIX the prefixes a symlink may resolve into (any symlink on the way,
/// also a directory, counts; the snap pair is always allowed), on Windows the roots the file must lie in. The path
/// must be absolute.
pub fn usable_with(path: &Path, allowed: &[PathBuf]) -> bool {
    checked(path, allowed).is_some()
}

/// Whether a symlinked candidate `path` may resolve to `real` (spec §5.2 step 1).
#[cfg(unix)]
fn link_allowed(path: &Path, real: &Path, allowed: &[PathBuf]) -> bool {
    real == path
        || allowed.iter().any(|prefix| real.starts_with(prefix))
        || (path == Path::new(SNAP_LINK.0) && real == Path::new(SNAP_LINK.1))
}

/// The path to execute when `path` passes the checks of [`usable_with`]: the canonical path on POSIX (so the checked
/// file is the one run, not whatever a link points to by then), the path itself on Windows.
#[cfg(unix)]
fn checked(path: &Path, allowed: &[PathBuf]) -> Option<PathBuf> {
    use std::os::unix::fs::MetadataExt;
    if !path.is_absolute() {
        return None;
    }
    let real = std::fs::canonicalize(path).ok()?;
    if !link_allowed(path, &real, allowed) {
        return None;
    }
    let meta = std::fs::symlink_metadata(&real).ok()?;
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    let euid = unsafe { libc::geteuid() };
    let ok = meta.file_type().is_file()
        && (meta.uid() == 0 || meta.uid() == euid)
        && meta.mode() & 0o022 == 0;
    ok.then_some(real)
}

/// The path to execute when `path` passes the checks of [`usable_with`]: the canonical path on POSIX (so the checked
/// file is the one run, not whatever a link points to by then), the path itself on Windows.
#[cfg(windows)]
fn checked(path: &Path, allowed: &[PathBuf]) -> Option<PathBuf> {
    use std::os::windows::fs::MetadataExt;
    use std::path::Component;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return None;
    }
    let root = allowed.iter().find(|root| path.starts_with(root))?;
    // The file and every directory up to and including the root: none may be a reparse point.
    for dir in path.ancestors() {
        let meta = std::fs::symlink_metadata(dir).ok()?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return None;
        }
        if dir == root.as_path() {
            break;
        }
    }
    let is_file = std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file());
    is_file.then(|| path.to_path_buf())
}

/// Not POSIX or Windows: nothing is usable.
#[cfg(not(any(unix, windows)))]
fn checked(_path: &Path, _allowed: &[PathBuf]) -> Option<PathBuf> {
    None
}

/// `FOLDERID_ProgramFiles` through the known-folder API, not the `%ProgramFiles%` variable (spec §5.2 step 1).
#[cfg(windows)]
fn program_files() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_ProgramFiles, SHGetKnownFolderPath};
    let mut raw: windows_sys::core::PWSTR = std::ptr::null_mut();
    // SAFETY: the GUID is a static, the token is null (current user), and `raw` receives a CoTaskMemAlloc'd,
    // NUL-terminated string that is freed below on every path (the API documents freeing it even on failure).
    let hr =
        unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramFiles, 0, std::ptr::null_mut(), &mut raw) };
    let path = if hr >= 0 && !raw.is_null() {
        // SAFETY: `raw` is NUL-terminated; the scan stops at the terminator or after 32 768 units.
        let len = (0..32_768usize)
            .take_while(|&i| unsafe { *raw.add(i) } != 0)
            .count();
        // SAFETY: the `len` units before the terminator are initialised.
        let wide = unsafe { std::slice::from_raw_parts(raw, len) };
        Some(PathBuf::from(std::ffi::OsString::from_wide(wide)))
    } else {
        None
    };
    // SAFETY: freeing null is allowed; otherwise `raw` came from the shell allocator above.
    unsafe { CoTaskMemFree(raw as *const core::ffi::c_void) };
    path.filter(|p| p.is_absolute())
}

// ---- the run (spec §5.2 step 2) ---------------------------------------------------------------------------------

/// One run of `status --json`: the exit status and stdout, or why there is none. Its `Debug` prints the byte count,
/// never the output.
pub enum ExecOutcome {
    Exited { success: bool, stdout: Vec<u8> },
    Failed(UnavailableWhy),
}

impl fmt::Debug for ExecOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Exited { success, stdout } => f
                .debug_struct("Exited")
                .field("success", success)
                .field("stdout", &stdout.len())
                .finish(),
            Self::Failed(why) => f.debug_tuple("Failed").field(why).finish(),
        }
    }
}

/// The environment the CLI gets (spec §5.2 step 2): cleared, then these variables copied when set, plus `LANG=C` on
/// POSIX.
#[cfg(unix)]
const PASS_ENV: [&str; 4] = ["HOME", "USER", "LOGNAME", "TMPDIR"];
#[cfg(windows)]
const PASS_ENV: [&str; 5] = [
    "SystemRoot",
    "USERPROFILE",
    "LOCALAPPDATA",
    "ProgramData",
    "TEMP",
];
#[cfg(not(any(unix, windows)))]
const PASS_ENV: [&str; 0] = [];

fn child_env() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let mut env: Vec<(std::ffi::OsString, std::ffi::OsString)> = PASS_ENV
        .iter()
        .filter_map(|name| std::env::var_os(name).map(|v| ((*name).into(), v)))
        .collect();
    if cfg!(unix) {
        env.push(("LANG".into(), "C".into()));
    }
    env
}

/// Runs `<binary> status --json` with `binary` as its own `argv[0]` (see [`run_status`]). Debug builds only: the
/// exec tests and the `PLUR1BUS_DESKTOP_TAILSCALE_BIN` seam use it; release code runs only a [`usable`] candidate.
#[cfg(debug_assertions)]
pub async fn exec_status(binary: &Path) -> ExecOutcome {
    run_status(binary, binary).await
}

/// Runs `<program> status --json` (spec §5.2 step 2): exactly these two arguments, never one derived from input; no
/// shell; on POSIX `argv[0]` is `arg0` (the candidate path, so snap's dispatcher still sees `tailscale`); the
/// environment cleared and refilled from the allow-list; stdin null; stdout capped at [`MAX_STATUS_BYTES`] (more →
/// `TooLarge`), stderr read up to [`MAX_STDERR_BYTES`] and drained; [`EXEC_TIMEOUT`] (→ `Timeout`); the child killed
/// on every early return; on Windows no console window. A relative path is refused (`Spawn`), as is anything that
/// cannot be started or read.
async fn run_status(program: &Path, arg0: &Path) -> ExecOutcome {
    if !program.is_absolute() {
        return ExecOutcome::Failed(UnavailableWhy::Spawn);
    }
    let mut command = tokio::process::Command::new(program);
    #[cfg(unix)]
    command.arg0(arg0);
    #[cfg(not(unix))]
    let _ = arg0;
    command
        .args(["status", "--json"])
        .env_clear()
        .envs(child_env())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    let Ok(mut child) = command.spawn() else {
        return ExecOutcome::Failed(UnavailableWhy::Spawn);
    };
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill().await;
        return ExecOutcome::Failed(UnavailableWhy::Spawn);
    };
    let outcome = tokio::time::timeout(EXEC_TIMEOUT, async {
        let (out, ()) = tokio::try_join!(read_capped(stdout, MAX_STATUS_BYTES), drain(stderr))?;
        let status = child.wait().await.map_err(|_| UnavailableWhy::Spawn)?;
        Ok::<_, UnavailableWhy>((status.success(), out))
    })
    .await;
    match outcome {
        Ok(Ok((success, stdout))) => ExecOutcome::Exited { success, stdout },
        Ok(Err(why)) => {
            let _ = child.kill().await;
            ExecOutcome::Failed(why)
        }
        Err(_) => {
            let _ = child.kill().await;
            ExecOutcome::Failed(UnavailableWhy::Timeout)
        }
    }
}

/// Reads at most `cap` bytes; one more means the output is too large. A read error is `Spawn` (the process could not
/// deliver its output).
async fn read_capped(
    reader: impl AsyncRead + Unpin,
    cap: usize,
) -> Result<Vec<u8>, UnavailableWhy> {
    let mut bytes = Vec::new();
    let limit = u64::try_from(cap).unwrap_or(u64::MAX).saturating_add(1);
    reader
        .take(limit)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| UnavailableWhy::Spawn)?;
    if bytes.len() > cap {
        return Err(UnavailableWhy::TooLarge);
    }
    Ok(bytes)
}

/// Keeps at most [`MAX_STDERR_BYTES`] of stderr and discards the rest, so a chatty CLI cannot block on a full pipe.
/// The text is not used: the exit status alone picks the state (spec §5.3).
async fn drain(mut reader: impl AsyncRead + Unpin) -> Result<(), UnavailableWhy> {
    let mut head = Vec::with_capacity(MAX_STDERR_BYTES);
    let limit = u64::try_from(MAX_STDERR_BYTES).unwrap_or(u64::MAX);
    let _ = (&mut reader).take(limit).read_to_end(&mut head).await;
    let _ = tokio::io::copy(&mut reader, &mut tokio::io::sink()).await;
    drop(head);
    Ok(())
}

// ---- the source (spec §5.4) -------------------------------------------------------------------------------------

/// Where [`CliTailscale`] reads the status from: the fixed candidates, or (debug builds only, DR19) a fixture file or
/// a fake binary.
enum Source {
    Candidates,
    #[cfg(debug_assertions)]
    Fixture(PathBuf),
    #[cfg(debug_assertions)]
    Binary(PathBuf),
}

impl Source {
    /// `PLUR1BUS_DESKTOP_TAILSCALE_STATUS=<file>` (a status document instead of the CLI) and
    /// `PLUR1BUS_DESKTOP_TAILSCALE_BIN=<path>` (a fake CLI) are read in debug builds only; a release build never looks
    /// at them.
    fn from_env() -> Self {
        #[cfg(debug_assertions)]
        {
            if let Some(file) = std::env::var_os("PLUR1BUS_DESKTOP_TAILSCALE_STATUS") {
                return Self::Fixture(file.into());
            }
            if let Some(bin) = std::env::var_os("PLUR1BUS_DESKTOP_TAILSCALE_BIN") {
                return Self::Binary(bin.into());
            }
        }
        Self::Candidates
    }
}

/// The real [`TailscaleSource`]: the first [`usable`] candidate, run (as its checked path) and read with
/// [`parse_status`]. Inside a Flatpak sandbox (`FLATPAK_ID` set when the source is created) nothing is run
/// (`Unavailable(Flatpak)`). No candidate on disk is `NotInstalled`; candidates that exist but none usable is
/// `Unavailable(Spawn)`. The answer is cached for [`STATUS_TTL`], and a caller arriving during a run waits for that run
/// instead of starting another (spec §5.4).
pub struct CliTailscale {
    source: Source,
    flatpak: bool,
    cache: tokio::sync::Mutex<Option<(Instant, Arc<TailscaleStatus>)>>,
}

impl Default for CliTailscale {
    fn default() -> Self {
        Self::new()
    }
}

impl CliTailscale {
    pub fn new() -> Self {
        Self {
            source: Source::from_env(),
            flatpak: std::env::var_os("FLATPAK_ID").is_some_and(|v| !v.is_empty()),
            cache: tokio::sync::Mutex::new(None),
        }
    }

    /// Whether a debug seam replaced the CLI. Always `false` in a release build.
    pub fn uses_debug_seam(&self) -> bool {
        !matches!(self.source, Source::Candidates)
    }

    async fn read(&self) -> TailscaleStatus {
        if self.flatpak {
            return TailscaleStatus::Unavailable(UnavailableWhy::Flatpak);
        }
        let outcome = match &self.source {
            Source::Candidates => match pick() {
                Ok((program, candidate)) => run_status(&program, &candidate).await,
                Err(status) => return status,
            },
            #[cfg(debug_assertions)]
            Source::Fixture(file) => return read_fixture(file),
            #[cfg(debug_assertions)]
            Source::Binary(binary) => exec_status(binary).await,
        };
        match outcome {
            ExecOutcome::Exited { success, stdout } => parse_status(success, &stdout),
            ExecOutcome::Failed(why) => TailscaleStatus::Unavailable(why),
        }
    }
}

impl TailscaleSource for CliTailscale {
    fn status(&self) -> BoxFuture<'_, TailscaleStatus> {
        Box::pin(async move {
            let mut cache = self.cache.lock().await;
            if let Some((at, status)) = cache.as_ref() {
                if at.elapsed() < STATUS_TTL {
                    return TailscaleStatus::clone(status);
                }
            }
            let status = Arc::new(self.read().await);
            *cache = Some((Instant::now(), Arc::clone(&status)));
            TailscaleStatus::clone(&status)
        })
    }
}

/// The first usable candidate as (checked path to execute, candidate path for `argv[0]`); `NotInstalled` when none
/// exists, `Unavailable(Spawn)` when some exist but none passes [`usable`].
fn pick() -> Result<(PathBuf, PathBuf), TailscaleStatus> {
    let allowed = default_allowed();
    let mut present = false;
    for candidate in candidates() {
        if std::fs::symlink_metadata(&candidate).is_ok() {
            present = true;
            if let Some(program) = checked(&candidate, &allowed) {
                return Ok((program, candidate));
            }
        }
    }
    Err(if present {
        TailscaleStatus::Unavailable(UnavailableWhy::Spawn)
    } else {
        TailscaleStatus::NotInstalled
    })
}

/// The debug fixture seam: the file as a successful run's stdout, with the same size cap.
#[cfg(debug_assertions)]
fn read_fixture(file: &Path) -> TailscaleStatus {
    use std::io::Read;
    let mut bytes = Vec::new();
    let limit = u64::try_from(MAX_STATUS_BYTES)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    match std::fs::File::open(file).and_then(|f| f.take(limit).read_to_end(&mut bytes)) {
        Ok(_) => parse_status(true, &bytes),
        Err(_) => TailscaleStatus::Unavailable(UnavailableWhy::Spawn),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn snap_link_is_one_exact_pair() {
        let none: [PathBuf; 0] = [];
        let p = Path::new;
        assert!(link_allowed(
            p("/snap/bin/tailscale"),
            p("/usr/bin/snap"),
            &none
        ));
        // Not another snap command, not another target, not another candidate, and no `/snap/` prefix.
        assert!(!link_allowed(
            p("/snap/bin/other"),
            p("/usr/bin/snap"),
            &none
        ));
        assert!(!link_allowed(
            p("/snap/bin/tailscale"),
            p("/usr/bin/snapd"),
            &none
        ));
        assert!(!link_allowed(
            p("/snap/bin/tailscale"),
            p("/usr/bin/snap/x"),
            &none
        ));
        assert!(!link_allowed(
            p("/usr/local/bin/tailscale"),
            p("/usr/bin/snap"),
            &none
        ));
        assert!(!link_allowed(
            p("/snap/bin/tailscale"),
            p("/snap/tailscale/current/bin/tailscale"),
            &none
        ));
        // A path that is its own real path needs no allowance; others need a whole-component prefix.
        assert!(link_allowed(
            p("/usr/bin/tailscale"),
            p("/usr/bin/tailscale"),
            &none
        ));
        let cellar = [PathBuf::from("/opt/homebrew/Cellar/tailscale")];
        assert!(link_allowed(
            p("/opt/homebrew/bin/tailscale"),
            p("/opt/homebrew/Cellar/tailscale/1.90.0/bin/tailscale"),
            &cellar
        ));
        assert!(!link_allowed(
            p("/opt/homebrew/bin/tailscale"),
            p("/opt/homebrew/Cellar/tailscale-evil/bin/tailscale"),
            &cellar
        ));
    }

    #[test]
    fn suggestion_names_are_validated_ldh() {
        assert_eq!(
            valid_dns_name("NAS.Example.ts.net.").as_deref(),
            Some("nas.example.ts.net")
        );
        for bad in [
            "",
            ".",
            "nas..ts.net",
            "-nas.ts.net",
            "nas_1.ts.net",
            "nas.ts.net/x",
            "nås.ts.net",
        ] {
            assert_eq!(valid_dns_name(bad), None, "{bad}");
        }
        assert_eq!(valid_dns_name(&format!("{}.ts.net", "a".repeat(64))), None);
    }
}
