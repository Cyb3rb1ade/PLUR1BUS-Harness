//! `plur1bus update` (apply), `update --rollback`, `update status` and the `daemon start` recovery hook (D78, plan
//! 2026-10-06-m8). The flow itself is `crate::update`; this file turns a verified feed into a plan and prints it.
use super::update::{installed_modules, plan_changes, Feed};
use crate::cli::UpdateArgs;
use crate::install::targets::Target;
use crate::output::Out;
use crate::paths::Layout;
use crate::update::host::SystemHost;
use crate::update::{self, state, Asset, Outcome, Plan};
use serde_json::{json, Value};
use std::io::{BufRead, IsTerminal, Write};

fn host() -> Result<(SystemHost, std::path::PathBuf), String> {
    let current =
        std::env::current_exe().map_err(|e| format!("cannot locate the plur1bus binary: {e}"))?;
    let target = update::target_binary()?;
    Ok((SystemHost::new(current), target))
}

fn host_or_fail(out: &Out) -> (SystemHost, std::path::PathBuf) {
    host().unwrap_or_else(|m| out.fail("E_NOT_AVAILABLE", &m, json!({ "reason": "io" }), 1))
}

fn refuse(out: &Out, reason: &str, message: &str) -> ! {
    out.fail("E_NOT_AVAILABLE", message, json!({ "reason": reason }), 1)
}

/// Turns the verified feed into a [`Plan`], or refuses (fail closed, plan R1/R2).
fn plan_from(out: &Out, layout: &Layout, feed: &Feed) -> Option<Plan> {
    let m = &feed.manifest;
    if !super::update::is_newer(&feed.head.version, &m.binary.version) {
        return None;
    }
    if !feed.verified {
        refuse(
            out,
            "release-unverified",
            "this build has no release key baked in, so it will not apply an update it cannot verify (`update --check` still works)",
        );
    }
    if super::update::is_newer(&feed.head.min_from_version, &m.binary.version) {
        refuse(
            out,
            "min-from-version",
            &format!("upgrade to {} first", feed.head.min_from_version),
        );
    }
    let Some(native) = &feed.native else {
        refuse(
            out,
            "no-native-release",
            "this release has no native binaries",
        );
    };
    let Some(t) = Target::current() else {
        refuse(
            out,
            "target-unsupported",
            "no release target for this platform",
        );
    };
    let (changes, _, _, _) = plan_changes(m, &feed.native, &feed.head, &installed_modules(layout));
    let unsupported: Vec<&str> = changes
        .iter()
        .filter_map(|c| c["unit"].as_str())
        .filter(|u| *u != "binary" && *u != "core")
        .collect();
    if !unsupported.is_empty() {
        out.fail(
            "E_NOT_AVAILABLE",
            &format!(
                "this release also changes {}: `update` replaces the binary and the core only, run `plur1bus setup` for the rest",
                unsupported.join(", ")
            ),
            json!({ "reason": "unit-unsupported", "units": unsupported }),
            1,
        );
    }
    let Some(binary) = native.binary.get(t.id()) else {
        refuse(
            out,
            "target-unsupported",
            &format!("the release has no binary for {}", t.id()),
        );
    };
    let core = if changes.iter().any(|c| c["unit"] == "core") {
        let Some(p) = native.core.payload.get(t.id()) else {
            refuse(
                out,
                "target-unsupported",
                &format!("the release has no core payload for {}", t.id()),
            );
        };
        Some((
            Asset {
                url: p.url.clone(),
                sha256: p.sha256.clone(),
            },
            native.core.clone(),
        ))
    } else {
        None
    };
    Some(Plan {
        from: m.binary.version.clone(),
        to: feed.head.version.clone(),
        channel: feed.channel.clone(),
        binary: Asset {
            url: binary.url.clone(),
            sha256: binary.sha256.clone(),
        },
        core,
    })
}

fn notes(raw: &[u8]) -> Option<String> {
    let doc: Value = serde_json::from_slice(raw).ok()?;
    let n = doc.get("notes")?;
    n["en"]
        .as_str()
        .or_else(|| n.as_object()?.values().find_map(Value::as_str))
        .map(str::to_string)
}

fn confirm(out: &Out, args: &UpdateArgs, plan: &Plan, raw: &[u8]) {
    if args.yes {
        return;
    }
    if !std::io::stdin().is_terminal() || out.json {
        out.fail(
            "E_INVALID_PARAMS",
            &format!(
                "updating to {} needs a confirmation: re-run with --yes (nothing was changed)",
                plan.to
            ),
            json!({ "reason": "confirmation-required" }),
            2,
        );
    }
    println!("Update {} -> {} ({})", plan.from, plan.to, plan.channel);
    if let Some(n) = notes(raw) {
        println!("{n}");
    }
    print!("Apply now? [y/N] ");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    if !matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
        out.fail(
            "E_CANCELLED",
            "cancelled; nothing was changed",
            json!({ "reason": "declined" }),
            1,
        );
    }
}

