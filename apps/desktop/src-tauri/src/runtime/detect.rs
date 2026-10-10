use super::{Runtime, RuntimeKind};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Host {
    Mac,
    Windows,
    Linux,
}
#[derive(Clone, Debug)]
pub struct Env {
    pub host: Host,
    pub docker_host: Option<String>,
    pub xdg_runtime_dir: Option<PathBuf>,
    pub macos_major: Option<u32>,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Endpoint {
    Unix(PathBuf),
    Pipe(String),
}
impl std::fmt::Display for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unix(p) => write!(f, "unix://{}", p.display()),
            Self::Pipe(p) => write!(f, "npipe://{p}"),
        }
    }
}
impl Endpoint {
    pub fn parse(s: &str) -> Option<Self> {
        if let Some(p) = s.strip_prefix("unix://") {
            let p = PathBuf::from(p);
            p.is_absolute().then_some(Self::Unix(p))
        } else {
            s.strip_prefix("npipe://")
                .filter(|p| p.starts_with("//./pipe/"))
                .map(|p| Self::Pipe(p.into()))
        }
    }
}
#[derive(Clone, Debug)]
pub struct Candidate {
    pub endpoint: Endpoint,
    pub source: String,
}
pub struct Candidates {
    pub candidates: Vec<Candidate>,
    pub notes: Vec<&'static str>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DetectState {
    Ready,
    Stopped,
    TooOld,
    NoAccess,
    WrongMode,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Detected {
    pub kind: RuntimeKind,
    pub endpoint: String,
    pub source: String,
    pub version: String,
    pub engine: String,
    pub state: DetectState,
}
pub fn candidates(env: &Env, home: &Path) -> Candidates {
    let mut out = Candidates {
        candidates: vec![],
        notes: vec![],
    };
    let mut seen = HashSet::new();
    let mut add = |endpoint: Endpoint, source: String| {
        let key = match &endpoint {
            Endpoint::Unix(p) => std::fs::canonicalize(p)
                .unwrap_or_else(|_| p.clone())
                .to_string_lossy()
                .into_owned(),
            Endpoint::Pipe(p) => p.to_ascii_lowercase(),
        };
        if seen.insert(key) {
            out.candidates.push(Candidate { endpoint, source })
        }
    };
    if let Some(host) = &env.docker_host {
        if let Some(ep) = Endpoint::parse(host) {
            add(ep, "DOCKER_HOST".into())
        } else {
            out.notes.push("runtime.remote-endpoint-ignored")
        }
    }
    let cfg = std::fs::read(home.join(".docker/config.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
    if let Some(context) = cfg
        .as_ref()
        .and_then(|c| c.get("currentContext"))
        .and_then(|v| v.as_str())
    {
        if let Ok(entries) = std::fs::read_dir(home.join(".docker/contexts/meta")) {
            let mut paths: Vec<_> = entries
                .flatten()
                .map(|e| e.path().join("meta.json"))
                .collect();
            paths.sort();
            for p in paths {
                if let Some(v) = std::fs::read(p)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                {
                    if v.get("Name").and_then(|v| v.as_str()) == Some(context) {
                        if let Some(ep) = v
                            .pointer("/Endpoints/docker/Host")
                            .and_then(|v| v.as_str())
                            .and_then(Endpoint::parse)
                        {
                            add(ep, format!("context:{context}"))
                        }
                    }
                }
            }
        }
    }
    if env.host == Host::Windows {
        for pipe in ["docker_engine", "podman-machine-default"] {
            add(Endpoint::Pipe(format!("//./pipe/{pipe}")), pipe.into())
        }
    } else {
        add(
            Endpoint::Unix("/var/run/docker.sock".into()),
            "default".into(),
        );
        if let Some(xdg) = &env.xdg_runtime_dir {
            add(Endpoint::Unix(xdg.join("docker.sock")), "rootless".into());
            add(
                Endpoint::Unix(xdg.join("podman/podman.sock")),
                "podman".into(),
            )
        }
        if env.host == Host::Mac {
            for (p, source) in [
                (".docker/run/docker.sock", "docker-desktop"),
                (".orbstack/run/docker.sock", "orbstack"),
                (".colima/default/docker.sock", "colima"),
            ] {
                add(Endpoint::Unix(home.join(p)), source.into())
            }
        }
    }
    out
}
pub fn choose_default(
    found: &[Detected],
    current: Option<&Detected>,
    macos_major: Option<u32>,
) -> Option<usize> {
    if let Some(current) = current {
        return found
            .iter()
            .position(|f| f.kind == current.kind && f.endpoint == current.endpoint);
    }
    let ready: Vec<_> = found
        .iter()
        .enumerate()
        .filter(|(_, d)| d.state == DetectState::Ready)
        .collect();
    if macos_major.is_some_and(|v| v >= 26) {
        if let Some((i, _)) = ready.iter().find(|(_, d)| d.kind == RuntimeKind::Apple) {
            return Some(*i);
        }
    }
    ready.first().map(|(i, _)| *i)
}
pub async fn detect_all(env: &Env, home: &Path) -> Vec<Detected> {
    let mut found = vec![];
    if env.host == Host::Mac && env.macos_major.is_some_and(|v| v >= 26) {
        match super::apple::AppleRuntime::detect().await {
            Ok(r) => {
                let i = r.info();
                let state = if r.ping().await.is_ok() {
                    DetectState::Ready
                } else {
                    DetectState::Stopped
                };
                found.push(Detected {
                    kind: i.kind,
                    endpoint: i.endpoint.clone(),
                    source: "apple".into(),
                    version: i.version.clone(),
                    engine: i.engine.clone(),
                    state,
                })
            }
            Err(super::RuntimeError::NotFound) => {}
            Err(e) => {
                let (state, version) = match e {
                    super::RuntimeError::TooOld { found, .. } => (DetectState::TooOld, found),
                    super::RuntimeError::NoAccess(_) => (DetectState::NoAccess, String::new()),
                    _ => (DetectState::Stopped, String::new()),
                };
                found.push(Detected {
                    kind: RuntimeKind::Apple,
                    endpoint: "/usr/local/bin/container".into(),
                    source: "apple".into(),
                    version,
                    engine: "Apple container".into(),
                    state,
                })
            }
        }
    }

    for c in candidates(env, home).candidates {
        let result = super::docker::DockerRuntime::connect(&c.endpoint).await;
        match result {
            Ok(r) => {
                let i = r.info();
                found.push(Detected {
                    kind: i.kind,
                    endpoint: i.endpoint.clone(),
                    source: c.source,
                    version: i.version.clone(),
                    engine: i.engine.clone(),
                    state: DetectState::Ready,
                })
            }
            Err(super::RuntimeError::NotFound) => {}
            Err(e) => {
                let state = match e {
                    super::RuntimeError::WrongMode => DetectState::WrongMode,
                    super::RuntimeError::NoAccess(_) => DetectState::NoAccess,
                    super::RuntimeError::TooOld { .. } => DetectState::TooOld,
                    _ => DetectState::Stopped,
                };
                found.push(Detected {
                    kind: RuntimeKind::Docker,
                    endpoint: c.endpoint.to_string(),
                    source: c.source,
                    version: String::new(),
                    engine: String::new(),
                    state,
                })
            }
        }
    }
    found
}
