//! Held directory capabilities for namespace routing, with the pin's verified-path fallback.
//!
//! Unix children are opened relative to a held descriptor with `openat` and `O_NOFOLLOW`.
//! Lance receives a verified descriptor alias when the host exposes one. Otherwise the held
//! identity is checked against the physical path before use, as Node's verified-path router does.

#[cfg(windows)]
use std::fs;
use std::fs::{File, OpenOptions};
use std::path::{Component, Path, PathBuf};

use crate::contract::StoreError;

use super::paths::assert_trusted_path;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectoryId(u64, u64);

fn io_error(error: std::io::Error) -> StoreError {
    StoreError::from(error)
}

fn absolute_path(path: &Path) -> Result<PathBuf, StoreError> {
    if path.as_os_str().is_empty() {
        return Err(StoreError::InvalidInput);
    }
    #[cfg(windows)]
    if !path.is_absolute() && matches!(path.components().next(), Some(Component::Prefix(_))) {
        // A drive-relative C:child depends on per-drive process state instead of an anchor.
        return Err(StoreError::InvalidInput);
    }
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().map_err(io_error)?.join(path)
    };
    let mut physical = PathBuf::new();
    for component in absolute.components() {
        if component == Component::ParentDir {
            return Err(StoreError::UntrustedPath);
        }
        if component != Component::CurDir {
            physical.push(component.as_os_str());
        }
    }
    Ok(physical)
}

fn valid_child(name: &str) -> Result<(), StoreError> {
    if name.is_empty() || matches!(name, "." | "..") || name.contains(['/', '\\', '\0']) {
        return Err(StoreError::InvalidInput);
    }
    #[cfg(windows)]
    if name.contains(':') || name.ends_with(['.', ' ']) {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}

/// A live directory handle whose identity cannot be recycled while the store uses it.
///
/// Keep this value alive for the lifetime of every connection using [`Self::lance_path`].
/// `assert_unchanged` must precede operations: it rejects a replaced pathname even when the
/// held Unix descriptor could still route safely to the original directory.
pub struct TrustedDirectory {
    physical: PathBuf,
    lance: PathBuf,
    anchor: File,
    identity: DirectoryId,
}

impl TrustedDirectory {
    /// Open an existing non-symlink directory, walking from the filesystem root without links.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let physical = absolute_path(path)?;
        assert_trusted_path(&physical)?;
        let anchor = open_chain(&physical)?;
        let directory = Self::from_anchor(physical, anchor)?;
        directory.assert_unchanged()?;
        Ok(directory)
    }

    fn from_anchor(physical: PathBuf, anchor: File) -> Result<Self, StoreError> {
        let identity = file_identity(&anchor)?;
        let lance = route(&anchor, identity).unwrap_or_else(|| physical.clone());
        Ok(Self {
            physical,
            lance,
            anchor,
            identity,
        })
    }

    /// The absolute physical pathname that was verified when the handle was opened.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.physical
    }

    /// The verified descriptor alias, or the identity-checked physical fallback path.
    #[must_use]
    pub fn lance_path(&self) -> &Path {
        &self.lance
    }

    /// Verify the held handle, every current pathname component, and its final directory id.
    pub fn assert_unchanged(&self) -> Result<(), StoreError> {
        if file_identity(&self.anchor)? != self.identity {
            return Err(StoreError::UntrustedPath);
        }
        assert_trusted_path(&self.physical)?;
        let current = open_chain(&self.physical).map_err(|_| StoreError::UntrustedPath)?;
        if file_identity(&current)? != self.identity {
            return Err(StoreError::UntrustedPath);
        }
        if self.lance != self.physical {
            let alias = open_alias(&self.lance)?;
            if file_identity(&alias)? != self.identity {
                return Err(StoreError::UntrustedPath);
            }
        }
        Ok(())
    }

    /// Open one directory segment relative to this capability; names cannot escape the parent.
    pub fn open_child(&self, name: &str) -> Result<Self, StoreError> {
        valid_child(name)?;
        self.assert_unchanged()?;
        #[cfg(unix)]
        let anchor = unix_child(&self.anchor, std::ffi::OsStr::new(name))?;
        #[cfg(windows)]
        let anchor = open_chain(&self.physical.join(name))?;
        let child = Self::from_anchor(self.physical.join(name), anchor)?;
        self.assert_unchanged()?;
        child.assert_unchanged()?;
        Ok(child)
    }
}

