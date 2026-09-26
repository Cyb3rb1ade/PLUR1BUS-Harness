//! `plur1bus memory add|recall`: the CLI's path to the core's `memory.capture`/`memory.recall`,
//! with an append-only journal fallback (see `crate::journal`) when the core cannot be reached.
use crate::cli::MemoryCmd;
use crate::identity;
use crate::journal::{self, JournalLine, Message};
use crate::output::Out;
use crate::paths::{core_address, Layout};
use plur1bus_config as cfg;
use plur1bus_rpc::{is_unavailable, Client, ConnectOptions, RpcError};
use serde_json::{json, Value};
use std::time::Duration;

pub(crate) fn connect(layout: &Layout, call_timeout: Duration) -> Result<Client, RpcError> {
    let token = std::fs::read_to_string(layout.core_token()).map_err(RpcError::from)?;
    Client::connect(
        &core_address(
            &layout.home,
            if cfg!(windows) { "windows" } else { "posix" },
        ),
        token.trim(),
        ConnectOptions {
            connect_timeout: Duration::from_millis(300),
            call_timeout,
        },
    )
}

pub(crate) fn require_agent(out: &Out, config: &Value, id: &str) {
    if config["agents"].get(id).is_none() {
        out.fail(
            "E_AGENT_UNKNOWN",
            &format!("agent {id} is not registered (plur1bus agent create {id})"),
            json!({}),
            1,
        );
    }
}

pub fn run(out: &Out, layout: &Layout, cmd: MemoryCmd) {
    let config = cfg::load(&layout.config_path())
        .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1))
        .config;
    let caller = identity::caller();
    match cmd {
        MemoryCmd::Add {
            agent,
            session,
            text,
        } => {
            require_agent(out, &config, &agent);
            let content = text.join(" ");
            if content.trim().is_empty() {
                out.fail("E_INVALID_PARAMS", "text is empty", json!({}), 1);
            }
            let wait_ms = config["core"]["capture"]["waitMs"]
                .as_u64()
                .unwrap_or(60_000);
            match connect(layout, Duration::from_millis(wait_ms + 1_000)) {
                Ok(mut c) => {
                    let params = json!({
                        "caller": caller,
                        "agentId": agent,
                        "sessionKey": session,
                        "messages": [{ "role": "user", "content": content }],
                        "wait": true,
                        "waitMs": wait_ms
                    });
                    match c.call("memory.capture", strip_nulls(params)) {
                        Ok(v) => out.ok("memory.add/1", &v, || {
                            format!(
                                "stored {} / skipped {}{}",
                                v["stored"],
                                v["skipped"],
                                v["reason"]
                                    .as_str()
                                    .map(|r| format!(" ({r})"))
                                    .unwrap_or_default()
                            )
                        }),
                        Err(e) if is_unavailable(&e) => journaled(
                            out,
                            layout,
                            &agent,
                            session.as_deref(),
                            &caller,
                            &content,
                            &e.to_string(),
                        ),
                        Err(e) => out.from_rpc_error(&e),
                    }
                }
                Err(e) if is_unavailable(&e) => journaled(
                    out,
                    layout,
                    &agent,
                    session.as_deref(),
                    &caller,
                    &content,
                    &e.to_string(),
                ),
                Err(e) => out.from_rpc_error(&e),
            }
        }
        MemoryCmd::Recall {
            agent,
            session,
            joined,
            query,
        } => {
            require_agent(out, &config, &agent);
            let q = query.join(" ");
            if q.trim().is_empty() {
                out.fail("E_INVALID_PARAMS", "query is empty", json!({}), 1);
            }
            let soft = config["core"]["recall"]["softBudgetMs"]
                .as_u64()
                .unwrap_or(400);
            let hard = config["core"]["recall"]["hardBudgetMs"]
                .as_u64()
                .unwrap_or(600);
            let cap = config["core"]["recall"]["capChars"]
                .as_u64()
                .unwrap_or(17_000);
            let unavailable = |detail: String| {
                let v = json!({
                    "blocks": [],
                    "capChars": cap,
                    "degraded": { "reason": "core-unavailable", "capability": "recall", "detail": detail },
                    "timing": { "totalMs": 0 },
                    "deferrals": []
                });
                eprintln!("! memory unavailable: core-unavailable ({detail})");
                out.ok("memory.recall/1", &v, String::new);
            };
            let params = build_recall_params(
                &caller,
                &agent,
                session.as_deref(),
                &q,
                soft,
                hard,
                cap,
                joined,
            );
            match connect(layout, Duration::from_millis(hard + 400)) {
                Ok(mut c) => match c.call("memory.recall", params) {
                    Ok(v) => out.ok("memory.recall/1", &v, || render_recall(&v, joined)),
                    Err(e) if is_unavailable(&e) => unavailable(e.to_string()),
                    Err(e) => out.from_rpc_error(&e),
                },
                Err(e) if is_unavailable(&e) => unavailable(e.to_string()),
                Err(e) => out.from_rpc_error(&e),
            }
        }
        other => super::memory_ops::run(out, layout, other),
    }
}

