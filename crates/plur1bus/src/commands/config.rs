//! `plur1bus config get|set|schema`. The supervisor owns config.json (B6): `get` and `set` (and `agent create|remove`,
//! through [`apply`]) go through it when it answers. When it is absent (no `run/supervisor.token`, connection refused,
//! or its recorded pid is dead) the file is read and written directly, as before; when it is present but does not
//! answer, the command fails with `E_NOT_AVAILABLE reason=supervisor-unresponsive` and writes nothing.
use crate::cli::{ConfigCmd, TierFilter};
use crate::output::Out;
use crate::paths::{supervisor_address, Layout};
use crate::supervisor;
use crate::supervisor::config::get_result;
use plur1bus_config as cfg;
use plur1bus_rpc::types::ErrorCode;
use plur1bus_rpc::{Client, ConnectOptions, Endpoint, RpcError};
use serde_json::{json, Value};
use std::io::{IsTerminal, Write};
use std::time::{Duration, Instant};

/// How long the supervisor gets to accept and authenticate a connection before it counts as unresponsive.
const SUPERVISOR_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/// The deadline of one `config.*` call (H3B-R22): a `config.set` may wait for a core restart, so the deadline is the
/// supervisor's longest restart wait plus 10 s. `agent create|remove` go through [`apply`] and share it.
const SUPERVISOR_CALL_TIMEOUT: Duration =
    Duration::from_secs(supervisor::config::RESTART_WAIT_MAX.as_secs() + 10);

fn parse_value(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

/// Where `config` commands go (B6).
pub(crate) enum Route {
    /// A supervisor answered `supervisor.auth` on this connection.
    Supervisor(Client),
    /// No supervisor runs: read and write config.json directly.
    Direct,
}

fn unresponsive(detail: String) -> RpcError {
    RpcError::Call {
        error: ErrorCode::ENotAvailable,
        jsonrpc: -32000,
        message: "the supervisor does not answer; nothing was changed".into(),
        reason: Some("supervisor-unresponsive".into()),
        detail: Some(detail),
        ids: None,
        ext: None,
    }
}

/// Decides [`Route`]: absent (no token file, refused connection, dead recorded pid) → `Direct`; answering →
/// `Supervisor`; anything else (a handshake that times out, a supervisor that is stopped) → `Err(E_NOT_AVAILABLE
/// supervisor-unresponsive)`.
pub(crate) fn route(layout: &Layout) -> Result<Route, RpcError> {
    let Some(token) = supervisor::read_token(layout) else {
        return Ok(Route::Direct);
    };
    if layout
        .recorded_pid(Endpoint::Supervisor)
        .is_some_and(|pid| !crate::proc::pid_alive(pid))
    {
        return Ok(Route::Direct);
    }
    let address = supervisor_address(
        &layout.home,
        if cfg!(windows) { "windows" } else { "posix" },
    );
    let opts = ConnectOptions {
        connect_timeout: SUPERVISOR_CONNECT_TIMEOUT,
        call_timeout: SUPERVISOR_CALL_TIMEOUT,
        endpoint: Endpoint::Supervisor,
        expected_server_pid: None, // set by connect_recorded
    };
    match super::connect_recorded(layout, &address, &token, opts) {
        // An older supervisor (before 1.3.0) does not own config.json and never writes it: the file is ours (I2).
        Ok(c) if !c.supports("config.set") => Ok(Route::Direct),
        Ok(c) => Ok(Route::Supervisor(c)),
        Err(RpcError::Unavailable { reason, .. }) if reason == "core-unavailable" => {
            Ok(Route::Direct)
        }
        Err(e @ RpcError::Call { .. }) => Err(e),
        Err(e) => Err(unresponsive(e.to_string())),
    }
}

/// One `config.*` call; a transport failure (timeout, closed connection) is `supervisor-unresponsive`.
pub(crate) fn call(client: &mut Client, method: &str, params: Value) -> Result<Value, RpcError> {
    client.call(method, params).map_err(|e| match e {
        RpcError::Unavailable { reason, detail } => unresponsive(format!("{reason}: {detail}")),
        other => other,
    })
}

fn reason_of(e: &RpcError) -> Option<&str> {
    match e {
        RpcError::Call { reason, .. } => reason.as_deref(),
        _ => None,
    }
}

/// The direct path's `E_CONFLICT reason=config-changed`: the same error the supervisor answers, so both paths print
/// the same message and document.
fn conflict(current: &str) -> RpcError {
    RpcError::Call {
        error: ErrorCode::EConflict,
        jsonrpc: -32000,
        message: "config.json changed since the given revision".into(),
        reason: Some("config-changed".into()),
        detail: None,
        ids: Some(Box::new(
            [("currentRevision".to_string(), current.to_string())]
                .into_iter()
                .collect(),
        )),
        ext: None,
    }
}

/// Prints a failed `config.*` call and exits 1: the error name, its reason/detail/ids, and a message that says what
/// to do.
pub(crate) fn fail_rpc(out: &Out, e: &RpcError) -> ! {
    let mut extra = json!({});
    if let RpcError::Call { reason, detail, .. } = e {
        if let Some(r) = reason {
            extra["reason"] = json!(r);
        }
        if let Some(d) = detail {
            extra["detail"] = json!(d);
        }
    }
    if let Some(ids) = e.ids() {
        extra["ids"] = json!(ids);
    }
    out.fail(&e.code_name(), &fail_message(e), extra, 1)
}

/// The human message of a failed `config.*` call: what happened and what to do.
fn fail_message(e: &RpcError) -> String {
    match (e, reason_of(e)) {
        (_, Some("config-changed")) => "config.json changed meanwhile; re-run".to_string(),
        (_, Some("config-unavailable")) => {
            "the supervisor runs no valid configuration; fix config.json".to_string()
        }
        (
            RpcError::Call {
                message,
                detail: Some(d),
                error,
                ..
            },
            _,
        ) if *error == ErrorCode::EConfigInvalid => {
            format!("{message}: {d}")
        }
        _ => e.to_string(),
    }
}

/// The running configuration and its revision: the supervisor's when it answers, else config.json (created with
/// the defaults when missing, as before).
pub(crate) fn running(out: &Out, layout: &Layout) -> (Value, String) {
    match route(layout) {
        Ok(Route::Supervisor(mut c)) => match call(&mut c, "config.get", json!({})) {
            Ok(v) => {
                return (
                    v["value"].clone(),
                    v["revision"].as_str().unwrap_or_default().to_string(),
                )
            }
            // No valid configuration runs: the file's own error says what is wrong.
            Err(e) if reason_of(&e) == Some("config-unavailable") => {}
            Err(e) => fail_rpc(out, &e),
        },
        Ok(Route::Direct) => {}
        Err(e) => fail_rpc(out, &e),
    }
    let loaded = cfg::load(&layout.config_path())
        .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1));
    let revision = cfg::revision(&loaded.config);
    (loaded.config, revision)
}

