//! What the three small stores of K3b (`inbox.sqlite`, `delivery.sqlite`, `channel-handoff.sqlite`) do before SQLite sees
//! their file: the directory 0700 and the file 0600 (`mkdirSync(dirname, { recursive: true, mode: 0o700 })` and
//! `closeSync(openSync(path, "a", 0o600))`), then the platform's owner-only hook. The permission bits only exist on Unix; on
//! other platforms the hook is the only protection, which is why the delivery and hand-off stores refuse to open without one.
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
