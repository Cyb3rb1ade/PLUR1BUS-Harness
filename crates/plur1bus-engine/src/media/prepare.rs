//! Explicit host-triggered media artifact preparation through the existing guarded K HTTP client.
//!
//! Loading remains read-only. Preparation verifies immutable pins before private atomic publication;
//! it never accepts a repository, revision, URL, credential or artifact list from its caller.

use super::artifacts::{graph_files, MediaGraph, MODEL, REPOSITORY, REVISION};
use super::embedder::MediaError;
use crate::contract::{Cancel, Cancelled};
use crate::embedding::artifacts::ArtifactFile;
use crate::transport::{GuardedClient, HttpRequest, TransportError};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, TryLockError};
use std::time::{Duration, Instant};

static PREPARATION: Mutex<()> = Mutex::new(());
static STAGING_ID: AtomicU64 = AtomicU64::new(0);
const NO_DEADLINE_LIMIT: Duration = Duration::from_secs(1800);

/// Log-safe preparation refusal; no native I/O messages, response bodies or host cache paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaPrepareError {
    /// The caller cancelled or its absolute deadline elapsed.
    Cancelled(Cancelled),
    /// The preparation's 30-minute limit elapsed when the caller supplied no deadline.
    Timeout,
    /// Existing cached bytes or downloaded bytes failed an immutable artifact check.
    Artifact(MediaError),
    /// The existing guarded transport refused or failed a request.
    Transport(TransportError),
    /// A response was not HTTP200; diagnostics are never retained.
    HttpStatus(u16),
    /// Cache creation, descriptor access, writing or atomic publication failed.
    CacheIo,
    /// A cache component is a symlink/reparse point or an artifact path escapes its root.
    UnsafePath,
}

impl std::fmt::Display for MediaPrepareError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled(_) => f.write_str("media preparation cancelled"),
            Self::Timeout => f.write_str("media preparation deadline elapsed"),
            Self::Artifact(error) => write!(f, "{error}"),
            Self::Transport(error) => write!(f, "media preparation transport: {error}"),
            Self::HttpStatus(status) => write!(f, "media artifact server returned HTTP {status}"),
            Self::CacheIo => f.write_str("media preparation cache I/O failed"),
            Self::UnsafePath => f.write_str("media preparation refused an unsafe cache path"),
        }
    }
}
impl std::error::Error for MediaPrepareError {}
impl From<Cancelled> for MediaPrepareError {
    fn from(error: Cancelled) -> Self {
        Self::Cancelled(error)
    }
}
impl From<MediaError> for MediaPrepareError {
    fn from(error: MediaError) -> Self {
        Self::Artifact(error)
    }
}

/// Completed revision-scoped preparation, with no implicit encoder initialization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedMediaArtifacts {
    /// Directory containing the immutable media and original text profile files.
    pub directory: PathBuf,
    /// Files fetched, verified and atomically published by this call.
    pub downloaded_files: usize,
    /// Existing regular files that passed exact size and SHA verification.
    pub reused_files: usize,
}

/// Prepare the pinned q8 vision, audio and unchanged text-profile files through the existing K transport.
///
/// Hosts must supply a `GuardedClient::new_owned` client backed by their live egress gate; that existing
/// client enforces every redirect hop, checked DNS addresses and cancellable socket I/O. One body is
/// buffered at a time, capped at its exact pin (largest:340058624 bytes). No request contains credentials.
/// All files share the caller's absolute cancellation budget; a caller with no deadline gets a single
/// 30-minute limit. Valid cached files are reused; corrupt, nonregular and linked entries refuse.
/// Newly created directories/files are private on Unix. Failed/aborted stages are removed on drop.
/// This explicit library operation never runs from `LocalMediaEmbedder::embed` or the read-only verifier.
pub fn prepare_media_artifacts(
    cache_root: &Path,
    client: &GuardedClient<'static>,
    cancel: &Cancel,
) -> Result<PreparedMediaArtifacts, MediaPrepareError> {
    cancel.check()?;
    let remaining = cancel.remaining().unwrap_or(NO_DEADLINE_LIMIT);
    let deadline = Instant::now()
        .checked_add(remaining)
        .ok_or(MediaPrepareError::Timeout)?;
    let _guard = loop {
        check(cancel, deadline)?;
        match PREPARATION.try_lock() {
            Ok(guard) => break guard,
            Err(TryLockError::Poisoned(_)) => return Err(MediaPrepareError::CacheIo),
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(2)),
        }
    };
    let files = pinned_files()?;
    let directory = cache_root.join(MODEL).join(REVISION);
    let root = Directory::open(&directory, cancel, deadline)?;
    let mut result = PreparedMediaArtifacts {
        directory,
        downloaded_files: 0,
        reused_files: 0,
    };
    for file in files {
        let url = artifact_url(&file)?;
        if prepare_one(&root, &file, &url, client, cancel, deadline)? {
            result.downloaded_files += 1;
        } else {
            result.reused_files += 1;
        }
    }
    check(cancel, deadline)?;
    Ok(result)
}

