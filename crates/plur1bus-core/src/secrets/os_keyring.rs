//! The operating system's keyring behind [`Keyring`].
//!
//! This build has none yet: every entry is refused, so a keyring backend over it probes `keyring-unavailable` and answers
//! `backend-unavailable`, and the store uses the file backend where the owner allowed that. The adapters for the macOS
//! Keychain, the Windows Credential Manager and the Secret Service replace [`os_keyring`]'s body in a change of their own;
//! nothing else has to move.
use super::keyring_backend::{Keyring, KeyringEntry, KeyringFailure};

/// A keyring that is not there.
pub struct NoKeyring;

impl Keyring for NoKeyring {
    fn entry(
        &self,
        _service: &str,
        _account: &str,
    ) -> Result<Box<dyn KeyringEntry>, KeyringFailure> {
        Err(KeyringFailure::default())
    }
}

/// The keyring of this operating system.
pub fn os_keyring() -> Box<dyn Keyring> {
    Box::new(NoKeyring)
}
