//! Engine snapshot verification (`plur1bus.snapshot/1`, distinct from Harness tar archives).
use crate::{
    contract::{Cancel, StoreError},
    store::directory::TrustedDirectory,
    text::json::{parse_json, TolerantJsonValue as Json},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, fs,
    io::Read,
    path::Path,
};

/// Exact on-disk engine snapshot schema.
pub const SNAPSHOT_SCHEMA: &str = "plur1bus.snapshot/1";
#[path = "snapshot_copy.rs"]
mod snapshot_copy;
/// RE-D170 create facade, root binding and retention.
#[path = "snapshot_create.rs"]
pub mod snapshot_create;

const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;

/// Content-free snapshot failure categories; no parser/backend message escapes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotError {
    /// Snapshot directory or manifest does not exist.
    NotFound,
    /// Invalid manifest, changed/missing/unlisted payload or digest mismatch.
    DigestMismatch,
    /// A path escapes the snapshot or violates the trusted physical path boundary.
    UnsafePath,
    /// A Lance table kept changing during all three copy attempts.
    SourceBusy,
    /// Caller cancellation or deadline, before snapshot publication.
    Cancelled,
    /// Other filesystem failures.
    Storage,
    /// Less than 1.1 × the source size is free below the snapshot root (pin, RE-D170).
    InsufficientDisk,
}
impl SnapshotError {
    /// Stable Node-compatible category; unsafe manifest paths deliberately fail closed.
    pub fn reason(self) -> &'static str {
        match self {
            Self::NotFound => "not-found",
            Self::DigestMismatch => "digest-mismatch",
            Self::UnsafePath => "unsafe-path",
            Self::Storage => "storage",
            Self::SourceBusy => "source-busy",
            Self::Cancelled => "cancelled",
            Self::InsufficientDisk => "insufficient-disk",
        }
    }
}
impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.reason())
    }
}
impl std::error::Error for SnapshotError {}
impl From<StoreError> for SnapshotError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::UntrustedPath | StoreError::InvalidInput => Self::UnsafePath,
            StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            } => Self::NotFound,
            _ => Self::Storage,
        }
    }
}

/// Same fields as Node `verifySnapshot`; metadata byte coercion is preserved.
#[derive(Debug, Serialize)]
pub struct SnapshotReport {
    /// Snapshot directory basename, independent of its optional manifest id.
    pub id: String,
    /// Manifest entry count (including duplicate entries, as in Node).
    pub files: usize,
    /// Node `Number(manifest.bytes) || 0`; each payload size is separately verified.
    pub bytes: f64,
}

fn property<'a>(value: &'a Json, key: &str) -> Option<&'a Json> {
    let Json::Object(fields) = value else {
        return None;
    };
    fields
        .iter()
        .rev()
        .find(|(k, _)| k.to_utf8_lossy() == key)
        .map(|(_, v)| v)
}
fn text(value: &Json) -> Option<String> {
    if let Json::String(s) = value {
        Some(s.to_utf8_lossy())
    } else {
        None
    }
}

fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', ':', '\0'])
        && path.split('/').all(|part| {
            !part.is_empty() && part != "." && part != ".." && !part.ends_with(['.', ' '])
        })
}

fn walk(
    dir: &TrustedDirectory,
    prefix: &str,
    files: &mut BTreeSet<String>,
) -> Result<(), SnapshotError> {
    dir.assert_unchanged()?;
    let entries = fs::read_dir(dir.path()).map_err(|_| SnapshotError::Storage)?;
    for entry in entries {
        let entry = entry.map_err(|_| SnapshotError::Storage)?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| SnapshotError::UnsafePath)?;
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if !safe_relative(&rel) {
            return Err(SnapshotError::UnsafePath);
        }
        let kind = entry.file_type().map_err(|_| SnapshotError::Storage)?;
        if kind.is_dir() {
            walk(&dir.open_child(&name)?, &rel, files)?;
        } else if kind.is_file() {
            if rel != "snapshot.json" {
                files.insert(rel);
            }
        } else {
            return Err(SnapshotError::DigestMismatch);
        }
    }
    dir.assert_unchanged()?;
    Ok(())
}

fn checkpoint(cancel: Option<&Cancel>) -> Result<(), SnapshotError> {
    match cancel {
        Some(cancel) => cancel.check().map_err(|_| SnapshotError::Cancelled),
        None => Ok(()),
    }
}

