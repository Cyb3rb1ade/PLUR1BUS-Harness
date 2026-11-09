//! Private immutable archive publication and held-directory live replacement.
use super::{journal_io, merged::optional};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::directory::{regular_file_identity, TrustedDirectory},
};
use std::io::Write;

struct Staging<'a> {
    dir: &'a TrustedDirectory,
    name: String,
    identity: (u64, u64),
}
impl Drop for Staging<'_> {
    fn drop(&mut self) {
        if self
            .dir
            .open_file(&self.name)
            .and_then(|f| regular_file_identity(&f))
            .ok()
            == Some(self.identity)
        {
            let _ = self.dir.remove_file(&self.name);
        }
    }
}
fn stage<'a>(
    dir: &'a TrustedDirectory,
    bytes: &[u8],
    cancel: &Cancel,
) -> Result<Staging<'a>, EngineError> {
    let mut count = 0;
    for (index, entry) in std::fs::read_dir(dir.path())
        .map_err(StoreError::from)?
        .enumerate()
    {
        cancel.check()?;
        if index >= journal_io::MAX_ROWS {
            return Err(StoreError::Unavailable.into());
        }
        if entry
            .map_err(StoreError::from)?
            .file_name()
            .to_string_lossy()
            .starts_with(".native-neo-cap-")
        {
            count += 1;
        }
        if count >= 128 {
            return Err(StoreError::Unavailable.into());
        }
    }
    let name = format!(".native-neo-cap-{}.tmp", uuid::Uuid::new_v4());
    let mut file = dir.create_file(&name)?;
    let staged = Staging {
        dir,
        name,
        identity: regular_file_identity(&file)?,
    };
    for chunk in bytes.chunks(65536) {
        cancel.check()?;
        file.write_all(chunk).map_err(StoreError::from)?;
    }
    file.sync_all().map_err(StoreError::from)?;
    Ok(staged)
}

pub(super) fn publish_archive(
    dir: &TrustedDirectory,
    name: &str,
    bytes: &[u8],
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<(u64, u64), EngineError> {
    check()?;
    if let Some(file) = optional(dir.open_file(name))? {
        let id = regular_file_identity(&file)?;
        if journal_io::bytes(dir, name, cancel)?.as_deref() != Some(bytes) {
            return Err(StoreError::Corrupt.into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if file
                .metadata()
                .map_err(StoreError::from)?
                .permissions()
                .mode()
                & 0o777
                != 0o600
            {
                return Err(StoreError::UntrustedPath.into());
            }
        }
        file.sync_all().map_err(StoreError::from)?;
        dir.sync_entries()?;
        check()?;
        if regular_file_identity(&dir.open_file(name)?)? != id {
            return Err(StoreError::UntrustedPath.into());
        }
        return Ok(id);
    }
    let staged = stage(dir, bytes, cancel)?;
    check()?;
    if journal_io::bytes(dir, &staged.name, cancel)?.as_deref() != Some(bytes) {
        return Err(StoreError::Corrupt.into());
    }
    dir.replace_staged(&staged.name, name, staged.identity, None)?;
    check()?;
    Ok(staged.identity)
}

pub(super) fn replace_live(
    dir: &TrustedDirectory,
    name: &str,
    identity: (u64, u64),
    before: &[u8],
    after: &[u8],
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    check()?;
    let staged = stage(dir, after, cancel)?;
    check()?;
    if regular_file_identity(&dir.open_file(name)?)? != identity
        || journal_io::bytes(dir, name, cancel)?.as_deref() != Some(before)
        || journal_io::bytes(dir, &staged.name, cancel)?.as_deref() != Some(after)
    {
        return Err(StoreError::UntrustedPath.into());
    }
    dir.replace_staged(&staged.name, name, staged.identity, Some(identity))?;
    check()?;
    if regular_file_identity(&dir.open_file(name)?)? != staged.identity
        || journal_io::bytes(dir, name, cancel)?.as_deref() != Some(after)
    {
        return Err(StoreError::UntrustedPath.into());
    }
    Ok(())
}
