use crate::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SidecarMode {
    Bundled,
    Remote,
    Off,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidecarConfig {
    pub mode: SidecarMode,
    pub url: Option<String>,
    pub ca_bundle: Option<PathBuf>,
    pub fingerprint: Option<String>,
    pub timeout_ms: u64,
}
impl SidecarConfig {
    pub fn off() -> Self {
        Self {
            mode: SidecarMode::Off,
            url: None,
            ca_bundle: None,
            fingerprint: None,
            timeout_ms: 5000,
        }
    }
}
fn url_checked(s: &str) -> Result<reqwest::Url> {
    let u = reqwest::Url::parse(s).map_err(|e| e.to_string())?;
    if !["http", "https", "valkey", "redis"].contains(&u.scheme())
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        Err("sidecar URL must use HTTP(S) or Valkey/Redis, without credentials or fragment".into())
    } else {
        Ok(u)
    }
}
fn pin_bytes(s: &str) -> Result<Vec<u8>> {
    let s = s
        .strip_prefix("sha256:")
        .ok_or("fingerprint requires sha256:<64 lowercase hex>")?;
    if s.len() != 64
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("fingerprint requires 64 lowercase hex digits".into());
    }
    (0..32)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string()))
        .collect()
}
pub fn certificate_fingerprint(der: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(der))
}
pub fn verify_fingerprint(expected: &str, der: &[u8]) -> Result<()> {
    let pin = pin_bytes(expected)?;
    let hash = Sha256::digest(der);
    if pin
        .iter()
        .zip(hash)
        .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
        == 0
    {
        Ok(())
    } else {
        Err("remote sidecar TLS certificate fingerprint mismatch".into())
    }
}
pub fn resolve_endpoint(
    id: &str,
    config: &SidecarConfig,
    bundled: Option<&str>,
) -> Result<Option<String>> {
    crate::model::validate_name(id)?;
    if config.mode == SidecarMode::Off {
        return Ok(None);
    }
    if config.timeout_ms == 0 || config.timeout_ms > 120000 {
        return Err("sidecar timeout must be 1..120000 ms".into());
    }
    let endpoint = match config.mode {
        SidecarMode::Bundled => bundled.ok_or("bundled endpoint unavailable")?,
        SidecarMode::Remote => config.url.as_deref().ok_or("remote sidecar requires url")?,
        SidecarMode::Off => unreachable!(),
    };
    let url = url_checked(endpoint)?;
    if ["valkey", "redis"].contains(&url.scheme()) && id != "valkey" {
        return Err("only Valkey accepts a Redis-protocol endpoint".into());
    }
    if let Some(pin) = &config.fingerprint {
        pin_bytes(pin)?;
        if url.scheme() != "https" {
            return Err("certificate fingerprint requires HTTPS".into());
        }
    }
    if config.ca_bundle.is_some() && url.scheme() != "https" {
        return Err("CA bundle requires HTTPS".into());
    }
    Ok(Some(endpoint.into()))
}
/// Injected health transport keeps all unit tests offline. Real requests never follow redirects.
pub trait HealthProbe {
    fn check(&self, url: &str, config: &SidecarConfig) -> Result<()>;
}
pub struct HttpHealthProbe;
impl HealthProbe for HttpHealthProbe {
    fn check(&self, url: &str, config: &SidecarConfig) -> Result<()> {
        let checked = url_checked(url)?;
        if config.timeout_ms == 0 || config.timeout_ms > 120000 {
            return Err("invalid sidecar timeout".into());
        }
        if ["valkey", "redis"].contains(&checked.scheme()) {
            use std::{
                io::{Read, Write},
                net::{TcpStream, ToSocketAddrs},
            };
            if config.ca_bundle.is_some() || config.fingerprint.is_some() {
                return Err("Valkey over Tailscale uses its network encryption; HTTPS pins apply to HTTP services".into());
            }
            let timeout = Duration::from_millis(config.timeout_ms);
            let start = std::time::Instant::now();
            let host = checked
                .host_str()
                .ok_or("missing remote host")?
                .trim_matches(['[', ']'])
                .to_string();
            let port = checked.port().unwrap_or(6379);
            let addresses: Vec<std::net::SocketAddr> =
                if let Ok(ip) = host.parse::<std::net::IpAddr>() {
                    vec![std::net::SocketAddr::new(ip, port)]
                } else {
                    let (send, receive) = std::sync::mpsc::sync_channel(1);
                    std::thread::spawn(move || {
                        let _ = send.send(
                            (host.as_str(), port)
                                .to_socket_addrs()
                                .map(|v| v.collect::<Vec<_>>()),
                        );
                    });
                    receive
                        .recv_timeout(timeout)
                        .map_err(|_| "remote sidecar DNS deadline")?
                        .map_err(|e| format!("remote sidecar unreachable: {e}"))?
                };
            for address in addresses {
                let Some(left) = timeout.checked_sub(start.elapsed()) else {
                    break;
                };
                if let Ok(mut stream) = TcpStream::connect_timeout(&address, left) {
                    stream
                        .set_read_timeout(Some(left))
                        .map_err(|e| e.to_string())?;
                    stream
                        .set_write_timeout(Some(left))
                        .map_err(|e| e.to_string())?;
                    stream
                        .write_all(b"*1\r\n$4\r\nPING\r\n")
                        .map_err(|e| format!("remote sidecar unreachable: {e}"))?;
                    let left = timeout
                        .checked_sub(start.elapsed())
                        .ok_or("remote sidecar deadline")?;
                    stream
                        .set_read_timeout(Some(left))
                        .map_err(|e| e.to_string())?;
                    let mut pong = [0; 7];
                    stream
                        .read_exact(&mut pong)
                        .map_err(|e| format!("remote sidecar unreachable: {e}"))?;
                    return if &pong == b"+PONG\r\n" {
                        Ok(())
                    } else {
                        Err("remote Valkey refused credential-free PING".into())
                    };
                }
            }
            return Err("remote sidecar unreachable: Valkey connection deadline".into());
        }
        resolve_endpoint("health", config, Some(url))?;
        let mut builder = reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(config.timeout_ms))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .tls_info(true);
        if let Some(path) = &config.ca_bundle {
            let pem = std::fs::read(path).map_err(|e| format!("sidecar CA bundle: {e}"))?;
            for cert in reqwest::Certificate::from_pem_bundle(&pem).map_err(|e| e.to_string())? {
                builder = builder.add_root_certificate(cert);
            }
        }
        // Explicit certificate pin is the trust anchor for self-signed health endpoints.
        // This probe sends only a credential-free GET and checks the DER certificate before
        // accepting HTTP status or body. Consumers need their own pinned TLS client.
        if config.fingerprint.is_some() {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let response = builder
            .build()
            .map_err(|e| e.to_string())?
            .get(url)
            .send()
            .map_err(|e| format!("remote sidecar unreachable: {e}"))?;
        if let Some(pin) = &config.fingerprint {
            let der = response
                .extensions()
                .get::<reqwest::tls::TlsInfo>()
                .and_then(|t| t.peer_certificate())
                .ok_or("TLS peer certificate unavailable; refusing pinned sidecar")?;
            verify_fingerprint(pin, der)?;
        }
        if !response.status().is_success() {
            return Err(format!("sidecar health HTTP {}", response.status()));
        }
        Ok(())
    }
}
pub struct SidecarManager<P> {
    pub configs: BTreeMap<String, SidecarConfig>,
    pub bundled: BTreeMap<String, String>,
    pub probe: P,
}
impl<P: HealthProbe> SidecarManager<P> {
    pub fn resolve_endpoint(&self, id: &str) -> Result<Option<String>> {
        let c = self.configs.get(id).ok_or("unknown sidecar")?;
        resolve_endpoint(id, c, self.bundled.get(id).map(String::as_str))
    }
    pub fn health(&self, id: &str) -> Result<()> {
        if let Some(url) = self.resolve_endpoint(id)? {
            self.probe
                .check(&url, &self.configs[id])
                .map_err(|e| format!("sidecar {id}: {e}"))?;
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SidecarManifest {
    pub id: String,
    pub image: String,
    pub port: u16,
    pub health_command: Vec<String>,
    pub memory: u64,
    pub pids: u32,
    pub user: String,
    pub volumes: Vec<Mount>,
    pub license: String,
}
impl SidecarManifest {
    pub fn service(&self) -> Result<Service> {
        crate::model::validate_name(&self.id)?;
        let digest = self
            .image
            .rsplit_once("@sha256:")
            .map(|(_, d)| d)
            .ok_or("sidecar image must be digest-pinned")?;
        if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid sidecar digest".into());
        }
        let mut s = Service::harness(&self.image);
        s.name = format!("plur1bus-{}", self.id);
        s.egress = false;
        s.user = self.user.clone();
        s.memory = self.memory;
        s.pids = self.pids;
        s.port = self.port;
        s.mounts = self.volumes.clone();
        s.health_command = self.health_command.clone();
        s.validate()?;
        Ok(s)
    }
}
