//! Threshold verification of raw Ed25519 catalogue envelopes.

use std::collections::HashSet;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, SecondsFormat, Utc};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use serde_json::Number;

const MAX_KEYS: usize = 64;
const MAX_SIGNED_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const SAFE_INT: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    KeyRevoked,
    KeyUnknown,
    SignatureInvalid,
    StaleIndex,
}

impl Error {
    pub const fn code(self) -> &'static str {
        match self {
            Self::KeyRevoked => "key_revoked",
            Self::KeyUnknown => "key_unknown",
            Self::SignatureInvalid => "signature_invalid",
            Self::StaleIndex => "stale_index",
        }
    }
}

type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyFile {
    id: String,
    public_key: String,
    expires: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct RootFile {
    #[serde(rename = "type")]
    kind: String,
    version: Number,
    threshold: Option<Number>,
    expires: String,
    keys: Vec<KeyFile>,
}

struct Key {
    public_key: [u8; 32],
    expires: i64,
}

pub struct Root {
    pub version: u64,
    threshold: usize,
    expires: i64,
    keys: Vec<(String, Key)>,
    normalized: Vec<u8>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Signature {
    key_id: String,
    signature: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Envelope {
    payload: String,
    signatures: Vec<Signature>,
}

impl Envelope {
    pub(crate) fn bytes(&self) -> Result<Vec<u8>> {
        decode(&self.payload, MAX_SIGNED_BYTES)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ignored<'a> {
    key_id: &'a str,
    code: &'static str,
}

pub struct Verified<'a> {
    bytes: Vec<u8>,
    signers: Vec<&'a str>,
    ignored: Vec<Ignored<'a>>,
}

impl<'a> Verified<'a> {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn signers(&self) -> &[&'a str] {
        &self.signers
    }

    pub fn ignored(&self) -> &[Ignored<'a>] {
        &self.ignored
    }
}

pub(crate) fn safe_integer(value: &Number, min: u64) -> Option<u64> {
    let n = value.as_f64()?;
    (n.fract() == 0.0 && (min as f64..=SAFE_INT as f64).contains(&n)).then_some(n as u64)
}

pub(crate) fn timestamp(raw: &str) -> Result<i64> {
    let Some(prefix) = raw.get(..19) else {
        return Err(Error::SignatureInvalid);
    };
    if raw.get(17..19).is_none_or(|seconds| seconds >= "60") {
        return Err(Error::SignatureInvalid);
    }
    let canonical = match raw.len() {
        20 if raw.ends_with('Z') => format!("{prefix}.000Z"),
        24 if raw.ends_with('Z') => raw.into(),
        _ => return Err(Error::SignatureInvalid),
    };
    let parsed = DateTime::parse_from_rfc3339(raw).map_err(|_| Error::SignatureInvalid)?;
    if parsed
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
        != canonical
    {
        return Err(Error::SignatureInvalid);
    }
    Ok(parsed.timestamp_millis())
}

fn decode(raw: &str, limit: usize) -> Result<Vec<u8>> {
    if raw.is_empty() || raw.len() > limit.div_ceil(3) * 4 {
        return Err(Error::SignatureInvalid);
    }
    let decoded = STANDARD.decode(raw).map_err(|_| Error::SignatureInvalid)?;
    if decoded.len() > limit || STANDARD.encode(&decoded) != raw {
        return Err(Error::SignatureInvalid);
    }
    Ok(decoded)
}

impl Root {
    pub fn parse(json: &str) -> Result<Self> {
        if json.len() > MAX_SIGNED_BYTES {
            return Err(Error::SignatureInvalid);
        }
        let mut root: RootFile = serde_json::from_str(json).map_err(|_| Error::SignatureInvalid)?;
        let version = safe_integer(&root.version, 1).ok_or(Error::SignatureInvalid)?;
        let threshold = root
            .threshold
            .as_ref()
            .map_or(Some(1), |n| safe_integer(n, 1))
            .ok_or(Error::SignatureInvalid)?;
        if root.kind != "root" || root.keys.len() > MAX_KEYS {
            return Err(Error::SignatureInvalid);
        }
        if root.keys.is_empty() {
            return Err(Error::KeyUnknown);
        }
        if threshold > root.keys.len() as u64 {
            return Err(Error::SignatureInvalid);
        }
        root.version = version.into();
        root.threshold = Some(threshold.into());
        let normalized = serde_json::to_vec(&root).map_err(|_| Error::SignatureInvalid)?;
        let mut keys = Vec::with_capacity(root.keys.len());
        let mut ids = HashSet::new();
        let mut public_keys = HashSet::new();
        for key in root.keys {
            let public_key: [u8; 32] = decode(&key.public_key, 32)?
                .try_into()
                .map_err(|_| Error::SignatureInvalid)?;
            if key.id.is_empty() || !ids.insert(key.id.clone()) || !public_keys.insert(public_key) {
                return Err(Error::SignatureInvalid);
            }
            keys.push((
                key.id,
                Key {
                    public_key,
                    expires: timestamp(&key.expires)?,
                },
            ));
        }
        Ok(Self {
            version,
            threshold: threshold as usize,
            expires: timestamp(&root.expires)?,
            keys,
            normalized,
        })
    }

    /// Authenticate the original bytes. Missing, expired and invalid signatures
    /// are counted separately from valid signers; a revoked signer rejects the envelope.
    pub fn verify<'a>(
        &self,
        signed: &'a Envelope,
        now: i64,
        revoked: &HashSet<&str>,
    ) -> Result<Verified<'a>> {
        self.verify_at(signed, now, revoked, false)
    }

    pub(crate) fn normalized(&self) -> &[u8] {
        &self.normalized
    }

    pub(crate) fn expires(&self) -> i64 {
        self.expires
    }

    fn key(&self, id: &str) -> Option<&Key> {
        self.keys
            .iter()
            .find(|(name, _)| name == id)
            .map(|(_, key)| key)
    }

    pub(crate) fn material(&self, id: &str) -> Option<String> {
        self.key(id).map(|key| STANDARD.encode(key.public_key))
    }

    pub(crate) fn materials(&self) -> impl Iterator<Item = (&str, String)> {
        self.keys
            .iter()
            .map(|(id, key)| (id.as_str(), STANDARD.encode(key.public_key)))
    }

    pub(crate) fn verify_at<'a>(
        &self,
        signed: &'a Envelope,
        now: i64,
        revoked: &HashSet<&str>,
        historical: bool,
    ) -> Result<Verified<'a>> {
        if signed.signatures.len() > MAX_KEYS {
            return Err(Error::SignatureInvalid);
        }
        let bytes = signed.bytes()?;
        if !historical && self.expires <= now {
            return Err(Error::StaleIndex);
        }
        let mut seen = HashSet::new();
        let mut signers = Vec::new();
        let mut ignored = Vec::new();
        let mut first_error = None;
        for signature in &signed.signatures {
            let id = signature.key_id.as_str();
            let result = match self.key(id) {
                None => Err(Error::KeyUnknown),
                Some(_) if revoked.contains(id) => return Err(Error::KeyRevoked),
                Some(key) if !historical && key.expires <= now => Err(Error::SignatureInvalid),
                Some(key) => decode(&signature.signature, 64).and_then(|value| {
                    UnparsedPublicKey::new(&ED25519, key.public_key)
                        .verify(&bytes, &value)
                        .map_err(|_| Error::SignatureInvalid)
                }),
            };
            match result {
                Ok(()) if seen.insert(id) => signers.push(id),
                Ok(()) => {}
                Err(error) => {
                    first_error.get_or_insert(error);
                    ignored.push(Ignored {
                        key_id: id,
                        code: error.code(),
                    });
                }
            }
        }
        if signers.len() < self.threshold {
            return Err(first_error.unwrap_or(Error::SignatureInvalid));
        }
        Ok(Verified {
            bytes,
            signers,
            ignored,
        })
    }
}
