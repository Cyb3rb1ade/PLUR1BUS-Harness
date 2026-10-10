//! `plur1bus session list|show|archive` and `plur1bus chat`: the CLI's path to the core's experimental `session.*`
//! RPC surface (M1b-2c). Like the memory-ops commands these never journal: a core that cannot be reached fails fast.
//! The owner of a session is derived by the core from `identity::caller()`; nothing here names an owner or a memory flag
//! beyond the session's own `--no-memory` attribute at creation.
use crate::cli::{ChatArgs, SessionCmd};
use crate::commands::memory::require_agent;
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::identity;
use crate::output::Out;
use crate::paths::Layout;
use plur1bus_config as cfg;
use plur1bus_rpc::{is_unavailable, Client, RpcError};
use serde_json::{json, Value};
use std::io::BufRead;
use std::time::Duration;

/// A turn can take as long as a model needs; the per-call timeout covers a whole `wait: true` turn.
const TURN_TIMEOUT: Duration = Duration::from_secs(600);

fn fmt_ts(ms: Option<u64>) -> String {
    match ms {
        None => "-".to_string(),
        Some(ms) => {
            // Date-less on purpose (no date crate in the CLI): epoch seconds, sortable and scriptable.
            format!("{}", ms / 1000)
        }
    }
}

fn session_line(s: &Value) -> String {
    let mut flags = Vec::new();
    if s["pinned"].as_bool() == Some(true) {
        flags.push("pinned");
    }
    if s["memoryMode"].as_str() == Some("incognito") {
        flags.push("incognito");
    }
    if !s["archivedAt"].is_null() {
        flags.push("archived");
    }
    let flags = if flags.is_empty() {
        String::new()
    } else {
        format!("  [{}]", flags.join(","))
    };
    let title = s["title"]
        .as_str()
        .filter(|t| !t.is_empty())
        .unwrap_or("(untitled)");
    format!(
        "{}  {}  {}  turns={}  last={}  {}{}",
        s["id"].as_str().unwrap_or("?"),
        s["kind"].as_str().unwrap_or("?"),
        s["agentId"].as_str().unwrap_or("?"),
        s["turnCount"].as_u64().unwrap_or(0),
        fmt_ts(s["lastTurnAt"].as_u64()),
        title,
        flags
    )
}

