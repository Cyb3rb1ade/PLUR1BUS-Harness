//! The supervisor trusts only the API delegation credential, and asks the core for current roles on every request.
use crate::paths::{core_address, Layout};
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Value};
use std::time::Duration;

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
