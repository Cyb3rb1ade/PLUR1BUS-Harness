//! Signed catalogue refresh and artifact admission. The host owns egress and
//! holds one exclusive store lease for each public client operation.

use std::collections::HashSet;
use std::sync::LazyLock;

use icu_normalizer::ComposingNormalizerBorrowed;
use regex::Regex;
use ring::digest::{digest, SHA256};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::{Host, Origin, Url};

use crate::trust::{self, Envelope, Root, SAFE_INT};

const MAX_METADATA: usize = 8 * 1024 * 1024;
const DEFAULT_ARTIFACT_LIMIT: usize = 128 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 15_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    SignatureInvalid,
    KeyUnknown,
    KeyRevoked,
    RollbackDetected,
    StaleIndex,
    HashMismatch,
    RevokedPackage,
    Transport,
}

impl Error {
    pub const fn code(self) -> &'static str {
        match self {
            Self::SignatureInvalid => "signature_invalid",
            Self::KeyUnknown => "key_unknown",
            Self::KeyRevoked => "key_revoked",
            Self::RollbackDetected => "rollback_detected",
            Self::StaleIndex => "stale_index",
            Self::HashMismatch => "hash_mismatch",
            Self::RevokedPackage => "revoked_package",
            Self::Transport => "transport",
        }
    }
}
impl From<trust::Error> for Error {
    fn from(value: trust::Error) -> Self {
        match value {
            trust::Error::KeyRevoked => Self::KeyRevoked,
            trust::Error::KeyUnknown => Self::KeyUnknown,
            trust::Error::SignatureInvalid => Self::SignatureInvalid,
            trust::Error::StaleIndex => Self::StaleIndex,
        }
    }
}
type Result<T> = std::result::Result<T, Error>;

pub struct Config {
    pub url: Url,
    pub root: String,
    pub revocations_url: Option<Url>,
    pub rotations_url: Option<Url>,
    /// Exact origin for a host-controlled loopback test catalogue.
    pub test_origin: Option<Origin>,
    pub max_bytes: usize,
    pub max_artifact_bytes: usize,
    pub timeout_ms: u64,
    pub offline_grace_ms: i64,
}

impl Config {
    pub fn new(url: Url, root: String) -> Self {
        Self {
            url,
            root,
            revocations_url: None,
            rotations_url: None,
            test_origin: None,
            max_bytes: 4 * 1024 * 1024,
            max_artifact_bytes: DEFAULT_ARTIFACT_LIMIT,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            offline_grace_ms: 0,
        }
    }
}

pub struct Request<'a> {
    pub url: &'a Url,
    pub max_bytes: usize,
    pub timeout_ms: u64,
    pub max_redirects: u8,
    pub accept: &'static str,
    pub user_agent: &'static str,
}
pub struct Response {
    pub url: Url,
    pub redirected: bool,
    pub status: u16,
    pub body: Vec<u8>,
}

