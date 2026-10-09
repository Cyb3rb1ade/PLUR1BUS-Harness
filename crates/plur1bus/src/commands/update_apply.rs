//! `plur1bus update` (apply), `update --rollback`, `update status` and the `daemon start` recovery hook (D78, plan
//! 2026-10-06-m8). The flow itself is `crate::update`; this file turns a verified feed (online, or an offline bundle)
//! into a plan, shows it, and prints the outcome.
use super::update::{installed_modules, plan_changes, Feed};
use crate::cli::UpdateArgs;
use crate::install::targets::Target;
use crate::output::Out;
use crate::paths::Layout;
use crate::update::host::SystemHost;
use crate::update::plan::{self, Lang};
use crate::update::{self, addons, bundle, guard, state, Asset, Outcome, Plan};
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

/// A refusal before anything was written: `(reason, message, extra fields of the error document)`.
type Refusal = (String, String, Value);

fn no(reason: &str, message: impl Into<String>) -> Refusal {
    (reason.to_string(), message.into(), json!({}))
}

/// What the feed would turn this install into, and the document that says so.
struct Prepared {
    plan: Plan,
    view: Value,
    lang: Lang,
}

fn lang_of(args: &UpdateArgs) -> Lang {
    args.lang
        .as_deref()
        .and_then(Lang::parse)
        .unwrap_or_else(Lang::from_env)
}

/// The bundle file an asset URL stands for (`--from`), else the URL itself.
fn resolve(feed: &Feed, url: &str) -> Result<String, Refusal> {
    match &feed.bundle {
        None => Ok(url.to_string()),
        Some(dir) => bundle::artefact(dir, url)
            .map(|p| p.to_string_lossy().into_owned())
            .ok_or_else(|| {
                no(
                    "bundle-invalid",
                    format!("the bundle holds no artefact for {url}"),
                )
            }),
    }
}

/// Size of an asset: what the release says, else (offline) the file's size.
fn size_of(declared: Option<u64>, resolved: &str, offline: bool) -> Option<u64> {
    declared.or_else(|| {
        offline
            .then(|| std::fs::metadata(resolved).ok().map(|m| m.len()))
            .flatten()
    })
}

/// Turns the verified feed into a [`Plan`] and its human-readable document, or refuses (fail closed, plan R1/R2).
/// `Ok(None)`: already on this version.
fn prepare(layout: &Layout, args: &UpdateArgs, feed: &Feed) -> Result<Option<Prepared>, Refusal> {
    let m = &feed.manifest;
    if feed.head.version == m.binary.version {
        return Ok(None);
    }
    if !feed.verified {
        return Err(no(
            "release-unverified",
            "this build has no release key baked in, so it will not apply an update it cannot verify (`update --check` still works)",
        ));
    }
    let guard_state = guard::load(layout).map_err(|m| no("guard-unreadable", m))?;
    guard::check_version(
        &guard_state,
        &feed.channel,
        &m.binary.version,
        &feed.head.version,
        args.allow_downgrade,
    )
    .map_err(|e| no(e.reason, e.message))?;
    let downgrade = !super::update::is_newer(&feed.head.version, &m.binary.version);
    if super::update::is_newer(&feed.head.min_from_version, &m.binary.version) {
        return Err(no(
            "min-from-version",
            format!("upgrade to {} first", feed.head.min_from_version),
        ));
    }
    let Some(native) = &feed.native else {
        return Err(no(
            "no-native-release",
            "this release has no native binaries",
        ));
    };
    let Some(t) = Target::current() else {
        return Err(no(
            "target-unsupported",
            "no release target for this platform",
        ));
    };
    let (changes, restart_core, restart_modules, supervisor_restart) =
        plan_changes(m, &feed.native, &feed.head, &installed_modules(layout));
    let unsupported: Vec<&str> = changes
        .iter()
        .filter_map(|c| c["unit"].as_str())
        .filter(|u| *u != "binary" && *u != "core")
        .collect();
    if !unsupported.is_empty() {
        let mut r = no(
            "unit-unsupported",
            format!(
                "this release also changes {}: `update` replaces the binary and the core only, run `plur1bus setup` for the rest",
                unsupported.join(", ")
            ),
        );
        r.2 = json!({ "units": unsupported });
        return Err(r);
    }
    let Some(binary) = native.binary.get(t.id()) else {
        return Err(no(
            "target-unsupported",
            format!("the release has no binary for {}", t.id()),
        ));
    };
    let offline = feed.bundle.is_some();
    let binary_url = resolve(feed, &binary.url)?;
    let mut downloads = vec![(
        "plur1bus".to_string(),
        size_of(binary.size, &binary_url, offline),
    )];
    let core = if changes.iter().any(|c| c["unit"] == "core") {
        let Some(p) = native.core.payload.get(t.id()) else {
            return Err(no(
                "target-unsupported",
                format!("the release has no core payload for {}", t.id()),
            ));
        };
        let core_url = resolve(feed, &p.url)?;
        downloads.push(("core".to_string(), size_of(p.size, &core_url, offline)));
        Some((
            Asset {
                url: core_url,
                sha256: p.sha256.clone(),
                size: p.size,
            },
            native.core.clone(),
        ))
    } else {
        None
    };
    let offer = addons::offer_of(&feed.head, Some(native));
    let addon_plan = addons::evaluate(layout, &offer, &args.require_addon, &args.unrequire_addon);
    let lang = lang_of(args);
    let doc: Value = serde_json::from_slice(&feed.raw).unwrap_or(Value::Null);
    let view = plan::build(
        &plan::Inputs {
            doc: &doc,
            from: &m.binary.version,
            to: &feed.head.version,
            channel: &feed.channel,
            downgrade,
            bundle: offline,
            changes: &changes,
            restart_core,
            restart_modules: &restart_modules,
            supervisor_restart,
            addons: &addon_plan,
            downloads,
            forced: args.force,
        },
        lang,
    );
    Ok(Some(Prepared {
        plan: Plan {
            from: m.binary.version.clone(),
            to: feed.head.version.clone(),
            channel: feed.channel.clone(),
            binary: Asset {
                url: binary_url,
                sha256: binary.sha256.clone(),
                size: binary.size,
            },
            core,
            addons: addon_plan,
            record_seen: true,
        },
        view,
        lang,
    }))
}