/// [`running`] for a command that only reads the configuration: the supervisor's when it answers, else config.json
/// or, when it is missing, the defaults — never creating the file (final review M4). An invalid file while no
/// configuration runs is `E_CONFIG_INVALID`; while the supervisor runs the last valid one, that one is used.
pub(crate) fn running_read_only(out: &Out, layout: &Layout) -> Value {
    match route(layout) {
        Ok(Route::Supervisor(mut c)) => match call(&mut c, "config.get", json!({})) {
            Ok(v) => return v["value"].clone(),
            Err(e) if reason_of(&e) == Some("config-unavailable") => {}
            Err(e) => fail_rpc(out, &e),
        },
        Ok(Route::Direct) => {}
        Err(e) => fail_rpc(out, &e),
    }
    cfg::read(&layout.config_path())
        .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1))
}

/// A `config.set/1` result and how it was produced.
pub(crate) struct Applied {
    /// The raw `config.set` result (the supervisor's, or the same shape built locally).
    pub value: Value,
    /// Whether the supervisor applied it (else config.json was written directly).
    pub supervised: bool,
}

/// The human description of a `config.set` result.
fn describe(v: &Value, supervised: bool) -> String {
    let strs = |x: &Value| -> Vec<String> {
        x.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut s = format!("changes: {}\n", strs(&v["changed"]).join(", "));
    for k in strs(&v["restart"]["live"]) {
        if k.starts_with("agents.") {
            s.push_str(&format!(
                "{k}: applied immediately (agents registry reloads on change)\n"
            ));
        } else if !supervised {
            // No supervisor: nothing re-reads config.json live except the agents registry (which the running core
            // polls for change), so this must not claim "applies live".
            s.push_str(&format!(
                "{k}: live key — H1: re-read at the next core start; live apply arrives with the supervisor (H2)\n"
            ));
        } else if k.starts_with("supervisor.") || k.starts_with("logs.") {
            s.push_str(&format!("{k}: live key, applied by the supervisor\n"));
        } else {
            s.push_str(&format!(
                "{k}: live key, sent to the running core with config.changed\n"
            ));
        }
    }
    if v["restart"]["core"] == true {
        if supervised {
            s.push_str("restarts core: yes\n");
        } else {
            s.push_str("restarts core: yes (H1: takes effect at the next `plur1bus core run`)\n");
        }
    }
    for m in strs(&v["restart"]["modules"]) {
        s.push_str(&format!("restarts module {m}\n"));
    }
    s.trim_end().to_string()
}

/// Asks before applying `preview` (a dry-run result): `--yes` skips the question; without a terminal (or with
/// `--json`) the command fails with exit 2 and changes nothing.
fn confirm(out: &Out, preview: &Value, supervised: bool, yes: bool) {
    if yes {
        return;
    }
    if std::io::stdin().is_terminal() && !out.json {
        eprintln!("{}", describe(preview, supervised));
        eprint!("apply? [y/N] ");
        std::io::stderr().flush().ok();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).ok();
        if !line.trim().eq_ignore_ascii_case("y") {
            out.fail(
                "E_INVALID_PARAMS",
                "not applied",
                json!({"applied": false}),
                2,
            );
        }
    } else {
        out.fail(
            "E_INVALID_PARAMS",
            &format!(
                "{}\nre-run with --yes to apply",
                describe(preview, supervised)
            ),
            json!({
                "applied": false,
                "changed": preview["changed"],
                "restart": preview["restart"]
            }),
            2,
        );
    }
}

