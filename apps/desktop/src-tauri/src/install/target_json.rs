use crate::{
    controller::{atomic_json, CtlError, Installed},
    runtime::{detect::Endpoint, RuntimeKind},
};
use serde::{Deserialize, Serialize};
use std::path::Path;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub version: u8,
    pub mode: String,
    pub runtime: RuntimeKind,
    pub endpoint: String,
    pub container: String,
}
impl Target {
    pub fn for_installed(i: &Installed) -> Result<Self, CtlError> {
        if i.runtime == RuntimeKind::Apple && i.endpoint != "/usr/local/bin/container"
            || i.runtime == RuntimeKind::Docker && Endpoint::parse(&i.endpoint).is_none()
        {
            return Err(CtlError::Invalid);
        }
        if i.container.is_empty()
            || i.container.starts_with('-')
            || !i
                .container
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        {
            return Err(CtlError::Invalid);
        }
        Ok(Self {
            version: 1,
            mode: "container".into(),
            runtime: i.runtime,
            endpoint: match Endpoint::parse(&i.endpoint) {
                Some(Endpoint::Unix(p)) => p.to_string_lossy().into(),
                Some(Endpoint::Pipe(p)) => p,
                _ => i.endpoint.clone(),
            },
            container: i.container.clone(),
        })
    }
}
pub fn write(dir: &Path, installed: &Installed) -> Result<(), CtlError> {
    let target = Target::for_installed(installed)?;
    atomic_json(dir, "target.json", &target)
}
pub fn remove_owned(dir: &Path, installed: &Installed) -> Result<bool, CtlError> {
    let path = dir.join("target.json");
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(CtlError::Storage),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 4096 {
        return Err(CtlError::Storage);
    }
    let current: Target =
        serde_json::from_slice(&std::fs::read(&path).map_err(|_| CtlError::Storage)?)
            .map_err(|_| CtlError::Storage)?;
    if current != Target::for_installed(installed)? {
        return Ok(false);
    }
    std::fs::remove_file(path).map_err(|_| CtlError::Storage)?;
    Ok(true)
}
