//! Native host filesystem, embedding-address and identity callbacks (RE-08 platform fold).

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use crate::contract::{
    IpcAddress, IpcAddressKind, PlatformCapabilities, SecurePathResult, SecurePathResultMechanism,
    SecurePathResultReason,
};
use crate::store::paths::{assert_trusted_path, secure_dir, secure_file};

const DIRECTORY_MODE: u32 = 0o700;
const FILE_MODE: u32 = 0o600;

/// Compose the four native callbacks without opening a listener or loading a model.
pub fn capabilities() -> PlatformCapabilities {
    PlatformCapabilities {
        secure_path: Arc::new(secure_path),
        ipc_address: Arc::new(ipc_address),
        is_unsafe_link: Arc::new(is_unsafe_link),
        canonical_identity_path: Arc::new(canonical_identity_path),
    }
}

fn is_filesystem_path(path: &Path) -> bool {
    let bytes = path.as_os_str().as_encoded_bytes();
    !bytes.is_empty() && bytes[0] != 0 && !bytes.starts_with(br"\\.\pipe\")
}

fn refused(reason: SecurePathResultReason) -> SecurePathResult {
    SecurePathResult {
        applied: false,
        reason: Some(reason),
        mechanism: None,
    }
}

fn secure_path(path: &Path, mode: Option<u32>) -> SecurePathResult {
    if !is_filesystem_path(path) {
        return refused(SecurePathResultReason::NotAFilesystemPath);
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return refused(SecurePathResultReason::Missing);
        }
        Err(_) => return refused(SecurePathResultReason::UnsupportedPlatform),
    };
    let mode = mode.unwrap_or(FILE_MODE);
    if metadata.file_type().is_symlink() || assert_trusted_path(path).is_err() {
        return refused(SecurePathResultReason::UnsupportedPlatform);
    }
    let result = match mode {
        FILE_MODE if metadata.is_file() => secure_file(path),
        DIRECTORY_MODE if metadata.is_dir() => secure_directory(path),
        _ => return refused(SecurePathResultReason::UnsupportedPlatform),
    };
    if result.is_err() {
        return refused(SecurePathResultReason::UnsupportedPlatform);
    }
    SecurePathResult {
        applied: true,
        reason: None,
        mechanism: Some(if cfg!(windows) {
            SecurePathResultMechanism::Acl
        } else {
            SecurePathResultMechanism::Chmod
        }),
    }
}

fn secure_directory(path: &Path) -> Result<(), crate::contract::StoreError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
        let directory = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        // SAFETY: geteuid has no preconditions and cannot fail.
        let euid = unsafe { libc::geteuid() };
        if directory.metadata()?.uid() != euid {
            return Err(crate::contract::StoreError::UntrustedPath);
        }
        directory.set_permissions(fs::Permissions::from_mode(DIRECTORY_MODE))?;
    }
    #[cfg(windows)]
    {
        let user = plur1bus_rpc::win::user_sid()?;
        plur1bus_rpc::win::set_path_dacl(path, &plur1bus_rpc::acl::run_dir_sddl(&user))?;
    }
    secure_dir(path)
}

fn ipc_address(state_root: &Path) -> IpcAddress {
    #[cfg(windows)]
    {
        use sha2::{Digest, Sha256};
        // This is the pinned engine's embedding-owner rule, not the Harness unit-address rule (RE-D4).
        let digest = format!(
            "{:x}",
            Sha256::digest(state_root.to_string_lossy().as_bytes())
        );
        IpcAddress {
            kind: IpcAddressKind::NamedPipe,
            address: format!(r"\\.\pipe\plur1bus-embedding-{}", &digest[..32]),
        }
    }
    #[cfg(not(windows))]
    {
        let address = absolute_normalized(state_root).join("owner.sock");
        let max_bytes = if cfg!(target_os = "macos") { 104 } else { 108 };
        // The callback cannot express Node's path-length exception. An empty address fails closed instead of
        // letting a Unix listener silently truncate it. Scoped embedding IPC itself remains unported (RE-D4).
        let address = address
            .to_str()
            .filter(|value| !value.contains('\0') && value.len() <= max_bytes)
            .unwrap_or_default()
            .to_owned();
        IpcAddress {
            kind: IpcAddressKind::UnixSocket,
            address,
        }
    }
}

fn is_unsafe_link(path: &Path) -> bool {
    if !is_filesystem_path(path) {
        return false;
    }
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        let absolute = absolute_normalized(path);
        let Ok(actual) = fs::canonicalize(&absolute) else {
            return false;
        };
        let expected = match (absolute.parent(), absolute.file_name()) {
            (Some(parent), Some(name)) => match fs::canonicalize(parent) {
                Ok(parent) => parent.join(name),
                Err(_) => return false,
            },
            _ => actual.clone(),
        };
        // Judge the entry against its own canonical parent: a short-name or symlinked ancestor is not itself
        // a link at this entry. Regular hardlinks remain safe, matching the pinned platform.js callback.
        actual.to_string_lossy().to_lowercase() != expected.to_string_lossy().to_lowercase()
    }
    #[cfg(not(windows))]
    false
}

