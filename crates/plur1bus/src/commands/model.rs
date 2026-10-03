//! `plur1bus model list|scan|override`: model catalog, scanners and overrides CLI (D112 Task 10).
use crate::cli::ModelCmd;
use crate::commands::firstaid::Check;
use crate::commands::memory::connect;
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::output::Out;
use crate::paths::Layout;
use plur1bus_rpc::is_unavailable;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::time::Duration;

#[derive(Debug, Default, Clone)]
pub struct ListFilter {
    pub provider: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
    pub new_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedRole {
    pub provider: String,
    pub id: String,
    pub state: String,
}

/// Maps command line override flags to `models.setOverride` parameters.
#[allow(clippy::too_many_arguments)]
pub fn override_params(
    provider: &str,
    id: &str,
    name: Option<String>,
    kind: Option<String>,
    context_window: Option<u64>,
    capability: Vec<String>,
    alias: Vec<String>,
    clear: Vec<String>,
    clear_all: bool,
    create: bool,
) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("provider".to_string(), json!(provider));
    map.insert("id".to_string(), json!(id));

    let mut set = serde_json::Map::new();
    if let Some(n) = name {
        set.insert("displayName".to_string(), json!(n));
    }
    if let Some(k) = kind {
        set.insert("kind".to_string(), json!(k));
    }
    if let Some(cw) = context_window {
        set.insert("contextWindow".to_string(), json!(cw));
    }
    if !capability.is_empty() {
        set.insert("capabilities".to_string(), json!(capability));
    }
    if !alias.is_empty() {
        set.insert("aliases".to_string(), json!(alias));
    }
    if !set.is_empty() {
        map.insert("set".to_string(), Value::Object(set));
    }

    if clear_all {
        map.insert("clear".to_string(), json!("all"));
    } else if !clear.is_empty() {
        map.insert("clear".to_string(), json!(clear));
    }

    if create {
        map.insert("create".to_string(), json!(true));
    }

    Value::Object(map)
}

/// Resolves a role value against a catalog model list:
/// 1. `<provider>/<rest>` with the longest provider id matching `provider + "/"`, rest matched against id or aliases of that provider.
/// 2. bare `value` matched against id or aliases of any provider.
///
/// If multiple match, available/manual preferred over unavailable.
pub fn resolve_role(value: &str, models: &[Value]) -> Option<ResolvedRole> {
    let mut providers: Vec<String> = models
        .iter()
        .filter_map(|m| m.get("provider")?.as_str().map(String::from))
        .collect();
    providers.sort_by_key(|b| std::cmp::Reverse(b.len()));
    providers.dedup();

    for p in providers {
        let prefix = format!("{p}/");
        if let Some(rest) = value.strip_prefix(&prefix) {
            let matches: Vec<&Value> = models
                .iter()
                .filter(|m| {
                    m.get("provider").and_then(Value::as_str) == Some(&p)
                        && (m.get("id").and_then(Value::as_str) == Some(rest)
                            || m.get("aliases")
                                .and_then(Value::as_array)
                                .is_some_and(|arr| arr.iter().any(|a| a.as_str() == Some(rest))))
                })
                .collect();
            if !matches.is_empty() {
                let avail = matches.iter().find(|m| {
                    let st = m.get("status").and_then(Value::as_str).unwrap_or("");
                    st == "available" || st == "manual"
                });
                let chosen = avail.unwrap_or(&matches[0]);
                let st = chosen.get("status").and_then(Value::as_str).unwrap_or("");
                let state = if st == "available" || st == "manual" {
                    "available"
                } else {
                    "unavailable"
                };
                return Some(ResolvedRole {
                    provider: chosen
                        .get("provider")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    id: chosen
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    state: state.to_string(),
                });
            }
        }
    }

    let matches: Vec<&Value> = models
        .iter()
        .filter(|m| {
            m.get("id").and_then(Value::as_str) == Some(value)
                || m.get("aliases")
                    .and_then(Value::as_array)
                    .is_some_and(|arr| arr.iter().any(|a| a.as_str() == Some(value)))
        })
        .collect();
    if !matches.is_empty() {
        let avail = matches.iter().find(|m| {
            let st = m.get("status").and_then(Value::as_str).unwrap_or("");
            st == "available" || st == "manual"
        });
        let chosen = avail.unwrap_or(&matches[0]);
        let st = chosen.get("status").and_then(Value::as_str).unwrap_or("");
        let state = if st == "available" || st == "manual" {
            "available"
        } else {
            "unavailable"
        };
        return Some(ResolvedRole {
            provider: chosen
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            id: chosen
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            state: state.to_string(),
        });
    }

    None
}

