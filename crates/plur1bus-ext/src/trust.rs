//! Package signatures and trust tiers (spec 2026-09-27 §8.1–§8.3, §8.4 step 4; X1-R6).
//!
//! A `.p1x` may carry `p1x.json.minisig`, a minisign signature (prehashed `ED` only) over the exact bytes of
//! `p1x.json` whose trusted comment is `p1x <id> <version> sha256(p1x.json)=<hex>`. The signature's key id (bytes
//! 2..10 of the decoded signature line; `minisign-verify` 0.2.5 exposes no accessor) picks the trusted key. A key id no
//! trusted key has makes the package `unknown-signer`: the signature cannot be checked without the key, and the id is
//! shown. The trusted set is [`PINNED_KEYS`], which ships empty until X5 generates the keys, so no package is
//! `first-party` in production yet; tests add keys through `PLUR1BUS_TEST_EXT_PUBKEYS` (test internals only).
use crate::manifest::P1xManifest;
use crate::refusal::{reason, Refusal};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// The pinned first-party extension keys, `(label, base64 minisign public key)`. The labels `ext-primary` (secret in
/// the GitHub Environment `extensions-release`) and `ext-backup` (offline) are reserved for them (§8.1). Empty until
/// X5 creates the keys (X1-R6); never put a test key here.
pub const PINNED_KEYS: &[(&str, &str)] = &[];

/// Labels only [`PINNED_KEYS`] may use.
pub const RESERVED_LABELS: &[&str] = &["ext-primary", "ext-backup"];

/// Test seam: `<label>=<base64>[,…]`, keys added to the pinned set. Honoured only with
/// `PLUR1BUS_ALLOW_TEST_INTERNALS=1`.
pub const TEST_KEYS_ENV: &str = "PLUR1BUS_TEST_EXT_PUBKEYS";

/// A trust tier (§8.2). This module assigns `first-party`, `unknown-signer` and `unsigned`; `release`, `imported` and
/// `dev` are assigned by callers from where an item came from.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tier {
    Release,
    FirstParty,
    UnknownSigner,
    Unsigned,
    Imported,
    Dev,
}

/// The tier of a package and, when it is signed, the signing key's id (16 upper-case hex digits, minisign's own
/// rendering) and, when that key is trusted, its label.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trust {
    pub tier: Tier,
    pub key_id: Option<String>,
    pub key_label: Option<String>,
}

struct TrustedKey {
    label: String,
    key: minisign_verify::PublicKey,
    id: [u8; 8],
}

/// The keys a package signature may verify with.
pub struct TrustStore {
    keys: Vec<TrustedKey>,
}

impl std::fmt::Debug for TrustStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list()
            .entries(self.keys.iter().map(|k| (&k.label, key_id_hex(&k.id))))
            .finish()
    }
}

