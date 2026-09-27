//! `plur1bus admin obsidian detect|prepare|confirm`, `admin migrate`, `admin embedding probe|serve` (B15): the CLI's
//! path to the core's experimental `admin.*` methods (engine AdminOps.obsidian, AdminOps.migrate,
//! EmbeddingService.probe|serve). Like the memory ops they need a running core and never journal: a core that
//! cannot be reached fails fast with `E_CORE_UNAVAILABLE`.
use crate::cli::{AdminCmd, EmbeddingCmd, ObsidianCmd};
use crate::commands::memory::require_agent;
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::commands::module::confirm;
use crate::identity;
use crate::output::Out;
use crate::paths::Layout;
use plur1bus_config as cfg;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

/// Longer than the core's own 30 s bound on the embedding probe, so the core answers before the CLI gives up.
const CALL_TIMEOUT: Duration = Duration::from_secs(45);

/// `admin.migrate`: the engine sets no budget on a migration (AdminOps.migrate at the pinned SHA runs every step to the
/// end, with no signal or deadline), so the CLI waits long rather than leave a migration it cannot see finishing (a
/// retry after a timeout would answer E_CONFLICT). The human output reports progress while it waits.
const MIGRATE_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const MIGRATE_PROGRESS_EVERY: Duration = Duration::from_secs(10);

/// Calls `method` on the core and returns its result; any failure prints the error and exits.
fn call(out: &Out, layout: &Layout, method: &str, params: Value) -> Value {
    call_with(out, layout, method, params, CALL_TIMEOUT)
}

fn call_with(out: &Out, layout: &Layout, method: &str, params: Value, timeout: Duration) -> Value {
    let mut c = connect_core(out, layout, "admin", timeout);
    require_supports(out, &c, method);
    c.call(method, params)
        .unwrap_or_else(|e| out.from_rpc_error(&e))
}

/// `admin.migrate` with [`MIGRATE_TIMEOUT`]; without `--json` a line on stderr every [`MIGRATE_PROGRESS_EVERY`] says
/// it is still running.
fn call_migrate(out: &Out, layout: &Layout, params: Value) -> Value {
    if out.json {
        return call_with(out, layout, "admin.migrate", params, MIGRATE_TIMEOUT);
    }
    eprintln!("migrating the store schema (the core runs it to the end even if this command is interrupted)");
    let (done, wait) = std::sync::mpsc::channel::<()>();
    let t0 = std::time::Instant::now();
    let progress = std::thread::spawn(move || {
        while let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
            wait.recv_timeout(MIGRATE_PROGRESS_EVERY)
        {
            eprintln!("still migrating ({} s)", t0.elapsed().as_secs());
        }
    });
    let v = call_with(out, layout, "admin.migrate", params, MIGRATE_TIMEOUT);
    drop(done);
    progress.join().ok();
    v
}

/// The engine resolves a relative vault path against the user's home; on the command line it means the working
/// directory, so it is made absolute here. `~` and `~/…` are left to the engine.
fn vault_arg(p: &Path) -> String {
    let s = p.to_string_lossy();
    if s == "~" || s.starts_with("~/") || s.starts_with("~\\") || p.is_absolute() {
        return s.into_owned();
    }
    std::path::absolute(p)
        .map(|a| a.to_string_lossy().into_owned())
        .unwrap_or_else(|_| s.into_owned())
}