fn strip_nulls(mut v: Value) -> Value {
    if let Some(m) = v.as_object_mut() {
        m.retain(|_, x| !x.is_null());
    }
    v
}

/// Builds the `memory.recall` params. `sessionKey` is present only when `--session` was given —
/// the schema allows it, and the core/engine ignore it until the session store lands (M1b-2c) —
/// so this never sends a `null` for it (unlike `memory.capture`, which strips nulls after the
/// fact; this builds the object without the key at all, which is equivalent and needs no
/// `strip_nulls` pass).
#[allow(clippy::too_many_arguments)]
fn build_recall_params(
    caller: &identity::CallerIdentity,
    agent: &str,
    session: Option<&str>,
    query: &str,
    soft_ms: u64,
    hard_ms: u64,
    cap_chars: u64,
    joined: bool,
) -> Value {
    let mut params = json!({
        "caller": caller,
        "agentId": agent,
        "query": query,
        "budget": { "softMs": soft_ms, "hardMs": hard_ms, "capChars": cap_chars },
        "joined": joined
    });
    if let Some(s) = session {
        params["sessionKey"] = json!(s);
    }
    params
}

#[allow(clippy::too_many_arguments)]
fn journaled(
    out: &Out,
    layout: &Layout,
    agent: &str,
    session: Option<&str>,
    caller: &identity::CallerIdentity,
    content: &str,
    detail: &str,
) {
    let line = JournalLine {
        v: 1,
        id: uuid::Uuid::new_v4().to_string(),
        at: journal::now_ms(),
        agent_id: agent,
        session_key: session,
        caller,
        messages: vec![Message {
            role: "user",
            content,
        }],
    };
    journal::append(layout, &line).unwrap_or_else(|e| {
        out.fail(
            "E_INTERNAL",
            &format!("journal write failed: {e}"),
            json!({}),
            1,
        )
    });
    eprintln!("! core unavailable ({detail}); journaled for replay");
    out.ok(
        "memory.add/1",
        &json!({
            "journaled": true,
            "id": line.id,
            "degraded": { "reason": "core-unavailable", "capability": "capture", "detail": detail }
        }),
        || "journaled (the core replays it at start)".into(),
    );
}

fn render_recall(v: &Value, joined: bool) -> String {
    let mut s = String::new();
    if joined {
        if let Some(t) = v["joined"]["text"].as_str() {
            s.push_str(t);
            s.push('\n');
        }
    } else {
        for b in v["blocks"].as_array().unwrap_or(&vec![]) {
            s.push_str(&format!(
                "── {} ({} chars){}\n{}\n",
                b["name"].as_str().unwrap_or("?"),
                b["chars"],
                if b["droppable"].as_bool().unwrap_or(false) {
                    ""
                } else {
                    " [pinned]"
                },
                b["text"].as_str().unwrap_or("")
            ));
        }
    }
    for d in v["deferrals"].as_array().unwrap_or(&vec![]) {
        s.push_str(&format!(
            "deferral: {} {} {}→{} ({})\n",
            d["block"], d["kind"], d["from"], d["to"], d["reason"]
        ));
    }
    if !v["degraded"].is_null() {
        s.push_str(&format!(
            "degraded: {} ({}){}\n",
            v["degraded"]["reason"],
            v["degraded"]["capability"],
            v["degraded"]["detail"]
                .as_str()
                .map(|d| format!(": {d}"))
                .unwrap_or_default()
        ));
    }
    s.push_str(&format!("{} ms", v["timing"]["totalMs"]));
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caller() -> identity::CallerIdentity {
        identity::CallerIdentity {
            channel: "cli",
            account_id: "host".into(),
            user_id: "user".into(),
        }
    }

    #[test]
    fn recall_params_forward_session_key_only_when_given() {
        let c = caller();
        let with_session =
            build_recall_params(&c, "bernd", Some("s1"), "q", 400, 600, 17_000, false);
        assert_eq!(with_session["sessionKey"], "s1");
        assert_eq!(with_session["agentId"], "bernd");
        assert_eq!(with_session["query"], "q");
        assert_eq!(with_session["budget"]["softMs"], 400);
        assert_eq!(with_session["budget"]["hardMs"], 600);
        assert_eq!(with_session["budget"]["capChars"], 17_000);
        assert_eq!(with_session["joined"], false);

        let without_session = build_recall_params(&c, "bernd", None, "q", 400, 600, 17_000, false);
        assert!(
            without_session.get("sessionKey").is_none(),
            "sessionKey must be absent, not null, when --session is not given"
        );
    }
}
