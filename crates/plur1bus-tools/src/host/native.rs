//! Platform adapters for effects whose work is performed by the operating system.

use super::{Failure, Invocation};
use crate::exec::capture::{BoundedCapture, KnownSecrets};
use serde::Serialize;
use serde_json::{json, Value};
use std::net::IpAddr;

const CLIPBOARD_MAX_BYTES: usize = 64 * 1024;

/// Safe hardware and network fields allowed in the Hostctl system report.
#[derive(Serialize)]
pub struct HostInfo {
    /// Operating system identifier.
    pub os: String,
    /// Operating system release.
    pub release: String,
    /// Architecture.
    pub arch: String,
    /// Processor information.
    pub cpu: Cpu,
    /// Memory information.
    pub memory: Memory,
    /// Capacity for the requested roots.
    pub disks: Vec<Disk>,
    /// Local interface addresses, with no hardware identifiers.
    pub network: Vec<Interface>,
}

/// Processor fields in the system report.
#[derive(Serialize)]
pub struct Cpu {
    /// Model name, where available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Number of logical processors.
    pub count: u32,
}

/// Memory in bytes.
#[derive(Serialize)]
pub struct Memory {
    /// Physical memory.
    pub total: u64,
    /// Currently available memory.
    pub free: u64,
}

/// Capacity for a configured root.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    /// The configured root ID.
    pub root_id: String,
    /// The platform could not report capacity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<bool>,
    /// Total capacity, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// Available bytes, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free: Option<u64>,
}

/// An interface without credentials, user data, hostname or hardware address.
#[derive(Serialize)]
pub struct Interface {
    /// Interface name.
    pub name: String,
    /// IPv4 or IPv6 addresses.
    pub addresses: Vec<Address>,
}

/// One local address.
#[derive(Serialize)]
pub struct Address {
    /// The IP address.
    pub address: IpAddr,
    /// The protocol family, as shown by Node.
    pub family: AddressFamily,
    /// Loopback or an internal interface.
    pub internal: bool,
}

/// Host network protocol family.
#[derive(Serialize)]
pub enum AddressFamily {
    /// IPv4.
    IPv4,
    /// IPv6.
    IPv6,
}