fn messages_block(v: &Value) -> String {
    v.as_array()
        .map(|ms| {
            ms.iter()
                .map(|m| {
                    format!(
                        "{}: {}",
                        m["role"].as_str().unwrap_or("?"),
                        m["text"].as_str().unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn connect_sessions(out: &Out, layout: &Layout) -> Client {
    connect_core(out, layout, "sessions", TURN_TIMEOUT)
}

/// A failed call: for a core with no configured chat provider say what to do, then exit like any RPC failure.
fn fail_rpc(out: &Out, e: &RpcError) -> ! {
    if !out.json && e.code_name() == "E_NOT_AVAILABLE" {
        if let RpcError::Call {
            reason: Some(r), ..
        } = e
        {
            if r == "no-provider" {
                eprintln!(
                    "no chat provider is configured for this core (real providers arrive with M2); \
                     for development start the core with PLUR1BUS_ALLOW_TEST_INTERNALS=1 PLUR1BUS_TEST_CHAT_PROVIDER=fake"
                );
            }
        }
    }
    if is_unavailable(e) {
        eprintln!("(is the daemon running? `plur1bus daemon start`)");
    }
    out.from_rpc_error(e)
}

fn call(out: &Out, c: &mut Client, method: &str, params: Value) -> Value {
    require_supports(out, c, method);
    c.call(method, params).unwrap_or_else(|e| fail_rpc(out, &e))
}

pub fn run(out: &Out, layout: &Layout, cmd: SessionCmd) {
    let caller = identity::caller();
    let mut c = connect_sessions(out, layout);
    match cmd {
        SessionCmd::List {
            owner,
            all_owners,
            agent,
            kind,
            archived,
            search,
            limit,
        } => {
            let mut p = json!({ "caller": &caller });
            if all_owners {
                p["allOwners"] = json!(true);
            }
            if let Some(o) = owner {
                p["owner"] = json!(o);
            }
            if let Some(a) = agent {
                p["agentId"] = json!(a);
            }
            if let Some(k) = kind {
                p["kind"] = json!(k);
            }
            if let Some(a) = archived {
                p["archived"] = json!(a);
            }
            if let Some(q) = search {
                p["search"] = json!(q);
            }
            if let Some(l) = limit {
                p["limit"] = json!(l);
            }
            let v = call(out, &mut c, "session.list", p);
            out.ok("session.list/1", &v, || {
                let mut lines: Vec<String> = v["sessions"]
                    .as_array()
                    .map(|a| a.iter().map(session_line).collect())
                    .unwrap_or_default();
                if v["truncated"].as_bool() == Some(true) {
                    lines.push("(more sessions exist: raise --limit or narrow the filter)".into());
                }
                lines.join("\n")
            });
        }
        SessionCmd::Show { id, messages } => {
            let v = call(
                out,
                &mut c,
                "session.get",
                json!({ "caller": &caller, "sessionId": id, "messages": messages }),
            );
            out.ok("session.get/1", &v, || {
                let mut s = session_line(&v["session"]);
                if let Some(t) = v["runningTurnId"].as_str() {
                    s.push_str(&format!("\nrunning turn: {t}"));
                }
                let m = messages_block(&v["messages"]);
                if !m.is_empty() {
                    s.push_str(&format!("\n\n{m}"));
                }
                s
            });
        }
        SessionCmd::Archive { id } => {
            let v = call(
                out,
                &mut c,
                "session.archive",
                json!({ "caller": &caller, "sessionId": id }),
            );
            out.ok("session.archive/1", &v, || {
                format!("archived {}", v["session"]["id"].as_str().unwrap_or("?"))
            });
        }
    }
}

/// The agent to talk to: `--agent`, else the only registered one (D92 §6: "single agent → that one").
pub(crate) fn pick_agent(out: &Out, config: &Value, agent: Option<String>) -> String {
    if let Some(a) = agent {
        require_agent(out, config, &a);
        return a;
    }
    let agents: Vec<&String> = config["agents"]
        .as_object()
        .map(|m| m.keys().collect())
        .unwrap_or_default();
    match agents.as_slice() {
        [only] => (*only).clone(),
        [] => out.fail(
            "E_AGENT_UNKNOWN",
            "no agent is registered (plur1bus agent create <id>)",
            json!({}),
            1,
        ),
        _ => out.fail(
            "E_INVALID_PARAMS",
            "several agents are registered: pick one with --agent",
            json!({ "agents": agents }),
            2,
        ),
    }
}

pub fn chat(out: &Out, layout: &Layout, args: ChatArgs) {
    let config = cfg::read_unvalidated(&layout.config_path())
        .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1));
    let caller = identity::caller();
    let mut c = connect_sessions(out, layout);
    let (session_id, agent) = match args.session {
        Some(id) => {
            let v = call(
                out,
                &mut c,
                "session.get",
                json!({ "caller": &caller, "sessionId": id }),
            );
            (
                id,
                v["session"]["agentId"].as_str().unwrap_or("").to_string(),
            )
        }
        None => {
            let agent = pick_agent(out, &config, args.agent.clone());
            let mut p = json!({ "caller": &caller, "agentId": &agent });
            if args.no_memory {
                p["memoryMode"] = json!("incognito");
            }
            let v = call(out, &mut c, "session.create", p);
            (v["session"]["id"].as_str().unwrap_or("").to_string(), agent)
        }
    };
    let mut turn = |text: &str| {
        let v = call(
            out,
            &mut c,
            "session.submit",
            json!({ "caller": &caller, "sessionId": &session_id, "text": text, "wait": true }),
        );
        let failed = v["state"].as_str() == Some("failed");
        out.ok("chat.turn/1", &v, || match v["reply"].as_str() {
            Some(r) => r.to_string(),
            None => format!(
                "(turn failed: {})",
                v["error"].as_str().unwrap_or("unknown")
            ),
        });
        failed
    };
    if let Some(m) = args.message {
        if turn(&m) {
            std::process::exit(1);
        }
        return;
    }
    // Without a message: one turn per non-empty stdin line, until EOF (the REPL with streaming is M2).
    if !out.json {
        eprintln!("chatting with {agent} (session {session_id}); end with Ctrl-D");
    }
    let mut failed = false;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        failed |= turn(&line);
    }
    if failed {
        std::process::exit(1);
    }
}
