use crate::cli::AgentCmd;
use crate::output::Out;
use crate::paths::{core_address, Layout};
use plur1bus_rpc::{Client, ConnectOptions};
use serde_json::{json, Value};

const ID_RE: &str = "^[a-z0-9][a-z0-9_-]{0,63}$";

fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    let first = chars
        .next()
        .map(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .unwrap_or(false);
    first
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn try_core(layout: &Layout) -> Option<Client> {
    let token = super::token_or_say_why(layout.read_token_file(&layout.core_token()))?;
    super::connect_recorded(
        layout,
        &core_address(
            &layout.home,
            if cfg!(windows) { "windows" } else { "posix" },
        ),
        token.trim(),
        ConnectOptions::default(),
    )
    .ok()
}

pub fn run(out: &Out, layout: &Layout, cmd: AgentCmd) {
    match &cmd {
        AgentCmd::Create { id, config } => {
            let mut params = config
                .as_ref()
                .map(|file| read_payload(out, file))
                .unwrap_or(json!({}));
            params
                .as_object_mut()
                .unwrap_or_else(|| {
                    out.fail(
                        "E_INVALID_PARAMS",
                        "expected JSON settings object",
                        json!({}),
                    )
                })
                .insert("name".into(), json!(id));
            if let Some(mut client) = try_core(layout) {
                if client.hello()["capabilities"]["methods"]
                    .get("agent.create")
                    .is_some()
                {
                    match client.call("agent.create", params) {
                        Ok(value) => out.ok("agent.create/1", &value, || {
                            format!(
                                "created agent {}",
                                value["agentId"].as_str().unwrap_or_default()
                            )
                        }),
                        Err(error) => out.from_rpc_error(&error),
                    }
                    return;
                }
            }
            if config.is_some() {
                out.fail(
                    "E_CORE_UNAVAILABLE",
                    "agent settings require a running current core",
                    json!({}),
                );
            }
            // Retain the pre-existing name-only offline bootstrap used by setup/Hermes and older cores.
        }
        AgentCmd::Validate { file } => {
            let value =
                super::surfaces::call(out, layout, "agent.validate", read_payload(out, file));
            super::surfaces::emit(out, "agent.validate", &value);
            return;
        }
        AgentCmd::Import { file, on_conflict } => {
            let export = read_payload(out, file);
            let bundle = export.get("bundle").cloned().unwrap_or(export);
            let value = super::surfaces::call(
                out,
                layout,
                "agent.import",
                json!({ "bundle": bundle, "onConflict": on_conflict }),
            );
            super::surfaces::emit(out, "agent.import", &value);
            return;
        }
        _ => {}
    }
    if let Some(request) = super::admin_backend::agent_request(&cmd) {
        super::admin_backend::run(out, layout, request);
        return;
    }
    // The registry is the running configuration's `agents` map: the supervisor's when it answers (B6).
    let (config, revision) = super::config::running(out, layout);
    match cmd {
        AgentCmd::List => {
            let ids: Vec<String> = config["agents"]
                .as_object()
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            let live: Option<Value> =
                try_core(layout).and_then(|mut c| c.call("agent.list", json!({})).ok());
            let rows: Vec<Value> = ids
                .iter()
                .map(|id| {
                    let a = live
                        .as_ref()
                        .and_then(|v| v["agents"].as_array())
                        .and_then(|a| a.iter().find(|x| x["agentId"] == *id));
                    json!({
                        "agentId": id,
                        "open": a.map(|x| x["open"].clone()).unwrap_or(Value::Null),
                        "activity": a.map(|x| x["activity"].clone()).unwrap_or(Value::Null)
                    })
                })
                .collect();
            out.ok("agent.list/1", &json!({ "agents": rows, "core": if live.is_some() { "ready" } else { "unavailable" } }), || {
                if rows.is_empty() {
                    "no agents (create one with `plur1bus agent create <id>`)".into()
                } else {
                    rows.iter()
                        .map(|r| {
                            format!(
                                "{}{}",
                                r["agentId"].as_str().unwrap_or_default(),
                                r["activity"]["state"]
                                    .as_str()
                                    .map(|s| format!("  [{s}]"))
                                    .unwrap_or_default()
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                }
            });
        }
        AgentCmd::Create { id, .. } => {
            if !valid_id(&id) {
                out.fail(
                    "E_INVALID_PARAMS",
                    &format!("agent id must match {ID_RE}"),
                    json!({}),
                );
            }
            if config["agents"].get(&id).is_some() {
                out.fail(
                    "E_INVALID_PARAMS",
                    &format!("agent {id} already exists"),
                    json!({ "reason": "agent-exists" }),
                );
            }
            let now = rfc3339_now();
            // Against the revision the existence check read: an agent added meanwhile is a conflict, not overwritten.
            super::config::apply(
                out,
                layout,
                vec![(format!("agents.{id}"), json!({ "createdAt": now }))],
                Some(&revision),
                true,
                false,
            );
            std::fs::create_dir_all(layout.workspace_dir(&id))
                .unwrap_or_else(|e| out.fail("E_INTERNAL", &e.to_string(), json!({})));
            let opened = try_core(layout)
                .and_then(|mut c| c.call("agent.open", json!({ "agentId": id })).ok())
                .is_some();
            out.ok(
                "agent.create/1",
                &json!({ "agentId": id, "created": true, "opened": opened }),
                || {
                    format!(
                        "created agent {id}{}",
                        if opened {
                            " (open in the running core)"
                        } else {
                            " (persona files are scaffolded when the core starts)"
                        }
                    )
                },
            );
        }
        AgentCmd::Remove { id } => {
            if config["agents"].get(&id).is_none() {
                out.fail(
                    "E_AGENT_UNKNOWN",
                    &format!("agent {id} is not registered"),
                    json!({}),
                );
            }
            // config.set has no delete: the whole map minus the agent, against the revision it was read from
            // (H3B-R5), so an agent added meanwhile is a conflict instead of being dropped.
            let mut agents = config["agents"].clone();
            if let Some(m) = agents.as_object_mut() {
                m.remove(&id);
            }
            super::config::apply(
                out,
                layout,
                vec![("agents".to_string(), agents)],
                Some(&revision),
                true,
                false,
            );
            let _ = try_core(layout)
                .and_then(|mut c| c.call("agent.close", json!({ "agentId": id })).ok());
            out.ok("agent.remove/1", &json!({ "agentId": id, "removed": true, "dataKept": true }), || {
                format!("removed agent {id} from the registry; data left in place under agents/{id} (purge arrives in M2)")
            });
        }
        AgentCmd::Status { id } => {
            if config["agents"].get(&id).is_none() {
                out.fail(
                    "E_AGENT_UNKNOWN",
                    &format!("agent {id} is not registered"),
                    json!({}),
                );
            }
            match try_core(layout) {
                Some(mut c) => match c.call("agent.status", json!({ "agentId": id })) {
                    Ok(v) => out.ok("agent.status/1", &v, || {
                        format!(
                            "{id}: {} since {} — workspace {}",
                            v["activity"]["state"], v["activity"]["since"], v["workspace"]
                        )
                    }),
                    Err(e) => out.from_rpc_error(&e),
                },
                None => out.ok(
                    "agent.status/1",
                    &json!({ "agentId": id, "core": "unavailable", "workspace": layout.workspace_dir(&id) }),
                    || format!("{id}: core unavailable; workspace {}", layout.workspace_dir(&id).display()),
                ),
            }
        }
        _ => unreachable!("admin commands dispatched above"),
    }
}

/// A UTC RFC3339 timestamp for `agents.<id>.createdAt`, without pulling in a chrono dependency
/// for this one call site. Days-from-civil / civil-from-days (Howard Hinnant,
/// http://howardhinnant.github.io/date_algorithms.html) converts the day count since the Unix
/// epoch into a proleptic-Gregorian (y, m, d).
pub(crate) fn rfc3339_now() -> String {
    let secs = crate::journal::now_ms() / 1000;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Bound JSON input before parsing; errors never echo submitted text or credentials.
fn read_payload(out: &Out, path: &std::path::Path) -> Value {
    use std::io::Read;
    let file = std::fs::File::open(path).unwrap_or_else(|_| {
        out.fail(
            "E_INVALID_PARAMS",
            "cannot read agent JSON file",
            json!({"detail":"file"}),
        )
    });
    let mut bytes = Vec::new();
    file.take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .unwrap_or_else(|_| {
            out.fail(
                "E_INVALID_PARAMS",
                "cannot read agent JSON file",
                json!({"detail":"file"}),
            )
        });
    if bytes.len() > 4 * 1024 * 1024 {
        out.fail(
            "E_INVALID_PARAMS",
            "agent JSON file exceeds transfer limit",
            json!({"detail":"file"}),
        );
    }
    serde_json::from_slice(&bytes).unwrap_or_else(|_| {
        out.fail(
            "E_INVALID_PARAMS",
            "invalid agent JSON file",
            json!({"detail":"file"}),
        )
    })
}