/// Ends the command with a refusal; an extracted bundle is removed first.
fn stop(out: &Out, layout: &Layout, r: Refusal) -> ! {
    bundle::cleanup(layout);
    let mut extra = r.2;
    extra["reason"] = json!(r.0);
    out.fail("E_NOT_AVAILABLE", &r.1, extra, 1)
}

/// Shows the plan (text mode) and asks, unless `--yes`.
fn confirm(out: &Out, layout: &Layout, args: &UpdateArgs, p: &Prepared) {
    let text = plan::render(&p.view, p.lang);
    if args.yes {
        if !out.json {
            println!("{text}\n");
        }
        return;
    }
    if !std::io::stdin().is_terminal() || out.json {
        bundle::cleanup(layout);
        out.fail(
            "E_INVALID_PARAMS",
            &format!(
                "updating to {} needs a confirmation: re-run with --yes (nothing was changed)",
                p.plan.to
            ),
            json!({ "reason": "confirmation-required" }),
            2,
        );
    }
    println!("{text}\n");
    print!("Apply now? [y/N] ");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    if !matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
        bundle::cleanup(layout);
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
    let prepared = match prepare(layout, args, &feed) {
        Ok(Some(p)) => p,
        Ok(None) => {
            bundle::cleanup(layout);
            out.ok(
                "update.apply/1",
                &json!({ "outcome": "up-to-date", "version": feed.manifest.binary.version }),
                || "up to date".to_string(),
            );
            std::process::exit(0);
        }
        Err(r) => stop(out, layout, r),
    };
    if args.plan {
        bundle::cleanup(layout);
        out.ok("update.plan/1", &prepared.view, || {
            plan::render(&prepared.view, prepared.lang)
        });
        std::process::exit(0);
    }
    let blocked = &prepared.plan.addons.blocked;
    if !blocked.is_empty() && !args.force {
        stop(
            out,
            layout,
            no(
                "addon-incompatible",
                format!(
                    "required add-on(s) would be incompatible with {}: {} (re-run with --force to disable them and update anyway)",
                    prepared.plan.to,
                    blocked.join(", ")
                ),
            ),
        );
    }
    confirm(out, layout, args, &prepared);
    if !args.require_addon.is_empty() || !args.unrequire_addon.is_empty() {
        if let Err(m) = addons::set_required(layout, &args.require_addon, &args.unrequire_addon) {
            stop(out, layout, no("addons-unreadable", m));
        }
    }
    let (host, target) = host_or_fail(out);
    let st = update::apply(layout, &host, &prepared.plan, &target)
        .unwrap_or_else(|e| stop(out, layout, no(e.reason, e.message)));
    bundle::cleanup(layout);
    finish(out, &st, Some(&prepared.view))
}

fn finish(out: &Out, st: &state::State, view: Option<&Value>) -> ! {
    let outcome = outcome_of(st);
    let mut doc = report(st);
    doc["outcome"] = json!(outcome);
    if let Some(v) = view {
        doc["plan"] = v.clone();
    }
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