/// Generates role warnings when a role points at an unavailable model (P9, R15).
pub fn role_warnings(catalog: &Value, roles: &Value) -> Vec<Value> {
    let mut warnings = Vec::new();
    let empty_models = Vec::new();
    let models = if let Some(arr) = catalog.as_array() {
        arr
    } else if let Some(arr) = catalog.get("models").and_then(Value::as_array) {
        arr
    } else {
        &empty_models
    };

    if let Some(role_map) = roles.as_object() {
        for (role, val) in role_map {
            if let Some(val_str) = val.as_str() {
                if let Some(res) = resolve_role(val_str, models) {
                    if res.state == "unavailable" {
                        warnings.push(json!({
                            "code": "role_unavailable",
                            "role": role,
                            "provider": res.provider,
                            "id": res.id,
                        }));
                    }
                }
            }
        }
    }
    warnings
}

/// Reads `modelRoles` from `config.json` if available.
pub fn read_config_roles(layout: &Layout) -> Value {
    if let Ok(c) = fs::read_to_string(layout.config_path()) {
        if let Ok(v) = serde_json::from_str::<Value>(&c) {
            return v.get("modelRoles").cloned().unwrap_or(json!({}));
        }
    }
    json!({})
}

/// Reads catalog models directly from disk when core is not available.
pub fn read_stale(layout: &Layout, filter: &ListFilter) -> Value {
    let path = layout.catalog_models();
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => {
            return json!({
                "models": [],
                "providers": [],
                "newCount": 0,
                "warnings": [],
                "stale": true,
                "note": "core not running: catalog/models.json does not exist yet"
            });
        }
    };

    let cat: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            return json!({
                "models": [],
                "providers": [],
                "newCount": 0,
                "warnings": [],
                "stale": true,
                "note": format!("core not running: catalog/models.json corrupt ({e})")
            });
        }
    };

    let ack_at = cat.get("acknowledgedAt").and_then(Value::as_str);
    let all_models = cat
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let new_count = all_models
        .iter()
        .filter(|m| {
            let status = m.get("status").and_then(Value::as_str).unwrap_or("");
            let source = m.get("source").and_then(Value::as_str).unwrap_or("");
            let first_seen = m.get("firstSeen").and_then(Value::as_str).unwrap_or("");
            status == "available" && source != "manual" && ack_at.is_none_or(|ack| first_seen > ack)
        })
        .count();

    let filtered_models: Vec<Value> = all_models
        .into_iter()
        .filter(|m| {
            if let Some(p) = &filter.provider {
                if m.get("provider").and_then(Value::as_str) != Some(p) {
                    return false;
                }
            }
            if let Some(k) = &filter.kind {
                if m.get("kind").and_then(Value::as_str) != Some(k) {
                    return false;
                }
            }
            if let Some(s) = &filter.status {
                if m.get("status").and_then(Value::as_str) != Some(s) {
                    return false;
                }
            }
            if filter.new_only {
                let status = m.get("status").and_then(Value::as_str).unwrap_or("");
                let source = m.get("source").and_then(Value::as_str).unwrap_or("");
                let first_seen = m.get("firstSeen").and_then(Value::as_str).unwrap_or("");
                if !(status == "available"
                    && source != "manual"
                    && ack_at.is_none_or(|ack| first_seen > ack))
                {
                    return false;
                }
            }
            true
        })
        .map(|mut m| {
            if let Some(obj) = m.as_object_mut() {
                obj.remove("api");
            }
            m
        })
        .collect();

    let mut providers = Vec::new();
    if let Some(prov_map) = cat.get("providers").and_then(Value::as_object) {
        for (prov_id, st) in prov_map {
            let mut obj = st.as_object().cloned().unwrap_or_default();
            obj.insert("provider".to_string(), json!(prov_id));
            providers.push(Value::Object(obj));
        }
    }

    let config_roles = read_config_roles(layout);
    let warnings = role_warnings(&cat, &config_roles);

    json!({
        "models": filtered_models,
        "providers": providers,
        "newCount": new_count,
        "warnings": warnings,
        "stale": true
    })
}

