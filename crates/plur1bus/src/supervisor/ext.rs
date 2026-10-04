//! `ext.*` under the supervisor (spec §6.1, §6.3, §10.2; X1-R2, X1-R8, X1-R15, X1-R17): the handlers of the nine
//! methods, the [`SupervisorHost`] the ext layer's commit, lifecycle and trash code run with, `ext.changed` for
//! `ext.watch` subscribers, the held-back overlays of packaged modules, and the start-time recovery.
//!
//! - **The supervisor never opens package bytes.** `ext.inspect` runs `plur1bus ext __worker inspect` and the staging
//!   half of `ext.install` runs `plur1bus ext __worker stage` (`ext::worker`, 60 s and 300 s, killed on overrun). A
//!   worker that fails (a crash, a kill) is `E_INTERNAL reason=worker-failed`, and what it left is removed: a stage's
//!   `extensions/staging/<name>-<id>` (and `extensions/` when the stage created it), the inspection's
//!   `run/inspect/<id>.*` (a re-inspection is needed).
//! - **Mutations** (`install`, `uninstall`, `restore`, `enable`, `disable`) run on the connection thread and hold the
//!   ext mutation lock (X1-R15): `ext.install` takes it before the stage, so a second mutation is `E_CONFLICT busy`
//!   for the whole install. Config changes go through `config::set_removing_nulls` (its restart plan restarts or holds
//!   back modules), module work through the main thread's op queue (`ModuleVerb::Install`, `ModuleVerb::Uninstall`).
//! - **Overlays.** A packaged module (or channel) that is revoked, whose installed files no longer match the package,
//!   or whose manifest `compat` no longer fits is held back (`stopped` with reason `ext-revoked`, `ext-tampered` or
//!   `ext-incompatible`), after the `disabled` check, so its dependents are held back as `needs-unavailable`. The
//!   overlays are computed at start, after `ext::recover` (which re-hashes every enabled packaged module), and again
//!   after every ext mutation; a module whose overlay changed is reconciled.
use super::config::SetError;
use super::subscribers::Topic;
use super::{relock, ModuleVerb, OpError, Shared, DEFAULT_STOP_BUDGET};
use crate::ext::commit::{install_commit_held, Agents, InstallOpts, ModuleHost};
use crate::ext::lifecycle::{self, ToggleOpts};
use crate::ext::list::{cached_meta, list_items, show_item, ListFilter};
use crate::ext::overlays::{load_revocations, overlays_of, rehash, Overlay};
use crate::ext::paths::ExtPaths;
use crate::ext::record::StagedItem;
use crate::ext::record::{self, strings, InspectionRecord};
use crate::ext::remove::{self, RemoveOpts};
use crate::ext::{self, state, worker, ExtError};
use crate::modules::install::Staged;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Held while `ext.changed` is broadcast and while `ext.watch` lists and subscribes, so a watcher reads its reply before
/// any notification sent after the listing.
static WATCH: Mutex<()> = Mutex::new(());

/// The held-back reason of a module with overlay `o` (X1-R17); `None` for the overlays that do not hold a module back
/// (`needs-setup` refuses the enable instead; `error` is a kind this build does not know).
pub fn overlay_reason(o: Overlay) -> Option<&'static str> {
    match o {
        Overlay::Revoked => Some(super::state::STOPPED_EXT_REVOKED),
        Overlay::Tampered => Some(super::state::STOPPED_EXT_TAMPERED),
        Overlay::Incompatible => Some(super::state::STOPPED_EXT_INCOMPATIBLE),
        Overlay::NeedsSetup | Overlay::Error => None,
    }
}

// ---- the host ------------------------------------------------------------------------------------------------------

/// The [`ModuleHost`] of the supervisor: config.json through `config::set_removing_nulls` (a `null` removes the key;
/// no byte snapshot, so a rollback goes through `set_config`, carry X1-T7), modules through the main thread's op queue,
/// `ext.changed` to the `ext.watch` subscribers.
pub struct SupervisorHost<'a> {
    shared: &'a Arc<Shared>,
    layout: &'a Layout,
}

impl<'a> SupervisorHost<'a> {
    pub fn new(shared: &'a Arc<Shared>, layout: &'a Layout) -> Self {
        SupervisorHost { shared, layout }
    }
}

/// The reasons a `module.*` op can answer, as `'static` names for an [`ExtError`].
const OP_REASONS: &[&str] = &["busy", "stopping", "no-children"];

