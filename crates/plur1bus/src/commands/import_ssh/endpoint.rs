//! Canonical SSH endpoints and explicit remote-root connection metadata; no shell parsing.
use super::port::{Failure, RpcPort, Server};
use crate::cli::ImportArgs;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::net::{IpAddr, Ipv6Addr};
pub(super) fn id(value: &str) -> Result<&str, Failure> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        || !value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
    {
        return Err(Failure::Invalid("ssh-connection-invalid"));
    }
    Ok(value)
}
pub(super) fn uuid(value: &str) -> Result<&str, Failure> {
    if uuid::Uuid::parse_str(value).is_err()
        || uuid::Uuid::parse_str(value)
            .ok()
            .is_none_or(|id| id.to_string() != value)
    {
        return Err(Failure::Invalid("ssh-run-invalid"));
    }
    Ok(value)
}
pub(super) fn metadata_id(value: &Value, field: &str) -> Result<String, Failure> {
    let value = value[field].as_str().ok_or(Failure::Protocol)?;
    uuid(value).map_err(|_| Failure::Protocol)?;
    Ok(value.into())
}
pub(super) fn remote_path(value: &str) -> Result<&str, Failure> {
    if value.is_empty()
        || value.len() > 4096
        || !value.starts_with('/')
        || value.contains('\\')
        || value.chars().any(char::is_control)
        || value != "/"
            && value[1..]
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(Failure::Invalid("ssh-source-required"));
    }
    Ok(value)
}
pub(super) fn inside(root: &str, path: &str) -> bool {
    root == "/"
        || path == root
        || path
            .strip_prefix(root)
            .is_some_and(|tail| tail.starts_with('/'))
}
pub(super) struct Selected {
    pub(super) id: String,
    pub(super) path: String,
    pub(super) setup: Option<Value>,
}
pub(super) fn select(
    args: &ImportArgs,
    port: &mut impl RpcPort,
    force_setup: bool,
) -> Result<Selected, Failure> {
    let endpoint = args
        .ssh
        .as_deref()
        .map(parse_endpoint)
        .transpose()
        .map_err(Failure::Invalid)?;
    let connection_id = args
        .connection
        .clone()
        .or_else(|| endpoint.as_ref().map(SshEndpoint::id))
        .ok_or(Failure::Invalid("ssh-connection-required"))?;
    let listed = port.call(Server::Core, "admin.import.ssh.connections.list", json!({}))?;
    let all = listed["connections"]
        .as_array()
        .filter(|all| all.len() <= 128)
        .ok_or(Failure::Protocol)?;
    let existing = all
        .iter()
        .find(|connection| connection["id"] == connection_id);
    let roots = existing
        .map(|connection| connection["roots"].as_array().ok_or(Failure::Protocol))
        .transpose()?;
    let mut roots = roots
        .into_iter()
        .flatten()
        .map(|root| {
            root.as_str().ok_or(Failure::Protocol).and_then(|root| {
                remote_path(root)
                    .map(str::to_owned)
                    .map_err(|_| Failure::Protocol)
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if roots.len() > 32 {
        return Err(Failure::Protocol);
    }
    let path = match &args.source {
        Some(path) => path
            .to_str()
            .ok_or(Failure::Invalid("ssh-source-required"))?
            .to_owned(),
        None if roots.len() == 1 => roots[0].clone(),
        _ => return Err(Failure::Invalid("ssh-source-required")),
    };
    let endpoint = match (endpoint, existing) {
        (Some(endpoint), _) => endpoint,
        (None, Some(connection)) => SshEndpoint {
            host: connection["host"].as_str().ok_or(Failure::Protocol)?.into(),
            user: connection["user"].as_str().ok_or(Failure::Protocol)?.into(),
            port: connection["port"]
                .as_u64()
                .and_then(|port| u16::try_from(port).ok())
                .filter(|port| *port > 0)
                .ok_or(Failure::Protocol)?,
        },
        _ => return Err(Failure::Unavailable("ssh-connection-required")),
    };
    let same = existing.is_some_and(|connection| {
        connection["host"] == endpoint.host
            && connection["user"] == endpoint.user
            && connection["port"] == endpoint.port
    });
    let private = existing
        .filter(|_| same)
        .and_then(|connection| connection["allowPrivate"].as_bool())
        .unwrap_or(false)
        || args.allow_private;
    if !same {
        roots.clear();
    }
    let covered = roots.iter().any(|root| inside(root, &path));
    let update = force_setup
        || !same
        || !covered
        || args.allow_private
            && existing.is_some_and(|connection| connection["allowPrivate"] != true);
    let setup = if update {
        if !covered {
            roots.push(path.clone());
        }
        if roots.len() > 32 {
            return Err(Failure::Invalid("ssh-roots-limit"));
        }
        Some(port.call(Server::Core,"admin.import.ssh.connections.set",json!({"connection":{"id":connection_id,"host":endpoint.host,"port":endpoint.port,"user":endpoint.user,"roots":roots,"allowPrivate":private}}))?)
    } else {
        None
    };
    Ok(Selected {
        id: connection_id,
        path,
        setup,
    })
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SshEndpoint {
    pub(super) user: String,
    pub(super) host: String,
    pub(super) port: u16,
}
impl SshEndpoint {
    pub(super) fn id(&self) -> String {
        let digest = Sha256::digest(format!("{}\0{}\0{}", self.user, self.host, self.port));
        format!("ssh-{}", &format!("{digest:x}")[..32])
    }
}
pub(super) fn parse_endpoint(value: &str) -> Result<SshEndpoint, &'static str> {
    if value.len() > 512
        || value
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return Err("ssh-endpoint-invalid");
    }
    let (user, address) = value.split_once('@').ok_or("ssh-endpoint-invalid")?;
    if user.is_empty()
        || user.len() > 128
        || user.starts_with('-')
        || !user
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
        || address.contains('@')
    {
        return Err("ssh-endpoint-invalid");
    }
    let (host, port) = if let Some(ipv6) = address.strip_prefix('[') {
        let (host, suffix) = ipv6.split_once(']').ok_or("ssh-endpoint-invalid")?;
        let host = host
            .parse::<Ipv6Addr>()
            .map_err(|_| "ssh-endpoint-invalid")?
            .to_string();
        let port = if suffix.is_empty() {
            22
        } else {
            parse_port(suffix.strip_prefix(':').ok_or("ssh-endpoint-invalid")?)?
        };
        (host, port)
    } else {
        let (host, port) = match address.split_once(':') {
            Some((host, port)) => (host, parse_port(port)?),
            None => (address, 22),
        };
        let host = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
        if host.is_empty() || host.len() > 253 || host.contains(':') {
            return Err("ssh-endpoint-invalid");
        }
        if host.parse::<IpAddr>().is_err()
            && (host
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'.')
                || host.split('.').any(|label| {
                    label.is_empty()
                        || label.len() > 63
                        || label.starts_with('-')
                        || label.ends_with('-')
                        || !label
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                }))
        {
            return Err("ssh-endpoint-invalid");
        }
        (host, port)
    };
    Ok(SshEndpoint {
        user: user.into(),
        host,
        port,
    })
}
fn parse_port(value: &str) -> Result<u16, &'static str> {
    if value.is_empty() || value.len() > 5 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("ssh-endpoint-invalid");
    }
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or("ssh-endpoint-invalid")
}
