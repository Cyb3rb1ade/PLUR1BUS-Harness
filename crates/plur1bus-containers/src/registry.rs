//! Docker client-side registry credentials. Explicit config keeps synthetic tests away from real helpers.
use crate::{process::run, Result};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE},
    Engine,
};
use serde_json::{json, Value};
use std::{path::Path, process::Command, time::Duration};
fn registry(image: &str) -> &str {
    let host = image.split('/').next().unwrap_or_default();
    if image.contains('/') && (host.contains('.') || host.contains(':') || host == "localhost") {
        host
    } else {
        "docker.io"
    }
}
pub(crate) fn auth(config_dir: Option<&Path>, image: &str) -> Result<Option<String>> {
    let Some(dir) = config_dir else {
        return Ok(None);
    };
    let bytes = match std::fs::read(dir.join("config.json")) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("cannot read Docker registry configuration".into()),
    };
    let config: Value =
        serde_json::from_slice(&bytes).map_err(|_| "invalid Docker registry configuration")?;
    let registry = registry(image);
    let server = if registry == "docker.io" {
        "https://index.docker.io/v1/"
    } else {
        registry
    };
    let helper = config["credHelpers"][registry]
        .as_str()
        .or(config["credsStore"].as_str());
    let credentials = if let Some(helper) = helper {
        if helper.is_empty()
            || !helper
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        {
            return Err("invalid Docker credential helper name".into());
        }
        let mut cmd = Command::new(format!("docker-credential-{helper}"));
        cmd.arg("get");
        let raw = match run(
            cmd,
            Some(format!("{server}\n").into_bytes()),
            Duration::from_secs(10),
        ) {
            Ok(raw) => raw,
            // Helper errors can be printed on stdout and must never enter diagnostics.
            // Anonymous pulls still fail closed for private registries.
            Err(_) => return Ok(None),
        };
        let v: Value = serde_json::from_slice(&raw)
            .map_err(|_| "invalid Docker credential helper response")?;
        let username = v["Username"].as_str().ok_or("missing registry username")?;
        let secret = v["Secret"].as_str().ok_or("missing registry secret")?;
        if username == "<token>" {
            json!({"identitytoken":secret,"serveraddress":server})
        } else {
            json!({"username":username,"password":secret,"serveraddress":server})
        }
    } else {
        let v = &config["auths"][server];
        let v = if v.is_null() {
            &config["auths"][registry]
        } else {
            v
        };
        if let Some(token) = v["identitytoken"].as_str() {
            json!({"identitytoken":token,"serveraddress":server})
        } else if let Some(auth) = v["auth"].as_str() {
            let decoded = STANDARD
                .decode(auth)
                .map_err(|_| "invalid Docker registry authentication")?;
            let decoded = String::from_utf8(decoded)
                .map_err(|_| "invalid registry authentication encoding")?;
            let (username, password) = decoded
                .split_once(':')
                .ok_or("invalid registry authentication fields")?;
            json!({"username":username,"password":password,"serveraddress":server})
        } else {
            return Ok(None);
        }
    };
    Ok(Some(URL_SAFE.encode(
        serde_json::to_vec(&credentials).map_err(|_| "registry authentication serialization")?,
    )))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_fake_auth_never_reads_the_user_configuration() {
        assert!(auth(None, "ghcr.io/example/private:tag").unwrap().is_none());
        let dir = tempfile::tempdir().unwrap();
        let v = json!({"auths":{"ghcr.io":{"auth":STANDARD.encode("synthetic:throwaway")}}});
        std::fs::write(
            dir.path().join("config.json"),
            serde_json::to_vec(&v).unwrap(),
        )
        .unwrap();
        let auth = auth(Some(dir.path()), "ghcr.io/example/private:tag")
            .unwrap()
            .unwrap();
        let v: Value = serde_json::from_slice(&URL_SAFE.decode(auth).unwrap()).unwrap();
        assert_eq!(v["password"], "throwaway");
        assert_eq!(v["serveraddress"], "ghcr.io");
    }
}
