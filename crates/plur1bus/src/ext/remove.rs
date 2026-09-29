//! `ext.uninstall` and `ext.restore`, and the trash (spec §6.4; X1-R18, X1-R19, X1-R31, X1-R32; X1-C15).
//!
//! - **Uninstall** moves an item's code into a fresh `extensions/trash/<name>-<version>-<YYYYMMDDTHHMMSSZ>/` (built
//!   atomically by [`build_trash_entry`], the same builder and layout a replacing install uses): `code/`,
//!   `package.p1x` (the cached package, which leaves the cache) and `record.json` (`{removedAt, reason, name, kind,
//!   version, record, index, purged}`: the state record and the index entry as they were). A skill's folder moves by
//!   rename; a module goes through [`ModuleHost::remove_module`] (which stops it first). The state record and the
//!   index entry are removed. Kept: `data/ext/<name>/` and the config section (`modules.<name>` stays, D14).
//! - **Purge** also moves `data/ext/<name>/` to `<trashId>/data`, and deletes the config: a module's `modules.<name>`
//!   section goes to `<trashId>/config.json` (`{"modules.<name>": section}`), a skill's name leaves every
//!   `agents.*.skills.{blocked,pinned}`. X1 has no secret store (X1-R31), so no secret is deleted, and the audit
//!   line's `detail.secrets` says so (`[]`).
//! - **Refusals**, before any write: an unknown or hidden name (`E_NOT_FOUND extension-unknown`); a purge of a bundled
//!   skill (`E_DENIED bundled`); a module that enabled modules still need ([`dependents`], the same list `ext.show`
//!   names) without `cascade` (`E_CONFLICT required-by`, `data.dependents`). `cascade` disables them first.
//! - **Bundled skills** (X1-R18) are hidden, not moved: a tombstone record (`removedByUser: true`) in `state.json` and
//!   a disabled index entry. The answer's `trashId` is `null`: nothing went into the trash.
//! - **Restore** brings an entry back as installed(disabled), replaying the install's order after marking the entry
//!   (`restoring`): the module's config section first (`enabled: false`, merged with a purged section the entry
//!   holds), the skill's index entry (disabled, before the folder, X1-C10), the code, the state record, the cached
//!   package and the data. An entry older than `extensions.trashDays` (or missing) is `E_NOT_FOUND trash-expired`; a
//!   name that is taken is `E_CONFLICT name-taken`.
//! - **Pruning** ([`prune_trash`]) removes entries older than `extensions.trashDays` by their recorded `removedAt`.
//!   Every mutation prunes once it has passed its refusal checks and is about to write, never on a refusal or a no-op
//!   (X1-C16); no timer runs.
//! - **Cascade** (X1-C17): dependents it disabled stay disabled if the uninstall then fails; the error names them in
//!   `data.disabledDependents`.
//!
//! Every step registers its undo; a failure undoes the steps done so far (the tree ends byte-identical, no audit line).
//! A kill between steps (`PLUR1BUS_TEST_EXT_FAIL_AT=kill:<point>`) is reconciled by [`super::recover`]: code that
//! moved into the trash while its record stayed is put back (X1-C15), with its cached package; a marked restore is
//! finished when its code is in place, else undone so the entry keeps its code.
//!
//! Supervisor-safe (X1-R2): no package bytes are opened here; the package is moved as an opaque file.
use super::commit::{
    build_trash_entry, config_change, copy_atomic, ensure_dir, fail_at, install_err, io_err,
    killed, put_code_back, read_bytes, reset_kill, restore_file, ModuleHost, Rollback,
};
use super::index::{self, lock_skills, ImportLock};
use super::lifecycle::{dependents, disable_locked, resolve, Target, ToggleOpts};
use super::list::{cached_meta, install_units};
use super::overlays::{load_revocations, overlays_of};
use super::paths::ExtPaths;
use super::record::{module_dir_kind, name_taken, now_ms, parse_iso_ms};
use super::state::{self, remove_dir_all_retrying, remove_retrying, rename_retrying, ItemRecord};
use super::{now_iso, ExtError};
use crate::modules::install as modinstall;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const DAY_MS: u64 = 86_400_000;
/// `extensions.trashDays`' default (§13 Q14).
const DEFAULT_TRASH_DAYS: u32 = 14;

/// `ext.uninstall`'s options.
#[derive(Clone, Debug, Default)]
pub struct RemoveOpts {
    /// Also move `data/ext/<name>/` into the trash and delete the config section.
    pub purge: bool,
    /// Disable the enabled modules that need this one first, instead of refusing with `required-by`.
    pub cascade: bool,
}

/// `extensions.trashDays` (1–365, default 14).
pub(crate) fn trash_days(cfg: &Value) -> u32 {
    cfg["extensions"]["trashDays"]
        .as_u64()
        .filter(|d| (1..=365).contains(d))
        .map_or(DEFAULT_TRASH_DAYS, |d| d as u32)
}

/// [`prune_trash`] with the configured retention: what every mutation calls first.
pub(crate) fn prune_for(layout: &Layout, cfg: &Value) -> Vec<String> {
    prune_trash(layout, trash_days(cfg))
}

fn read_json(p: &Path) -> Option<Value> {
    fs::read_to_string(p)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
}

