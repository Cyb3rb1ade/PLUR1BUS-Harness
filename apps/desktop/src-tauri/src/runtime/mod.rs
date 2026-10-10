//! Local-only container runtimes; container policy lives in `spec`.
pub mod apple;
pub mod detect;
pub mod docker;
pub mod spec;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
pub use spec::ContainerSpec;
use std::{collections::BTreeMap, net::IpAddr, path::Path, time::Duration};
pub type Labels = BTreeMap<String, String>;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Apple,
    Docker,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeInfo {
    pub kind: RuntimeKind,
    pub endpoint: String,
    pub version: String,
    pub engine: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeError {
    NotFound,
    TooOld { found: String, min: String },
    NoAccess(String),
    WrongMode,
    Stopped,
    NotFoundObject(String),
    Conflict(String),
    Timeout(&'static str),
    Failed(String),
}
impl RuntimeError {
    pub fn message_key(&self) -> &'static str {
        match self {
            Self::NotFound => "runtime.not-found",
            Self::TooOld { .. } => "runtime.too-old",
            Self::NoAccess(_) => "runtime.no-access",
            Self::WrongMode => "runtime.wrong-mode",
            Self::Stopped => "runtime.stopped",
            Self::NotFoundObject(_) => "runtime.object-missing",
            Self::Conflict(_) => "runtime.conflict",
            Self::Timeout(_) => "runtime.timeout",
            Self::Failed(_) => "runtime.failed",
        }
    }
}
impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message_key())
    }
}
impl std::error::Error for RuntimeError {}
#[derive(Debug)]
pub struct ExecOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
#[derive(Clone, Debug, Default)]
pub struct ContainerState {
    pub exists: bool,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub image_digest: Option<String>,
    pub labels: Labels,
    pub ip: Option<IpAddr>,
}
#[async_trait]
pub trait Runtime: Send + Sync {
    fn info(&self) -> &RuntimeInfo;
    async fn ping(&self) -> Result<(), RuntimeError>;
    async fn ensure_started(&self) -> Result<(), RuntimeError>;
    async fn image_present(&self, digest: &str) -> Result<bool, RuntimeError>;
    async fn image_load(&self, tar: &Path) -> Result<String, RuntimeError>;
    async fn image_pull(&self, reference: &str, digest: &str) -> Result<(), RuntimeError>;
    async fn volume_ensure(
        &self,
        name: &str,
        size_gib: u32,
        labels: &Labels,
    ) -> Result<(), RuntimeError>;
    /// Read-only availability/ownership query for the manual rollback offer.
    async fn volume_present(&self, _name: &str, _labels: &Labels) -> Result<bool, RuntimeError> {
        Ok(false)
    }
    async fn volume_remove(&self, name: &str) -> Result<(), RuntimeError>;
    async fn volume_remove_owned(&self, name: &str, _labels: &Labels) -> Result<(), RuntimeError> {
        self.volume_remove(name).await
    }
    async fn network_ensure(&self, name: &str, internal: bool) -> Result<(), RuntimeError>;
    async fn network_ensure_labeled(
        &self,
        name: &str,
        internal: bool,
        _labels: &Labels,
    ) -> Result<(), RuntimeError> {
        self.network_ensure(name, internal).await
    }
    async fn published_ports(
        &self,
        _except: &str,
    ) -> Result<std::collections::BTreeSet<u16>, RuntimeError> {
        Ok(std::collections::BTreeSet::new())
    }
    async fn image_remove(&self, _digest: &str) -> Result<(), RuntimeError> {
        Err(RuntimeError::Failed("image-remove-unavailable".into()))
    }
    async fn network_remove(&self, _name: &str) -> Result<(), RuntimeError> {
        Err(RuntimeError::Failed("network-remove-unavailable".into()))
    }
    async fn restart_system(&self) -> Result<(), RuntimeError> {
        Err(RuntimeError::Stopped)
    }

    async fn create(&self, spec: &ContainerSpec) -> Result<(), RuntimeError>;
    async fn start(&self, name: &str) -> Result<(), RuntimeError>;
    async fn stop(&self, name: &str, timeout: Duration) -> Result<(), RuntimeError>;
    async fn rename(&self, from: &str, to: &str) -> Result<(), RuntimeError>;
    async fn remove(&self, name: &str) -> Result<(), RuntimeError>;
    async fn state(&self, name: &str) -> Result<ContainerState, RuntimeError>;
    async fn list_labeled(&self, label: &str) -> Result<Vec<String>, RuntimeError>;
    async fn logs_tail(&self, name: &str, lines: u32) -> Result<String, RuntimeError>;
    async fn exec(
        &self,
        name: &str,
        argv: &[&str],
        stdin: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<ExecOutput, RuntimeError>;
    async fn run_oneshot(
        &self,
        spec: &ContainerSpec,
        timeout: Duration,
    ) -> Result<ExecOutput, RuntimeError>;
}