fn op_error(e: OpError) -> ExtError {
    let message = match &e.detail {
        Some(d) => format!("{}: {d}", e.message),
        None => e.message.clone(),
    };
    let reason = e
        .reason
        .as_deref()
        .and_then(|r| OP_REASONS.iter().copied().find(|x| *x == r))
        .or(if e.error == "E_INTERNAL" {
            Some("io")
        } else {
            None
        });
    ExtError {
        code: e.error,
        reason,
        message,
        data: Value::Null,
    }
}

fn set_error(e: SetError) -> ExtError {
    match e {
        SetError::Invalid(errors) => ExtError {
            code: "E_CONFIG_INVALID",
            reason: None,
            message: format!("the configuration would be invalid: {}", errors.join("; ")),
            data: Value::Null,
        },
        SetError::OpenclawStorePath(violation) => ExtError::new(
            "E_CONFIG_INVALID",
            "openclaw-store-path",
            violation.message(),
        ),
        SetError::Conflict { current } => ExtError::new(
            "E_CONFLICT",
            "config-changed",
            format!("config.json changed (revision {current}); try again"),
        ),
        SetError::Unavailable => ExtError::new(
            "E_NOT_AVAILABLE",
            "config-unavailable",
            "no valid configuration runs; fix config.json",
        ),
        SetError::Io(d) => ExtError::new("E_INTERNAL", "io", d),
    }
}

impl ModuleHost for SupervisorHost<'_> {
    fn config(&self) -> Value {
        relock(&self.shared.config)
            .running
            .clone()
            .unwrap_or(Value::Null)
    }

    fn set_config(
        &mut self,
        changes: Vec<(String, Value)>,
        dry_run: bool,
    ) -> Result<Value, ExtError> {
        let v = super::config::set_removing_nulls(self.shared, self.layout, changes, dry_run)
            .map_err(set_error)?;
        let modules = v["restart"]["modules"].clone();
        Ok(json!({
            "restart": { "modules": if modules.is_array() { modules } else { json!([]) } },
            "heldBack": []
        }))
    }

    fn install_module(&mut self, staged: Staged) -> Result<bool, ExtError> {
        let name = staged.manifest.name.clone();
        let v = super::modules::run_ext_op(
            self.shared,
            &name,
            ModuleVerb::Install(Box::new(staged)),
            DEFAULT_STOP_BUDGET,
        )
        .map_err(op_error)?;
        Ok(v["replaced"].as_bool().unwrap_or(false))
    }

    fn remove_module(&mut self, name: &str, into: &Path) -> Result<(), ExtError> {
        super::modules::run_ext_op(
            self.shared,
            name,
            ModuleVerb::Uninstall {
                into: Some(into.to_path_buf()),
            },
            DEFAULT_STOP_BUDGET,
        )
        .map(drop)
        .map_err(op_error)
    }

    fn notify(&mut self, change: Value) {
        let _one = relock(&WATCH);
        let dropped = self
            .shared
            .subscribers
            .broadcast(Topic::Ext, "ext.changed", &change);
        for d in dropped {
            self.shared.log.warn(
                "ext.changed subscriber dropped",
                json!({ "subscription": d.id, "reason": d.reason }),
            );
        }
    }

    fn via(&self) -> &'static str {
        "supervisor"
    }
}

// ---- overlays and start --------------------------------------------------------------------------------------------

/// The held-back overlay of every packaged module and channel (X1-R17): `revoked` first, then `tampered` (the record's
/// last integrity result), then `incompatible` (the cached manifest's `compat`). When `extensions/state.json` cannot be
/// read, the check fails closed (X1-C23): every module a cached package names (`extensions/cache/<sha256>.json`, kind
/// `module` or `channel`) is held back as `tampered`.
pub fn module_overlays(layout: &Layout) -> BTreeMap<String, Overlay> {
    let paths = ExtPaths::of(layout);
    let st = match state::read(&paths) {
        Ok(st) => st,
        Err(_) => {
            return cached_modules(&paths)
                .into_iter()
                .map(|n| (n, Overlay::Tampered))
                .collect()
        }
    };
    let host = ext::host::host_facts();
    let revs = load_revocations(&paths);
    let mut out = BTreeMap::new();
    for rec in st.items.values() {
        if rec.removed_by_user || !matches!(rec.kind.as_str(), "module" | "channel") {
            continue;
        }
        let compat = cached_meta(&paths, &rec.package_sha256)
            .and_then(|m| m["manifest"].get("compat").cloned());
        let found = overlays_of(rec, &host, &revs, compat.as_ref());
        let pick = [Overlay::Revoked, Overlay::Tampered, Overlay::Incompatible]
            .into_iter()
            .find(|o| found.contains(o));
        if let Some(o) = pick {
            out.insert(rec.name.clone(), o);
        }
    }
    out
}

