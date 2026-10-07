//! What an extension asks for, as one flat, ordered list (spec §8.6 "disclosed before install"; X2 / D1).
//!
//! [`declared_rights`] turns a manifest's `capabilities` (and a remote MCP endpoint or a provider base URL) into
//! [`Right`]s with a stable id, so a disclosure, an acknowledgment hash and a test can all compare the same strings. A
//! right is *absent* when the extension does not ask for it (`network: none`, `spawn: false`, `authority: none` give
//! nothing). Nothing here enforces; the disclosure is the contract (spec §8.6, docs/extensions.md "What is not
//! protected").
use crate::manifest::P1xManifest;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Low,
    Medium,
    High,
}

/// One declared right: `id` is stable (`network:host:<h>`, `fs:<scope>[:<path>]:<access>`, `process:spawn`,
/// `process:command:<c>`, `secret:<slot>[:required]`, `hostbridge:<x>`, `harness:full`, `harness:scoped:<rpc>`,
/// `tool:<name>:<effect>`, `mcpapps`, `remote:<url>`, `provider:<baseUrl>`).
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct Right {
    pub id: String,
    pub risk: Risk,
}

fn right(id: impl Into<String>, risk: Risk) -> Right {
    Right {
        id: id.into(),
        risk,
    }
}

/// The rights `m` declares, sorted by id.
pub fn declared_rights(m: &P1xManifest) -> Vec<Right> {
    let c = &m.capabilities;
    let mut out = Vec::new();
    match c["network"]["mode"].as_str() {
        Some("none") => {}
        Some("allowlist") => {
            for h in c["network"]["hosts"].as_array().into_iter().flatten() {
                out.push(right(
                    format!("network:host:{}", h.as_str().unwrap_or("")),
                    Risk::Medium,
                ));
            }
        }
        // RULING: `any`, and a mode the schema would have refused, count as the widest network right.
        _ => out.push(right("network:any", Risk::High)),
    }
    for f in c["filesystem"].as_array().into_iter().flatten() {
        let scope = f["scope"].as_str().unwrap_or("");
        let access = f["access"].as_str().unwrap_or("read-write");
        let write = access != "read";
        let risk = match (scope, write) {
            ("home" | "path", true) => Risk::High,
            (_, true) | ("home" | "path", false) => Risk::Medium,
            _ => Risk::Low,
        };
        let id = if scope == "path" {
            format!("fs:path:{}:{access}", f["path"].as_str().unwrap_or(""))
        } else {
            format!("fs:{scope}:{access}")
        };
        out.push(right(id, risk));
    }
    if c["processes"]["spawn"] == true {
        out.push(right("process:spawn", Risk::High));
        for cmd in c["processes"]["commands"].as_array().into_iter().flatten() {
            out.push(right(
                format!("process:command:{}", cmd.as_str().unwrap_or("")),
                Risk::High,
            ));
        }
    }
    for s in c["secrets"].as_array().into_iter().flatten() {
        let req = if s["required"] == true {
            ":required"
        } else {
            ""
        };
        out.push(right(
            format!("secret:{}{req}", s["slot"].as_str().unwrap_or("")),
            Risk::Medium,
        ));
    }
    for b in c["hostBridge"].as_array().into_iter().flatten() {
        out.push(right(
            format!("hostbridge:{}", b.as_str().unwrap_or("")),
            Risk::High,
        ));
    }
    match c["harness"]["authority"].as_str() {
        Some("full") => out.push(right("harness:full", Risk::High)),
        Some("scoped") => {
            for r in c["harness"]["rpc"].as_array().into_iter().flatten() {
                out.push(right(
                    format!("harness:scoped:{}", r.as_str().unwrap_or("")),
                    Risk::Medium,
                ));
            }
        }
        _ => {}
    }
    for t in c["tools"].as_array().into_iter().flatten() {
        let effect = t["effect"].as_str().unwrap_or("destructive");
        let risk = match effect {
            "read" => Risk::Low,
            "write" => Risk::Medium,
            _ => Risk::High,
        };
        out.push(right(
            format!("tool:{}:{effect}", t["name"].as_str().unwrap_or("")),
            risk,
        ));
    }
    if c["mcpApps"] == true {
        out.push(right("mcpapps", Risk::Medium));
    }
    if let Some(url) = m.rest.get("remote").and_then(|r| r["url"].as_str()) {
        out.push(right(format!("remote:{url}"), Risk::Medium));
    }
    if let Some(url) = m
        .rest
        .get("provider")
        .and_then(|p: &Value| p["baseUrl"].as_str())
    {
        out.push(right(format!("provider:{url}"), Risk::Medium));
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out.dedup_by(|a, b| a.id == b.id);
    out
}

/// The highest risk among `rights`, `None` for an extension that asks for nothing.
pub fn max_risk(rights: &[Right]) -> Option<Risk> {
    rights.iter().map(|r| r.risk).max()
}
