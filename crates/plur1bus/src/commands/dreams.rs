use crate::cli::DreamsCmd;
use crate::output::Out;
use crate::paths::{core_address, Layout};
use plur1bus_config as cfg;
use plur1bus_rpc::{Client, ConnectOptions};
use serde_json::{json, Value};

fn connect(out: &Out, layout: &Layout) -> Client {
    let token = std::fs::read_to_string(layout.core_token()).unwrap_or_else(|_| {
        out.fail(
            "E_CORE_UNAVAILABLE",
            "core unavailable (no token; is the core running? `plur1bus core run`)",
            json!({}),
            1,
        )
    });
    Client::connect(
        &core_address(
            &layout.home,
            if cfg!(windows) { "windows" } else { "posix" },
        ),
        token.trim(),
        ConnectOptions::default(),
    )
    .unwrap_or_else(|e| {
        out.fail(
            "E_CORE_UNAVAILABLE",
            &format!("core unavailable: {e}"),
            json!({}),
            1,
        )
    })
}

fn utc_day(ms: u64) -> u64 {
    ms / 86_400_000
}

pub fn run(out: &Out, layout: &Layout, cmd: DreamsCmd) {
    let config = cfg::load(&layout.config_path())
        .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1))
        .config;
    let registered: Vec<String> = config["agents"]
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    let require = |id: &str| {
        if !registered.iter().any(|r| r == id) {
            out.fail(
                "E_AGENT_UNKNOWN",
                &format!("agent {id} is not registered"),
                json!({}),
                1,
            )
        }
    };
    match cmd {
        DreamsCmd::Status { agent } => {
            if let Some(a) = &agent {
                require(a);
            }
            let mut c = connect(out, layout);
            let jobs = c
                .call("jobs.list", json!({}))
                .unwrap_or_else(|e| out.from_rpc_error(&e));
            let agents: Vec<String> = agent.map(|a| vec![a]).unwrap_or(registered.clone());
            let today = utc_day(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64,
            );
            let mut per_agent = Vec::new();
            for a in &agents {
                let runs = c
                    .call("jobs.history", json!({ "agentId": a, "limit": 200 }))
                    .unwrap_or_else(|e| out.from_rpc_error(&e));
                let runs = runs["runs"].as_array().cloned().unwrap_or_default();
                let mut last: Vec<Value> = Vec::new();
                for j in jobs["jobs"].as_array().unwrap_or(&vec![]) {
                    let name = j["name"].as_str().unwrap_or("");
                    let mine: Vec<&Value> = runs.iter().filter(|r| r["job"] == name).collect();
                    let newest = mine
                        .iter()
                        .max_by_key(|r| r["startedAt"].as_u64().unwrap_or(0));
                    last.push(json!({ "job": name, "phase": j["phase"], "needsLlm": j["needsLlm"], "lastOutcome": newest.map(|r| r["outcome"].clone()).unwrap_or(Value::Null), "lastReason": newest.map(|r| r["reason"].clone()).unwrap_or(Value::Null), "lastAt": newest.map(|r| r["startedAt"].clone()).unwrap_or(Value::Null), "attempts": mine.len() }));
                }
                let llm_today = runs
                    .iter()
                    .filter(|r| {
                        matches!(r["phase"].as_str(), Some("rem") | Some("deep"))
                            && r["startedAt"]
                                .as_u64()
                                .map(|t| utc_day(t) == today)
                                .unwrap_or(false)
                    })
                    .count();
                per_agent.push(json!({ "agentId": a, "breaker": { "llmSessionsToday": llm_today, "limit": 3, "open": llm_today >= 3 }, "jobs": last }));
            }
            let v = json!({ "jobs": jobs["jobs"], "agents": per_agent });
            out.ok(&v, || {
                per_agent
                    .iter()
                    .map(|a| {
                        let b = &a["breaker"];
                        let mut s = format!(
                            "{}  breaker {}/{}{}\n",
                            a["agentId"].as_str().unwrap(),
                            b["llmSessionsToday"],
                            b["limit"],
                            if b["open"].as_bool().unwrap_or(false) {
                                " OPEN"
                            } else {
                                ""
                            }
                        );
                        for j in a["jobs"].as_array().unwrap() {
                            s.push_str(&format!(
                                "  {:<26} {:<10} {}\n",
                                j["job"].as_str().unwrap(),
                                j["lastOutcome"].as_str().unwrap_or("-"),
                                j["lastReason"].as_str().unwrap_or("")
                            ));
                        }
                        s
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            });
        }
        DreamsCmd::Run { job, agent } => {
            require(&agent);
            let mut c = connect(out, layout);
            let v = c
                .call("jobs.run", json!({ "agentId": agent, "job": job }))
                .unwrap_or_else(|e| out.from_rpc_error(&e));
            let outcome = v["outcome"].as_str().unwrap_or("?").to_string();
            out.ok(&v, || {
                format!(
                    "{job}: {outcome}{} in {} ms (run {})",
                    v["reason"]
                        .as_str()
                        .map(|r| format!(" ({r})"))
                        .unwrap_or_default(),
                    v["durationMs"],
                    v["runId"]
                )
            });
            if !matches!(outcome.as_str(), "completed" | "skipped") {
                std::process::exit(1);
            }
        }
        DreamsCmd::Log { agent, job, limit } => {
            require(&agent);
            let mut c = connect(out, layout);
            let mut params = json!({ "agentId": agent, "limit": limit });
            if let Some(j) = job {
                params["job"] = json!(j);
            }
            let v = c
                .call("jobs.history", params)
                .unwrap_or_else(|e| out.from_rpc_error(&e));
            let mut runs = v["runs"].as_array().cloned().unwrap_or_default();
            runs.sort_by_key(|r| std::cmp::Reverse(r["startedAt"].as_u64().unwrap_or(0)));
            out.ok(&json!({ "runs": runs }), || {
                runs.iter()
                    .map(|r| {
                        format!(
                            "{} {:<26} {:<10} attempt {} {} ms {}",
                            r["startedAt"],
                            r["job"].as_str().unwrap_or(""),
                            r["outcome"].as_str().unwrap_or(""),
                            r["attempt"],
                            r["durationMs"],
                            r["reason"].as_str().unwrap_or("")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            });
        }
    }
}
