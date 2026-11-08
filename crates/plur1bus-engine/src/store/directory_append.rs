//! Directory-relative durable JSONL writes for the principal-bound Neo writer.
use super::{directory_open_error, valid_child, TrustedDirectory};
use crate::{
    contract::StoreError,
    text::json::{write_json, TolerantJsonValue as Json},
};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
};

impl TrustedDirectory {
    /// Drop only an incomplete final JSONL record under the caller's writer lease. Both lengths
    /// come from a bounded, validated read of this same file; complete malformed lines are errors.
    pub(crate) fn truncate_jsonl_tail(
        &self,
        name: &str,
        expected: u64,
        committed: u64,
    ) -> Result<(), StoreError> {
        if committed >= expected {
            return Err(StoreError::InvalidInput);
        }
        let mut file = AppendFile::open(self, name)?;
        if file.file.metadata()?.len() != expected {
            return Err(StoreError::Unavailable);
        }
        if committed > 0 {
            file.file.seek(SeekFrom::Start(committed - 1))?;
            let mut last = [0];
            file.file.read_exact(&mut last)?;
            if last[0] != b'\n' {
                return Err(StoreError::InvalidInput);
            }
        }
        file.check()?;
        file.file.set_len(committed)?;
        file.file.sync_all()?;
        file.check()
    }
    /// Append one bounded ordered JSON record through this held directory and sync its file.
    /// The caller must hold the workspace writer lease and authorize the record first. This
    /// method supplies path integrity, not authorization or multi-record transaction semantics.
    /// A torn tail is closed before the new line. New files are private on Unix. The directory
    /// is also synced on Unix; Windows uses the existing private-parent policy and file sync.
    /// A failure after writing may have persisted bytes: callers must recover through their WAL.
    pub fn append_jsonl_durable(
        &self,
        name: &str,
        record: &Json,
        max_bytes: usize,
    ) -> Result<(), StoreError> {
        valid_child(name)?;
        let line = write_json(record);
        // Include both framing bytes even when this file does not need a torn-tail separator.
        if line
            .len()
            .checked_add(2)
            .is_none_or(|size| size > max_bytes)
        {
            return Err(StoreError::InvalidInput);
        }
        AppendFile::open(self, name)?.append(line.as_bytes())
    }
}

pub(super) struct AppendFile<'a> {
    directory: &'a TrustedDirectory,
    name: &'a str,
    file: File,
    identity: (u64, u64),
}
impl<'a> AppendFile<'a> {
    pub(super) fn open(directory: &'a TrustedDirectory, name: &'a str) -> Result<Self, StoreError> {
        valid_child(name)?;
        directory.assert_unchanged()?;
        let file = open_child(directory, name)?;
        let identity = identity(&file)?;
        let out = Self {
            directory,
            name,
            file,
            identity,
        };
        out.check()?;
        Ok(out)
    }
    fn check(&self) -> Result<(), StoreError> {
        self.directory.assert_unchanged()?;
        let current = self.directory.open_file(self.name)?;
        if identity(&current)? != self.identity || identity(&self.file)? != self.identity {
            return Err(StoreError::UntrustedPath);
        }
        Ok(())
    }
    pub(super) fn append(&mut self, line: &[u8]) -> Result<(), StoreError> {
        self.check()?;
        let mut record = Vec::with_capacity(line.len() + 2);
        if self.file.metadata()?.len() > 0 {
            self.file.seek(SeekFrom::End(-1))?;
            let mut last = [0];
            self.file.read_exact(&mut last)?;
            if last[0] != b'\n' {
                record.push(b'\n');
            }
        }
        record.extend_from_slice(line);
        record.push(b'\n');
        self.check()?;
        self.file.write_all(&record)?;
        self.file.sync_all()?;
        #[cfg(unix)]
        self.directory.anchor.sync_all()?;
        self.check()
    }
}

#[cfg(unix)]
fn open_child(directory: &TrustedDirectory, name: &str) -> Result<File, StoreError> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let name = std::ffi::CString::new(name).map_err(|_| StoreError::InvalidInput)?;
    // SAFETY: both the held directory descriptor and NUL-terminated child name are live.
    // NONBLOCK refuses to hang on a substituted FIFO; identity() then rejects special files.
    let fd = unsafe {
        libc::openat(
            directory.anchor.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDWR
                | libc::O_APPEND
                | libc::O_CREAT
                | libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | libc::O_NONBLOCK,
            0o600,
        )
    };
    if fd < 0 {
        return Err(directory_open_error(std::io::Error::last_os_error()));
    }
    // SAFETY: openat returned a newly owned file descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}
#[cfg(windows)]
fn open_child(directory: &TrustedDirectory, name: &str) -> Result<File, StoreError> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
    };
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .append(true)
        .create(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(directory.path().join(name))
        .map_err(directory_open_error)?;
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(StoreError::UntrustedPath);
    }
    Ok(file)
}
#[cfg(unix)]
pub(crate) fn identity(file: &File) -> Result<(u64, u64), StoreError> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(StoreError::UntrustedPath);
    }
    Ok((metadata.dev(), metadata.ino()))
}
#[cfg(windows)]
pub(crate) fn identity(file: &File) -> Result<(u64, u64), StoreError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    if !file.metadata()?.is_file() {
        return Err(StoreError::UntrustedPath);
    }
    // SAFETY: this POD is initialized for an output-only Windows API parameter.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: File owns its live handle and info is a valid writable output buffer.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if info.nNumberOfLinks != 1 {
        return Err(StoreError::UntrustedPath);
    }
    Ok((
        u64::from(info.dwVolumeSerialNumber),
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    ))
}