fn mtime_ms(p: &Path) -> Option<u64> {
    let t = fs::metadata(p).and_then(|m| m.modified()).ok()?;
    let d = t.duration_since(std::time::UNIX_EPOCH).ok()?;
    u64::try_from(d.as_millis()).ok()
}

fn is_expired(at_ms: u64, days: u32) -> bool {
    now_ms().saturating_sub(at_ms) > u64::from(days) * DAY_MS
}

/// When a trash entry was made: its `record.json`'s `removedAt`, else (an unreadable record) the entry's mtime.
fn removed_at_ms(dir: &Path) -> Option<u64> {
    read_json(&dir.join("record.json"))
        .and_then(|rj| rj["removedAt"].as_str().and_then(parse_iso_ms))
        .or_else(|| mtime_ms(dir))
}

/// Removes the trash entries older than `days` days (X1-R19), by their recorded `removedAt`. An entry still being built
/// (`<trashId>.tmp-<pid>`) or marked by a restore ([`RESTORING`]) is left to [`super::recover`]. Returns the removed
/// trash ids, sorted. Best effort.
pub fn prune_trash(layout: &Layout, days: u32) -> Vec<String> {
    let dir = ExtPaths::of(layout).trash;
    let Ok(entries) = fs::read_dir(&dir) else {
        return vec![];
    };
    let mut pruned = Vec::new();
    for e in entries.flatten() {
        let Ok(tid) = e.file_name().into_string() else {
            continue;
        };
        // An entry still being built is `ext::recover`'s, and so is one a restore is using (or a kill left marked).
        if tid.contains(".tmp-")
            || !e.file_type().is_ok_and(|t| t.is_dir())
            || e.path().join(RESTORING).exists()
        {
            continue;
        }
        let old = removed_at_ms(&e.path()).is_some_and(|t| is_expired(t, days));
        if old && remove_dir_all_retrying(&e.path()).is_ok() {
            pruned.push(tid);
        }
    }
    pruned.sort();
    pruned
}

/// The importer's `SKILL_ID`, which every extension name satisfies.
fn name_ok(n: &str) -> bool {
    let b = n.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..].iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

/// A trash id is one path segment: `<name>-<version>-<stamp>[-n]` in `[A-Za-z0-9._+-]`, never `.`/`..` or a temp
/// entry.
pub(crate) fn valid_trash_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && !id.starts_with('.')
        && !id.contains(".tmp-")
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'+'))
}

/// The trash entry for `name` at `version` whose `code/` is still there, newest first by `removedAt`.
pub(crate) fn newest_trash_with_code(
    paths: &ExtPaths,
    name: &str,
    version: &str,
) -> Option<PathBuf> {
    let entries = fs::read_dir(&paths.trash).ok()?;
    let mut best: Option<(u64, PathBuf)> = None;
    for e in entries.flatten() {
        let tid = e.file_name().to_string_lossy().into_owned();
        if tid.contains(".tmp-") || !e.path().join("code").is_dir() {
            continue;
        }
        let Some(rj) = read_json(&e.path().join("record.json")) else {
            continue;
        };
        let n = rj["name"]
            .as_str()
            .or_else(|| rj["record"]["name"].as_str());
        let v = rj["version"]
            .as_str()
            .or_else(|| rj["record"]["version"].as_str());
        if n != Some(name) || v != Some(version) {
            continue;
        }
        let at = rj["removedAt"].as_str().and_then(parse_iso_ms).unwrap_or(0);
        if best.as_ref().is_none_or(|(b, _)| at > *b) {
            best = Some((at, e.path()));
        }
    }
    best.map(|(_, p)| p)
}

fn state_invalid(e: String) -> ExtError {
    ExtError::new("E_STORAGE", "state-invalid", e)
}

fn trash_expired(id: &str) -> ExtError {
    ExtError::new(
        "E_NOT_FOUND",
        "trash-expired",
        format!(
            "no trash entry {id:?}: it was never there, or it is older than extensions.trashDays and was removed"
        ),
    )
}

fn pretty(v: &Value) -> Vec<u8> {
    let mut text = serde_json::to_string_pretty(v).unwrap_or_default();
    text.push('\n');
    text.into_bytes()
}

/// Runs the undo actions of a failed mutation (none after a kill) and adds their failures to the error.
fn roll_back(mut e: ExtError, rb: Rollback<'_>, host: &mut dyn ModuleHost) -> ExtError {
    if killed() {
        drop(rb); // a killed process undoes nothing
        return e;
    }
    let failed = rb.run(host);
    if !failed.is_empty() {
        e.message = format!(
            "{}; the rollback also failed: {}",
            e.message,
            failed.join("; ")
        );
    }
    e
}

/// X1-C17: an uninstall error after a cascade names the dependents it disabled (`data.disabledDependents`), which stay
/// disabled.
fn with_disabled(mut e: ExtError, disabled: &[String]) -> ExtError {
    if disabled.is_empty() {
        return e;
    }
    if !e.data.is_object() {
        e.data = json!({});
    }
    e.data["disabledDependents"] = json!(disabled);
    e.message = format!(
        "{}; the dependents disabled first stay disabled: {}",
        e.message,
        disabled.join(", ")
    );
    e
}

