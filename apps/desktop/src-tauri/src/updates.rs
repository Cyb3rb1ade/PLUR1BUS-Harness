//! Signed release metadata and deterministic, clock-injected update policy.
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Write, path::Path};
/// Each channel has independent feed and updater keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    #[cfg(debug_assertions)]
    Dev,
    Beta,
    #[default]
    Stable,
}
impl Channel {
    /// Static channel name used in the publisher endpoint.
    pub fn name(self) -> &'static str {
        match self {
            #[cfg(debug_assertions)]
            Self::Dev => "dev",
            Self::Beta => "beta",
            Self::Stable => "stable",
        }
    }
    /// Embedded keys are public placeholders until release engineering provisions them.
    pub fn key(self, updater: bool) -> &'static str {
        match (self, updater) {
            #[cfg(debug_assertions)]
            (Self::Dev, false) => include_str!("../keys/dev.feed.pub"),
            #[cfg(debug_assertions)]
            (Self::Dev, true) => include_str!("../keys/dev.updater.pub"),
            (Self::Beta, false) => include_str!("../keys/beta.feed.pub"),
            (Self::Beta, true) => include_str!("../keys/beta.updater.pub"),
            (Self::Stable, false) => include_str!("../keys/stable.feed.pub"),
            (Self::Stable, true) => include_str!("../keys/stable.updater.pub"),
        }
    }
}
/// Product meaning of the version increment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Major,
    Minor,
    Patch,
}
/// Plain release notes, rendered without HTML or links.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Notes {
    pub de: String,
    pub en: String,
}
/// Superset of the native updater's release manifest; native assets are retained.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub version: Version,
    pub channel: Channel,
    pub kind: Kind,
    pub security: bool,
    pub date: String,
    pub notes: Notes,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration_note: Option<Notes>,
    pub min_from_version: Version,
    #[serde(rename = "bundle")]
    pub bundle_digest: String,
    #[serde(rename = "tauri")]
    pub tauri_manifest_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native: Option<serde_json::Value>,
}
/// Persisted choices survive app replacement; skip timestamps allow security reminders.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateSettings {
    pub channel: Channel,
    pub held: bool,
    pub auto_patch: bool,
    pub quiet_hours: (u8, u8),
    pub skipped: BTreeMap<Version, u64>,
    pub later_until: Option<u64>,
    pub check_on_start: bool,
    pub last_check: Option<u64>,
}
impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            channel: Channel::Stable,
            held: false,
            auto_patch: true,
            quiet_hours: (3, 5),
            skipped: BTreeMap::new(),
            later_until: None,
            check_on_start: true,
            last_check: None,
        }
    }
}
impl UpdateSettings {
    /// Suppress this offer for 24 hours, or until the next app start.
    pub fn later(&mut self, now: u64) {
        self.later_until = Some(now.saturating_add(86400));
    }
    /// A restart may consume an expired reminder, but never bypass its 24-hour floor.
    pub fn next_start(&mut self, now: u64) {
        if self.later_until.is_some_and(|until| now >= until) {
            self.later_until = None;
        }
    }
    /// Remember the exact version and when it was skipped.
    pub fn skip(&mut self, release: &Release, now: u64) {
        self.skipped.insert(release.version.clone(), now);
    }
    /// Reject invalid hour ranges before persisting IPC input.
    pub fn validate(&self) -> Result<(), UpdateError> {
        if self.quiet_hours.0 > 23 || self.quiet_hours.1 > 23 || self.skipped.len() > 128 {
            Err(UpdateError::Settings)
        } else {
            Ok(())
        }
    }
}
/// Policy never installs minor/major automatically or downgrades across channels.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "action", content = "version", rename_all = "camelCase")]
pub enum Offer {
    None,
    Show,
    AutoInstall,
    NeedsIntermediate(Version),
}
/// Errors contain stable codes only, never publisher bodies or endpoint arguments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateError {
    Signature,
    Schema,
    Channel,
    Digest,
    Manifest,
    Network,
    Settings,
    Storage,
    Placeholder,
}
impl UpdateError {
    /// Safe IPC/log representation.
    pub fn code(self) -> &'static str {
        match self {
            Self::Signature => "update-signature",
            Self::Schema => "update-schema",
            Self::Channel => "update-channel",
            Self::Digest => "update-digest",
            Self::Manifest => "update-manifest",
            Self::Network => "update-network",
            Self::Settings => "update-settings",
            Self::Storage => "update-storage",
            Self::Placeholder => "update-key-not-provisioned",
        }
    }
}
/// Verify the exact bytes before parsing or showing anything.
pub fn verify_feed(
    bytes: &[u8],
    signature: &str,
    key: &str,
    channel: Channel,
) -> Result<Release, UpdateError> {
    if bytes.len() > 131072 || signature.len() > 8192 {
        return Err(UpdateError::Schema);
    }
    verify_payload(bytes, signature, key)?;
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| UpdateError::Schema)?;
    let schema = serde_json::from_str(include_str!("../../bundle/release.schema.json"))
        .map_err(|_| UpdateError::Schema)?;
    let validator = jsonschema::validator_for(&schema).map_err(|_| UpdateError::Schema)?;
    if !validator.is_valid(&value) {
        return Err(UpdateError::Schema);
    }
    let release: Release = serde_json::from_value(value).map_err(|_| UpdateError::Schema)?;
    if release.channel != channel {
        return Err(UpdateError::Channel);
    }
    chrono::NaiveDate::parse_from_str(&release.date, "%Y-%m-%d")
        .map_err(|_| UpdateError::Schema)?;
    if !release.version.build.is_empty() || !release.min_from_version.build.is_empty() {
        return Err(UpdateError::Schema);
    }
    if channel == Channel::Stable && !release.version.pre.is_empty() {
        return Err(UpdateError::Schema);
    }
    Ok(release)
}
/// Minisign validates both the data and trusted-comment signatures.
pub fn verify_payload(bytes: &[u8], signature: &str, key: &str) -> Result<(), UpdateError> {
    if key.contains("PLACEHOLDER") {
        return Err(UpdateError::Placeholder);
    }
    let key = minisign_verify::PublicKey::from_base64(key.trim())
        .or_else(|_| minisign_verify::PublicKey::decode(key.trim()))
        .map_err(|_| UpdateError::Signature)?;
    let sig = minisign_verify::Signature::decode(signature).map_err(|_| UpdateError::Signature)?;
    key.verify(bytes, &sig, false)
        .map_err(|_| UpdateError::Signature)
}
/// Injected local hour avoids treating UTC quiet hours as local quiet hours.
pub fn decide(
    r: &Release,
    running: &Version,
    s: &UpdateSettings,
    now: u64,
    hour: u8,
    agent_run_active: bool,
) -> Offer {
    if s.held || r.channel != s.channel || r.version <= *running {
        return Offer::None;
    }
    if let Some(skipped) = s.skipped.get(&r.version) {
        if !r.security || now.saturating_sub(*skipped) < 604800 {
            return Offer::None;
        }
    }
    if s.later_until.is_some_and(|until| now < until) {
        return Offer::None;
    }
    if *running < r.min_from_version {
        return Offer::NeedsIntermediate(r.min_from_version.clone());
    }
    let (a, b) = s.quiet_hours;
    let quiet = if a < b {
        hour >= a && hour < b
    } else if a > b {
        hour >= a || hour < b
    } else {
        false
    };
    // Do not trust a publisher's `kind=patch` to auto-install a minor/major.
    let patch = r.kind == Kind::Patch
        && r.version.major == running.major
        && r.version.minor == running.minor
        && r.version.patch > running.patch;
    if s.auto_patch && patch && quiet && !agent_run_active {
        Offer::AutoInstall
    } else {
        Offer::Show
    }
}
/// Rate-limit every attempt, including failures, and tolerate clock rollback safely.
#[derive(Default)]
pub struct CheckClock {
    last: Option<u64>,
}
impl CheckClock {
    /// Reserve the next check before network I/O.
    pub fn begin(&mut self, now: u64) -> bool {
        if self
            .last
            .is_some_and(|last| now.saturating_sub(last) < 21600)
        {
            false
        } else {
            self.last = Some(now);
            true
        }
    }
}
/// Load choices without resetting an explicit opt-out on failure.
pub fn load_settings(dir: &Path) -> Result<UpdateSettings, UpdateError> {
    match std::fs::read(dir.join("updates.json")) {
        Ok(bytes) => {
            if bytes.len() > 32768 {
                return Err(UpdateError::Settings);
            }
            let s: UpdateSettings =
                serde_json::from_slice(&bytes).map_err(|_| UpdateError::Settings)?;
            s.validate()?;
            Ok(s)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(UpdateSettings::default()),
        Err(_) => Err(UpdateError::Storage),
    }
}
/// Atomic private persistence shared by settings and pending update state.
pub fn write_private(dir: &Path, name: &str, value: &impl Serialize) -> Result<(), UpdateError> {
    std::fs::create_dir_all(dir).map_err(|_| UpdateError::Storage)?;
    let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|_| UpdateError::Storage)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| UpdateError::Storage)?;
    }
    file.write_all(&serde_json::to_vec_pretty(value).map_err(|_| UpdateError::Storage)?)
        .map_err(|_| UpdateError::Storage)?;
    file.as_file()
        .sync_all()
        .map_err(|_| UpdateError::Storage)?;
    file.persist(dir.join(name))
        .map_err(|_| UpdateError::Storage)?;
    Ok(())
}
/// Write settings only after checking bounded IPC fields.
pub fn save_settings(dir: &Path, s: &UpdateSettings) -> Result<(), UpdateError> {
    s.validate()?;
    write_private(dir, "updates.json", s)
}
/// Pin the exact Tauri manifest bytes, and reject a different product version.
pub fn verify_manifest(bytes: &[u8], r: &Release) -> Result<serde_json::Value, UpdateError> {
    if bytes.len() > 131072 || format!("{:x}", Sha256::digest(bytes)) != r.tauri_manifest_digest {
        return Err(UpdateError::Digest);
    }
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| UpdateError::Manifest)?;
    #[cfg(all(feature = "direct-updater", not(feature = "store")))]
    {
        let remote: tauri_plugin_updater::RemoteRelease =
            serde_json::from_value(value.clone()).map_err(|_| UpdateError::Manifest)?;
        if remote.version != r.version {
            return Err(UpdateError::Manifest);
        }
    }
    if value["version"].as_str() != Some(r.version.to_string().as_str()) {
        return Err(UpdateError::Manifest);
    }
    Ok(value)
}

/// Normalize raw or file-shaped public keys to Tauri's base64-wrapped minisign file.
pub fn tauri_public_key(key: &str) -> Result<String, UpdateError> {
    use base64::Engine;
    let raw = key.trim();
    if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(raw) {
        if let Ok(text) = std::str::from_utf8(&decoded) {
            if minisign_verify::PublicKey::decode(text).is_ok() {
                return Ok(raw.into());
            }
        }
    }
    let text = if minisign_verify::PublicKey::decode(raw).is_ok() {
        raw.to_owned()
    } else {
        minisign_verify::PublicKey::from_base64(raw).map_err(|_| UpdateError::Signature)?;
        format!("untrusted comment: PLUR1BUS updater public key\n{raw}\n")
    };
    Ok(base64::engine::general_purpose::STANDARD.encode(text))
}
