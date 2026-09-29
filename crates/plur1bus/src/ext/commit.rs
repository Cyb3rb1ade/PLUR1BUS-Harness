//! The commit half of `ext.install` (spec §6.1, §8.3, §9.2; X1-R13, R14, R15, R19, R29, R31, R32; Review Focus 1, 3, 5).
//!
//! [`install_commit`] takes a staged package (Task 6) and puts it in place in the order of [`COMMIT_STEPS`]; every step
//! registers how to undo itself before the next one runs, and a failure at any step undoes the steps done so far in
//! reverse, so `skills/`, `modules/`, `extensions/` and `config.json` end as they were (acceptance 2). Before any
//! write it re-checks what the inspection checked against the current state (the inspection can be ten minutes old):
//! the name, a module's socket address, the revocation list and `extensions.allowUnsigned`; then the
//! acknowledgments. The staging directory it was handed is removed whichever way it ends.
//!
//! Supervisor-safe (X1-R2): nothing here opens package bytes; the package is copied into the cache as an opaque file.
//! Config and module work go through a [`ModuleHost`], so the same code runs in the supervisor (Task 11) and in the
//! offline CLI ([`OfflineHost`]).
use super::index::{self, lock_skills, ImportLock};
use super::inspect::{self, InspectionRecord};
use super::overlays::{load_revocations, overlays_of, revoked};
use super::paths::ExtPaths;
use super::stage::StagedItem;
use super::state::{self, remove_retrying, rename_retrying, write_private_atomic, ItemRecord};
use super::{now_iso, ExtError};
use crate::modules::install as modinstall;
use crate::paths::Layout;
use plur1bus_ext::manifest::Kind;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

/// The commit steps in order; `PLUR1BUS_TEST_EXT_FAIL_AT=<step>` fails the named one after its own writes, so its undo
/// runs too (test internals only).
pub const COMMIT_STEPS: [&str; 6] = ["config", "code", "state", "cache", "index", "enable"];

/// What an ext mutation needs from whoever owns config.json and the module processes: the supervisor (Task 11) or the
/// offline CLI ([`OfflineHost`]).
pub trait ModuleHost {
    /// The running `config.json` (defaults filled).
    fn config(&self) -> Value;
    /// Applies `changes` as one `config.set` (all or none). A `null` value removes the key (how a rollback restores a
    /// value that was absent). Returns `{restart: {modules}, heldBack}`.
    fn set_config(
        &mut self,
        changes: Vec<(String, Value)>,
        dry_run: bool,
    ) -> Result<Value, ExtError>;
    /// Puts a staged module in place (`modules::install::commit`); true when one was replaced.
    fn install_module(&mut self, staged: modinstall::Staged) -> Result<bool, ExtError>;
    /// Stops the module, then moves `modules/<name>` to `into` (`modules::install::remove_to`).
    fn remove_module(&mut self, name: &str, into: &Path) -> Result<(), ExtError>;
    /// `ext.changed` params, for `ext.watch` subscribers.
    fn notify(&mut self, change: Value);
    /// `"supervisor"` or `"offline"` (the audit line's `detail.via`, X1-R32).
    fn via(&self) -> &'static str;
}

/// The agents an enable applies to (X1-R11).
#[derive(Clone, Debug, PartialEq)]
pub enum Agents {
    All,
    Some(Vec<String>),
}

/// `ext.install`'s options: the acknowledgments given (`unsigned`, `unknown-signer`, `downgrade`, `capabilities`) and
/// whether to enable right after the install.
#[derive(Clone, Debug, Default)]
pub struct InstallOpts {
    pub acknowledge: Vec<String>,
    pub enable: Option<Agents>,
}

fn io_err(what: &str, path: &Path, e: impl std::fmt::Display) -> ExtError {
    ExtError::new(
        "E_INTERNAL",
        "io",
        format!("{what} {}: {e}", path.display()),
    )
}

fn install_err(e: modinstall::InstallError) -> ExtError {
    let code = if e.is_io() {
        "E_INTERNAL"
    } else {
        "E_INVALID_PARAMS"
    };
    ExtError::new(code, e.reason(), e.to_string())
}

fn allow_internals() -> bool {
    std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Ok("1")
}

