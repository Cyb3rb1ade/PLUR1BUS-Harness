//! Worker half of `ext.install` (spec §8.4 steps 9–10; X1-R3, X1-R22): stages an inspected package, and the
//! `plur1bus ext __worker` entry point (X1-R2).
//!
//! [`stage`] loads the inspection, re-hashes the spooled package against its `sha256` (`digest-mismatch`), and extracts
//! it with the one verified extractor, `install::archive::extract`, into `extensions/staging/<name>-<id>`. It then walks
//! the staged tree (TOCTOU closed): a symlink or special file is `archive-unsafe-entry`; the payload's file set must be
//! exactly `files` (`package-invalid`), with every size and SHA-256 equal (`digest-mismatch`); modes become 0755 for
//! `exec: true` and 0644 otherwise. The kind checks follow: a skill's `SKILL.md` passes the Agent Skills check with
//! the package name; a module's or channel's `module.json` is valid and names the package's name, version and kind
//! (default `module`), and its entry file exists. Any refusal removes the staging directory, `extensions/staging/`
//! when that is left empty, and `extensions/` when this stage created it and it is empty.
use super::inspect::{self, Source};
use super::paths::ExtPaths;
pub use super::record::StagedItem;
use super::record::{
    allow_internals, io_err as io_error, kind_name, spool_path, staging_dir, InspectionRecord,
};
use super::state::ItemRecord;
use super::ExtError;
use crate::install::archive;
use crate::paths::Layout;
use plur1bus_ext::manifest::{parse_manifest, Kind, P1xManifest};
use plur1bus_ext::refusal::{reason, Refusal};
use plur1bus_ext::skill::validate_skill_md;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};

/// The hidden `plur1bus ext __worker` operations.
#[derive(clap::Subcommand, Debug, Clone)]
pub enum WorkerArgs {
    /// Inspect a package into `run/inspect/<id>.{p1x,json}`
    Inspect {
        #[arg(long)]
        id: String,
        /// A `.p1x`, a skill folder, `.zip` or `.skill`
        #[arg(long, required_unless_present = "stdin", conflicts_with = "stdin")]
        path: Option<PathBuf>,
        /// Read the package from stdin
        #[arg(long)]
        stdin: bool,
        /// Test seam: sleep first (needs PLUR1BUS_ALLOW_TEST_INTERNALS=1)
        #[arg(long, hide = true)]
        sleep_ms: Option<u64>,
        /// Test seam: abort once the package is spooled, as a crashing parser would (needs
        /// PLUR1BUS_ALLOW_TEST_INTERNALS=1)
        #[arg(long, hide = true)]
        crash: bool,
    },
    /// Stage an inspected package into `extensions/staging/`
    Stage {
        #[arg(long)]
        id: String,
        /// Test seam: sleep first (needs PLUR1BUS_ALLOW_TEST_INTERNALS=1)
        #[arg(long, hide = true)]
        sleep_ms: Option<u64>,
        /// Test seam: abort once the package is extracted into staging, leaving it half-checked (needs
        /// PLUR1BUS_ALLOW_TEST_INTERNALS=1)
        #[arg(long, hide = true)]
        crash: bool,
    },
}

fn invalid(r: &'static str, detail: impl Into<String>) -> ExtError {
    ExtError::from(Refusal::invalid(r, detail))
}

/// Removes what a refused stage created: the staging directory once the extraction has created it, then
/// `extensions/staging/` and `extensions/` when they are left empty.
struct Cleanup {
    dest: PathBuf,
    /// Set once `extract` has created `dest`.
    dest_created: bool,
    staging: PathBuf,
    root: Option<PathBuf>,
    armed: bool,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if self.armed {
            if self.dest_created {
                let _ = std::fs::remove_dir_all(&self.dest);
            }
            // `remove_dir` removes only an empty directory.
            let _ = std::fs::remove_dir(&self.staging);
            if let Some(root) = &self.root {
                let _ = std::fs::remove_dir(root);
            }
        }
    }
}