/// Implementations hold an exclusive lease across load, admission, commit and
/// download, including between different processes using the same installation.
/// A commit replaces the previous checkpoint and cached snapshot atomically.
pub trait Port {
    fn now_ms(&self) -> i64;
    fn state(&self) -> Result<State>;
    fn commit(&mut self, state: State) -> Result<()>;
    fn fetch(&mut self, request: Request<'_>) -> Result<Response>;
    fn installed(&self) -> Result<Vec<InstalledPackage>> {
        Ok(Vec::new())
    }
    fn report(&mut self, _entries: Vec<Value>) -> Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
pub struct InstalledPackage {
    pub id: String,
    pub version: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Selection {
    pub serial: u64,
    pub id: String,
    pub version: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub checkpoint: Option<Checkpoint>,
    pub snapshot: Option<Snapshot>,
    pub legacy_serial: Option<u64>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    index: Envelope,
    revocations: Envelope,
    rotations: Vec<Envelope>,
    fetched_at: i64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    serial: u64,
    index_hash: String,
    root_version: u64,
    root_hash: String,
    revocation_version: u64,
    revocation_hash: String,
    revoked_keys: Vec<String>,
    revoked_public_keys: Vec<String>,
    revoked_packages: Vec<Revocation>,
    rotation_hashes: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
struct Revocation {
    id: String,
    versions: Vec<String>,
    reason: String,
}

struct Verified {
    index: Value,
    floor: Checkpoint,
    expires: i64,
    warnings: Vec<Value>,
}

pub struct Client {
    config: Config,
    root: Root,
}

fn parse<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|_| Error::SignatureInvalid)
}

fn stamp(value: &Value) -> Result<i64> {
    Ok(trust::timestamp(
        value.as_str().ok_or(Error::SignatureInvalid)?,
    )?)
}

fn integer(value: &Value, min: u64) -> Result<u64> {
    value
        .as_number()
        .and_then(|number| trust::safe_integer(number, min))
        .ok_or(Error::SignatureInvalid)
}

fn hash(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut text = String::with_capacity(64);
    for byte in digest(&SHA256, bytes).as_ref() {
        let _ = write!(&mut text, "{byte:02x}");
    }
    text
}

fn hex_hash(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or(Error::SignatureInvalid)
}

fn url_policy(url: &Url, test_origin: Option<&Origin>) -> bool {
    let permitted_scheme = url.scheme() == "https"
        || (url.scheme() == "http"
            && test_origin.is_some_and(|origin| *origin == url.origin())
            && url.host().is_some_and(|host| match host {
                Host::Domain(name) => name == "localhost" || name.ends_with(".localhost"),
                Host::Ipv4(ip) => ip.is_loopback(),
                Host::Ipv6(ip) => {
                    ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|ip| ip.is_loopback())
                }
            }));
    permitted_scheme
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.has_host()
}

fn monotone(version: u64, hash: &str, old: Option<(u64, &str)>) -> Result<()> {
    if old.is_some_and(|(n, digest)| version < n || (version == n && digest != hash)) {
        return Err(Error::RollbackDetected);
    }
    Ok(())
}

fn valid_pattern(text: &str) -> bool {
    let plain = text.strip_suffix(".*").unwrap_or(text);
    text == "*"
        || (!plain.is_empty()
            && !plain
                .chars()
                .any(|c| c.is_whitespace() || "*<>=^~!|,?[]{}()".contains(c)))
}

fn covered(pattern: &str, value: &str) -> bool {
    pattern == "*"
        || pattern == value
        || pattern
            .strip_suffix('*')
            .is_some_and(|prefix| value.starts_with(prefix))
}

fn revoked<'a>(rules: &'a [Revocation], id: &str, version: &str) -> Option<&'a Revocation> {
    rules
        .iter()
        .find(|rule| rule.id == id && rule.versions.iter().any(|p| covered(p, version)))
}

fn distinct(strings: &[String]) -> bool {
    let mut seen = HashSet::new();
    strings
        .iter()
        .all(|value| !value.is_empty() && seen.insert(value))
}

static INVISIBLE: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"[\p{Z}\p{C}]").ok());

fn skeleton(id: &str) -> Result<String> {
    let re = INVISIBLE.as_ref().ok_or(Error::SignatureInvalid)?;
    let normalizer = ComposingNormalizerBorrowed::new_nfkc();
    let normalized = normalizer.normalize(id).to_lowercase();
    let folded: String = re
        .replace_all(&normalized, "")
        .chars()
        .map(lookalike)
        .collect();
    Ok(normalizer.normalize(&folded).into_owned())
}

