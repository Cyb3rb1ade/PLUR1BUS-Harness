//! Trusted physical store paths and private directory creation.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::contract::StoreError;

/// Refuse symlinks in every existing component without creating a missing target.
///
/// Windows reports directory junctions through `is_symlink` too. Callers retain a physical
/// path, rather than canonicalizing away an unsafe link before this check.
pub fn assert_trusted_path(path: &Path) -> Result<(), StoreError> {
    let absolute = absolute_path(path)?;
    let mut walked = PathBuf::new();
    for component in absolute.components() {
        if component == Component::ParentDir {
            return Err(StoreError::UntrustedPath);
        }
        if component == Component::CurDir {
            continue;
        }
        walked.push(component.as_os_str());
        match fs::symlink_metadata(&walked) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(StoreError::UntrustedPath);
            }
            Ok(metadata) if walked != absolute && !metadata.is_dir() => {
                return Err(StoreError::UntrustedPath);
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(())
}

/// Create missing directories privately and verify an existing target through the RPC trust rule.
///
/// Existing directory permissions are never silently repaired. Shared system ancestors may
/// contain this user's private temporary directory; their ownership is not changed or claimed.
pub fn secure_dir(path: &Path) -> Result<(), StoreError> {
    let absolute = absolute_path(path)?;
    assert_trusted_path(&absolute)?;
    let mut missing = Vec::new();
    let mut ancestor = absolute.as_path();
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err(StoreError::UntrustedPath);
                }
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(ancestor.to_owned());
                ancestor = ancestor.parent().ok_or(StoreError::UntrustedPath)?;
            }
            Err(error) => return Err(io_error(error)),
        }
    }
    for directory in missing.into_iter().rev() {
        assert_trusted_path(&directory)?;
        #[allow(unused_mut)] // Only the Unix builder configures an explicit creation mode.
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        let created = match builder.create(&directory) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(error) => return Err(io_error(error)),
        };
        assert_trusted_path(&directory)?;
        #[cfg(windows)]
        if created {
            let user = plur1bus_rpc::win::user_sid().map_err(io_error)?;
            let sddl = plur1bus_rpc::acl::run_dir_sddl(&user);
            plur1bus_rpc::win::set_path_dacl(&directory, &sddl).map_err(io_error)?;
        }
        #[cfg(not(windows))]
        let _ = created;
        verify_directory(&directory)?;
    }
    assert_trusted_path(&absolute)?;
    verify_directory(&absolute)
}

/// Restrict an existing state file to this user (and SYSTEM on Windows), without following links.
pub fn secure_file(path: &Path) -> Result<(), StoreError> {
    assert_trusted_path(path)?;
    if !fs::symlink_metadata(path).map_err(io_error)?.is_file() {
        return Err(StoreError::UntrustedPath);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = fs::symlink_metadata(path).map_err(io_error)?;
        // SAFETY: geteuid has no preconditions and does not fail.
        let euid = unsafe { libc::geteuid() };
        plur1bus_rpc::trust::check_peer_uid(Some(metadata.uid()), euid)
            .map_err(|_| StoreError::UntrustedPath)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(io_error)?;
    }
    #[cfg(windows)]
    {
        let user = plur1bus_rpc::win::user_sid().map_err(io_error)?;
        let sddl = plur1bus_rpc::acl::user_and_system_sddl(&user);
        plur1bus_rpc::win::set_path_dacl(path, &sddl).map_err(io_error)?;
    }
    Ok(())
}

/// A namespace directory using the pinned engine's ASCII identifier grammar.
pub fn namespace_path(base: &Path, namespace: &str) -> Result<PathBuf, StoreError> {
    let bytes = namespace.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 64
        || !bytes[0].is_ascii_alphanumeric()
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-'))
    {
        return Err(StoreError::InvalidInput);
    }
    let path = base.join(namespace);
    assert_trusted_path(&path)?;
    Ok(path)
}

fn absolute_path(path: &Path) -> Result<PathBuf, StoreError> {
    if path.as_os_str().is_empty() {
        return Err(StoreError::InvalidInput);
    }
    if path.is_absolute() {
        Ok(path.to_owned())
    } else {
        Ok(std::env::current_dir().map_err(io_error)?.join(path))
    }
}

fn verify_directory(path: &Path) -> Result<(), StoreError> {
    if !fs::symlink_metadata(path).map_err(io_error)?.is_dir() {
        return Err(StoreError::UntrustedPath);
    }
    plur1bus_rpc::trust::verify_run_dir(path).map_err(|_| StoreError::UntrustedPath)
}

fn io_error(error: std::io::Error) -> StoreError {
    StoreError::from(error)
}
