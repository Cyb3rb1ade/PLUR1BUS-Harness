//! The supervisor trusts only the API delegation credential, and asks the core for current roles on every request.
use crate::paths::{core_address, Layout};
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Value};
use std::time::Duration;

/// Browser delegation remains restricted to current human owners/admins and admitted methods.
pub fn allowed(principal: &Value, method: &str) -> bool {
    principal["kind"] == "person"
        && matches!(principal["role"].as_str(), Some("owner" | "admin"))
        && (!method.starts_with("admin.import.")
            || principal.get("tokenScopes").is_none()
            || principal["tokenScopes"].as_array().is_some_and(|scopes| {
                scopes.iter().any(|scope| {
                    matches!(scope.as_str(), Some("*" | "imports.*" | "imports.manage"))
                })
            }))
        && matches!(
            method,
            "config.get"
                | "config.set"
                | "module.list"
                | "module.graph"
                | "daemon.status"
                | "ext.watch"
                | "ext.list"
                | "ext.show"
                | "ext.inspect"
                | "ext.inspection.get"
                | "ext.install"
                | "ext.uninstall"
                | "ext.restore"
                | "ext.enable"
                | "ext.disable"
                | "admin.import.apply"
                | "admin.import.status"
                | "admin.import.abort"
                | "admin.import.runs"
                | "admin.import.rollback"
        )
}

pub fn principal(layout: &Layout, delegation: &Value) -> Result<Value, &'static str> {
    if delegation["clientId"] != "harness-api" || !delegation["token"].is_string() {
        return Err("api-delegation");
    }
    let token = layout
        .read_token_file(&layout.core_token())
        .map_err(|_| "core-unavailable")?;
    let pid = std::fs::read_to_string(layout.core_pid())
        .ok()
        .and_then(|s| s.split_whitespace().next()?.parse().ok());
    // Windows must know the pipe server before sending either credential.
    if cfg!(windows) && pid.is_none() {
        return Err("core-unavailable");
    }
    let address = core_address(
        &layout.home,
        if cfg!(windows) { "windows" } else { "posix" },
    );
    let mut core = Client::connect(
        &address,
        token.trim(),
        ConnectOptions {
            endpoint: Endpoint::Core,
            connect_timeout: Duration::from_secs(2),
            call_timeout: Duration::from_secs(2),
            expected_server_pid: pid,
        },
    )
    .map_err(|_| "core-unavailable")?;
    let hello = core
        .call(
            "core.auth",
            json!({ "token": token.trim(), "api": delegation }),
        )
        .map_err(|_| "api-delegation")?;
    let p = &hello["apiPrincipal"];
    if p["kind"] != "person" {
        return Err("agent-principal");
    }
    if !p["userId"].is_string()
        || !matches!(
            p["role"].as_str(),
            Some("owner" | "admin" | "operator" | "member" | "viewer")
        )
    {
        return Err("no-principal");
    }
    Ok(p.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_maintenance_requires_explicit_manage_scope_for_scoped_people() {
        for method in ["apply", "status", "abort", "runs", "rollback"] {
            let method = format!("admin.import.{method}");
            for role in ["owner", "admin"] {
                for scopes in [
                    json!([]),
                    json!(["imports.read"]),
                    json!(["extensions.manage"]),
                ] {
                    assert!(!allowed(
                        &json!({"kind":"person","role":role,"tokenScopes":scopes}),
                        &method
                    ));
                }
                for scope in ["*", "imports.*", "imports.manage"] {
                    assert!(allowed(
                        &json!({"kind":"person","role":role,"tokenScopes":[scope]}),
                        &method
                    ));
                    assert!(!allowed(
                        &json!({"kind":"agent","role":role,"tokenScopes":[scope]}),
                        &method
                    ));
                }
            }
        }
    }

    #[test]
    fn delegated_extension_access_matches_shared_human_policy() {
        let policy: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/extensions-human-access.json"
        ))
        .unwrap();
        for role in ["owner", "admin", "operator", "member", "viewer"] {
            for method in policy["methods"].as_array().unwrap() {
                let admitted = policy["roles"].as_array().unwrap().contains(&json!(role));
                assert_eq!(
                    allowed(
                        &json!({ "kind": "person", "role": role }),
                        method.as_str().unwrap()
                    ),
                    admitted,
                    "{role} {method}"
                );
                assert!(!allowed(
                    &json!({ "kind": "agent", "role": role }),
                    method.as_str().unwrap()
                ));
            }
        }
        assert!(!allowed(
            &json!({ "kind": "person", "role": "owner" }),
            "daemon.stop"
        ));
        assert!(!allowed(
            &json!({ "kind": "person", "role": "owner" }),
            "ext.future-unsafe-method"
        ));
        assert!(allowed(
            &json!({ "kind": "person", "role": "admin" }),
            "config.get"
        ));
    }
}
