//! The disclosure an install or enable prints (spec §8.3): trust tier and why, signer key, publisher, licence, summary,
//! every capability in plain language, every script with its size and first line, runtime, secrets and `replaces`.
use super::strings;
use serde_json::Value;

pub(super) fn lang(v: &Value) -> Option<String> {
    v.get("en")
        .or_else(|| v.as_object().and_then(|m| m.values().next()))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The capability block in plain language, one line per key (spec §8.3).
pub(super) fn capability_lines(caps: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let net = &caps["network"];
    out.push(match net["mode"].as_str() {
        Some("none") => "network: no network access".to_string(),
        Some("allowlist") => format!(
            "network: may connect to {}",
            strings(&net["hosts"]).join(", ")
        ),
        Some("any") => "network: may connect to any host".to_string(),
        _ => "network: not declared".to_string(),
    });
    match caps["filesystem"].as_array() {
        Some(list) if list.is_empty() => out.push("files: no access outside its own folder".into()),
        Some(list) => {
            for e in list {
                let what = match e["scope"].as_str() {
                    Some("agent-workspace") => "the agent's workspace".to_string(),
                    Some("extension-data") => "its own data folder".to_string(),
                    Some("home") => "your home folder".to_string(),
                    Some("path") => e["path"].as_str().unwrap_or("?").to_string(),
                    Some(o) => o.to_string(),
                    None => "?".to_string(),
                };
                let how = match e["access"].as_str() {
                    Some("read-write") => "may read and write",
                    _ => "may read",
                };
                out.push(format!("files: {how} {what}"));
            }
        }
        None => out.push("files: not declared".into()),
    }
    let procs = &caps["processes"];
    out.push(match procs["spawn"].as_bool() {
        Some(true) => {
            let cmds = strings(&procs["commands"]);
            if cmds.is_empty() {
                "programs: may start any program".to_string()
            } else {
                format!("programs: may start {}", cmds.join(", "))
            }
        }
        Some(false) => "programs: starts no programs".to_string(),
        None => "programs: not declared".to_string(),
    });
    let harness = &caps["harness"];
    out.push(match harness["authority"].as_str() {
        Some("none") => "harness: no access to the harness".to_string(),
        Some("scoped") => format!("harness: may call {}", strings(&harness["rpc"]).join(", ")),
        Some("full") => "harness: full control of the harness".to_string(),
        _ => "harness: not declared".to_string(),
    });
    let secrets: Vec<String> = caps["secrets"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            let slot = s["slot"].as_str().unwrap_or("?");
            let label = lang(&s["label"]).unwrap_or_default();
            let req = if s["required"] == true {
                "required"
            } else {
                "optional"
            };
            format!("{slot} ({label}, {req})")
        })
        .collect();
    out.push(if secrets.is_empty() {
        "secrets: none".to_string()
    } else {
        format!("secrets: {}", secrets.join(", "))
    });
    out
}

/// "contains N programs your agents can run" and one line per script: path, size, first line.
pub(super) fn script_lines(scripts: &Value) -> Vec<String> {
    let list = scripts.as_array().cloned().unwrap_or_default();
    let mut out = vec![format!(
        "contains {} program{} your agents can run",
        list.len(),
        if list.len() == 1 { "" } else { "s" }
    )];
    for s in &list {
        let mut l = format!(
            "  {} ({} bytes)",
            s["path"].as_str().unwrap_or("?"),
            s["size"].as_u64().unwrap_or(0)
        );
        if let Some(first) = s["firstLine"].as_str() {
            l.push_str(&format!(": {first}"));
        }
        out.push(l);
    }
    out
}

pub(super) fn trust_line(trust: &Value) -> String {
    let tier = trust["tier"].as_str().or(trust.as_str()).unwrap_or("?");
    let key = trust["keyId"].as_str();
    match tier {
        "first-party" => format!(
            "trust: first-party (signed by {}{})",
            trust["label"].as_str().unwrap_or("a pinned key"),
            key.map(|k| format!(", key {k}")).unwrap_or_default()
        ),
        "unknown-signer" => format!(
            "trust: unknown signer (signed with key {}, which this harness does not trust; anyone can make a key)",
            key.unwrap_or("?")
        ),
        "unsigned" => {
            "trust: unsigned (nobody vouches for this package; anyone could have made or changed it)".to_string()
        }
        "release" => "trust: release (shipped with the harness)".to_string(),
        "dev" => "trust: dev (a local folder)".to_string(),
        other => format!("trust: {other}"),
    }
}

pub(super) fn runtime_line(requires: &Value) -> String {
    let rt = &requires["runtime"];
    match rt["type"].as_str() {
        Some("none") | None => "runtime: none".to_string(),
        Some(t) => match rt["range"].as_str() {
            Some(r) => format!("runtime: {t} {r}"),
            None => format!("runtime: {t}"),
        },
    }
}