fn audit(layout: &Layout, action: &str, name: &str, detail: Value) {
    if let Err(e) = crate::audit::append(layout, action, name, detail) {
        eprintln!("plur1bus: warning: cannot write the audit line for {action} {name}: {e}");
    }
}

// ---- uninstall ------------------------------------------------------------------------------------------------------

/// A skill without a package record that the install manifest (or its index entry) names as bundled (X1-R12).
fn bundled_skill(layout: &Layout, name: &str) -> Result<bool, ExtError> {
    if install_units(layout, "skills")
        .get(name)
        .is_some_and(|(s, _)| s == "bundled")
    {
        return Ok(true);
    }
    Ok(index::read_index(layout)?
        .entry(name)
        .is_some_and(|e| e["source"] == "bundled"))
}

/// `ext.uninstall` (see the module documentation). Result: `{name, removed: true, trashId, purged}`.
pub fn uninstall(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    name: &str,
    o: &RemoveOpts,
) -> Result<Value, ExtError> {
    let guard = super::try_mutation()?;
    uninstall_held(layout, host, name, o, &guard)
}

/// [`uninstall`] for a caller that already holds the ext mutation lock (the supervisor, which refreshes its overlays
/// before it lets the lock go).
pub fn uninstall_held(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    name: &str,
    o: &RemoveOpts,
    _held: &super::MutationGuard,
) -> Result<Value, ExtError> {
    reset_kill();
    let cfg = host.config();
    let paths = ExtPaths::of(layout);
    let st = state::read(&paths).map_err(state_invalid)?;
    let t = resolve(layout, &st, name)?;
    let is_skill = t.kind == "skill";
    let bundled = is_skill && t.record.is_none() && bundled_skill(layout, name)?;
    if bundled && o.purge {
        return Err(ExtError::new(
            "E_DENIED",
            "bundled",
            format!("{name} is bundled with PLUR1BUS and cannot be purged; uninstall hides it"),
        ));
    }
    let deps = if is_skill {
        vec![]
    } else {
        dependents(layout, &cfg, name)
    };
    if !deps.is_empty() && !o.cascade {
        return Err(ExtError::new(
            "E_CONFLICT",
            "required-by",
            format!(
                "{name} is needed by the enabled module(s) {}; disable them first, or uninstall with cascade",
                deps.join(", ")
            ),
        )
        .with_data(json!({ "dependents": deps })));
    }
    // The importer's lock before the index is read for writing (X1-R14), held to the end.
    let _lock: Option<ImportLock> = if is_skill {
        Some(lock_skills(layout)?)
    } else {
        None
    };
    // Every refusal is behind us: the first write (X1-C16).
    prune_for(layout, &cfg);
    // X1-C17: dependents the cascade disabled stay disabled if the uninstall then fails; the error names them.
    let mut disabled: Vec<String> = Vec::new();
    for d in &deps {
        if let Err(e) = disable_locked(layout, host, d, &ToggleOpts::default()) {
            return Err(with_disabled(e, &disabled));
        }
        disabled.push(d.clone());
    }
    if bundled {
        return hide_bundled(layout, &paths, host, &t);
    }

    let mut rb = Rollback::default();
    let (tid, moved) = match move_to_trash(layout, &paths, host, &t, o, &mut rb) {
        Ok(x) => x,
        Err(e) => return Err(with_disabled(roll_back(e, rb, host), &disabled)),
    };
    drop(rb);
    let mut detail = json!({
        "kind": t.kind, "version": t.version, "trashId": tid, "purged": o.purge, "cascade": deps,
        "via": host.via(),
    });
    if o.purge {
        detail["moved"] = json!(moved);
        detail["secrets"] = json!([]); // X1-R31: no secret store yet, so none were deleted
    }
    let action = if o.purge {
        "ext.purge"
    } else {
        "ext.uninstall"
    };
    audit(layout, action, name, detail);
    host.notify(json!({
        "name": name, "kind": t.kind, "state": "removed", "version": t.version, "overlays": []
    }));
    Ok(json!({ "name": name, "removed": true, "trashId": tid, "purged": o.purge }))
}

/// The config writes that take a purged skill's name out of every `agents.*.skills.{blocked,pinned}`, with each touched
/// `agents.<id>.skills` as it was, for the rollback.
type Changes = Vec<(String, Value)>;
fn purge_lists(cfg: &Value, name: &str) -> (Changes, Changes) {
    let mut changes = Vec::new();
    let mut restore = Vec::new();
    for (id, a) in cfg["agents"].as_object().into_iter().flatten() {
        let mut touched = false;
        for list in ["blocked", "pinned"] {
            let Some(items) = a["skills"][list].as_array() else {
                continue;
            };
            if items.iter().any(|x| x == name) {
                let kept: Vec<&Value> = items.iter().filter(|x| *x != name).collect();
                changes.push((format!("agents.{id}.skills.{list}"), json!(kept)));
                touched = true;
            }
        }
        if touched {
            restore.push((
                format!("agents.{id}.skills"),
                a.get("skills").cloned().unwrap_or(Value::Null),
            ));
        }
    }
    (changes, restore)
}