fn pinned_files() -> Result<Vec<ArtifactFile>, MediaPrepareError> {
    let mut files = BTreeMap::new();
    for graph in [MediaGraph::Vision, MediaGraph::Audio, MediaGraph::Fusion] {
        for file in graph_files(graph)? {
            if let Some(previous) = files.insert(file.path.clone(), file.clone()) {
                if previous != file {
                    return Err(MediaError::InvalidProfile.into());
                }
            }
        }
    }
    Ok(files.into_values().collect())
}

fn artifact_url(file: &ArtifactFile) -> Result<String, MediaPrepareError> {
    relative_parts(&file.path)?;
    if file.source_path.is_some() {
        return Err(MediaError::InvalidProfile.into());
    }
    Ok(format!(
        "https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{}",
        file.path
    ))
}

fn check(cancel: &Cancel, deadline: Instant) -> Result<(), MediaPrepareError> {
    cancel.check()?;
    if Instant::now() >= deadline {
        return Err(MediaPrepareError::Timeout);
    }
    Ok(())
}

fn relative_parts(path: &str) -> Result<Vec<&str>, MediaPrepareError> {
    let parts: Vec<_> = path.split('/').collect();
    if parts.is_empty()
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        })
    {
        return Err(MediaPrepareError::UnsafePath);
    }
    Ok(parts)
}

fn prepare_one(
    root: &Directory,
    file: &ArtifactFile,
    url: &str,
    client: &GuardedClient<'static>,
    cancel: &Cancel,
    deadline: Instant,
) -> Result<bool, MediaPrepareError> {
    check(cancel, deadline)?;
    let parts = relative_parts(&file.path)?;
    let name = *parts.last().ok_or(MediaPrepareError::UnsafePath)?;
    let mut directory = root.duplicate()?;
    for part in &parts[..parts.len() - 1] {
        check(cancel, deadline)?;
        directory = directory.child(std::ffi::OsStr::new(part))?;
    }
    match directory.existing(name) {
        Ok(mut cached) => {
            if !regular_file(&cached)? {
                return Err(MediaError::ArtifactSize {
                    file: file.path.clone(),
                }
                .into());
            }
            if cached
                .metadata()
                .map_err(|_| MediaPrepareError::CacheIo)?
                .len()
                != file.bytes
            {
                return Err(MediaError::ArtifactSize {
                    file: file.path.clone(),
                }
                .into());
            }
            verify_read(&mut cached, file, cancel, deadline)?;
            return Ok(false);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(MediaPrepareError::UnsafePath),
    }
    check(cancel, deadline)?;
    let mut request = HttpRequest::get(url);
    request.max_response_bytes =
        usize::try_from(file.bytes).map_err(|_| MediaPrepareError::CacheIo)?;
    request.max_error_response_bytes = 1024;
    let response = client
        .request_cancelled(request, deadline, cancel)
        .map_err(|error| {
            if let Err(reason) = cancel.check() {
                MediaPrepareError::Cancelled(reason)
            } else {
                MediaPrepareError::Transport(error)
            }
        })?;
    check(cancel, deadline)?;
    if response.status != 200 {
        return Err(MediaPrepareError::HttpStatus(response.status));
    }
    if response.body.len() as u64 != file.bytes {
        return Err(MediaError::ArtifactSize {
            file: file.path.clone(),
        }
        .into());
    }
    let mut stage = Stage::new(&directory)?;
    let mut hash = Sha256::new();
    for chunk in response.body.chunks(64 * 1024) {
        check(cancel, deadline)?;
        stage
            .file
            .write_all(chunk)
            .map_err(|_| MediaPrepareError::CacheIo)?;
        hash.update(chunk);
    }
    check(cancel, deadline)?;
    if format!("{:x}", hash.finalize()) != file.sha256 {
        return Err(MediaError::ArtifactHash {
            file: file.path.clone(),
        }
        .into());
    }
    stage
        .file
        .sync_all()
        .map_err(|_| MediaPrepareError::CacheIo)?;
    check(cancel, deadline)?;
    // Hard-link publication atomically adds the verified file and refuses any concurrent destination;
    // unlike a replacing rename, it cannot overwrite somebody else's newly prepared cache entry.
    directory.publish(&stage.name, name)?;
    check(cancel, deadline)?;
    Ok(true)
}

fn verify_read(
    reader: &mut impl Read,
    file: &ArtifactFile,
    cancel: &Cancel,
    deadline: Instant,
) -> Result<(), MediaPrepareError> {
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        check(cancel, deadline)?;
        let count = reader
            .read(&mut buffer)
            .map_err(|_| MediaPrepareError::CacheIo)?;
        if count == 0 {
            break;
        }
        bytes = bytes
            .checked_add(count as u64)
            .filter(|bytes| *bytes <= file.bytes)
            .ok_or_else(|| {
                MediaPrepareError::Artifact(MediaError::ArtifactSize {
                    file: file.path.clone(),
                })
            })?;
        hash.update(&buffer[..count]);
    }
    check(cancel, deadline)?;
    if bytes != file.bytes {
        return Err(MediaError::ArtifactSize {
            file: file.path.clone(),
        }
        .into());
    }
    if format!("{:x}", hash.finalize()) != file.sha256 {
        return Err(MediaError::ArtifactHash {
            file: file.path.clone(),
        }
        .into());
    }
    Ok(())
}

