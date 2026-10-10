//! Private, caller-owned directory. Unix operations are relative to a pinned no-follow directory fd.
//! Windows pins the directory against replacement and sets a protected user+SYSTEM DACL before writing.
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};
#[cfg(windows)]
#[path = "private_windows.rs"]
mod windows;

pub(crate) struct OwnedDirectory {
    path: PathBuf,
    handle: File,
}
fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "unsafe diagnostic storage")
}
impl OwnedDirectory {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        if !path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        {
            return Err(denied());
        }
        Self::ancestry(path)?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        #[cfg(windows)]
        {
            windows::directory_options(&mut options);
        }
        let handle = options.open(path)?;
        if !handle.metadata()?.is_dir() {
            return Err(denied());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let m = handle.metadata()?;
            if m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o022 != 0 {
                return Err(denied());
            }
            handle.set_permissions(fs::Permissions::from_mode(0o700))?;
        }
        #[cfg(windows)]
        {
            windows::require_owner(&handle)?;
            windows::restrict(&handle)?;
        }
        let dir = Self {
            path: path.to_path_buf(),
            handle,
        };
        dir.check()?;
        Ok(dir)
    }
    fn ancestry(path: &Path) -> io::Result<()> {
        for item in path.ancestors() {
            let m = fs::symlink_metadata(item)?;
            if m.file_type().is_symlink() || !m.is_dir() {
                return Err(denied());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                // Sticky system temp roots are safe: another user cannot replace our owned leaf.
                if m.mode() & 0o022 != 0 && !(m.uid() == 0 && m.mode() & 0o1000 != 0) {
                    return Err(denied());
                }
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if m.file_attributes() & 0x400 != 0 {
                    return Err(denied());
                }
            }
        }
        Ok(())
    }
    pub(crate) fn check(&self) -> io::Result<()> {
        Self::ancestry(&self.path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let path = fs::symlink_metadata(&self.path)?;
            let held = self.handle.metadata()?;
            if path.dev() != held.dev()
                || path.ino() != held.ino()
                || path.uid() != unsafe { libc::geteuid() }
                || path.mode() & 0o077 != 0
            {
                return Err(denied());
            }
        }
        #[cfg(windows)]
        {
            windows::require_private(&self.handle)?;
        }
        Ok(())
    }
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn names(&self) -> io::Result<Vec<String>> {
        self.check()?;
        let names = fs::read_dir(&self.path)?
            .filter_map(|e| e.ok().and_then(|e| e.file_name().into_string().ok()))
            .collect();
        self.check()?;
        Ok(names)
    }
    fn file(&self, name: &str, new: bool, append: bool) -> io::Result<File> {
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-._".contains(&c))
            || name == "."
            || name == ".."
        {
            return Err(denied());
        }
        self.check()?;
        #[cfg(unix)]
        let file = {
            use std::{
                ffi::CString,
                os::fd::{AsRawFd, FromRawFd},
            };
            let name = CString::new(name).map_err(|_| denied())?;
            let flags = libc::O_CLOEXEC
                | libc::O_NOFOLLOW
                | libc::O_NONBLOCK
                | if new {
                    libc::O_RDWR | libc::O_CREAT | libc::O_EXCL
                } else if append {
                    libc::O_WRONLY | libc::O_APPEND
                } else {
                    libc::O_RDONLY
                };
            // SAFETY: pinned directory handle, single validated component, valid C string.
            let fd = unsafe { libc::openat(self.handle.as_raw_fd(), name.as_ptr(), flags, 0o600) };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: successful openat transfers one owned descriptor.
            unsafe { File::from_raw_fd(fd) }
        };
        #[cfg(windows)]
        let file = {
            use std::os::windows::fs::OpenOptionsExt;
            let mut options = OpenOptions::new();
            options.read(true).write(new).append(append).create_new(new);
            options
                .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT)
                .share_mode(
                    windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ
                        | windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE
                        | windows_sys::Win32::Storage::FileSystem::FILE_SHARE_DELETE,
                );
            if new {
                options.access_mode(
                    windows_sys::Win32::Foundation::GENERIC_READ
                        | windows_sys::Win32::Foundation::GENERIC_WRITE
                        | windows_sys::Win32::Storage::FileSystem::WRITE_DAC
                        | windows_sys::Win32::Storage::FileSystem::READ_CONTROL,
                );
            }
            let file = options.open(self.path.join(name))?;
            if new {
                windows::require_owner(&file)?;
                windows::restrict(&file)?;
            }
            file
        };
        Self::validate_file(&file)?;
        self.check()?;
        Ok(file)
    }
    fn validate_file(file: &File) -> io::Result<()> {
        let m = file.metadata()?;
        if !m.is_file() {
            return Err(denied());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 || m.nlink() != 1 {
                return Err(denied());
            }
        }
        #[cfg(windows)]
        {
            windows::require_private(file)?;
        }
        Ok(())
    }
    pub(crate) fn create(&self, name: &str) -> io::Result<File> {
        self.file(name, true, false)
    }
    pub(crate) fn append(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        let mut file = self.file(name, false, true)?;
        file.write_all(bytes)?;
        file.sync_data()
    }
    pub(crate) fn read(&self, name: &str, limit: usize) -> io::Result<String> {
        let file = self.file(name, false, false)?;
        if file.metadata()?.len() > limit as u64 {
            return Err(io::Error::other("diagnostic file exceeds read budget"));
        }
        let mut text = String::new();
        file.take(limit as u64 + 1).read_to_string(&mut text)?;
        if text.len() > limit {
            return Err(io::Error::other("diagnostic file exceeds read budget"));
        }
        Ok(text)
    }
    pub(crate) fn len(&self, name: &str) -> io::Result<u64> {
        Ok(self.file(name, false, false)?.metadata()?.len())
    }
    pub(crate) fn receipt(&self, name: &str) -> io::Result<()> {
        match self.create(name) {
            Ok(mut f) => {
                f.write_all(b"PLUR1BUS desktop receipt v1\n")?;
                f.sync_all()?;
                self.sync()
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                if self.read(name, 128)? != "PLUR1BUS desktop receipt v1\n" {
                    return Err(denied());
                }
                Ok(())
            }
            Err(e) => Err(e),
        }
    }
    pub(crate) fn has_receipt(&self, name: &str) -> io::Result<bool> {
        match self.read(name, 128) {
            Ok(text) => Ok(text == "PLUR1BUS desktop receipt v1\n"),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }
    pub(crate) fn remove(&self, name: &str) -> io::Result<()> {
        drop(self.file(name, false, false)?);
        #[cfg(unix)]
        {
            use std::{ffi::CString, os::fd::AsRawFd};
            let name = CString::new(name).map_err(|_| denied())?;
            // SAFETY: single previously validated component, pinned directory descriptor.
            if unsafe { libc::unlinkat(self.handle.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        #[cfg(windows)]
        {
            fs::remove_file(self.path.join(name))?;
        }
        self.sync()
    }
    pub(crate) fn sync(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            self.handle.sync_all()?;
        }
        Ok(())
    }
}