/// Local desktop effects. The host supplies implementations at the flip.
pub trait Port {
    /// Read up to the given budget, preserving a final line separator.
    fn read_clipboard(
        &mut self,
        max_bytes: usize,
        call: &Invocation<'_>,
    ) -> Result<String, Failure>;
    /// Pass text as data, never as command arguments or script source.
    fn write_clipboard(&mut self, text: &str, call: &Invocation<'_>) -> Result<(), Failure>;
    /// Show a notification with title and body as data.
    fn notify(&mut self, title: &str, body: &str, call: &Invocation<'_>) -> Result<(), Failure>;
    /// Open one approved, credential-free HTTP(S) URL in the default handler.
    fn open_url(&mut self, url: &str, call: &Invocation<'_>) -> Result<(), Failure>;
    /// Return safe system information for the requested roots.
    fn sys_info(&mut self, call: &Invocation<'_>) -> Result<HostInfo, Failure>;
}

/// Apply one supported desktop effect after Hostctl has redeemed the invocation.
pub fn apply(
    port: &mut dyn Port,
    call: &Invocation<'_>,
    known: Option<KnownSecrets<'_>>,
) -> Option<Result<Value, Failure>> {
    match call.name() {
        "hostctl.clipboard.read"
        | "hostctl.clipboard.write"
        | "hostctl.notify"
        | "hostctl.app.open"
        | "hostctl.sys.info" => Some(run(port, call, known)),
        _ => None,
    }
}

fn run(
    port: &mut dyn Port,
    call: &Invocation<'_>,
    known: Option<KnownSecrets<'_>>,
) -> Result<Value, Failure> {
    if call.aborted() {
        return Err(Failure::new("ABORTED", "Cancelled."));
    }
    let text = |field: &str| {
        call.args()
            .get(field)
            .and_then(Value::as_str)
            .unwrap_or_default()
    };
    let limit = CLIPBOARD_MAX_BYTES.min(call.max_output_bytes());
    match call.name() {
        "hostctl.clipboard.read" => {
            let value = port.read_clipboard(limit + 2, call)?;
            let stripped = value
                .strip_suffix("\r\n")
                .or_else(|| value.strip_suffix('\n'))
                .unwrap_or(&value);
            if stripped.len() > limit {
                return Err(Failure::too_large("The clipboard exceeds the byte limit."));
            }
            let mut capture = BoundedCapture::new(limit, known);
            capture.push(stripped.as_bytes());
            Ok(json!({"text":capture.text(true)}))
        }
        "hostctl.clipboard.write" => {
            let text = text("text");
            if text.len() > limit {
                return Err(Failure::too_large("The clipboard exceeds the byte limit."));
            }
            port.write_clipboard(text, call)?;
            Ok(json!({"bytes":text.len()}))
        }
        "hostctl.notify" => {
            port.notify(text("title"), text("body"), call)?;
            Ok(json!({"sent":true}))
        }
        "hostctl.app.open" => {
            let url = call.url().ok_or_else(|| {
                Failure::new(
                    "UNAVAILABLE",
                    "Verified local document opening is unavailable.",
                )
            })?;
            port.open_url(url, call)?;
            Ok(json!({"opened":true}))
        }
        "hostctl.sys.info" => {
            let mut info = port.sys_info(call)?;
            info.disks
                .retain(|disk| call.root_ids().iter().any(|id| *id == disk.root_id));
            serde_json::to_value(info)
                .map_err(|_| Failure::new("IO_ERROR", "The system report could not be encoded."))
        }
        _ => Err(Failure::invalid("Choose a registered desktop operation.")),
    }
}

/// Descriptor-bound local desktop operations.
///
/// Implementations must operate on the held file. A platform that can only
/// re-resolve the caller's path must return `UNAVAILABLE`.
pub trait PathPort<H> {
    /// Open the verified document or directory in the default viewer.
    fn open_document(&mut self, file: &H, call: &Invocation<'_>) -> Result<(), Failure>;
    /// Recycle the verified entry through the native trash, without deleting it.
    fn trash(&mut self, file: &H, call: &Invocation<'_>) -> Result<(), Failure>;
}

/// Apply local document opening or trash using a verified handle.
pub fn apply_path<F: plur1bus_core::policy::fs_paths::PathFs>(
    fs: &F,
    port: &mut dyn PathPort<F::Handle>,
    call: &Invocation<'_>,
) -> Option<Result<Value, Failure>> {
    match call.name() {
        "hostctl.fs.trash" => Some(path_effect(fs, port, call, false)),
        "hostctl.app.open" if call.url().is_none() => Some(path_effect(fs, port, call, true)),
        _ => None,
    }
}

fn path_effect<F: plur1bus_core::policy::fs_paths::PathFs>(
    fs: &F,
    port: &mut dyn PathPort<F::Handle>,
    call: &Invocation<'_>,
    opening: bool,
) -> Result<Value, Failure> {
    use plur1bus_core::policy::fs_paths::{open_verified, stat_verified, FileKind, OpenFlags};
    let changed = || Failure::new("CHANGED", "The entry could not be verified.");
    let path = call.paths().first().ok_or_else(Failure::outside)?;
    let observed = stat_verified(fs, path).map_err(|_| changed())?;
    let file = open_verified(fs, path, OpenFlags::READ).map_err(|_| changed())?;
    if call.aborted() {
        return Err(Failure::new("ABORTED", "Cancelled."));
    }
    if opening {
        let name = path
            .canonical()
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default();
        let ext = name
            .rsplit_once('.')
            .map(|(_, tail)| tail.to_ascii_lowercase());
        // Some directories are handled as launchable packages by the default viewer.
        let launchable = matches!(
            ext.as_deref(),
            Some(
                "exe"
                    | "com"
                    | "bat"
                    | "cmd"
                    | "ps1"
                    | "psm1"
                    | "vbs"
                    | "vbe"
                    | "js"
                    | "jse"
                    | "wsf"
                    | "wsh"
                    | "hta"
                    | "msi"
                    | "msp"
                    | "scr"
                    | "pif"
                    | "cpl"
                    | "reg"
                    | "jar"
                    | "command"
                    | "tool"
                    | "app"
                    | "workflow"
                    | "action"
                    | "pkg"
                    | "mpkg"
                    | "desktop"
                    | "appimage"
                    | "bundle"
                    | "framework"
                    | "appex"
                    | "prefpane"
                    | "saver"
                    | "lnk"
                    | "url"
                    | "scf"
                    | "appref-ms"
                    | "settingcontent-ms"
                    | "library-ms"
                    | "chm"
                    | "terminal"
                    | "fileloc"
                    | "webloc"
                    | "inetloc"
                    | "mobileconfig"
            )
        );
        let document = matches!(
            ext.as_deref(),
            Some("txt" | "md" | "pdf" | "png" | "jpeg" | "jpg" | "webp" | "gif")
        );
        let allowed = match observed.kind {
            FileKind::Dir => !launchable,
            FileKind::File => document && observed.mode & 0o111 == 0,
            _ => false,
        };
        if !allowed {
            return Err(Failure::denied("Choose a verified document or directory."));
        }
        port.open_document(&file, call)?;
        return Ok(json!({"opened":true}));
    }
    port.trash(&file, call)?;
    Ok(json!({"trashed":true}))
}
