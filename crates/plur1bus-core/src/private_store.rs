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

/// Prepare the pathname for a versioned store. On Windows the host's ACL attestation
/// must be read-only and cover the parent before SQLite may open the database.
/// On Unix, new paths are created privately; existing permissions are left alone.
pub(crate) fn prepare_versioned(
    path: &Path,
    verify: Option<&dyn Fn(&Path) -> bool>,
) -> Result<(), PrepareError> {
    if path == Path::new(":memory:") {
        return Ok(());
    }
    #[cfg(unix)]
    {
        let _ = verify;
        prepare(path).map_err(PrepareError::Io)
    }
    #[cfg(not(unix))]
    {
        prepare_owner_only(path, verify)
    }
}

/// Inspect only the on-disk schema using a read-only connection. The owner
/// callback runs before obtaining any writable SQLite handle. Check the schema
/// again on that handle before configuration or migration.
pub(crate) fn open_versioned<E: From<plur1bus_store::StoreError>>(
    path: &Path,
    owner: &plur1bus_store::OwnerSpec,
    protect: impl FnOnce() -> Result<(), E>,
) -> Result<plur1bus_store::Store, E> {
    use plur1bus_store::{
        rusqlite::{Connection, OpenFlags},
        Store, StoreError,
    };
    let check = |cx: &Connection| -> Result<(), StoreError> {
        let found: u32 = cx.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if found > owner.store.version {
            return Err(StoreError::NewerSchema {
                store: owner.store.name,
                found,
                supported: owner.store.version,
            });
        }
        Ok(())
    };
    if path != Path::new(":memory:") {
        let cx = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(StoreError::from)?;
        check(&cx)?;
        protect()?;
    }
    Store::open_owner_before_configure(path, owner, |cx| check(cx).map_err(E::from))
}

/// Apply Unix permissions only after checking the schema on the opened connection.
pub(crate) fn protect_compatible(path: &Path, verify: Option<&dyn Fn(&Path) -> bool>) -> bool {
    #[cfg(unix)]
    {
        path == Path::new(":memory:") || verify.unwrap_or(&default_secure)(path)
    }
    #[cfg(not(unix))]
    {
        let _ = (path, verify);
        true
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
pub(crate) mod tests;