/// The uninstall's writes, each registering its undo: trash entry, code, state record, cached package, index entry,
/// then (purge) data and config. The record goes right after the code, so a kill leaves either the item installed
/// with its code in the trash (which `ext::recover` puts back, X1-C15) or the item uninstalled. Returns the trash id
/// and what a purge moved or deleted.
fn move_to_trash<'a>(
    layout: &'a Layout,
    paths: &ExtPaths,
    host: &mut dyn ModuleHost,
    t: &Target,
    o: &RemoveOpts,
    rb: &mut Rollback<'a>,
) -> Result<(String, Vec<String>), ExtError> {
    let name = t.name.as_str();
    let is_skill = t.kind == "skill";
    let now = now_iso();
    let cfg = host.config();
    let idx_entry = if is_skill {
        index::read_index(layout)?.entry(name).cloned()
    } else {
        None
    };
    let section = if o.purge && !is_skill {
        cfg["modules"].get(name).cloned()
    } else {
        None
    };
    let body = json!({
        "removedAt": now, "reason": if o.purge { "purged" } else { "uninstalled" }, "name": name, "kind": t.kind,
        "version": t.version, "record": t.record, "index": idx_entry, "purged": o.purge,
    });
    let mut extra: Vec<(&str, Vec<u8>)> = Vec::new();
    if let Some(sec) = &section {
        let mut saved = serde_json::Map::new();
        saved.insert(format!("modules.{name}"), sec.clone());
        extra.push(("config.json", pretty(&Value::Object(saved))));
    }
    let sha = t.record.as_ref().map(|r| r.package_sha256.clone());
    let version = if t.version.is_empty() {
        "0.0.0"
    } else {
        t.version.as_str()
    };

    // trash: the entry, whose one undo puts code and data back and removes it only once that worked.
    ensure_dir(&paths.trash, "trash", rb)?;
    let (tid, tdir) = build_trash_entry(paths, name, version, &now, &body, sha.as_deref(), &extra)?;
    {
        let (entry, n, data) = (tdir.clone(), name.to_string(), layout.ext_data(name));
        rb.push("trash", move |h| {
            put_code_back(layout, h, is_skill, &n, &entry.join("code"))?;
            let moved = entry.join("data");
            if fs::symlink_metadata(&moved).is_ok() {
                rename_retrying(&moved, &data).map_err(|e| {
                    format!(
                        "cannot put {} back (it stays in the trash): {e}",
                        moved.display()
                    )
                })?;
            }
            remove_dir_all_retrying(&entry).map_err(|e| format!("{}: {e}", entry.display()))
        });
    }
    fail_at("uninstall.trash")?;

    // code
    let code = tdir.join("code");
    if is_skill {
        let dir = layout.skills().join(name);
        if fs::symlink_metadata(&dir).is_ok() {
            rename_retrying(&dir, &code)
                .map_err(|e| io_err("cannot move to the trash", &dir, e))?;
        }
    } else if modinstall::installed_dir(layout, name).is_some() {
        host.remove_module(name, &code)?;
    }
    fail_at("uninstall.code")?;

    // state
    if t.record.is_some() {
        let mut st = state::read(paths).map_err(state_invalid)?;
        st.items.remove(name);
        let before = read_bytes(&paths.state);
        state::write(paths, &st).map_err(|e| io_err("cannot write", &paths.state, e))?;
        rb.push("state", restore_file(paths.state.clone(), before));
        fail_at("uninstall.state")?;
    }

    // cache: the package now lives in the trash entry. Only once the record is gone: a kill before that leaves the
    // item installed with its cached package (recover puts the code back and drops the entry).
    if let Some(sha) = &sha {
        let cached = paths.cached(sha);
        let copy = tdir.join("package.p1x");
        if cached.is_file() && copy.is_file() {
            remove_retrying(&cached).map_err(|e| io_err("cannot remove", &cached, e))?;
            rb.push("cache", move |_| {
                copy_atomic(&copy, &cached).map_err(|e| e.to_string())
            });
            fail_at("uninstall.cache")?;
        }
    }

    // index (skills)
    if idx_entry.is_some() {
        let ipath = index::index_path(layout);
        let before = read_bytes(&ipath);
        let mut idx = index::read_index(layout)?;
        idx.remove(name);
        index::write_index(layout, &idx).map_err(|e| io_err("cannot write", &ipath, e))?;
        rb.push("index", restore_file(ipath, before));
        fail_at("uninstall.index")?;
    }

    // purge: data, then config.
    let mut moved = Vec::new();
    if o.purge {
        let data = layout.ext_data(name);
        if fs::symlink_metadata(&data).is_ok() {
            let to = tdir.join("data");
            rename_retrying(&data, &to)
                .map_err(|e| io_err("cannot move to the trash", &data, e))?;
            moved.push(format!("data/ext/{name}"));
            fail_at("uninstall.data")?;
        }
        let (changes, restore) = if is_skill {
            purge_lists(&host.config(), name)
        } else if let Some(sec) = &section {
            (
                vec![(format!("modules.{name}"), Value::Null)],
                vec![(format!("modules.{name}"), sec.clone())],
            )
        } else {
            (vec![], vec![])
        };
        if !changes.is_empty() {
            moved.extend(changes.iter().map(|(k, _)| k.clone()));
            config_change(host, "config", changes, restore, rb)?;
            fail_at("uninstall.config")?;
        }
    }
    Ok((tid, moved))
}