/// Diagnoses `models.roles` in `1staid check`:
/// - `skip` if `catalog/models.json` does not exist
/// - `ok` if no roles point at an unavailable model
/// - `warn` with `detail.roles` when a role points at an unavailable model
pub fn check_models_roles(layout: &Layout) -> Check {
    const ID: &str = "models.roles";
    let cat_path = layout.catalog_models();
    if !cat_path.is_file() {
        return Check::skip(ID, "no model catalog (catalog/models.json does not exist)");
    }
    let content = match fs::read_to_string(&cat_path) {
        Ok(c) => c,
        Err(e) => {
            return Check::warn(
                ID,
                format!("cannot read catalog/models.json: {e}"),
                None,
                None,
            )
        }
    };
    let cat: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            return Check::warn(
                ID,
                format!("catalog/models.json is not valid JSON: {e}"),
                None,
                None,
            )
        }
    };

    let config_roles = read_config_roles(layout);
    let warnings = role_warnings(&cat, &config_roles);
    if warnings.is_empty() {
        return Check::ok(ID, "all configured model roles point to available models");
    }

    let affected_roles: Vec<String> = warnings
        .iter()
        .filter_map(|w| w.get("role").and_then(Value::as_str).map(String::from))
        .collect();

    Check::warn(
        ID,
        format!(
            "{} model role(s) point at unavailable models",
            affected_roles.len()
        ),
        Some(json!({ "roles": affected_roles })),
        Some(
            "switch roles to available models with plur1bus config set or plur1bus model list"
                .to_string(),
        ),
    )
}