fn rel_of(base: &Path, p: &Path) -> Result<String, ExtError> {
    let rel = p.strip_prefix(base).expect("walked under base");
    let mut parts = Vec::new();
    for c in rel.components() {
        match c.as_os_str().to_str() {
            Some(s) => parts.push(s.to_string()),
            None => {
                return Err(invalid(
                    reason::UNSAFE_ENTRY,
                    format!("{}: the name is not UTF-8", p.display()),
                ))
            }
        }
    }
    Ok(parts.join("/"))
}

/// Every regular file under `dir` (payload-relative, `/`-separated); a symlink or special file refuses.
fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> Result<(), ExtError> {
    let entries = std::fs::read_dir(dir).map_err(|e| io_error("cannot read", dir, &e))?;
    for e in entries {
        let e = e.map_err(|e| io_error("cannot read", dir, &e))?;
        let path = e.path();
        let t = std::fs::symlink_metadata(&path)
            .map_err(|e| io_error("cannot stat", &path, &e))?
            .file_type();
        if t.is_dir() {
            walk(base, &path, out)?;
        } else if t.is_file() {
            out.push((rel_of(base, &path)?, path));
        } else {
            return Err(invalid(
                reason::UNSAFE_ENTRY,
                format!(
                    "{}: only regular files and directories are installed",
                    rel_of(base, &path)?
                ),
            ));
        }
    }
    Ok(())
}