fn report(st: &state::State) -> Value {
    json!({
        "id": st.id,
        "trigger": st.trigger,
        "phase": st.phase,
        "from": st.from,
        "to": st.to,
        "channel": st.channel,
        "reason": st.reason,
        "message": st.message,
    })
}

fn outcome_of(st: &state::State) -> Outcome {
    match st.phase {
        state::Phase::Committed => Outcome::Committed,
        state::Phase::Failed => Outcome::Failed,
        _ => Outcome::RolledBack,
    }
}

pub(super) fn apply(out: &Out, layout: &Layout, args: &UpdateArgs, feed: Feed) -> ! {
    let Some(plan) = plan_from(out, layout, &feed) else {
        out.ok(
            "update.apply/1",
            &json!({ "outcome": "up-to-date", "version": feed.manifest.binary.version }),
            || "up to date".to_string(),
        );
        std::process::exit(0);
    };
    confirm(out, args, &plan, &feed.raw);
    let (host, target) = host_or_fail(out);
    let st = update::apply(layout, &host, &plan, &target)
        .unwrap_or_else(|e| refuse(out, e.reason, &e.message));
    finish(out, &st)
}

fn finish(out: &Out, st: &state::State) -> ! {
    let outcome = outcome_of(st);
    let mut doc = report(st);
    doc["outcome"] = json!(outcome);
    out.ok("update.apply/1", &doc, || match outcome {
        Outcome::Committed => format!("updated {} -> {}", st.from, st.to),
        Outcome::RolledBack => format!(
            "update to {} failed ({}): rolled back to {}\n{}",
            st.to,
            st.reason.as_deref().unwrap_or("?"),
            st.from,
            st.message.as_deref().unwrap_or("")
        ),
        Outcome::Failed => format!(
            "update to {} failed and the snapshot could not be restored: {}",
            st.to,
            st.message.as_deref().unwrap_or("")
        ),
    });
    std::process::exit(if outcome == Outcome::Committed { 0 } else { 1 })
}

pub(super) fn rollback(out: &Out, layout: &Layout) -> ! {
    let (host, _) = host_or_fail(out);
    match update::rollback_manual(layout, &host) {
        Ok(st) => {
            let mut doc = report(&st);
            doc["outcome"] = json!("rolled-back");
            out.ok("update.rollback/1", &doc, || {
                format!("rolled back {} -> {}", st.from, st.to)
            });
            std::process::exit(0)
        }
        Err(e) => refuse(out, e.reason, &e.message),
    }
}

pub(super) fn status(out: &Out, layout: &Layout) -> ! {
    let loaded = state::load(layout).unwrap_or_else(|m| refuse(out, "state-unreadable", &m));
    let doc = match loaded {
        None => json!({ "phase": "idle", "recoveryPending": false, "canRollback": false }),
        Some(st) => {
            let pending = !st.phase.is_terminal() && !crate::proc::pid_alive(st.owner);
            let can = st.phase == state::Phase::Committed
                && state::snapshot_dir(layout).join("snapshot.json").is_file();
            let mut d = report(&st);
            d["startedAt"] = json!(st.started_at);
            d["updatedAt"] = json!(st.updated_at);
            d["recoveryPending"] = json!(pending);
            d["canRollback"] = json!(can);
            d
        }
    };
    out.ok("update.status/1", &doc, || {
        let phase = doc["phase"].as_str().unwrap_or("?");
        if phase == "idle" {
            return "no update has run".to_string();
        }
        let mut line = format!(
            "{} -> {}: {}",
            doc["from"].as_str().unwrap_or("?"),
            doc["to"].as_str().unwrap_or("?"),
            phase
        );
        if doc["recoveryPending"] == true {
            line.push_str(" (interrupted; the next `update` or `daemon start` settles it)");
        }
        if doc["canRollback"] == true {
            line.push_str(" (`update --rollback` is possible)");
        }
        line
    });
    std::process::exit(0)
}

/// `daemon start`'s hook: settles an update whose process died, before the daemon is started. Never fails the start.
pub(crate) fn recover_at_start(layout: &Layout) {
    if crate::container::container_mode() || !state::state_path(layout).exists() {
        return;
    }
    let Ok((host, _)) = host() else { return };
    match update::recover(layout, &host) {
        Ok(Some(st)) => eprintln!(
            "plur1bus: settled an interrupted update to {}: {:?}",
            st.to, st.phase
        ),
        Ok(None) => {}
        Err(m) => eprintln!("plur1bus: could not settle an interrupted update: {m}"),
    }
}
