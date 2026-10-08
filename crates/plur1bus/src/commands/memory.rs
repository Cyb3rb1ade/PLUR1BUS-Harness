//! `plur1bus memory add|recall`: the CLI's path to the core's `memory.capture`/`memory.recall`,
//! with an append-only journal fallback (see `crate::journal`) when the core cannot be reached.
use crate::cli::MemoryCmd;
use crate::identity;
use crate::journal::{self, JournalLine, Message};
use crate::output::Out;
use crate::paths::{core_address, Layout};
use plur1bus_config as cfg;
use plur1bus_rpc::types::ErrorCode;
use plur1bus_rpc::{is_unavailable, Client, ConnectOptions, RpcError};
use serde_json::{json, Value};
use std::time::Duration;

pub(crate) fn connect(layout: &Layout, call_timeout: Duration) -> Result<Client, RpcError> {
    let token = layout.read_token_file(&layout.core_token())?;
    super::connect_recorded(
        layout,
        &core_address(
            &layout.home,
            if cfg!(windows) { "windows" } else { "posix" },
        ),
        token.trim(),
        ConnectOptions {
            connect_timeout: Duration::from_secs(2),
            call_timeout,
            ..ConnectOptions::default()
        },
    )
}

/// The `degraded.detail`/error `detail` text for a core-unavailable failure: the RPC error itself, plus the
/// supervisor's own view of why (Task 9, spec §6.6) — "supervisor not running", "core crashed: config-invalid",
/// etc. — so the caller learns whether it's the core, the supervisor, or neither that is missing.
pub(crate) fn unavailable_detail(layout: &Layout, e: &RpcError) -> String {
    format!("{e} ({})", super::daemon::supervisor_detail(layout))
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
    // Read without creating config.json: only the supervisor (or a config-writing command) writes it (M4).
    let config = cfg::read(&layout.config_path())
        .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1));
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
            // Q3 (E4): the journal line this capture falls back to is built first, and the live call carries runId
            // `journal:<its id>`. The core's replay of that line passes the same runId, so a core that stored the turn
            // but died before replying answers the replay with duplicate-turn instead of storing it twice.
            let line = JournalLine {
                v: 1,
                id: uuid::Uuid::new_v4().to_string(),
                at: 0, // set when it is journaled
                agent_id: &agent,
                session_key: session.as_deref(),
                caller: &caller,
                messages: vec![Message {
                    role: "user",
                    content: &content,
                }],
            };
            let wait_ms = config["core"]["capture"]["waitMs"]
                .as_u64()
                .unwrap_or(60_000);
            match connect(layout, Duration::from_millis(wait_ms + 1_000)) {
                Ok(mut c) => {
                    let params = json!({
                        "caller": caller,
                        "agentId": agent,
                        "sessionKey": session,
                        "runId": format!("journal:{}", line.id),
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
                        Err(e) if is_unavailable(&e) || refused_as_unavailable(&e) => {
                            journaled(out, layout, line, &unavailable_detail(layout, &e))
                        }
                        Err(e) => out.from_rpc_error(&e),
                    }
                }
                Err(e) if is_unavailable(&e) => {
                    journaled(out, layout, line, &unavailable_detail(layout, &e))
                }
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
                    Err(e) if is_unavailable(&e) || refused_as_unavailable(&e) => {
                        unavailable(unavailable_detail(layout, &e))
                    }
                    Err(e) => out.from_rpc_error(&e),
                },
                Err(e) if is_unavailable(&e) => unavailable(unavailable_detail(layout, &e)),
                Err(e) => out.from_rpc_error(&e),
            }
        }
        MemoryCmd::Reembed(args) => super::memory_reembed::run(out, layout, args),
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

/// The core answered but could not serve the call because it is stopping (`E_CORE_UNAVAILABLE`, reason
/// `core-stopping`): nothing was stored or recalled, so a capture is journaled and a recall answers degraded
/// `core-unavailable`, exactly as for a core that cannot be reached.
fn refused_as_unavailable(e: &RpcError) -> bool {
    matches!(
        e,
        RpcError::Call {
            error: ErrorCode::ECoreUnavailable,
            ..
        }
    )
}

/// `line.id` is the one the live capture's runId carried (`journal:<id>`), so the replay's runId matches it.
fn journaled(out: &Out, layout: &Layout, mut line: JournalLine<'_>, detail: &str) {
    line.at = journal::now_ms();
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
    if let Some(line) = degraded_line(v) {
        s.push_str(&line);
        s.push('\n');
    }
    s.push_str(&format!("{} ms", v["timing"]["totalMs"]));
    s
}

/// The human `degraded: <reason> (<capability>): <detail>` line for a result carrying `degraded`
/// (shared by `memory recall` and the memory-ops reads); `None` when the result is not degraded.
pub(crate) fn degraded_line(v: &Value) -> Option<String> {
    let d = &v["degraded"];
    if d.is_null() {
        return None;
    }
    let text = |x: &Value| {
        x.as_str()
            .map(String::from)
            .unwrap_or_else(|| x.to_string())
    };
    Some(format!(
        "degraded: {} ({}){}",
        text(&d["reason"]),
        text(&d["capability"]),
        d["detail"]
            .as_str()
            .map(|t| format!(": {t}"))
            .unwrap_or_default()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_core_stopping_refusal_is_journaled_like_an_unreachable_core() {
        let call = |error| RpcError::Call {
            error,
            jsonrpc: -32000,
            message: "core is stopping".into(),
            reason: Some("core-stopping".into()),
            detail: None,
            ids: None,
            ext: None,
        };
        assert!(refused_as_unavailable(&call(ErrorCode::ECoreUnavailable)));
        assert!(!refused_as_unavailable(&call(ErrorCode::EInvalidParams)));
        assert!(!refused_as_unavailable(&RpcError::Protocol("x".into())));
    }

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