/// The staged tree against the manifest: the root layout, then the payload's file set, sizes, hashes and modes.
fn check_tree(dest: &Path, m: &P1xManifest) -> Result<(), ExtError> {
    for e in std::fs::read_dir(dest).map_err(|e| io_error("cannot read", dest, &e))? {
        let e = e.map_err(|e| io_error("cannot read", dest, &e))?;
        let name = e.file_name();
        let t = e
            .file_type()
            .map_err(|x| io_error("cannot stat", &e.path(), &x))?;
        match (name.to_str(), t.is_file(), t.is_dir()) {
            (Some("p1x.json" | "p1x.json.minisig"), true, _) | (Some("payload"), _, true) => {}
            _ => {
                return Err(invalid(
                    reason::UNSAFE_ENTRY,
                    format!("{name:?} is not allowed at the package root"),
                ))
            }
        }
    }
    let payload = dest.join("payload");
    let mut files = Vec::new();
    if payload.is_dir() {
        walk(&payload, &payload, &mut files)?;
    }
    let staged: BTreeSet<String> = files.iter().map(|(r, _)| format!("payload/{r}")).collect();
    let declared: BTreeSet<String> = m.files.keys().cloned().collect();
    if let Some(extra) = staged.difference(&declared).next() {
        return Err(invalid(
            reason::PACKAGE_INVALID,
            format!("{extra:?} was extracted but is not in p1x.json files"),
        ));
    }
    if let Some(missing) = declared.difference(&staged).next() {
        return Err(invalid(
            reason::PACKAGE_INVALID,
            format!("{missing:?} is in p1x.json files but was not extracted"),
        ));
    }
    for (rel, path) in &files {
        let want = &m.files[&format!("payload/{rel}")];
        let size = std::fs::metadata(path)
            .map_err(|e| io_error("cannot stat", path, &e))?
            .len();
        let sha = archive::sha256_file(path).map_err(|e| io_error("cannot read", path, &e))?;
        if size != want.size || sha != want.sha256 {
            return Err(invalid(
                reason::DIGEST,
                format!(
                    "payload/{rel}: {size} bytes with sha256 {sha} after extraction, p1x.json says {} bytes with sha256 {}",
                    want.size, want.sha256
                ),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if want.exec { 0o755 } else { 0o644 };
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
                .map_err(|e| io_error("cannot set the mode of", path, &e))?;
        }
    }
    Ok(())
}

fn read_payload_text(payload: &Path, rel: &str) -> Result<String, ExtError> {
    let p = payload.join(rel);
    match std::fs::read(&p) {
        Ok(b) => String::from_utf8(b)
            .map_err(|e| invalid(reason::PACKAGE_INVALID, format!("{rel} is not UTF-8: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(invalid(
            reason::PACKAGE_INVALID,
            format!("the package has no {rel}"),
        )),
        Err(e) => Err(io_error("cannot read", &p, &e)),
    }
}

/// The kind checks (X1-R22).
fn check_kind(payload: &Path, m: &P1xManifest) -> Result<(), ExtError> {
    match m.kind {
        Kind::Skill => {
            let raw = read_payload_text(payload, "SKILL.md")?;
            validate_skill_md(&raw, &m.name)?;
        }
        Kind::Module | Kind::Channel => {
            let raw = read_payload_text(payload, "module.json")?;
            let mm = crate::modules::manifest::parse_manifest(&raw).map_err(|errs| {
                invalid(
                    reason::PACKAGE_INVALID,
                    format!("module.json: {}", errs.join("; ")),
                )
            })?;
            let kind = mm.kind.as_deref().unwrap_or("module");
            let mut disagree = Vec::new();
            if mm.name != m.name {
                disagree.push(format!("name {:?} (p1x.json: {:?})", mm.name, m.name));
            }
            if mm.version != m.version {
                disagree.push(format!(
                    "version {:?} (p1x.json: {:?})",
                    mm.version, m.version
                ));
            }
            if kind != kind_name(m.kind) {
                disagree.push(format!("kind {kind:?} (p1x.json: {:?})", kind_name(m.kind)));
            }
            if !disagree.is_empty() {
                return Err(invalid(
                    reason::PACKAGE_INVALID,
                    format!(
                        "module.json disagrees with p1x.json: {}",
                        disagree.join(", ")
                    ),
                ));
            }
            let entry = mm
                .entry
                .split('/')
                .fold(payload.to_path_buf(), |p, s| p.join(s));
            if !std::fs::symlink_metadata(&entry).is_ok_and(|md| md.is_file()) {
                return Err(invalid(
                    reason::PACKAGE_INVALID,
                    format!("module.json entry {:?} is not in the package", mm.entry),
                ));
            }
        }
        Kind::McpServer | Kind::Provider | Kind::Bundle => {
            return Err(ExtError::new(
                "E_NOT_AVAILABLE",
                reason::KIND_UNSUPPORTED,
                format!("{} packages arrive in X2", kind_name(m.kind)),
            ))
        }
    }
    Ok(())
}

fn strip_payload(p: &str) -> String {
    p.strip_prefix("payload/").unwrap_or(p).to_string()
}

fn record_of(rec: &InspectionRecord, m: &P1xManifest) -> ItemRecord {
    let required_secrets = m.capabilities["secrets"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|s| s["required"].as_bool() == Some(true))
                .filter_map(|s| s["slot"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let scripts = rec
        .scripts
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| s["path"].as_str().map(strip_payload))
                .collect()
        })
        .unwrap_or_default();
    ItemRecord {
        id: m.id.clone(),
        name: m.name.clone(),
        kind: kind_name(m.kind).to_string(),
        version: m.version.clone(),
        source: "file".into(),
        trust: rec.trust["tier"].as_str().unwrap_or("unsigned").to_string(),
        key_id: rec.trust["keyId"].as_str().map(str::to_string),
        key_label: rec.trust["label"].as_str().map(str::to_string),
        package_sha256: rec.sha256.clone(),
        installed_at: super::now_iso(),
        previous_version: rec
            .replaces
            .as_ref()
            .and_then(|r| r["version"].as_str().map(str::to_string)),
        files: m
            .files
            .iter()
            .map(|(k, v)| (strip_payload(k), v.clone()))
            .collect::<BTreeMap<_, _>>(),
        capabilities: m.capabilities.clone(),
        capabilities_ack: None,
        scripts,
        required_secrets,
        removed_by_user: false,
        integrity: None,
    }
}

/// Extracts and checks an inspected package in staging (see the module documentation).
pub fn stage(layout: &Layout, id: &str) -> Result<StagedItem, ExtError> {
    stage_with(layout, id, false)
}

/// [`stage`], aborting the process right after the extraction when `crash` (the worker's `--crash` test seam).
fn stage_with(layout: &Layout, id: &str, crash: bool) -> Result<StagedItem, ExtError> {
    let rec = super::record::load(layout, id)?;
    let pkg = spool_path(layout, id);
    let actual = archive::sha256_file(&pkg).map_err(|e| io_error("cannot read", &pkg, &e))?;
    if actual != rec.sha256 {
        return Err(invalid(
            reason::DIGEST,
            format!(
                "the inspected package changed: sha256 {actual}, the inspection says {}",
                rec.sha256
            ),
        ));
    }
    let raw = serde_json::to_vec(&rec.manifest).unwrap_or_default();
    let m = parse_manifest(&raw, super::host::reserved_names())?;

    let paths = ExtPaths::of(layout);
    let mut cleanup = Cleanup {
        dest: staging_dir(layout, &m.name, id),
        dest_created: false,
        staging: paths.staging.clone(),
        root: (!paths.root.exists()).then(|| paths.root.clone()),
        armed: true,
    };
    // A leftover of an earlier stage of this same inspection (its name carries the inspection id) is this stage's
    // own: it is replaced, never merged into.
    remove_leftover(&cleanup.dest)?;
    archive::extract(&pkg, &cleanup.dest, 0).map_err(|e| {
        let code = if e.reason() == "io" {
            "E_INTERNAL"
        } else {
            "E_INVALID_PARAMS"
        };
        ExtError::new(code, e.reason(), e.to_string())
    })?;
    cleanup.dest_created = true;
    if crash {
        std::process::abort();
    }
    check_tree(&cleanup.dest, &m)?;
    let dir = cleanup.dest.join("payload");
    check_kind(&dir, &m)?;
    let item = StagedItem {
        name: m.name.clone(),
        kind: m.kind,
        dir,
        record: record_of(&rec, &m),
        package: pkg,
    };
    cleanup.armed = false;
    Ok(item)
}

/// Removes `dest` if something is there (a directory tree, or a file or symlink, which is never followed).
fn remove_leftover(dest: &Path) -> Result<(), ExtError> {
    let r = match std::fs::symlink_metadata(dest) {
        Err(_) => return Ok(()),
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(dest),
        Ok(_) => std::fs::remove_file(dest),
    };
    r.map_err(|e| io_error("cannot remove the leftover", dest, &e))
}

fn to_json<T: Serialize>(what: &str, v: T) -> Result<Value, ExtError> {
    serde_json::to_value(v).map_err(|e| {
        ExtError::new(
            "E_INTERNAL",
            "worker-failed",
            format!("cannot serialise the {what}: {e}"),
        )
    })
}

/// `plur1bus ext __worker …`: runs one operation and prints exactly one JSON line, `{"ok":true,"result":…}` (exit 0)
/// or `{"ok":false,"error":{"code","reason","message","data"}}` (exit 1).
pub fn worker_main(layout: &Layout, args: WorkerArgs) -> ! {
    let sleep = |ms: Option<u64>| {
        if let (Some(ms), true) = (ms, allow_internals()) {
            std::thread::sleep(std::time::Duration::from_millis(ms));
        }
    };
    let result: Result<Value, ExtError> = match args {
        WorkerArgs::Inspect {
            id,
            path,
            stdin,
            sleep_ms,
            crash,
        } => {
            sleep(sleep_ms);
            let src = match (stdin, path) {
                (false, Some(p)) => Source::Path(p),
                _ => Source::Stdin,
            };
            inspect::inspect_with(layout, src, &id, crash && allow_internals())
                .and_then(|r| to_json("inspection", r))
        }
        WorkerArgs::Stage {
            id,
            sleep_ms,
            crash,
        } => {
            sleep(sleep_ms);
            stage_with(layout, &id, crash && allow_internals())
                .and_then(|s| to_json("staged item", s))
        }
    };
    let (line, code) = match result {
        Ok(v) => (json!({ "ok": true, "result": v }), 0),
        Err(e) => (
            json!({
                "ok": false,
                "error": { "code": e.code, "reason": e.reason, "message": e.message, "data": e.data }
            }),
            1,
        ),
    };
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
    std::process::exit(code)
}
