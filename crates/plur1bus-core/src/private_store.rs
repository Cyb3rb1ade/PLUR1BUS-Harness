//! Common owner-only SQLite file preparation and advisory lock release.
use std::path::Path;

/// Creates the directory and the file the way the TypeScript constructors do. `:memory:` has nothing to prepare.
pub(crate) fn prepare(path: &Path) -> std::io::Result<()> {
    if path == Path::new(":memory:") {
        return Ok(());
    }
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        let mut b = std::fs::DirBuilder::new();
        b.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        b.create(dir)?;
    }
    let mut f = std::fs::OpenOptions::new();
    f.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        f.mode(0o600);
    }
    drop(f.open(path)?);
    Ok(())
}

/// `createSecurePath()(path, { mode: 0o600 }).applied` where no hook is given: Unix applies the mode, any other platform
/// has nothing to apply (`false`, so a store that needs it fails closed).
pub(crate) fn default_secure(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).is_ok()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}

/// Distinguishes filesystem preparation from a host that could not verify access.
pub(crate) enum PrepareError {
    Io(std::io::Error),
    Permissions,
}

/// Prepare a private file before SQLite can read it or create a journal.
/// On platforms without Unix modes, the host must verify the file (or its
/// creation under a private parent), including the ACL inherited by sidecars.
pub(crate) fn prepare_owner_only(
    path: &Path,
    verify: Option<&dyn Fn(&Path) -> bool>,
) -> Result<(), PrepareError> {
    #[cfg(unix)]
    {
        prepare(path).map_err(PrepareError::Io)?;
        if !verify.unwrap_or(&default_secure)(path) {
            return Err(PrepareError::Permissions);
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        if !verify.is_some_and(|check| check(path)) {
            return Err(PrepareError::Permissions);
        }
        prepare(path).map_err(PrepareError::Io)
    }
}

/// An acquired advisory lock. Unlock explicitly so a duplicate file description
/// held briefly across fork does not keep an already released operation busy.
pub(crate) struct AdvisoryLease(pub(crate) std::fs::File);

impl Drop for AdvisoryLease {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

/// In tests, a fixture port for synthetic databases below a temporary directory.
#[cfg(test)]
pub(crate) fn fixture_owner_hook() -> Option<&'static dyn Fn(&Path) -> bool> {
    if cfg!(windows) {
        Some(&|_| true)
    } else {
        None
    }
}

#[cfg(test)]
#[path = "private_store_tests.rs"]
mod tests;
