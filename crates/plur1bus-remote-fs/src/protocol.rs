//! Closed v1 pipe metadata and length frames. Private key material has a separate raw frame, never a JSON field.
use crate::Failure;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zeroize::Zeroize;

/// Connect metadata is capped before allocation.
pub const CONNECT_BYTES: usize = 16 * 1024;
/// Private key frames are independently capped before allocation.
pub const KEY_BYTES: usize = 64 * 1024;
/// Read data frames never exceed this size.
pub const READ_BYTES: u32 = 64 * 1024;
/// No metadata or SFTP frame may exceed this hard ceiling.
pub const METADATA_BYTES: usize = 1024 * 1024;

/// The complete per-session budgets; defaults match the reusable Node port.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct Limits {
    /// Maximum complete source file size.
    pub file_bytes: u64,
    /// Cumulative bytes returned, counting repeated reads again.
    pub read_bytes: u64,
    /// Cumulative directory entries, including repeated listings.
    pub entries: u64,
    /// Maximum absolute POSIX path depth.
    pub depth: usize,
    /// SFTP decoder allocation ceiling.
    pub packet_bytes: u32,
    /// Encoded JSON metadata ceiling.
    pub metadata_bytes: usize,
    /// Maximum public operations and internal listing pages.
    pub requests: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            file_bytes: 32 << 20,
            read_bytes: 512 << 20,
            entries: 16_384,
            depth: 32,
            packet_bytes: 256 << 10,
            metadata_bytes: METADATA_BYTES,
            requests: 10_000,
        }
    }
}

/// Probe performs SSH key exchange only; connect requires a separate bounded key frame.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    ProbeHostKey,
    Connect,
}

/// Metadata supplied by the authorized host after its egress service vets the numeric address.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connect {
    /// Protocol version, currently one.
    pub v: u8,
    /// Handshake-only probe or authenticated read-only session.
    pub mode: Mode,
    /// Numeric IPv4/IPv6; this process never resolves a hostname.
    pub ip: String,
    /// Explicit destination port.
    pub port: u16,
    /// SSH account, required for connect.
    #[serde(default)]
    pub username: String,
    /// Standard SHA256:base64-without-padding fingerprint, required for connect.
    #[serde(default)]
    pub host_key_sha256: Option<String>,
    /// Absolute Unix milliseconds; at most five minutes into the future.
    pub deadline_ms: u64,
    /// Finite run and allocation budgets.
    #[serde(default)]
    pub limits: Limits,
}

impl Connect {
    /// Validates the closed contract before any socket is opened; returns a numeric socket and monotonic deadline.
    pub fn validate(&self) -> Result<(SocketAddr, Instant), Failure> {
        let ip: IpAddr = self.ip.parse().map_err(|_| Failure::InvalidRequest)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Failure::InvalidRequest)?
            .as_millis() as u64;
        let remaining = self
            .deadline_ms
            .checked_sub(now)
            .filter(|n| *n > 0 && *n <= 300_000)
            .ok_or(Failure::InvalidRequest)?;
        let l = &self.limits;
        if self.v != 1
            || self.port == 0
            || self.username.len() > 256
            || self.username.chars().any(char::is_control)
            || (self.mode == Mode::Connect
                && (self.username.is_empty()
                    || self.host_key_sha256.as_ref().is_none_or(|pin| {
                        pin.len() != 50
                            || !pin.starts_with("SHA256:")
                            || !pin[7..].bytes().all(|byte| {
                                byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/')
                            })
                    })))
            || l.file_bytes > 1 << 30
            || l.read_bytes > 8 << 30
            || l.entries > 100_000
            || l.depth > 128
            || !(4096..=METADATA_BYTES as u32).contains(&l.packet_bytes)
            || !(1024..=METADATA_BYTES).contains(&l.metadata_bytes)
            || l.requests == 0
            || l.requests > 100_000
        {
            return Err(Failure::InvalidRequest);
        }
        Ok((
            SocketAddr::new(ip, self.port),
            Instant::now() + Duration::from_millis(remaining),
        ))
    }
}

/// Source metadata contains no open handle or backend diagnostics.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    /// file, directory, symlink or other.
    pub kind: &'static str,
    /// Declared size in bytes.
    pub size: u64,
    /// Portable permission bits, when supplied by the SFTP server.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    /// Modification time, when supplied by the server.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<u64>,
}

/// Identity read from the negotiated server key; neither field is guessed from a default algorithm.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostIdentity {
    /// Standard SHA256 fingerprint of the actual host public key.
    pub host_key_sha256: String,
    /// Actual negotiated SSH public-key algorithm.
    pub host_key_algorithm: String,
}

/// Exactly six read-only operations plus closing the session; unknown fields/operations are rejected.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    /// Follow the final link for metadata.
    Stat { id: u64, path: String },
    /// Inspect the final link itself.
    Lstat { id: u64, path: String },
    /// List immediate child names.
    Readdir { id: u64, path: String },
    /// Read one bounded chunk; no remote handle escapes.
    Read {
        id: u64,
        path: String,
        offset: u64,
        length: u32,
    },
    /// Resolve a canonical path.
    Realpath { id: u64, path: String },
    /// Read a link target.
    Readlink { id: u64, path: String },
    /// Close without filesystem mutation.
    Close { id: u64 },
}

impl Request {
    /// Request identifier copied only after successful closed parsing.
    pub fn id(&self) -> u64 {
        match self {
            Self::Stat { id, .. }
            | Self::Lstat { id, .. }
            | Self::Readdir { id, .. }
            | Self::Read { id, .. }
            | Self::Realpath { id, .. }
            | Self::Readlink { id, .. }
            | Self::Close { id } => *id,
        }
    }
}

/// Reads a u32 big-endian length frame. Clean EOF differs from truncation; the declared length is checked first.
pub fn read_frame(input: &mut impl Read, cap: usize) -> Result<Option<Vec<u8>>, Failure> {
    let mut header = [0; 4];
    let first = input
        .read(&mut header[..1])
        .map_err(|_| Failure::InvalidRequest)?;
    if first == 0 {
        return Ok(None);
    }
    input
        .read_exact(&mut header[1..])
        .map_err(|_| Failure::InvalidRequest)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > cap {
        return Err(Failure::InvalidRequest);
    }
    let mut body = vec![0; length];
    if input.read_exact(&mut body).is_err() {
        body.zeroize();
        return Err(Failure::InvalidRequest);
    }
    Ok(Some(body))
}

/// Writes a length frame under the caller's cap; it never accepts a body larger than u32.
pub fn write_frame(output: &mut impl Write, body: &[u8], cap: usize) -> Result<(), Failure> {
    if body.len() > cap || body.len() > u32::MAX as usize {
        return Err(Failure::Limit);
    }
    output
        .write_all(&(body.len() as u32).to_be_bytes())
        .and_then(|()| output.write_all(body))
        .map_err(|_| Failure::Unavailable)
}