pub fn render_list(v: &Value) -> String {
    let mut out = String::new();
    if v.get("stale").and_then(Value::as_bool).unwrap_or(false) {
        out.push_str("core not running: showing the last scan from catalog/models.json\n\n");
    }

    if let Some(providers) = v.get("providers").and_then(Value::as_array) {
        if !providers.is_empty() {
            out.push_str("Providers:\n");
            for p in providers {
                let id = p
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let res = p
                    .get("lastResult")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let at = p
                    .get("lastScanAt")
                    .and_then(Value::as_str)
                    .unwrap_or("never");
                let hint = if res == "failed:auth" {
                    "renew sign-in"
                } else {
                    res
                };
                out.push_str(&format!("  {id}: last scan {at}, {hint}\n"));
            }
            out.push('\n');
        }
    }

    let mut role_marker: std::collections::HashMap<(String, String), String> =
        std::collections::HashMap::new();
    if let Some(warnings) = v.get("warnings").and_then(Value::as_array) {
        for w in warnings {
            if let (Some(role), Some(p), Some(id)) = (
                w.get("role").and_then(Value::as_str),
                w.get("provider").and_then(Value::as_str),
                w.get("id").and_then(Value::as_str),
            ) {
                role_marker.insert((p.to_string(), id.to_string()), format!("(role: {role})"));
            }
        }
    }

    if let Some(models) = v.get("models").and_then(Value::as_array) {
        if models.is_empty() {
            out.push_str("No models found.\n");
        } else {
            out.push_str(&format!(
                "{:<20} {:<30} {:<10} {:<10} {:<20}\n",
                "PROVIDER", "ID", "KIND", "CONTEXT", "STATUS"
            ));
            out.push_str(&format!(
                "{:-<20} {:-<30} {:-<10} {:-<10} {:-<20}\n",
                "", "", "", "", ""
            ));
            for m in models {
                let provider = m.get("provider").and_then(Value::as_str).unwrap_or("-");
                let id = m.get("id").and_then(Value::as_str).unwrap_or("-");
                let kind = m.get("kind").and_then(Value::as_str).unwrap_or("-");
                let cw = m
                    .get("contextWindow")
                    .and_then(Value::as_u64)
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| "-".to_string());
                let base_status = m.get("status").and_then(Value::as_str).unwrap_or("-");
                let marker = role_marker.get(&(provider.to_string(), id.to_string()));
                let status = match marker {
                    Some(role_str) => format!("{base_status} {role_str}"),
                    None => base_status.to_string(),
                };
                out.push_str(&format!(
                    "{:<20} {:<30} {:<10} {:<10} {:<20}\n",
                    provider, id, kind, cw, status
                ));
            }
        }
    }
    if let Some(count) = v.get("newCount").and_then(Value::as_u64) {
        if count > 0 {
            out.push_str(&format!(
                "\n{count} new model(s) available (use --ack to acknowledge)\n"
            ));
        }
    }
    out
}

pub fn render_scan(v: &Value) -> String {
    let mut out = String::new();
    out.push_str("Model scan finished:\n");
    if let Some(providers) = v.get("providers").and_then(Value::as_array) {
        for p in providers {
            let id = p
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let res = p.get("result").and_then(Value::as_str).unwrap_or("unknown");
            let new = p
                .get("new")
                .and_then(Value::as_array)
                .map_or(0, |a| a.len());
            let reappeared = p
                .get("reappeared")
                .and_then(Value::as_array)
                .map_or(0, |a| a.len());
            let unavailable = p
                .get("unavailable")
                .and_then(Value::as_array)
                .map_or(0, |a| a.len());
            out.push_str(&format!(
                "  {id}: {res} ({new} new, {reappeared} reappeared, {unavailable} unavailable)\n"
            ));
        }
    }
    out
}

