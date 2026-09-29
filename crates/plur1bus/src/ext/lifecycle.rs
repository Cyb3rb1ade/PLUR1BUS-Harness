//! `ext.enable` and `ext.disable` (spec §6.3; X1-R11, X1-R13, X1-R17, X1-R32): hot enable and disable of an installed
//! skill (per agent), module or channel, with the capability acknowledgment and dry-run plans.
//!
//! - **Skill.** The enabled flag lives in `skills/index.json` (written under the importer's lock, X1-R14), the
//!   per-agent selection in `agents.<id>.skills.blocked` (written through [`ModuleHost::set_config`]). Enable without
//!   `agents` (or `"all"`) enables the entry and removes the name from every agent's list; with agents it removes the
//!   name from theirs and adds it to every other configured agent's. Disable without agents disables the entry and
//!   leaves the lists alone; with agents it adds the name to theirs. A skill folder without an index entry (X1-R12)
//!   gets its entry, with its `bundled` or `local` source, at its first toggle that touches the index.
//! - **Module and channel.** `modules.<name>.enabled` through [`ModuleHost::set_config`], the only switch; its result
//!   supplies `restart` and `heldBack`. A disable also holds back the enabled modules whose `needs` reach it
//!   ([`dependents`]), so the offline plan names them too. `agents` is `E_INVALID_PARAMS agents-not-supported`.
//!
//! Enable refuses, before any write and in this order: an unknown name (`E_NOT_FOUND extension-unknown`), bad agents,
//! a missing code folder (`E_NOT_AVAILABLE tampered`, X1-C15), the overlays of a packaged item from a fresh re-hash (`revoked` → `E_DENIED`; `needs-setup`, `incompatible`,
//! `tampered` → `E_NOT_AVAILABLE`), then a missing capability acknowledgment (`E_APPROVAL_REQUIRED
//! acknowledge-capabilities` with the disclosure in `data`). Disable is always allowed. `dry_run` runs every check,
//! asks the host for its plan without writing, and returns the same shape. A toggle that changes nothing writes
//! nothing but the trash pruning every mutation starts with (`super::remove::prune_for`), and no audit line.
//!
//! Supervisor-safe (X1-R2): no package bytes are opened here (`scripts/lint-hygiene.mjs`).
use super::commit::{
    capabilities_hash, config_change, io_err, read_bytes, restore_file, Agents, ModuleHost,
    Rollback,
};
use super::index::{self, lock_skills, ImportLock};
use super::list::{cached_meta, install_units, scripts_of};
use super::overlays::{load_revocations, overlays_of, rehash, revoked, Overlay};
use super::paths::ExtPaths;
use super::state::{self, ItemRecord};
use super::{now_iso, ExtError};
use crate::paths::Layout;
use serde_json::{json, Value};
use std::collections::BTreeSet;

/// `ext.enable|disable`'s options: the agents (skills only; `None` means everywhere for enable and "the entry" for
/// disable), the acknowledgments given (`capabilities`) and whether to only plan.
#[derive(Clone, Debug, Default)]
pub struct ToggleOpts {
    pub agents: Option<Agents>,
    pub acknowledge: Vec<String>,
    pub dry_run: bool,
}

/// X1-R13: the capabilities `caps` are covered by the acknowledged hash `ack`. `ext.enable` checks an item's current
/// capabilities, and the install commit a replacement's new ones (X1-C12), with this one comparison.
pub(crate) fn capabilities_acknowledged(caps: &Value, ack: Option<&str>) -> bool {
    ack == Some(capabilities_hash(caps).as_str())
}

