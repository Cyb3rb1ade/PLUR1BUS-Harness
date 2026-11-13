//! Bounded ordinary-file reads beneath held directories; no link-following fallback.
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::directory::{regular_file_identity, TrustedDirectory},
};
use std::io::{Read, Write};
pub(super) fn child(
    dir: &TrustedDirectory,
    name: &str,
) -> Result<Option<TrustedDirectory>, EngineError> {
    match dir.open_child(name) {
        Ok(child) => Ok(Some(child)),
        Err(StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
        }) => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub(crate) fn read(
    dir: &TrustedDirectory,
    name: &str,
    max: usize,
    cancel: &Cancel,
) -> Result<Option<Vec<u8>>, EngineError> {
    cancel.check()?;
    let mut file = match dir.open_file(name) {
        Ok(file) => file,
        Err(StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
        }) => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let identity = regular_file_identity(&file)?;
    let size = file.metadata().map_err(StoreError::from)?.len();
    if size > max as u64 {
        return Err(StoreError::Corrupt.into());
    }
    let mut bytes = Vec::new();
    let mut chunk = [0; 65536];
    loop {
        cancel.check()?;
        let read = file.read(&mut chunk).map_err(StoreError::from)?;
        if read == 0 {
            break;
        }
        if bytes.len() + read > max {
            return Err(StoreError::Corrupt.into());
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    if regular_file_identity(&dir.open_file(name)?)? != identity
        || file.metadata().map_err(StoreError::from)?.len() != size
        || bytes.len() as u64 != size
    {
        return Err(StoreError::Unavailable.into());
    }
    dir.assert_unchanged()?;
    Ok(Some(bytes))
}
pub(super) fn sync(dir: &TrustedDirectory) -> Result<(), EngineError> {
    dir.sync_entries()?;
    Ok(())
}
pub(super) fn remove(dir: &TrustedDirectory, name: &str) -> Result<(), EngineError> {
    dir.remove_file(name)?;
    Ok(())
}

/// Verify only the exact acknowledged row span; unrelated earlier ledger content is not reread per marker.
pub(super) fn verify_range(
    dir: &TrustedDirectory,
    name: &str,
    offset: u64,
    bytes: &[u8],
    cancel: &Cancel,
) -> Result<(), EngineError> {
    use std::io::{Seek, SeekFrom};
    cancel.check()?;
    let mut file = dir.open_file(name)?;
    let identity = regular_file_identity(&file)?;
    file.seek(SeekFrom::Start(offset))
        .map_err(StoreError::from)?;
    let mut buffer = [0; 65536];
    let mut position = 0;
    while position < bytes.len() {
        cancel.check()?;
        let count = (bytes.len() - position).min(buffer.len());
        file.read_exact(&mut buffer[..count])
            .map_err(StoreError::from)?;
        if buffer[..count] != bytes[position..position + count] {
            return Err(StoreError::Corrupt.into());
        }
        position += count;
    }
    if regular_file_identity(&dir.open_file(name)?)? != identity {
        return Err(StoreError::UntrustedPath.into());
    }
    dir.assert_unchanged()?;
    Ok(())
}

pub(crate) fn identity(
    dir: &TrustedDirectory,
    name: &str,
) -> Result<Option<(u64, u64)>, EngineError> {
    match dir.open_file(name) {
        Ok(file) => Ok(Some(regular_file_identity(&file)?)),
        Err(StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
        }) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub(crate) fn replace(
    dir: &TrustedDirectory,
    target: &str,
    before: Option<&[u8]>,
    bytes: &[u8],
    max: usize,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    let name = format!(".job-{}.tmp", uuid::Uuid::new_v4());
    let mut file = dir.create_file(&name)?;
    let staged_identity = regular_file_identity(&file)?;
    let result = (|| {
        file.write_all(bytes).map_err(StoreError::from)?;
        file.sync_all().map_err(StoreError::from)?;
        drop(file);
        check()?;
        let old_identity = identity(dir, target)?;
        if read(dir, target, max, cancel)?.as_deref() != before {
            return Err(StoreError::Unavailable.into());
        }
        check()?;
        dir.replace_staged(&name, target, staged_identity, old_identity)?;
        Ok(())
    })();
    if result.is_err() && identity(dir, &name).ok().flatten() == Some(staged_identity) {
        let _ = dir.remove_file(&name);
    }
    result
}
