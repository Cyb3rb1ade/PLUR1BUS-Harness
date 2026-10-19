//! Owner 2026-10-18: RSA authenticates through an agent in v1. Check the public
//! algorithm before requesting a passphrase/decrypting a selected key file.
use russh::keys::Algorithm;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirectRsaUnsupported;

impl DirectRsaUnsupported {
    pub const fn reason(self) -> &'static str {
        "rsa-direct-unsupported"
    }
}
impl std::fmt::Display for DirectRsaUnsupported {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}: Lade den Key in deinen SSH-Agent oder erzeuge einen ed25519-Key.",
            self.reason()
        )
    }
}
impl std::error::Error for DirectRsaUnsupported {}

pub fn validate(algorithm: &Algorithm) -> Result<(), DirectRsaUnsupported> {
    if matches!(algorithm, Algorithm::Rsa { .. }) {
        Err(DirectRsaUnsupported)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::{ssh_key::EcdsaCurve, HashAlg};

    #[test]
    fn direct_rsa_is_refused_with_stable_reason_and_actionable_hint() {
        for hash in [None, Some(HashAlg::Sha256), Some(HashAlg::Sha512)] {
            let error = validate(&Algorithm::Rsa { hash }).unwrap_err();
            assert_eq!(error.reason(), "rsa-direct-unsupported");
            assert_eq!(error.to_string(), "rsa-direct-unsupported: Lade den Key in deinen SSH-Agent oder erzeuge einen ed25519-Key.");
        }
    }

    #[test]
    fn ed25519_and_ecdsa_file_auth_remain_supported() {
        assert!(validate(&Algorithm::Ed25519).is_ok());
        assert!(validate(&Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP256
        })
        .is_ok());
    }
}