/// The test seam `PLUR1BUS_TEST_EXT_FAIL_AT=<step>` (global constraints).
fn fail_at(step: &str) -> Result<(), ExtError> {
    if allow_internals() && std::env::var("PLUR1BUS_TEST_EXT_FAIL_AT").as_deref() == Ok(step) {
        return Err(ExtError::new(
            "E_INTERNAL",
            "io",
            format!("test seam: the {step} step failed"),
        ));
    }
    Ok(())
}

/// SHA-256 (hex) of a capability block as serialised with sorted keys: what `capabilitiesAck` records (X1-R13).
pub fn capabilities_hash(caps: &Value) -> String {
    let text = serde_json::to_string(caps).unwrap_or_default();
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

type Undo<'a> = Box<dyn FnOnce(&mut dyn ModuleHost) -> Result<(), String> + 'a>;

/// The undo actions of the steps done so far, run in reverse on failure.
#[derive(Default)]
struct Rollback<'a> {
    undos: Vec<(&'static str, Undo<'a>)>,
}

impl<'a> Rollback<'a> {
    fn push(
        &mut self,
        step: &'static str,
        f: impl FnOnce(&mut dyn ModuleHost) -> Result<(), String> + 'a,
    ) {
        self.undos.push((step, Box::new(f)));
    }

    /// Runs every undo, last first; returns the ones that failed.
    fn run(self, host: &mut dyn ModuleHost) -> Vec<String> {
        let mut failed = Vec::new();
        for (step, undo) in self.undos.into_iter().rev() {
            if let Err(e) = undo(host) {
                failed.push(format!("undo {step}: {e}"));
            }
        }
        failed
    }
}

/// Creates `dir` and its missing ancestors, and registers their removal (only while empty) for the rollback.
fn ensure_dir(dir: &Path, step: &'static str, rb: &mut Rollback<'_>) -> Result<(), ExtError> {
    let mut missing = Vec::new();
    let mut at = Some(dir);
    while let Some(p) = at {
        if fs::symlink_metadata(p).is_ok() {
            break;
        }
        missing.push(p.to_path_buf());
        at = p.parent();
    }
    if missing.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(dir).map_err(|e| io_err("cannot create", dir, e))?;
    rb.push(step, move |_| {
        // Deepest first; `remove_dir` only removes an empty directory.
        for d in &missing {
            let _ = fs::remove_dir(d);
        }
        Ok(())
    });
    Ok(())
}

fn read_bytes(p: &Path) -> Option<Vec<u8>> {
    fs::read(p).ok()
}

/// Puts a file back as it was: the saved bytes, or no file.
fn restore_file(
    path: PathBuf,
    before: Option<Vec<u8>>,
) -> impl FnOnce(&mut dyn ModuleHost) -> Result<(), String> {
    move |_| match before {
        Some(b) => write_private_atomic(&path, &b).map_err(|e| format!("{}: {e}", path.display())),
        None => remove_retrying(&path).map_err(|e| format!("{}: {e}", path.display())),
    }
}

/// Copies `from` to `to` through `<to>.tmp-<pid>` and a rename.
fn copy_atomic(from: &Path, to: &Path) -> Result<(), ExtError> {
    let mut name = to.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".tmp-{}", std::process::id()));
    let tmp = to.with_file_name(name);
    let res = fs::copy(from, &tmp)
        .and_then(|_| fs::File::open(&tmp)?.sync_all())
        .and_then(|_| rename_retrying(&tmp, to));
    if let Err(e) = res {
        let _ = fs::remove_file(&tmp);
        return Err(io_err("cannot copy the package to", to, e));
    }
    Ok(())
}

fn kind_str(k: Kind) -> &'static str {
    inspect::kind_name(k)
}

