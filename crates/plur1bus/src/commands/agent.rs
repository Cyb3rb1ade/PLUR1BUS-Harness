use crate::cli::AgentCmd;
use crate::output::Out;
use crate::paths::{core_address, Layout};
use plur1bus_config as cfg;
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
    let token = std::fs::read_to_string(layout.core_token()).ok()?;
    Client::connect(
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
    let loaded = cfg::load(&layout.config_path())
        .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1));
    let config = loaded.config;
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
                                r["agentId"].as_str().unwrap(),
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
        AgentCmd::Create { id } => {
            if !valid_id(&id) {
                out.fail(
                    "E_INVALID_PARAMS",
                    &format!("agent id must match {ID_RE}"),
                    json!({}),
                    1,
                );
            }
            if config["agents"].get(&id).is_some() {
                out.fail(
                    "E_INVALID_PARAMS",
                    &format!("agent {id} already exists"),
                    json!({}),
                    1,
                );
            }
            let now = rfc3339_now();
            let plan = cfg::set(
                &config,
                &format!("agents.{id}"),
                json!({ "createdAt": now }),
            )
            .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1));
            cfg::write_atomic(&layout.config_path(), &plan.after)
                .unwrap_or_else(|e| out.fail("E_INTERNAL", &e.to_string(), json!({}), 1));
            std::fs::create_dir_all(layout.workspace_dir(&id))
                .unwrap_or_else(|e| out.fail("E_INTERNAL", &e.to_string(), json!({}), 1));
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
                    1,
                );
            }
            let mut after = config.clone();
            after["agents"].as_object_mut().unwrap().remove(&id);
            cfg::validate(&after)
                .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.join("; "), json!({}), 1));
            let _ = try_core(layout)
                .and_then(|mut c| c.call("agent.close", json!({ "agentId": id })).ok());
            cfg::write_atomic(&layout.config_path(), &after)
                .unwrap_or_else(|e| out.fail("E_INTERNAL", &e.to_string(), json!({}), 1));
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
                    1,
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
    }
}

/// A UTC RFC3339 timestamp for `agents.<id>.createdAt`, without pulling in a chrono dependency
/// for this one call site. Days-from-civil / civil-from-days (Howard Hinnant,
/// http://howardhinnant.github.io/date_algorithms.html) converts the day count since the Unix
/// epoch into a proleptic-Gregorian (y, m, d).
fn rfc3339_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
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
