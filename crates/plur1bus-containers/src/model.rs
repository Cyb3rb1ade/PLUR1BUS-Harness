use crate::{LogStream, Result};
use serde::{Deserialize, Serialize};
use std::{net::IpAddr, path::Path};

pub const APPLE_VERSION: &str = "1.5.0";
// The mount path is shared by both adapters; it is not a chat slash command.
pub const STATE_PATH: &str = concat!("/", "state");
pub const OWNER_LABEL: &str = "app.plur1bus.stack";
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Docker,
    Apple,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Linux,
    MacArm,
    MacIntel,
    Windows,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeState {
    Ready,
    Stopped,
    Missing,
    PermissionDenied,
    Unsupported,
    Unreachable,
}
#[derive(Clone, Debug, Serialize)]
pub struct Detection {
    pub kind: RuntimeKind,
    pub version: Option<String>,
    pub state: RuntimeState,
    pub detail: String,
}
impl Detection {
    pub fn ready(kind: RuntimeKind, version: &str) -> Self {
        Self {
            kind,
            version: Some(version.into()),
            state: RuntimeState::Ready,
            detail: String::new(),
        }
    }
    pub fn failed(kind: RuntimeKind, state: RuntimeState, detail: impl Into<String>) -> Self {
        Self {
            kind,
            version: None,
            state,
            detail: detail.into(),
        }
    }
}
pub fn select_runtime(
    preferred: Option<RuntimeKind>,
    platform: Platform,
    detections: &[Detection],
) -> Result<RuntimeKind> {
    let ready = |k| {
        detections
            .iter()
            .any(|d| d.kind == k && d.state == RuntimeState::Ready)
    };
    if preferred == Some(RuntimeKind::Apple) && platform != Platform::MacArm {
        return Err("Apple container requires macOS on Apple Silicon".into());
    }
    if let Some(k) = preferred {
        return if ready(k) {
            Ok(k)
        } else {
            Err(format!(
                "configured runtime {k:?} is unavailable; inspect detection diagnostics"
            ))
        };
    }
    if platform == Platform::MacArm && ready(RuntimeKind::Apple) {
        return Ok(RuntimeKind::Apple);
    }
    if ready(RuntimeKind::Docker) {
        return Ok(RuntimeKind::Docker);
    }
    Err("no running supported runtime".into())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Mount {
    pub source: String,
    pub target: String,
    pub read_only: bool,
    pub bind: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Connection {
    pub env: String,
    pub service: String,
    pub scheme: String,
    pub port: u16,
    pub path: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Service {
    pub name: String,
    pub image: String,
    pub state_volume: String,
    pub network: String,
    pub bind: IpAddr,
    pub publish: Option<u16>,
    pub port: u16,
    pub user: String,
    pub memory: u64,
    pub pids: u32,
    #[serde(default)]
    pub egress: bool,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub entrypoint: Vec<String>,
    #[serde(default)]
    pub tmpfs: Vec<String>,
    pub env: Vec<String>,
    pub mounts: Vec<Mount>,
    pub health_command: Vec<String>,
    #[serde(default)]
    pub connections: Vec<Connection>,
}
impl Service {
    pub fn harness(image: &str) -> Self {
        Self {
            name: "plur1bus-harness".into(),
            image: image.into(),
            state_volume: "plur1bus-state".into(),
            network: "plur1bus-internal".into(),
            bind: "127.0.0.1".parse().unwrap(),
            publish: None,
            port: 18700,
            user: "10001:10001".into(),
            memory: 3 * 1024 * 1024 * 1024,
            pids: 1024,
            egress: true,
            command: vec![],
            entrypoint: vec![],
            tmpfs: vec![],
            env: vec![],
            mounts: vec![Mount {
                source: "plur1bus-state".into(),
                target: STATE_PATH.into(),
                read_only: false,
                bind: false,
            }],
            health_command: vec!["node".into(), "/opt/plur1bus/healthcheck.mjs".into()],
            connections: vec![],
        }
    }
    pub fn validate(&self) -> Result<()> {
        for name in [&self.name, &self.network, &self.state_volume] {
            validate_name(name)?;
        }
        if self.image.is_empty() || self.image.starts_with('-') {
            return Err("invalid image reference".into());
        }
        if !private_bind(self.bind) {
            return Err(
                "bind must be loopback, private LAN or Tailscale IP; wildcard/public API forbidden"
                    .into(),
            );
        }
        let mut user = self.user.split(':');
        let uid = user
            .next()
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|uid| *uid > 0);
        let gid_valid = user.next().is_none_or(|v| v.parse::<u32>().is_ok());
        if self.memory == 0
            || self.pids == 0
            || uid.is_none()
            || !gid_valid
            || user.next().is_some()
        {
            return Err("non-root numeric UID and positive resource limits required".into());
        }
        if self.health_command.is_empty() {
            return Err("health command required".into());
        }
        for c in &self.connections {
            validate_name(&c.service)?;
            if c.env.is_empty()
                || !c
                    .env
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                || c.scheme.is_empty()
                || !c.scheme.bytes().all(|b| b.is_ascii_lowercase())
                || c.port == 0
                || (!c.path.is_empty() && !c.path.starts_with('/'))
            {
                return Err("invalid service connection".into());
            }
        }
        for m in &self.mounts {
            if !m.target.starts_with('/') || m.source.contains(',') || m.target.contains(',') {
                return Err("invalid mount".into());
            }
            if m.bind && !m.read_only && m.target.starts_with(STATE_PATH) {
                return Err("state needs a runtime volume: host virtiofs/rootless bind UID and SQLite-WAL semantics are unsafe".into());
            }
            if !m.bind {
                validate_name(&m.source)?;
            }
        }
        Ok(())
    }
}
pub fn private_bind(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            v.is_loopback()
                || v.is_private()
                || (v.octets()[0] == 100 && (64..=127).contains(&v.octets()[1]))
        }
        IpAddr::V6(v) => v.is_loopback() || (v.segments()[0] & 0xfe00 == 0xfc00),
    }
}
pub(crate) fn validate_name(s: &str) -> Result<()> {
    if s.is_empty()
        || s.len() > 64
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || s.starts_with('-')
    {
        Err("invalid resource name".into())
    } else {
        Ok(())
    }
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct ContainerStatus {
    pub running: bool,
    pub healthy: bool,
    pub image: String,
    pub owned: bool,
}
/// Operations use bounded requests. `logs` owns a child and kills/reaps it on drop.
pub trait ContainerRuntime {
    fn detect(&self) -> Detection;
    fn ensure_running(&self) -> Result<()>;
    fn pull(&self, image: &str) -> Result<()>;
    fn image_available(&self, _image: &str) -> Result<bool> {
        Ok(false)
    }
    fn load(&self, tarball: &Path) -> Result<()>;
    fn create(&self, service: &Service) -> Result<()>;
    fn start(&self, name: &str) -> Result<()>;
    fn stop(&self, name: &str) -> Result<()>;
    fn remove(&self, name: &str) -> Result<()>;
    fn volume(&self, name: &str) -> Result<()>;
    fn network(&self, name: &str) -> Result<()>;
    fn remove_network(&self, name: &str) -> Result<()>;
    fn inspect(&self, service: &Service) -> Result<Option<ContainerStatus>>;
    fn exec(&self, name: &str, args: &[String]) -> Result<String>;
    fn logs(&self, name: &str) -> Result<LogStream>;
    fn address(&self, name: &str, _network: &str) -> Result<String> {
        validate_name(name)?;
        Ok(name.into())
    }
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            Self::MacArm
        } else if cfg!(target_os = "macos") {
            Self::MacIntel
        } else {
            Self::Linux
        }
    }
}
/// Production images are pinned to an OCI manifest/index digest, never a mutable tag.
pub fn validate_digest_image(image: &str) -> Result<()> {
    let (repository, digest) = image
        .rsplit_once("@sha256:")
        .ok_or("image must be digest-pinned")?;
    if repository.is_empty()
        || repository.starts_with('-')
        || repository.chars().any(char::is_whitespace)
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("invalid digest-pinned image".into());
    }
    Ok(())
}

/// Registry defaults used by both engines when normalising inspect results.
pub fn canonical_image(image: &str) -> String {
    let first = image.split('/').next().unwrap_or_default();
    let mut reference = if !image.contains('/') {
        format!("docker.io/library/{image}")
    } else if !first.contains('.') && !first.contains(':') && first != "localhost" {
        format!("docker.io/{image}")
    } else {
        image.to_string()
    };
    if let Some((base, digest)) = reference.split_once('@') {
        let repository = if base.rsplit('/').next().unwrap_or_default().contains(':') {
            base.rsplit_once(':').unwrap().0
        } else {
            base
        };
        reference = format!("{repository}@{digest}");
    }
    if !reference.contains('@')
        && !reference
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .contains(':')
    {
        reference.push_str(":latest");
    }
    reference
}
