//! `plur1bus memory list|show|forget|correct|share|state|propose|proposals …`: the CLI's path to
//! the core's experimental MemoryOps RPC surface (`memory.list`, `memory.show`, `memory.forget`,
//! `memory.correct`, `memory.share`, `memory.state`, `memory.propose`,
//! `memory.proposals.list|accept|reject`). Unlike `memory add`/`memory recall` (`memory.rs`),
//! these never journal: a core that cannot be reached fails fast with `E_CORE_UNAVAILABLE`.
use crate::cli::{MemoryCmd, ProposalStatus, ProposalsCmd, ShareTarget};
use crate::commands::memory::{connect, require_agent};
use crate::identity;
use crate::output::Out;
use crate::paths::Layout;
use plur1bus_config as cfg;
use plur1bus_rpc::{is_unavailable, Client};
use serde_json::{json, Value};
use std::io::{IsTerminal, Write};
use std::time::Duration;

/// G19: `--since`/`--until` accept epoch milliseconds (all-digit) or a relative `<n>m|h|d`
/// (minutes/hours/days before `now_ms`) — no date crate in the CLI, so the arithmetic is done
/// here. Saturates rather than overflowing/underflowing on a huge `n`.
pub(crate) fn parse_time_arg(s: &str, now_ms: u64) -> Result<u64, String> {
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
        return s.parse::<u64>().map_err(|e| e.to_string());
    }
    if let Some(unit) = s.chars().last() {
        let unit_ms: Option<u64> = match unit {
            'm' => Some(60_000),
            'h' => Some(3_600_000),
            'd' => Some(86_400_000),
            _ => None,
        };
        if let Some(unit_ms) = unit_ms {
            let digits = &s[..s.len() - unit.len_utf8()];
            if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
                if let Ok(n) = digits.parse::<u64>() {
                    return Ok(now_ms.saturating_sub(n.saturating_mul(unit_ms)));
                }
            }
        }
    }
    Err(format!(
        "invalid time {s:?} (expected epoch milliseconds or <n>m|h|d, e.g. 7d)"
    ))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn parse_time_or_fail(out: &Out, flag: &str, s: &str) -> u64 {
    parse_time_arg(s, now_ms())
        .unwrap_or_else(|e| out.fail("E_INVALID_PARAMS", &format!("--{flag}: {e}"), json!({}), 1))
}

/// Connects with the 30 s call timeout the memory-ops surface uses; a core that cannot be
/// reached fails fast here (never journaled — that fallback is `memory add`/`memory recall`
/// only).
fn connect_or_unavailable(out: &Out, layout: &Layout) -> Client {
    match connect(layout, Duration::from_secs(30)) {
        Ok(c) => c,
        Err(e) if is_unavailable(&e) => out.fail(
            "E_CORE_UNAVAILABLE",
            &format!("core unavailable: {e}"),
            json!({
                "degraded": {
                    "reason": "core-unavailable",
                    "capability": "memory-ops",
                    "detail": e.to_string()
                }
            }),
            1,
        ),
        Err(e) => out.from_rpc_error(&e),
    }
}

/// A core old enough to have no `capabilities` at all answers for itself (`Client::supports`
/// then returns `true`); a core that *does* advertise capabilities but omits this method answers
/// `E_NOT_AVAILABLE reason=core-lacks-method` without ever reaching it (G14/review item 5).
fn require_supports(out: &Out, c: &Client, method: &str) {
    if !c.supports(method) {
        out.fail(
            "E_NOT_AVAILABLE",
            &format!("core does not support {method} yet"),
            json!({ "reason": "core-lacks-method", "method": method }),
            2,
        );
    }
}

/// Connects, checks capabilities, calls `method`, and prints the result — the shared shape of
/// every memory-ops command except `share` (which needs to retry once on `E_APPROVAL_REQUIRED`).
fn call(
    out: &Out,
    layout: &Layout,
    method: &str,
    params: Value,
    schema: &str,
    human: impl FnOnce(&Value) -> String,
) {
    let mut c = connect_or_unavailable(out, layout);
    require_supports(out, &c, method);
    match c.call(method, params) {
        Ok(v) => out.ok(schema, &v, || human(&v)),
        Err(e) => out.from_rpc_error(&e),
    }
}

fn share_target_str(t: &ShareTarget) -> &'static str {
    match t {
        ShareTarget::Workspace => "workspace",
        ShareTarget::User => "user",
    }
}

fn proposal_status_str(s: &ProposalStatus) -> &'static str {
    match s {
        ProposalStatus::Pending => "pending",
        ProposalStatus::Accepted => "accepted",
        ProposalStatus::Rejected => "rejected",
        ProposalStatus::Stale => "stale",
    }
}

