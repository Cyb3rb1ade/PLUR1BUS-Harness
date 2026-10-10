use crate::{model::validate_name, process::run, *};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
#[derive(Clone, Debug)]
pub struct AppleContainerRuntime {
    pub cli: PathBuf,
    pub platform: Platform,
    pub macos_major: u32,
}
impl AppleContainerRuntime {
    pub fn new(cli: impl Into<PathBuf>, platform: Platform, macos_major: u32) -> Self {
        Self {
            cli: cli.into(),
            platform,
            macos_major,
        }
    }
    pub fn local() -> Self {
        let platform = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            Platform::MacArm
        } else {
            Platform::MacIntel
        };
        let version = Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        Self::new(
            "container",
            platform,
            version
                .split('.')
                .next()
                .unwrap_or_default()
                .parse()
                .unwrap_or(0),
        )
    }
    fn command(&self, args: &[String]) -> Command {
        let mut c = Command::new(&self.cli);
        c.args(args);
        c
    }
    fn quick(&self, args: &[&str]) -> Result<String> {
        run(
            self.command(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>()),
            None,
            Duration::from_secs(5),
        )
        .and_then(|b| String::from_utf8(b).map_err(|e| e.to_string()))
    }
    fn call(&self, args: &[&str]) -> Result<String> {
        self.call_owned(args.iter().map(|s| s.to_string()).collect())
    }
    fn call_owned(&self, args: Vec<String>) -> Result<String> {
        run(self.command(&args), None, Duration::from_secs(300))
            .and_then(|b| String::from_utf8(b).map_err(|e| e.to_string()))
    }
    fn resource(&self, kind: &str, name: &str, internal: bool) -> Result<()> {
        validate_name(name)?;
        let list = self.call(&[kind, "list", "--format", "json"])?;
        let entries: Value =
            serde_json::from_str(&list).map_err(|e| format!("Apple {kind} list: {e}"))?;
        for v in entries
            .as_array()
            .ok_or("Apple resource list not an array")?
        {
            if v["id"] == name || v["name"] == name {
                if v["configuration"]["labels"][OWNER_LABEL] != "distribution" {
                    return Err(format!("resource {name} belongs to another installation"));
                }
                if kind == "network"
                    && ((v["configuration"]["mode"] == "hostOnly") != internal)
                    && v["configuration"]["mode"].is_string()
                {
                    return Err(
                        "existing Apple network isolation differs from requested mode".into(),
                    );
                }
                return Ok(());
            }
        }
        let mut args = vec![
            kind.to_string(),
            "create".into(),
            "--label".into(),
            format!("{OWNER_LABEL}=distribution"),
        ];
        if kind == "network" && internal {
            args.push("--internal".into());
        }
        args.push(name.into());
        self.call_owned(args).map(|_| ())
    }
}
impl ContainerRuntime for AppleContainerRuntime {
    fn detect(&self) -> Detection {
        if self.platform != Platform::MacArm || self.macos_major < 26 {
            return Detection::failed(
                RuntimeKind::Apple,
                RuntimeState::Unsupported,
                "Apple container 1.5.0 requires macOS >=26 on Apple Silicon",
            );
        }
        let version = match self.quick(&["--version"]) {
            Ok(v) => v,
            Err(e) => {
                return Detection::failed(
                    RuntimeKind::Apple,
                    if e.contains("Permission denied") {
                        RuntimeState::PermissionDenied
                    } else {
                        RuntimeState::Missing
                    },
                    e,
                )
            }
        };
        if !version.split_whitespace().any(|v| v == APPLE_VERSION) {
            return Detection::failed(
                RuntimeKind::Apple,
                RuntimeState::Unsupported,
                format!("expected Apple {APPLE_VERSION}; found {}", version.trim()),
            );
        }
        match self.quick(&["system", "status"]) {
            Ok(status)
                if status.lines().any(|l| {
                    l.contains("status") && l.split_whitespace().last() == Some("running")
                }) =>
            {
                Detection::ready(RuntimeKind::Apple, APPLE_VERSION)
            }
            Ok(_) => Detection::failed(
                RuntimeKind::Apple,
                RuntimeState::Stopped,
                "container system is stopped",
            ),
            Err(e) => Detection::failed(
                RuntimeKind::Apple,
                if e.contains("permission") {
                    RuntimeState::PermissionDenied
                } else {
                    RuntimeState::Stopped
                },
                e,
            ),
        }
    }
    fn ensure_running(&self) -> Result<()> {
        let d = self.detect();
        if d.state == RuntimeState::Stopped {
            self.call(&["system", "start"])?;
            let until = std::time::Instant::now() + Duration::from_secs(30);
            while std::time::Instant::now() < until {
                if self.detect().state == RuntimeState::Ready {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            return Err("Apple system did not become ready within 30 seconds".into());
        }
        if d.state == RuntimeState::Ready {
            Ok(())
        } else {
            Err(d.detail)
        }
    }
    fn image_available(&self, image: &str) -> Result<bool> {
        if image.starts_with('-') {
            return Err("invalid image".into());
        }
        let value: Value =
            serde_json::from_str(&self.call(&["image", "list", "--format", "json"])?)
                .map_err(|e| e.to_string())?;
        let entries = value.as_array().ok_or("image list not an array")?;
        Ok(entries.iter().any(|v| {
            v["configuration"]["name"]
                .as_str()
                .is_some_and(|name| canonical_image(name) == canonical_image(image))
        }))
    }
    fn pull(&self, image: &str) -> Result<()> {
        if image.starts_with('-') {
            return Err("invalid image".into());
        }
        self.call(&["image", "pull", image]).map(|_| ())
    }
    fn load(&self, tarball: &Path) -> Result<()> {
        self.call(&[
            "image",
            "load",
            "--input",
            tarball.to_str().ok_or("non-UTF8 tarball")?,
        ])
        .map(|_| ())
    }
    fn create(&self, s: &Service) -> Result<()> {
        s.validate()?;
        // Apple volumes do not populate ownership from image directories. An isolated init
        // fixes only the volume root, never recursively rewrites existing application state.
        for m in s
            .mounts
            .iter()
            .filter(|m| !m.bind && !m.read_only && m.target == STATE_PATH)
        {
            self.call(&[
                "run",
                "--rm",
                "--name",
                &format!("{}-init", s.name),
                "--read-only",
                "--user",
                "0:0",
                "--cap-drop",
                "ALL",
                "--cap-add",
                "CHOWN",
                "--cap-add",
                "FOWNER",
                "--network",
                &s.network,
                "--volume",
                &format!("{}:/state", m.source),
                "--workdir",
                "/",
                "--entrypoint",
                "sh",
                &s.image,
                "-ec",
                "chown 10001:10001 /state && chmod 700 /state",
            ])?;
        }
        let mut args = vec![
            "create".into(),
            "--name".into(),
            s.name.clone(),
            "--label".into(),
            format!("{OWNER_LABEL}=distribution"),
            "--init".into(),
            "--read-only".into(),
            "--cap-drop".into(),
            "ALL".into(),
            "--user".into(),
            s.user.clone(),
            "--memory".into(),
            s.memory.max(200 * 1024 * 1024).to_string(),
            "--ulimit".into(),
            format!("nproc={}:{}", s.pids, s.pids),
            "--network".into(),
            format!(
                "{},mtu=1280",
                if s.egress {
                    format!("{}-egress", s.network)
                } else {
                    s.network.clone()
                }
            ),
            "--tmpfs".into(),
            "/tmp:rw,noexec,nosuid,size=64m,mode=1777".into(),
        ];
        if s.egress {
            let name = format!("{}-egress", s.network);
            self.resource("network", &name, false)?;
            // Apple assigns the default route through the first interface; put NAT first.
            args.extend(["--network".into(), format!("{},mtu=1280", s.network)]);
        }
        for mount in &s.tmpfs {
            args.extend(["--tmpfs".into(), mount.clone()]);
        }
        if !s.entrypoint.is_empty() {
            if s.entrypoint.len() != 1 {
                return Err(
                    "Apple entrypoint must name one executable; use command for args".into(),
                );
            }
            args.extend(["--entrypoint".into(), s.entrypoint[0].clone()]);
        }
        for m in &s.mounts {
            args.extend([
                "--mount".into(),
                format!(
                    "type={},source={},target={}{}",
                    if m.bind { "bind" } else { "volume" },
                    m.source,
                    m.target,
                    if m.read_only { ",readonly" } else { "" }
                ),
            ]);
        }
        for e in &s.env {
            args.extend(["--env".into(), e.clone()]);
        }
        if let Some(p) = s.publish {
            args.extend([
                "--publish".into(),
                format!(
                    "{}:{p}:{}",
                    if s.bind.is_ipv6() {
                        format!("[{}]", s.bind)
                    } else {
                        s.bind.to_string()
                    },
                    s.port
                ),
            ]);
        }
        args.push(s.image.clone());
        args.extend(s.command.clone());
        self.call_owned(args).map(|_| ())
    }
    fn start(&self, name: &str) -> Result<()> {
        validate_name(name)?;
        self.call(&["start", name]).map(|_| ())
    }
    fn stop(&self, name: &str) -> Result<()> {
        validate_name(name)?;
        self.call(&["stop", "--time", "150", name]).map(|_| ())
    }
    fn remove(&self, name: &str) -> Result<()> {
        validate_name(name)?;
        self.call(&["delete", name]).map(|_| ())
    }
    fn volume(&self, name: &str) -> Result<()> {
        self.resource("volume", name, false)
    }
    fn network(&self, name: &str) -> Result<()> {
        self.resource("network", name, true)
    }
    fn remove_network(&self, name: &str) -> Result<()> {
        validate_name(name)?;
        let list: Value =
            serde_json::from_str(&self.call(&["network", "list", "--format", "json"])?)
                .map_err(|e| e.to_string())?;
        let v = list
            .as_array()
            .ok_or("invalid network list")?
            .iter()
            .find(|v| v["id"] == name);
        match v {
            None => Ok(()),
            Some(v) if v["configuration"]["labels"][OWNER_LABEL] == "distribution" => {
                self.call(&["network", "delete", name]).map(|_| ())
            }
            _ => Err("refusing removal of unowned network".into()),
        }
    }
    fn inspect(&self, s: &Service) -> Result<Option<ContainerStatus>> {
        validate_name(&s.name)?;
        let list = self.call(&["list", "--all", "--format", "json"])?;
        let v: Value = serde_json::from_str(&list).map_err(|e| e.to_string())?;
        let Some(v) = v
            .as_array()
            .ok_or("Apple list not an array")?
            .iter()
            .find(|v| v["configuration"]["id"] == s.name)
        else {
            return Ok(None);
        };
        let running = v["status"]["state"] == "running";
        Ok(Some(ContainerStatus {
            running,
            healthy: running && self.exec(&s.name, &s.health_command).is_ok(),
            image: v["configuration"]["image"]["reference"]
                .as_str()
                .unwrap_or_default()
                .into(),
            owned: v["configuration"]["labels"][OWNER_LABEL] == "distribution",
        }))
    }
    fn exec(&self, name: &str, args: &[String]) -> Result<String> {
        validate_name(name)?;
        let mut a = vec!["exec".into(), name.into()];
        a.extend_from_slice(args);
        run(self.command(&a), None, Duration::from_secs(10))
            .and_then(|b| String::from_utf8(b).map_err(|e| e.to_string()))
    }
    fn address(&self, name: &str, network: &str) -> Result<String> {
        validate_name(name)?;
        let list: Value = serde_json::from_str(&self.call(&["list", "--all", "--format", "json"])?)
            .map_err(|e| e.to_string())?;
        let container = list
            .as_array()
            .ok_or("invalid container list")?
            .iter()
            .find(|v| v["configuration"]["id"] == name)
            .ok_or("container absent")?;
        if container["configuration"]["labels"][OWNER_LABEL] != "distribution" {
            return Err("unowned connection dependency".into());
        }
        let address = container["status"]["networks"]
            .as_array()
            .ok_or("container has no addresses")?
            .iter()
            .find(|v| v["network"] == network)
            .and_then(|v| v["ipv4Address"].as_str())
            .ok_or("network address absent")?;
        let ip: std::net::IpAddr = address
            .split('/')
            .next()
            .unwrap_or_default()
            .parse()
            .map_err(|_| "invalid network address")?;
        if !private_bind(ip) {
            return Err("public container address refused".into());
        }
        Ok(ip.to_string())
    }
    fn logs(&self, name: &str) -> Result<LogStream> {
        validate_name(name)?;
        LogStream::spawn(self.command(&[
            "logs".into(),
            "--follow".into(),
            "--".into(),
            name.into(),
        ]))
    }
}
