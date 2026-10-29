//! Bounded A13 import metadata shared with the isolated producer; never opens or parses package bytes.
use super::ExtError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::Path;

pub const MAX_METADATA: u64 = 64 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    pub schema: String,
    pub source: String,
    pub profile: Option<String>,
    pub name: String,
    pub fingerprint: String,
    pub transport: Transport,
    pub required_secrets: Vec<SecretSlot>,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Transport {
    Http { url: String, auth: HeaderAuth },
    Manual { runtime: ManualRuntime },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HeaderAuth {
    None,
    Header,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ManualRuntime {
    Node,
    Python,
    Binary,
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecretSlot {
    pub slot: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub schema: String,
    pub name: String,
    pub fingerprint: String,
    pub installation_id: String,
}

pub fn invalid() -> ExtError {
    ExtError::new(
        "E_INVALID_PARAMS",
        "package-invalid",
        "imported MCP metadata is invalid",
    )
}
pub fn hash(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
pub fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub fn valid_run(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
pub fn provenance_note(candidate_digest: &str, installation_id: &str) -> String {
    format!("Imported candidate SHA-256: {candidate_digest}. Installation: {installation_id}. Disabled; no capability acknowledgement.")
}

impl Candidate {
    pub fn parse(value: &Value) -> Result<Self, ExtError> {
        if value.get("profile").is_none() {
            return Err(invalid());
        }
        if serde_json::to_vec(value).map_err(|_| invalid())?.len() > MAX_METADATA as usize {
            return Err(invalid());
        }
        let candidate: Self = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
        candidate.validate()?;
        Ok(candidate)
    }
    pub fn validate(&self) -> Result<(), ExtError> {
        let source = serde_json::from_str::<std::collections::BTreeMap<String, Value>>(
            include_str!("../../../../packages/core/src/import/source-catalog.json"),
        )
        .is_ok_and(|catalog| catalog.contains_key(&self.source));
        let label = |value: &str| {
            !value.is_empty()
                && value.len() <= 32
                && value
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        };
        if self.schema != "import.mcp-candidate/1"
            || !source
            || !plur1bus_ext::manifest::valid_name(&self.name)
            || !is_hash(&self.fingerprint)
            || self
                .profile
                .as_deref()
                .is_some_and(|profile| !label(profile))
            || self.required_secrets.len() > 64
            || self.reasons.len() > 16
        {
            return Err(invalid());
        }
        let mut slots = BTreeSet::new();
        for item in &self.required_secrets {
            let slot = item.slot.as_bytes();
            if slot.is_empty()
                || slot.len() > 64
                || !(slot[0].is_ascii_alphabetic() || slot[0] == b'_')
                || !slot
                    .iter()
                    .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
                || !slots.insert(&item.slot)
            {
                return Err(invalid());
            }
        }
        const REASONS: &[&str] = &[
            "invalid-secret-slot-manual-setup",
            "requester-oauth-manual-setup",
            "invalid-remote-url",
            "credential-or-unsupported-url",
            "unsupported-header-manual-setup",
            "external-command-manual-setup",
            "arguments-withheld",
            "working-directory-withheld",
        ];
        if self
            .reasons
            .iter()
            .any(|reason| !REASONS.contains(&reason.as_str()))
        {
            return Err(invalid());
        }
        if let Transport::Http { url, .. } = &self.transport {
            if url.len() > 4096 || url.chars().any(char::is_control) {
                return Err(invalid());
            }
            let parsed = reqwest::Url::parse(url).map_err(|_| invalid())?;
            if !matches!(parsed.scheme(), "http" | "https")
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.host_str().is_none()
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
    pub fn identity(&self) -> String {
        format!("imported/{}", self.name)
    }
    pub fn version(&self) -> String {
        format!("0.0.0-import.f{}", &self.fingerprint[..32])
    }
    pub fn digest(&self) -> Result<String, ExtError> {
        Ok(hash(&serde_json::to_vec(self).map_err(|_| invalid())?))
    }
}

impl Receipt {
    pub fn parse(value: &Value) -> Result<Self, ExtError> {
        let receipt: Self = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
        if receipt.schema != "import.extension-receipt/1"
            || !plur1bus_ext::manifest::valid_name(&receipt.name)
            || !is_hash(&receipt.fingerprint)
            || !is_hash(&receipt.installation_id)
        {
            return Err(invalid());
        }
        Ok(receipt)
    }
}

/** Metadata files must be regular and bounded. Private receipt reads additionally check ownership and permissions. */
pub fn read_metadata(path: &Path, private: bool) -> Result<Value, ExtError> {
    serde_json::from_slice(&read_metadata_bytes(path, private)?).map_err(|_| invalid())
}
pub fn read_metadata_bytes(path: &Path, private: bool) -> Result<Vec<u8>, ExtError> {
    #[cfg(windows)]
    if private {
        let user = plur1bus_rpc::win::user_sid().map_err(|_| invalid())?;
        let acl = plur1bus_rpc::win::file_dacl_report(path).map_err(|_| invalid())?;
        if !plur1bus_rpc::acl::run_writable_by_others(&acl, &user).is_empty() {
            return Err(invalid());
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|_| invalid())?;
    check_file(&file, private)?;
    let mut bytes = Vec::new();
    file.take(MAX_METADATA + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() > MAX_METADATA as usize {
        return Err(invalid());
    }
    Ok(bytes)
}
fn check_file(file: &File, private: bool) -> Result<(), ExtError> {
    let metadata = file.metadata().map_err(|_| invalid())?;
    if !metadata.is_file() || metadata.len() > MAX_METADATA {
        return Err(invalid());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if private
            && (metadata.uid() != unsafe { libc::geteuid() }
                || metadata.mode() & 0o077 != 0
                || metadata.nlink() != 1)
        {
            return Err(invalid());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err(invalid());
        }
        let _ = private;
    }
    Ok(())
}
