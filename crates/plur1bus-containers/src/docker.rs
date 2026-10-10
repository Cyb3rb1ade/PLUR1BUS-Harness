use crate::{model::validate_name, process::run, *};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
/// Engine API v1.47 over Unix sockets, or an explicit TLS DOCKER_HOST.
/// curl is a transport only: no Docker CLI lifecycle commands are used.
#[derive(Clone, Debug)]
pub struct DockerRuntime {
    pub endpoint: String,
    pub curl: PathBuf,
    pub cert_path: Option<PathBuf>,
    pub registry_config: Option<PathBuf>,
}
impl DockerRuntime {
    pub fn new(endpoint: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            curl: "curl".into(),
            cert_path: None,
            registry_config: None,
        }
    }
    pub fn discover() -> Self {
        let mut runtime = Self::discover_endpoint();
        runtime.registry_config = std::env::var_os("DOCKER_CONFIG")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .map(|p| PathBuf::from(p).join(".docker"))
            });
        runtime
    }
    fn discover_endpoint() -> Self {
        if let Ok(host) = std::env::var("DOCKER_HOST") {
            let mut r = Self::new(host);
            r.cert_path = std::env::var_os("DOCKER_CERT_PATH").map(PathBuf::from);
            return r;
        }
        // Contexts cover Docker Desktop, Colima, OrbStack and Podman-compatible engines.
        let mut cmd = Command::new("docker");
        cmd.args(["context", "inspect"]);
        if let Ok(bytes) = run(cmd, None, Duration::from_secs(3)) {
            if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                if let Some(s) = v[0]["Endpoints"]["docker"]["Host"].as_str() {
                    let mut runtime = Self::new(s);
                    if let Some(path) = v[0]["Storage"]["TLSPath"].as_str() {
                        let path = PathBuf::from(path).join("docker");
                        if path.is_dir() {
                            runtime.cert_path = Some(path);
                        }
                    }
                    return runtime;
                }
            }
        }
        if cfg!(windows) {
            return Self::new("npipe:////./pipe/docker_engine");
        }
        let home = std::env::var("HOME").unwrap_or_default();
        let candidates = [
            format!("{home}/.docker/run/docker.sock"),
            format!("{home}/.colima/default/docker.sock"),
            format!("{home}/.orbstack/run/docker.sock"),
            format!(
                "{}/podman/podman.sock",
                std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| {
                    let uid = Command::new("id")
                        .arg("-u")
                        .output()
                        .ok()
                        .and_then(|o| String::from_utf8(o.stdout).ok())
                        .and_then(|s| s.trim().parse::<u32>().ok())
                        .unwrap_or(1000);
                    format!("/run/user/{uid}")
                })
            ),
            "/run/podman/podman.sock".into(),
            "/var/run/docker.sock".into(),
        ];
        Self::new(format!(
            "unix://{}",
            candidates
                .iter()
                .find(|p| Path::new(p).exists())
                .unwrap_or(candidates.last().unwrap())
        ))
    }
    fn command(&self, method: &str, path: &str) -> Result<Command> {
        if self.endpoint.starts_with("npipe://") {
            if !cfg!(windows) {
                return Err("unsupported named-pipe endpoint on this platform".into());
            }
            let name = self.endpoint.rsplit('/').next().unwrap_or_default();
            validate_name(name)?;
            let mut cmd = Command::new("powershell.exe");
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                include_str!("docker-pipe.ps1"),
            ]);
            cmd.env("PLUR1BUS_PIPE", name)
                .env("PLUR1BUS_PIPE_METHOD", method)
                .env("PLUR1BUS_PIPE_PATH", path)
                .env("PLUR1BUS_PIPE_TYPE", "application/json")
                .env_remove("PLUR1BUS_PIPE_FILE")
                .env_remove("PLUR1BUS_PIPE_STREAM")
                .env_remove("PLUR1BUS_PIPE_AUTH");
            return Ok(cmd);
        }
        let mut cmd = Command::new(&self.curl);
        cmd.args([
            "--silent",
            "--show-error",
            "--no-buffer",
            "--noproxy",
            "*",
            "--connect-timeout",
            "5",
            "--request",
            method,
        ]);
        let base = if let Some(socket) = self.endpoint.strip_prefix("unix://") {
            cmd.args(["--unix-socket", socket]);
            "http://localhost".to_owned()
        } else if let Some(host) = self.endpoint.strip_prefix("tcp://") {
            if self.cert_path.is_some() {
                format!("https://{host}")
            } else {
                let hostname = host.split(':').next().unwrap_or_default();
                if !["127.0.0.1", "localhost"].contains(&hostname) {
                    return Err("remote Docker requires TLS and DOCKER_CERT_PATH".into());
                }
                format!("http://{host}")
            }
        } else if self.endpoint.starts_with("https://") {
            self.endpoint.clone()
        } else {
            return Err("unsupported Docker endpoint".into());
        };
        if let Some(p) = &self.cert_path {
            cmd.arg("--cacert")
                .arg(p.join("ca.pem"))
                .arg("--cert")
                .arg(p.join("cert.pem"))
                .arg("--key")
                .arg(p.join("key.pem"));
        }
        cmd.arg(format!("{base}{path}"));
        Ok(cmd)
    }
    fn request(
        &self,
        method: &str,
        path: &str,
        input: Option<Vec<u8>>,
        raw: bool,
    ) -> Result<(u16, Vec<u8>)> {
        self.request_authenticated(method, path, input, raw, None)
    }
    fn request_authenticated(
        &self,
        method: &str,
        path: &str,
        input: Option<Vec<u8>>,
        raw: bool,
        auth: Option<String>,
    ) -> Result<(u16, Vec<u8>)> {
        use std::io::Write;
        let mut cmd = self.command(method, path)?;
        let mut header_file = None;
        if let Some(auth) = auth {
            if self.endpoint.starts_with("npipe://") {
                cmd.env("PLUR1BUS_PIPE_AUTH", auth);
            } else {
                let mut file = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
                writeln!(file, "X-Registry-Auth: {auth}").map_err(|e| e.to_string())?;
                cmd.arg("--header")
                    .arg(format!("@{}", file.path().display()));
                header_file = Some(file);
            }
        }
        let pipe = self.endpoint.starts_with("npipe://");
        if !pipe {
            cmd.args(["--max-time", "300", "--write-out", "\n%{http_code}"]);
        }
        if input.is_some() && !pipe {
            cmd.args([
                "--header",
                if raw {
                    "Content-Type: application/x-tar"
                } else {
                    "Content-Type: application/json"
                },
                "--data-binary",
                "@-",
            ]);
        }
        let mut data = run(
            cmd,
            input,
            if method == "GET" {
                Duration::from_secs(10)
            } else {
                Duration::from_secs(305)
            },
        )?;
        let pos = data
            .iter()
            .rposition(|b| *b == b'\n')
            .ok_or("Docker response missing status")?;
        let status = std::str::from_utf8(&data[pos + 1..])
            .map_err(|e| e.to_string())?
            .parse::<u16>()
            .map_err(|e| e.to_string())?;
        data.truncate(pos);
        drop(header_file);
        if status >= 400 && status != 404 {
            return Err(format!(
                "Docker HTTP {status}: {}",
                String::from_utf8_lossy(&data)
            ));
        }
        Ok((status, data))
    }
    fn api(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        let (status, bytes) = self.request(
            method,
            &format!("/v1.47{path}"),
            body.map(|v| v.to_string().into_bytes()),
            false,
        )?;
        if status == 404 {
            return Err("Docker resource not found".into());
        }
        if bytes.is_empty() {
            Ok(Value::Null)
        } else {
            serde_json::from_slice(&bytes).map_err(|e| format!("Docker invalid JSON: {e}"))
        }
    }
    fn ensure_resource(&self, kind: &str, name: &str, create: Value) -> Result<()> {
        validate_name(name)?;
        let (code, bytes) = self.request("GET", &format!("/v1.47/{kind}/{name}"), None, false)?;
        if code == 404 {
            self.api("POST", &format!("/{kind}/create"), Some(create))?;
            return Ok(());
        }
        let v: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if v["Labels"][OWNER_LABEL] != "distribution" {
            return Err(format!(
                "resource {name} exists without our ownership label"
            ));
        }
        if kind == "networks" && v["Internal"] != create["Internal"] {
            return Err("existing network is not internal".into());
        }
        Ok(())
    }
}
impl ContainerRuntime for DockerRuntime {
    fn detect(&self) -> Detection {
        match self.request("GET", "/version", None, false) {
            Ok((200, bytes)) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(v) => match v["Version"].as_str().filter(|v| !v.trim().is_empty()) {
                    Some(version) => Detection::ready(RuntimeKind::Docker, version),
                    None => Detection::failed(
                        RuntimeKind::Docker,
                        RuntimeState::Unreachable,
                        "endpoint did not identify a Docker-compatible engine",
                    ),
                },
                Err(e) => Detection::failed(
                    RuntimeKind::Docker,
                    RuntimeState::Unreachable,
                    e.to_string(),
                ),
            },
            Ok((code, _)) => Detection::failed(
                RuntimeKind::Docker,
                RuntimeState::Unreachable,
                format!("HTTP {code}"),
            ),
            Err(e) => {
                let state = if e.contains("Permission denied")
                    || e.contains("HTTP 403")
                    || e.contains("HTTP 401")
                {
                    RuntimeState::PermissionDenied
                } else if e.contains("unsupported") {
                    RuntimeState::Unsupported
                } else if self
                    .endpoint
                    .strip_prefix("unix://")
                    .is_some_and(|p| !Path::new(p).exists())
                {
                    RuntimeState::Missing
                } else {
                    RuntimeState::Stopped
                };
                Detection::failed(RuntimeKind::Docker, state, e)
            }
        }
    }
    fn ensure_running(&self) -> Result<()> {
        let d = self.detect();
        if d.state == RuntimeState::Ready {
            Ok(())
        } else {
            Err(d.detail)
        }
    }
    fn image_available(&self, image: &str) -> Result<bool> {
        let encoded: String = image
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-_.".contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        self.request("GET", &format!("/v1.47/images/{encoded}/json"), None, false)
            .map(|(code, _)| code == 200)
    }
    fn pull(&self, image: &str) -> Result<()> {
        let query: String = image
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-_.".contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        let (code, bytes) = self.request_authenticated(
            "POST",
            &format!("/v1.47/images/create?fromImage={query}"),
            None,
            false,
            crate::registry::auth(self.registry_config.as_deref(), image)?,
        )?;
        if code != 200 {
            return Err(format!("pull HTTP {code}"));
        }
        for line in bytes.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
            let v: Value = serde_json::from_slice(line).map_err(|e| e.to_string())?;
            if let Some(e) = v.get("error") {
                return Err(format!("pull: {e}"));
            }
        }
        Ok(())
    }
    fn load(&self, tarball: &Path) -> Result<()> {
        if self.endpoint.starts_with("npipe://") {
            let mut cmd = self.command("POST", "/v1.47/images/load?quiet=1")?;
            cmd.env("PLUR1BUS_PIPE_FILE", tarball)
                .env("PLUR1BUS_PIPE_TYPE", "application/x-tar");
            let bytes = run(cmd, None, Duration::from_secs(900))?;
            if bytes.windows(7).any(|w| w == b"\"error\"") {
                return Err("Docker image load failed".into());
            }
            return Ok(());
        }
        // Stream the tar file, never buffer installer images in RAM.
        let mut cmd = self.command("POST", "/v1.47/images/load?quiet=1")?;
        cmd.args([
            "--fail",
            "--max-time",
            "300",
            "--header",
            "Content-Type: application/x-tar",
            "--header",
            "Transfer-Encoding: chunked",
            "--header",
            "Expect:",
            "--upload-file",
        ])
        .arg(tarball);
        let out = run(cmd, None, Duration::from_secs(305))?;
        for line in out.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
            let v: Value = serde_json::from_slice(line).map_err(|e| e.to_string())?;
            if v.get("error").is_some() {
                return Err(format!("load: {v}"));
            }
        }
        Ok(())
    }
    fn create(&self, s: &Service) -> Result<()> {
        s.validate()?;
        let binds: Vec<_> = s
            .mounts
            .iter()
            .map(|m| {
                format!(
                    "{}:{}:{}",
                    m.source,
                    m.target,
                    if m.read_only { "ro" } else { "rw" }
                )
            })
            .collect();
        let mut ports = json!({});
        let mut exposed = json!({});
        let mut tmpfs = json!({"/tmp": "rw,noexec,nosuid,size=64m,mode=1777"});
        for mount in &s.tmpfs {
            let (path, options) = mount.split_once(':').ok_or("tmpfs needs path:options")?;
            tmpfs[path] = json!(options);
        }
        if s.egress {
            self.ensure_resource("networks", &format!("{}-egress", s.network), json!({"Name": format!("{}-egress", s.network), "Internal": false, "Labels": { OWNER_LABEL: "distribution" }}))?;
        }
        if let Some(p) = s.publish {
            ports[format!("{}/tcp", s.port)] =
                json!([{ "HostIp": s.bind.to_string(), "HostPort": p.to_string() }]);
            exposed[format!("{}/tcp", s.port)] = json!({});
        }
        self.api("POST", &format!("/containers/create?name={}", s.name), Some(json!({ "Image": s.image, "User": s.user, "Env": s.env, "Cmd": if s.command.is_empty() { Value::Null } else { json!(s.command) }, "Entrypoint": if s.entrypoint.is_empty() { Value::Null } else { json!(s.entrypoint) }, "Labels": { OWNER_LABEL: "distribution" }, "ExposedPorts": exposed, "Healthcheck": { "Test": std::iter::once("CMD".to_string()).chain(s.health_command.clone()).collect::<Vec<_>>(), "Interval": 30000000000_u64, "Timeout": 10000000000_u64, "StartPeriod": 90000000000_u64, "Retries": 3 }, "HostConfig": { "Init": true, "ReadonlyRootfs": true, "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"], "PidsLimit": s.pids, "Memory": s.memory, "Tmpfs": tmpfs, "Binds": binds, "NetworkMode": s.network, "PortBindings": ports } })))?;
        if s.egress {
            self.api(
                "POST",
                &format!("/networks/{}-egress/connect", s.network),
                Some(json!({"Container": s.name})),
            )?;
        }
        Ok(())
    }
    fn start(&self, name: &str) -> Result<()> {
        validate_name(name)?;
        self.api("POST", &format!("/containers/{name}/start"), None)
            .map(|_| ())
    }
    fn stop(&self, name: &str) -> Result<()> {
        validate_name(name)?;
        self.api("POST", &format!("/containers/{name}/stop?t=150"), None)
            .map(|_| ())
    }
    fn remove(&self, name: &str) -> Result<()> {
        validate_name(name)?;
        self.api("DELETE", &format!("/containers/{name}"), None)
            .map(|_| ())
    }
    fn volume(&self, name: &str) -> Result<()> {
        self.ensure_resource(
            "volumes",
            name,
            json!({ "Name": name, "Labels": { OWNER_LABEL: "distribution" } }),
        )
    }
    fn network(&self, name: &str) -> Result<()> {
        self.ensure_resource(
            "networks",
            name,
            json!({ "Name": name, "Internal": true, "Labels": { OWNER_LABEL: "distribution" } }),
        )
    }
    fn remove_network(&self, name: &str) -> Result<()> {
        validate_name(name)?;
        let (code, bytes) = self.request("GET", &format!("/v1.47/networks/{name}"), None, false)?;
        if code == 404 {
            return Ok(());
        }
        let v: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if v["Labels"][OWNER_LABEL] != "distribution" {
            return Err("refusing removal of unowned network".into());
        }
        self.api("DELETE", &format!("/networks/{name}"), None)
            .map(|_| ())
    }
    fn inspect(&self, s: &Service) -> Result<Option<ContainerStatus>> {
        validate_name(&s.name)?;
        let (status, bytes) = self.request(
            "GET",
            &format!("/v1.47/containers/{}/json", s.name),
            None,
            false,
        )?;
        if status == 404 {
            return Ok(None);
        }
        let v: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        Ok(Some(ContainerStatus {
            running: v["State"]["Running"] == true,
            healthy: v["State"]["Health"]["Status"] == "healthy",
            image: v["Config"]["Image"].as_str().unwrap_or_default().into(),
            owned: v["Config"]["Labels"][OWNER_LABEL] == "distribution",
        }))
    }
    fn exec(&self, name: &str, args: &[String]) -> Result<String> {
        validate_name(name)?;
        let v = self.api(
            "POST",
            &format!("/containers/{name}/exec"),
            Some(json!({ "AttachStdout": true, "AttachStderr": true, "Cmd": args })),
        )?;
        let id = v["Id"].as_str().ok_or("exec missing id")?;
        validate_name(id)?;
        let (_, bytes) = self.request(
            "POST",
            &format!("/v1.47/exec/{id}/start"),
            Some(br#"{"Detach":false,"Tty":false}"#.to_vec()),
            false,
        )?;
        let status = self.api("GET", &format!("/exec/{id}/json"), None)?;
        if status["ExitCode"] != 0 {
            return Err(format!(
                "diagnostic exec failed: {}",
                String::from_utf8_lossy(&bytes)
            ));
        }
        decode_docker_stream(&bytes)
    }
    fn logs(&self, name: &str) -> Result<LogStream> {
        validate_name(name)?;
        let mut cmd = self.command(
            "GET",
            &format!("/v1.47/containers/{name}/logs?stdout=1&stderr=1&follow=1&tail=100"),
        )?;
        if self.endpoint.starts_with("npipe://") {
            cmd.env("PLUR1BUS_PIPE_STREAM", "1");
        } else {
            cmd.arg("--fail");
        }
        LogStream::docker(cmd)
    }
}
/// Docker's non-TTY logs/exec use eight-byte multiplex headers; logs streams retain framing.
pub fn decode_docker_stream(bytes: &[u8]) -> Result<String> {
    let mut offset = 0;
    let mut out = Vec::new();
    while offset < bytes.len() {
        if bytes.len() - offset < 8 {
            return Err("truncated Docker stream header".into());
        }
        let header = &bytes[offset..offset + 8];
        let len = u32::from_be_bytes(header[4..8].try_into().unwrap()) as usize;
        offset += 8;
        if bytes.len() - offset < len {
            return Err("truncated Docker stream frame".into());
        }
        out.extend_from_slice(&bytes[offset..offset + len]);
        offset += len;
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}
