//! User recurring jobs use the same authenticated core transport and capabilities as other CLI RPC commands.
use crate::cli::JobsCmd;
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::output::Out;
use crate::paths::Layout;
use serde_json::json;
use std::time::Duration;

pub fn run(out: &Out, layout: &Layout, cmd: JobsCmd) {
    let (method, schema, params) = match cmd {
        JobsCmd::List { kind } => ("jobs.list", "jobs.list/1", json!({"kind":kind})),
        JobsCmd::Create {
            name,
            agent,
            prompt,
            cron,
            timezone,
            disabled,
        } => (
            "jobs.create",
            "jobs.create/1",
            json!({"name":name,"agentId":agent,"prompt":prompt,"schedule":{"cron":cron,"timezone":timezone},"enabled":!disabled}),
        ),
    };
    let mut client = connect_core(out, layout, "jobs", Duration::from_secs(15));
    require_supports(out, &client, method);
    match client.call(method, params) {
        Ok(value) => out.ok(schema, &value, || {
            if method == "jobs.create" {
                format!(
                    "created {} (runs as {})",
                    value["job"]["id"].as_str().unwrap_or("?"),
                    value["job"]["runAs"].as_str().unwrap_or("?")
                )
            } else {
                value["jobs"]
                    .as_array()
                    .map(|jobs| {
                        jobs.iter()
                            .map(|job| {
                                format!(
                                    "{}\t{}\t{}",
                                    job["id"]
                                        .as_str()
                                        .or_else(|| job["name"].as_str())
                                        .unwrap_or("?"),
                                    job["kind"].as_str().unwrap_or("agent"),
                                    job["name"].as_str().unwrap_or("?")
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default()
            }
        }),
        Err(error) => out.from_rpc_error(&error),
    }
}