/// X1-R29 again, against the state now: the same name under another id or kind is taken, whether the installed item
/// has a record or is a bare skill folder or module directory.
fn check_name(
    layout: &Layout,
    st: &state::ExtState,
    name: &str,
    id: &str,
    kind: &str,
) -> Result<(), ExtError> {
    let taken = |kind: &str, id: Option<&str>| {
        let by = match id {
            Some(id) => format!("the installed {kind} {id}"),
            None => format!("an installed {kind}"),
        };
        ExtError::new(
            "E_CONFLICT",
            "name-taken",
            format!("the name {name} is taken by {by}; uninstall it first"),
        )
        .with_data(json!({ "name": name, "installedKind": kind, "installedId": id }))
    };
    if let Some(rec) = st.items.get(name) {
        if rec.id != id || rec.kind != kind {
            return Err(taken(&rec.kind, Some(&rec.id)));
        }
        return Ok(());
    }
    if fs::symlink_metadata(layout.skills().join(name)).is_ok() {
        return Err(taken("skill", None));
    }
    let module = layout.modules_dir().join(name);
    if fs::symlink_metadata(&module).is_ok() {
        let k = fs::read_to_string(module.join("module.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v["kind"].as_str().map(str::to_string))
            .unwrap_or_else(|| "module".into());
        return Err(taken(&k, None));
    }
    Ok(())
}

/// The re-checks at commit time (the inspection can be up to ten minutes old).
fn recheck(
    layout: &Layout,
    paths: &ExtPaths,
    st: &state::ExtState,
    staged: &StagedItem,
    cfg: &Value,
) -> Result<(), ExtError> {
    let r = &staged.record;
    check_name(layout, st, &r.name, &r.id, kind_str(staged.kind))?;
    if matches!(staged.kind, Kind::Module | Kind::Channel) {
        modinstall::check_socket_fits(layout, &r.name).map_err(|e| {
            ExtError::new("E_INVALID_PARAMS", "socket-path-too-long", e.to_string())
        })?;
    }
    if let Some(why) = revoked(&load_revocations(paths), &r.id, &r.version) {
        return Err(ExtError::new(
            "E_DENIED",
            "revoked",
            format!("{} {} is revoked: {why}", r.id, r.version),
        ));
    }
    if cfg["extensions"]["allowUnsigned"] == false && r.trust != "first-party" {
        return Err(ExtError::new(
            "E_DENIED",
            "policy-unsigned-disallowed",
            format!(
                "{} {} is not signed by a trusted key, and extensions.allowUnsigned is false",
                r.id, r.version
            ),
        ));
    }
    Ok(())
}

fn lower(new: &str, old: &str) -> bool {
    match (semver::Version::parse(new), semver::Version::parse(old)) {
        (Ok(n), Ok(o)) => n < o,
        _ => false,
    }
}

/// The acknowledgments this install needs (X1-R13, X1-R29): `unsigned` or `unknown-signer` by tier, `downgrade` for a
/// lower version of the installed id, `capabilities` with `enable`. The first missing one is `E_APPROVAL_REQUIRED
/// acknowledge-<x>` with the inspection in `data` (plus `authority` for the capability disclosure). Returns the
/// acknowledgments given, deduplicated, for the audit line.
fn acknowledgments(
    rec: &InspectionRecord,
    staged: &StagedItem,
    prev: Option<&ItemRecord>,
    opts: &InstallOpts,
) -> Result<Vec<String>, ExtError> {
    let r = &staged.record;
    let mut needed: Vec<&'static str> = Vec::new();
    match r.trust.as_str() {
        "unsigned" => needed.push("unsigned"),
        "unknown-signer" => needed.push("unknown-signer"),
        _ => {}
    }
    if prev.is_some_and(|p| p.id == r.id && lower(&r.version, &p.version)) {
        needed.push("downgrade");
    }
    if opts.enable.is_some() {
        needed.push("capabilities");
    }
    let given = |a: &str| opts.acknowledge.iter().any(|x| x == a);
    if let Some(missing) = needed.into_iter().find(|a| !given(a)) {
        let mut data = serde_json::to_value(rec).unwrap_or(Value::Null);
        if missing == "capabilities" {
            let authority = if matches!(staged.kind, Kind::Module | Kind::Channel) {
                json!("full")
            } else {
                r.capabilities["harness"]["authority"].clone()
            };
            data["authority"] = authority;
        }
        let (reason, what) = match missing {
            "unsigned" => ("acknowledge-unsigned", "the package is not signed"),
            "unknown-signer" => (
                "acknowledge-unknown-signer",
                "the package is signed by a key this harness does not trust",
            ),
            "downgrade" => (
                "acknowledge-downgrade",
                "the package is a lower version than the installed one",
            ),
            _ => (
                "acknowledge-capabilities",
                "enabling lets the extension use the capabilities it declares",
            ),
        };
        return Err(ExtError::new(
            "E_APPROVAL_REQUIRED",
            reason,
            format!("{what}; acknowledge {missing:?} to go ahead"),
        )
        .with_data(data));
    }
    let mut out: Vec<String> = Vec::new();
    for a in &opts.acknowledge {
        if !out.contains(a) {
            out.push(a.clone());
        }
    }
    Ok(out)
}

/// The enable pre-checks that must refuse before any write: agents on a module, an unknown agent, a required secret
/// slot (X1-R9: `needs-setup` until the secret store lands).
fn enable_prechecks(staged: &StagedItem, cfg: &Value, agents: &Agents) -> Result<(), ExtError> {
    let is_skill = staged.kind == Kind::Skill;
    if let Agents::Some(list) = agents {
        if !is_skill {
            return Err(ExtError::new(
                "E_INVALID_PARAMS",
                "agents-not-supported",
                format!(
                    "{} is a {}; modules.{}.enabled is its only switch",
                    staged.name,
                    kind_str(staged.kind),
                    staged.name
                ),
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
    }
    if !staged.record.required_secrets.is_empty() {
        return Err(ExtError::new(
            "E_NOT_AVAILABLE",
            "needs-setup",
            format!(
                "{} needs secrets ({}) that cannot be set up yet; it installs, but cannot be enabled",
                staged.name,
                staged.record.required_secrets.join(", ")
            ),
        ));
    }
    Ok(())
}

/// Whether an installed item is enabled now: a skill's index entry (an unindexed folder counts as enabled, X1-R12), a
/// module's `modules.<name>.enabled` (absent means enabled) while its directory exists.
pub(crate) fn enabled_now(layout: &Layout, cfg: &Value, name: &str, kind: &str) -> bool {
    if kind == "skill" {
        match index::read_index(layout)
            .ok()
            .and_then(|i| i.entry(name).cloned())
        {
            Some(e) => e["enabled"] == true,
            None => layout.skills().join(name).is_dir(),
        }
    } else {
        modinstall::installed_dir(layout, name).is_some()
            && cfg["modules"][name]["enabled"] != false
    }
}

fn trash_stamp(iso: &str) -> String {
    // `YYYY-MM-DDTHH:MM:SS.mmmZ` → `YYYYMMDDTHHMMSSZ`.
    let digits: String = iso
        .chars()
        .take(19)
        .filter(|c| c.is_ascii_digit() || *c == 'T')
        .collect();
    format!("{digits}Z")
}

/// A fresh `extensions/trash/<name>-<version>-<YYYYMMDDTHHMMSSZ>` (X1-R19); a second one in the same second gets `-2`,
/// `-3`, …
fn trash_id(paths: &ExtPaths, name: &str, version: &str, at: &str) -> String {
    let base = format!("{name}-{version}-{}", trash_stamp(at));
    let mut id = base.clone();
    let mut n = 2;
    while fs::symlink_metadata(paths.trash.join(&id)).is_ok() {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

/// Installs a staged package (see the module documentation). Result: `{name, version, kind, replaced, state}`.
pub fn install_commit(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    rec: &InspectionRecord,
    staged: StagedItem,
    opts: &InstallOpts,
) -> Result<Value, ExtError> {
    let paths = ExtPaths::of(layout);
    let staging_dir = staged
        .dir
        .parent()
        .filter(|d| d.starts_with(&paths.staging))
        .map(Path::to_path_buf);
    let result = match super::try_mutation() {
        Ok(_guard) => commit_locked(layout, &paths, host, rec, staged, opts),
        Err(e) => Err(e),
    };
    // The staging directory is spent whichever way it went (a refusal must leave `extensions/` as it was).
    if let Some(d) = staging_dir {
        let _ = fs::remove_dir_all(&d);
        let _ = fs::remove_dir(&paths.staging);
        let _ = fs::remove_dir(&paths.root);
    }
    if result.is_ok() && inspect::valid_id(&rec.inspection_id) {
        // The inspection is consumed.
        let _ = remove_retrying(&paths.inspect.join(format!("{}.json", rec.inspection_id)));
        let _ = remove_retrying(&inspect::spool_path(layout, &rec.inspection_id));
    }
    result
}

fn commit_locked(
    layout: &Layout,
    paths: &ExtPaths,
    host: &mut dyn ModuleHost,
    rec: &InspectionRecord,
    staged: StagedItem,
    opts: &InstallOpts,
) -> Result<Value, ExtError> {
    if !matches!(staged.kind, Kind::Skill | Kind::Module | Kind::Channel) {
        return Err(ExtError::new(
            "E_NOT_AVAILABLE",
            "kind-unsupported",
            format!("{} packages arrive in X2", kind_str(staged.kind)),
        ));
    }
    if staged.record.package_sha256 != rec.sha256 || rec.manifest["name"] != staged.name.as_str() {
        return Err(ExtError::new(
            "E_INTERNAL",
            "worker-failed",
            "the staged item does not belong to this inspection",
        ));
    }
    let name = staged.name.clone();
    let kind = kind_str(staged.kind);
    let st = state::read(paths).map_err(|e| ExtError::new("E_STORAGE", "state-invalid", e))?;
    let prev = st.items.get(&name).cloned();
    let cfg = host.config();

    // Review Focus 5: the identical package again is a no-op that writes nothing.
    if let Some(p) = prev
        .as_ref()
        .filter(|p| p.id == staged.record.id && p.package_sha256 == rec.sha256)
    {
        let state = if enabled_now(layout, &cfg, &name, kind) {
            "enabled"
        } else {
            "installed"
        };
        return Ok(json!({
            "name": name, "version": p.version, "kind": kind, "replaced": false, "state": state
        }));
    }

    recheck(layout, paths, &st, &staged, &cfg)?;
    let acknowledged = acknowledgments(rec, &staged, prev.as_ref(), opts)?;
    if let Some(agents) = &opts.enable {
        enable_prechecks(&staged, &cfg, agents)?;
    }
    // Review Focus 1: the importer's lock before any write, held to the end.
    let _lock: Option<ImportLock> = if staged.kind == Kind::Skill {
        Some(lock_skills(layout)?)
    } else {
        None
    };

    let mut rb = Rollback::default();
    let done = run_steps(
        layout,
        paths,
        host,
        rec,
        &staged,
        prev.as_ref(),
        &st,
        &cfg,
        opts,
        &mut rb,
    );
    let (record, state_name) = match done {
        Ok(x) => x,
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
    let replaced = prev.is_some();

    let detail = json!({
        "id": record.id, "version": record.version, "kind": kind, "sha256": record.package_sha256,
        "trust": record.trust, "keyId": record.key_id, "acknowledged": acknowledged, "replaced": replaced,
        "via": host.via(),
    });
    if let Err(e) = crate::audit::append(layout, "ext.install", &name, detail) {
        eprintln!("plur1bus: warning: cannot write the audit line for ext.install {name}: {e}");
    }
    let overlays = overlays_of(
        &record,
        &super::host::host_facts(),
        &load_revocations(paths),
        rec.manifest.get("compat"),
    );
    host.notify(json!({
        "name": name, "kind": kind, "state": state_name, "version": record.version, "overlays": overlays
    }));
    Ok(json!({
        "name": name, "version": record.version, "kind": kind, "replaced": replaced, "state": state_name
    }))
}

/// The steps of [`COMMIT_STEPS`], each registering its undo in `rb`. Returns the written record and the final state.
#[allow(clippy::too_many_arguments)]
fn run_steps<'a>(
    layout: &'a Layout,
    paths: &ExtPaths,
    host: &mut dyn ModuleHost,
    rec: &InspectionRecord,
    staged: &StagedItem,
    prev: Option<&ItemRecord>,
    st: &state::ExtState,
    cfg: &Value,
    opts: &InstallOpts,
    rb: &mut Rollback<'a>,
) -> Result<(ItemRecord, &'static str), ExtError> {
    let name = staged.name.clone();
    let is_skill = staged.kind == Kind::Skill;
    let now = now_iso();

    // config: a module is installed disabled; the previous `modules.<name>` section comes back exactly on rollback.
    if !is_skill {
        let section = cfg["modules"].get(&name).cloned().unwrap_or(Value::Null);
        if section.get("enabled") != Some(&json!(false)) {
            host.set_config(
                vec![(format!("modules.{name}.enabled"), json!(false))],
                false,
            )?;
            let key = format!("modules.{name}");
            rb.push("config", move |h| {
                h.set_config(vec![(key, section)], false)
                    .map(drop)
                    .map_err(|e| e.to_string())
            });
        }
        fail_at("config")?;
    }

    // code: a replaced item's code goes into the trash first (X1-R19), then the new code into place.
    if let Some(old) = prev {
        let tid = trash_id(paths, &name, &old.version, &now);
        let tdir = paths.trash.join(&tid);
        ensure_dir(&paths.trash, "code", rb)?;
        fs::create_dir(&tdir).map_err(|e| io_err("cannot create", &tdir, e))?;
        let t = tdir.clone();
        rb.push("code", move |_| {
            fs::remove_dir_all(&t).map_err(|e| format!("{}: {e}", t.display()))
        });
        let old_index = if is_skill {
            index::read_index(layout)?.entry(&name).cloned()
        } else {
            None
        };
        let record_json = json!({
            "removedAt": now, "reason": "replaced", "record": old, "index": old_index
        });
        let mut text = serde_json::to_string_pretty(&record_json).unwrap_or_default();
        text.push('\n');
        let rj = tdir.join("record.json");
        write_private_atomic(&rj, text.as_bytes()).map_err(|e| io_err("cannot write", &rj, e))?;
        let cached = paths.cached(&old.package_sha256);
        if cached.is_file() {
            let to = tdir.join("package.p1x");
            fs::copy(&cached, &to).map_err(|e| io_err("cannot copy", &cached, e))?;
        }
        let code = tdir.join("code");
        if is_skill {
            let dir = layout.skills().join(&name);
            if fs::symlink_metadata(&dir).is_ok() {
                rename_retrying(&dir, &code)
                    .map_err(|e| io_err("cannot move to the trash", &dir, e))?;
                rb.push("code", move |_| {
                    rename_retrying(&code, &dir).map_err(|e| format!("{}: {e}", code.display()))
                });
            }
        } else if modinstall::installed_dir(layout, &name).is_some() {
            host.remove_module(&name, &code)?;
            rb.push("code", move |h| {
                let s = modinstall::stage(layout, &code).map_err(|e| e.to_string())?;
                h.install_module(s).map(drop).map_err(|e| e.to_string())
            });
        }
    }
    if is_skill {
        let dest = layout.skills().join(&name);
        ensure_dir(&layout.skills(), "code", rb)?;
        rename_retrying(&staged.dir, &dest)
            .map_err(|e| io_err("cannot move into place", &staged.dir, e))?;
        rb.push("code", move |_| {
            fs::remove_dir_all(&dest).map_err(|e| format!("{}: {e}", dest.display()))
        });
    } else {
        ensure_dir(&layout.modules_dir(), "code", rb)?;
        let s = modinstall::stage(layout, &staged.dir).map_err(install_err)?;
        host.install_module(s)?;
        let aside = staged
            .dir
            .parent()
            .unwrap_or(&paths.staging)
            .join("rollback-code");
        let n = name.clone();
        rb.push("code", move |h| {
            h.remove_module(&n, &aside).map_err(|e| e.to_string())?;
            fs::remove_dir_all(&aside).map_err(|e| format!("{}: {e}", aside.display()))
        });
    }
    fail_at("code")?;

    // state: the package record; a replacement keeps the acknowledged capability hash (a widened set needs a new
    // acknowledgment at the next enable, X1-R29).
    let mut record = staged.record.clone();
    record.installed_at = now.clone();
    record.previous_version = prev.map(|p| p.version.clone());
    record.capabilities_ack = prev.and_then(|p| p.capabilities_ack.clone());
    record.integrity = None;
    let mut next = st.clone();
    next.items.insert(name.clone(), record.clone());
    ensure_dir(&paths.root, "state", rb)?;
    let before = read_bytes(&paths.state);
    state::write(paths, &next).map_err(|e| io_err("cannot write", &paths.state, e))?;
    rb.push("state", restore_file(paths.state.clone(), before));
    fail_at("state")?;

    // cache: the package bytes, and what the inspection found about them (X1-R2: `ext.show` reads this, never the
    // package).
    ensure_dir(&paths.cache, "cache", rb)?;
    let cached = paths.cached(&rec.sha256);
    if !cached.is_file() {
        copy_atomic(&staged.package, &cached)?;
        let c = cached.clone();
        rb.push("cache", move |_| {
            remove_retrying(&c).map_err(|e| e.to_string())
        });
    }
    let meta = paths.cached_meta(&rec.sha256);
    if !meta.is_file() {
        let body = json!({ "manifest": rec.manifest, "trust": rec.trust, "scripts": rec.scripts });
        let mut text = serde_json::to_string_pretty(&body).unwrap_or_default();
        text.push('\n');
        write_private_atomic(&meta, text.as_bytes())
            .map_err(|e| io_err("cannot write", &meta, e))?;
        rb.push("cache", move |_| {
            remove_retrying(&meta).map_err(|e| e.to_string())
        });
    }
    fail_at("cache")?;

    // index (skills): the importer's entry shape plus `package` (X1-R14); a replacement keeps `enabled`.
    let mut state_name = "installed";
    if is_skill {
        let ipath = layout.skills().join("index.json");
        let before = read_bytes(&ipath);
        let mut idx = index::read_index(layout)?;
        let old_entry = idx.entry(&name).cloned();
        let enabled = prev.is_some()
            && old_entry
                .as_ref()
                .and_then(|e| e["enabled"].as_bool())
                .unwrap_or(false);
        let mut entry = old_entry
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        let pairs: Vec<(String, String)> = record
            .files
            .iter()
            .map(|(k, v)| (k.clone(), v.sha256.clone()))
            .collect();
        entry["id"] = json!(name);
        entry["source"] = json!("file");
        entry["sourcePath"] = json!(rec.source_path.clone().unwrap_or_else(|| "-".into()));
        entry["sha256"] = json!(plur1bus_ext::folder_hash::skill_folder_hash(&pairs));
        entry["enabled"] = json!(enabled);
        entry["importedAt"] = json!(now);
        entry["package"] =
            json!({ "id": record.id, "version": record.version, "trust": record.trust });
        idx.upsert(entry);
        index::write_index(layout, &idx).map_err(|e| io_err("cannot write", &ipath, e))?;
        rb.push("index", restore_file(ipath, before));
        if enabled {
            state_name = "enabled";
        }
        fail_at("index")?;
    }

    // enable (only when asked): the same writes as `ext.enable`, recorded with the acknowledged capability hash.
    if let Some(agents) = &opts.enable {
        enable_now(
            layout,
            paths,
            host,
            &name,
            is_skill,
            agents,
            &mut record,
            rb,
        )?;
        state_name = "enabled";
        fail_at("enable")?;
    }

    // `data/ext/<name>/` (X1-R31); kept if an earlier install left it.
    ensure_dir(&layout.ext_data(&name), "data", rb)?;
    Ok((record, state_name))
}

/// Enables a just-installed item (X1-R11, X1-R13): a skill's index entry and every agent's `blocked` list, a module's
/// `modules.<name>.enabled`; then `capabilitiesAck` in the record. Task 8's `ext.enable` owns the same semantics for
/// installed items.
#[allow(clippy::too_many_arguments)]
fn enable_now<'a>(
    layout: &'a Layout,
    paths: &ExtPaths,
    host: &mut dyn ModuleHost,
    name: &str,
    is_skill: bool,
    agents: &Agents,
    record: &mut ItemRecord,
    rb: &mut Rollback<'a>,
) -> Result<(), ExtError> {
    let cfg = host.config();
    if is_skill {
        let ipath = layout.skills().join("index.json");
        let before = read_bytes(&ipath);
        let mut idx = index::read_index(layout)?;
        idx.set_enabled(name, true);
        index::write_index(layout, &idx).map_err(|e| io_err("cannot write", &ipath, e))?;
        rb.push("enable", restore_file(ipath, before));

        let mut changes = Vec::new();
        let mut restore = Vec::new();
        if let Some(map) = cfg["agents"].as_object() {
            for (id, a) in map {
                let blocked: Vec<String> = a["skills"]["blocked"]
                    .as_array()
                    .map(|l| {
                        l.iter()
                            .filter_map(|x| x.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                let wanted = match agents {
                    Agents::All => true,
                    Agents::Some(list) => list.iter().any(|x| x == id),
                };
                let mut next: Vec<String> =
                    blocked.iter().filter(|b| *b != name).cloned().collect();
                if !wanted {
                    next.push(name.to_string());
                }
                if next != blocked {
                    changes.push((format!("agents.{id}.skills.blocked"), json!(next)));
                    restore.push((
                        format!("agents.{id}.skills"),
                        a.get("skills").cloned().unwrap_or(Value::Null),
                    ));
                }
            }
        }
        if !changes.is_empty() {
            host.set_config(changes, false)?;
            rb.push("enable", move |h| {
                h.set_config(restore, false)
                    .map(drop)
                    .map_err(|e| e.to_string())
            });
        }
    } else {
        let section = cfg["modules"].get(name).cloned().unwrap_or(Value::Null);
        host.set_config(
            vec![(format!("modules.{name}.enabled"), json!(true))],
            false,
        )?;
        let key = format!("modules.{name}");
        rb.push("enable", move |h| {
            h.set_config(vec![(key, section)], false)
                .map(drop)
                .map_err(|e| e.to_string())
        });
    }
    let mut st = state::read(paths).map_err(|e| ExtError::new("E_STORAGE", "state-invalid", e))?;
    record.capabilities_ack = Some(capabilities_hash(&record.capabilities));
    st.items.insert(name.to_string(), record.clone());
    let before = read_bytes(&paths.state);
    state::write(paths, &st).map_err(|e| io_err("cannot write", &paths.state, e))?;
    rb.push("enable", restore_file(paths.state.clone(), before));
    Ok(())
}

// ---- the offline host ---------------------------------------------------------------------------------------------

/// The [`ModuleHost`] of the offline CLI (no supervisor runs): config.json through `plur1bus_config` (read, validate,
/// atomic write), modules through `modules::install` (nothing runs, so nothing is stopped). `notified` collects the
/// `ext.changed` params (nobody is subscribed offline).
pub struct OfflineHost<'a> {
    layout: &'a Layout,
    pub notified: Vec<Value>,
}

impl<'a> OfflineHost<'a> {
    pub fn new(layout: &'a Layout) -> Self {
        OfflineHost {
            layout,
            notified: Vec::new(),
        }
    }
}

fn config_invalid(msg: String) -> ExtError {
    ExtError {
        code: "E_CONFIG_INVALID",
        reason: None,
        message: msg,
        data: Value::Null,
    }
}

/// Removes the dotted `key` from `v`; a missing key is fine.
fn remove_key(v: &mut Value, key: &str) {
    let parts: Vec<&str> = key.split('.').collect();
    let Some((last, dirs)) = parts.split_last() else {
        return;
    };
    let mut node = v;
    for p in dirs {
        match node.get_mut(*p) {
            Some(n) => node = n,
            None => return,
        }
    }
    if let Some(m) = node.as_object_mut() {
        m.remove(*last);
    }
}

/// `changes` applied in order to `config` (a `null` value removes the key), validated once at the end.
pub(crate) fn apply_changes(
    config: &Value,
    changes: &[(String, Value)],
) -> Result<Value, ExtError> {
    let mut after = config.clone();
    for (k, v) in changes {
        if v.is_null() {
            remove_key(&mut after, k);
        } else {
            after = plur1bus_config::set_many(&after, &[(k.clone(), v.clone())])
                .map_err(|e| config_invalid(format!("{k}: {e}")))?
                .after;
        }
    }
    plur1bus_config::validate(&after).map_err(|v| {
        config_invalid(format!(
            "the configuration would be invalid: {}",
            v.join("; ")
        ))
    })?;
    Ok(after)
}

impl ModuleHost for OfflineHost<'_> {
    fn config(&self) -> Value {
        plur1bus_config::read(&self.layout.config_path()).unwrap_or(Value::Null)
    }

    fn set_config(
        &mut self,
        changes: Vec<(String, Value)>,
        dry_run: bool,
    ) -> Result<Value, ExtError> {
        let path = self.layout.config_path();
        let before = plur1bus_config::read(&path)
            .map_err(|e| config_invalid(format!("{}: {e}", path.display())))?;
        let after = apply_changes(&before, &changes)?;
        let plan = plur1bus_config::restart_plan(&before, &after);
        if !dry_run && after != before {
            plur1bus_config::write_atomic(&path, &after)
                .map_err(|e| io_err("cannot write", &path, e))?;
        }
        Ok(json!({ "restart": { "modules": plan.restart.modules }, "heldBack": [] }))
    }

    fn install_module(&mut self, staged: modinstall::Staged) -> Result<bool, ExtError> {
        modinstall::commit(staged).map_err(install_err)
    }

    fn remove_module(&mut self, name: &str, into: &Path) -> Result<(), ExtError> {
        modinstall::remove_to(self.layout, name, into).map_err(install_err)
    }

    fn notify(&mut self, change: Value) {
        self.notified.push(change);
    }

    fn via(&self) -> &'static str {
        "offline"
    }
}
