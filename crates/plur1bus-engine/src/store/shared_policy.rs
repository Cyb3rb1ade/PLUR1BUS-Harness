//! Owner checks for shared destinations; never repair an existing root's permissions.
use crate::contract::StoreError;
use std::path::Path;

pub(super) fn verify(path: &Path, private: bool) -> Result<(), StoreError> {
    super::paths::assert_trusted_path(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::symlink_metadata(path)?;
        // SAFETY: geteuid reads the current process identity without arguments.
        let uid = unsafe { libc::geteuid() };
        let forbidden = if private { 0o077 } else { 0o022 };
        if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & forbidden != 0 {
            return Err(StoreError::UntrustedPath);
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        let user = plur1bus_rpc::win::user_sid()?;
        if !owner_sid(path)?.eq_ignore_ascii_case(&user) {
            return Err(StoreError::UntrustedPath);
        }
        let entries = plur1bus_rpc::win::file_dacl_report_strict(path)?;
        let unsafe_acl = if private {
            entries.iter().any(|ace| {
                ace.allow
                    && ![user.as_str(), "S-1-5-18", "S-1-5-32-544"]
                        .iter()
                        .any(|sid| ace.sid.eq_ignore_ascii_case(sid))
            })
        } else {
            !plur1bus_rpc::acl::run_writable_by_others(&entries, &user).is_empty()
        };
        if unsafe_acl {
            return Err(StoreError::UntrustedPath);
        }
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = private;
        Err(StoreError::Unavailable)
    }
}

#[cfg(windows)]
fn owner_sid(path: &Path) -> Result<String, StoreError> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{ConvertSidToStringSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT},
            OWNER_SECURITY_INFORMATION,
        },
    };
    struct Local(*mut c_void);
    impl Drop for Local {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: each pointer was allocated by the security API with LocalAlloc.
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    if wide[..wide.len() - 1].contains(&0) {
        return Err(StoreError::UntrustedPath);
    }
    let mut owner = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    // SAFETY: the path is terminated, output pointers are valid; owner lives inside descriptor.
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    let _descriptor = Local(descriptor);
    if status != 0 || owner.is_null() {
        return Err(StoreError::UntrustedPath);
    }
    let mut text = ptr::null_mut();
    // SAFETY: owner is the live SID returned by the successful descriptor lookup.
    if unsafe { ConvertSidToStringSidW(owner, &mut text) } == 0 {
        return Err(StoreError::UntrustedPath);
    }
    let _text = Local(text.cast());
    let mut length = 0;
    // SAFETY: ConvertSidToStringSidW guarantees a NUL-terminated allocated UTF-16 string.
    while unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    // SAFETY: the loop found the exact allocated string length while _text retains ownership.
    String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
        .map_err(|_| StoreError::UntrustedPath)
}