/// X1-R18: a bundled skill is hidden, not deleted (the next release would bring it back): a tombstone record with
/// `removedByUser: true` and a disabled index entry. `setup` honouring the tombstone is M8.
fn hide_bundled(
    layout: &Layout,
    paths: &ExtPaths,
    host: &mut dyn ModuleHost,
    t: &Target,
) -> Result<Value, ExtError> {
    let name = t.name.as_str();
    let now = now_iso();
    let version = if t.version.is_empty() {
        "0.0.0".to_string()
    } else {
        t.version.clone()
    };
    let local = index::local_entry(layout, name, "bundled", false, &now);
    let sha = local["sha256"]
        .as_str()
        .and_then(|s| s.strip_prefix("sha256:"))
        .unwrap_or_default()
        .to_string();
    let tombstone = ItemRecord {
        id: format!("bundled/{name}"),
        name: name.to_string(),
        kind: "skill".into(),
        version: version.clone(),
        source: "bundled".into(),
        trust: "release".into(),
        key_id: None,
        key_label: None,
        package_sha256: sha,
        installed_at: now.clone(),
        previous_version: None,
        files: Default::default(),
        capabilities: json!({}),
        capabilities_ack: None,
        scripts: vec![],
        required_secrets: vec![],
        removed_by_user: true,
        integrity: None,
    };
    let mut rb = Rollback::default();
    let written = (|| -> Result<(), ExtError> {
        let mut st = state::read(paths).map_err(state_invalid)?;
        st.items.insert(name.to_string(), tombstone);
        ensure_dir(&paths.root, "state", &mut rb)?;
        let before = read_bytes(&paths.state);
        state::write(paths, &st).map_err(|e| io_err("cannot write", &paths.state, e))?;
        rb.push("state", restore_file(paths.state.clone(), before));
        fail_at("uninstall.state")?;
        let ipath = index::index_path(layout);
        let before = read_bytes(&ipath);
        let mut idx = index::read_index(layout)?;
        let entry = match idx.entry(name) {
            Some(e) => {
                let mut e = e.clone();
                e["enabled"] = json!(false);
                e
            }
            None => local,
        };
        idx.upsert(entry);
        index::write_index(layout, &idx).map_err(|e| io_err("cannot write", &ipath, e))?;
        rb.push("index", restore_file(ipath, before));
        fail_at("uninstall.index")
    })();
    if let Err(e) = written {
        return Err(roll_back(e, rb, host));
    }
    drop(rb);
    audit(
        layout,
        "ext.uninstall",
        name,
        json!({ "kind": "skill", "version": version, "hidden": true, "via": host.via() }),
    );
    host.notify(json!({
        "name": name, "kind": "skill", "state": "removed", "version": version, "overlays": []
    }));
    Ok(json!({ "name": name, "removed": true, "trashId": null, "purged": false }))
}

// ---- restore --------------------------------------------------------------------------------------------------------

/// A restored name must be free: no record (a hidden bundled item's tombstone included), no skill folder or index
/// entry, no module directory.
fn check_free(layout: &Layout, st: &state::ExtState, name: &str) -> Result<(), ExtError> {
    if let Some(r) = st.items.get(name) {
        return Err(name_taken(name, &r.kind, Some(&r.id)));
    }
    if fs::symlink_metadata(layout.skills().join(name)).is_ok()
        || index::read_index(layout)?.entry(name).is_some()
    {
        return Err(name_taken(name, "skill", None));
    }
    let m = layout.modules_dir().join(name);
    if fs::symlink_metadata(&m).is_ok() {
        return Err(name_taken(name, &module_dir_kind(&m), None));
    }
    Ok(())
}

/// `data/ext/<name>` exists and holds something: a restore does not merge data.
fn data_in_the_way(layout: &Layout, name: &str) -> bool {
    fs::read_dir(layout.ext_data(name)).is_ok_and(|mut r| r.next().is_some())
        || fs::symlink_metadata(layout.ext_data(name)).is_ok_and(|m| !m.is_dir())
}

/// The file that marks a trash entry whose restore is running (or was killed): `ext::recover` finishes or undoes it.
pub(crate) const RESTORING: &str = "restoring";

/// What a trash entry says about the item in it.
struct Trashed {
    name: String,
    kind: String,
    version: String,
    record: Option<ItemRecord>,
    body: Value,
}

fn read_entry(tdir: &Path, id: &str, days: u32) -> Result<Trashed, ExtError> {
    let body = read_json(&tdir.join("record.json")).ok_or_else(|| trash_expired(id))?;
    let at = body["removedAt"]
        .as_str()
        .and_then(parse_iso_ms)
        .ok_or_else(|| trash_expired(id))?;
    if is_expired(at, days) || !tdir.join("code").is_dir() {
        return Err(trash_expired(id));
    }
    let record: Option<ItemRecord> = serde_json::from_value(body["record"].clone()).ok();
    let name = body["name"]
        .as_str()
        .or_else(|| record.as_ref().map(|r| r.name.as_str()))
        .or_else(|| body["index"]["id"].as_str())
        .filter(|n| name_ok(n))
        .ok_or_else(|| trash_expired(id))?
        .to_string();
    let kind = body["kind"]
        .as_str()
        .or_else(|| record.as_ref().map(|r| r.kind.as_str()))
        .unwrap_or("skill")
        .to_string();
    if !matches!(kind.as_str(), "skill" | "module" | "channel")
        || record.as_ref().is_some_and(|r| r.name != name)
    {
        return Err(trash_expired(id));
    }
    let version = body["version"]
        .as_str()
        .or_else(|| record.as_ref().map(|r| r.version.as_str()))
        .unwrap_or_default()
        .to_string();
    Ok(Trashed {
        name,
        kind,
        version,
        record,
        body,
    })
}