fn describe_detect(v: &Value) -> String {
    let vaults = v["vaults"].as_array().cloned().unwrap_or_default();
    if vaults.is_empty() {
        return "no vault candidates".into();
    }
    vaults
        .iter()
        .map(|x| {
            format!(
                "{}  {}  {}  ({})",
                x["path"].as_str().unwrap_or("?"),
                if x["isVault"] == true {
                    "vault"
                } else {
                    "not a vault"
                },
                if x["confirmed"] == true {
                    "confirmed"
                } else {
                    "unconfirmed"
                },
                x["source"].as_str().unwrap_or("?")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn describe_probe(v: &Value) -> String {
    let id = &v["identity"];
    let who = format!(
        "{} {} ({} dimensions)",
        id["provider"].as_str().unwrap_or("?"),
        id["model"].as_str().unwrap_or("?"),
        id["dimensions"]
    );
    if v["ok"] == true {
        format!(
            "embedding ok: {who}, {} ms{}",
            v["durationMs"].as_f64().map(|m| m.round()).unwrap_or(0.0),
            if v["cached"] == true { " (cached)" } else { "" }
        )
    } else {
        format!(
            "embedding probe failed: {} ({who})",
            v["error"].as_str().unwrap_or("unknown")
        )
    }
}

fn describe_serve(v: &Value) -> String {
    match v["address"].as_object() {
        Some(a) => format!(
            "serving embeddings on {} {} (token file: {})",
            a.get("kind").and_then(Value::as_str).unwrap_or("?"),
            a.get("address").and_then(Value::as_str).unwrap_or("?"),
            v["tokenPath"].as_str().unwrap_or("?")
        ),
        None => "not serving embeddings".into(),
    }
}

fn describe_migrate(v: &Value) -> String {
    let (from, to) = (
        v["from"].as_str().unwrap_or("?"),
        v["to"].as_str().unwrap_or("?"),
    );
    if v["applied"] == true {
        format!("store schema migrated from {from} to {to}")
    } else {
        format!("store schema is at {to}; nothing to apply")
    }
}

pub fn run(out: &Out, layout: &Layout, cmd: AdminCmd) {
    match cmd {
        AdminCmd::Obsidian { sub } => obsidian(out, layout, sub),
        AdminCmd::Migrate { from, to, yes } => {
            // G18: destructive (rewrites the store's schema marker, runs the migration steps); asked before any
            // connection, so a refusal changes nothing.
            confirm(
                out,
                &format!("migrate the memory store schema from {from} to {to}?"),
                yes,
            );
            let params = json!({ "from": from.to_string(), "to": to.to_string() });
            let v = call_migrate(out, layout, params);
            out.ok("admin.migrate/1", &v, || describe_migrate(&v));
        }
        AdminCmd::Embedding {
            sub: EmbeddingCmd::Probe { refresh },
        } => {
            let params = if refresh {
                json!({ "refresh": true })
            } else {
                json!({})
            };
            let v = call(out, layout, "admin.embedding.probe", params);
            out.ok("admin.embedding.probe/1", &v, || describe_probe(&v));
            if v["ok"] != true {
                std::process::exit(1);
            }
        }
        AdminCmd::Embedding {
            sub: EmbeddingCmd::Serve { stop },
        } => {
            // Omitted address: the engine's platform default; null: stop serving.
            let params = if stop {
                json!({ "address": null })
            } else {
                json!({})
            };
            let v = call(out, layout, "admin.embedding.serve", params);
            out.ok("admin.embedding.serve/1", &v, || describe_serve(&v));
        }
    }
}

fn obsidian(out: &Out, layout: &Layout, cmd: ObsidianCmd) {
    let config = cfg::load(&layout.config_path())
        .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1))
        .config;
    let caller = identity::caller();
    match cmd {
        ObsidianCmd::Detect { agent, candidates } => {
            require_agent(out, &config, &agent);
            let mut params = json!({ "caller": &caller, "agentId": &agent });
            if !candidates.is_empty() {
                params["candidates"] =
                    json!(candidates.iter().map(|p| vault_arg(p)).collect::<Vec<_>>());
            }
            let v = call(out, layout, "admin.obsidian.detect", params);
            out.ok("admin.obsidian.detect/1", &v, || describe_detect(&v));
        }
        ObsidianCmd::Prepare { agent, vault } => {
            require_agent(out, &config, &agent);
            let params =
                json!({ "caller": &caller, "agentId": &agent, "vaultPath": vault_arg(&vault) });
            let v = call(out, layout, "admin.obsidian.prepare", params);
            out.ok("admin.obsidian.prepare/1", &v, || {
                let nonce = v["nonce"].as_str().unwrap_or("?");
                format!(
                    "{nonce}\nconfirm {} within 10 minutes: plur1bus admin obsidian confirm --agent {agent} {nonce}",
                    v["vaultPath"].as_str().unwrap_or("?")
                )
            });
        }
        ObsidianCmd::Confirm { agent, nonce } => {
            require_agent(out, &config, &agent);
            let params = json!({ "caller": &caller, "agentId": &agent, "nonce": &nonce });
            let v = call(out, layout, "admin.obsidian.confirm", params);
            out.ok("admin.obsidian.confirm/1", &v, || {
                let path = v["vaultPath"].as_str().unwrap_or("?");
                if v["alreadyConfirmed"] == true {
                    format!("{path} was already confirmed")
                } else {
                    format!("confirmed {path}")
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relative_vault_is_made_absolute_and_home_forms_are_kept() {
        assert_eq!(vault_arg(Path::new("~")), "~");
        assert_eq!(vault_arg(Path::new("~/notes")), "~/notes");
        let abs = std::env::temp_dir().join("vault");
        assert_eq!(vault_arg(&abs), abs.to_string_lossy());
        let rel = vault_arg(Path::new("vault"));
        assert!(Path::new(&rel).is_absolute(), "{rel}");
        assert!(rel.ends_with("vault"), "{rel}");
    }

    #[test]
    fn migrate_versions_are_limited_to_nine_digits_like_the_schema() {
        use clap::Parser;
        let parse = |from: &str| {
            crate::cli::Cli::try_parse_from([
                "plur1bus", "admin", "migrate", "--from", from, "--to", "1",
            ])
        };
        assert!(parse("999999999").is_ok());
        assert!(parse("1000000000").is_err());
        assert!(parse("-1").is_err());
    }

    #[test]
    fn human_lines_name_the_outcome() {
        let probe = json!({ "ok": true, "cached": true, "identity": { "fingerprintId": "fp", "provider": "test", "model": "flat", "dimensions": 384 }, "durationMs": 1.6, "checkedAt": 1 });
        assert_eq!(
            describe_probe(&probe),
            "embedding ok: test flat (384 dimensions), 2 ms (cached)"
        );
        let failed = json!({ "ok": false, "error": "provider-failed", "cached": false, "identity": probe["identity"], "durationMs": 0, "checkedAt": 1 });
        assert!(describe_probe(&failed).starts_with("embedding probe failed: provider-failed"));
        assert_eq!(
            describe_serve(&json!({ "address": null, "tokenPath": null, "identity": null })),
            "not serving embeddings"
        );
        assert_eq!(
            describe_migrate(&json!({ "from": "1", "to": "1", "applied": false })),
            "store schema is at 1; nothing to apply"
        );
        assert_eq!(
            describe_migrate(&json!({ "from": "0", "to": "1", "applied": true })),
            "store schema migrated from 0 to 1"
        );
        let detect = json!({ "agentId": "bernd", "vaults": [{ "path": "/v", "isVault": true, "confirmed": false, "source": "candidate" }] });
        assert_eq!(
            describe_detect(&detect),
            "/v  vault  unconfirmed  (candidate)"
        );
    }
}