pub(crate) fn absolute_normalized(path: &Path) -> PathBuf {
    #[cfg(windows)]
    let absolute = std::path::absolute(if path.as_os_str().is_empty() {
        Path::new(".")
    } else {
        path
    })
    .unwrap_or_else(|_| path.to_owned());
    #[cfg(not(windows))]
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn canonical_identity_path(path: &Path) -> PathBuf {
    let absolute = absolute_normalized(path);
    let resolved = fs::canonicalize(&absolute).unwrap_or(absolute);
    #[cfg(windows)]
    {
        // Rust adds a verbatim prefix while Node's realpath does not; keep persisted identities identical.
        let text = resolved.to_string_lossy().replace('/', r"\");
        let text = if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{share}")
        } else {
            text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
        };
        PathBuf::from(text.to_lowercase())
    }
    #[cfg(not(windows))]
    resolved
}

#[cfg(test)]
mod tests {
    // Native OS fixtures intentionally panic on a failed setup/cleanup so a test cannot pass vacuously.
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;
    use crate::contract::{IpcAddressKind, SecurePathResultReason};
    use std::fs;
    use std::path::Path;

    #[test]
    fn permissions_apply_only_the_supported_mode_and_existing_entry_type() {
        let root =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let file = root.path().join("token");
        fs::write(&file, b"private").unwrap();
        let platform = capabilities();
        let secured = platform.secure_path(&file, None);
        assert!(secured.applied);
        assert_eq!(
            secured.mechanism,
            Some(if cfg!(windows) {
                SecurePathResultMechanism::Acl
            } else {
                SecurePathResultMechanism::Chmod
            })
        );
        assert!(platform.secure_path(root.path(), Some(0o700)).applied);
        assert!(!platform.secure_path(&file, Some(0o700)).applied);
        assert!(!platform.secure_path(root.path(), Some(0o600)).applied);
        assert!(!platform.secure_path(&file, Some(0o644)).applied);
        let missing = root.path().join("missing");
        let result = platform.secure_path(&missing, Some(0o700));
        assert!(!result.applied);
        assert_eq!(result.reason, Some(SecurePathResultReason::Missing));
        assert!(!missing.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(file).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(root.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn non_filesystem_addresses_are_never_touched() {
        let platform = capabilities();
        for path in [
            Path::new(""),
            Path::new("\0abstract"),
            Path::new(r"\\.\pipe\example"),
        ] {
            let result = platform.secure_path(path, None);
            assert!(!result.applied);
            assert_eq!(
                result.reason,
                Some(SecurePathResultReason::NotAFilesystemPath)
            );
            assert!(!platform.is_unsafe_link(path));
        }
    }

    #[test]
    fn native_ipc_address_is_the_embedding_owner_address_without_creating_it() {
        let root =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let address = capabilities().ipc_address(root.path());
        #[cfg(unix)]
        {
            assert_eq!(address.kind, IpcAddressKind::UnixSocket);
            assert_eq!(
                address.address,
                root.path().join("owner.sock").to_str().unwrap()
            );
            assert!(!Path::new(&address.address).exists());
            let long = root.path().join("x".repeat(120));
            assert!(capabilities().ipc_address(&long).address.is_empty());
        }
        #[cfg(windows)]
        {
            assert_eq!(address.kind, IpcAddressKind::NamedPipe);
            assert!(address.address.starts_with(r"\\.\pipe\plur1bus-embedding-"));
            // Recorded from the installed pinned Node lib/platform.js, not recomputed by the test.
            let golden = capabilities().ipc_address(Path::new(r"C:\State\Case"));
            assert_eq!(
                golden.address,
                r"\\.\pipe\plur1bus-embedding-7d424f1a47f0c7d9f59755c82872f5b3"
            );
            assert_ne!(
                golden.address,
                capabilities()
                    .ipc_address(Path::new(r"c:\state\case"))
                    .address
            );
        }
    }

    #[test]
    fn hardlinks_are_regular_entries_and_missing_paths_are_not_unsafe() {
        let root =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let file = root.path().join("source");
        let alias = root.path().join("hardlink");
        fs::write(&file, b"same inode").unwrap();
        fs::hard_link(&file, &alias).unwrap();
        assert!(!capabilities().is_unsafe_link(&alias));
        assert!(!capabilities().is_unsafe_link(&root.path().join("absent")));
    }

    #[cfg(unix)]
    #[test]
    fn only_the_last_segment_is_judged_as_a_link_and_secure_path_refuses_aliases() {
        use std::os::unix::fs::symlink;
        let root =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let directory = root.path().join("physical");
        fs::create_dir(&directory).unwrap();
        let file = directory.join("state");
        fs::write(&file, b"state").unwrap();
        let alias = root.path().join("alias");
        symlink(&directory, &alias).unwrap();
        let platform = capabilities();
        assert!(platform.is_unsafe_link(&alias));
        assert!(!platform.is_unsafe_link(&alias.join("state")));
        assert!(!platform.secure_path(&alias.join("state"), None).applied);
        assert_eq!(
            platform.canonical_identity_path(&alias.join("state")),
            fs::canonicalize(file).unwrap()
        );
    }

    #[test]
    fn identity_paths_resolve_dot_segments_and_keep_the_native_case_rule() {
        let root =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let candidate = root.path().join("Missing").join("..").join("Case");
        let identity = capabilities().canonical_identity_path(&candidate);
        #[cfg(unix)]
        assert_eq!(identity, root.path().join("Case"));
        #[cfg(windows)]
        {
            assert_eq!(
                identity.to_str().unwrap(),
                root.path().join("Case").to_str().unwrap().to_lowercase()
            );
            assert!(!capabilities()
                .canonical_identity_path(root.path())
                .to_string_lossy()
                .starts_with(r"\\?\"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_owned_directory_can_be_restricted_to_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let directory = root.path().join("directory");
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(capabilities().secure_path(&directory, Some(0o700)).applied);
        assert_eq!(
            fs::metadata(directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}