pub fn run(out: &Out, layout: &Layout, cmd: ModelCmd) {
    match cmd {
        ModelCmd::List {
            provider,
            kind,
            status,
            new,
            ack,
        } => {
            let filter = ListFilter {
                provider: provider.clone(),
                kind: kind.clone(),
                status: status.clone(),
                new_only: new,
            };

            match connect(layout, Duration::from_secs(30)) {
                Ok(mut client) => {
                    require_supports(out, &client, "models.list");
                    let mut params = serde_json::Map::new();
                    if let Some(p) = provider {
                        params.insert("provider".to_string(), json!(p));
                    }
                    if let Some(k) = kind {
                        params.insert("kind".to_string(), json!(k));
                    }
                    if let Some(s) = status {
                        params.insert("status".to_string(), json!(s));
                    }
                    if new {
                        params.insert("newOnly".to_string(), json!(true));
                    }
                    match client.call("models.list", Value::Object(params)) {
                        Ok(v) => {
                            if new && ack {
                                require_supports(out, &client, "models.acknowledge");
                                let _ = client.call("models.acknowledge", json!({}));
                            }
                            out.ok("model.list/1", &v, || render_list(&v));
                        }
                        Err(e) if is_unavailable(&e) => {
                            let v = read_stale(layout, &filter);
                            out.ok("model.list/1", &v, || render_list(&v));
                        }
                        Err(e) => out.from_rpc_error(&e),
                    }
                }
                Err(e) if is_unavailable(&e) => {
                    let v = read_stale(layout, &filter);
                    out.ok("model.list/1", &v, || render_list(&v));
                }
                Err(e) => out.from_rpc_error(&e),
            }
        }
        ModelCmd::Scan { provider } => {
            let mut client = connect_core(out, layout, "model-discovery", Duration::from_secs(60));
            require_supports(out, &client, "models.scan");
            let mut params = serde_json::Map::new();
            if let Some(p) = provider {
                params.insert("provider".to_string(), json!(p));
            }
            match client.call("models.scan", Value::Object(params)) {
                Ok(v) => {
                    let any_failed =
                        v.get("providers")
                            .and_then(Value::as_array)
                            .is_some_and(|arr| {
                                arr.iter().any(|p| {
                                    p.get("result")
                                        .and_then(Value::as_str)
                                        .is_some_and(|r| r.starts_with("failed"))
                                })
                            });
                    out.ok("model.scan/1", &v, || render_scan(&v));
                    if any_failed {
                        std::process::exit(1);
                    }
                }
                Err(e) => out.from_rpc_error(&e),
            }
        }
        ModelCmd::Override {
            provider,
            id,
            name,
            kind,
            context_window,
            capability,
            alias,
            clear,
            clear_all,
            create,
            remove,
        } => {
            let mut client = connect_core(out, layout, "model-discovery", Duration::from_secs(30));
            if remove {
                require_supports(out, &client, "models.removeManual");
                match client.call(
                    "models.removeManual",
                    json!({ "provider": provider, "id": id }),
                ) {
                    Ok(res) => out.ok("model.override/1", &res, || {
                        format!("removed manual model {provider}/{id}")
                    }),
                    Err(e) => out.from_rpc_error(&e),
                }
            } else {
                require_supports(out, &client, "models.setOverride");
                let params = override_params(
                    &provider,
                    &id,
                    name,
                    kind,
                    context_window,
                    capability,
                    alias,
                    clear,
                    clear_all,
                    create,
                );
                match client.call("models.setOverride", params) {
                    Ok(res) => out.ok("model.override/1", &res, || {
                        format!("updated model {provider}/{id}")
                    }),
                    Err(e) => out.from_rpc_error(&e),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn override_flags_map_to_params() {
        let p = override_params(
            "p1",
            "m1",
            Some("N".to_string()),
            None,
            Some(128000),
            vec!["tools".to_string()],
            vec!["a1".to_string()],
            vec!["kind".to_string()],
            false,
            false,
        );
        assert_eq!(
            p,
            json!({
                "provider": "p1",
                "id": "m1",
                "set": {
                    "displayName": "N",
                    "contextWindow": 128000,
                    "capabilities": ["tools"],
                    "aliases": ["a1"]
                },
                "clear": ["kind"]
            })
        );

        let p_all = override_params(
            "p1",
            "m1",
            None,
            None,
            None,
            vec![],
            vec![],
            vec![],
            true,
            false,
        );
        assert_eq!(
            p_all,
            json!({
                "provider": "p1",
                "id": "m1",
                "clear": "all"
            })
        );
    }

    #[test]
    fn stale_read_filters_and_counts() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().join("h"));
        fs::create_dir_all(layout.catalog()).unwrap();

        let cat = json!({
            "revision": 1,
            "acknowledgedAt": "2026-10-03T09:00:00.000Z",
            "models": [
                {
                    "provider": "p1",
                    "id": "m1",
                    "status": "available",
                    "source": "scan",
                    "firstSeen": "2026-10-03T08:00:00.000Z",
                    "lastSeen": "2026-10-03T10:00:00.000Z"
                },
                {
                    "provider": "p1",
                    "id": "m2",
                    "status": "available",
                    "source": "scan",
                    "firstSeen": "2026-10-03T10:00:00.000Z",
                    "lastSeen": "2026-10-03T10:00:00.000Z"
                },
                {
                    "provider": "p1",
                    "id": "m3",
                    "status": "unavailable",
                    "source": "scan",
                    "firstSeen": "2026-10-03T08:00:00.000Z",
                    "lastSeen": "2026-10-03T08:00:00.000Z"
                }
            ],
            "providers": {
                "p1": { "lastResult": "ok" }
            }
        });
        fs::write(layout.catalog_models(), cat.to_string()).unwrap();

        let res = read_stale(
            &layout,
            &ListFilter {
                status: Some("unavailable".to_string()),
                ..Default::default()
            },
        );
        assert_eq!(res["stale"], true);
        assert_eq!(res["newCount"], 1);
        let models = res["models"].as_array().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["id"], "m3");
    }

    #[test]
    fn stale_read_of_a_missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().join("h"));
        let res = read_stale(&layout, &ListFilter::default());
        assert_eq!(res["stale"], true);
        assert_eq!(res["newCount"], 0);
        assert_eq!(res["models"].as_array().unwrap().len(), 0);
        assert_eq!(res["providers"].as_array().unwrap().len(), 0);
        assert!(res["note"].is_string());
    }

    #[test]
    fn role_warnings_match_the_shared_vectors() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let vectors_path =
            manifest_dir.join("../../packages/core/test/fixtures/discovery/role-vectors.json");
        let content = fs::read_to_string(vectors_path).unwrap();
        let vectors: Vec<Value> = serde_json::from_str(&content).unwrap();

        for v in vectors {
            let name = v["name"].as_str().unwrap();
            let cat = &v["catalog"];
            let val = v["value"].as_str().unwrap();
            let expected = &v["expect"];

            let resolved = resolve_role(val, cat.as_array().unwrap());
            if expected.is_null() {
                assert!(
                    resolved.is_none(),
                    "case {name}: expected None, got {resolved:?}"
                );
            } else {
                let r = resolved
                    .unwrap_or_else(|| panic!("case {name}: expected {expected:?}, got None"));
                assert_eq!(
                    r.provider,
                    expected["provider"].as_str().unwrap(),
                    "case {name} provider"
                );
                assert_eq!(r.id, expected["id"].as_str().unwrap(), "case {name} id");
                assert_eq!(
                    r.state,
                    expected["state"].as_str().unwrap(),
                    "case {name} state"
                );
            }
        }
    }

    #[test]
    fn models_roles_check_statuses() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().join("h"));

        // 1. Skip when no catalog file
        let c1 = check_models_roles(&layout);
        assert_eq!(c1.status, crate::commands::firstaid::Status::Skip);

        // Setup catalog with 1 available and 1 unavailable
        fs::create_dir_all(layout.catalog()).unwrap();
        let cat = json!({
            "revision": 1,
            "models": [
                { "provider": "p1", "id": "avail-model", "status": "available", "aliases": [] },
                { "provider": "p1", "id": "dead-model", "status": "unavailable", "aliases": [] }
            ],
            "providers": {}
        });
        fs::write(layout.catalog_models(), cat.to_string()).unwrap();

        // 2. Ok when role points to available model
        fs::write(
            layout.config_path(),
            json!({ "modelRoles": { "chat": "avail-model" } }).to_string(),
        )
        .unwrap();
        let c2 = check_models_roles(&layout);
        assert_eq!(c2.status, crate::commands::firstaid::Status::Ok);

        // 3. Warn when role points to unavailable model
        fs::write(
            layout.config_path(),
            json!({ "modelRoles": { "chat": "dead-model" } }).to_string(),
        )
        .unwrap();
        let c3 = check_models_roles(&layout);
        assert_eq!(c3.status, crate::commands::firstaid::Status::Warn);
        assert_eq!(c3.detail.unwrap()["roles"], json!(["chat"]));
    }
}
