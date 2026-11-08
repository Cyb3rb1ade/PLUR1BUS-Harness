//! Bounded authoritative JSONL snapshots and atomic, derived-cache publication.
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::{
        atomic_write::atomic_write,
        directory::{regular_file_identity, TrustedDirectory},
        paths::{assert_trusted_path, secure_dir},
    },
};
use serde_json::Value;
use std::io::Read;
pub(super) const MAX_BYTES: usize = 64 * 1024 * 1024;
pub(super) const MAX_ROWS: usize = 50_000;
pub(super) fn read(
    dir: &TrustedDirectory,
    name: &str,
    max: usize,
    cancel: &Cancel,
) -> Result<Option<Vec<u8>>, EngineError> {
    let mut file = match dir.open_file(name) {
        Ok(f) => f,
        Err(StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
        }) => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let metadata = file.metadata().map_err(StoreError::from)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(StoreError::UntrustedPath.into());
        }
    }
    if !metadata.is_file() || metadata.len() > max as u64 {
        return Err(StoreError::Corrupt.into());
    }
    let identity = regular_file_identity(&file)?;
    let mut bytes = Vec::new();
    let mut buf = [0; 65536];
    loop {
        cancel.check()?;
        let n = file.read(&mut buf).map_err(StoreError::from)?;
        if n == 0 {
            break;
        }
        if bytes.len() + n > max {
            return Err(StoreError::Corrupt.into());
        }
        bytes.extend_from_slice(&buf[..n]);
    }
    if regular_file_identity(&dir.open_file(name)?)? != identity {
        return Err(StoreError::UntrustedPath.into());
    }
    dir.assert_unchanged()?;
    Ok(Some(bytes))
}
pub(super) fn records(bytes: &[u8]) -> Result<Vec<(Value, usize)>, EngineError> {
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        return Err(StoreError::Corrupt.into());
    }
    let mut rows = Vec::new();
    for line in bytes.split_inclusive(|v| *v == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let row: Value = serde_json::from_slice(line).map_err(|_| StoreError::Corrupt)?;
        if !row.is_object() || rows.len() == MAX_ROWS {
            return Err(StoreError::Corrupt.into());
        }
        rows.push((row, line.len()));
    }
    Ok(rows)
}
pub(super) fn replace(
    dir: &TrustedDirectory,
    name: &str,
    old: Option<&[u8]>,
    bytes: &[u8],
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    check()?;
    dir.assert_unchanged()?;
    if read(dir, name, MAX_BYTES, cancel)?.as_deref() != old {
        return Err(StoreError::Corrupt.into());
    }
    let path = dir.path().join(name);
    assert_trusted_path(&path)?;
    secure_dir(dir.path())?;
    dir.restrict_private()?;
    check()?;
    atomic_write(&path, bytes).map_err(StoreError::from)?;
    dir.assert_unchanged()?;
    check()
}
