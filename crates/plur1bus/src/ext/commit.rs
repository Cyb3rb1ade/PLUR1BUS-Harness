//! The commit half of `ext.install` (spec §6.1, §8.3, §9.2; X1-R13, R14, R15, R19, R29, R31, R32; X1-C9, C10, C12,
//! C14; Review Focus 1, 3, 5).
//!
//! [`install_commit`] takes a staged package (Task 6) and puts it in place in the order of [`COMMIT_STEPS`]. Each step
//! registers how to undo itself before the next one runs. A failure at any step undoes the steps done so far in
//! reverse, so `skills/`, `modules/`, `extensions/` and `config.json` end as they were (acceptance 2). Before any
//! write, and for a skill under the importer's lock, it re-checks against the current state what the inspection
//! checked (the inspection can be ten minutes old): the name, a module's socket address, the revocation list and
//! `extensions.allowUnsigned`. Then it checks the acknowledgments. The staging directory it was handed is removed
//! whichever way it ends.
//!
//! A kill between steps (X1-C10): a skill's index entry is written, disabled and with `package` set, *before* its
//! folder moves into place, so no folder ever lies in `skills/` without an entry (which X1-R12 would list as enabled).
//! [`super::recover`] reconciles what a kill left: an entry without folder and record, or a recorded folder without
//! an entry.
//!
//! Supervisor-safe (X1-R2): nothing here opens package bytes; the package is copied into the cache as an opaque file.
//! Config and module work go through a [`ModuleHost`], so the same code runs in the supervisor (Task 11) and in the
//! offline CLI ([`OfflineHost`]).
use super::index::{self, lock_skills, package_entry, ImportLock};
use super::lifecycle::{capabilities_acknowledged, enable_prechecks, skill_enable_changes};
use super::overlays::{load_revocations, overlays_of, revoked};
use super::paths::ExtPaths;
use super::record::{
    check_name, check_unsigned_policy, kind_name, record_path, spool_path, staging_dir, valid_id,
    InspectionRecord, StagedItem,
};
use super::state::{
    self, remove_dir_all_retrying, remove_retrying, rename_retrying, write_private_atomic,
    ItemRecord,
};
use super::{now_iso, ExtError};
use crate::modules::install as modinstall;
use crate::paths::Layout;
use plur1bus_ext::manifest::Kind;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// The commit steps in order. `PLUR1BUS_TEST_EXT_FAIL_AT=<step>` fails the named one after its own writes, so its undo
/// runs too; `PLUR1BUS_TEST_EXT_FAIL_AT=kill:<point>` stops there with no rollback and no clean-up, as a killed
/// process would (the points are the steps plus `code.index`, between a skill's index entry and its folder move, and
/// `code.trash`, between a replaced item's old code moving into the trash and the new code moving into place). The
/// uninstall and restore of `super::remove` name their own points (`uninstall.*`, `restore.*`). Test internals only.
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
    /// The raw bytes of `config.json` (`Some(None)`: no file) when this host can put them back exactly
    /// ([`ModuleHost::restore_config_bytes`], X1-C14); `None` when a rollback goes through [`ModuleHost::set_config`].
    fn config_bytes(&self) -> Option<Option<Vec<u8>>> {
        None
    }
    /// Puts back what [`ModuleHost::config_bytes`] returned: those bytes, or no file.
    fn restore_config_bytes(&mut self, _bytes: Option<Vec<u8>>) -> Result<(), ExtError> {
        Err(ExtError::new(
            "E_INTERNAL",
            "io",
            "this host cannot restore config.json byte for byte",
        ))
    }
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

pub(crate) fn io_err(what: &str, path: &Path, e: impl std::fmt::Display) -> ExtError {
    ExtError::new(
        "E_INTERNAL",
        "io",
        format!("{what} {}: {e}", path.display()),
    )
}

