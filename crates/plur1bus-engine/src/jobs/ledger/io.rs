//! Bounded ordinary-file reads beneath held directories; no link-following fallback.
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::directory::{regular_file_identity, TrustedDirectory},
};
use std::io::Read;
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
pub(super) fn read(
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
