//! `approvals/keys.ts`: the per-installation HMAC key of the chain and the Ed25519 identity that signs decisions. Both live in
//! the secret store (ADR-005), never on disk in the clear, and reach the chain through a source the caller injects: tests a
//! fixed key, the core the secret store. The secret store itself is a port here ([`SecretSlot`]); no test reaches a keyring.
//!
//! A stored value that is not a valid key is `corrupt` and is never replaced: replacing the chain key would orphan every
//! existing entry, replacing the signing key would make every signature unverifiable. A missing value is created once
//! (32 random bytes; a fresh Ed25519 identity as PKCS #8 v1, the form Node's `generateKeyPairSync` exports) and read back.
use super::node_codec::base64_decode;
use base64::Engine;
use std::fmt;
use zeroize::Zeroizing;

/// `MIN_KEY_BYTES`.
pub const MIN_KEY_BYTES: usize = 32;
/// `CHAIN_KEY_SECRET_NAME`.
pub const CHAIN_KEY_SECRET_NAME: &str = "approvals.chain-key.v1";
/// `SIGNING_KEY_SECRET_NAME`: PKCS #8 DER (base64) of the Ed25519 identity that signs `approval.decided` entries.
pub const SIGNING_KEY_SECRET_NAME: &str = "approvals.signing-key.v1";

/// The fixed DER head of an Ed25519 PKCS #8 v1 key (RFC 8410): the 32-byte seed follows.
pub const PKCS8_V1_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/// Why a key could not be had. The messages name the secret, never its value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyError {
    /// `SecretError("corrupt")`: the stored value is not a key of the expected kind (never replaced).
    Corrupt(String),
    /// A key shorter than [`MIN_KEY_BYTES`] was handed to the chain (`RangeError`).
    TooShort,
    /// The secret store refused or failed (its own message, which carries no secret value).
    Store(String),
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeyError::Corrupt(m) | KeyError::Store(m) => f.write_str(m),
            KeyError::TooShort => write!(
                f,
                "approval chain key must be at least {MIN_KEY_BYTES} bytes"
            ),
        }
    }
}

impl std::error::Error for KeyError {}

/// The chain key in memory (zeroed when dropped).
pub type ChainKey = Zeroizing<Vec<u8>>;

/// `assertKey`: at least [`MIN_KEY_BYTES`].
pub fn assert_key(key: &[u8]) -> Result<(), KeyError> {
    if key.len() < MIN_KEY_BYTES {
        return Err(KeyError::TooShort);
    }
    Ok(())
}

/// `ChainKeySource`: the key bytes, asked once when a store opens; the key is then held in memory only.
pub trait ChainKeySource {
    /// The key.
    fn load(&self) -> Result<ChainKey, KeyError>;
}

/// `SigningKeySource`: the PKCS #8 DER bytes of the signing identity, asked once when a store opens.
pub trait SigningKeySource {
    /// The DER bytes.
    fn load(&self) -> Result<ChainKey, KeyError>;
}

/// `staticKeySource`: a fixed key (tests, and a host that has the key already).
pub struct StaticKeySource(ChainKey);

impl StaticKeySource {
    /// Copies `key` after checking its length.
    pub fn new(key: &[u8]) -> Result<Self, KeyError> {
        assert_key(key)?;
        Ok(StaticKeySource(Zeroizing::new(key.to_vec())))
    }
}

impl ChainKeySource for StaticKeySource {
    fn load(&self) -> Result<ChainKey, KeyError> {
        Ok(Zeroizing::new(self.0.to_vec()))
    }
}

/// The part of the secret store the key sources use (the port of `SecretStore.lease`/`set` for one name). The core reads
/// as `core` and creates as owner `core`; which principal that is, and the lease with its purpose and TTL, are the host's.
pub trait SecretSlot {
    /// The stored value (base64 text), or `None` when the secret does not exist (`SecretError("not-found")`).
    fn read(&self, name: &str) -> Result<Option<Zeroizing<String>>, KeyError>;
    /// Stores `value` under `name` (first use only).
    fn create(&self, name: &str, value: &str) -> Result<(), KeyError>;
}

fn fresh(bytes: usize) -> Result<Zeroizing<Vec<u8>>, KeyError> {
    let mut out = Zeroizing::new(vec![0u8; bytes]);
    getrandom::fill(&mut out)
        .map_err(|_| KeyError::Store("the random source failed".to_owned()))?;
    Ok(out)
}

fn read_or_create(
    slot: &dyn SecretSlot,
    name: &str,
    min: usize,
    what: &str,
    make: impl FnOnce() -> Result<Zeroizing<Vec<u8>>, KeyError>,
) -> Result<ChainKey, KeyError> {
    let read = |slot: &dyn SecretSlot| -> Result<Option<ChainKey>, KeyError> {
        let Some(text) = slot.read(name)? else {
            return Ok(None);
        };
        let bytes = Zeroizing::new(base64_decode(&text));
        if bytes.len() < min {
            return Err(KeyError::Corrupt(format!(
                "secret {name} is corrupt: {what}"
            )));
        }
        Ok(Some(bytes))
    };
    if let Some(key) = read(slot)? {
        return Ok(key);
    }
    let made = make()?;
    let text = Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(made.as_slice()));
    slot.create(name, &text)?;
    read(slot)?
        .ok_or_else(|| KeyError::Store(format!("secret {name} is missing after it was created")))
}

/// `secretStoreKeySource`: the chain key from the secret store, created (32 random bytes) on first use. Creation assumes one
/// core process (the core lock), as in TypeScript.
pub struct SecretChainKey<'a> {
    /// The secret store.
    pub slot: &'a dyn SecretSlot,
    /// The secret's name ([`CHAIN_KEY_SECRET_NAME`] by default).
    pub name: &'a str,
}

impl ChainKeySource for SecretChainKey<'_> {
    fn load(&self) -> Result<ChainKey, KeyError> {
        let what = format!("not a {MIN_KEY_BYTES}-byte key");
        read_or_create(self.slot, self.name, MIN_KEY_BYTES, &what, || {
            fresh(MIN_KEY_BYTES)
        })
    }
}

/// `secretStoreSigningKeySource`: the signing identity from the secret store, created on first use as PKCS #8 v1 DER. Fewer
/// than 16 bytes is corrupt here; anything else that is not an Ed25519 key is corrupt when the signer is built from it.
pub struct SecretSigningKey<'a> {
    /// The secret store.
    pub slot: &'a dyn SecretSlot,
    /// The secret's name ([`SIGNING_KEY_SECRET_NAME`] by default).
    pub name: &'a str,
}

/// A fresh Ed25519 identity as PKCS #8 v1 DER (the prefix and 32 random seed bytes).
pub fn fresh_pkcs8() -> Result<Zeroizing<Vec<u8>>, KeyError> {
    let seed = fresh(32)?;
    let mut der = Zeroizing::new(PKCS8_V1_PREFIX.to_vec());
    der.extend_from_slice(&seed);
    Ok(der)
}

impl SigningKeySource for SecretSigningKey<'_> {
    fn load(&self) -> Result<ChainKey, KeyError> {
        read_or_create(
            self.slot,
            self.name,
            16,
            "not an Ed25519 PKCS8 key",
            fresh_pkcs8,
        )
    }
}