/// `ext.restore` (see the module documentation). Result: `{name, version, state: "installed"}`.
pub fn restore(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    trash_id: &str,
) -> Result<Value, ExtError> {
    let guard = super::try_mutation()?;
    restore_held(layout, host, trash_id, &guard)
}

/// [`restore`] for a caller that already holds the ext mutation lock.
pub fn restore_held(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    trash_id: &str,
    _held: &super::MutationGuard,
) -> Result<Value, ExtError> {
    reset_kill();
    let cfg = host.config();
    let days = trash_days(&cfg);
    let paths = ExtPaths::of(layout);
    if !valid_trash_id(trash_id) {
        return Err(trash_expired(trash_id));
    }
    let tdir = paths.trash.join(trash_id);
    let t = read_entry(&tdir, trash_id, days)?;
    let _lock: Option<ImportLock> = if t.kind == "skill" {
        Some(lock_skills(layout)?)
    } else {
        None
    };
    let st = state::read(&paths).map_err(state_invalid)?;
    check_free(layout, &st, &t.name)?;
    if tdir.join("data").exists() && data_in_the_way(layout, &t.name) {
        return Err(ExtError::new(
            "E_CONFLICT",
            "name-taken",
            format!(
                "{} holds data already; move it away before restoring {trash_id}",
                layout.ext_data(&t.name).display()
            ),
        ));
    }
    // Every refusal is behind us: the first write (X1-C16). This entry is not expired, so it stays.
    prune_trash(layout, days);

    let mut rb = Rollback::default();
    if let Err(e) = restore_steps(layout, &paths, host, &tdir, &t, &mut rb) {
        return Err(roll_back(e, rb, host));
    }
    drop(rb);
    // The entry is spent.
    if let Err(e) = remove_dir_all_retrying(&tdir) {
        eprintln!(
            "plur1bus: warning: {trash_id} is restored, but its trash entry could not be removed: {e}"
        );
    }
    audit(
        layout,
        "ext.restore",
        &t.name,
        json!({ "kind": t.kind, "version": t.version, "trashId": trash_id, "via": host.via() }),
    );
    let overlays = t.record.as_ref().map_or(json!([]), |r| {
        let compat = cached_meta(&paths, &r.package_sha256)
            .and_then(|m| m["manifest"].get("compat").cloned());
        json!(overlays_of(
            r,
            &super::host::host_facts(),
            &load_revocations(&paths),
            compat.as_ref()
        ))
    });
    host.notify(json!({
        "name": t.name, "kind": t.kind, "state": "installed", "version": t.version, "overlays": overlays
    }));
    Ok(json!({ "name": t.name, "version": t.version, "state": "installed" }))
}

fn write_entry<'a>(layout: &Layout, entry: Value, rb: &mut Rollback<'a>) -> Result<(), ExtError> {
    let ipath = index::index_path(layout);
    let before = read_bytes(&ipath);
    let mut idx = index::read_index(layout)?;
    idx.upsert(entry);
    index::write_index(layout, &idx).map_err(|e| io_err("cannot write", &ipath, e))?;
    rb.push("index", restore_file(ipath, before));
    Ok(())
}

