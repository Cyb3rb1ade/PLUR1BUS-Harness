//! Shared-engine local-only admission and read-only diagnostics. Cross-language vectors pin URL/scope behavior.
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SharedPolicy {
    pub required: bool,
    pub agents: Vec<String>,
    pub blocked: Vec<String>,
}
impl SharedPolicy {
    pub fn reason(&self) -> &'static str {
        if self.agents.is_empty() {
            "local-only"
        } else {
            "local-only-shared-engine"
        }
    }
    pub fn message(&self) -> String {
        let source = if self.agents.is_empty() {
            "privacy.localOnly".into()
        } else {
            format!("agents {}", self.agents.join(", "))
        };
        format!("Shared engine {} must use local endpoints because of {source}; choose local engine models or review privacy.localEndpoints",self.blocked.join(", "))
    }
}
pub fn installation(cfg: &Value) -> bool {
    cfg.pointer("/privacy/localOnly") == Some(&Value::Bool(true))
}
pub fn agents(cfg: &Value) -> Vec<String> {
    let mut result = cfg["agents"]
        .as_object()
        .into_iter()
        .flat_map(|a| a.iter())
        .filter(|(_, a)| a.pointer("/privacy/localOnly") == Some(&Value::Bool(true)))
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    result.sort();
    result
}
pub fn local_endpoint(raw: &str, listed: &[String]) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let host = url
        .host_str()
        .unwrap_or("")
        .trim_start_matches('[')
        .trim_end_matches(']');
    if host == "localhost"
        || host == "::1"
        || host
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|ip| ip.is_loopback())
    {
        return true;
    }
    listed
        .iter()
        .any(|entry| reqwest::Url::parse(entry).is_ok_and(|e| e.origin() == url.origin()))
}
fn endpoint(out: &mut Vec<(String, Option<String>)>, role: &str, value: Option<&str>) {
    out.push((role.into(), value.map(str::to_owned)));
}
fn walk(node: &Value, path: &str, depth: usize, out: &mut Vec<(String, Option<String>)>) {
    if depth > 6 {
        return;
    }
    let Some(map) = node.as_object() else {
        return;
    };
    if let Some(url) = map.get("baseUrl").and_then(Value::as_str) {
        endpoint(out, path, Some(url));
    } else if map.get("apiKey").is_some_and(|v| !v.is_null() && v != "")
        || map.get("apiKeyEnv").is_some_and(Value::is_string)
    {
        endpoint(out, path, None);
    }
    for (key, value) in map {
        if key != "__proto__" && key != "headers" {
            walk(value, &format!("{path}.{key}"), depth + 1, out);
        }
    }
}
pub fn engine_endpoints(cfg: &Value) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    let engine = &cfg["engine"];
    for (key, default) in [
        ("embedding", "https://api.openai.com/v1"),
        ("reranker", "https://api.cohere.com/v2/rerank"),
    ] {
        if let Some(block) = engine.get(key).filter(|v| v.is_object()) {
            if block
                .get("provider")
                .is_some_and(|p| p != "local-transformers")
            {
                endpoint(
                    &mut out,
                    key,
                    Some(if key == "embedding" {
                        block["baseUrl"].as_str().unwrap_or(default)
                    } else {
                        default
                    }),
                );
            }
        }
    }
    if let Some(map) = engine.as_object() {
        for (key, value) in map {
            if !matches!(key.as_str(), "embedding" | "reranker" | "__proto__") {
                walk(value, key, 1, &mut out);
            }
        }
    }
    out
}
pub fn shared(cfg: &Value) -> SharedPolicy {
    let agents = agents(cfg);
    let required = installation(cfg) || !agents.is_empty();
    let listed = cfg
        .pointer("/privacy/localEndpoints")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut blocked = if required {
        engine_endpoints(cfg)
            .into_iter()
            .filter(|(_, url)| url.as_deref().is_none_or(|u| !local_endpoint(u, &listed)))
            .map(|(role, _)| role)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    blocked.sort();
    SharedPolicy {
        required,
        agents,
        blocked,
    }
}
pub fn violation(cfg: &Value) -> Option<SharedPolicy> {
    let p = shared(cfg);
    (!p.blocked.is_empty()).then_some(p)
}

/// The accepted configuration can already describe a future engine. Check the bound process too.
/// Only endpoint origins are stored by Core, never paths, credentials, headers or keys.
pub fn running_violation(layout: &crate::paths::Layout, cfg: &Value) -> Option<SharedPolicy> {
    if let Some(policy) = violation(cfg) {
        return Some(policy);
    }
    let mut policy = shared(cfg);
    if !policy.required {
        return None;
    }
    let pid_record = match layout.read_token_file(&layout.core_pid()) {
        Ok(s) => s,
        Err(_) => return None,
    };
    let mut fields = pid_record.split_whitespace();
    let pid = fields.next().and_then(|p| p.parse::<u32>().ok())?;
    if !crate::proc::pid_alive(pid) {
        return None;
    }
    let instance = fields.next().unwrap_or("");
    let snapshot = layout.run().join("engine-models.json");
    let read = || -> Option<Value> {
        let meta = std::fs::symlink_metadata(&snapshot).ok()?;
        if !meta.is_file() || meta.len() > 1024 * 1024 {
            return None;
        }
        serde_json::from_str(&layout.read_token_file(&snapshot).ok()?).ok()
    };
    let data = read();
    let rows = data
        .as_ref()
        .filter(|v| v["version"] == 1 && v["pid"] == pid && v["instanceId"] == instance)
        .and_then(|v| v["endpoints"].as_array());
    let Some(rows) = rows else {
        policy
            .blocked
            .push("running engine (endpoint inventory unavailable; restart Core first)".into());
        return Some(policy);
    };
    let listed: Vec<String> = cfg
        .pointer("/privacy/localEndpoints")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    for row in rows {
        if row["endpoint"]
            .as_str()
            .is_none_or(|u| !local_endpoint(u, &listed))
        {
            let role = row["role"].as_str().unwrap_or("unknown");
            policy.blocked.push(format!(
                "running {role} (restart Core after changing engine models)"
            ));
        }
    }
    (!policy.blocked.is_empty()).then_some(policy)
}

/// Shared services are pinned by any agent; ordinary chat/voice/media adapters by the installation switch.
pub fn findings(cfg: &Value) -> Vec<String> {
    let listed = cfg
        .pointer("/privacy/localEndpoints")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let local = |v: Option<&str>| v.is_some_and(|u| local_endpoint(u, &listed));
    let mut out = Vec::new();
    if installation(cfg) {
        if let Some(map) = cfg["providers"].as_object() {
            for (id, d) in map {
                if d.get("wireFormat").is_some()
                    && !local(d.pointer("/profile/base_url").and_then(Value::as_str))
                {
                    out.push(format!("chat provider {id}"));
                }
            }
        }
        if let Some(adapters) = cfg
            .pointer("/providers/media/adapters")
            .and_then(Value::as_array)
        {
            for d in adapters {
                let id = d["id"].as_str().unwrap_or("unknown");
                if id == "coreml-local" {
                    continue;
                }
                let url = d["baseUrl"].as_str().or(if id == "draw-things" {
                    Some("http://127.0.0.1:7860")
                } else {
                    None
                });
                if !local(url) {
                    out.push(format!("media adapter {id}"));
                }
            }
        }
        if let Some(providers) = cfg.pointer("/voice/providers").and_then(Value::as_object) {
            for (id, d) in providers {
                if d["enabled"] == true && !local(d["baseUrl"].as_str()) {
                    out.push(format!("voice provider {id}"));
                }
            }
        }
    }
    let media = &cfg["memory"]["mediaEmbedding"];
    let local_provider = |p: &str| matches!(p, "local" | "local-transformers" | "egemma2" | "off");
    if media["enabled"] != false {
        if let Some(provider) = media["provider"].as_str().filter(|p| !local_provider(p)) {
            out.push(format!("media index provider {provider}"));
        }
    }
    let caption = &media["caption"];
    if caption["source"] != "off" {
        if let Some(provider) = caption["provider"].as_str().filter(|p| !local_provider(p)) {
            out.push(format!("caption provider {provider}"));
        }
    }
    for (role, url) in engine_endpoints(cfg) {
        if !local(url.as_deref()) {
            out.push(format!("engine {role}"));
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_admission_uses_the_bound_engine_and_pid_not_the_future_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let layout = crate::paths::Layout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(layout.run()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(layout.run(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let pid = std::process::id();
        std::fs::write(layout.core_pid(), format!("{pid} instance\n")).unwrap();
        let cfg = serde_json::json!({"privacy":{"localOnly":true},"engine":{}});
        assert!(
            violation(&cfg).is_none(),
            "prospective local configuration is allowed offline"
        );
        assert!(
            running_violation(&layout, &cfg).is_some(),
            "a live legacy core without an inventory is unverified"
        );
        let snapshot = layout.run().join("engine-models.json");
        let write = |url: &str, instance: &str| {
            std::fs::write(&snapshot,
            serde_json::json!({"version":1,"pid":pid,"instanceId":instance,"endpoints":[{"role":"embedding","endpoint":url}]}).to_string()).unwrap()
        };
        write("https://cloud.invalid", "instance");
        assert!(running_violation(&layout, &cfg).unwrap().blocked[0].contains("running embedding"));
        write("http://127.0.0.1:1234", "instance");
        assert!(running_violation(&layout, &cfg).is_none());
        write("http://127.0.0.1:1234", "stale");
        assert!(
            running_violation(&layout, &cfg).is_some(),
            "stale process instance never grants permission"
        );
        write("http://192.168.1.4:1234", "instance");
        let allowed = serde_json::json!({"privacy":{"localOnly":true,"localEndpoints":["http://192.168.1.4:1234"]}});
        assert!(running_violation(&layout, &allowed).is_none());
        assert!(
            running_violation(&layout, &cfg).is_some(),
            "removing the live allowlist cannot relabel a bound LAN adapter"
        );
    }

    #[test]
    fn shared_engine_matches_the_typescript_policy_vectors() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/privacy-local-only.json"
        ))
        .unwrap();
        for c in cases.as_array().unwrap() {
            let actual = serde_json::to_value(shared(&c["config"])).unwrap();
            assert_eq!(
                actual,
                serde_json::json!({"required":c["required"],"agents":c["agents"],"blocked":c["blocked"]}),
                "{}",
                c["name"]
            );
        }
    }
}