fn check_index(index: &mut Value, test_origin: Option<&Origin>) -> Result<()> {
    if integer(&index["format"], 1)? != 1
        || index
            .get("revocations")
            .is_some_and(|v| v.as_array().is_none_or(|v| !v.is_empty()))
    {
        return Err(Error::SignatureInvalid);
    }
    index["format"] = json!(1);
    let packages = index["packages"]
        .as_array_mut()
        .ok_or(Error::SignatureInvalid)?;
    let mut seen = HashSet::new();
    for entry in packages {
        let id = entry["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(Error::SignatureInvalid)?;
        if !entry["kind"].is_string() || !entry["name"].is_string() || !seen.insert(skeleton(id)?) {
            return Err(Error::SignatureInvalid);
        }
        let mut versions = HashSet::new();
        for version in entry["versions"]
            .as_array_mut()
            .ok_or(Error::SignatureInvalid)?
        {
            version["size"] = json!(integer(&version["size"], 1)?);
            let name = version["version"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or(Error::SignatureInvalid)?;
            let url = Url::parse(version["url"].as_str().ok_or(Error::SignatureInvalid)?)
                .map_err(|_| Error::SignatureInvalid)?;
            if !versions.insert(name) || !url_policy(&url, test_origin) {
                return Err(Error::SignatureInvalid);
            }
            hex_hash(&version["sha256"])?;
        }
    }
    Ok(())
}

// Extension index comparison uses the D112 catalogue's existing look-alike vocabulary.
fn lookalike(ch: char) -> char {
    match ch {
        'а' => 'a',
        'в' => 'b',
        'с' => 'c',
        'е' => 'e',
        'н' => 'h',
        'і' => 'i',
        'ј' => 'j',
        'к' => 'k',
        'м' => 'm',
        'о' => 'o',
        'р' => 'p',
        'ѕ' => 's',
        'т' => 't',
        'у' => 'y',
        'х' => 'x',
        'ӏ' => 'l',
        'α' => 'a',
        'β' => 'b',
        'ε' => 'e',
        'ι' => 'i',
        'κ' => 'k',
        'ν' => 'v',
        'ο' => 'o',
        'ρ' => 'p',
        'τ' => 't',
        'υ' => 'u',
        'χ' => 'x',
        '∕' => '/',
        '⁄' => '/',
        '╱' => '/',
        '⧸' => '/',
        '／' => '/',
        '‐' => '-',
        '‑' => '-',
        '‒' => '-',
        '–' => '-',
        '−' => '-',
        '﹣' => '-',
        '－' => '-',
        '․' => '.',
        'ǀ' => 'l',
        _ => ch,
    }
}

impl Client {
    pub fn new(config: Config) -> Result<Self> {
        let root = Root::parse(&config.root)?;
        if !url_policy(&config.url, config.test_origin.as_ref())
            || !(1..=MAX_METADATA).contains(&config.max_bytes)
            || !u64::try_from(config.max_artifact_bytes).is_ok_and(|n| (1..=SAFE_INT).contains(&n))
            || !(1..=SAFE_INT).contains(&config.timeout_ms)
            || !(0..=SAFE_INT as i64).contains(&config.offline_grace_ms)
        {
            return Err(Error::Transport);
        }
        Ok(Self { config, root })
    }

    fn fetch(&self, port: &mut dyn Port, url: &Url, limit: usize) -> Result<Vec<u8>> {
        if !url_policy(url, self.config.test_origin.as_ref()) {
            return Err(Error::Transport);
        }
        let response = port
            .fetch(Request {
                url,
                max_bytes: limit,
                timeout_ms: self.config.timeout_ms,
                max_redirects: 0,
                accept: "application/json,application/octet-stream",
                user_agent: "PLUR1BUS-Catalog/1",
            })
            .map_err(|_| Error::Transport)?;
        if response.status != 200
            || response.url != *url
            || response.redirected
            || response.body.len() > limit
        {
            return Err(Error::Transport);
        }
        Ok(response.body)
    }

    pub fn refresh(&self, port: &mut dyn Port) -> Result<Value> {
        let previous = port.state()?;
        let endpoint = |name: &str, configured: Option<&Url>| match configured {
            Some(url) => Ok(url.clone()),
            None => self.config.url.join(name).map_err(|_| Error::Transport),
        };
        let revocations_url = endpoint("revocations", self.config.revocations_url.as_ref())?;
        let rotations_url = endpoint("rotations", self.config.rotations_url.as_ref())?;
        let index = self.fetch(port, &self.config.url, self.config.max_bytes);
        let revocations = self.fetch(port, &revocations_url, self.config.max_bytes);
        let rotations = self.fetch(port, &rotations_url, self.config.max_bytes);
        let snapshot = Snapshot {
            index: parse(&index?)?,
            revocations: parse(&revocations?)?,
            rotations: parse(&rotations?)?,
            fetched_at: port.now_ms(),
        };
        let checked = self.authenticate(&snapshot, previous.checkpoint.as_ref(), port.now_ms())?;
        if previous
            .legacy_serial
            .is_some_and(|floor| checked.floor.serial <= floor)
        {
            return Err(Error::RollbackDetected);
        }
        if checked.expires <= port.now_ms() {
            return Err(Error::StaleIndex);
        }
        let fetched_at = snapshot.fetched_at;
        port.commit(State {
            checkpoint: Some(checked.floor.clone()),
            snapshot: Some(snapshot),
            legacy_serial: None,
        })?;
        Self::view(port, checked, fetched_at, "network")
    }

    pub fn get(&self, port: &mut dyn Port) -> Result<Value> {
        match self.refresh(port) {
            Err(Error::Transport) => {
                let state = port.state()?;
                let snapshot = state.snapshot.as_ref().ok_or(Error::Transport)?;
                let floor = state.checkpoint.as_ref().ok_or(Error::SignatureInvalid)?;
                let checked = self.authenticate(snapshot, Some(floor), port.now_ms())?;
                let grace_end = checked.expires.saturating_add(self.config.offline_grace_ms);
                let mut view = Self::view(port, checked, snapshot.fetched_at, "cache")?;
                if grace_end <= port.now_ms() {
                    return Err(Error::StaleIndex);
                }
                view["refreshError"] = json!({
                    "code": "transport",
                    "message": "catalogue I/O or reporting failed",
                });
                Ok(view)
            }
            other => other,
        }
    }

    pub fn download(&self, port: &mut dyn Port, selected: &Selection) -> Result<Vec<u8>> {
        let state = port.state()?;
        let snapshot = state.snapshot.as_ref().ok_or(Error::Transport)?;
        let floor = state.checkpoint.as_ref().ok_or(Error::SignatureInvalid)?;
        let checked = self.authenticate(snapshot, Some(floor), port.now_ms())?;
        if checked.expires <= port.now_ms() {
            return Err(Error::StaleIndex);
        }
        if selected.serial != checked.floor.serial {
            return Err(Error::RollbackDetected);
        }
        if revoked(
            &checked.floor.revoked_packages,
            &selected.id,
            &selected.version,
        )
        .is_some()
        {
            return Err(Error::RevokedPackage);
        }
        let version = checked.index["packages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["id"] == selected.id)
            .and_then(|p| p["versions"].as_array())
            .and_then(|v| v.iter().find(|v| v["version"] == selected.version))
            .ok_or(Error::SignatureInvalid)?;
        let size = usize::try_from(integer(&version["size"], 1)?)
            .ok()
            .filter(|&n| n <= self.config.max_artifact_bytes)
            .ok_or(Error::Transport)?;
        let url = Url::parse(version["url"].as_str().ok_or(Error::SignatureInvalid)?)
            .map_err(|_| Error::SignatureInvalid)?;
        let bytes = self.fetch(port, &url, size)?;
        if bytes.len() != size || hash(&bytes) != hex_hash(&version["sha256"])? {
            return Err(Error::HashMismatch);
        }
        self.authenticate(snapshot, Some(&checked.floor), port.now_ms())?;
        if checked.expires <= port.now_ms() {
            return Err(Error::StaleIndex);
        }
        Ok(bytes)
    }

    fn view(
        port: &mut dyn Port,
        mut checked: Verified,
        fetched_at: i64,
        source: &str,
    ) -> Result<Value> {
        let rules = &checked.floor.revoked_packages;
        let installed = port.installed()?;
        port.report(
            installed
                .iter()
                .filter_map(|item| {
                    revoked(rules, &item.id, &item.version).map(|rule| {
                json!({"id":item.id,"version":item.version,"status":"revoked","reason":rule.reason})
            })
                })
                .collect(),
        )?;
        let packages = checked.index["packages"]
            .as_array_mut()
            .ok_or(Error::SignatureInvalid)?;
        for package in packages.iter_mut() {
            let id = package["id"]
                .as_str()
                .ok_or(Error::SignatureInvalid)?
                .to_owned();
            let versions = package["versions"]
                .as_array_mut()
                .ok_or(Error::SignatureInvalid)?;
            versions.retain(|v| {
                v["version"]
                    .as_str()
                    .is_some_and(|version| revoked(rules, &id, version).is_none())
            });
        }
        packages.retain(|p| p["versions"].as_array().is_some_and(|v| !v.is_empty()));
        Ok(json!({
            "index":checked.index, "rootVersion":checked.floor.root_version, "source":source,
            "stale":checked.expires <= port.now_ms(), "fetchedAt":fetched_at, "warnings":checked.warnings,
        }))
    }

    fn authenticate(
        &self,
        snapshot: &Snapshot,
        previous: Option<&Checkpoint>,
        now: i64,
    ) -> Result<Verified> {
        if snapshot.rotations.len() > 64 {
            return Err(Error::SignatureInvalid);
        }
        let old_revoked: HashSet<_> = previous
            .into_iter()
            .flat_map(|p| &p.revoked_keys)
            .map(String::as_str)
            .collect();
        let old_material = previous.map_or(&[][..], |p| p.revoked_public_keys.as_slice());
        let mut rotated = None;
        let mut keys: Vec<_> = self
            .root
            .materials()
            .map(|(id, key)| (id.to_owned(), key))
            .collect();
        let mut rotation_hashes = Vec::new();
        let mut root_hash = hash(self.root.normalized());
        for envelope in &snapshot.rotations {
            let root = rotated.as_ref().unwrap_or(&self.root);
            let payload_hash = hash(&envelope.bytes()?);
            let historical = previous.and_then(|p| p.rotation_hashes.get(rotation_hashes.len()))
                == Some(&payload_hash);
            let none_revoked = HashSet::new();
            let check = root.verify_at(
                envelope,
                now,
                if historical {
                    &none_revoked
                } else {
                    &old_revoked
                },
                historical,
            )?;
            if !historical {
                verify_material(root, check.signers(), old_material)?;
            }
            let next = Root::parse(
                std::str::from_utf8(check.bytes()).map_err(|_| Error::SignatureInvalid)?,
            )?;
            if next.version != root.version + 1 {
                return Err(Error::RollbackDetected);
            }
            if !historical && next.expires() <= now {
                return Err(Error::StaleIndex);
            }
            keys.extend(next.materials().map(|(id, key)| (id.to_owned(), key)));
            rotated = Some(next);
            root_hash = payload_hash;
            rotation_hashes.push(root_hash.clone());
        }
        let root = rotated.as_ref().unwrap_or(&self.root);
        monotone(
            root.version,
            &root_hash,
            previous.map(|p| (p.root_version, p.root_hash.as_str())),
        )?;

        let verified_index = root.verify(&snapshot.index, now, &old_revoked)?;
        let verified_revocations = root.verify(&snapshot.revocations, now, &old_revoked)?;
        let mut index: Value = parse(verified_index.bytes())?;
        let revocation: Value = parse(verified_revocations.bytes())?;
        if integer(&index["rootVersion"], 1)? != root.version
            || revocation["type"] != "revocations"
            || integer(&revocation["rootVersion"], 1)? != root.version
        {
            return Err(Error::SignatureInvalid);
        }
        let serial = integer(&index["serial"], 0)?;
        let index_hash = hash(verified_index.bytes());
        monotone(
            serial,
            &index_hash,
            previous.map(|p| (p.serial, p.index_hash.as_str())),
        )?;

        let revocation_version = integer(&revocation["version"], 1)?;
        let revocation_hash = hash(verified_revocations.bytes());
        if revocation_version != integer(&index["revocation"]["version"], 1)?
            || revocation_hash != hex_hash(&index["revocation"]["sha256"])?
        {
            return Err(Error::SignatureInvalid);
        }
        monotone(
            revocation_version,
            &revocation_hash,
            previous.map(|p| (p.revocation_version, p.revocation_hash.as_str())),
        )?;
        let revoked_keys: Vec<String> = serde_json::from_value(revocation["keys"].clone())
            .map_err(|_| Error::SignatureInvalid)?;
        let revoked_packages: Vec<Revocation> =
            serde_json::from_value(revocation["packages"].clone())
                .map_err(|_| Error::SignatureInvalid)?;
        if !distinct(&revoked_keys)
            || revoked_packages.iter().any(|p| {
                p.id.is_empty()
                    || p.versions.is_empty()
                    || p.versions.iter().any(|v| !valid_pattern(v))
            })
        {
            return Err(Error::SignatureInvalid);
        }
        let denied: HashSet<_> = revoked_keys.iter().map(String::as_str).collect();
        if !old_revoked.is_subset(&denied) {
            return Err(Error::KeyRevoked);
        }
        if let Some(previous) = previous {
            for old in &previous.revoked_packages {
                if old
                    .versions
                    .iter()
                    .any(|v| revoked(&revoked_packages, &old.id, v).is_none())
                {
                    return Err(Error::RevokedPackage);
                }
            }
        }
        let mut revoked_public_keys = old_material.to_vec();
        for (id, key) in &keys {
            if denied.contains(id.as_str()) && !revoked_public_keys.contains(key) {
                revoked_public_keys.push(key.clone());
            }
        }
        verify_material(root, verified_index.signers(), &revoked_public_keys)?;
        verify_material(root, verified_revocations.signers(), &revoked_public_keys)?;
        root.verify(&snapshot.index, now, &denied)?;
        root.verify(&snapshot.revocations, now, &denied)?;

        let generated = stamp(&index["generatedAt"])?;
        let index_expires = stamp(&index["expires"])?;
        if generated >= index_expires || generated > now {
            return Err(Error::SignatureInvalid);
        }
        let expires = root
            .expires()
            .min(index_expires)
            .min(stamp(&revocation["expires"])?);
        check_index(&mut index, self.config.test_origin.as_ref())?;
        let packages = index["packages"]
            .as_array()
            .ok_or(Error::SignatureInvalid)?;
        let warnings = warnings(&keys, packages, &revoked_keys, &revoked_packages);
        index["serial"] = json!(serial);
        index["rootVersion"] = json!(root.version);
        index["revocation"]["version"] = json!(revocation_version);
        index["revocations"] = json!([]);
        Ok(Verified {
            index,
            expires,
            warnings,
            floor: Checkpoint {
                serial,
                index_hash,
                root_version: root.version,
                root_hash,
                revocation_version,
                revocation_hash,
                revoked_keys,
                revoked_public_keys,
                revoked_packages,
                rotation_hashes,
            },
        })
    }
}

fn verify_material(root: &Root, signers: &[&str], revoked: &[String]) -> Result<()> {
    if signers
        .iter()
        .any(|id| root.material(id).is_some_and(|key| revoked.contains(&key)))
    {
        Err(Error::KeyRevoked)
    } else {
        Ok(())
    }
}

fn warnings(
    keys: &[(String, String)],
    packages: &[Value],
    revoked_keys: &[String],
    revoked_packages: &[Revocation],
) -> Vec<Value> {
    let known_keys: HashSet<_> = keys.iter().map(|(id, _)| id.as_str()).collect();
    let known_packages: HashSet<_> = packages.iter().filter_map(|p| p["id"].as_str()).collect();
    let mut seen = HashSet::new();
    revoked_keys.iter().filter(|id| !known_keys.contains(id.as_str())).map(|id| {
        json!({"kind":"revocation_unknown_key","id":id,
            "message":format!("revocation names key {} which no trust root lists; it stays revoked", json!(id))})
    }).chain(revoked_packages.iter().filter(|p| !known_packages.contains(p.id.as_str()) && seen.insert(&p.id)).map(|p| {
        json!({"kind":"revocation_unknown_package","id":p.id,
            "message":format!("revocation names package {} which the index does not contain; it stays revoked", json!(p.id))})
    })).collect()
}
