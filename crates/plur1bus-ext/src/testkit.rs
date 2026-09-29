//! Test and fixture support (feature `testkit`): a throwaway minisign key, signed packages and the eight tamper
//! variants. No key is committed: [`test_key`] generates one in memory per call, and the public half reaches the code
//! under test only through the test seam `PLUR1BUS_TEST_EXT_PUBKEYS` (X1-R6; global constraints).
use crate::pack::{
    checked_zip, collect_dir, entries_of, prepare, DirLimits, PayloadFile, ZipEntry, ZipKind,
};
use crate::zipaudit::{audit_zip, read_entry, Limits};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Cursor;
use std::path::Path;

/// The `created` time of testkit packages.
pub const CREATED: &str = "2026-01-01T00:00:00Z";

/// A throwaway signing key. The secret half stays in memory and is never printed or written.
pub struct TestKey {
    pub label: String,
    /// The base64 public key, as `PLUR1BUS_TEST_EXT_PUBKEYS=<label>=<base64>` takes it.
    pub public_b64: String,
    pk: minisign::PublicKey,
    sk: minisign::SecretKey,
}

impl std::fmt::Debug for TestKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TestKey")
            .field("label", &self.label)
            .field("public_b64", &self.public_b64)
            .finish_non_exhaustive()
    }
}

/// A fresh Ed25519 key pair (unencrypted, in memory).
pub fn test_key(label: &str) -> TestKey {
    let pair = minisign::KeyPair::generate_unencrypted_keypair().expect("generate a test key");
    TestKey {
        label: label.to_string(),
        public_b64: pair.pk.to_base64(),
        pk: pair.pk,
        sk: pair.sk,
    }
}

/// A minisign signature file over `manifest_raw` with the given trusted comment.
pub fn sign_manifest(key: &TestKey, manifest_raw: &[u8], comment: &str) -> Vec<u8> {
    let untrusted = format!("p1x test signature ({})", key.label);
    minisign::sign(
        Some(&key.pk),
        &key.sk,
        Cursor::new(manifest_raw),
        Some(comment),
        Some(&untrusted),
    )
    .expect("sign the manifest")
    .to_bytes()
}

fn signature_for(key: &TestKey, id: &str, version: &str, raw: &[u8]) -> Vec<u8> {
    let hash = crate::zipaudit::hex(&Sha256::digest(raw));
    sign_manifest(
        key,
        raw,
        &format!("p1x {id} {version} sha256(p1x.json)={hash}"),
    )
}

/// Builds a package from a payload directory: `p1x.json`, `p1x.json.minisig` when `key` is given (trusted comment
/// `p1x <id> <version> sha256(p1x.json)=<hex>`), then `payload/…`. Panics on a refusal: it is for tests.
pub fn build_package(template: &Value, payload: &Path, key: Option<&TestKey>) -> Vec<u8> {
    let (files, _) =
        collect_dir(payload, &DirLimits::default(), |_| Ok(true)).expect("read the payload");
    build_package_from(template, files, key)
}

/// [`build_package`] over in-memory files.
pub fn build_package_from(
    template: &Value,
    files: Vec<PayloadFile>,
    key: Option<&TestKey>,
) -> Vec<u8> {
    let p = prepare(template, files, CREATED).expect("the template is a valid manifest");
    let sig = key.map(|k| signature_for(k, &p.manifest.id, &p.manifest.version, &p.raw));
    checked_zip(&entries_of(&p, sig)).expect("the package audits clean")
}

/// The eight ways a signed package can be broken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tamper {
    /// One payload byte changes; the manifest, its hashes and the signature stay.
    PayloadByte,
    /// A payload entry that `files` does not list.
    ExtraEntry,
    /// An entry named `payload/../evil`.
    DotDot,
    /// A symlink entry.
    Symlink,
    /// A second entry that differs from an existing one only by case.
    CaseCollision,
    /// An entry that inflates by more than 100:1.
    Bomb101,
    /// The manifest names another id (publisher and name), with the old signature kept.
    ForeignId,
    /// Bytes after the end-of-central-directory record.
    AppendAfterEocd,
}