pub fn run(out: &Out, layout: &Layout, cmd: MemoryCmd) {
    let config = cfg::load(&layout.config_path())
        .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1))
        .config;
    let caller = identity::caller();

    match cmd {
        MemoryCmd::Add { .. } | MemoryCmd::Recall { .. } => {
            unreachable!("memory add/recall are dispatched by commands::memory::run")
        }
        MemoryCmd::List {
            agent,
            topic,
            since,
            until,
            limit,
        } => {
            require_agent(out, &config, &agent);
            let since_ms = since
                .as_deref()
                .map(|s| parse_time_or_fail(out, "since", s));
            let until_ms = until
                .as_deref()
                .map(|s| parse_time_or_fail(out, "until", s));
            let mut params = json!({ "caller": &caller, "agentId": &agent });
            if let Some(t) = &topic {
                params["topic"] = json!(t);
            } else {
                // G9: the CLI defaults to `since: 0` (all history) when neither flag is given.
                params["since"] = json!(since_ms.unwrap_or(0));
            }
            if let Some(u) = until_ms {
                params["until"] = json!(u);
            }
            if let Some(l) = limit {
                params["limit"] = json!(l);
            }
            call(out, layout, "memory.list", params, "memory.list/1", |v| {
                v["items"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .map(|item| {
                                format!(
                                    "{}  {}{}  {}",
                                    item["id"].as_str().unwrap_or("?"),
                                    item["scope"].as_str().unwrap_or("?"),
                                    item["sharedBy"]
                                        .as_str()
                                        .map(|s| format!(" · shared by {s}"))
                                        .unwrap_or_default(),
                                    item["summary"].as_str().unwrap_or("")
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default()
            });
        }
        MemoryCmd::Show { agent, id } => {
            require_agent(out, &config, &agent);
            let params = json!({ "caller": &caller, "agentId": &agent, "id": &id });
            call(out, layout, "memory.show", params, "memory.show/1", |v| {
                format!(
                    "{}  {}",
                    v["card"]["id"].as_str().unwrap_or("?"),
                    v["card"]["summary"].as_str().unwrap_or("")
                )
            });
        }
        MemoryCmd::Forget { agent, id, yes } => {
            require_agent(out, &config, &agent);
            // G18: destructive — a TTY (and not --json) is prompted; a script needs --yes.
            if !yes {
                if std::io::stdin().is_terminal() && !out.json {
                    eprint!("forget {id} for {agent}? [y/N] ");
                    std::io::stderr().flush().ok();
                    let mut line = String::new();
                    std::io::stdin().read_line(&mut line).ok();
                    if !line.trim().eq_ignore_ascii_case("y") {
                        out.fail(
                            "E_INVALID_PARAMS",
                            "not applied",
                            json!({ "applied": false }),
                            2,
                        );
                    }
                } else {
                    out.fail(
                        "E_INVALID_PARAMS",
                        &format!("re-run with --yes to forget {id}"),
                        json!({ "applied": false }),
                        2,
                    );
                }
            }
            let params = json!({ "caller": &caller, "agentId": &agent, "id": &id });
            call(
                out,
                layout,
                "memory.forget",
                params,
                "memory.forget/1",
                |v| {
                    format!(
                        "forgot {}{}",
                        v["id"],
                        v["tombstoneId"]
                            .as_str()
                            .map(|t| format!(" (tombstone {t})"))
                            .unwrap_or_default()
                    )
                },
            );
        }
        MemoryCmd::Correct { agent, id, text } => {
            require_agent(out, &config, &agent);
            let content = text.join(" ");
            if content.trim().is_empty() {
                out.fail("E_INVALID_PARAMS", "text is empty", json!({}), 1);
            }
            let params =
                json!({ "caller": &caller, "agentId": &agent, "id": &id, "text": content });
            call(
                out,
                layout,
                "memory.correct",
                params,
                "memory.correct/1",
                move |v| format!("corrected {id} -> {}", v["id"]),
            );
        }
        MemoryCmd::Share {
            agent,
            id,
            to,
            allow_sensitive,
        } => {
            let target = share_target_str(&to);
            require_agent(out, &config, &agent);
            let mut c = connect_or_unavailable(out, layout);
            require_supports(out, &c, "memory.share");
            let mut allow = allow_sensitive;
            loop {
                let params = json!({
                    "caller": &caller,
                    "agentId": &agent,
                    "id": &id,
                    "target": target,
                    "allowSensitive": allow
                });
                match c.call("memory.share", params) {
                    Ok(v) => {
                        out.ok("memory.share/1", &v, || {
                            format!(
                                "shared {} -> {} ({})",
                                v["sourceId"],
                                v["sharedId"],
                                v["target"].as_str().unwrap_or(target)
                            )
                        });
                        return;
                    }
                    Err(e) => {
                        if e.code_name() == "E_APPROVAL_REQUIRED" {
                            let should_prompt =
                                !allow && std::io::stdin().is_terminal() && !out.json;
                            if should_prompt {
                                eprint!("this memory is marked sensitive; share it anyway? [y/N] ");
                                std::io::stderr().flush().ok();
                                let mut line = String::new();
                                std::io::stdin().read_line(&mut line).ok();
                                if line.trim().eq_ignore_ascii_case("y") {
                                    allow = true;
                                    continue;
                                }
                            }
                            eprintln!("re-run with --allow-sensitive after the person confirmed");
                        }
                        out.from_rpc_error(&e);
                    }
                }
            }
        }
        MemoryCmd::State { agent } => {
            require_agent(out, &config, &agent);
            let params = json!({ "caller": &caller, "agentId": &agent });
            call(out, layout, "memory.state", params, "memory.state/1", |v| {
                format!(
                    "{}: agent-private {} · workspace {} · user {} · tombstones {}",
                    v["agentId"].as_str().unwrap_or("?"),
                    v["cards"]["agentPrivate"],
                    v["cards"]["workspace"],
                    v["cards"]["user"],
                    v["tombstones"]
                )
            });
        }
        MemoryCmd::Propose {
            agent,
            shared_id,
            note,
            text,
        } => {
            require_agent(out, &config, &agent);
            let content = text.join(" ");
            if content.trim().is_empty() {
                out.fail("E_INVALID_PARAMS", "text is empty", json!({}), 1);
            }
            let mut params = json!({
                "caller": &caller,
                "agentId": &agent,
                "sharedId": &shared_id,
                "text": content
            });
            if let Some(n) = &note {
                params["note"] = json!(n);
            }
            call(
                out,
                layout,
                "memory.propose",
                params,
                "memory.propose/1",
                |v| format!("proposed {} for {}", v["proposalId"], v["sharedId"]),
            );
        }
        MemoryCmd::Proposals { sub } => match sub {
            ProposalsCmd::List {
                agent,
                status,
                limit,
            } => {
                require_agent(out, &config, &agent);
                let mut params = json!({ "caller": &caller, "agentId": &agent });
                if let Some(s) = &status {
                    params["status"] = json!(proposal_status_str(s));
                }
                if let Some(l) = limit {
                    params["limit"] = json!(l);
                }
                call(
                    out,
                    layout,
                    "memory.proposals.list",
                    params,
                    "memory.proposals.list/1",
                    |v| {
                        v["items"]
                            .as_array()
                            .map(|items| {
                                items
                                    .iter()
                                    .map(|p| {
                                        format!(
                                            "{}  {}  {} → {}  \"{}\"",
                                            p["id"].as_str().unwrap_or("?"),
                                            p["status"].as_str().unwrap_or("?"),
                                            p["proposerAgentId"].as_str().unwrap_or("?"),
                                            p["sharerAgentId"].as_str().unwrap_or("?"),
                                            p["newText"].as_str().unwrap_or("")
                                        )
                                    })
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_default()
                    },
                );
            }
            ProposalsCmd::Accept { agent, proposal_id } => {
                require_agent(out, &config, &agent);
                let params =
                    json!({ "caller": &caller, "agentId": &agent, "proposalId": &proposal_id });
                call(
                    out,
                    layout,
                    "memory.proposals.accept",
                    params,
                    "memory.proposals.accept/1",
                    |v| format!("accepted {} -> {}", v["proposalId"], v["id"]),
                );
            }
            ProposalsCmd::Reject {
                agent,
                proposal_id,
                note,
            } => {
                require_agent(out, &config, &agent);
                let mut params =
                    json!({ "caller": &caller, "agentId": &agent, "proposalId": &proposal_id });
                if let Some(n) = &note {
                    params["note"] = json!(n);
                }
                call(
                    out,
                    layout,
                    "memory.proposals.reject",
                    params,
                    "memory.proposals.reject/1",
                    |v| format!("rejected {}", v["proposalId"]),
                );
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_time_arg_accepts_epoch_millis() {
        assert_eq!(
            parse_time_arg("1700000000000", 0).unwrap(),
            1_700_000_000_000
        );
    }

    #[test]
    fn parse_time_arg_accepts_relative_days_hours_minutes() {
        let now = 1_700_000_000_000u64;
        assert_eq!(parse_time_arg("7d", now).unwrap(), now - 7 * 86_400_000);
        assert_eq!(parse_time_arg("90m", now).unwrap(), now - 90 * 60_000);
        assert_eq!(parse_time_arg("3h", now).unwrap(), now - 3 * 3_600_000);
    }

    #[test]
    fn parse_time_arg_saturates_instead_of_underflowing() {
        assert_eq!(parse_time_arg("999999999d", 0).unwrap(), 0);
    }

    #[test]
    fn parse_time_arg_rejects_unknown_units_and_junk() {
        assert!(parse_time_arg("7w", 0).is_err());
        assert!(parse_time_arg("", 0).is_err());
        assert!(parse_time_arg("-1", 0).is_err());
        assert!(parse_time_arg("abc", 0).is_err());
    }
}
