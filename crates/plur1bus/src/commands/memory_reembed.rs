//! `plur1bus memory reembed --plan|--run|--status|--abort` (M2 acceptance 6): the CLI's path to the core's experimental
//! `admin.reembed.*` methods (docs/embedding-migration.md). Like the other admin commands it needs a running core and
//! never journals. `--run` starts the migration in the core and, unless `--no-wait`, follows it; Ctrl-C only stops the
//! following, never the migration (`--abort` does that, at a batch boundary). A switch makes the supervisor restart the
//! core, so the follow loop reconnects through that restart.
use crate::cli::ReembedArgs;
use crate::commands::memory::connect;
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::commands::module::confirm;
use crate::output::Out;
use crate::paths::Layout;
use plur1bus_rpc::{is_unavailable, RpcError};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// `plan` asks the engine (inventory, disk, a provider probe); every other call answers from state.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(1000);
/// How long the follow loop waits for the core to come back (a switch restarts it) before it gives up.
const RECONNECT_BUDGET: Duration = Duration::from_secs(120);

/// `PLUR1BUS_REEMBED_POLL_MS` shortens the follow loop's poll interval; honoured only with
/// `PLUR1BUS_ALLOW_TEST_INTERNALS=1` (AGENTS.md).
fn poll_interval() -> Duration {
    let allowed = std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").is_ok_and(|v| v == "1");
    match std::env::var("PLUR1BUS_REEMBED_POLL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        Some(ms) if allowed && ms > 0 => Duration::from_millis(ms),
        _ => POLL,
    }
}

fn call(out: &Out, layout: &Layout, method: &str, params: Value) -> Value {
    let mut c = connect_core(out, layout, "admin", CALL_TIMEOUT);
    require_supports(out, &c, method);
    c.call(method, params)
        .unwrap_or_else(|e| out.from_rpc_error(&e))
}

fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[u])
    }
}

