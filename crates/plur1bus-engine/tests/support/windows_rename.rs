//! Exercise the same directory rename with a live engine handle on every platform.

use std::path::Path;

#[allow(
    clippy::unwrap_used,
    reason = "an unexpected fixture rename failure is a test failure"
)]
pub(super) fn attempt(source: &Path, destination: &Path) -> bool {
    #[cfg(windows)]
    let original = (directory_id(source), directory_entries(source));
    let result = std::fs::rename(source, destination);
    #[cfg(windows)]
    if let Err(error) = &result {
        use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION};

        assert!(
            error.raw_os_error().is_some_and(|code| {
                code == ERROR_ACCESS_DENIED as i32 || code == ERROR_SHARING_VIOLATION as i32
            }),
            "unexpected directory rename error: {error}"
        );
        assert_eq!((directory_id(source), directory_entries(source)), original);
        assert_eq!(
            std::fs::symlink_metadata(destination).unwrap_err().kind(),
            std::io::ErrorKind::NotFound,
            "the attempted move must not populate its destination"
        );
        return false;
    }
    result.unwrap();
    true
}

#[cfg(windows)]
#[allow(
    clippy::unwrap_used,
    reason = "the original fixture must remain readable"
)]
fn directory_entries(path: &Path) -> Vec<std::ffi::OsString> {
    let mut entries: Vec<_> = std::fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    entries.sort();
    entries
}

#[cfg(windows)]
#[allow(
    clippy::unwrap_used,
    reason = "identity is part of the fixture assertion"
)]
fn directory_id(path: &Path) -> (u32, u32, u32) {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_READ_ATTRIBUTES,
    };

    let dir = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .unwrap();
    // SAFETY: an initialized output and its live directory handle exist for the call.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    assert_ne!(
        unsafe { GetFileInformationByHandle(dir.as_raw_handle().cast(), &mut info) },
        0
    );
    (
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    )
    // The fixture owns no directory handle at the moment rename is attempted.
}