fn digest(
    dir: &TrustedDirectory,
    relative: &str,
    cancel: Option<&Cancel>,
) -> Result<(u64, String), SnapshotError> {
    let mut parts = relative.split('/').peekable();
    let mut held = Vec::new();
    let mut parent = dir;
    while let Some(name) = parts.next() {
        if parts.peek().is_some() {
            held.push(parent.open_child(name).map_err(payload_error)?);
            parent = held.last().ok_or(SnapshotError::UnsafePath)?;
        } else {
            let mut file = parent.open_file(name).map_err(payload_error)?;
            let mut hasher = Sha256::new();
            let mut bytes = 0_u64;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                checkpoint(cancel)?;
                let n = file.read(&mut buffer).map_err(|_| SnapshotError::Storage)?;
                if n == 0 {
                    break;
                }
                hasher.update(&buffer[..n]);
                bytes += n as u64;
            }
            for pin in &held {
                pin.assert_unchanged()?;
            }
            dir.assert_unchanged()?;
            return Ok((bytes, format!("{:x}", hasher.finalize())));
        }
    }
    Err(SnapshotError::UnsafePath)
}
fn payload_error(e: StoreError) -> SnapshotError {
    match SnapshotError::from(e) {
        SnapshotError::NotFound => SnapshotError::DigestMismatch,
        e => e,
    }
}

/// Verify every regular payload file with readonly, capability-relative opens. The manifest
/// is parsed losslessly: unknown metadata and Node last-member/last-path semantics remain.
/// Unlike Node, traversal and non-portable paths are rejected before opening any payload.
pub fn verify_snapshot(dir: &Path) -> Result<SnapshotReport, SnapshotError> {
    verify(dir, None)
}

/// [`verify_snapshot`], abandoned with `cancelled` between files and between read blocks
/// once `cancel` fires (RE-D170: connection, request or process stop). Read-only either way.
pub fn verify_snapshot_cancellable(
    dir: &Path,
    cancel: &Cancel,
) -> Result<SnapshotReport, SnapshotError> {
    verify(dir, Some(cancel))
}

fn verify(dir: &Path, cancel: Option<&Cancel>) -> Result<SnapshotReport, SnapshotError> {
    checkpoint(cancel)?;
    let root = TrustedDirectory::open(dir)?;
    let file = root.open_file("snapshot.json")?;
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| SnapshotError::Storage)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(SnapshotError::DigestMismatch);
    }
    let manifest =
        parse_json(&String::from_utf8_lossy(&bytes)).map_err(|_| SnapshotError::DigestMismatch)?;
    if property(&manifest, "schema").and_then(text).as_deref() != Some(SNAPSHOT_SCHEMA) {
        return Err(SnapshotError::DigestMismatch);
    }
    let Some(Json::Array(entries)) = property(&manifest, "files") else {
        return Err(SnapshotError::DigestMismatch);
    };
    let mut expected = BTreeMap::new();
    for entry in entries {
        if let Some(path) = property(entry, "path").and_then(text) {
            if !safe_relative(&path) {
                return Err(SnapshotError::UnsafePath);
            }
            expected.insert(path, entry);
        }
    }
    let mut actual = BTreeSet::new();
    walk(&root, "", &mut actual)?;
    if actual.iter().any(|path| !expected.contains_key(path)) {
        return Err(SnapshotError::DigestMismatch);
    }
    for (path, entry) in expected {
        checkpoint(cancel)?;
        let (bytes, hash) = digest(&root, &path, cancel)?;
        let size = match property(entry, "bytes") {
            Some(Json::Number(n)) => n.parse::<f64>().ok(),
            _ => None,
        };
        if size != Some(bytes as f64)
            || property(entry, "sha256").and_then(text).as_deref() != Some(hash.as_str())
        {
            return Err(SnapshotError::DigestMismatch);
        }
    }
    root.assert_unchanged()?;
    let bytes = property(&manifest, "bytes")
        .map(super::import_primitives::number)
        .unwrap_or(0.);
    Ok(SnapshotReport {
        id: dir
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or(SnapshotError::UnsafePath)?
            .to_owned(),
        files: entries.len(),
        bytes: if bytes.is_nan() || bytes == 0. {
            0.
        } else {
            bytes
        },
    })
}