impl TrustStore {
    /// A store of `(label, base64 public key)` pairs. Refuses an empty label, a key that is not a 42-byte Ed25519
    /// minisign public key, and a label or key id given twice.
    pub fn new(keys: &[(String, String)]) -> Result<TrustStore, String> {
        let mut out: Vec<TrustedKey> = Vec::new();
        for (label, b64) in keys {
            if label.is_empty() {
                return Err("a trusted key has an empty label".into());
            }
            let bin =
                base64_decode(b64.trim()).ok_or_else(|| format!("key {label:?}: not base64"))?;
            if bin.len() != 42 || bin[0] != b'E' || bin[1] != b'd' {
                return Err(format!("key {label:?}: not an Ed25519 minisign public key"));
            }
            let key = minisign_verify::PublicKey::from_base64(b64.trim())
                .map_err(|e| format!("key {label:?}: {e}"))?;
            let mut id = [0u8; 8];
            id.copy_from_slice(&bin[2..10]);
            if out.iter().any(|k| k.label == *label) {
                return Err(format!("the label {label:?} is given twice"));
            }
            if out.iter().any(|k| k.id == id) {
                return Err(format!("the key id {} is given twice", key_id_hex(&id)));
            }
            out.push(TrustedKey {
                label: label.clone(),
                key,
                id,
            });
        }
        Ok(TrustStore { keys: out })
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// The pinned set alone ([`PINNED_KEYS`]).
    pub fn pinned() -> TrustStore {
        let keys: Vec<(String, String)> = PINNED_KEYS
            .iter()
            .map(|(l, k)| (l.to_string(), k.to_string()))
            .collect();
        TrustStore::new(&keys).expect("the pinned extension keys are valid")
    }

    /// The pinned set plus the keys in `test_keys` (the [`TEST_KEYS_ENV`] syntax) when `allow_internals`; without it
    /// the test keys are ignored. A test key may not take a [`RESERVED_LABELS`] label.
    pub fn with_test_keys(
        allow_internals: bool,
        test_keys: Option<&str>,
    ) -> Result<TrustStore, String> {
        let mut keys: Vec<(String, String)> = PINNED_KEYS
            .iter()
            .map(|(l, k)| (l.to_string(), k.to_string()))
            .collect();
        if let (true, Some(spec)) = (allow_internals, test_keys) {
            for part in spec.split(',').filter(|p| !p.trim().is_empty()) {
                let (label, b64) = part
                    .split_once('=')
                    .ok_or_else(|| format!("{TEST_KEYS_ENV}: {part:?} is not <label>=<base64>"))?;
                let label = label.trim();
                if RESERVED_LABELS.contains(&label) {
                    return Err(format!(
                        "{TEST_KEYS_ENV}: the label {label:?} is reserved for a pinned key"
                    ));
                }
                keys.push((label.to_string(), b64.trim().to_string()));
            }
        }
        TrustStore::new(&keys).map_err(|e| format!("{TEST_KEYS_ENV}: {e}"))
    }

    /// [`TrustStore::with_test_keys`] from the environment: `PLUR1BUS_ALLOW_TEST_INTERNALS=1` and [`TEST_KEYS_ENV`].
    pub fn from_env() -> Result<TrustStore, String> {
        let allow = std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Ok("1");
        let spec = std::env::var(TEST_KEYS_ENV).ok();
        TrustStore::with_test_keys(allow, spec.as_deref())
    }

    fn find(&self, id: &[u8; 8]) -> Option<&TrustedKey> {
        self.keys.iter().find(|k| k.id == *id)
    }
}

/// minisign's rendering of a key id: the 8 bytes as a little-endian u64 in 16 upper-case hex digits.
pub fn key_id_hex(id: &[u8; 8]) -> String {
    format!("{:016X}", u64::from_le_bytes(*id))
}

/// The trusted comment a package signature must carry: `p1x <id> <version> sha256(p1x.json)=<hex>`.
pub fn trusted_comment(id: &str, version: &str, manifest_raw: &[u8]) -> String {
    format!(
        "p1x {id} {version} sha256(p1x.json)={}",
        crate::zipaudit::hex(&Sha256::digest(manifest_raw))
    )
}

fn invalid(detail: impl Into<String>) -> Refusal {
    Refusal::invalid(reason::SIGNATURE_INVALID, detail)
}

/// A signature checked against the manifest bytes, before the manifest is parsed (§8.4 step 4). `named` is the id
/// and version the trusted comment names, which [`check_names`] compares with the parsed manifest (step 5).
#[derive(Clone, Debug)]
pub(crate) struct Checked {
    pub trust: Trust,
    pub named: Option<(String, String)>,
}

/// Step 4 on the raw bytes: no signature → `unsigned`; a legacy `Ed` signature, an undecodable file, a trusted key
/// whose signature does not verify, or a trusted comment that is not the binding shape over these exact bytes →
/// `signature-invalid`; a key id the store does not have → `unknown-signer` (its comment is still checked, since it
/// must describe this manifest whoever signed it).
pub(crate) fn check_signature(
    manifest_raw: &[u8],
    minisig: Option<&[u8]>,
    store: &TrustStore,
) -> Result<Checked, Refusal> {
    let Some(minisig) = minisig else {
        return Ok(Checked {
            trust: Trust {
                tier: Tier::Unsigned,
                key_id: None,
                key_label: None,
            },
            named: None,
        });
    };
    let text =
        std::str::from_utf8(minisig).map_err(|_| invalid("p1x.json.minisig is not UTF-8"))?;
    let line = text
        .lines()
        .nth(1)
        .ok_or_else(|| invalid("p1x.json.minisig is not a minisign signature"))?;
    let bin = base64_decode(line.trim())
        .filter(|b| b.len() == 74)
        .ok_or_else(|| invalid("p1x.json.minisig is not a minisign signature"))?;
    match (bin[0], bin[1]) {
        (b'E', b'D') => {}
        (b'E', b'd') => {
            return Err(invalid(
                "p1x.json.minisig is a legacy (non-prehashed) minisign signature; sign with minisign 0.8 or later",
            ))
        }
        _ => return Err(invalid("p1x.json.minisig uses an unknown signature algorithm")),
    }
    let mut id = [0u8; 8];
    id.copy_from_slice(&bin[2..10]);
    let sig = minisign_verify::Signature::decode(text)
        .map_err(|e| invalid(format!("p1x.json.minisig: {e}")))?;
    let key_id = key_id_hex(&id);
    let key_label = match store.find(&id) {
        Some(k) => {
            k.key.verify(manifest_raw, &sig, false).map_err(|e| {
                invalid(format!(
                    "the signature by trusted key {key_id} ({}) does not match p1x.json: {e}",
                    k.label
                ))
            })?;
            Some(k.label.clone())
        }
        None => None,
    };
    let named = parse_comment(sig.trusted_comment(), manifest_raw)?;
    let tier = if key_label.is_some() {
        Tier::FirstParty
    } else {
        Tier::UnknownSigner
    };
    Ok(Checked {
        trust: Trust {
            tier,
            key_id: Some(key_id),
            key_label,
        },
        named: Some(named),
    })
}

/// `p1x <id> <version> sha256(p1x.json)=<hex>` with `<hex>` the hash of these bytes → `(id, version)`.
fn parse_comment(comment: &str, manifest_raw: &[u8]) -> Result<(String, String), Refusal> {
    let parts: Vec<&str> = comment.split(' ').collect();
    let expected_hash = format!(
        "sha256(p1x.json)={}",
        crate::zipaudit::hex(&Sha256::digest(manifest_raw))
    );
    match parts.as_slice() {
        ["p1x", id, version, hash] if !id.is_empty() && !version.is_empty() => {
            if *hash != expected_hash {
                return Err(invalid(
                    "the signature's trusted comment names another p1x.json (its SHA-256 differs)",
                ));
            }
            Ok((id.to_string(), version.to_string()))
        }
        _ => Err(invalid(format!(
            "the signature's trusted comment {comment:?} is not \"p1x <id> <version> sha256(p1x.json)=<hex>\""
        ))),
    }
}

/// Step 5's half of the signature check: the trusted comment names the parsed manifest's id and version.
pub(crate) fn check_names(c: &Checked, m: &P1xManifest) -> Result<(), Refusal> {
    match &c.named {
        Some((id, version)) if *id != m.id || *version != m.version => Err(invalid(format!(
            "the signature is for {id} {version}, but p1x.json is {} {}",
            m.id, m.version
        ))),
        _ => Ok(()),
    }
}

/// Verifies `p1x.json.minisig` (if any) over `manifest_raw` for the parsed manifest `m` (§8.4 step 4): see
/// [`TrustStore`] for the tiers. Refusals are `E_INVALID_PARAMS reason=signature-invalid`.
pub fn verify_signature(
    manifest_raw: &[u8],
    minisig: Option<&[u8]>,
    m: &P1xManifest,
    store: &TrustStore,
) -> Result<Trust, Refusal> {
    let c = check_signature(manifest_raw, minisig, store)?;
    check_names(&c, m)?;
    Ok(c.trust)
}

/// Standard base64 (RFC 4648 alphabet, `=` padding required to a multiple of 4), as minisign writes it. `None` for
/// anything else.
pub(crate) fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if b.is_empty() || !b.len().is_multiple_of(4) {
        return None;
    }
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    let chunks = b.len() / 4;
    for (i, q) in b.chunks(4).enumerate() {
        let pad = q.iter().rev().take_while(|c| **c == b'=').count();
        if pad > 2 || (pad > 0 && i + 1 != chunks) {
            return None;
        }
        let mut n = 0u32;
        for (j, c) in q.iter().enumerate() {
            let v = if j >= 4 - pad { 0 } else { val(*c)? };
            n = (n << 6) | v;
        }
        let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&bytes[..3 - pad]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_decodes_minisign_shapes_and_refuses_the_rest() {
        assert_eq!(base64_decode("TWFu").unwrap(), b"Man");
        assert_eq!(base64_decode("TWE=").unwrap(), b"Ma");
        assert_eq!(base64_decode("TQ==").unwrap(), b"M");
        for bad in ["", "TWF", "TW=u", "T===", "TQ==TWFu", "TWF!", "TWFu\n"] {
            assert!(base64_decode(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn key_ids_render_like_minisign() {
        assert_eq!(key_id_hex(&[1, 2, 3, 4, 5, 6, 7, 8]), "0807060504030201");
        assert_eq!(key_id_hex(&[0xab; 8]), "ABABABABABABABAB");
    }
}
