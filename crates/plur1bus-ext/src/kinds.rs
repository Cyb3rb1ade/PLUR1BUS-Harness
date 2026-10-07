//! Per-kind consistency of a schema-valid manifest (spec 2026-09-27 §5.2 "Kind-specific consistency", §8.6; X2 / D1).
//!
//! The JSON Schema fixes the shape of every field; this module judges what a field means for the *kind*: what a skill,
//! an MCP server or a provider may ask for, and what it must declare before it is installed. It reads the manifest
//! only (no package bytes) and refuses with `E_INVALID_PARAMS reason=package-invalid`, the detail naming the field.
//! Every rule that the spec leaves open is the conservative one (fail closed) and is marked `RULING`.
use crate::manifest::{Kind, P1xManifest};
use crate::refusal::{reason, Refusal};
use serde_json::Value;
use std::collections::BTreeSet;

fn bad(detail: impl Into<String>) -> Refusal {
    Refusal::invalid(reason::PACKAGE_INVALID, detail)
}

/// The host of an `https://` URL, lower-cased, without port. Refuses credentials, an empty host and anything that is
/// not a plain `https://host[:port][/path]`.
pub fn url_host(url: &str) -> Result<String, String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| format!("{url:?} is not an https URL"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // RULING: userinfo in a URL is refused outright, so a secret never travels in a manifest.
    if authority.contains('@') {
        return Err(format!("{url:?} carries credentials in the URL"));
    }
    let host = match authority.rsplit_once(':') {
        Some((h, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => h,
        Some(_) => return Err(format!("{url:?} has a malformed port")),
        None => authority,
    };
    if host.is_empty() || host.starts_with('[') {
        // RULING: IP literals in brackets are not allowlistable by name; refused.
        return Err(format!("{url:?} has no usable host name"));
    }
    Ok(host.to_ascii_lowercase())
}

/// An allowlist entry: `host.name` or `*.host.name`, lower-case letters, digits, `-` and `.`; no scheme, port or path.
fn valid_allow_host(h: &str) -> bool {
    let body = h.strip_prefix("*.").unwrap_or(h);
    !body.is_empty()
        && body.len() <= 253
        && !body.starts_with(['.', '-'])
        && !body.ends_with(['.', '-'])
        && !body.contains("..")
        && body
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
}

fn allows(hosts: &[String], host: &str) -> bool {
    hosts.iter().any(|h| match h.strip_prefix("*.") {
        Some(suffix) => host.len() > suffix.len() && host.ends_with(&format!(".{suffix}")),
        None => h == host,
    })
}

fn runtime_type(m: &P1xManifest) -> &str {
    m.requires["runtime"]["type"].as_str().unwrap_or("none")
}

fn authority(m: &P1xManifest) -> &str {
    m.capabilities["harness"]["authority"]
        .as_str()
        .unwrap_or("none")
}

fn spawns(m: &P1xManifest) -> bool {
    m.capabilities["processes"]["spawn"].as_bool() == Some(true)
}

fn net_mode(m: &P1xManifest) -> &str {
    m.capabilities["network"]["mode"].as_str().unwrap_or("none")
}

fn net_hosts(m: &P1xManifest) -> Vec<String> {
    m.capabilities["network"]["hosts"]
        .as_array()
        .map(|a| a.iter().filter_map(|h| h.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn has_value(m: &P1xManifest, key: &str) -> bool {
    m.rest.get(key).is_some_and(|v| !v.is_null())
}

/// The network declaration of an extension that talks to one fixed endpoint: an allowlist that names that host.
fn require_endpoint_allowlist(m: &P1xManifest, what: &str, url: &str) -> Result<(), Refusal> {
    let host = url_host(url).map_err(|e| bad(format!("{what}: {e}")))?;
    // RULING: `mode: any` is refused for a fixed endpoint: the declaration must name where the data goes.
    if net_mode(m) != "allowlist" {
        return Err(bad(format!(
            "capabilities.network: {what} {url:?} needs an allowlist naming {host}, not mode {:?}",
            net_mode(m)
        )));
    }
    if !allows(&net_hosts(m), &host) {
        return Err(bad(format!(
            "capabilities.network.hosts does not allow {host}, the host of {what}"
        )));
    }
    Ok(())
}

/// Checks `m` against the rules of its kind.
///
/// Common to every kind: allowlist hosts are bare lower-case names (`*.` prefix allowed), secret slots are unique, the
/// `remote` block exists only on an `mcp-server` and the `provider` block only on a `provider`.
///
/// - `skill`: no harness authority (`none`).
/// - `mcp-server`: either `remote` (nothing runs locally: runtime `none`, no spawn, no scripts; the network
///   allowlist names the URL's host; `auth: header` needs a required secret slot) or local (runtime `node`, `python`
///   or `binary`, `processes.spawn`, a non-empty payload); never `authority: full`.
/// - `provider`: a `provider` block; pure data (runtime `none`, no spawn, no scripts, authority `none`); the allowlist
///   names the base URL's host.
/// - `module`, `channel`: the common rules only (they run with full authority, §8.6).
pub fn check_kind(m: &P1xManifest) -> Result<(), Refusal> {
    // Common.
    if has_value(m, "remote") && m.kind != Kind::McpServer {
        return Err(bad("remote: only an mcp-server may declare a remote endpoint"));
    }
    if has_value(m, "provider") && m.kind != Kind::Provider {
        return Err(bad("provider: only a provider may declare a provider block"));
    }
    if net_mode(m) == "allowlist" {
        for h in net_hosts(m) {
            if !valid_allow_host(&h) {
                return Err(bad(format!(
                    "capabilities.network.hosts: {h:?} is not a bare lower-case host name"
                )));
            }
        }
    }
    let mut slots = BTreeSet::new();
    for s in m.capabilities["secrets"].as_array().into_iter().flatten() {
        let slot = s["slot"].as_str().unwrap_or("");
        if !slots.insert(slot.to_string()) {
            return Err(bad(format!(
                "capabilities.secrets: the slot {slot:?} is declared twice"
            )));
        }
    }

    match m.kind {
        Kind::Skill => {
            // RULING: a skill is text the model reads; it never holds harness authority.
            if authority(m) != "none" {
                return Err(bad("capabilities.harness.authority: a skill has authority none"));
            }
        }
        Kind::Module | Kind::Channel | Kind::Bundle => {}
        Kind::McpServer => check_mcp(m)?,
        Kind::Provider => check_provider(m)?,
    }
    Ok(())
}

fn no_code(m: &P1xManifest, what: &str) -> Result<(), Refusal> {
    if runtime_type(m) != "none" {
        return Err(bad(format!(
            "requires.runtime: {what} runs nothing locally, the runtime is none (not {})",
            runtime_type(m)
        )));
    }
    if spawns(m) {
        return Err(bad(format!(
            "capabilities.processes.spawn: {what} does not spawn processes"
        )));
    }
    if !m.scripts.is_empty() {
        return Err(bad(format!(
            "scripts: {what} carries no script ({})",
            m.scripts.join(", ")
        )));
    }
    Ok(())
}

fn check_mcp(m: &P1xManifest) -> Result<(), Refusal> {
    // RULING: an MCP server serves tools; it never gets `full` harness authority (scoped RPC at most).
    if authority(m) == "full" {
        return Err(bad(
            "capabilities.harness.authority: an mcp-server never holds full authority",
        ));
    }
    if !has_value(m, "remote") {
        if !matches!(runtime_type(m), "node" | "python" | "binary") {
            return Err(bad(
                "requires.runtime: a local mcp-server names its runtime (node, python or binary)",
            ));
        }
        if !spawns(m) {
            return Err(bad(
                "capabilities.processes.spawn: a local mcp-server is a process; spawn must be true",
            ));
        }
        if m.files.is_empty() {
            return Err(bad("payload: a local mcp-server carries its code, the payload is empty"));
        }
        return Ok(());
    }
    let r = &m.rest["remote"];
    no_code(m, "a remote mcp-server")?;
    let url = r["url"].as_str().unwrap_or("");
    require_endpoint_allowlist(m, "the remote endpoint", url)?;
    if r["auth"] == "header" {
        let has_required = m.capabilities["secrets"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|s| s["required"] == true);
        if !has_required {
            return Err(bad(
                "capabilities.secrets: remote auth \"header\" needs a required secret slot for the header value",
            ));
        }
    }
    Ok(())
}

fn check_provider(m: &P1xManifest) -> Result<(), Refusal> {
    let Some(p) = m.rest.get("provider").filter(|v| !v.is_null()) else {
        return Err(bad("provider: a provider declares its provider block"));
    };
    no_code(m, "a provider")?;
    // RULING: a provider is data the harness interprets; no authority at all.
    if authority(m) != "none" {
        return Err(bad("capabilities.harness.authority: a provider has authority none"));
    }
    require_endpoint_allowlist(m, "the provider baseUrl", value_str(p, "baseUrl"))
}

fn value_str<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