/// Applies `changes` as one `config.set` (all or none): through the supervisor when it answers, previewing with
/// `dryRun` first and applying against the previewed revision (a change in between is `E_CONFLICT`: "config.json
/// changed meanwhile; re-run", exit 1); else directly to config.json. `expect` is the revision the caller read its
/// changes against (`agent remove` rewrites the whole `agents` map), `yes` skips the question, `dry_run` only
/// previews. Failures print and exit; the caller prints the result.
pub(crate) fn apply(
    out: &Out,
    layout: &Layout,
    changes: Vec<(String, Value)>,
    expect: Option<&str>,
    yes: bool,
    dry_run: bool,
) -> Applied {
    let started = Instant::now();
    let items: Vec<Value> = changes
        .iter()
        .map(|(k, v)| json!({ "key": k, "value": v }))
        .collect();
    match route(layout) {
        Ok(Route::Supervisor(mut client)) => {
            let mut params = json!({ "changes": items, "dryRun": true });
            if let Some(r) = expect {
                params["ifRevision"] = json!(r);
            }
            let preview =
                call(&mut client, "config.set", params).unwrap_or_else(|e| fail_rpc(out, &e));
            if dry_run {
                return Applied {
                    value: preview,
                    supervised: true,
                };
            }
            confirm(out, &preview, true, yes);
            let params = json!({ "changes": items, "ifRevision": preview["revision"] });
            let value =
                call(&mut client, "config.set", params).unwrap_or_else(|e| fail_rpc(out, &e));
            Applied {
                value,
                supervised: true,
            }
        }
        Ok(Route::Direct) => {
            let loaded = cfg::load(&layout.config_path())
                .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1));
            let current = cfg::revision(&loaded.config);
            if expect.is_some_and(|r| r != current) {
                fail_rpc(out, &conflict(&current));
            }
            let keys: Vec<&str> = changes.iter().map(|(k, _)| k.as_str()).collect();
            let extra = match keys.as_slice() {
                [one] => json!({ "key": one }),
                many => json!({ "keys": many }),
            };
            let plan = cfg::set_many(&loaded.config, &changes)
                .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), extra.clone(), 1));
            // B13: a changed `modules.<name>` must satisfy its manifest's configSchema, as through the supervisor.
            let module_errors = crate::modules::config_errors(
                &crate::modules::scan(layout),
                &loaded.config,
                &plan.after,
            );
            if !module_errors.is_empty() {
                out.fail(
                    "E_CONFIG_INVALID",
                    &format!(
                        "the configuration would be invalid: {}",
                        module_errors.join("; ")
                    ),
                    extra,
                    1,
                );
            }
            let restart = json!({
                "live": plan.restart.live,
                "core": plan.restart.core,
                "modules": plan.restart.modules
            });
            let result = |applied: bool, dry: bool, revision: String| {
                json!({
                    "applied": applied, "dryRun": dry, "changed": plan.changed, "restart": restart,
                    "revision": revision, "restarted": [], "durationMs": started.elapsed().as_millis() as u64,
                })
            };
            let preview = result(false, true, current);
            if dry_run {
                return Applied {
                    value: preview,
                    supervised: false,
                };
            }
            confirm(out, &preview, false, yes);
            cfg::write_atomic(&layout.config_path(), &plan.after)
                .unwrap_or_else(|e| out.fail("E_INTERNAL", &e.to_string(), json!({}), 1));
            Applied {
                value: result(true, false, cfg::revision(&plan.after)),
                supervised: false,
            }
        }
        Err(e) => fail_rpc(out, &e),
    }
}