/// The module and channel names the cached package manifests name (`extensions/cache/*.json`): which installed
/// modules came from a package when `state.json` cannot say.
fn cached_modules(paths: &ExtPaths) -> BTreeSet<String> {
    let Ok(entries) = std::fs::read_dir(&paths.cache) else {
        return BTreeSet::new();
    };
    entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|m| matches!(m["manifest"]["kind"].as_str(), Some("module" | "channel")))
        .filter_map(|m| m["manifest"]["name"].as_str().map(str::to_string))
        .collect()
}

/// At supervisor start, after `ext::recover` (which runs before config.json is loaded) and before any module starts:
/// the integrity re-hash of every enabled packaged module and channel (X1-R17, X1-C21), stored in `state.json`.
/// Returns the overlays; what was done goes to the log.
pub fn at_start(
    layout: &Layout,
    config: Option<&Value>,
    log: &super::Log,
) -> BTreeMap<String, Overlay> {
    let paths = ExtPaths::of(layout);
    match state::read(&paths) {
        Ok(mut st) => {
            let modules = config.map(|c| c["modules"].clone()).unwrap_or(Value::Null);
            let mut changed = Vec::new();
            for rec in st.items.values_mut() {
                let packaged_module =
                    !rec.removed_by_user && matches!(rec.kind.as_str(), "module" | "channel");
                if !packaged_module || !crate::modules::enabled(&modules, &rec.name) {
                    continue;
                }
                let integrity = rehash(layout, rec);
                if !integrity.ok {
                    log.warn(
                        "installed files of a packaged module no longer match its package",
                        json!({ "module": rec.name, "paths": integrity.paths }),
                    );
                }
                rec.integrity = Some(integrity);
                changed.push(rec.name.clone());
            }
            if !changed.is_empty() {
                if let Err(e) = state::write(&paths, &st) {
                    log.warn(
                        "cannot record the integrity of the packaged modules",
                        json!({ "err": e.to_string(), "modules": changed }),
                    );
                }
            }
        }
        Err(e) => log.warn(
            "extensions/state.json is unreadable; every module a cached package names is held back as ext-tampered",
            json!({ "err": e }),
        ),
    }
    let overlays = module_overlays(layout);
    for (name, o) in &overlays {
        log.info(
            "packaged module held back",
            json!({ "module": name, "reason": overlay_reason(*o) }),
        );
    }
    overlays
}

/// After an ext mutation, while its caller still holds the mutation lock (so no later mutation's overlays can be
/// overwritten by these): the overlays again; a module whose overlay changed is reconciled (held back, or released
/// and started when it may run).
fn refresh_overlays(shared: &Shared, layout: &Layout, _held: &ext::MutationGuard) {
    let now = module_overlays(layout);
    let changed: BTreeSet<String> = {
        let mut st = shared.lock();
        let before = std::mem::replace(&mut st.ext_overlays, now.clone());
        before
            .keys()
            .chain(now.keys())
            .filter(|n| before.get(*n) != now.get(*n))
            .cloned()
            .collect()
    };
    if !changed.is_empty() {
        let plan = plur1bus_config::Restart {
            modules: changed.into_iter().collect(),
            ..Default::default()
        };
        drop(super::push_restart(shared, plan));
    }
}

// ---- the handlers --------------------------------------------------------------------------------------------------

/// `ExtInspection` from a stored inspection record: exactly the schema's closed keys (X1-C7: `sourcePath` and
/// `normalised` are dropped).
pub fn inspection_result(rec: &InspectionRecord) -> Value {
    let mut v = json!({
        "inspectionId": rec.inspection_id,
        "expiresAt": rec.expires_at,
        "sha256": rec.sha256,
        "manifest": rec.manifest,
        "trust": rec.trust,
        "checks": rec.checks,
        "capabilities": rec.capabilities,
        "scripts": rec.scripts,
        "requires": rec.requires,
    });
    if let Some(r) = &rec.replaces {
        v["replaces"] = json!({
            "version": r["version"],
            "capabilityDiff": { "changed": r["capabilityDiff"]["changed"] },
        });
    }
    v
}