/// The restore's writes in the install's order, each registering its undo.
fn restore_steps<'a>(
    layout: &'a Layout,
    paths: &ExtPaths,
    host: &mut dyn ModuleHost,
    tdir: &Path,
    t: &Trashed,
    rb: &mut Rollback<'a>,
) -> Result<(), ExtError> {
    let name = t.name.as_str();
    let is_skill = t.kind == "skill";
    let now = now_iso();

    // A restore in progress is marked in its entry, so `ext::recover` can finish or undo one a kill interrupted. For a
    // module the mark carries the config section as it was (`null`: absent), which an undo puts back.
    let previous = if is_skill {
        None
    } else {
        Some(
            host.config()["modules"]
                .get(name)
                .cloned()
                .unwrap_or(Value::Null),
        )
    };
    let mut mark = json!({ "at": now });
    if let Some(prev) = &previous {
        mark["previousSection"] = prev.clone();
    }
    let marker = tdir.join(RESTORING);
    state::write_private_atomic(&marker, &pretty(&mark))
        .map_err(|e| io_err("cannot write", &marker, e))?;
    rb.push("marker", move |_| {
        remove_retrying(&marker).map_err(|e| e.to_string())
    });

    // config: a module comes back disabled, with its purged section if the entry holds one (only this item's own
    // section is taken from the entry). One write, first, so a kill after it never strands the section.
    if !is_skill {
        let key = format!("modules.{name}");
        let current = host.config()["modules"]
            .get(name)
            .cloned()
            .unwrap_or(Value::Null);
        let saved = read_json(&tdir.join("config.json"))
            .and_then(|v| v.get(&key).cloned())
            .filter(Value::is_object);
        let mut section = saved.unwrap_or_else(|| {
            if current.is_object() {
                current.clone()
            } else {
                json!({})
            }
        });
        section["enabled"] = json!(false);
        if section != current {
            config_change(
                host,
                "config",
                vec![(key.clone(), section)],
                vec![(key, current)],
                rb,
            )?;
        }
        fail_at("restore.config")?;
    }

    // index (skills): the entry, disabled, before the folder moves in (X1-C10).
    let entry_first = is_skill && (t.body["index"].is_object() || t.record.is_some());
    if entry_first {
        ensure_dir(&layout.skills(), "index", rb)?;
        let entry = match (&t.body["index"], &t.record) {
            (e, _) if e.is_object() => {
                let mut e = e.clone();
                e["enabled"] = json!(false);
                e
            }
            (_, Some(r)) => index::package_entry(r, "-", false, &now, None),
            _ => unreachable!("entry_first needs an entry or a record"),
        };
        write_entry(layout, entry, rb)?;
        fail_at("restore.index")?;
    }

    // code
    let code = tdir.join("code");
    if is_skill {
        ensure_dir(&layout.skills(), "code", rb)?;
        let dest = layout.skills().join(name);
        rename_retrying(&code, &dest).map_err(|e| io_err("cannot restore", &code, e))?;
        let (from, to) = (dest.clone(), code.clone());
        rb.push("code", move |_| {
            rename_retrying(&from, &to).map_err(|e| format!("{}: {e}", from.display()))
        });
    } else {
        ensure_dir(&layout.modules_dir(), "code", rb)?;
        let s = modinstall::stage(layout, &code).map_err(install_err)?;
        host.install_module(s)?;
        let aside = tdir.join("rollback-code");
        let n = name.to_string();
        rb.push("code", move |h| {
            h.remove_module(&n, &aside).map_err(|e| e.to_string())?;
            remove_dir_all_retrying(&aside).map_err(|e| format!("{}: {e}", aside.display()))
        });
    }
    fail_at("restore.code")?;
    if is_skill && !entry_first {
        // An unindexed local skill: its first entry, from the folder now in place.
        write_entry(
            layout,
            index::local_entry(layout, name, "local", false, &now),
            rb,
        )?;
    }

    // state and cache
    if let Some(rec) = &t.record {
        let mut rec = rec.clone();
        rec.removed_by_user = false;
        rec.integrity = None;
        let sha = rec.package_sha256.clone();
        let mut st = state::read(paths).map_err(state_invalid)?;
        st.items.insert(name.to_string(), rec);
        ensure_dir(&paths.root, "state", rb)?;
        let before = read_bytes(&paths.state);
        state::write(paths, &st).map_err(|e| io_err("cannot write", &paths.state, e))?;
        rb.push("state", restore_file(paths.state.clone(), before));
        fail_at("restore.state")?;

        let pkg = tdir.join("package.p1x");
        let cached = paths.cached(&sha);
        if pkg.is_file() && !cached.exists() {
            ensure_dir(&paths.cache, "cache", rb)?;
            copy_atomic(&pkg, &cached)?;
            rb.push("cache", move |_| {
                remove_retrying(&cached).map_err(|e| e.to_string())
            });
        }
    }

    // data: the purged directory back, or the (kept or new) empty one.
    let data = layout.ext_data(name);
    let moved = tdir.join("data");
    if fs::symlink_metadata(&moved).is_ok() {
        if fs::symlink_metadata(&data).is_ok() {
            // Checked empty before any write.
            state::remove_empty_dir_retrying(&data)
                .map_err(|e| io_err("cannot replace", &data, e))?;
            let d = data.clone();
            rb.push("data", move |_| {
                state::create_dir_retrying(&d).map_err(|e| format!("{}: {e}", d.display()))
            });
        }
        if let Some(parent) = data.parent() {
            ensure_dir(parent, "data", rb)?;
        }
        rename_retrying(&moved, &data).map_err(|e| io_err("cannot restore", &moved, e))?;
        let (from, to) = (data.clone(), moved.clone());
        rb.push("data", move |_| {
            rename_retrying(&from, &to).map_err(|e| format!("{}: {e}", from.display()))
        });
        fail_at("restore.data")?;
    } else {
        ensure_dir(&data, "data", rb)?;
    }

    Ok(())
}

// ---- recovery -------------------------------------------------------------------------------------------------------