pub fn run(out: &Out, layout: &Layout, cmd: ConfigCmd) {
    match cmd {
        ConfigCmd::Schema { tier } => {
            let s: Value = serde_json::from_str(cfg::SCHEMA_JSON)
                .unwrap_or_else(|e| out.fail("E_INTERNAL", &e.to_string(), json!({}), 1));
            // G15: a JSON Schema must not carry a foreign top-level key, so the schema itself is
            // wrapped under `jsonSchema` rather than getting `schema` inserted directly into it.
            let (tier_str, filtered) = match tier {
                TierFilter::All => ("all", s.clone()),
                TierFilter::Basic => ("basic", cfg::filter_schema_by_tier(&s, cfg::Tier::Basic)),
                TierFilter::Advanced => (
                    "advanced",
                    cfg::filter_schema_by_tier(&s, cfg::Tier::Advanced),
                ),
            };
            out.ok(
                "config.schema/1",
                &json!({ "tier": tier_str, "jsonSchema": filtered }),
                || serde_json::to_string_pretty(&filtered).unwrap(),
            );
        }
        ConfigCmd::Get { key, tier } => {
            // `tier` and `key` are clap-conflicting.
            let tier: Option<cfg::Tier> = tier.map(Into::into);
            let mut params = json!({});
            if let Some(k) = &key {
                params["key"] = json!(k);
            }
            if let Some(t) = tier {
                params["tier"] = json!(match t {
                    cfg::Tier::Basic => "basic",
                    cfg::Tier::Advanced => "advanced",
                });
            }
            let routed = match route(layout) {
                Ok(Route::Supervisor(mut c)) => match call(&mut c, "config.get", params) {
                    Ok(v) => Some(v),
                    // No valid configuration runs: read the file, whose own error says what is wrong.
                    Err(e) if reason_of(&e) == Some("config-unavailable") => None,
                    Err(e) => fail_rpc(out, &e),
                },
                Ok(Route::Direct) => None,
                Err(e) => fail_rpc(out, &e),
            };
            let v = routed.unwrap_or_else(|| {
                let loaded = cfg::load(&layout.config_path())
                    .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1));
                let revision = cfg::revision(&loaded.config);
                get_result(&loaded.config, &revision, key.as_deref(), tier).unwrap_or_else(|| {
                    out.fail(
                        "E_INVALID_PARAMS",
                        &format!("no such key: {}", key.clone().unwrap_or_default()),
                        json!({}),
                        1,
                    )
                })
            });
            out.ok("config.get/1", &v, || match v["key"].as_str() {
                Some(k) => format!(
                    "{k} = {}  [{}, {}]",
                    v["value"],
                    v["restart"].as_str().unwrap_or_default(),
                    v["tier"].as_str().unwrap_or_default()
                ),
                None => serde_json::to_string_pretty(&v["value"]).unwrap(),
            });
        }
        ConfigCmd::Set {
            key,
            value,
            yes,
            dry_run,
        } => {
            let applied = apply(
                out,
                layout,
                vec![(key, parse_value(&value))],
                None,
                yes,
                dry_run,
            );
            let (v, supervised) = (applied.value, applied.supervised);
            out.ok("config.set/1", &v, || {
                if dry_run {
                    describe(&v, supervised)
                } else {
                    format!("{}\napplied", describe(&v, supervised))
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_paths_say_changed_meanwhile_on_a_conflict() {
        // The direct path's own conflict and the supervisor's E_CONFLICT print the same message.
        assert_eq!(
            fail_message(&conflict("0123456789abcdef")),
            "config.json changed meanwhile; re-run"
        );
        let from_supervisor = RpcError::Call {
            error: ErrorCode::EConflict,
            jsonrpc: -32000,
            message: "config.json changed since the given revision".into(),
            reason: Some("config-changed".into()),
            detail: None,
            ids: None,
            ext: None,
        };
        assert_eq!(
            fail_message(&from_supervisor),
            "config.json changed meanwhile; re-run"
        );
        assert_eq!(
            conflict("r")
                .ids()
                .and_then(|i| i.get("currentRevision").cloned()),
            Some("r".to_string())
        );
    }
}