/// What an ext refusal shows in `error.data.ext`: its data, with a stored inspection record (an install's
/// `acknowledge-*`) narrowed to `ExtInspection` plus `authority` and `previousCapabilities`.
pub fn error_data(data: &Value) -> Option<Value> {
    let obj = data.as_object().filter(|o| !o.is_empty())?;
    if obj.contains_key("inspectionId") {
        if let Ok(rec) = serde_json::from_value::<InspectionRecord>(data.clone()) {
            let mut v = inspection_result(&rec);
            for k in ["authority", "previousCapabilities"] {
                if let Some(x) = obj.get(k) {
                    v[k] = x.clone();
                }
            }
            return Some(v);
        }
    }
    Some(data.clone())
}

fn invalid(message: impl Into<String>) -> ExtError {
    ExtError {
        code: "E_INVALID_PARAMS",
        reason: None,
        message: message.into(),
        data: Value::Null,
    }
}

/// `ExtAgents`: `"all"` or a list of agent ids; absent → `None`.
fn agents(v: Option<&Value>) -> Result<Option<Agents>, ExtError> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s == "all" => Ok(Some(Agents::All)),
        Some(Value::Array(a)) if a.iter().all(Value::is_string) => {
            Ok(Some(Agents::Some(strings(&Value::Array(a.clone())))))
        }
        Some(_) => Err(invalid("agents must be \"all\" or a list of agent ids")),
    }
}

/// Removes what a failed worker left of inspection `id`: its files in `run/inspect/` (the spool, the record, a temp
/// file) and its staging directory `extensions/staging/<name>-<id>`, then `extensions/staging/` when empty and
/// `extensions/` when it did not exist before the stage and is empty (carry X1-T6/T11: no half-written staging).
fn clean_after_worker(layout: &Layout, id: &str, root_existed: bool) {
    if !record::valid_id(id) {
        return;
    }
    let p = ExtPaths::of(layout);
    if let Ok(entries) = std::fs::read_dir(&p.staging) {
        let suffix = format!("-{id}");
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().ends_with(&suffix) {
                let path = e.path();
                let _ = match std::fs::symlink_metadata(&path) {
                    Ok(m) if m.is_dir() => state::remove_dir_all_retrying(&path),
                    _ => state::remove_retrying(&path),
                };
            }
        }
    }
    let _ = std::fs::remove_dir(&p.staging);
    if !root_existed {
        let _ = std::fs::remove_dir(&p.root);
    }
    if let Ok(entries) = std::fs::read_dir(&p.inspect) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with(id) {
                let _ = state::remove_retrying(&e.path());
            }
        }
    }
}

/// `ext.inspect { source: { path } }`: the worker inspects; the answer is the stored record as `ExtInspection`. The
/// path must be absolute (a relative one would resolve against the supervisor's working directory, not the caller's);
/// it reaches the worker as `--path=<p>`, so a path that starts with `-` is never read as a flag.
pub fn inspect(layout: &Layout, params: &Value) -> Result<Value, ExtError> {
    let path = params["source"]["path"].as_str().unwrap_or_default();
    if !Path::new(path).is_absolute() {
        return Err(invalid(format!(
            "source.path must be an absolute path, got {path:?}"
        )));
    }
    let id = worker::new_inspection_id();
    let path_arg = format!("--path={path}");
    let seam = worker::seam_args("inspect");
    let mut args = vec!["inspect", "--id", &id, path_arg.as_str()];
    args.extend(seam.iter().map(String::as_str));
    match worker::spawn_worker(
        layout,
        &args,
        worker::deadline("inspect", worker::INSPECT_DEADLINE),
    ) {
        Ok(v) => {
            let rec: InspectionRecord = serde_json::from_value(v).map_err(|e| {
                clean_after_worker(layout, &id, true);
                ExtError::new(
                    "E_INTERNAL",
                    "worker-failed",
                    format!("the ext worker answered an unreadable inspection: {e}"),
                )
            })?;
            Ok(inspection_result(&rec))
        }
        Err(e) => {
            if worker::is_worker_failure(&e) {
                clean_after_worker(layout, &id, true);
            }
            Err(e)
        }
    }
}