/// Sets `modules.<name>` in config.json to `section` (`null`: removes it), with no host: `ext::recover` runs before
/// the supervisor serves config and while no offline command does. Unchanged config is not rewritten.
fn restore_section(layout: &Layout, name: &str, section: Value) -> Result<(), String> {
    let path = layout.config_path();
    let before = plur1bus_config::read(&path).map_err(|e| e.to_string())?;
    let after = super::commit::apply_changes(&before, &[(format!("modules.{name}"), section)])
        .map_err(|e| e.to_string())?;
    if after != before {
        plur1bus_config::write_atomic(&path, &after).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Puts a trash entry's `package.p1x` back into the cache when the cache has lost it (an uninstall killed after the
/// cache step, then undone by recover). True when the cache holds the package afterwards, or there is none to keep.
pub(crate) fn keep_cached_package(paths: &ExtPaths, entry: &Path, sha256: &str) -> bool {
    let pkg = entry.join("package.p1x");
    let cached = paths.cached(sha256);
    if !pkg.is_file() || cached.is_file() {
        return true;
    }
    fs::create_dir_all(&paths.cache).is_ok() && copy_atomic(&pkg, &cached).is_ok()
}

/// A restore a kill interrupted leaves its entry marked ([`RESTORING`]). With the item's code in place the restore is
/// finished: the record, the cached package, the data and the index entry (disabled), then the entry goes. Without
/// it the restore is undone: a module's config section goes back to what the mark recorded, a skill's index entry
/// that has no folder and no record is removed, the mark goes, and the entry keeps its code for a later restore. An
/// empty `data/ext/<name>` in the way of purged data is replaced, as the restore does. Runs under the mutation lock (skipped while a mutation runs).
pub(crate) fn reconcile_restores(layout: &Layout) -> Vec<String> {
    let mut done = Vec::new();
    let paths = ExtPaths::of(layout);
    let Ok(entries) = fs::read_dir(&paths.trash) else {
        return done;
    };
    let marked: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.join(RESTORING).is_file())
        .filter(|p| !p.to_string_lossy().contains(".tmp-"))
        .collect();
    if marked.is_empty() {
        return done;
    }
    let Ok(_guard) = super::try_mutation() else {
        return done;
    };
    for entry in marked {
        let Some(body) = read_json(&entry.join("record.json")) else {
            continue;
        };
        let record: Option<ItemRecord> = serde_json::from_value(body["record"].clone()).ok();
        let Some(name) = body["name"]
            .as_str()
            .or_else(|| record.as_ref().map(|r| r.name.as_str()))
            .filter(|n| name_ok(n))
            .map(str::to_string)
        else {
            continue;
        };
        let kind = body["kind"].as_str().unwrap_or("skill").to_string();
        if !matches!(kind.as_str(), "skill" | "module" | "channel") {
            continue;
        }
        let is_skill = kind == "skill";
        let dir = if is_skill {
            layout.skills().join(&name)
        } else {
            layout.modules_dir().join(&name)
        };
        let Ok(st) = state::read(&paths) else {
            continue;
        };
        let Ok(_lock) = lock_skills(layout) else {
            continue;
        };
        if dir.is_dir() {
            // Finish.
            let mut ok = true;
            if let Some(rec) = &record {
                if !st.items.contains_key(&name) {
                    let mut rec = rec.clone();
                    rec.removed_by_user = false;
                    rec.integrity = None;
                    let mut next = st.clone();
                    next.items.insert(name.clone(), rec);
                    ok &= state::write(&paths, &next).is_ok();
                }
                ok &= keep_cached_package(&paths, &entry, &rec.package_sha256);
            }
            let data = layout.ext_data(&name);
            let moved = entry.join("data");
            if moved.is_dir() {
                // An empty `data/ext/<name>` is replaced, as the restore itself does; one with content is not merged.
                if fs::symlink_metadata(&data).is_ok() && !data_in_the_way(layout, &name) {
                    ok &= state::remove_empty_dir_retrying(&data).is_ok();
                }
                ok &= fs::symlink_metadata(&data).is_err()
                    && data.parent().is_some_and(|p| fs::create_dir_all(p).is_ok())
                    && rename_retrying(&moved, &data).is_ok();
            } else {
                let _ = fs::create_dir_all(&data);
            }
            if is_skill {
                if let Ok(mut idx) = index::read_index(layout) {
                    if idx.entry(&name).is_none() {
                        let now = now_iso();
                        idx.upsert(match &record {
                            Some(r) => index::package_entry(r, "-", false, &now, None),
                            None => index::local_entry(layout, &name, "local", false, &now),
                        });
                        ok &= index::write_index(layout, &idx).is_ok();
                    }
                }
            }
            if ok && !entry.join("data").exists() && remove_dir_all_retrying(&entry).is_ok() {
                done.push(format!(
                    "finished the interrupted restore of {name} from {}",
                    entry.display()
                ));
            } else {
                done.push(format!(
                    "could not finish the interrupted restore of {name}; {} stays marked",
                    entry.display()
                ));
            }
        } else {
            // Undo: the code never moved in. A module's config section goes back to what the mark recorded, as the
            // restore's own rollback does.
            if !is_skill {
                let prev = read_json(&entry.join(RESTORING))
                    .and_then(|m| m.get("previousSection").cloned());
                if let Some(prev) = prev {
                    if restore_section(layout, &name, prev).is_err() {
                        done.push(format!(
                            "could not put back the config section of {name}; {} stays marked",
                            entry.display()
                        ));
                        continue;
                    }
                }
            }
            if is_skill && !st.items.contains_key(&name) {
                if let Ok(mut idx) = index::read_index(layout) {
                    if idx.remove(&name).is_some() && index::write_index(layout, &idx).is_err() {
                        continue;
                    }
                }
            }
            if remove_retrying(&entry.join(RESTORING)).is_ok() {
                done.push(format!(
                    "undid the interrupted restore of {name}; {} keeps its code",
                    entry.display()
                ));
            }
        }
    }
    done
}
