pub mod acquire;
pub mod autostart;
pub mod bundle;
pub mod lifecycle;
pub mod watch;
use crate::runtime::{Runtime, RuntimeError, RuntimeKind};
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Resources {
    pub memory_mib: u32,
    pub cpus: u32,
}
impl Default for Resources {
    fn default() -> Self {
        Self {
            memory_mib: 3072,
            cpus: std::thread::available_parallelism()
                .map(|n| n.get() as u32)
                .unwrap_or(1)
                .min(4),
        }
    }
}
impl Resources {
    pub fn validate(&self) -> Result<(), CtlError> {
        if !(2048..=16384).contains(&self.memory_mib) || self.cpus == 0 || self.cpus > 64 {
            Err(CtlError::Invalid)
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstallStep {
    Image,
    Volumes,
    Network,
    Container,
    Start,
    Owner,
    Pairing,
    Done,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum HarnessStatus {
    NotInstalled,
    Stopped,
    Starting,
    Ready {
        port: u16,
    },
    Crashed {
        exit_code: Option<i32>,
        log_tail: String,
    },
    RuntimeDown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Installed {
    pub runtime: RuntimeKind,
    pub endpoint: String,
    pub container: String,
    pub port: u16,
    pub image_digest: String,
    pub resources: Resources,
    pub installed_version: String,
    pub step: InstallStep,
}
#[derive(Debug, PartialEq, Eq)]
pub enum CtlError {
    Runtime(RuntimeError),
    Invalid,
    Storage,
    Bundle,
    ImageDigest,
    PortBusy,
    StartTimeout,
    NotInstalled,
    RuntimeChanged,
    ExecFailed {
        code: i32,
        error_code: Option<String>,
    },
    Health,
    Cancelled,
}
impl CtlError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Runtime(e) => e.message_key(),
            Self::Invalid => "invalid-resources",
            Self::Storage => "storage",
            Self::Bundle => "bundle",
            Self::ImageDigest => "digest-mismatch",
            Self::PortBusy => "port-in-use",
            Self::StartTimeout => "start-timeout",
            Self::NotInstalled => "not-installed",
            Self::RuntimeChanged => "runtime-changed",
            Self::ExecFailed { .. } => "exec-failed",
            Self::Health => "health",
            Self::Cancelled => "cancelled",
        }
    }
}
impl From<RuntimeError> for CtlError {
    fn from(e: RuntimeError) -> Self {
        Self::Runtime(e)
    }
}
#[async_trait::async_trait]
pub trait Health: Send + Sync {
    async fn ready(&self, port: u16) -> bool;
}
pub struct NativeHealth;
#[async_trait::async_trait]
impl Health for NativeHealth {
    async fn ready(&self, port: u16) -> bool {
        let Ok(origin) = crate::connections::Origin::parse(&format!("http://127.0.0.1:{port}"))
        else {
            return false;
        };
        crate::client::HarnessClient::new(origin, None)
            .meta()
            .await
            .is_ok()
    }
}
#[derive(Clone)]
pub struct Names {
    pub container: String,
    pub state: String,
    pub models: String,
    pub network: String,
    pub test: Option<String>,
}
impl Default for Names {
    fn default() -> Self {
        Self {
            container: crate::ids::CONTAINER.into(),
            state: "plur1bus-state".into(),
            models: "plur1bus-models".into(),
            network: "plur1bus".into(),
            test: None,
        }
    }
}
pub struct Controller {
    pub(crate) runtime: Arc<dyn Runtime>,
    pub(crate) bundle: bundle::Bundle,
    pub(crate) dir: PathBuf,
    pub(crate) resource_dir: PathBuf,
    pub(crate) health: Arc<dyn Health>,
    pub(crate) mutation: tokio::sync::Mutex<()>,
    pub(crate) names: Names,
    pub(crate) watcher: std::sync::Mutex<watch::Watch>,
}
impl Controller {
    pub fn new(runtime: Arc<dyn Runtime>, bundle: bundle::Bundle, dir: PathBuf) -> Self {
        Self::with_health(runtime, bundle, dir, Arc::new(NativeHealth))
    }
    pub fn with_health(
        runtime: Arc<dyn Runtime>,
        bundle: bundle::Bundle,
        dir: PathBuf,
        health: Arc<dyn Health>,
    ) -> Self {
        let kind = runtime.info().kind;
        Self {
            runtime,
            bundle,
            resource_dir: dir.join("resources"),
            dir,
            health,
            mutation: tokio::sync::Mutex::new(()),
            names: Names::default(),
            watcher: std::sync::Mutex::new(watch::Watch::new(kind)),
        }
    }
    #[cfg(debug_assertions)]
    pub fn with_test_namespace(mut self, id: &str) -> Result<Self, CtlError> {
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(CtlError::Invalid);
        }
        let p = format!("p1t-{id}");
        self.names = Names {
            container: format!("{p}-harness"),
            state: format!("{p}-state"),
            models: format!("{p}-models"),
            network: format!("{p}-network"),
            test: Some(id.into()),
        };
        Ok(self)
    }
    #[cfg(debug_assertions)]
    pub fn with_watch(mut self, watch: watch::Watch) -> Self {
        self.watcher = std::sync::Mutex::new(watch);
        self
    }
    pub fn with_resource_dir(mut self, dir: PathBuf) -> Self {
        self.resource_dir = dir;
        self
    }
    pub fn desired_running(&self) -> Result<bool, CtlError> {
        if !self.dir.join("desired.json").exists() {
            return Ok(true);
        }
        serde_json::from_str::<bool>(&read_private_json(&self.dir, "desired.json", 128)?)
            .map_err(|_| CtlError::Storage)
    }
    pub(crate) fn set_desired_running(&self, running: bool) -> Result<(), CtlError> {
        atomic_json(&self.dir, "desired.json", &running)
    }
    pub fn reconcile_connection_origins(
        &self,
        store: &crate::connections::Store,
        before: impl Fn(uuid::Uuid),
    ) -> Result<(), CtlError> {
        let installed = self.installed()?.ok_or(CtlError::NotInstalled)?;
        let origin =
            crate::connections::Origin::parse(&format!("http://127.0.0.1:{}", installed.port))
                .map_err(|_| CtlError::Invalid)?;
        for mut row in store.load().map_err(|_| CtlError::Storage)? {
            if row.kind == crate::connections::Kind::Bundled
                && row.bundled.as_ref().is_some_and(|b| {
                    b.endpoint == installed.endpoint && b.container == installed.container
                })
                && row.origin != origin
            {
                before(row.id);
                row.origin = origin.clone();
                store.upsert(row).map_err(|_| CtlError::Storage)?;
            }
        }
        Ok(())
    }
    pub fn info(&self) -> &crate::runtime::RuntimeInfo {
        self.runtime.info()
    }
    pub fn installed(&self) -> Result<Option<Installed>, CtlError> {
        let path = self.dir.join("installed.json");
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(CtlError::Storage),
        };
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 16384 {
            return Err(CtlError::Storage);
        }
        let text = read_private_json(&self.dir, "installed.json", 16384)?;
        let v: Installed = serde_json::from_str(&text).map_err(|_| CtlError::Storage)?;
        v.resources.validate()?;
        if !(18700..=18799).contains(&v.port)
            || v.container != self.names.container
            || !crate::runtime::spec::valid_digest(&v.image_digest)
        {
            return Err(CtlError::Storage);
        }
        if v.runtime != self.info().kind || v.endpoint != self.info().endpoint {
            return Err(CtlError::RuntimeChanged);
        }
        Ok(Some(v))
    }
    pub(crate) fn save(&self, v: &Installed) -> Result<(), CtlError> {
        atomic_json(&self.dir, "installed.json", v)
    }
    pub(crate) fn labels(&self, role: &str, digest: &str) -> crate::runtime::Labels {
        let mut l = crate::runtime::Labels::from([
            ("app.plur1bus.role".into(), role.into()),
            ("app.plur1bus.version".into(), self.bundle.version.clone()),
            ("app.plur1bus.image.digest".into(), digest.into()),
        ]);
        if let Some(id) = &self.names.test {
            l.insert("app.plur1bus.test".into(), id.clone());
        }
        l
    }
    pub(crate) fn spec(&self, installed: &Installed) -> crate::runtime::ContainerSpec {
        let mut s = crate::runtime::spec::harness_spec(
            &self.bundle,
            installed.port,
            &installed.resources,
            &[],
        );
        s.name = self.names.container.clone();
        s.volumes[0].0 = self.names.state.clone();
        s.volumes[1].0 = self.names.models.clone();
        s.network = Some(self.names.network.clone());
        s.labels = self.labels("harness", &installed.image_digest);
        s.image_digest = installed.image_digest.clone();
        s
    }
    pub async fn exec_json(
        &self,
        argv: &[&str],
        timeout: Duration,
    ) -> Result<serde_json::Value, CtlError> {
        if argv.first() != Some(&"plur1bus") {
            return Err(CtlError::Invalid);
        }
        crate::contract::exec::classify(&argv[1..]).ok_or(CtlError::Invalid)?;
        let installed = self.installed()?.ok_or(CtlError::NotInstalled)?;
        let state = self.runtime.state(&installed.container).await?;
        if !state.exists
            || state.labels.get("app.plur1bus.role").map(String::as_str) != Some("harness")
            || state.labels.get("app.plur1bus.image.digest") != Some(&installed.image_digest)
        {
            return Err(CtlError::Runtime(RuntimeError::Conflict(
                "foreign-container".into(),
            )));
        }
        let output = self
            .runtime
            .exec(&installed.container, argv, None, timeout)
            .await?;
        let bytes = zeroize::Zeroizing::new(output.stdout);
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(CtlError::Invalid);
        }
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| CtlError::Invalid)?;
        if output.code != 0 {
            let error_code = value
                .get("code")
                .and_then(|v| v.as_str())
                .filter(|s| s.len() <= 48 && s.bytes().all(|b| b.is_ascii_uppercase() || b == b'_'))
                .map(str::to_owned);
            return Err(CtlError::ExecFailed {
                code: output.code,
                error_code,
            });
        }
        Ok(value)
    }
    pub async fn logs_tail(&self, lines: u32) -> Result<String, CtlError> {
        let i = self.installed()?.ok_or(CtlError::NotInstalled)?;
        let raw = self.runtime.logs_tail(&i.container, lines.min(200)).await?;
        let f = crate::logging::Formatter::new(
            crate::logging::SecretRegistry::process(),
            Arc::new(crate::logging::CredentialPaths::new(
                std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .and_then(|v| v.into_string().ok())
                    .ok_or(CtlError::Health)?
                    .as_str(),
            )),
            true,
        );
        f.redact_text(&raw).map_err(|_| CtlError::Health)
    }
}