/// The stage half of `ext.install`, under the caller's mutation lock: the worker stages inspection `rec`. Only the
/// staged item's name, kind and record are taken from its answer; the commit checks its paths against the ones derived
/// from the inspection (worker-failed otherwise).
fn stage(layout: &Layout, id: &str) -> Result<StagedItem, ExtError> {
    let root_existed = ExtPaths::of(layout).root.exists();
    let seam = worker::seam_args("stage");
    let mut args = vec!["stage", "--id", id];
    args.extend(seam.iter().map(String::as_str));
    let staged = worker::spawn_worker(
        layout,
        &args,
        worker::deadline("stage", worker::STAGE_DEADLINE),
    )
    .and_then(|v| {
        serde_json::from_value::<StagedItem>(v).map_err(|e| {
            ExtError::new(
                "E_INTERNAL",
                "worker-failed",
                format!("the ext worker answered an unreadable staged item: {e}"),
            )
        })
    });
    if let Err(e) = &staged {
        if worker::is_worker_failure(e) {
            clean_after_worker(layout, id, root_existed);
        }
    }
    staged
}

/// `ext.install { inspectionId, acknowledge?, enable? }`: under the mutation lock, the worker stages the inspected
/// package, then the commit puts it in place with a [`SupervisorHost`], and the overlays are refreshed.
pub fn install(shared: &Arc<Shared>, layout: &Layout, params: &Value) -> Result<Value, ExtError> {
    let opts = InstallOpts {
        acknowledge: strings(&params["acknowledge"]),
        enable: match params.get("enable") {
            None => None,
            Some(e) => Some(agents(e.get("agents"))?.unwrap_or(Agents::All)),
        },
    };
    let id = params["inspectionId"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let guard = ext::try_mutation()?;
    let result = record::load(layout, &id).and_then(|rec| {
        let staged = stage(layout, &id)?;
        let mut host = SupervisorHost::new(shared, layout);
        install_commit_held(layout, &mut host, &rec, staged, &opts, &guard)
    });
    refresh_overlays(shared, layout, &guard);
    result
}

fn toggle_opts(params: &Value) -> Result<ToggleOpts, ExtError> {
    Ok(ToggleOpts {
        agents: agents(params.get("agents"))?,
        acknowledge: strings(&params["acknowledge"]),
        dry_run: params["dryRun"].as_bool().unwrap_or(false),
    })
}

/// `ext.enable` (`on`) or `ext.disable`: a dry run takes no lock and refreshes nothing; otherwise under the mutation
/// lock, with the overlays refreshed before it is released.
fn toggle(
    shared: &Arc<Shared>,
    layout: &Layout,
    params: &Value,
    on: bool,
) -> Result<Value, ExtError> {
    let o = toggle_opts(params)?;
    let name = params["name"].as_str().unwrap_or_default();
    let mut host = SupervisorHost::new(shared, layout);
    if o.dry_run {
        return if on {
            lifecycle::enable(layout, &mut host, name, &o)
        } else {
            lifecycle::disable(layout, &mut host, name, &o)
        };
    }
    let guard = ext::try_mutation()?;
    let r = lifecycle::toggle_held(layout, &mut host, name, &o, on, &guard);
    refresh_overlays(shared, layout, &guard);
    r
}

/// `ext.enable { name, agents?, acknowledge?, dryRun? }`.
pub fn enable(shared: &Arc<Shared>, layout: &Layout, params: &Value) -> Result<Value, ExtError> {
    toggle(shared, layout, params, true)
}

/// `ext.disable { name, agents?, dryRun? }` (a disable holds the enabled modules that need it back).
pub fn disable(shared: &Arc<Shared>, layout: &Layout, params: &Value) -> Result<Value, ExtError> {
    toggle(shared, layout, params, false)
}

/// `ext.uninstall { name, purge?, cascade? }`.
pub fn uninstall(shared: &Arc<Shared>, layout: &Layout, params: &Value) -> Result<Value, ExtError> {
    let o = RemoveOpts {
        purge: params["purge"].as_bool().unwrap_or(false),
        cascade: params["cascade"].as_bool().unwrap_or(false),
    };
    let name = params["name"].as_str().unwrap_or_default();
    let guard = ext::try_mutation()?;
    let r = remove::uninstall_held(
        layout,
        &mut SupervisorHost::new(shared, layout),
        name,
        &o,
        &guard,
    );
    refresh_overlays(shared, layout, &guard);
    r
}

/// `ext.restore { trashId }`.
pub fn restore(shared: &Arc<Shared>, layout: &Layout, params: &Value) -> Result<Value, ExtError> {
    let tid = params["trashId"].as_str().unwrap_or_default();
    let guard = ext::try_mutation()?;
    let r = remove::restore_held(
        layout,
        &mut SupervisorHost::new(shared, layout),
        tid,
        &guard,
    );
    refresh_overlays(shared, layout, &guard);
    r
}

fn running_config(shared: &Shared) -> Value {
    relock(&shared.config)
        .running
        .clone()
        .unwrap_or(Value::Null)
}

/// `ext.list { kind?, state?, agent? }`.
pub fn list(shared: &Shared, layout: &Layout, params: &Value) -> Result<Value, ExtError> {
    let filter = ListFilter {
        kind: params.get("kind").map(strings),
        state: params.get("state").map(strings),
        agent: params["agent"].as_str().map(str::to_string),
    };
    list_items(layout, &running_config(shared), &filter)
}

/// `ext.show { name }` (never writes, X1-C13).
pub fn show(shared: &Shared, layout: &Layout, params: &Value) -> Result<Value, ExtError> {
    let name = params["name"].as_str().unwrap_or_default();
    show_item(layout, &running_config(shared), name)
}

/// `ext.watch`: under the watch lock, `subscribe(items)` subscribes the connection and queues its reply, so no
/// `ext.changed` sent after the listing can overtake it. An unreadable `extensions/state.json` subscribes nothing
/// (`E_STORAGE state-invalid`, X1-C29).
pub fn watch<T>(
    shared: &Shared,
    layout: &Layout,
    subscribe: impl FnOnce(Value) -> T,
) -> Result<T, ExtError> {
    let _one = relock(&WATCH);
    let items =
        list_items(layout, &running_config(shared), &ListFilter::default())?["items"].clone();
    Ok(subscribe(items))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validator(pointer: &str) -> jsonschema::Validator {
        let schema: Value = serde_json::from_str(plur1bus_rpc::SCHEMA_JSON).unwrap();
        let doc = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$ref": format!("#/$defs/{pointer}"),
            "$defs": schema["$defs"],
        });
        jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .build(&doc)
            .unwrap()
    }

    fn record(replaces: Option<Value>) -> InspectionRecord {
        InspectionRecord {
            inspection_id: "0b9e4c1e-7a6b-4d1c-9a3e-2f1d7c8b9a01".into(),
            expires_at: "2026-09-28T10:10:00.000Z".into(),
            sha256: "a".repeat(64),
            source_path: Some("/tmp/p1x A/fixture.p1x".into()),
            normalised: true,
            manifest: json!({ "id": "demo/fixture", "name": "fixture" }),
            trust: json!({ "tier": "unsigned" }),
            checks: json!([{ "id": "signature", "status": "warn", "detail": "unsigned" }]),
            capabilities: json!({ "network": { "mode": "none" } }),
            scripts: json!([{ "path": "payload/run.sh", "size": 3 }]),
            requires: json!({}),
            replaces,
        }
    }

    #[test]
    fn an_inspection_answers_the_closed_ext_inspection_shape() {
        let v = validator("ExtInspection");
        for replaces in [
            None,
            Some(
                json!({ "version": "0.9.0", "capabilityDiff": { "changed": ["network"], "extra": 1 }, "more": 2 }),
            ),
        ] {
            let out = inspection_result(&record(replaces.clone()));
            let errors: Vec<String> = v.iter_errors(&out).map(|e| e.to_string()).collect();
            assert!(errors.is_empty(), "{errors:?} in {out}");
            for k in ["sourcePath", "normalised"] {
                assert!(out.get(k).is_none(), "{k} leaked: {out}");
            }
            assert_eq!(out.get("replaces").is_some(), replaces.is_some());
        }
    }

    #[test]
    fn an_install_refusal_shows_the_inspection_narrowed() {
        let mut data = serde_json::to_value(record(None)).unwrap();
        data["authority"] = json!("full");
        let out = error_data(&data).unwrap();
        assert!(out.get("sourcePath").is_none() && out.get("normalised").is_none());
        assert_eq!(out["authority"], "full");
        assert_eq!(out["inspectionId"], data["inspectionId"]);
        assert_eq!(
            error_data(&json!({ "dependents": ["fixture-b"] })).unwrap()["dependents"][0],
            "fixture-b"
        );
        assert!(error_data(&Value::Null).is_none() && error_data(&json!({})).is_none());
    }

    #[test]
    fn the_overlays_that_hold_a_module_back_have_their_own_reasons() {
        assert_eq!(overlay_reason(Overlay::Revoked), Some("ext-revoked"));
        assert_eq!(overlay_reason(Overlay::Tampered), Some("ext-tampered"));
        assert_eq!(
            overlay_reason(Overlay::Incompatible),
            Some("ext-incompatible")
        );
        assert_eq!(overlay_reason(Overlay::NeedsSetup), None);
        assert_eq!(overlay_reason(Overlay::Error), None);
    }
}
