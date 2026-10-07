//! Signed Apple CLI adapter. Only consumed JSON fields are required.
use super::*;
use serde::Deserialize;
use std::{path::PathBuf, process::Stdio, sync::Arc};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[async_trait]
pub trait Cli: Send + Sync {
    async fn run(
        &self,
        argv: &[String],
        stdin: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<ExecOutput, RuntimeError>;
}
pub struct SignedCli {
    path: PathBuf,
}
impl SignedCli {
    pub async fn verify(path: PathBuf, team: &str) -> Result<Self, RuntimeError> {
        #[cfg(target_os = "macos")]
        {
            let verified = tokio::process::Command::new("/usr/bin/codesign")
                .args([
                    "--verify",
                    "--strict",
                    "-R",
                    &format!("anchor apple generic and certificate leaf[subject.OU] = \"{team}\""),
                ])
                .arg(&path)
                .kill_on_drop(true)
                .output();
            let out = tokio::time::timeout(Duration::from_secs(2), verified)
                .await
                .map_err(|_| RuntimeError::Timeout("signature"))?
                .map_err(|_| RuntimeError::NoAccess("apple-signature".into()))?;
            if !out.status.success() {
                return Err(RuntimeError::NoAccess("apple-signature".into()));
            }
            Ok(Self { path })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (path, team);
            Err(RuntimeError::NotFound)
        }
    }
}
#[async_trait]
impl Cli for SignedCli {
    async fn run(
        &self,
        argv: &[String],
        stdin: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<ExecOutput, RuntimeError> {
        let mut child = tokio::process::Command::new(&self.path)
            .args(argv)
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => RuntimeError::NotFound,
                std::io::ErrorKind::PermissionDenied => RuntimeError::NoAccess("apple-cli".into()),
                _ => RuntimeError::Failed("apple-spawn".into()),
            })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| RuntimeError::Failed("apple-stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| RuntimeError::Failed("apple-stderr".into()))?;
        let input = child.stdin.take();
        tokio::time::timeout(timeout, async {
            let write = async {
                if let (Some(mut input), Some(bytes)) = (input, stdin) {
                    input.write_all(bytes).await?;
                    input.shutdown().await?
                }
                Ok::<_, std::io::Error>(())
            };
            let read = |pipe: Box<dyn tokio::io::AsyncRead + Unpin + Send>| async move {
                let mut bytes = vec![];
                pipe.take(8 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .await?;
                Ok::<_, std::io::Error>(bytes)
            };
            let ((), stdout, stderr) =
                tokio::try_join!(write, read(Box::new(stdout)), read(Box::new(stderr)))
                    .map_err(|_| RuntimeError::Failed("apple-io".into()))?;
            if stdout.len() + stderr.len() > 8 * 1024 * 1024 {
                return Err(RuntimeError::Failed("apple-output-limit".into()));
            }
            let status = child
                .wait()
                .await
                .map_err(|_| RuntimeError::Failed("apple-wait".into()))?;
            Ok(ExecOutput {
                code: status.code().unwrap_or(1),
                stdout,
                stderr,
            })
        })
        .await
        .map_err(|_| RuntimeError::Timeout("apple-cli"))?
    }
}
#[derive(Deserialize)]
struct Version {
    #[serde(rename = "appName")]
    app_name: String,
    version: String,
}
pub fn parse_version(bytes: &[u8], min: &str) -> Result<String, RuntimeError> {
    let list: Vec<Version> = serde_json::from_slice(bytes)
        .map_err(|_| RuntimeError::Failed("apple-version-shape".into()))?;
    let v = list
        .into_iter()
        .find(|v| v.app_name == "container")
        .ok_or_else(|| RuntimeError::Failed("apple-version-shape".into()))?
        .version;
    let parts = |v: &str| -> Result<Vec<u32>, RuntimeError> {
        let p = v
            .strip_prefix('v')
            .unwrap_or(v)
            .split('.')
            .map(str::parse::<u32>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| RuntimeError::Failed("apple-version-shape".into()))?;
        if p.len() != 3 {
            return Err(RuntimeError::Failed("apple-version-shape".into()));
        }
        Ok(p)
    };
    if parts(&v)? < parts(min)? {
        Err(RuntimeError::TooOld {
            found: v,
            min: min.into(),
        })
    } else {
        Ok(v)
    }
}
#[derive(Deserialize)]
struct Status {
    status: String,
}
pub fn parse_status(bytes: &[u8]) -> Result<bool, RuntimeError> {
    let v: Status = serde_json::from_slice(bytes)
        .map_err(|_| RuntimeError::Failed("apple-status-shape".into()))?;
    match v.status.as_str() {
        "running" => Ok(true),
        "not running" | "unregistered" => Ok(false),
        _ => Err(RuntimeError::Failed("apple-status-shape".into())),
    }
}
pub fn create_argv(s: &ContainerSpec) -> Result<Vec<String>, RuntimeError> {
    s.validate()?;
    let mut a = vec![
        "create".into(),
        "--name".into(),
        s.name.clone(),
        "-m".into(),
        format!("{}M", s.memory_mib),
        "-c".into(),
        s.cpus.to_string(),
        "--read-only".into(),
        "--user".into(),
        "10001:10001".into(),
        "--tmpfs".into(),
        "/tmp".into(),
    ];
    if let Some(p) = s.host_port {
        a.extend(["-p".into(), format!("127.0.0.1:{p}:18700")])
    }
    for (v, p, ro) in &s.volumes {
        a.extend([
            "-v".into(),
            format!("{v}:{p}{}", if *ro { ":ro" } else { "" }),
        ])
    }
    for (k, v) in &s.env {
        a.extend(["-e".into(), format!("{k}={v}")])
    }
    for (k, v) in &s.labels {
        a.extend(["-l".into(), format!("{k}={v}")])
    }
    if let Some(n) = &s.network {
        a.extend(["--network".into(), n.clone()])
    }
    a.push(s.image_digest.clone());
    if let Some(cmd) = &s.cmd {
        a.extend(cmd.clone())
    }
    Ok(a)
}
pub struct AppleRuntime {
    cli: Arc<dyn Cli>,
    info: RuntimeInfo,
}
impl AppleRuntime {
    pub async fn detect() -> Result<Self, RuntimeError> {
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            return Err(RuntimeError::NotFound);
        }
        let path = PathBuf::from("/usr/local/bin/container");
        if !path.exists() {
            return Err(RuntimeError::NotFound);
        }
        let cli = SignedCli::verify(path.clone(), "UPBK2H6LZM").await?;
        Self::with_cli(Arc::new(cli), path.to_string_lossy().into(), "1.3.0").await
    }
    pub async fn with_cli(
        cli: Arc<dyn Cli>,
        endpoint: String,
        min: &str,
    ) -> Result<Self, RuntimeError> {
        let v = cli
            .run(
                &[
                    "system".into(),
                    "version".into(),
                    "--format".into(),
                    "json".into(),
                ],
                None,
                Duration::from_secs(3),
            )
            .await?;
        let version = parse_version(&v.stdout, min)?;
        Ok(Self {
            cli,
            info: RuntimeInfo {
                kind: RuntimeKind::Apple,
                endpoint,
                version,
                engine: "Apple container".into(),
            },
        })
    }
    async fn raw(&self, args: &[&str], timeout: Duration) -> Result<ExecOutput, RuntimeError> {
        self.cli
            .run(
                &args.iter().map(|s| (*s).into()).collect::<Vec<_>>(),
                None,
                timeout,
            )
            .await
    }
    async fn checked(&self, args: &[&str]) -> Result<ExecOutput, RuntimeError> {
        check(self.raw(args, Duration::from_secs(300)).await?)
    }
}
fn check(out: ExecOutput) -> Result<ExecOutput, RuntimeError> {
    if out.code == 0 {
        Ok(out)
    } else {
        let s = String::from_utf8_lossy(&out.stderr).to_ascii_lowercase();
        if s.contains("notfound") || s.contains("not found") {
            Err(RuntimeError::NotFoundObject("apple-object".into()))
        } else if s.contains("alreadyexists") || s.contains("already exists") {
            Err(RuntimeError::Conflict("apple-object".into()))
        } else if s.contains("permission") {
            Err(RuntimeError::NoAccess("apple-cli".into()))
        } else {
            Err(RuntimeError::Failed("apple-cli".into()))
        }
    }
}
#[derive(Deserialize)]
struct Image {
    configuration: ImageConfig,
}
#[derive(Deserialize)]
struct ImageConfig {
    descriptor: Descriptor,
}
#[derive(Deserialize)]
struct Descriptor {
    digest: String,
}
#[derive(Deserialize)]
struct Inspect {
    configuration: Configuration,
    status: ContainerStatus,
}
#[derive(Deserialize)]
struct ContainerStatus {
    state: String,
}
#[derive(Deserialize)]
struct Configuration {
    id: String,
    labels: Labels,
    image: ImageRef,
}
#[derive(Deserialize)]
struct ImageRef {
    reference: String,
}
pub fn parse_state(bytes: &[u8], name: &str) -> Result<ContainerState, RuntimeError> {
    let v: Vec<Inspect> = serde_json::from_slice(bytes)
        .map_err(|_| RuntimeError::Failed("apple-inspect-shape".into()))?;
    let v = v
        .into_iter()
        .find(|v| v.configuration.id == name)
        .ok_or_else(|| RuntimeError::Failed("apple-inspect-missing".into()))?;
    if !matches!(
        v.status.state.as_str(),
        "running" | "stopped" | "created" | "exited"
    ) {
        return Err(RuntimeError::Failed("apple-status-shape".into()));
    }
    Ok(ContainerState {
        exists: true,
        running: v.status.state == "running",
        exit_code: None,
        image_digest: Some(v.configuration.image.reference),
        labels: v.configuration.labels,
        ip: None,
    })
}
struct OwnedCleanup {
    cli: Arc<dyn Cli>,
    name: String,
    armed: bool,
}
impl Drop for OwnedCleanup {
    fn drop(&mut self) {
        if self.armed {
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                let cli = self.cli.clone();
                let name = self.name.clone();
                handle.spawn(async move {
                    let _ = cli
                        .run(
                            &["delete".into(), "--force".into(), name],
                            None,
                            Duration::from_secs(10),
                        )
                        .await;
                });
            }
        }
    }
}
#[async_trait]
impl Runtime for AppleRuntime {
    fn info(&self) -> &RuntimeInfo {
        &self.info
    }
    async fn ping(&self) -> Result<(), RuntimeError> {
        let o = self
            .raw(
                &["system", "status", "--format", "json"],
                Duration::from_secs(2),
            )
            .await?;
        if parse_status(&o.stdout)? {
            Ok(())
        } else {
            Err(RuntimeError::Stopped)
        }
    }
    async fn ensure_started(&self) -> Result<(), RuntimeError> {
        match self.ping().await {
            Ok(()) => Ok(()),
            Err(RuntimeError::Stopped) => {
                self.checked(&["system", "start"]).await?;
                self.ping().await
            }
            Err(e) => Err(e),
        }
    }
    async fn image_present(&self, digest: &str) -> Result<bool, RuntimeError> {
        match self.checked(&["image", "inspect", digest]).await {
            Ok(o) => {
                let images: Vec<Image> = serde_json::from_slice(&o.stdout)
                    .map_err(|_| RuntimeError::Failed("apple-image-shape".into()))?;
                Ok(images.iter().any(|i| {
                    i.configuration.descriptor.digest == digest.rsplit('@').next().unwrap_or(digest)
                }))
            }
            Err(RuntimeError::NotFoundObject(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }
    async fn image_load(&self, tar: &Path) -> Result<String, RuntimeError> {
        let path = tar
            .to_str()
            .ok_or_else(|| RuntimeError::Failed("archive-path".into()))?;
        let o = self.checked(&["image", "load", "--input", path]).await?;
        let text = std::str::from_utf8(&o.stdout)
            .map_err(|_| RuntimeError::Failed("apple-load-shape".into()))?;
        let reference = text
            .lines()
            .last()
            .filter(|r| !r.is_empty() && !r.starts_with('-') && !r.contains(char::is_whitespace))
            .ok_or_else(|| RuntimeError::Failed("apple-load-reference".into()))?;
        let inspected = self.checked(&["image", "inspect", reference]).await?;
        let images: Vec<Image> = serde_json::from_slice(&inspected.stdout)
            .map_err(|_| RuntimeError::Failed("apple-image-shape".into()))?;
        if images.len() != 1 {
            return Err(RuntimeError::Failed("apple-load-image-count".into()));
        }
        Ok(images[0].configuration.descriptor.digest.clone())
    }
    async fn image_pull(&self, reference: &str, digest: &str) -> Result<(), RuntimeError> {
        if !spec::valid_digest(digest) {
            return Err(RuntimeError::Failed("invalid-image-digest".into()));
        }
        let pinned = format!(
            "{}@{digest}",
            reference.split('@').next().unwrap_or(reference)
        );
        self.checked(&["image", "pull", &pinned]).await?;
        if self.image_present(&pinned).await? {
            Ok(())
        } else {
            Err(RuntimeError::Failed("image-digest-mismatch".into()))
        }
    }
    async fn volume_ensure(
        &self,
        name: &str,
        size_gib: u32,
        labels: &Labels,
    ) -> Result<(), RuntimeError> {
        match self.checked(&["volume", "inspect", name]).await {
            Ok(o) => {
                let v: serde_json::Value = serde_json::from_slice(&o.stdout)
                    .map_err(|_| RuntimeError::Failed("apple-volume-shape".into()))?;
                let owned = v
                    .get(0)
                    .and_then(|v| v.pointer("/configuration/labels"))
                    .and_then(|v| serde_json::from_value::<Labels>(v.clone()).ok())
                    .is_some_and(|l| labels.iter().all(|(k, v)| l.get(k) == Some(v)));
                return if owned {
                    Ok(())
                } else {
                    Err(RuntimeError::Conflict("foreign-volume".into()))
                };
            }
            Err(RuntimeError::NotFoundObject(_)) => {}
            Err(e) => return Err(e),
        }
        let mut args = vec![
            "volume".into(),
            "create".into(),
            "-s".into(),
            format!("{size_gib}G"),
        ];
        for (k, v) in labels {
            args.extend(["--label".into(), format!("{k}={v}")])
        }
        args.push(name.into());
        check(self.cli.run(&args, None, Duration::from_secs(60)).await?).map(|_| ())
    }
    async fn volume_remove(&self, name: &str) -> Result<(), RuntimeError> {
        self.checked(&["volume", "delete", name]).await.map(|_| ())
    }
    async fn network_ensure(&self, name: &str, internal: bool) -> Result<(), RuntimeError> {
        match self.checked(&["network", "inspect", name]).await {
            Ok(o) => {
                let v: serde_json::Value = serde_json::from_slice(&o.stdout)
                    .map_err(|_| RuntimeError::Failed("apple-network-shape".into()))?;
                let c = v
                    .get(0)
                    .and_then(|v| v.get("configuration"))
                    .ok_or_else(|| RuntimeError::Failed("apple-network-shape".into()))?;
                if c.pointer("/labels/app.plur1bus.role")
                    .and_then(|v| v.as_str())
                    == Some("network")
                    && c.get("mode").and_then(|v| v.as_str())
                        == Some(if internal { "hostOnly" } else { "nat" })
                {
                    return Ok(());
                }
                return Err(RuntimeError::Conflict("foreign-network".into()));
            }
            Err(RuntimeError::NotFoundObject(_)) => {}
            Err(e) => return Err(e),
        }
        let mut a = vec!["network", "create", "--label", "app.plur1bus.role=network"];
        if internal {
            a.push("--internal")
        }
        a.push(name);
        self.checked(&a).await.map(|_| ())
    }
    async fn create(&self, spec: &ContainerSpec) -> Result<(), RuntimeError> {
        check(
            self.cli
                .run(&create_argv(spec)?, None, Duration::from_secs(60))
                .await?,
        )
        .map(|_| ())
    }
    async fn start(&self, name: &str) -> Result<(), RuntimeError> {
        self.checked(&["start", name]).await.map(|_| ())
    }
    async fn stop(&self, name: &str, timeout: Duration) -> Result<(), RuntimeError> {
        self.checked(&["stop", "-t", &timeout.as_secs().to_string(), name])
            .await
            .map(|_| ())
    }
    async fn rename(&self, _from: &str, _to: &str) -> Result<(), RuntimeError> {
        Err(RuntimeError::Failed("apple-rename-unavailable".into()))
    }
    async fn remove(&self, name: &str) -> Result<(), RuntimeError> {
        self.checked(&["delete", name]).await.map(|_| ())
    }
    async fn state(&self, name: &str) -> Result<ContainerState, RuntimeError> {
        match self.checked(&["inspect", name]).await {
            Ok(o) => parse_state(&o.stdout, name),
            Err(RuntimeError::NotFoundObject(_)) => Ok(ContainerState::default()),
            Err(e) => Err(e),
        }
    }
    async fn list_labeled(&self, label: &str) -> Result<Vec<String>, RuntimeError> {
        let o = self.checked(&["list", "--all", "--format", "json"]).await?;
        let v: Vec<Inspect> = serde_json::from_slice(&o.stdout)
            .map_err(|_| RuntimeError::Failed("apple-list-shape".into()))?;
        let (key, value) = label
            .split_once('=')
            .map(|(k, v)| (k, Some(v)))
            .unwrap_or((label, None));
        Ok(v.into_iter()
            .filter(|v| {
                v.configuration
                    .labels
                    .get(key)
                    .is_some_and(|v| value.is_none_or(|wanted| v == wanted))
            })
            .map(|v| v.configuration.id)
            .collect())
    }
    async fn logs_tail(&self, name: &str, lines: u32) -> Result<String, RuntimeError> {
        let o = self
            .checked(&["logs", "-n", &lines.min(1000).to_string(), name])
            .await?;
        Ok(String::from_utf8_lossy(&o.stdout).into())
    }
    async fn exec(
        &self,
        name: &str,
        argv: &[&str],
        stdin: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<ExecOutput, RuntimeError> {
        let mut a = vec!["exec".into()];
        if stdin.is_some() {
            a.push("-i".into())
        }
        a.push(name.into());
        a.extend(argv.iter().map(|v| (*v).into()));
        self.cli.run(&a, stdin, timeout).await
    }
    async fn run_oneshot(
        &self,
        spec: &ContainerSpec,
        timeout: Duration,
    ) -> Result<ExecOutput, RuntimeError> {
        if spec.network.as_deref() != Some("none") || spec.restart || spec.host_port.is_some() {
            return Err(RuntimeError::Failed("oneshot-policy".into()));
        }
        self.create(spec).await?;
        let mut guard = OwnedCleanup {
            cli: self.cli.clone(),
            name: spec.name.clone(),
            armed: true,
        };
        let result = self
            .cli
            .run(
                &["start".into(), "--attach".into(), spec.name.clone()],
                None,
                timeout,
            )
            .await;
        let cleanup = check(
            self.cli
                .run(
                    &["delete".into(), "--force".into(), spec.name.clone()],
                    None,
                    Duration::from_secs(10),
                )
                .await?,
        )
        .map(|_| ());
        if cleanup.is_ok() {
            guard.armed = false
        }
        match result {
            Ok(o) => {
                cleanup?;
                Ok(o)
            }
            Err(e) => Err(e),
        }
    }
}