impl Tamper {
    /// A file-name stem for the fixture generator.
    pub fn slug(self) -> &'static str {
        match self {
            Tamper::PayloadByte => "payload-byte",
            Tamper::ExtraEntry => "extra-entry",
            Tamper::DotDot => "dot-dot",
            Tamper::Symlink => "symlink",
            Tamper::CaseCollision => "case-collision",
            Tamper::Bomb101 => "bomb-101",
            Tamper::ForeignId => "foreign-id",
            Tamper::AppendAfterEocd => "append-after-eocd",
        }
    }

    pub const ALL: [Tamper; 8] = [
        Tamper::PayloadByte,
        Tamper::ExtraEntry,
        Tamper::DotDot,
        Tamper::Symlink,
        Tamper::CaseCollision,
        Tamper::Bomb101,
        Tamper::ForeignId,
        Tamper::AppendAfterEocd,
    ];
}

fn file(name: &str, bytes: Vec<u8>) -> ZipEntry {
    ZipEntry {
        name: name.to_string(),
        bytes,
        kind: ZipKind::File { exec: false },
    }
}

/// Breaks a package built by this module in one way. Panics if `pkg` is not such a package.
pub fn tamper(pkg: &[u8], how: Tamper) -> Vec<u8> {
    if how == Tamper::AppendAfterEocd {
        let mut out = pkg.to_vec();
        out.extend_from_slice(b"appended after the end-of-central-directory record");
        return out;
    }
    let mut r = Cursor::new(pkg);
    let audited = audit_zip(&mut r, &Limits::default()).expect("a valid package");
    let mut entries: Vec<ZipEntry> = audited
        .entries
        .iter()
        .map(|e| ZipEntry {
            name: e.name.clone(),
            bytes: read_entry(&mut r, e, u64::MAX).expect("read an entry"),
            kind: ZipKind::File { exec: e.exec },
        })
        .collect();
    let first_payload = entries
        .iter()
        .position(|e| e.name.starts_with("payload/") && !e.bytes.is_empty())
        .expect("a non-empty payload file");
    match how {
        Tamper::PayloadByte => entries[first_payload].bytes[0] ^= 0x01,
        Tamper::ExtraEntry => entries.push(file("payload/extra.txt", b"not in files".to_vec())),
        Tamper::DotDot => entries.push(file("payload/../evil", b"escape".to_vec())),
        Tamper::Symlink => entries.push(ZipEntry {
            name: "payload/link".into(),
            bytes: b"/etc/passwd".to_vec(),
            kind: ZipKind::Symlink,
        }),
        Tamper::CaseCollision => {
            let name = &entries[first_payload].name;
            let (dir, base) = name.rsplit_once('/').expect("under payload/");
            let flipped = if base.chars().any(char::is_uppercase) {
                base.to_lowercase()
            } else {
                base.to_uppercase()
            };
            let name = format!("{dir}/{flipped}");
            entries.push(file(&name, b"collides".to_vec()));
        }
        Tamper::Bomb101 => entries.push(file("payload/bomb.bin", vec![0u8; 1 << 20])),
        Tamper::ForeignId => {
            let m = entries
                .iter_mut()
                .find(|e| e.name == "p1x.json")
                .expect("p1x.json");
            let mut v: Value = serde_json::from_slice(&m.bytes).expect("manifest JSON");
            let name = v["name"].as_str().expect("name").to_string();
            v["id"] = Value::from(format!("evil/{name}"));
            v["publisher"]["id"] = Value::from("evil");
            m.bytes = serde_json::to_vec_pretty(&v).expect("serialise");
        }
        Tamper::AppendAfterEocd => unreachable!(),
    }
    // Written without the audit: the variants exist to be refused by it.
    crate::pack::write_zip(&entries).expect("write the tampered archive")
}