pub(crate) fn install_err(e: modinstall::InstallError) -> ExtError {
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

/// Set when the kill seam fired: the commit then returns without rollback or clean-up.
static KILLED: AtomicBool = AtomicBool::new(false);

/// Clears the kill mark at the start of a mutation.
pub(crate) fn reset_kill() {
    KILLED.store(false, Ordering::SeqCst);
}

/// The kill seam fired in this mutation: undo nothing, clean nothing up.
pub(crate) fn killed() -> bool {
    KILLED.load(Ordering::SeqCst)
}

/// The test seam `PLUR1BUS_TEST_EXT_FAIL_AT=<step>|kill:<point>` (global constraints, X1-C10).
pub(crate) fn fail_at(point: &str) -> Result<(), ExtError> {
    if !allow_internals() {
        return Ok(());
    }
    let Ok(seam) = std::env::var("PLUR1BUS_TEST_EXT_FAIL_AT") else {
        return Ok(());
    };
    if seam == point {
        return Err(ExtError::new(
            "E_INTERNAL",
            "io",
            format!("test seam: the {point} step failed"),
        ));
    }
    if seam.strip_prefix("kill:") == Some(point) {
        KILLED.store(true, Ordering::SeqCst);
        return Err(ExtError::new(
            "E_INTERNAL",
            "io",
            format!("test seam: killed after {point}"),
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
pub(crate) struct Rollback<'a> {
    undos: Vec<(&'static str, Undo<'a>)>,
}

impl<'a> Rollback<'a> {
    pub(crate) fn push(
        &mut self,
        step: &'static str,
        f: impl FnOnce(&mut dyn ModuleHost) -> Result<(), String> + 'a,
    ) {
        self.undos.push((step, Box::new(f)));
    }

    /// Runs every undo, last first; returns the ones that failed.
    pub(crate) fn run(self, host: &mut dyn ModuleHost) -> Vec<String> {
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
pub(crate) fn ensure_dir(
    dir: &Path,
    step: &'static str,
    rb: &mut Rollback<'_>,
) -> Result<(), ExtError> {
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

pub(crate) fn read_bytes(p: &Path) -> Option<Vec<u8>> {
    fs::read(p).ok()
}

/// Puts a file back as it was: the saved bytes, or no file.
pub(crate) fn restore_file(
    path: PathBuf,
    before: Option<Vec<u8>>,
) -> impl FnOnce(&mut dyn ModuleHost) -> Result<(), String> {
    move |_| match before {
        Some(b) => write_private_atomic(&path, &b).map_err(|e| format!("{}: {e}", path.display())),
        None => remove_retrying(&path).map_err(|e| format!("{}: {e}", path.display())),
    }
}

/// Changes config through the host and registers the undo: the raw bytes back when the host offers them (X1-C14),
/// else each touched section set back to its value before (`null`: absent). Returns the host's plan
/// (`{restart: {modules}, heldBack}`).
pub(crate) fn config_change<'a>(
    host: &mut dyn ModuleHost,
    step: &'static str,
    changes: Vec<(String, Value)>,
    restore: Vec<(String, Value)>,
    rb: &mut Rollback<'a>,
) -> Result<Value, ExtError> {
    let snapshot = host.config_bytes();
    let plan = host.set_config(changes, false)?;
    rb.push(step, move |h| match snapshot {
        Some(bytes) => h.restore_config_bytes(bytes).map_err(|e| e.to_string()),
        None => h
            .set_config(restore, false)
            .map(drop)
            .map_err(|e| e.to_string()),
    });
    Ok(plan)
}

/// `extensions/staging/<name>-<id>` of inspection `rec`, when its id and manifest name are plain file-name parts.
fn derived_staging(layout: &Layout, rec: &InspectionRecord) -> Option<PathBuf> {
    let name = rec.manifest["name"].as_str()?;
    let plain = !name.is_empty()
        && name.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
        && !name.starts_with('.');
    (plain && valid_id(&rec.inspection_id)).then(|| staging_dir(layout, name, &rec.inspection_id))
}

/// Moves a package file `from` to `to` (X1-C22: the supervisor never opens package bytes): the spool into the cache,
/// the cache into a trash entry and back. A rename, retried on Windows; only when the two are on different devices an
/// opaque copy through `<to>.tmp-<pid>`, after which `from` is removed.
pub(crate) fn move_package(from: &Path, to: &Path) -> Result<(), ExtError> {
    match rename_retrying(from, to) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
            copy_atomic(from, to)?;
            remove_retrying(from).map_err(|e| io_err("cannot remove", from, e))
        }
        Err(e) => Err(io_err("cannot move the package to", to, e)),
    }
}

/// Moves the cached package `sha256` into the trash entry `tdir` as `package.p1x` (X1-R19, X1-C22), and registers the
/// undo that moves it back into the cache. Nothing to do when the cache does not hold it.
pub(crate) fn package_into_trash<'a>(
    paths: &ExtPaths,
    sha256: &str,
    tdir: &Path,
    step: &'static str,
    rb: &mut Rollback<'a>,
) -> Result<(), ExtError> {
    let cached = paths.cached(sha256);
    let into = tdir.join("package.p1x");
    if !cached.is_file() || into.exists() {
        return Ok(());
    }
    move_package(&cached, &into)?;
    rb.push(step, move |_| {
        move_package(&into, &cached).map_err(|e| e.to_string())
    });
    Ok(())
}

/// Copies `from` to `to` through `<to>.tmp-<pid>` and a rename.
pub(crate) fn copy_atomic(from: &Path, to: &Path) -> Result<(), ExtError> {
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

/// The re-checks at commit time (the inspection can be up to ten minutes old).
fn recheck(
    layout: &Layout,
    paths: &ExtPaths,
    st: &state::ExtState,
    staged: &StagedItem,
    cfg: &Value,
) -> Result<(), ExtError> {
    let r = &staged.record;
    check_name(layout, st, &r.name, &r.id, kind_name(staged.kind))?;
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
    check_unsigned_policy(
        cfg["extensions"]["allowUnsigned"] != false,
        &r.trust,
        &r.id,
        &r.version,
    )
}

fn lower(new: &str, old: &str) -> bool {
    match (semver::Version::parse(new), semver::Version::parse(old)) {
        (Ok(n), Ok(o)) => n < o,
        _ => false,
    }
}

/// The acknowledgments this install needs (X1-R13, X1-R29, X1-C12): `unsigned` or `unknown-signer` by tier,
/// `downgrade` for a lower version of the installed id, `capabilities` with `enable` or when an enabled item is
/// replaced by one with other capabilities (`widened`). The first missing one is `E_APPROVAL_REQUIRED
/// acknowledge-<x>` with the inspection in `data` (plus `authority` for the capability disclosure). Returns the
/// acknowledgments given, deduplicated, for the audit line.
fn acknowledgments(
    rec: &InspectionRecord,
    staged: &StagedItem,
    prev: Option<&ItemRecord>,
    widened: bool,
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
    if opts.enable.is_some() || widened {
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
            if widened {
                data["previousCapabilities"] = prev.map_or(Value::Null, |p| p.capabilities.clone());
            }
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
            _ if widened && opts.enable.is_none() => (
                "acknowledge-capabilities",
                "the enabled extension would change its capabilities",
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

/// One part of a trash id, safe as a path segment: characters outside `[A-Za-z0-9._+-]` become `_`, `..` collapses to
/// `.`, `.tmp-` (a temp entry's mark) becomes `-tmp-`, no leading `.`, at most 64 characters; empty → `fallback`. The
/// name and version come from records, index entries or the install manifest, which may hold anything.
fn id_part(s: &str, fallback: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    while out.contains("..") {
        out = out.replace("..", ".");
    }
    out = out.replace(".tmp-", "-tmp-");
    let out = out.trim_start_matches('.');
    if out.is_empty() {
        fallback.to_string()
    } else {
        out.to_string()
    }
}

/// A fresh `extensions/trash/<name>-<version>-<YYYYMMDDTHHMMSSZ>` (X1-R19); a second one in the same second gets `-2`,
/// `-3`, … Name and version are made safe ([`id_part`]), so every id passes the restore's check
/// (`super::remove::valid_trash_id`) and never leaves `extensions/trash/`.
pub(crate) fn trash_id(paths: &ExtPaths, name: &str, version: &str, at: &str) -> String {
    let base = format!(
        "{}-{}-{}",
        id_part(name, "item"),
        id_part(version, "0.0.0"),
        trash_stamp(at)
    );
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
    let guard = super::try_mutation();
    // Only whether the lock was taken is passed on; `guard` itself stays alive (and the lock held) until this
    // function returns.
    let locked: Result<(), &ExtError> = match &guard {
        Ok(_) => Ok(()),
        Err(e) => Err(e),
    };
    commit_and_clean(layout, host, rec, staged, opts, locked)
}

/// [`install_commit`] for a caller that already holds the ext mutation lock: the supervisor's `ext.install` takes it
/// before the worker stages the package, so the stage and the commit are one mutation (X1-R15).
pub fn install_commit_held(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    rec: &InspectionRecord,
    staged: StagedItem,
    opts: &InstallOpts,
    _held: &super::MutationGuard,
) -> Result<Value, ExtError> {
    commit_and_clean(layout, host, rec, staged, opts, Ok(()))
}

fn commit_and_clean(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    rec: &InspectionRecord,
    staged: StagedItem,
    opts: &InstallOpts,
    locked: Result<(), &ExtError>,
) -> Result<Value, ExtError> {
    let paths = ExtPaths::of(layout);
    // Derived from the inspection, never from the staged item's own paths (the worker's answer).
    let staging = derived_staging(layout, rec);
    KILLED.store(false, Ordering::SeqCst);
    let result = match locked {
        Ok(()) => commit_locked(layout, &paths, host, rec, staged, opts),
        Err(e) => Err(e.clone()),
    };
    if KILLED.load(Ordering::SeqCst) {
        // A killed process cleans nothing up; `ext::recover` does, at the next start.
        return result;
    }
    // The staging directory is spent whichever way it went (a refusal must leave `extensions/` as it was).
    if let Some(d) = staging {
        let _ = remove_dir_all_retrying(&d);
        let _ = fs::remove_dir(&paths.staging);
        let _ = fs::remove_dir(&paths.root);
    }
    if result.is_ok() && valid_id(&rec.inspection_id) {
        // The inspection is consumed.
        let _ = remove_retrying(&record_path(layout, &rec.inspection_id));
        let _ = remove_retrying(&spool_path(layout, &rec.inspection_id));
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
            format!("{} packages arrive in X2", kind_name(staged.kind)),
        ));
    }
    if staged.record.package_sha256 != rec.sha256 || rec.manifest["name"] != staged.name.as_str() {
        return Err(ExtError::new(
            "E_INTERNAL",
            "worker-failed",
            "the staged item does not belong to this inspection",
        ));
    }
    // The staged item's paths come from the worker's answer: they must be exactly the ones derived from the inspection
    // (`extensions/staging/<name>-<id>/payload`, `run/inspect/<id>.p1x`), else nothing is moved.
    let derived = derived_staging(layout, rec).map(|d| d.join("payload"));
    if derived.as_deref() != Some(staged.dir.as_path())
        || staged.package != spool_path(layout, &rec.inspection_id)
    {
        return Err(ExtError::new(
            "E_INTERNAL",
            "worker-failed",
            "the staged item names paths other than this inspection's staging directory and package",
        ));
    }
    let name = staged.name.clone();
    let kind = kind_name(staged.kind);
    let cfg = host.config();

    // Review Focus 5: the identical package again is a no-op that writes nothing.
    {
        let st = state::read(paths).map_err(|e| ExtError::new("E_STORAGE", "state-invalid", e))?;
        if let Some(p) = st
            .items
            .get(&name)
            .filter(|p| p.id == staged.record.id && p.package_sha256 == rec.sha256)
        {
            // An `enable` it skips shows as `state: "installed"`; the CLI says so (the supervisor's stderr is a log).
            let on = enabled_now(layout, &cfg, &name, kind);
            return Ok(json!({
                "name": name, "version": p.version, "kind": kind, "replaced": false,
                "state": if on { "enabled" } else { "installed" }
            }));
        }
    }

    // Review Focus 1: the importer's lock before any write, held to the end; everything after it is judged under it.
    let _lock: Option<ImportLock> = if staged.kind == Kind::Skill {
        Some(lock_skills(layout)?)
    } else {
        None
    };
    let st = state::read(paths).map_err(|e| ExtError::new("E_STORAGE", "state-invalid", e))?;
    let prev = st.items.get(&name).cloned();
    recheck(layout, paths, &st, &staged, &cfg)?;
    let prev_enabled = prev.is_some() && enabled_now(layout, &cfg, &name, kind);
    // X1-C12, with the comparison `ext.enable` uses: the new capabilities against the acknowledged hash.
    let widened = prev_enabled
        && prev.as_ref().is_some_and(|p| {
            !capabilities_acknowledged(&staged.record.capabilities, p.capabilities_ack.as_deref())
        });
    let acknowledged = acknowledgments(rec, &staged, prev.as_ref(), widened, opts)?;
    if let Some(agents) = &opts.enable {
        enable_prechecks(&name, kind, &staged.record.required_secrets, &cfg, agents)?;
    }
    // Every refusal and the no-op are behind us: the first write (X1-C16).
    super::remove::prune_for(layout, &cfg);

    let mut rb = Rollback::default();
    let ctx = Ctx {
        layout,
        paths,
        rec,
        staged: &staged,
        prev: prev.as_ref(),
        prev_enabled,
        widened,
        prev_index: if staged.kind == Kind::Skill {
            index::read_index(layout)?.entry(&name).cloned()
        } else {
            None
        },
        st: &st,
        cfg: &cfg,
        opts,
    };
    let (record, state_name) = match run_steps(&ctx, host, &mut rb) {
        Ok(x) => x,
        Err(mut e) => {
            if KILLED.load(Ordering::SeqCst) {
                drop(rb); // a killed process undoes nothing
                return Err(e);
            }
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

/// What the steps read.
struct Ctx<'c> {
    layout: &'c Layout,
    paths: &'c ExtPaths,
    rec: &'c InspectionRecord,
    staged: &'c StagedItem,
    prev: Option<&'c ItemRecord>,
    /// The replaced item is enabled now (X1-C9 keeps it so).
    prev_enabled: bool,
    /// ... and its capabilities change, which the person acknowledged (X1-C12).
    widened: bool,
    /// The skill's index entry as it was when the commit started (for the trash's `record.json`).
    prev_index: Option<Value>,
    st: &'c state::ExtState,
    cfg: &'c Value,
    opts: &'c InstallOpts,
}

/// The steps of [`COMMIT_STEPS`], each registering its undo in `rb`. Returns the written record and the final state.
fn run_steps<'a>(
    c: &Ctx<'a>,
    host: &mut dyn ModuleHost,
    rb: &mut Rollback<'a>,
) -> Result<(ItemRecord, &'static str), ExtError> {
    let (layout, paths, staged) = (c.layout, c.paths, c.staged);
    let name = staged.name.clone();
    let is_skill = staged.kind == Kind::Skill;
    let now = now_iso();

    // The record the steps write: a replacement keeps the acknowledged capability hash (a widened set needs a new
    // acknowledgment at the next enable, X1-R29) unless the widening was acknowledged right here (X1-C12).
    let mut record = staged.record.clone();
    record.installed_at = now.clone();
    record.previous_version = c.prev.map(|p| p.version.clone());
    record.capabilities_ack = if c.widened {
        Some(capabilities_hash(&record.capabilities))
    } else {
        c.prev.and_then(|p| p.capabilities_ack.clone())
    };
    record.integrity = None;

    // config: a fresh module is installed disabled. A replacement keeps its enable state (X1-C9).
    if !is_skill {
        if c.prev.is_none() {
            let section = c.cfg["modules"].get(&name).cloned().unwrap_or(Value::Null);
            if section.get("enabled") != Some(&json!(false)) {
                config_change(
                    host,
                    "config",
                    vec![(format!("modules.{name}.enabled"), json!(false))],
                    vec![(format!("modules.{name}"), section)],
                    rb,
                )?;
            }
        }
        fail_at("config")?;
    }

    // code, for a skill: the index entry first, disabled, with `package` set (X1-C10).
    let ipath = index::index_path(layout);
    if is_skill {
        ensure_dir(&layout.skills(), "code", rb)?;
        let before = read_bytes(&ipath);
        let mut idx = index::read_index(layout)?;
        let old = idx.entry(&name).cloned();
        idx.upsert(package_entry(
            &record,
            &source_path(c.rec),
            false,
            &now,
            old.as_ref(),
        ));
        index::write_index(layout, &idx).map_err(|e| io_err("cannot write", &ipath, e))?;
        rb.push("code", restore_file(ipath.clone(), before));
        fail_at("code.index")?;
    }

    // code: a replaced item's code goes into the trash first (X1-R19), then the new code into place.
    if let Some(old) = c.prev {
        let tdir = new_trash_entry(c, old, &now, rb)?;
        let code = tdir.join("code");
        if is_skill {
            let dir = layout.skills().join(&name);
            if fs::symlink_metadata(&dir).is_ok() {
                rename_retrying(&dir, &code)
                    .map_err(|e| io_err("cannot move to the trash", &dir, e))?;
            }
        } else if modinstall::installed_dir(layout, &name).is_some() {
            host.remove_module(&name, &code)?;
        }
        // Its package follows the code (a kill in between: `ext::recover` puts both back, X1-C15).
        package_into_trash(paths, &old.package_sha256, &tdir, "code", rb)?;
        fail_at("code.trash")?;
    }
    if is_skill {
        let dest = layout.skills().join(&name);
        rename_retrying(&staged.dir, &dest)
            .map_err(|e| io_err("cannot move into place", &staged.dir, e))?;
        rb.push("code", move |_| {
            remove_dir_all_retrying(&dest).map_err(|e| format!("{}: {e}", dest.display()))
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
            remove_dir_all_retrying(&aside).map_err(|e| format!("{}: {e}", aside.display()))
        });
    }
    fail_at("code")?;

    // state: the package record.
    let mut next = c.st.clone();
    next.items.insert(name.clone(), record.clone());
    ensure_dir(&paths.root, "state", rb)?;
    let before = read_bytes(&paths.state);
    state::write(paths, &next).map_err(|e| io_err("cannot write", &paths.state, e))?;
    rb.push("state", restore_file(paths.state.clone(), before));
    fail_at("state")?;

    // cache: the package bytes, and what the inspection derived from them (X1-R2: `ext.show` reads this, never the
    // package). Trust lives in the record.
    ensure_dir(&paths.cache, "cache", rb)?;
    let cached = paths.cached(&c.rec.sha256);
    if !cached.is_file() {
        move_package(&staged.package, &cached)?;
        let (cc, spool) = (cached.clone(), staged.package.clone());
        // Undo: the package goes back to the spool (the inspection stays usable), or is removed when that fails.
        rb.push("cache", move |_| {
            if !spool.exists() && rename_retrying(&cc, &spool).is_ok() {
                return Ok(());
            }
            remove_retrying(&cc).map_err(|e| e.to_string())
        });
    }
    let meta = paths.cached_meta(&c.rec.sha256);
    if !meta.is_file() {
        let body = json!({ "manifest": c.rec.manifest, "scripts": c.rec.scripts });
        let mut text = serde_json::to_string_pretty(&body).unwrap_or_default();
        text.push('\n');
        write_private_atomic(&meta, text.as_bytes())
            .map_err(|e| io_err("cannot write", &meta, e))?;
        rb.push("cache", move |_| {
            remove_retrying(&meta).map_err(|e| e.to_string())
        });
    }
    fail_at("cache")?;

    // index (skills): the final entry; a replacement keeps `enabled` (X1-C9).
    let mut state_name = if !is_skill && c.prev.is_some() && c.prev_enabled {
        "enabled"
    } else {
        "installed"
    };
    if is_skill {
        if c.prev_enabled {
            let before = read_bytes(&ipath);
            let mut idx = index::read_index(layout)?;
            idx.set_enabled(&name, true);
            index::write_index(layout, &idx).map_err(|e| io_err("cannot write", &ipath, e))?;
            rb.push("index", restore_file(ipath.clone(), before));
            state_name = "enabled";
        }
        fail_at("index")?;
    }

    // enable (only when asked): the same writes as `ext.enable`, recorded with the acknowledged capability hash.
    if let Some(agents) = &c.opts.enable {
        enable_now(c, host, agents, &mut record, rb)?;
        state_name = "enabled";
        fail_at("enable")?;
    }

    // `data/ext/<name>/` (X1-R31); kept if an earlier install left it.
    ensure_dir(&layout.ext_data(&name), "data", rb)?;
    Ok((record, state_name))
}

fn source_path(rec: &InspectionRecord) -> String {
    rec.source_path.clone().unwrap_or_else(|| "-".into())
}

/// Builds `extensions/trash/<trashId>/` atomically (X1-R19): `<trashId>.tmp-<pid>` with `record.json` (`body`) and
/// the `extra` files, then one rename. `code/`, the cached package (`package.p1x`, [`package_into_trash`], moved once
/// the code is in) and a purge's `data/` move in afterwards. The trash directory must exist. Returns the trash id and
/// the entry's directory; a failure leaves nothing behind.
pub(crate) fn build_trash_entry(
    paths: &ExtPaths,
    name: &str,
    version: &str,
    now: &str,
    body: &Value,
    extra: &[(&str, Vec<u8>)],
) -> Result<(String, PathBuf), ExtError> {
    let tid = trash_id(paths, name, version, now);
    let tdir = paths.trash.join(&tid);
    let tmp = paths
        .trash
        .join(format!("{tid}.tmp-{}", std::process::id()));
    let built = (|| -> Result<(), ExtError> {
        fs::create_dir(&tmp).map_err(|e| io_err("cannot create", &tmp, e))?;
        let mut text = serde_json::to_string_pretty(body).unwrap_or_default();
        text.push('\n');
        let rj = tmp.join("record.json");
        write_private_atomic(&rj, text.as_bytes()).map_err(|e| io_err("cannot write", &rj, e))?;
        for (file, bytes) in extra {
            let p = tmp.join(file);
            write_private_atomic(&p, bytes).map_err(|e| io_err("cannot write", &p, e))?;
        }
        rename_retrying(&tmp, &tdir).map_err(|e| io_err("cannot create", &tdir, e))
    })();
    if let Err(e) = built {
        let _ = remove_dir_all_retrying(&tmp);
        return Err(e);
    }
    Ok((tid, tdir))
}

/// Builds the trash entry of a replaced item ([`build_trash_entry`]) and registers its one undo: put `code/` back
/// where it came from if it is there, and remove the entry only once that worked. A failed restore keeps the entry, so
/// no code is lost. The caller then moves the old code to `<trashId>/code`.
fn new_trash_entry<'a>(
    c: &Ctx<'a>,
    old: &ItemRecord,
    now: &str,
    rb: &mut Rollback<'a>,
) -> Result<PathBuf, ExtError> {
    let (layout, paths) = (c.layout, c.paths);
    let name = old.name.clone();
    let is_skill = old.kind == "skill";
    ensure_dir(&paths.trash, "code", rb)?;
    // The entry as it stood before this commit (the code step has already rewritten a skill's entry).
    let old_index = if is_skill { c.prev_index.clone() } else { None };
    let body = json!({
        "removedAt": now, "reason": "replaced", "name": name, "kind": old.kind, "version": old.version,
        "record": old, "index": old_index,
    });
    let (_, tdir) = build_trash_entry(paths, &name, &old.version, now, &body, &[])?;
    let t = tdir.clone();
    rb.push("code", move |h| {
        put_code_back(layout, h, is_skill, &name, &t.join("code"))?;
        remove_dir_all_retrying(&t).map_err(|e| format!("{}: {e}", t.display()))
    });
    Ok(tdir)
}

/// Puts code that moved into a trash entry back in place, if it is there: a skill folder by rename, a module through
/// the host (`modules::install::stage` copies it, [`ModuleHost::install_module`] puts it in place). The trash copy
/// stays; the caller removes the entry once this worked.
pub(crate) fn put_code_back(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    is_skill: bool,
    name: &str,
    code: &Path,
) -> Result<(), String> {
    if fs::symlink_metadata(code).is_err() {
        return Ok(());
    }
    let stays = |e: &dyn std::fmt::Display| {
        format!(
            "cannot put {} back (it stays in the trash): {e}",
            code.display()
        )
    };
    if is_skill {
        let dir = layout.skills().join(name);
        rename_retrying(code, &dir).map_err(|e| stays(&e))
    } else {
        let s = modinstall::stage(layout, code).map_err(|e| stays(&e))?;
        host.install_module(s).map(drop).map_err(|e| stays(&e))
    }
}

/// Enables a just-installed item (X1-R11, X1-R13): a skill's index entry and every agent's `blocked` list, a module's
/// `modules.<name>.enabled`; then `capabilitiesAck` in the record. Task 8's `ext.enable` owns the same semantics for
/// installed items.
fn enable_now<'a>(
    c: &Ctx<'a>,
    host: &mut dyn ModuleHost,
    agents: &Agents,
    record: &mut ItemRecord,
    rb: &mut Rollback<'a>,
) -> Result<(), ExtError> {
    let (layout, paths) = (c.layout, c.paths);
    let name = c.staged.name.as_str();
    let cfg = host.config();
    if c.staged.kind == Kind::Skill {
        let ipath = index::index_path(layout);
        let before = read_bytes(&ipath);
        let mut idx = index::read_index(layout)?;
        idx.set_enabled(name, true);
        index::write_index(layout, &idx).map_err(|e| io_err("cannot write", &ipath, e))?;
        rb.push("enable", restore_file(ipath, before));

        let (changes, restore) = skill_enable_changes(&cfg, name, agents);
        if !changes.is_empty() {
            config_change(host, "enable", changes, restore, rb)?;
        }
    } else {
        let section = cfg["modules"].get(name).cloned().unwrap_or(Value::Null);
        config_change(
            host,
            "enable",
            vec![(format!("modules.{name}.enabled"), json!(true))],
            vec![(format!("modules.{name}"), section)],
            rb,
        )?;
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
/// atomic write; a rollback puts the raw bytes back, X1-C14), modules through `modules::install` (nothing runs, so
/// nothing is stopped). `notified` collects the `ext.changed` params (nobody is subscribed offline).
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

    fn config_bytes(&self) -> Option<Option<Vec<u8>>> {
        match fs::read(self.layout.config_path()) {
            Ok(b) => Some(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(None),
            // Unreadable: no snapshot, so a rollback goes through `set_config` and never deletes the file.
            Err(_) => None,
        }
    }

    fn restore_config_bytes(&mut self, bytes: Option<Vec<u8>>) -> Result<(), ExtError> {
        let path = self.layout.config_path();
        match bytes {
            Some(b) => write_private_atomic(&path, &b),
            None => remove_retrying(&path),
        }
        .map_err(|e| io_err("cannot restore", &path, e))
    }
}
