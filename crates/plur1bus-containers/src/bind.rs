//! Which host ports a service publishes and on which address. The runtimes already honour `Service::bind` when
//! `Service::publish` is set (Docker `PortBindings.HostIp`, Apple `--publish ADDR:HOST:CONTAINER`); this module is the
//! one place that answers "what will be exposed" for status output and for the non-loopback warning.
use crate::*;
use serde::Serialize;
use std::net::IpAddr;

/// One published port, as the runtimes receive it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedPort {
    pub service: String,
    pub address: IpAddr,
    pub host_port: u16,
    pub container_port: u16,
}

/// The ports `s` publishes on the host. Empty unless a host port is set: a service publishes nothing by default.
pub fn published_ports(s: &Service) -> Vec<PublishedPort> {
    s.publish
        .map(|host_port| PublishedPort {
            service: s.name.clone(),
            address: s.bind,
            host_port,
            container_port: s.port,
        })
        .into_iter()
        .collect()
}

fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_loopback(),
        IpAddr::V6(v) => v.is_loopback(),
    }
}

fn network_kind(ip: IpAddr) -> &'static str {
    match ip {
        IpAddr::V4(v) if v.octets()[0] == 100 => "tailnet address",
        IpAddr::V4(_) => "private LAN address",
        IpAddr::V6(_) => "unique-local address",
    }
}

/// The warning for publishing `port` on `ip`, or `None` on loopback. A wildcard or public address never gets this far:
/// `Service::validate` refuses it, so the warning only has to separate "this machine" from "a network I control".
pub fn bind_warning(service: &str, ip: IpAddr, port: u16) -> Option<String> {
    if is_loopback(ip) {
        return None;
    }
    Some(format!(
        "{service} publishes port {port} on {ip} ({kind}), not on loopback: every machine that can route to {ip} can reach it. \
         The API stays behind authentication and is never meant for the Internet; use this only on a network you control, \
         such as a company LAN or your tailnet.",
        kind = network_kind(ip)
    ))
}

/// Warnings for every published, non-loopback port of `services`.
pub fn bind_warnings(services: &[Service]) -> Vec<String> {
    services
        .iter()
        .flat_map(published_ports)
        .filter_map(|p| bind_warning(&p.service, p.address, p.host_port))
        .collect()
}