fn storage_path(dir: &Path) -> Result<PathBuf, CtlError> {
    // macOS exposes these root-owned aliases. Other symlink ancestry is refused by OwnedDirectory.
    #[cfg(target_os = "macos")]
    for alias in ["/var", "/tmp"] {
        if let Ok(rest) = dir.strip_prefix(alias) {
            return Ok(Path::new("/private")
                .join(alias.trim_start_matches('/'))
                .join(rest));
        }
    }
    Ok(dir.to_path_buf())
}
pub(crate) fn read_private_json(dir: &Path, name: &str, limit: usize) -> Result<String, CtlError> {
    let dir = storage_path(dir)?;
    crate::logging::storage::OwnedDirectory::open(&dir)
        .and_then(|d| d.read(name, limit))
        .map_err(|_| CtlError::Storage)
}
pub(crate) fn atomic_json<T: Serialize>(dir: &Path, name: &str, value: &T) -> Result<(), CtlError> {
    let dir = storage_path(dir)?;
    std::fs::create_dir_all(&dir).map_err(|_| CtlError::Storage)?;
    let owned =
        crate::logging::storage::OwnedDirectory::open(&dir).map_err(|_| CtlError::Storage)?;
    let target = owned.path().join(name);
    if std::fs::symlink_metadata(&target).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink())
    {
        return Err(CtlError::Storage);
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| CtlError::Storage)?;
    #[cfg(unix)]
    {
        let mut file =
            tempfile::NamedTempFile::new_in(owned.path()).map_err(|_| CtlError::Storage)?;
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| CtlError::Storage)?;
        }
        file.write_all(&bytes).map_err(|_| CtlError::Storage)?;
        file.as_file().sync_all().map_err(|_| CtlError::Storage)?;
        owned.check().map_err(|_| CtlError::Storage)?;
        file.persist(target).map_err(|_| CtlError::Storage)?;
    }
    #[cfg(windows)]
    {
        // A tempfile::NamedTempFile carries the directory's inherited DACL, which
        // OwnedDirectory::read rightly refuses (it requires the protected user+SYSTEM DACL).
        // Create the temporary through OwnedDirectory so it gets that DACL before any content is
        // written; MoveFileEx keeps the security descriptor on rename. The handle is closed first
        // because OwnedDirectory opens without FILE_SHARE_DELETE.
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING};

        let temp_name = format!("{name}.{}.tmp", uuid::Uuid::now_v7().simple());
        let temp = owned.path().join(&temp_name);
        let written = (|| -> std::io::Result<()> {
            let mut file = owned.create(&temp_name)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            owned.check()?;
            let from_wide: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
            let to_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
            let ok = unsafe {
                MoveFileExW(
                    from_wide.as_ptr(),
                    to_wide.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING,
                )
            };
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        })();
        if written.is_err() {
            let _ = std::fs::remove_file(&temp);
            return Err(CtlError::Storage);
        }
    }
    owned.sync().map_err(|_| CtlError::Storage)
}

pub fn daemon_is_ready(value: &serde_json::Value) -> bool {
    value.get("schema").and_then(|v| v.as_str()) == Some("daemon.status/1")
        && value
            .pointer("/supervisor/process/state")
            .and_then(|v| v.as_str())
            == Some("running")
        && value
            .get("children")
            .and_then(|v| v.as_array())
            .is_some_and(|children| {
                children
                    .iter()
                    .filter(|c| c.get("kind").and_then(|v| v.as_str()) != Some("module"))
                    .any(|c| c.pointer("/process/state").and_then(|v| v.as_str()) == Some("ready"))
            })
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UninstallLevel {
    AppOnly,
    AppAndImages,
    Everything,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UninstallStep {
    Container,
    Network,
    Images,
    Volumes,
    Keychain,
    Done,
}