fn list(v: &Value) -> String {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

pub(crate) fn describe_plan(v: &Value) -> String {
    let probe = &v["probe"];
    let mut s = format!(
        "compatibility: {}\n  {}",
        probe["verdict"].as_str().unwrap_or("?"),
        probe["message"].as_str().unwrap_or("")
    );
    if !probe["reasons"].as_array().is_none_or(Vec::is_empty) {
        s.push_str(&format!("\n  reasons: {}", list(&probe["reasons"])));
    }
    let plan = &v["plan"];
    if plan.is_null() {
        if probe["verdict"] == "compatible" {
            s.push_str("\nnothing to migrate");
        }
        return s;
    }
    let n = |k: &str| plan[k].as_u64().unwrap_or(0);
    s.push_str(&format!(
        "\nplan {}: {} rows in {} tables -> {} batches of up to {} ({} provider calls)\n  \
         copy: {} source, about {} written, {} free space needed ({} free)\n  \
         pause between batches: {} ms (at least {} s of pauses)\n  \
         generations: {} (kept) -> {}\nnext: plur1bus memory reembed --run",
        plan["id"].as_str().unwrap_or("?"),
        n("rows"),
        n("tables"),
        n("batches"),
        n("batchSize"),
        n("providerCalls"),
        human_bytes(n("sourceBytes")),
        human_bytes(n("targetBytes")),
        human_bytes(n("requiredFreeBytes")),
        human_bytes(n("freeBytes")),
        n("throttleMs"),
        n("minDurationMs") / 1000,
        plan["sourceGeneration"].as_str().unwrap_or("?"),
        plan["targetGeneration"].as_str().unwrap_or("?"),
    ));
    s
}

fn progress_line(v: &Value) -> String {
    let p = &v["progress"];
    format!(
        "{}/{} rows, {}/{} batches ({}%)",
        p["rowsDone"], p["rows"], p["batchesDone"], p["batches"], p["percent"]
    )
}

pub(crate) fn describe_status(v: &Value) -> String {
    let cp = &v["checkpoint"];
    if cp.is_null() {
        return "no re-embedding migration (plan one with: plur1bus memory reembed --plan --model <id>)".into();
    }
    let phase = cp["phase"].as_str().unwrap_or("?");
    let mut s = format!(
        "migration {}: {phase} - {}\n  engine: {}, run in progress: {}\n  generations: {} (kept) -> {}",
        cp["id"].as_str().unwrap_or("?"),
        progress_line(v),
        v["engineState"].as_str().unwrap_or("none"),
        if v["running"] == true { "yes" } else { "no" },
        cp["sourceGeneration"].as_str().unwrap_or("?"),
        cp["targetGeneration"].as_str().unwrap_or("?"),
    );
    if let Some(e) = cp["error"].as_object() {
        s.push_str(&format!(
            "\n  {}: {}",
            e.get("code").and_then(Value::as_str).unwrap_or("error"),
            e.get("message").and_then(Value::as_str).unwrap_or("")
        ));
    }
    s.push_str(match phase {
        "planned" => "\nnext: plur1bus memory reembed --run",
        "aborted" => "\nresume: plur1bus memory reembed --run",
        "running" => "\nstop: plur1bus memory reembed --abort",
        "ready-to-switch" => "\nnext: plur1bus memory reembed --run (switches; the old generation is kept)",
        "switched" => "\nswitched: the new generation is active from the core's next start; the old generation is kept on disk",
        _ => "",
    });
    s
}

/// The follow loop stops when the migration is over, or waiting longer would not change anything.
fn settled(v: &Value, want_switch: bool) -> bool {
    if v["running"] == true {
        return false;
    }
    let cp = &v["checkpoint"];
    let has_error = cp["error"].is_object();
    match cp["phase"].as_str().unwrap_or("") {
        "switched" | "failed" | "aborted" => true,
        "validating" => has_error,
        // After the loop the core still makes the switch; an error means it could not.
        "ready-to-switch" => !want_switch || has_error,
        _ => false,
    }
}

fn succeeded(v: &Value, want_switch: bool) -> bool {
    match v["checkpoint"]["phase"].as_str().unwrap_or("") {
        "switched" => true,
        "ready-to-switch" => !want_switch && !v["checkpoint"]["error"].is_object(),
        _ => false,
    }
}

/// A core that is away or going away (a switch restarts it): worth waiting for, unlike a refusal.
fn transient(e: &RpcError) -> bool {
    is_unavailable(e) || matches!(e, RpcError::Protocol(_)) || e.code_name() == "E_CORE_UNAVAILABLE"
}

/// One status call on a fresh connection, so the loop survives the core restart a switch causes.
fn poll_once(layout: &Layout) -> Result<Value, RpcError> {
    let mut c = connect(layout, CALL_TIMEOUT)?;
    c.call("admin.reembed.status", json!({}))
}

fn follow(out: &Out, layout: &Layout, want_switch: bool) -> Value {
    let every = poll_interval();
    let mut down_since: Option<Instant> = None;
    let mut last = String::new();
    loop {
        std::thread::sleep(every);
        match poll_once(layout) {
            Ok(v) => {
                down_since = None;
                if !out.json {
                    let line = format!(
                        "{}: {}",
                        v["checkpoint"]["phase"].as_str().unwrap_or("?"),
                        progress_line(&v)
                    );
                    if line != last {
                        eprintln!("{line}");
                        last = line;
                    }
                }
                if settled(&v, want_switch) {
                    return v;
                }
            }
            Err(e) if transient(&e) => {
                let since = *down_since.get_or_insert_with(Instant::now);
                if !out.json && since.elapsed() < every * 2 {
                    eprintln!("waiting for the core (a switch restarts it)...");
                }
                if since.elapsed() > RECONNECT_BUDGET {
                    out.fail(
                        "E_CORE_UNAVAILABLE",
                        "the core did not come back; the migration state is kept (plur1bus memory reembed --status)",
                        json!({ "degraded": { "reason": "core-unavailable", "capability": "admin", "detail": e.to_string() } }),
                        1,
                    );
                }
            }
            Err(e) => out.from_rpc_error(&e),
        }
    }
}

pub fn run(out: &Out, layout: &Layout, a: ReembedArgs) {
    if a.plan {
        let mut params = json!({ "model": a.model.clone().unwrap_or_default() });
        if let Some(d) = a.dimensions {
            params["dimensions"] = json!(d);
        }
        if let Some(p) = &a.query_prefix {
            params["queryPrefix"] = json!(p);
        }
        if let Some(p) = &a.passage_prefix {
            params["passagePrefix"] = json!(p);
        }
        if let Some(t) = a.throttle_ms {
            params["throttleMs"] = json!(t);
        }
        let v = call(out, layout, "admin.reembed.plan", params);
        out.ok("memory.reembed.plan/1", &v, || describe_plan(&v));
        // A model the store cannot move to is a refusal, with its reasons printed above.
        if v["probe"]["verdict"] == "incompatible" {
            std::process::exit(1);
        }
    } else if a.status {
        let v = call(out, layout, "admin.reembed.status", json!({}));
        out.ok("memory.reembed.status/1", &v, || describe_status(&v));
    } else if a.abort {
        let v = call(out, layout, "admin.reembed.abort", json!({}));
        out.ok("memory.reembed.abort/1", &v, || {
            format!(
                "aborted\n{}",
                describe_status(&json!({ "checkpoint": v["checkpoint"], "engineState": null, "running": false, "progress": progress_of(&v["checkpoint"]) }))
            )
        });
    } else if a.run {
        run_migration(out, layout, &a);
    }
}

/// `abort` answers a bare checkpoint; the progress counters are in its `counts`.
fn progress_of(cp: &Value) -> Value {
    let c = &cp["counts"];
    let (rows, done) = (
        c["rows"].as_u64().unwrap_or(0),
        c["rowsDone"].as_u64().unwrap_or(0),
    );
    json!({ "rows": c["rows"], "rowsDone": c["rowsDone"], "batches": c["batches"], "batchesDone": c["batchesDone"],
            "percent": if rows == 0 { 0 } else { done * 100 / rows } })
}

fn run_migration(out: &Out, layout: &Layout, a: &ReembedArgs) {
    let want_switch = !a.no_switch;
    // Look before asking: the question names what will be copied, and no plan is a refusal that changes nothing.
    let st = call(out, layout, "admin.reembed.status", json!({}));
    let cp = &st["checkpoint"];
    if cp.is_null() {
        out.fail(
            "E_NOT_FOUND",
            "no re-embedding migration is planned (plur1bus memory reembed --plan --model <id>)",
            json!({ "reason": "no-migration" }),
            1,
        );
    }
    let question = if cp["phase"] == "ready-to-switch" {
        format!(
            "switch to the re-embedded generation {} (the old one is kept)?",
            cp["targetGeneration"].as_str().unwrap_or("?")
        )
    } else {
        format!(
            "re-embed {} rows into {} (the current store is kept until you confirm the switch)?",
            cp["counts"]["rows"],
            cp["target"]["model"].as_str().unwrap_or("?")
        )
    };
    confirm(out, &question, a.yes);
    let started = call(
        out,
        layout,
        "admin.reembed.run",
        json!({ "switch": want_switch }),
    );
    if a.no_wait {
        out.ok("memory.reembed.run/1", &started, || {
            format!(
                "started migration {} ({}); follow it with: plur1bus memory reembed --status",
                started["checkpoint"]["id"].as_str().unwrap_or("?"),
                started["checkpoint"]["phase"].as_str().unwrap_or("?")
            )
        });
        return;
    }
    let done = if settled(
        &json!({ "running": false, "checkpoint": started["checkpoint"] }),
        want_switch,
    ) {
        // e.g. a run that was only a switch
        poll_once(layout).unwrap_or_else(|e| out.from_rpc_error(&e))
    } else {
        follow(out, layout, want_switch)
    };
    out.ok("memory.reembed.run/1", &done, || describe_status(&done));
    if !succeeded(&done, want_switch) {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_are_human() {
        assert_eq!(human_bytes(10), "10 B");
        assert_eq!(human_bytes(1536), "1.5 KiB");
        assert_eq!(human_bytes(5 * 1024 * 1024 * 1024), "5.0 GiB");
    }

    #[test]
    fn settled_follows_the_phase_not_the_hope() {
        let v = |phase: &str, running: bool, err: bool| json!({ "running": running, "checkpoint": { "phase": phase, "error": if err { json!({"code":"x","message":"y"}) } else { Value::Null } } });
        assert!(!settled(&v("running", true, false), true));
        assert!(!settled(&v("planned", false, false), true));
        assert!(settled(&v("switched", false, false), true));
        assert!(settled(&v("failed", false, true), true));
        assert!(settled(&v("aborted", false, false), true));
        // the loop is over but the switch is still to be made (or has failed)
        assert!(!settled(&v("ready-to-switch", false, false), true));
        assert!(settled(&v("ready-to-switch", false, true), true));
        assert!(settled(&v("ready-to-switch", false, false), false));
        // validating waits only when it says why
        assert!(!settled(&v("validating", false, false), true));
        assert!(settled(&v("validating", false, true), true));
    }

    #[test]
    fn only_a_finished_migration_succeeds() {
        let v = |phase: &str| json!({ "checkpoint": { "phase": phase, "error": null } });
        assert!(succeeded(&v("switched"), true));
        assert!(succeeded(&v("ready-to-switch"), false));
        assert!(!succeeded(&v("ready-to-switch"), true));
        assert!(!succeeded(&v("aborted"), true));
        assert!(!succeeded(&v("failed"), false));
    }
}