/// The agent checks an enable or disable makes before any write (X1-R11): agents on a module or channel, an agent that
/// is not configured.
fn check_agents(name: &str, kind: &str, cfg: &Value, agents: &Agents) -> Result<(), ExtError> {
    let Agents::Some(list) = agents else {
        return Ok(());
    };
    if kind != "skill" {
        return Err(ExtError::new(
            "E_INVALID_PARAMS",
            "agents-not-supported",
            format!("{name} is a {kind}; modules.{name}.enabled is its only switch"),
        ));
    }
    if let Some(unknown) = list
        .iter()
        .find(|a| cfg["agents"].get(a.as_str()).is_none())
    {
        return Err(ExtError {
            code: "E_AGENT_UNKNOWN",
            reason: None,
            message: format!("no agent {unknown:?} is configured"),
            data: json!({ "agentId": unknown }),
        });
    }
    Ok(())
}

fn needs_setup(name: &str, required_secrets: &[String]) -> ExtError {
    ExtError::new(
        "E_NOT_AVAILABLE",
        "needs-setup",
        format!(
            "{name} needs secrets ({}) that cannot be set up yet; it installs, but cannot be enabled",
            required_secrets.join(", ")
        ),
    )
}

/// The enable pre-checks of `ext.install { enable }` (Task 7) that must refuse before any write: the agent checks,
/// and a required secret slot (X1-R9: `needs-setup` until the secret store lands).
pub(crate) fn enable_prechecks(
    name: &str,
    kind: &str,
    required_secrets: &[String],
    cfg: &Value,
    agents: &Agents,
) -> Result<(), ExtError> {
    check_agents(name, kind, cfg, agents)?;
    if !required_secrets.is_empty() {
        return Err(needs_setup(name, required_secrets));
    }
    Ok(())
}