/// The disclosure of an inspection (`ExtInspection`, or `ext verify`'s document): what the person confirms.
pub(crate) fn describe_inspection(v: &Value) -> String {
    let m = &v["manifest"];
    let tier = v["trust"]["tier"].as_str().unwrap_or("?");
    let mut lines = vec![format!(
        "{} {} ({}){}",
        m["id"].as_str().unwrap_or("?"),
        m["version"].as_str().unwrap_or("?"),
        m["kind"].as_str().unwrap_or("?"),
        lang(&m["title"])
            .map(|t| format!(": {t}"))
            .unwrap_or_default()
    )];
    lines.push(trust_line(&v["trust"]));
    if let Some(k) = v["trust"]["keyId"].as_str() {
        lines.push(format!("signer key: {k}"));
    }
    let verified = matches!(tier, "first-party" | "release");
    lines.push(format!(
        "publisher: {} ({}){}",
        m["publisher"]["name"].as_str().unwrap_or("?"),
        m["publisher"]["id"].as_str().unwrap_or("?"),
        if verified { "" } else { ", unverified" }
    ));
    lines.push(format!("licence: {}", m["licence"].as_str().unwrap_or("?")));
    if let Some(s) = lang(&m["summary"]) {
        lines.push(format!("summary: {s}"));
    }
    if matches!(m["kind"].as_str(), Some("module" | "channel")) {
        lines.push("authority: runs as a harness process with full authority".into());
    }
    let caps = if v["capabilities"].is_object() {
        &v["capabilities"]
    } else {
        &m["capabilities"]
    };
    lines.extend(capability_lines(caps));
    lines.extend(script_lines(&v["scripts"]));
    let requires = if v["requires"].is_object() {
        &v["requires"]
    } else {
        &m["requires"]
    };
    lines.push(runtime_line(requires));
    if let Some(r) = v.get("replaces").filter(|r| r.is_object()) {
        let changed = strings(&r["capabilityDiff"]["changed"]);
        lines.push(format!(
            "replaces: the installed {}{}",
            r["version"].as_str().unwrap_or("?"),
            if changed.is_empty() {
                " (same capabilities)".to_string()
            } else {
                format!(" (capabilities changed: {})", changed.join(", "))
            }
        ));
    }
    if let Some(prev) = v.get("previousCapabilities").filter(|p| p.is_object()) {
        lines.push("capabilities acknowledged before:".into());
        lines.extend(capability_lines(prev).into_iter().map(|l| format!("  {l}")));
    }
    for c in v["checks"].as_array().into_iter().flatten() {
        if c["status"] != "pass" {
            lines.push(format!(
                "check {} {}: {}",
                c["id"].as_str().unwrap_or("?"),
                c["status"].as_str().unwrap_or("?"),
                c["detail"].as_str().unwrap_or("")
            ));
        }
    }
    lines.join("\n")
}

/// The capability disclosure of an enable (`acknowledge-capabilities` data): what enabling lets the item do.
pub(super) fn describe_capabilities(d: &Value) -> String {
    let mut lines = vec![format!(
        "{} {} ({}), {}",
        d["id"].as_str().or(d["name"].as_str()).unwrap_or("?"),
        d["version"].as_str().unwrap_or("?"),
        d["kind"].as_str().unwrap_or("?"),
        trust_line(&d["trust"]).replacen("trust: ", "trust ", 1)
    )];
    if d["authority"] == "full" {
        lines.push("authority: runs as a harness process with full authority".into());
    }
    lines.extend(capability_lines(&d["capabilities"]));
    lines.extend(script_lines(&d["scripts"]));
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_read_in_plain_language() {
        let lines = capability_lines(&serde_json::json!({
            "network": { "mode": "allowlist", "hosts": ["api.example.org"] },
            "filesystem": [{ "scope": "agent-workspace", "access": "read-write" }],
            "processes": { "spawn": true },
            "harness": { "authority": "scoped", "rpc": ["memory.recall"] },
            "secrets": [{ "slot": "TOKEN", "label": { "en": "API token" }, "required": true }]
        }));
        assert_eq!(
            lines,
            [
                "network: may connect to api.example.org",
                "files: may read and write the agent's workspace",
                "programs: may start any program",
                "harness: may call memory.recall",
                "secrets: TOKEN (API token, required)",
            ]
        );
    }

    #[test]
    fn scripts_are_counted_and_listed_with_size_and_first_line() {
        let lines = script_lines(&serde_json::json!([
            { "path": "payload/scripts/run.sh", "size": 18, "firstLine": "#!/bin/sh" },
            { "path": "payload/bin/tool", "size": 3 }
        ]));
        assert_eq!(
            lines,
            [
                "contains 2 programs your agents can run",
                "  payload/scripts/run.sh (18 bytes): #!/bin/sh",
                "  payload/bin/tool (3 bytes)",
            ]
        );
        assert_eq!(
            script_lines(&serde_json::json!([]))[0],
            "contains 0 programs your agents can run"
        );
    }

    #[test]
    fn the_publisher_is_unverified_below_first_party() {
        let insp = |tier: &str| {
            serde_json::json!({
                "manifest": { "id": "demo/x", "version": "1.0.0", "kind": "skill", "licence": "MIT",
                              "publisher": { "id": "demo", "name": "Demo" } },
                "trust": { "tier": tier, "keyId": "ABCDEF0123456789" },
                "capabilities": {}, "scripts": [], "requires": { "runtime": { "type": "none" } },
            })
        };
        assert!(describe_inspection(&insp("unknown-signer")).contains("Demo (demo), unverified"));
        assert!(describe_inspection(&insp("unsigned")).contains("unverified"));
        let fp = describe_inspection(&insp("first-party"));
        assert!(!fp.contains("unverified"), "{fp}");
        assert!(fp.contains("signer key: ABCDEF0123456789"), "{fp}");
    }
}