fn regular_file(file: &File) -> Result<bool, MediaPrepareError> {
    let metadata = file.metadata().map_err(|_| MediaPrepareError::CacheIo)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(MediaPrepareError::UnsafePath);
        }
    }
    Ok(metadata.is_file())
}

struct Directory {
    path: PathBuf,
    #[cfg(unix)]
    handle: File,
    // Keep each Windows ancestor open without FILE_SHARE_DELETE so path-based child operations
    // cannot be redirected by renaming/replacing an already checked parent directory.
    #[cfg(windows)]
    ancestors: Vec<std::sync::Arc<File>>,
}
impl Directory {
    fn open(path: &Path, cancel: &Cancel, deadline: Instant) -> Result<Self, MediaPrepareError> {
        check(cancel, deadline)?;
        let absolute = if path.is_absolute() {
            path.to_owned()
        } else {
            std::env::current_dir()
                .map_err(|_| MediaPrepareError::CacheIo)?
                .join(path)
        };
        #[cfg(unix)]
        {
            let mut directory = Self {
                path: PathBuf::from("/"),
                handle: File::open("/").map_err(|_| MediaPrepareError::CacheIo)?,
            };
            for component in absolute.components() {
                check(cancel, deadline)?;
                match component {
                    Component::RootDir | Component::CurDir => {}
                    Component::Normal(name) => directory = directory.child(name)?,
                    _ => return Err(MediaPrepareError::UnsafePath),
                }
            }
            Ok(directory)
        }
        #[cfg(not(unix))]
        {
            let mut directory = Self {
                path: PathBuf::new(),
                #[cfg(windows)]
                ancestors: Vec::new(),
            };
            for component in absolute.components() {
                check(cancel, deadline)?;
                match component {
                    Component::RootDir | Component::Prefix(_) => directory.path.push(component),
                    Component::CurDir => {}
                    Component::Normal(name) => directory = directory.child(name)?,
                    Component::ParentDir => return Err(MediaPrepareError::UnsafePath),
                }
            }
            Ok(directory)
        }
    }
    fn duplicate(&self) -> Result<Self, MediaPrepareError> {
        Ok(Self {
            path: self.path.clone(),
            #[cfg(unix)]
            handle: self
                .handle
                .try_clone()
                .map_err(|_| MediaPrepareError::CacheIo)?,
            #[cfg(windows)]
            ancestors: self.ancestors.clone(),
        })
    }
    fn child(&self, name: &std::ffi::OsStr) -> Result<Self, MediaPrepareError> {
        let path = self.path.join(name);
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            let name = c_string(name)?;
            // SAFETY: directory descriptor is live; CString is terminated. All cache traversal is
            // relative to retained directory descriptors, so renamed/replaced parents cannot escape.
            let created = unsafe { libc::mkdirat(self.handle.as_raw_fd(), name.as_ptr(), 0o700) };
            if created != 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(MediaPrepareError::CacheIo);
            }
            // SAFETY: opening a named child of our directory descriptor with no symlink following.
            let descriptor = unsafe {
                libc::openat(
                    self.handle.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if descriptor < 0 {
                return Err(MediaPrepareError::UnsafePath);
            }
            // SAFETY: successful openat transfers a new uniquely owned descriptor into File.
            Ok(Self {
                path,
                handle: unsafe { File::from_raw_fd(descriptor) },
            })
        }
        #[cfg(not(unix))]
        {
            match std::fs::create_dir(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(MediaPrepareError::CacheIo),
            }
            #[cfg(windows)]
            let handle = {
                use std::os::windows::fs::OpenOptionsExt;
                std::fs::OpenOptions::new()
                    .read(true)
                    .share_mode(0x0000_0003)
                    .custom_flags(0x0200_0000 | 0x0020_0000)
                    .open(&path)
                    .map_err(|_| MediaPrepareError::UnsafePath)?
            };
            #[cfg(windows)]
            let metadata = handle.metadata().map_err(|_| MediaPrepareError::CacheIo)?;
            #[cfg(not(windows))]
            let metadata =
                std::fs::symlink_metadata(&path).map_err(|_| MediaPrepareError::CacheIo)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(MediaPrepareError::UnsafePath);
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err(MediaPrepareError::UnsafePath);
                }
            }
            #[cfg(windows)]
            let ancestors = {
                let mut ancestors = self.ancestors.clone();
                ancestors.push(std::sync::Arc::new(handle));
                ancestors
            };
            Ok(Self {
                path,
                #[cfg(windows)]
                ancestors,
            })
        }
    }
    fn existing(&self, name: &str) -> std::io::Result<File> {
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            let name =
                std::ffi::CString::new(name).map_err(|_| std::io::ErrorKind::InvalidInput)?;
            // SAFETY: live directory descriptor and terminated single-component filename; no blocking FIFO open.
            let descriptor = unsafe {
                libc::openat(
                    self.handle.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if descriptor < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: uniquely owned new descriptor from successful openat.
            Ok(unsafe { File::from_raw_fd(descriptor) })
        }
        #[cfg(not(unix))]
        {
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(0x0020_0000);
            }
            options.open(self.path.join(name))
        }
    }
    fn stage_file(&self, name: &str) -> std::io::Result<File> {
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            let name =
                std::ffi::CString::new(name).map_err(|_| std::io::ErrorKind::InvalidInput)?;
            // SAFETY: live directory descriptor, valid filename and mode; O_EXCL makes staging private and unshared.
            let descriptor = unsafe {
                libc::openat(
                    self.handle.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if descriptor < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: successful openat returns a uniquely owned new file descriptor.
            Ok(unsafe { File::from_raw_fd(descriptor) })
        }
        #[cfg(not(unix))]
        {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(self.path.join(name))
        }
    }
    fn publish(&self, temporary: &str, destination: &str) -> Result<(), MediaPrepareError> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let temporary = c_string(std::ffi::OsStr::new(temporary))?;
            let destination = c_string(std::ffi::OsStr::new(destination))?;
            // SAFETY: names belong to the live retained parent directory. linkat refuses an existing destination.
            if unsafe {
                libc::linkat(
                    self.handle.as_raw_fd(),
                    temporary.as_ptr(),
                    self.handle.as_raw_fd(),
                    destination.as_ptr(),
                    0,
                )
            } != 0
            {
                return Err(MediaPrepareError::CacheIo);
            }
            self.handle
                .sync_all()
                .map_err(|_| MediaPrepareError::CacheIo)?;
        }
        #[cfg(not(unix))]
        {
            std::fs::hard_link(self.path.join(temporary), self.path.join(destination))
                .map_err(|_| MediaPrepareError::CacheIo)?;
        }
        Ok(())
    }
    fn remove_stage(&self, name: &str) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if let Ok(name) = std::ffi::CString::new(name) {
                // SAFETY: remove only our single staging name relative to the retained directory handle.
                unsafe { libc::unlinkat(self.handle.as_raw_fd(), name.as_ptr(), 0) };
            }
        }
        #[cfg(not(unix))]
        {
            let _ = std::fs::remove_file(self.path.join(name));
        }
    }
}

#[cfg(unix)]
fn c_string(value: &std::ffi::OsStr) -> Result<std::ffi::CString, MediaPrepareError> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(value.as_bytes()).map_err(|_| MediaPrepareError::UnsafePath)
}

struct Stage<'a> {
    directory: &'a Directory,
    name: String,
    file: File,
}
impl<'a> Stage<'a> {
    fn new(directory: &'a Directory) -> Result<Self, MediaPrepareError> {
        for _ in 0..64 {
            let name = format!(
                ".media-{}-{}.part",
                std::process::id(),
                STAGING_ID.fetch_add(1, Ordering::Relaxed)
            );
            match directory.stage_file(&name) {
                Ok(file) => {
                    return Ok(Self {
                        directory,
                        name,
                        file,
                    })
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err(MediaPrepareError::CacheIo),
            }
        }
        Err(MediaPrepareError::CacheIo)
    }
}
impl Drop for Stage<'_> {
    fn drop(&mut self) {
        self.directory.remove_stage(&self.name);
    }
}

#[cfg(test)]
#[path = "prepare_tests.rs"]
mod tests;
