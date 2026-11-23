//! Pin and verify a peer's A2A 1.0 card without a peer-supplied key lookup.
mod schema;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

pub const MAX_CARD_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    InvalidKey,
    CardSignature,
}

impl Error {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidKey => "invalid-key",
            Self::CardSignature => "card-signature",
        }
    }
}

type Check<T> = Result<T, Error>;

pub struct PublicKey {
    bytes: [u8; 32],
    fingerprint: String,
}

impl PublicKey {
    pub fn parse(value: &Value) -> Check<Self> {
        let fields = value.as_object().ok_or(Error::InvalidKey)?;
        if fields.len() != 3 || value["kty"] != "OKP" || value["crv"] != "Ed25519" {
            return Err(Error::InvalidKey);
        }
        let encoded = value["x"].as_str().ok_or(Error::InvalidKey)?;
        let bytes = decode::<32>(encoded).ok_or(Error::InvalidKey)?;
        let json =
            plur1bus_canon::canonical_json(&json!({"crv":"Ed25519","kty":"OKP","x":encoded}));
        let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(json));
        Ok(Self {
            bytes,
            fingerprint: format!("sha256:{digest}"),
        })
    }

    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct Verified {
    pub endpoint: Url,
    pub fingerprint: String,
    pub kid: String,
}

fn decode<const SIZE: usize>(raw: &str) -> Option<[u8; SIZE]> {
    if raw.len() != (SIZE * 4).div_ceil(3) {
        return None;
    }
    let mut out = [0u8; SIZE];
    let count = URL_SAFE_NO_PAD.decode_slice(raw, &mut out).ok()?;
    (count == SIZE).then_some(out)
}

pub(crate) fn valid_tree(value: &Value, depth: usize, nodes: &mut usize) -> bool {
    *nodes += 1;
    if *nodes > 8192 || depth > 16 {
        return false;
    }
    match value {
        Value::Object(fields) => {
            fields.len() <= 128
                && fields.iter().all(|(key, val)| {
                    !matches!(key.as_str(), "__proto__" | "prototype" | "constructor")
                        && valid_tree(val, depth + 1, nodes)
                })
        }
        Value::Array(items) => {
            items.len() <= 256 && items.iter().all(|val| valid_tree(val, depth + 1, nodes))
        }
        _ => true,
    }
}

pub(crate) fn peer_url(raw: &str) -> Option<Url> {
    if raw.encode_utf16().count() > 2048 || raw.chars().any(char::is_control) {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

fn endpoint_of(card: &Value, source: &Url) -> Option<Url> {
    let mut endpoint = None;
    for interface in card["supportedInterfaces"].as_array()? {
        if interface["protocolBinding"] != "JSONRPC" || interface["protocolVersion"] != "1.0" {
            continue;
        }
        let candidate = peer_url(interface["url"].as_str()?)?;
        if candidate.origin() != source.origin()
            || endpoint.as_ref().is_some_and(|prior| *prior != candidate)
        {
            return None;
        }
        endpoint = Some(candidate);
    }
    endpoint
}

fn valid_signature(entry: &Value, encoded_payload: &str, key: &PublicKey, kid: &str) -> Option<()> {
    let protected = entry["protected"].as_str()?;
    if protected.is_empty() || protected.len() > (4096usize * 4).div_ceil(3) {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(protected).ok()?;
    if bytes.len() > 4096 {
        return None;
    }
    let header: Value = serde_json::from_slice(&bytes).ok()?;
    let fields = header.as_object()?;
    if !matches!(header["alg"].as_str(), Some("EdDSA" | "Ed25519"))
        || header["kid"] != kid
        || header["typ"].as_str().is_none_or(str::is_empty)
        || fields.contains_key("crit")
        || fields.contains_key("b64")
    {
        return None;
    }
    if let Some(other) = entry.get("header") {
        let unprotected = other.as_object()?;
        if unprotected
            .keys()
            .any(|name| fields.contains_key(name) || matches!(name.as_str(), "crit" | "b64"))
        {
            return None;
        }
    }
    let signature = decode::<64>(entry["signature"].as_str()?)?;
    let signed = format!("{protected}.{encoded_payload}");
    UnparsedPublicKey::new(&ED25519, key.bytes)
        .verify(signed.as_bytes(), &signature)
        .ok()
}

pub fn verify(raw: &[u8], key: &PublicKey, kid: &str, source: &str) -> Check<Verified> {
    let invalid = Error::CardSignature;
    if raw.len() > MAX_CARD_BYTES
        || kid.is_empty()
        || kid.encode_utf16().count() > 128
        || kid.bytes().any(|b| b.is_ascii_control())
    {
        return Err(invalid);
    }
    let source = peer_url(source).ok_or(invalid)?;
    let card: Value = serde_json::from_slice(raw).map_err(|_| invalid)?;
    if !valid_tree(&card, 0, &mut 0) {
        return Err(invalid);
    }
    let signatures = card["signatures"].as_array().ok_or(invalid)?;
    if signatures.is_empty() || signatures.len() > 8 {
        return Err(invalid);
    }
    let normalized = schema::normalize(&card).ok_or(invalid)?;
    let payload = URL_SAFE_NO_PAD.encode(plur1bus_canon::canonical_json(&normalized));
    if !signatures
        .iter()
        .any(|entry| valid_signature(entry, &payload, key, kid).is_some())
    {
        return Err(invalid);
    }
    let endpoint = endpoint_of(&card, &source).ok_or(invalid)?;
    Ok(Verified {
        endpoint,
        fingerprint: key.fingerprint.clone(),
        kid: kid.to_owned(),
    })
}
