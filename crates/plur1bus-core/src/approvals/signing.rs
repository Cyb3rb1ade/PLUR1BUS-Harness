//! `approvals/signing.ts` (D109 §9.7): Ed25519 signatures on `approval.decided` entries. The HMAC chain stays the authority;
//! a signature is additive evidence an out-of-process verifier can check without the HMAC key.
//!
//! The signed message is the entry's MAC as bytes (`Buffer.from(mac, "hex")`); the stored public key is the base64 of its
//! DER SubjectPublicKeyInfo and the signature the base64 of its 64 bytes, both read the way Node reads base64
//! ([`super::node_codec`]). Ed25519 itself is `ring`'s; nothing here is cryptography of its own, only the fixed DER framing
//! RFC 8410 gives an Ed25519 key.
use super::keys::{KeyError, SigningKeySource, PKCS8_V1_PREFIX};
use super::node_codec::{base64_decode, hex_decode};
use base64::Engine;
use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};

/// The DER head of an Ed25519 SubjectPublicKeyInfo (RFC 8410): the 32-byte public key follows.
pub const SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// The one algorithm name the store writes.
pub const ALG: &str = "Ed25519";

/// One signature as the store keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signature {
    /// Base64 of the signer's DER SubjectPublicKeyInfo.
    pub public_key: String,
    /// Base64 of the 64 signature bytes.
    pub signature: String,
    /// Always [`ALG`].
    pub alg: &'static str,
}

/// `DecisionSigner`: the identity that signs decisions (the port; tests inject one).
pub trait DecisionSigner {
    /// Base64 of its DER SubjectPublicKeyInfo.
    fn public_key(&self) -> &str;
    /// Signs `Buffer.from(mac, "hex")`.
    fn sign(&self, mac: &str) -> Signature;
}

/// The 32 key bytes of a DER SubjectPublicKeyInfo, when it is an Ed25519 one (`createPublicKey` + `asymmetricKeyType`).
/// The DER object is read on its own; bytes after it are not looked at, as OpenSSL's `d2i` leaves them.
pub fn spki_ed25519(der: &[u8]) -> Option<&[u8]> {
    let rest = der.strip_prefix(&SPKI_PREFIX[..])?;
    rest.get(..32)
}

/// `verifyDecisionSignature(mac, publicKey, signature)`: `false` for anything that is not a valid Ed25519 signature by an
/// Ed25519 key over the MAC's bytes; never an error.
pub fn verify_decision_signature(mac: &str, public_key: &str, signature: &str) -> bool {
    let der = base64_decode(public_key);
    let Some(raw) = spki_ed25519(&der) else {
        return false;
    };
    UnparsedPublicKey::new(&ED25519, raw)
        .verify(&hex_decode(mac), &base64_decode(signature))
        .is_ok()
}

/// An Ed25519 identity from its PKCS #8 DER.
pub struct Ed25519Signer {
    pair: Ed25519KeyPair,
    public_key: String,
}

impl std::fmt::Debug for Ed25519Signer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The key pair is never printed.
        f.debug_struct("Ed25519Signer")
            .field("public_key", &self.public_key)
            .finish_non_exhaustive()
    }
}

impl Ed25519Signer {
    /// `signerFromPkcs8`: v1 (the seed alone, what Node exports) and v2 (with the public key) are read; anything else, an
    /// RSA key included, is `corrupt`.
    pub fn from_pkcs8(der: &[u8]) -> Result<Self, KeyError> {
        let corrupt = || KeyError::Corrupt("approval signing identity is invalid".to_owned());
        // The DER object is read on its own: bytes after it are left alone, as OpenSSL's `d2i` leaves them.
        let pair = match der.strip_prefix(&PKCS8_V1_PREFIX[..]) {
            Some(seed) if seed.len() >= 32 => Ed25519KeyPair::from_seed_unchecked(&seed[..32]),
            _ => Ed25519KeyPair::from_pkcs8_maybe_unchecked(der),
        }
        .map_err(|_| corrupt())?;
        let mut spki = SPKI_PREFIX.to_vec();
        spki.extend_from_slice(pair.public_key().as_ref());
        let public_key = base64::engine::general_purpose::STANDARD.encode(spki);
        Ok(Ed25519Signer { pair, public_key })
    }

    /// `loadDecisionSigner(src)`.
    pub fn load(src: &dyn SigningKeySource) -> Result<Self, KeyError> {
        Self::from_pkcs8(&src.load()?)
    }
}

impl DecisionSigner for Ed25519Signer {
    fn public_key(&self) -> &str {
        &self.public_key
    }
    fn sign(&self, mac: &str) -> Signature {
        let sig = self.pair.sign(&hex_decode(mac));
        Signature {
            public_key: self.public_key.clone(),
            signature: base64::engine::general_purpose::STANDARD.encode(sig.as_ref()),
            alg: ALG,
        }
    }
}
