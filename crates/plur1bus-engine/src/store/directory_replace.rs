//! Rename an already-synced private sibling under a held directory and cooperating writer lease.
use super::{io_error, regular_file_identity, valid_child, TrustedDirectory};
use crate::contract::StoreError;

impl TrustedDirectory {
    /// Replace one ordinary child with an already synced staging file, checking both identities.
    /// Unix renameat cannot be redirected by ancestor substitution. This is not CAS against
    /// noncooperating writers; the caller must retain its kernel lease and verify exact old bytes.
    pub(crate) fn replace_staged(
        &self,
        source: &str,
        target: &str,
        source_identity: (u64, u64),
        target_identity: Option<(u64, u64)>,
    ) -> Result<(), StoreError> {
        valid_child(source)?;
        valid_child(target)?;
        if source == target {
            return Err(StoreError::InvalidInput);
        }
        self.assert_unchanged()?;
        if regular_file_identity(&self.open_file(source)?)? != source_identity {
            return Err(StoreError::UntrustedPath);
        }
        let current = match self.open_file(target) {
            Ok(file) => Some(regular_file_identity(&file)?),
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => None,
            Err(error) => return Err(error),
        };
        if current != target_identity {
            return Err(StoreError::UntrustedPath);
        }
        self.assert_unchanged()?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let source = std::ffi::CString::new(source).map_err(|_| StoreError::InvalidInput)?;
            let target = std::ffi::CString::new(target).map_err(|_| StoreError::InvalidInput)?;
            // SAFETY: the held directory fd and both validated single-component names are live.
            if unsafe {
                libc::renameat(
                    self.anchor.as_raw_fd(),
                    source.as_ptr(),
                    self.anchor.as_raw_fd(),
                    target.as_ptr(),
                )
            } != 0
            {
                return Err(io_error(std::io::Error::last_os_error()));
            }
        }
        #[cfg(windows)]
        super::super::atomic_write::rename_with_retry(
            &self.physical.join(source),
            &self.physical.join(target),
        )
        .map_err(io_error)?;
        self.sync_entries()?;
        if regular_file_identity(&self.open_file(target)?)? != source_identity {
            return Err(StoreError::UntrustedPath);
        }
        self.assert_unchanged()
    }
}
