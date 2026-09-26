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

fn llm_sessions_today(job_defs: &Value, job_runs: &Value, midnight_ms: u64) -> u64 {
    // Build a map of job name -> phase from job definitions
    let mut job_phases: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    if let Some(jobs) = job_defs.as_array() {
        for j in jobs {
            if let (Some(name), Some(phase)) = (j["name"].as_str(), j["phase"].as_str()) {
                job_phases.insert(name.to_string(), phase.to_string());
            }
        }
    }

    // Count runs that are "rem" or "deep" phase and occurred since midnight
    let mut count = 0u64;
    if let Some(runs) = job_runs.as_array() {
        for r in runs {
            if let Some(job_name) = r["job"].as_str() {
                if let Some(phase) = job_phases.get(job_name) {
                    if matches!(phase.as_str(), "rem" | "deep") {
                        if let Some(started_at) = r["startedAt"].as_u64() {
                            if started_at >= midnight_ms {
                                count += 1;
                            }
                        }
                    }
                }
            }
        }
    }
    count
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
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            let today = utc_day(now_ms);
            let midnight_ms = today * 86_400_000;
            let mut per_agent = Vec::new();
            for a in &agents {
                let runs = c
                    .call("jobs.history", json!({ "agentId": a, "limit": 200 }))
                    .unwrap_or_else(|e| out.from_rpc_error(&e));
                let runs = runs["runs"].as_array().cloned().unwrap_or_default();

                // Fetch runs since midnight for LLM breaker count
                let llm_runs = c
                    .call(
                        "jobs.history",
                        json!({ "agentId": a, "since": midnight_ms, "limit": 1000 }),
                    )
                    .unwrap_or_else(|e| out.from_rpc_error(&e));
                let llm_runs = llm_runs["runs"].as_array().cloned().unwrap_or_default();

                let mut last: Vec<Value> = Vec::new();
                for j in jobs["jobs"].as_array().unwrap_or(&vec![]) {
                    let name = j["name"].as_str().unwrap_or("");
                    let mine: Vec<&Value> = runs.iter().filter(|r| r["job"] == name).collect();
                    let newest = mine
                        .iter()
                        .max_by_key(|r| r["startedAt"].as_u64().unwrap_or(0));
                    last.push(json!({ "job": name, "phase": j["phase"], "needsLlm": j["needsLlm"], "lastOutcome": newest.map(|r| r["outcome"].clone()).unwrap_or(Value::Null), "lastReason": newest.map(|r| r["reason"].clone()).unwrap_or(Value::Null), "lastAt": newest.map(|r| r["startedAt"].clone()).unwrap_or(Value::Null), "attempts": mine.len() }));
                }
                let llm_today =
                    llm_sessions_today(&jobs["jobs"], &Value::Array(llm_runs), midnight_ms);
                per_agent.push(json!({ "agentId": a, "breaker": { "llmSessionsToday": llm_today, "limit": 3, "open": llm_today >= 3 }, "jobs": last }));
            }
            let v = json!({ "jobs": jobs["jobs"], "agents": per_agent });
            out.ok("dreams.status/1", &v, || {
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
            out.ok("dreams.run/1", &v, || {
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
            out.ok("dreams.log/1", &json!({ "runs": runs }), || {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_llm_sessions_today_counts_rem_and_deep_phases() {
        // Setup job definitions with different phases
        let job_defs = json!([
            { "name": "rem_job", "phase": "rem", "needsLlm": true, "singleton": false },
            { "name": "deep_job", "phase": "deep", "needsLlm": true, "singleton": false },
            { "name": "light_job", "phase": "light", "needsLlm": false, "singleton": false },
        ]);

        // Setup job runs - some from today, some from yesterday
        let midnight_ms = 1000 * 86_400_000; // Arbitrary midnight timestamp
        let today_ms = midnight_ms + 3_600_000; // 1 hour after midnight
        let yesterday_ms = midnight_ms - 1; // 1 ms before midnight

        let job_runs = json!([
            {
                "runId": "run1",
                "job": "rem_job",
                "agentId": "agent1",
                "trigger": "manual",
                "startedAt": today_ms,
                "finishedAt": today_ms + 1_000,
                "durationMs": 1000,
                "outcome": "completed",
                "attempt": 1,
            },
            {
                "runId": "run2",
                "job": "deep_job",
                "agentId": "agent1",
                "trigger": "manual",
                "startedAt": today_ms + 7_200_000,
                "finishedAt": today_ms + 7_201_000,
                "durationMs": 1000,
                "outcome": "completed",
                "attempt": 1,
            },
            {
                "runId": "run3",
                "job": "light_job",
                "agentId": "agent1",
                "trigger": "manual",
                "startedAt": today_ms + 100,
                "finishedAt": today_ms + 101,
                "durationMs": 1,
                "outcome": "completed",
                "attempt": 1,
            },
            {
                "runId": "run4",
                "job": "rem_job",
                "agentId": "agent1",
                "trigger": "manual",
                "startedAt": yesterday_ms,
                "finishedAt": yesterday_ms + 1000,
                "durationMs": 1000,
                "outcome": "completed",
                "attempt": 1,
            },
        ]);

        let count = llm_sessions_today(&job_defs, &job_runs, midnight_ms);
        // Should count 2: rem_job (today) and deep_job (today)
        // Should NOT count: light_job (today, but phase is "light"), rem_job (yesterday)
        assert_eq!(count, 2);
    }

    #[test]
    fn test_llm_sessions_today_no_runs() {
        let job_defs = json!([
            { "name": "rem_job", "phase": "rem", "needsLlm": true, "singleton": false },
        ]);
        let job_runs = json!([]);
        let midnight_ms = 1000 * 86_400_000;

        let count = llm_sessions_today(&job_defs, &job_runs, midnight_ms);
        assert_eq!(count, 0);
    }

    #[test]
    fn test_llm_sessions_today_job_without_phase() {
        // JobRun without phase field should not cause panic, just be ignored
        let job_defs = json!([
            { "name": "unknown_job", "needsLlm": true, "singleton": false },
        ]);
        let midnight_ms = 1000u64 * 86_400_000u64;
        let job_runs = json!([
            {
                "runId": "run1",
                "job": "unknown_job",
                "agentId": "agent1",
                "trigger": "manual",
                "startedAt": midnight_ms,
                "finishedAt": midnight_ms + 1_000,
                "durationMs": 1000,
                "outcome": "completed",
                "attempt": 1,
            },
        ]);

        // Should not panic, should return 0
        let count = llm_sessions_today(&job_defs, &job_runs, midnight_ms);
        assert_eq!(count, 0);
    }
}
