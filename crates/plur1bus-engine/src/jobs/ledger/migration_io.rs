//! Held-directory publication for the migration receipt, first copy and marked state.
use crate::{
    contract::{Cancel, EngineError, StoreError},
    jobs::ledger::io,
    store::directory::{regular_file_identity, TrustedDirectory},
};
use std::io::Write;
struct Staging<'a> {
    dir: &'a TrustedDirectory,
    name: &'a str,
    identity: (u64, u64),
}
impl Drop for Staging<'_> {
    fn drop(&mut self) {
        if io::identity(self.dir, self.name).ok().flatten() == Some(self.identity) {
            let _ = self.dir.remove_file(self.name);
        }
    }
}
fn bound(dir: &TrustedDirectory, cancel: &Cancel) -> Result<(), EngineError> {
    let mut staged = 0;
    for (index, entry) in std::fs::read_dir(dir.path())
        .map_err(StoreError::from)?
        .enumerate()
    {
        cancel.check()?;
        if index >= 50_000 {
            return Err(StoreError::Corrupt.into());
        }
        let entry = entry.map_err(StoreError::from)?;
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(".native-job-migration-")
        {
            staged += 1;
        }
        if staged >= 128 {
            return Err(StoreError::Corrupt.into());
        }
    }
    dir.assert_unchanged()?;
    Ok(())
}
pub(super) fn replace(
    dir: &TrustedDirectory,
    name: &str,
    before: Option<&[u8]>,
    after: &[u8],
    max: usize,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    check()?;
    if after.len() > max {
        return Err(StoreError::Corrupt.into());
    }
    let identity = io::identity(dir, name)?;
    if io::read(dir, name, max, cancel)?.as_deref() != before {
        return Err(StoreError::Unavailable.into());
    }
    bound(dir, cancel)?;
    let temp = format!(".native-job-migration-{}.tmp", uuid::Uuid::new_v4());
    let mut file = dir.create_file(&temp)?;
    let staged = regular_file_identity(&file)?;
    let _cleanup = Staging {
        dir,
        name: &temp,
        identity: staged,
    };
    file.write_all(after).map_err(StoreError::from)?;
    file.sync_all().map_err(StoreError::from)?;
    drop(file);
    check()?;
    if io::identity(dir, name)? != identity
        || io::read(dir, name, max, cancel)?.as_deref() != before
        || io::read(dir, &temp, max, cancel)?.as_deref() != Some(after)
    {
        return Err(StoreError::Unavailable.into());
    }
    dir.replace_staged(&temp, name, staged, identity)?;
    check()?;
    if io::identity(dir, name)? != Some(staged)
        || io::read(dir, name, max, cancel)?.as_deref() != Some(after)
    {
        return Err(StoreError::Unavailable.into());
    }
    Ok(())
}