fn blocked_of(agent: &Value) -> Vec<String> {
    agent["skills"]["blocked"]
        .as_array()
        .map(|l| {
            l.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

type Changes = Vec<(String, Value)>;

/// The `agents.<id>.skills.blocked` writes that give `name` to every agent `wanted` selects, and block it for every
/// other one (X1-R11), with each touched `agents.<id>.skills` as it was (`null`: absent) for a rollback. Lists that
/// would not change are left out.
fn block_changes(
    cfg: &Value,
    name: &str,
    wanted: impl Fn(&str) -> Option<bool>,
) -> (Changes, Changes) {
    let mut changes = Vec::new();
    let mut restore = Vec::new();
    for (id, a) in cfg["agents"].as_object().into_iter().flatten() {
        let Some(give) = wanted(id) else {
            continue;
        };
        let before = blocked_of(a);
        let mut next: Vec<String> = before.iter().filter(|b| *b != name).cloned().collect();
        if !give {
            next.push(name.to_string());
        }
        if next != before {
            changes.push((format!("agents.{id}.skills.blocked"), json!(next)));
            restore.push((
                format!("agents.{id}.skills"),
                a.get("skills").cloned().unwrap_or(Value::Null),
            ));
        }
    }
    (changes, restore)
}

/// A skill enable's list writes: `all` removes the name from every list; a list of agents removes it from theirs and
/// adds it to every other configured agent's.
pub(crate) fn skill_enable_changes(cfg: &Value, name: &str, agents: &Agents) -> (Changes, Changes) {
    block_changes(cfg, name, |id| {
        Some(match agents {
            Agents::All => true,
            Agents::Some(list) => list.iter().any(|x| x == id),
        })
    })
}

/// A skill disable for some agents: the name is added to their lists only.
fn skill_disable_changes(cfg: &Value, name: &str, agents: &[String]) -> (Changes, Changes) {
    block_changes(cfg, name, |id| {
        agents.iter().any(|x| x == id).then_some(false)
    })
}

/// The enabled modules whose `needs` reach `name`, directly or through other enabled modules (`modules::graph`), sorted.
/// A module is enabled unless `modules.<m>.enabled` is `false`; a disabled module is not held back by `name` and does
/// not carry the dependency further.
pub fn dependents(layout: &Layout, cfg: &Value, name: &str) -> Vec<String> {
    let g = crate::modules::graph::graph(&crate::modules::manifest::scan(layout));
    let enabled = |m: &str| cfg["modules"][m]["enabled"] != false;
    let needs: Vec<(&str, &str)> = g
        .edges
        .iter()
        .filter(|e| e["kind"] == "needs")
        .filter_map(|e| Some((e["from"].as_str()?, e["to"].as_str()?)))
        .collect();
    let mut found: BTreeSet<String> = BTreeSet::new();
    let mut frontier = vec![name.to_string()];
    while let Some(target) = frontier.pop() {
        for (from, to) in &needs {
            if *to == target && *from != name && enabled(from) && found.insert(from.to_string()) {
                frontier.push(from.to_string());
            }
        }
    }
    found.into_iter().collect()
}

/// An installed item as a toggle (or an uninstall) sees it.
pub(crate) struct Target {
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) record: Option<ItemRecord>,
    pub(crate) version: String,
}

pub(crate) fn unknown(name: &str) -> ExtError {
    ExtError::new(
        "E_NOT_FOUND",
        "extension-unknown",
        format!("no extension named {name} is installed"),
    )
}

/// The package record (unless hidden, X1-R18), else an index entry or skill folder, else a module directory.
pub(crate) fn resolve(
    layout: &Layout,
    st: &state::ExtState,
    name: &str,
) -> Result<Target, ExtError> {
    if let Some(rec) = st.items.get(name) {
        if rec.removed_by_user || !matches!(rec.kind.as_str(), "skill" | "module" | "channel") {
            return Err(unknown(name));
        }
        return Ok(Target {
            name: name.to_string(),
            kind: rec.kind.clone(),
            version: rec.version.clone(),
            record: Some(rec.clone()),
        });
    }
    let indexed = index::read_index(layout)?.entry(name).cloned();
    if indexed.is_some() || layout.skills().join(name).is_dir() {
        let version = indexed
            .as_ref()
            .and_then(|e| e["package"]["version"].as_str().map(str::to_string))
            .or_else(|| install_units(layout, "skills").remove(name).map(|u| u.1))
            .unwrap_or_default();
        return Ok(Target {
            name: name.to_string(),
            kind: "skill".into(),
            record: None,
            version,
        });
    }
    if let Some(dir) = crate::modules::install::installed_dir(layout, name) {
        let kind = super::record::module_dir_kind(&dir);
        if matches!(kind.as_str(), "module" | "channel") {
            let version = crate::modules::manifest::scan(layout)
                .into_iter()
                .find(|m| m.name == name)
                .and_then(|m| m.manifest.ok().map(|x| x.version))
                .unwrap_or_default();
            return Ok(Target {
                name: name.to_string(),
                kind,
                record: None,
                version,
            });
        }
    }
    Err(unknown(name))
}

fn overlay_name(o: Overlay) -> String {
    serde_json::to_value(o)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// The overlays of a packaged item (none for an item without a record).
fn overlays(paths: &ExtPaths, rec: Option<&ItemRecord>) -> Vec<Overlay> {
    let Some(rec) = rec else {
        return vec![];
    };
    let compat =
        cached_meta(paths, &rec.package_sha256).and_then(|m| m["manifest"].get("compat").cloned());
    overlays_of(
        rec,
        &super::host::host_facts(),
        &load_revocations(paths),
        compat.as_ref(),
    )
}

/// Enable's overlay refusals (X1-R17; Q9: revoked is refused and locked), first match in the overlay order with
/// `revoked` first.
fn refuse_overlays(paths: &ExtPaths, rec: &ItemRecord, found: &[Overlay]) -> Result<(), ExtError> {
    if found.contains(&Overlay::Revoked) {
        let why = revoked(&load_revocations(paths), &rec.id, &rec.version)
            .unwrap_or_else(|| "revoked".into());
        return Err(ExtError::new(
            "E_DENIED",
            "revoked",
            format!("{} {} is revoked: {why}", rec.id, rec.version),
        ));
    }
    for o in found {
        match o {
            Overlay::NeedsSetup => return Err(needs_setup(&rec.name, &rec.required_secrets)),
            Overlay::Incompatible => {
                return Err(ExtError::new(
                    "E_NOT_AVAILABLE",
                    "incompatible",
                    format!(
                        "{} {} does not fit this harness (its compat no longer matches)",
                        rec.id, rec.version
                    ),
                ))
            }
            Overlay::Tampered => {
                let bad = rec
                    .integrity
                    .as_ref()
                    .map(|i| i.paths.clone())
                    .unwrap_or_default();
                return Err(ExtError::new(
                    "E_NOT_AVAILABLE",
                    "tampered",
                    format!(
                        "installed files of {} no longer match the package ({}); reinstall it",
                        rec.name,
                        bad.join(", ")
                    ),
                )
                .with_data(json!({ "paths": bad })));
            }
            _ => {}
        }
    }
    Ok(())
}

/// X1-R13: the first enable of a packaged item, or an enable after its capabilities changed, needs `capabilities`.
/// Items without a package record (bundled, local, imported) never reach this check, so they need none.
fn check_acknowledged(paths: &ExtPaths, rec: &ItemRecord, o: &ToggleOpts) -> Result<(), ExtError> {
    if capabilities_acknowledged(&rec.capabilities, rec.capabilities_ack.as_deref())
        || o.acknowledge.iter().any(|a| a == "capabilities")
    {
        return Ok(());
    }
    let authority = if rec.kind == "skill" {
        rec.capabilities["harness"]["authority"].clone()
    } else {
        json!("full")
    };
    let meta = cached_meta(paths, &rec.package_sha256);
    let what = if rec.capabilities_ack.is_some() {
        "its capabilities changed since they were acknowledged"
    } else {
        "enabling lets the extension use the capabilities it declares"
    };
    Err(ExtError::new(
        "E_APPROVAL_REQUIRED",
        "acknowledge-capabilities",
        format!(
            "{what}; acknowledge \"capabilities\" to enable {}",
            rec.name
        ),
    )
    .with_data(json!({
        "name": rec.name,
        "id": rec.id,
        "version": rec.version,
        "kind": rec.kind,
        "trust": rec.trust,
        "capabilities": rec.capabilities,
        "scripts": scripts_of(meta.as_ref(), rec),
        "authority": authority,
    })))
}

fn state_invalid(e: String) -> ExtError {
    ExtError::new("E_STORAGE", "state-invalid", e)
}

fn empty_plan() -> Value {
    json!({ "restart": { "modules": [] }, "heldBack": [] })
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str().map(str::to_string))
        .collect()
}

/// Adds the enabled modules that need `name` to a plan's `heldBack` (sorted, once each).
fn hold_dependents(plan: &mut Value, layout: &Layout, cfg: &Value, name: &str) {
    let mut held: BTreeSet<String> = strings(&plan["heldBack"]).into_iter().collect();
    held.extend(dependents(layout, cfg, name));
    plan["heldBack"] = json!(held.into_iter().collect::<Vec<_>>());
}

/// `ext.enable` (see the module documentation). Result: `{name, state, restart: {modules}, heldBack}`.
pub fn enable(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    name: &str,
    o: &ToggleOpts,
) -> Result<Value, ExtError> {
    toggle(layout, host, name, o, true)
}

/// `ext.disable` (see the module documentation). Always allowed, whatever the overlays.
pub fn disable(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    name: &str,
    o: &ToggleOpts,
) -> Result<Value, ExtError> {
    toggle(layout, host, name, o, false)
}

fn toggle(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    name: &str,
    o: &ToggleOpts,
    on: bool,
) -> Result<Value, ExtError> {
    // A plan writes nothing, so it does not wait for (or block) a mutation, and prunes nothing.
    if o.dry_run {
        return toggle_locked(layout, host, name, o, on);
    }
    let _guard = super::try_mutation()?;
    super::remove::prune_for(layout, &host.config());
    toggle_locked(layout, host, name, o, on)
}

/// `ext.disable` for a caller that already holds the mutation lock: `ext.uninstall { cascade }` disables the
/// dependents first (X1-R19, spec §6.4).
pub(crate) fn disable_locked(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    name: &str,
    o: &ToggleOpts,
) -> Result<Value, ExtError> {
    toggle_locked(layout, host, name, o, false)
}

/// The code directory of an item: `skills/<name>` or `modules/<name>`.
pub(crate) fn code_dir(layout: &Layout, name: &str, kind: &str) -> std::path::PathBuf {
    if kind == "skill" {
        layout.skills().join(name)
    } else {
        layout.modules_dir().join(name)
    }
}

/// X1-C15: an item whose code folder is missing (a kill between steps that `ext::recover` has not reconciled yet, or
/// a folder deleted by hand) cannot be enabled. The overlay vocabulary has no "missing" value; `tampered` (installed
/// files no longer match what was installed) is the closest, and `data.paths` lists every recorded file.
fn refuse_missing_code(layout: &Layout, t: &Target) -> Result<(), ExtError> {
    let dir = code_dir(layout, &t.name, &t.kind);
    if std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
        return Ok(());
    }
    let paths: Vec<&String> = t.record.iter().flat_map(|r| r.files.keys()).collect();
    Err(ExtError::new(
        "E_NOT_AVAILABLE",
        "tampered",
        format!(
            "the code folder {} of {} is missing; restore it from the trash or reinstall it",
            dir.display(),
            t.name
        ),
    )
    .with_data(json!({ "paths": paths })))
}

fn toggle_locked(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    name: &str,
    o: &ToggleOpts,
    on: bool,
) -> Result<Value, ExtError> {
    let paths = ExtPaths::of(layout);
    let st = state::read(&paths).map_err(state_invalid)?;
    let cfg = host.config();
    let t = resolve(layout, &st, name)?;
    let agents = o.agents.clone().unwrap_or(Agents::All);
    check_agents(name, &t.kind, &cfg, &agents)?;

    // Enable: the code folder, overlays from a fresh re-hash, then the acknowledgment.
    let mut record = t.record.clone();
    if on {
        refuse_missing_code(layout, &t)?;
        if let Some(rec) = record.as_mut() {
            rec.integrity = Some(rehash(layout, rec));
            let found = overlays(&paths, Some(rec));
            refuse_overlays(&paths, rec, &found)?;
            check_acknowledged(&paths, rec, o)?;
        }
    }

    let is_skill = t.kind == "skill";
    // The importer's lock before the index is read for writing (X1-R14), held to the end.
    let _lock: Option<ImportLock> = if is_skill && !o.dry_run {
        Some(lock_skills(layout)?)
    } else {
        None
    };

    // What changes.
    let mut index_entry: Option<Value> = None; // the entry to write, if the index changes
    let (changes, restore, now_on) = if is_skill {
        let idx = index::read_index(layout)?;
        let entry = idx.entry(name).cloned();
        let was_on = entry.as_ref().is_none_or(|e| e["enabled"] == true);
        let set_entry = |enabled: bool| -> Option<Value> {
            match &entry {
                Some(e) if (e["enabled"] == true) == enabled => None,
                Some(e) => {
                    let mut e = e.clone();
                    e["enabled"] = json!(enabled);
                    Some(e)
                }
                // A packaged skill whose entry a kill lost (normally reconciled by `ext::recover`) gets its package
                // entry back, never a local one.
                None if t.record.is_some() => t
                    .record
                    .as_ref()
                    .map(|r| index::package_entry(r, "-", enabled, &now_iso(), None)),
                None => {
                    let source = match install_units(layout, "skills").get(name) {
                        Some((s, _)) if s == "bundled" => "bundled",
                        _ => "local",
                    };
                    Some(index::local_entry(
                        layout,
                        name,
                        source,
                        enabled,
                        &now_iso(),
                    ))
                }
            }
        };
        if on {
            index_entry = set_entry(true);
            let (c, r) = skill_enable_changes(&cfg, name, &agents);
            (c, r, true)
        } else {
            match &o.agents {
                Some(Agents::Some(list)) => {
                    // The entry stays as it is, but an unindexed skill gets its first one (X1-R12), enabled.
                    index_entry = if entry.is_none() {
                        set_entry(true)
                    } else {
                        None
                    };
                    let (c, r) = skill_disable_changes(&cfg, name, list);
                    (c, r, was_on)
                }
                _ => {
                    index_entry = set_entry(false);
                    (vec![], vec![], false)
                }
            }
        }
    } else {
        let current = cfg["modules"][name]["enabled"] != false;
        let section = cfg["modules"].get(name).cloned().unwrap_or(Value::Null);
        if current == on {
            (vec![], vec![], on)
        } else {
            (
                vec![(format!("modules.{name}.enabled"), json!(on))],
                vec![(format!("modules.{name}"), section)],
                on,
            )
        }
    };
    let ack_changes = on
        && record.as_ref().is_some_and(|r| {
            !capabilities_acknowledged(&r.capabilities, r.capabilities_ack.as_deref())
        });
    let noop = changes.is_empty() && index_entry.is_none() && !ack_changes;

    // The plan: the host's (asked for without writing only when that is all this call does), plus, for a module
    // disable, the enabled modules that need this one.
    let mut plan = if changes.is_empty() || !o.dry_run {
        empty_plan()
    } else {
        host.set_config(changes.clone(), true)?
    };
    if !on && !is_skill {
        hold_dependents(&mut plan, layout, &cfg, name);
    }
    let state_name = if now_on { "enabled" } else { "installed" };
    let result = |plan: &Value| {
        json!({
            "name": name,
            "state": state_name,
            "restart": { "modules": strings(&plan["restart"]["modules"]) },
            "heldBack": strings(&plan["heldBack"]),
        })
    };
    if o.dry_run || noop {
        return Ok(result(&plan));
    }

    // The writes, each with its undo: the record (enable), config, the index.
    let mut rb = Rollback::default();
    let written = (|| -> Result<Value, ExtError> {
        if on {
            if let Some(rec) = record.as_mut() {
                rec.capabilities_ack = Some(capabilities_hash(&rec.capabilities));
                let mut next = st.clone();
                next.items.insert(name.to_string(), rec.clone());
                let before = read_bytes(&paths.state);
                state::write(&paths, &next).map_err(|e| io_err("cannot write", &paths.state, e))?;
                rb.push("state", restore_file(paths.state.clone(), before));
            }
        }
        let mut applied = plan.clone();
        if !changes.is_empty() {
            applied = config_change(host, "config", changes.clone(), restore.clone(), &mut rb)?;
        }
        if let Some(entry) = &index_entry {
            let ipath = index::index_path(layout);
            let before = read_bytes(&ipath);
            let mut idx = index::read_index(layout)?;
            idx.upsert(entry.clone());
            index::write_index(layout, &idx).map_err(|e| io_err("cannot write", &ipath, e))?;
            rb.push("index", restore_file(ipath, before));
        }
        Ok(applied)
    })();
    let applied = match written {
        Ok(p) => p,
        Err(mut e) => {
            let failed = rb.run(host);
            if !failed.is_empty() {
                e.message = format!(
                    "{}; the rollback also failed: {}",
                    e.message,
                    failed.join("; ")
                );
            }
            return Err(e);
        }
    };
    let mut plan = applied;
    if !on && !is_skill {
        hold_dependents(&mut plan, layout, &cfg, name);
    }

    let action = if on { "ext.enable" } else { "ext.disable" };
    let agents_detail = match &o.agents {
        None => Value::Null,
        Some(Agents::All) => json!("all"),
        Some(Agents::Some(list)) => json!(list),
    };
    let detail = json!({ "kind": t.kind, "agents": agents_detail, "via": host.via() });
    if let Err(e) = crate::audit::append(layout, action, name, detail) {
        eprintln!("plur1bus: warning: cannot write the audit line for {action} {name}: {e}");
    }
    let shown: Vec<String> = overlays(&paths, record.as_ref())
        .into_iter()
        .map(overlay_name)
        .collect();
    host.notify(json!({
        "name": name, "kind": t.kind, "state": state_name, "version": t.version, "overlays": shown
    }));
    Ok(result(&plan))
}