#[cfg(unix)]
fn unix_policy(file: &File) -> Result<(), StoreError> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata().map_err(io_error)?;
    // SAFETY: geteuid only reads this process's effective identity.
    let user = unsafe { libc::geteuid() };
    if !metadata.is_dir()
        || (metadata.uid() != 0 && metadata.uid() != user)
        || (metadata.mode() & 0o022 != 0 && metadata.mode() & 0o1000 == 0)
    {
        return Err(StoreError::UntrustedPath);
    }
    Ok(())
}

#[cfg(unix)]
fn unix_flags() -> i32 {
    libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC
}

#[cfg(unix)]
fn unix_child(parent: &File, name: &std::ffi::OsStr) -> Result<File, StoreError> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| StoreError::InvalidInput)?;
    // SAFETY: parent owns a live directory fd; the NUL-terminated name and flags are valid.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | unix_flags(),
        )
    };
    if fd < 0 {
        return Err(directory_open_error(std::io::Error::last_os_error()));
    }
    // SAFETY: successful openat returned one newly owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    unix_policy(&file)?;
    Ok(file)
}

#[cfg(unix)]
fn directory_open_error(error: std::io::Error) -> StoreError {
    if matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) {
        StoreError::UntrustedPath
    } else {
        io_error(error)
    }
}

#[cfg(unix)]
fn open_chain(path: &Path) -> Result<File, StoreError> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut anchor = OpenOptions::new()
        .read(true)
        .custom_flags(unix_flags())
        .open(Path::new("/"))
        .map_err(directory_open_error)?;
    unix_policy(&anchor)?;
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => anchor = unix_child(&anchor, name)?,
            _ => return Err(StoreError::UntrustedPath),
        }
    }
    Ok(anchor)
}

#[cfg(unix)]
fn file_identity(file: &File) -> Result<DirectoryId, StoreError> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_dir() {
        return Err(StoreError::UntrustedPath);
    }
    Ok(DirectoryId(metadata.dev(), metadata.ino()))
}

#[cfg(unix)]
fn open_alias(path: &Path) -> Result<File, StoreError> {
    use std::os::unix::fs::OpenOptionsExt;
    // This deliberately follows only our verified fd alias, never a caller-supplied path.
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(path.join("."))
        .map_err(io_error)
}

#[cfg(unix)]
fn route(file: &File, identity: DirectoryId) -> Option<PathBuf> {
    use std::os::fd::AsRawFd;
    let fd = file.as_raw_fd();
    #[cfg(target_os = "linux")]
    let candidates = vec![
        PathBuf::from(format!("/proc/self/fd/{fd}")),
        PathBuf::from(format!("/dev/fd/{fd}")),
    ];
    #[cfg(not(target_os = "linux"))]
    let candidates = vec![PathBuf::from(format!("/dev/fd/{fd}"))];
    candidates.into_iter().find(|candidate| {
        open_alias(candidate)
            .is_ok_and(|alias| file_identity(&alias).is_ok_and(|found| found == identity))
    })
}

#[cfg(windows)]
fn windows_open(path: &Path) -> Result<File, StoreError> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES,
    };
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(StoreError::UntrustedPath);
    }
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(io_error)?;
    let held = file.metadata().map_err(io_error)?;
    if !held.is_dir() || held.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(StoreError::UntrustedPath);
    }
    Ok(file)
}

#[cfg(windows)]
fn file_identity(file: &File) -> Result<DirectoryId, StoreError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    // SAFETY: the correctly laid out POD is populated through a live owned handle.
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the handle and output buffer remain live for the duration of this query.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) } == 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    Ok(DirectoryId(
        u64::from(information.dwVolumeSerialNumber),
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    ))
}

#[cfg(windows)]
fn open_chain(path: &Path) -> Result<File, StoreError> {
    let mut walked = PathBuf::new();
    let mut held = Vec::new();
    for component in path.components() {
        walked.push(component.as_os_str());
        match component {
            Component::Prefix(_) => continue,
            Component::RootDir | Component::Normal(_) => {}
            _ => return Err(StoreError::UntrustedPath),
        }
        let file = windows_open(&walked)?;
        let identity = file_identity(&file)?;
        held.push((walked.clone(), file, identity));
    }
    // Verify every ancestor after the child is pinned; a swapped ancestor cannot redirect it.
    for (name, _, identity) in &held {
        if file_identity(&windows_open(name)?)? != *identity {
            return Err(StoreError::UntrustedPath);
        }
    }
    held.pop()
        .map(|(_, file, _)| file)
        .ok_or(StoreError::InvalidInput)
}

#[cfg(windows)]
fn open_alias(path: &Path) -> Result<File, StoreError> {
    windows_open(path)
}

#[cfg(windows)]
fn route(_file: &File, _identity: DirectoryId) -> Option<PathBuf> {
    None
}
