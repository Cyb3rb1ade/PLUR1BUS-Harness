//! Public connection metadata. Credentials and CA certificates never enter this file.
use crate::secrets::{token_account, TokenStore};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Origin(String);
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OriginError {
    Invalid,
    Scheme,
    InsecureRemote,
    HasUserinfo,
    HasPath,
}
impl std::fmt::Display for OriginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid origin: {self:?}")
    }
}
impl TryFrom<String> for Origin {
    type Error = OriginError;
    fn try_from(v: String) -> Result<Self, Self::Error> {
        Self::parse(&v)
    }
}
impl From<Origin> for String {
    fn from(v: Origin) -> String {
        v.0
    }
}
impl Origin {
    pub fn parse(input: &str) -> Result<Self, OriginError> {
        if input.len() > 2048
            || input.chars().any(|c| c.is_whitespace() || c.is_control())
            || input.contains('\\')
        {
            return Err(OriginError::Invalid);
        }
        let (scheme, rest) = input.split_once("://").ok_or(OriginError::Invalid)?;
        if !["http", "https"].contains(&scheme.to_ascii_lowercase().as_str()) {
            return Err(OriginError::Scheme);
        }
        if rest.contains('@') {
            return Err(OriginError::HasUserinfo);
        }
        if rest.contains(['?', '#']) {
            return Err(OriginError::HasPath);
        }
        let authority = rest.strip_suffix('/').unwrap_or(rest);
        if authority.contains('%') {
            return Err(OriginError::Invalid);
        }
        if authority.contains('/') {
            return Err(OriginError::HasPath);
        }
        let url = url::Url::parse(input).map_err(|_| OriginError::Invalid)?;
        let host = url.host_str().ok_or(OriginError::Invalid)?;
        // URL parsers turn abbreviated/octal/hex IPv4 into loopback: reject the original spelling.
        if matches!(url.host(), Some(url::Host::Ipv4(_))) {
            let raw = authority.split(':').next().unwrap_or("");
            if raw != host {
                return Err(OriginError::Invalid);
            }
        }
        if url.scheme() == "http" && !["127.0.0.1", "[::1]", "localhost"].contains(&host) {
            return Err(OriginError::InsecureRemote);
        }
        Ok(Self(url.origin().ascii_serialization()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn is_loopback(&self) -> bool {
        url::Url::parse(&self.0)
            .ok()
            .is_some_and(|u| matches!(u.host_str(), Some("127.0.0.1" | "[::1]" | "localhost")))
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct CertPin(String);
impl CertPin {
    pub fn parse(s: &str) -> Result<Self, String> {
        let value = s.strip_prefix("sha256:").ok_or("invalid pin")?;
        let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| "invalid pin")?;
        if bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&bytes) != value {
            return Err("invalid pin".into());
        }
        Ok(Self(s.into()))
    }
    pub fn of(der: &[u8]) -> Self {
        use sha2::Digest;
        Self(format!(
            "sha256:{}",
            URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(der))
        ))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<String> for CertPin {
    type Error = String;
    fn try_from(v: String) -> Result<Self, String> {
        Self::parse(&v)
    }
}
impl From<CertPin> for String {
    fn from(v: CertPin) -> String {
        v.0
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Bundled,
    Local,
    Remote,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Apple,
    Docker,
    Podman,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BundledRef {
    pub runtime: RuntimeKind,
    pub endpoint: String,
    pub container: String,
    pub image_digest: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Connection {
    pub id: Uuid,
    pub name: String,
    pub kind: Kind,
    pub origin: Origin,
    pub installation_id: String,
    pub device_id: String,
    pub token_hint: String,
    pub bundled: Option<BundledRef>,
    pub cert_pin: Option<CertPin>,
    pub ca_pin: Option<CertPin>,
    pub next_cert_pin: Option<CertPin>,
    pub next_ca_pin: Option<CertPin>,
    #[serde(default)]
    pub pairing_needed: bool,
    #[serde(default)]
    pub observed_cert_pin: Option<CertPin>,
}
impl Connection {
    pub fn new(
        name: String,
        kind: Kind,
        origin: Origin,
        installation_id: String,
        device_id: String,
        token_hint: String,
    ) -> Self {
        Self {
            id: Uuid::now_v7(),
            name,
            kind,
            origin,
            installation_id,
            device_id,
            token_hint,
            bundled: None,
            cert_pin: None,
            ca_pin: None,
            next_cert_pin: None,
            next_ca_pin: None,
            pairing_needed: false,
            observed_cert_pin: None,
        }
    }
    fn validate(&self) -> Result<(), StoreError> {
        if self.name.trim().is_empty()
            || self.name.len() > 120
            || self.name.chars().any(char::is_control)
            || self.installation_id.is_empty()
            || self.installation_id.len() > 256
            || self.device_id.len() > 256
            || self.token_hint.len() > 16
        {
            return Err(StoreError::Invalid);
        }
        if (self.cert_pin.is_some()
            || self.ca_pin.is_some()
            || self.next_cert_pin.is_some()
            || self.next_ca_pin.is_some())
            && (self.kind != Kind::Remote || !self.origin.as_str().starts_with("https://"))
        {
            return Err(StoreError::Invalid);
        }
        if self.cert_pin.is_some() && self.ca_pin.is_some()
            || self.next_cert_pin.is_some() && self.next_ca_pin.is_some()
        {
            return Err(StoreError::Invalid);
        }
        Ok(())
    }
}
#[derive(Debug, PartialEq, Eq)]
pub enum StoreError {
    Io,
    Invalid,
    Corrupt,
    Token,
}
impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "connection store: {self:?}")
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct File {
    version: u32,
    active: Option<Uuid>,
    ui_locale: String,
    connections: Vec<Connection>,
}
impl Default for File {
    fn default() -> Self {
        Self {
            version: 1,
            active: None,
            ui_locale: "system".into(),
            connections: vec![],
        }
    }
}
pub struct Store {
    path: PathBuf,
}
impl Store {
    pub fn open(dir: &Path) -> Self {
        Self {
            path: dir.join("connections.json"),
        }
    }
    fn read(&self) -> Result<File, StoreError> {
        let f = match fs::File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(File::default()),
            Err(_) => return Err(StoreError::Io),
        };
        let mut bytes = vec![];
        f.take(1_048_577)
            .read_to_end(&mut bytes)
            .map_err(|_| StoreError::Io)?;
        let parsed = serde_json::from_slice::<File>(&bytes).ok().filter(|v| {
            bytes.len() <= 1_048_576
                && v.version == 1
                && ["system", "de", "en"].contains(&v.ui_locale.as_str())
                && v.connections.iter().all(|c| c.validate().is_ok())
                && v.connections
                    .iter()
                    .map(|c| c.id)
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    == v.connections.len()
                && v.active
                    .is_none_or(|id| v.connections.iter().any(|c| c.id == id))
        });
        if let Some(v) = parsed {
            return Ok(v);
        }
        fs::rename(
            &self.path,
            self.path.with_file_name(format!(
                "connections.json.corrupt-{}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis(),
                Uuid::now_v7()
            )),
        )
        .map_err(|_| StoreError::Io)?;
        Err(StoreError::Corrupt)
    }
    fn write(&self, v: &File) -> Result<(), StoreError> {
        let dir = self.path.parent().ok_or(StoreError::Io)?;
        fs::create_dir_all(dir).map_err(|_| StoreError::Io)?;
        let mut f = tempfile::NamedTempFile::new_in(dir).map_err(|_| StoreError::Io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            f.as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|_| StoreError::Io)?;
        }
        f.write_all(&serde_json::to_vec_pretty(v).map_err(|_| StoreError::Invalid)?)
            .map_err(|_| StoreError::Io)?;
        f.as_file().sync_all().map_err(|_| StoreError::Io)?;
        f.persist(&self.path).map_err(|_| StoreError::Io)?;
        Ok(())
    }
    pub fn load(&self) -> Result<Vec<Connection>, StoreError> {
        Ok(self.read()?.connections)
    }
    pub fn upsert(&self, c: Connection) -> Result<(), StoreError> {
        c.validate()?;
        let mut v = self.read()?;
        if let Some(old) = v.connections.iter_mut().find(|old| old.id == c.id) {
            *old = c
        } else {
            v.connections.push(c)
        }
        self.write(&v)
    }
    pub fn active(&self) -> Result<Option<Uuid>, StoreError> {
        Ok(self.read()?.active)
    }
    pub fn set_active(&self, id: Uuid) -> Result<(), StoreError> {
        let mut v = self.read()?;
        if !v.connections.iter().any(|c| c.id == id) {
            return Err(StoreError::Invalid);
        }
        v.active = Some(id);
        self.write(&v)
    }
    pub fn remove(&self, id: Uuid, tokens: &dyn TokenStore) -> Result<(), StoreError> {
        let mut v = self.read()?;
        tokens
            .delete(&token_account(id))
            .map_err(|_| StoreError::Token)?;
        v.connections.retain(|c| c.id != id);
        if v.active == Some(id) {
            v.active = None
        }
        self.write(&v)
    }
}
