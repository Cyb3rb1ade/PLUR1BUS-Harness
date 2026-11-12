//! Kernel-held state-writer leases: no stale timeout, nonce takeover or unlink race.
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::directory::TrustedDirectory,
};
use std::{
    fs::{File, TryLockError},
    time::Duration,
};

pub(crate) struct KernelLease {
    file: File,
    name: String,
}
impl KernelLease {
    pub(crate) fn check(&self, directory: &TrustedDirectory) -> Result<(), StoreError> {
        let current = directory.open_file(&self.name)?;
        if identity(&current)? != identity(&self.file)? {
            return Err(StoreError::UntrustedPath);
        }
        Ok(())
    }
}
fn lease_file(directory: &TrustedDirectory, name: &str) -> Result<File, StoreError> {
    match directory.create_file(name) {
        Ok(file) => Ok(file),
        Err(StoreError::Io {
            kind: std::io::ErrorKind::AlreadyExists,
        }) => directory.open_file(name),
        Err(e) => Err(e),
    }
}
/// One attempt without waiting: `None` while another holder has the lease.
pub(crate) fn try_acquire(
    directory: &TrustedDirectory,
    name: &str,
) -> Result<Option<KernelLease>, StoreError> {
    let name = format!("{name}.lock");
    let file = lease_file(directory, &name)?;
    directory.assert_unchanged()?;
    match file.try_lock() {
        Ok(()) => {
            let lease = KernelLease { file, name };
            lease.check(directory)?;
            Ok(Some(lease))
        }
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(e)) => Err(StoreError::from(e)),
    }
}
pub(crate) fn acquire(
    directory: &TrustedDirectory,
    name: &str,
    cancel: &Cancel,
    waiting: &mut dyn FnMut(),
) -> Result<KernelLease, EngineError> {
    cancel.check()?;
    let name = format!("{name}.lock");
    let file = lease_file(directory, &name)?;
    loop {
        cancel.check()?;
        directory.assert_unchanged()?;
        match file.try_lock() {
            Ok(()) => {
                let lease = KernelLease { file, name };
                lease.check(directory)?;
                return Ok(lease);
            }
            Err(TryLockError::WouldBlock) => {
                waiting();
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(TryLockError::Error(e)) => return Err(StoreError::from(e).into()),
        }
    }
}

#[cfg(unix)]
fn identity(file: &File) -> Result<(u64, u64), StoreError> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata().map_err(StoreError::from)?;
    if !meta.is_file() || meta.nlink() != 1 {
        return Err(StoreError::UntrustedPath);
    }
    Ok((meta.dev(), meta.ino()))
}

#[cfg(windows)]
fn identity(file: &File) -> Result<(u64, u64), StoreError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    // SAFETY: the POD is initialized as an output buffer for the live File handle.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: File owns the handle and info is valid writable output storage.
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
