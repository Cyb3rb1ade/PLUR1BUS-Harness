//! `plur1bus setup` (spec §6.5, H3b-b-1, HB8–HB13): nine steps with fixed ids, run in order. The first failed step
//! stops the run and every later one is `skipped` with reason `after-failure`; a step whose result already exists and
//! matches the install manifest is `skipped` with reason `already-installed`. Every directory is staged as
//! `<name>.tmp-<pid>` and renamed into place, so a killed setup leaves nothing half-installed under a final name, and
//! the next run's `state-root` step removes the stray temps (Review Focus 1).
use super::archive::{self, sha256_file};
use super::fetch::{self, FetchError};
use super::manifest::{
    self, CoreUnit, InstallManifest, NodeUnit, PackageUnit, Unit, PROFILE_FULL, PROFILE_HOST,
};
use super::pins::{self, NODE_VERSION};
use super::skills;
use super::targets::Target;
use crate::commands::config::{self as config_cmd, Route};
use crate::output::Out;
use crate::paths::Layout;
use plur1bus_config::Tier;
use plur1bus_rpc::{ConnectOptions, Endpoint};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

pub const STEP_IDS: [&str; 9] = [
    "state-root",
    "runtime.node",
    "runtime.core",
    "modules.bundled",
    "config",
    "skills",
    "service",
    "start",
    "check",
];

/// The questions setup asks, keyed by the `basic`-tier leaf keys of the config schema (HB11). A `basic` key without
/// an entry here fails `setup_asks_only_basic_tier_questions`.
pub const PROMPTS: &[(&str, &str)] = &[
    ("agents", "Name of your first agent"),
    (
        "embedding.useClass",
        "How will you use PLUR1BUS (general, research or commercial)",
    ),
];

/// The NC-licence confirmation, asked only when the use class is not `commercial` (HB11, ADR-006).
pub const NC_QUESTION: &str =
    "The default embedding and reranker models are licensed for non-commercial use only. \
     Accept that licence";

const DEFAULT_AGENT: &str = "main";
const DEFAULT_USE_CLASS: &str = "general";
const USE_CLASSES: [&str; 3] = ["general", "research", "commercial"];

/// The Node archive is about 30 MB (zip ~35 MB); anything far larger is not it.
const NODE_MAX_BYTES: u64 = 256 << 20;
/// A core payload with its production dependencies.
const CORE_MAX_BYTES: u64 = 1 << 30;
const DOWNLOAD_DEADLINE: Duration = Duration::from_secs(15 * 60);
/// `PLUR1BUS_TEST_SETUP_PAUSE_AT=<step id>` sleeps this long before that step (test internals only).
const TEST_PAUSE: Duration = Duration::from_secs(30);

pub struct SetupOpts {
    pub non_interactive: bool,
    pub accept_nc: bool,
    pub no_service: bool,
    pub core_from: Option<PathBuf>,
    pub channel: String,
    pub use_class: Option<String>,
    pub agent: Option<String>,
    /// `--profile`: `host` or `full`; `None` keeps the recorded profile (`full` for a new home, HM2-R9).
    pub profile: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StepResult {
    pub id: &'static str,
    /// `done`, `skipped` or `failed`.
    pub status: &'static str,
    pub reason: Option<String>,
    pub detail: Value,
}

impl StepResult {
    fn done(id: &'static str, detail: Value) -> Self {
        StepResult {
            id,
            status: "done",
            reason: None,
            detail,
        }
    }
    fn skipped(id: &'static str, reason: &str, detail: Value) -> Self {
        StepResult {
            id,
            status: "skipped",
            reason: Some(reason.to_string()),
            detail,
        }
    }
    fn failed(id: &'static str, e: StepError) -> Self {
        let mut detail = json!({ "message": e.message });
        if let Some(h) = e.hint {
            detail["hint"] = json!(h);
        }
        StepResult {
            id,
            status: "failed",
            reason: Some(e.reason),
            detail,
        }
    }
}

/// Why a step failed: a `reason` from the frozen vocabulary (HB16, ⟂EXT 2), a message, and what to try.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepError {
    pub reason: String,
    pub message: String,
    pub hint: Option<String>,
}

impl StepError {
    pub fn new(reason: &str, message: impl Into<String>) -> Self {
        StepError {
            reason: reason.to_string(),
            message: message.into(),
            hint: None,
        }
    }
    pub fn io(path: &Path, e: io::Error) -> Self {
        StepError::new("io", format!("{}: {e}", path.display()))
    }
    fn hint(mut self, h: &str) -> Self {
        self.hint = Some(h.to_string());
        self
    }
}

impl From<FetchError> for StepError {
    fn from(e: FetchError) -> Self {
        let unreachable = e.reason() == "release-unreachable";
        let s = StepError::new(e.reason(), e.to_string());
        if unreachable {
            s.hint("check the network, or set PLUR1BUS_NODE_MIRROR to a reachable mirror")
        } else {
            s
        }
    }
}

impl From<archive::PayloadError> for StepError {
    fn from(e: archive::PayloadError) -> Self {
        StepError::new(e.reason(), e.to_string())
    }
}

impl From<archive::ArchiveError> for StepError {
    fn from(e: archive::ArchiveError) -> Self {
        StepError::new(e.reason(), e.to_string())
    }
}

/// Answers setup's questions: stdin on a terminal, a script in the tests.
pub trait Prompter {
    fn ask(&mut self, key: &str, question: &str, default: &str) -> String;
    fn confirm(&mut self, question: &str) -> bool;
}

/// Asks on stderr (stdout stays the document) and reads a line from stdin; an empty line or end of input takes the
/// default (and "no" for a confirmation).
pub struct StdinPrompter;

impl Prompter for StdinPrompter {
    fn ask(&mut self, _key: &str, question: &str, default: &str) -> String {
        eprint!("{question} [{default}]: ");
        let _ = io::stderr().flush();
        let mut line = String::new();
        match io::stdin().lock().read_line(&mut line) {
            Ok(n) if n > 0 && !line.trim().is_empty() => line.trim().to_string(),
            _ => default.to_string(),
        }
    }
    fn confirm(&mut self, question: &str) -> bool {
        eprint!("{question}? [y/N]: ");
        let _ = io::stderr().flush();
        let mut line = String::new();
        let _ = io::stdin().lock().read_line(&mut line);
        matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes")
    }
}

/// The source of the core payload.
pub enum CoreSource {
    /// `--core-from`: a directory (copied) or a `.tar.gz` (verified only when a payload hash is baked in).
    Local(PathBuf),
    /// `<release base>/core-<version>-<target>.tar.gz`, checked against the baked hash.
    Release { url: String, sha256: String },
}

/// What the steps pass on to each other and to the manifest.
struct Ctx {
    target: Option<Target>,
    prev: Option<InstallManifest>,
    /// The profile this run installs ([`effective_profile`], settled by `state-root` before any write).
    profile: &'static str,
    node: Option<NodeUnit>,
    core: Option<CoreUnit>,
    modules: Vec<PackageUnit>,
    skills: Vec<PackageUnit>,
}

fn test_internals() -> bool {
    std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Ok("1")
}

/// The test seam `PLUR1BUS_TEST_SETUP_PAUSE_AT`: marks the pause with `runtime/setup-paused.tmp-<pid>` (a stray temp
/// the next run removes) and sleeps.
fn maybe_pause(layout: &Layout, id: &str) {
    if !test_internals() || std::env::var("PLUR1BUS_TEST_SETUP_PAUSE_AT").as_deref() != Ok(id) {
        return;
    }
    let marker = layout
        .runtime()
        .join(format!("setup-paused.tmp-{}", std::process::id()));
    let _ = fs::create_dir_all(layout.runtime());
    let _ = fs::write(&marker, id);
    std::thread::sleep(TEST_PAUSE);
    let _ = fs::remove_file(marker);
}

/// Runs the nine steps in order ([`STEP_IDS`]). After every step succeeded it writes the install manifest and
/// appends `setup.complete` to the audit log.
pub fn run_steps(
    out: &Out,
    layout: &Layout,
    o: &SetupOpts,
    ask: &mut dyn Prompter,
) -> Vec<StepResult> {
    let mut ctx = Ctx {
        target: Target::current(),
        prev: manifest::read(layout).ok().flatten(),
        profile: PROFILE_FULL,
        node: None,
        core: None,
        modules: Vec::new(),
        skills: Vec::new(),
    };
    let mut results: Vec<StepResult> = Vec::with_capacity(STEP_IDS.len());
    for id in STEP_IDS {
        if results.iter().any(|r| r.status == "failed") {
            results.push(StepResult::skipped(id, "after-failure", json!({})));
            continue;
        }
        maybe_pause(layout, id);
        let r = match id {
            "state-root" => step_state_root(layout, o, &mut ctx),
            "runtime.node" => step_node(layout, &mut ctx),
            "runtime.core" => step_core(layout, o, &mut ctx),
            "modules.bundled" => step_modules(out, layout, &mut ctx),
            "config" => step_config(out, layout, o, ctx.profile, ask),
            "skills" => step_skills(layout, &mut ctx),
            "service" => step_service(out, layout, o),
            "start" => step_start(out, layout, &mut ctx),
            _ => step_check(layout),
        };
        results.push(r.unwrap_or_else(|e| StepResult::failed(id, e)));
    }
    if results.iter().all(|r| r.status != "failed") {
        if let Err(e) = finish(layout, o, &ctx) {
            let last = results.len() - 1;
            results[last] = StepResult::failed(STEP_IDS[last], e);
        }
    }
    results
}

/// Writes the manifest and the `setup.complete` audit line.
fn finish(layout: &Layout, o: &SetupOpts, ctx: &Ctx) -> Result<(), StepError> {
    let (Some(target), Some(node), Some(core)) = (ctx.target, ctx.node.clone(), ctx.core.clone())
    else {
        return Err(StepError::new("io", "setup did not record every unit"));
    };
    let now = now_ms();
    let m = InstallManifest {
        schema_version: manifest::INSTALL_SCHEMA_VERSION,
        installed_at: ctx.prev.as_ref().map(|p| p.installed_at).unwrap_or(now),
        updated_at: now,
        channel: o.channel.clone(),
        target: target.id().to_string(),
        binary: Unit {
            version: env!("CARGO_PKG_VERSION").to_string(),
            sha256: std::env::current_exe()
                .ok()
                .and_then(|p| sha256_file(&p).ok()),
        },
        node,
        core,
        modules: ctx.modules.clone(),
        skills: ctx.skills.clone(),
        profile: Some(ctx.profile.to_string()),
    };
    manifest::write(layout, &m).map_err(|e| StepError::io(&layout.install_manifest(), e))?;
    crate::audit::append(
        layout,
        "setup.complete",
        &layout.home.to_string_lossy(),
        json!({ "target": m.target, "channel": m.channel, "core": m.core.source, "profile": ctx.profile }),
    )
    .map_err(|e| StepError::io(&layout.audit_log(), e))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- state-root ------------------------------------------------------------------------------------------------

/// The profile a run installs (HM2-R9): the requested one, else the recorded one (`full` when the manifest has none),
/// else `full` for a new home. A request that differs from the recorded profile fails with
/// `profile-change-unsupported` (HB16 vocabulary): until HM4 an installation cannot change profile in place.
pub fn effective_profile(
    requested: Option<&str>,
    recorded: Option<&InstallManifest>,
) -> Result<&'static str, StepError> {
    fn known(p: &str) -> Option<&'static str> {
        match p {
            PROFILE_HOST => Some(PROFILE_HOST),
            PROFILE_FULL => Some(PROFILE_FULL),
            _ => None,
        }
    }
    let requested = match requested {
        Some(r) => Some(known(r).ok_or_else(|| {
            StepError::new(
                "profile-invalid",
                format!("unknown install profile {r:?} (host or full)"),
            )
        })?),
        None => None,
    };
    let Some(recorded) = recorded.map(|m| known(m.profile()).unwrap_or(PROFILE_FULL)) else {
        return Ok(requested.unwrap_or(PROFILE_FULL));
    };
    match requested {
        None => Ok(recorded),
        Some(r) if r == recorded => Ok(recorded),
        Some(r) => {
            let e = StepError::new(
                "profile-change-unsupported",
                format!(
                    "this home is installed with profile {recorded}; changing it to {r} is not supported"
                ),
            );
            Err(if recorded == PROFILE_HOST {
                e.hint("host \u{2192} full arrives with HM4")
            } else {
                e.hint("Hermes on an existing full installation arrives with HM4")
            })
        }
    }
}

/// Settles the profile first (a refused profile change writes nothing), then creates the home tree (§6.1) with `run/`
/// private, and removes what a killed setup left: every `*.tmp-*` entry in the home, `runtime/` and `skills/` (never
/// this process's own).
fn step_state_root(layout: &Layout, o: &SetupOpts, ctx: &mut Ctx) -> Result<StepResult, StepError> {
    ctx.profile = effective_profile(o.profile.as_deref(), ctx.prev.as_ref())?;
    for d in [
        layout.home.clone(),
        layout.state(),
        layout.logs(),
        layout.runtime(),
        layout.skills(),
        layout.models(),
        layout.modules_dir(),
        layout.home.join("agents"),
    ] {
        fs::create_dir_all(&d).map_err(|e| StepError::io(&d, e))?;
    }
    let run = layout.run();
    fs::create_dir_all(&run).map_err(|e| StepError::io(&run, e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&run, fs::Permissions::from_mode(0o700))
            .map_err(|e| StepError::io(&run, e))?;
    }
    let mut removed = Vec::new();
    for dir in [layout.home.clone(), layout.runtime(), layout.skills()] {
        removed.extend(remove_stray_temps(&dir));
    }
    Ok(StepResult::done(
        "state-root",
        json!({ "home": layout.home, "removedTemps": removed, "profile": ctx.profile }),
    ))
}

/// Removes every entry of `dir` whose name contains `.tmp-` and is not this process's own; returns the names.
fn remove_stray_temps(dir: &Path) -> Vec<String> {
    let own = format!(".tmp-{}", std::process::id());
    let mut removed = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else {
        return removed;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.contains(".tmp-") || name.contains(&own) {
            continue;
        }
        let p = e.path();
        let gone = if e.file_type().is_ok_and(|t| t.is_dir()) {
            fs::remove_dir_all(&p)
        } else {
            fs::remove_file(&p)
        };
        if gone.is_ok() {
            removed.push(name);
        }
    }
    removed.sort();
    removed
}

// ---- runtime.node ----------------------------------------------------------------------------------------------

fn node_bin(dir: &Path, t: Target) -> PathBuf {
    dir.join("bin")
        .join(if t.is_windows() { "node.exe" } else { "node" })
}

fn step_node(layout: &Layout, ctx: &mut Ctx) -> Result<StepResult, StepError> {
    let t = ctx.target.ok_or_else(unsupported_target)?;
    if let Some(prev) = ctx.prev.as_ref().map(|m| &m.node) {
        let path = Path::new(&prev.path);
        if prev.version == NODE_VERSION
            && prev.archive_sha256 == pins::node_sha256(t)
            && sha256_file(path).is_ok_and(|h| h == prev.binary_sha256)
        {
            ctx.node = Some(prev.clone());
            return Ok(StepResult::skipped(
                "runtime.node",
                "already-installed",
                json!({ "path": prev.path, "version": prev.version }),
            ));
        }
    }
    let unit = install_node(layout, t)?;
    let detail =
        json!({ "path": unit.path, "version": unit.version, "binarySha256": unit.binary_sha256 });
    ctx.node = Some(unit);
    Ok(StepResult::done("runtime.node", detail))
}

fn unsupported_target() -> StepError {
    StepError::new(
        "archive-unsupported",
        format!(
            "no release target for {}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
    )
}

/// Downloads `node-v24.21.0-<target>` (from `PLUR1BUS_NODE_MIRROR` or nodejs.org), checks it against the pinned
/// SHA-256, extracts it, moves a Windows zip's root `node.exe` into `bin/` (HB8), and renames the tree to
/// `runtime/node-24.21.0`. Reused by `1staid repair` (Task 7).
pub fn install_node(layout: &Layout, t: Target) -> Result<NodeUnit, StepError> {
    let runtime = layout.runtime();
    fs::create_dir_all(&runtime).map_err(|e| StepError::io(&runtime, e))?;
    let pid = std::process::id();
    let sha = pins::node_sha256(t);
    let download = runtime.join(t.node_archive(NODE_VERSION));
    fetch::fetch_verified(
        &pins::node_url(t),
        &download,
        sha,
        NODE_MAX_BYTES,
        DOWNLOAD_DEADLINE,
    )?;
    let staging = runtime.join(format!("node-{NODE_VERSION}.tmp-{pid}"));
    let _ = fs::remove_dir_all(&staging);
    let extracted = archive::verify_and_extract(&download, sha, &staging, 1);
    let _ = fs::remove_file(&download);
    extracted?;
    let unit = (|| {
        if t.is_windows() {
            normalise_windows_node(&staging)?;
        }
        let bin = node_bin(&staging, t);
        if !bin.is_file() {
            return Err(StepError::new(
                "archive-unsupported",
                format!(
                    "the Node archive has no {}",
                    bin.strip_prefix(&staging).unwrap_or(&bin).display()
                ),
            ));
        }
        let binary_sha256 = sha256_file(&bin).map_err(|e| StepError::io(&bin, e))?;
        let dest = runtime.join(format!("node-{NODE_VERSION}"));
        swap_into_place(&staging, &dest)?;
        let path = std::path::absolute(node_bin(&dest, t)).unwrap_or_else(|_| node_bin(&dest, t));
        Ok(NodeUnit {
            version: NODE_VERSION.to_string(),
            archive_sha256: sha.to_string(),
            binary_sha256,
            path: path.to_string_lossy().into_owned(),
        })
    })();
    if unit.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    unit
}

/// The Windows zip has `node.exe` at its root; the runtime layout has it in `bin/` on every OS (HB8).
fn normalise_windows_node(dir: &Path) -> Result<(), StepError> {
    let root_exe = dir.join("node.exe");
    if root_exe.is_file() && !dir.join("bin").join("node.exe").exists() {
        let bin = dir.join("bin");
        fs::create_dir_all(&bin).map_err(|e| StepError::io(&bin, e))?;
        fs::rename(&root_exe, bin.join("node.exe")).map_err(|e| StepError::io(&root_exe, e))?;
    }
    Ok(())
}

/// Renames the staged `staging` onto `dest`, replacing an existing `dest` (moved aside as `<dest>.tmp-<pid>.old`
/// first and removed afterwards).
fn swap_into_place(staging: &Path, dest: &Path) -> Result<(), StepError> {
    let old = PathBuf::from(format!("{}.tmp-{}.old", dest.display(), std::process::id()));
    if dest.exists() {
        let _ = fs::remove_dir_all(&old);
        fs::rename(dest, &old).map_err(|e| StepError::io(dest, e))?;
    }
    if let Err(e) = fs::rename(staging, dest) {
        if old.exists() {
            let _ = fs::rename(&old, dest);
        }
        return Err(StepError::io(dest, e));
    }
    let _ = fs::remove_dir_all(&old);
    Ok(())
}

// ---- runtime.core ----------------------------------------------------------------------------------------------

fn step_core(layout: &Layout, o: &SetupOpts, ctx: &mut Ctx) -> Result<StepResult, StepError> {
    let src = match &o.core_from {
        Some(p) => CoreSource::Local(std::path::absolute(p).unwrap_or_else(|_| p.clone())),
        None => {
            let t = ctx.target.ok_or_else(unsupported_target)?;
            match (pins::release_base_url(), pins::core_payload_sha256()) {
                (Some(base), Some(sha)) => CoreSource::Release {
                    url: format!(
                        "{}/core-{}-{}.tar.gz",
                        base.trim_end_matches('/'),
                        env!("CARGO_PKG_VERSION"),
                        t.id()
                    ),
                    sha256: sha.to_string(),
                },
                _ => {
                    return Err(StepError::new(
                        "core-source-missing",
                        "this build has no release payload to install the core from",
                    )
                    .hint("pass --core-from <dir>"))
                }
            }
        }
    };
    if let (CoreSource::Release { sha256, .. }, Some(prev)) = (&src, &ctx.prev) {
        if prev.core.sha256.as_deref() == Some(sha256.as_str())
            && layout.runtime().join("core").join("core.js").is_file()
        {
            ctx.core = Some(prev.core.clone());
            return Ok(StepResult::skipped(
                "runtime.core",
                "already-installed",
                json!({ "version": prev.core.version }),
            ));
        }
    }
    let unit = install_core(layout, src)?;
    let detail = json!({ "version": unit.version, "source": unit.source, "path": layout.runtime().join("core") });
    ctx.core = Some(unit);
    Ok(StepResult::done("runtime.core", detail))
}

/// Installs the core payload to `runtime/core` through a staged swap; the previous tree is kept as
/// `runtime/core.prev` until the core has started (setup's `start` step removes it). Reused by `1staid repair`.
pub fn install_core(layout: &Layout, src: CoreSource) -> Result<CoreUnit, StepError> {
    let runtime = layout.runtime();
    fs::create_dir_all(&runtime).map_err(|e| StepError::io(&runtime, e))?;
    let pid = std::process::id();
    let staging = runtime.join(format!("core.tmp-{pid}"));
    let _ = fs::remove_dir_all(&staging);
    let missing = |p: &Path| {
        StepError::new(
            "core-source-missing",
            format!("no core payload at {}", p.display()),
        )
        .hint("pass --core-from <dir>")
    };
    let (source, sha256) = match &src {
        CoreSource::Local(p) if p.is_dir() => {
            copy_tree(p, &staging)?;
            ("local", None)
        }
        CoreSource::Local(p) if p.is_file() => {
            match pins::core_payload_sha256() {
                Some(sha) => archive::verify_and_extract(p, sha, &staging, 0)?,
                None => archive::extract(p, &staging, 0)?,
            }
            ("local", pins::core_payload_sha256().map(str::to_string))
        }
        CoreSource::Local(p) => return Err(missing(p)),
        CoreSource::Release { url, sha256 } => {
            let download = runtime.join(format!("core-download.tar.gz.tmp-{pid}"));
            let fetched =
                fetch::fetch_verified(url, &download, sha256, CORE_MAX_BYTES, DOWNLOAD_DEADLINE);
            let extracted = fetched.map_err(StepError::from).and_then(|_| {
                archive::verify_and_extract(&download, sha256, &staging, 0).map_err(StepError::from)
            });
            let _ = fs::remove_file(&download);
            extracted?;
            ("release", Some(sha256.clone()))
        }
    };
    let unit = (|| {
        let root = payload_root(&staging).ok_or_else(|| {
            StepError::new("core-source-missing", "the core payload has no core.js")
                .hint("pass --core-from <dir> holding core.js")
        })?;
        let package: Value = fs::read_to_string(root.join("package.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(Value::Null);
        let field = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_string);
        let unit = CoreUnit {
            version: field(&package["version"]).unwrap_or_else(|| "0.0.0".to_string()),
            contract: field(&package["plur1bus"]["contract"])
                .unwrap_or_else(|| "unknown".to_string()),
            rpc: field(&package["plur1bus"]["rpc"]).unwrap_or_else(|| "unknown".to_string()),
            sha256,
            source: source.to_string(),
        };
        if root != staging {
            // A tarball with one top-level directory: that directory is the payload.
            let inner = runtime.join(format!("core.tmp-{pid}.inner"));
            fs::rename(&root, &inner).map_err(|e| StepError::io(&root, e))?;
            fs::remove_dir_all(&staging).map_err(|e| StepError::io(&staging, e))?;
            fs::rename(&inner, &staging).map_err(|e| StepError::io(&staging, e))?;
        }
        let dest = runtime.join("core");
        let prev = runtime.join("core.prev");
        if dest.exists() {
            let _ = fs::remove_dir_all(&prev);
            fs::rename(&dest, &prev).map_err(|e| StepError::io(&dest, e))?;
        }
        if let Err(e) = fs::rename(&staging, &dest) {
            if prev.exists() {
                let _ = fs::rename(&prev, &dest);
            }
            return Err(StepError::io(&dest, e));
        }
        Ok(unit)
    })();
    if unit.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    unit
}

/// The directory holding `core.js`: `dir` itself, or its only subdirectory.
fn payload_root(dir: &Path) -> Option<PathBuf> {
    if dir.join("core.js").is_file() {
        return Some(dir.to_path_buf());
    }
    let entries: Vec<_> = fs::read_dir(dir).ok()?.flatten().collect();
    match entries.as_slice() {
        [one] if one.path().join("core.js").is_file() => Some(one.path()),
        _ => None,
    }
}

/// Copies the tree `from` to the new directory `to`. On unix a symlink is recreated as it is (a `pnpm deploy`
/// payload links into `node_modules/.pnpm`); on Windows its target is copied.
pub(crate) fn copy_tree(from: &Path, to: &Path) -> Result<(), StepError> {
    fs::create_dir_all(to).map_err(|e| StepError::io(to, e))?;
    for entry in fs::read_dir(from).map_err(|e| StepError::io(from, e))? {
        let entry = entry.map_err(|e| StepError::io(from, e))?;
        let src = entry.path();
        let dest = to.join(entry.file_name());
        let ty = entry.file_type().map_err(|e| StepError::io(&src, e))?;
        if ty.is_symlink() {
            #[cfg(unix)]
            {
                let target = fs::read_link(&src).map_err(|e| StepError::io(&src, e))?;
                std::os::unix::fs::symlink(target, &dest).map_err(|e| StepError::io(&dest, e))?;
                continue;
            }
            #[cfg(windows)]
            {
                if src.is_dir() {
                    copy_tree(&src, &dest)?;
                } else {
                    fs::copy(&src, &dest).map_err(|e| StepError::io(&src, e))?;
                }
                continue;
            }
        }
        if ty.is_dir() {
            copy_tree(&src, &dest)?;
        } else {
            fs::copy(&src, &dest).map_err(|e| StepError::io(&src, e))?;
        }
    }
    Ok(())
}

// ---- modules.bundled -------------------------------------------------------------------------------------------

/// Every `runtime/core/modules/*/module.json` is installed through the one module commit path (⟂EXT 3): the
/// supervisor's `module.install` when one answers, else `modules::install::{stage, commit}` under the offline lock.
fn step_modules(out: &Out, layout: &Layout, ctx: &mut Ctx) -> Result<StepResult, StepError> {
    if ctx.profile == PROFILE_HOST {
        return Ok(StepResult::skipped(
            "modules.bundled",
            "profile-host",
            json!({}),
        ));
    }
    let bundled = layout.runtime().join("core").join("modules");
    let mut dirs: Vec<PathBuf> = fs::read_dir(&bundled)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.join("module.json").is_file())
                .collect()
        })
        .unwrap_or_default();
    dirs.sort();
    if dirs.is_empty() {
        return Ok(StepResult::skipped("modules.bundled", "none", json!({})));
    }
    let mut installed = Vec::new();
    for dir in dirs {
        let (name, version) = match config_cmd::route(layout) {
            Ok(Route::Supervisor(mut c)) => {
                let v = config_cmd::call(
                    &mut c,
                    "module.install",
                    json!({ "path": dir.to_string_lossy() }),
                )
                .map_err(|e| StepError::new("io", e.to_string()))?;
                (
                    v["name"].as_str().unwrap_or_default().to_string(),
                    v["version"].as_str().unwrap_or_default().to_string(),
                )
            }
            Ok(Route::Direct) => {
                let _lock = crate::commands::module::offline_lock(out, layout);
                let (m, _) = crate::modules::install::install(layout, &dir)
                    .map_err(|e| StepError::new(e.reason(), e.to_string()))?;
                (m.name, m.version)
            }
            Err(e) => return Err(StepError::new("io", e.to_string())),
        };
        installed.push(json!({ "name": name, "version": version }));
        ctx.modules.push(PackageUnit {
            name,
            version,
            source: "bundled".to_string(),
            sha256: None,
        });
    }
    Ok(StepResult::done(
        "modules.bundled",
        json!({ "installed": installed }),
    ))
}

// ---- config ----------------------------------------------------------------------------------------------------

/// The answers to setup's questions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigAnswers {
    /// `None`: no first agent (the host profile without `--agent`, HM2-R9).
    pub agent: Option<String>,
    pub use_class: String,
    pub accept_nc: bool,
}

fn valid_agent_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// Asks [`PROMPTS`] in order (flags give the defaults), or takes the flags and the defaults with
/// `--non-interactive`, then the NC-licence gate: asked only when the use class is not `commercial`, and
/// `--non-interactive` accepts only with `--accept-nc-licence` (HB11). Without `--use-class` the default is the
/// `recorded_use_class` of the existing configuration, so a re-run never switches the licence class silently (HM2
/// F3); `general` only for a new home. The host profile creates no first agent unless `--agent` names one and never
/// asks for it (HM2-R9).
pub fn answer_config(
    o: &SetupOpts,
    profile: &str,
    recorded_use_class: Option<&str>,
    ask: &mut dyn Prompter,
) -> Result<ConfigAnswers, StepError> {
    let host = profile == PROFILE_HOST;
    let mut agent = o.agent.clone().unwrap_or_else(|| DEFAULT_AGENT.to_string());
    let mut use_class = o.use_class.clone().unwrap_or_else(|| {
        recorded_use_class
            .filter(|c| USE_CLASSES.contains(c))
            .unwrap_or(DEFAULT_USE_CLASS)
            .to_string()
    });
    if !o.non_interactive {
        for (key, question) in PROMPTS {
            if host && *key == "agents" {
                continue;
            }
            let (slot, valid): (&mut String, fn(&str) -> bool) = match *key {
                "agents" => (&mut agent, valid_agent_id),
                "embedding.useClass" => (&mut use_class, |v| USE_CLASSES.contains(&v)),
                other => unreachable!("no answer slot for {other}"),
            };
            let default = slot.clone();
            // An invalid answer is asked again; the default (valid) ends the loop at end of input.
            loop {
                let a = ask.ask(key, question, &default);
                if valid(&a) {
                    *slot = a;
                    break;
                }
                eprintln!("{a:?} is not a valid answer");
            }
        }
    }
    let agent = if host && o.agent.is_none() {
        None
    } else {
        Some(agent)
    };
    if let Some(agent) = agent.as_deref().filter(|a| !valid_agent_id(a)) {
        return Err(StepError::new(
            "agent-id-invalid",
            format!("agent id {agent:?} must match ^[a-z0-9][a-z0-9_-]{{0,63}}$"),
        ));
    }
    let accept_nc = use_class != "commercial"
        && (o.accept_nc || (!o.non_interactive && ask.confirm(NC_QUESTION)));
    Ok(ConfigAnswers {
        agent,
        use_class,
        accept_nc,
    })
}

/// The `config.set` changes for `a` against the current `config`: the agent only when it is not registered yet,
/// the use class when it differs, the licence fields only for a new acceptance (an existing one is never revoked).
fn config_changes(config: &Value, a: &ConfigAnswers, now: &str) -> Vec<(String, Value)> {
    let mut changes = Vec::new();
    if let Some(agent) = a
        .agent
        .as_deref()
        .filter(|id| config["agents"].get(id).is_none())
    {
        changes.push((format!("agents.{agent}"), json!({ "createdAt": now })));
    }
    if config["embedding"]["useClass"].as_str() != Some(a.use_class.as_str()) {
        changes.push(("embedding.useClass".to_string(), json!(a.use_class)));
    }
    if a.accept_nc && config["embedding"]["acceptedNcLicence"] != json!(true) {
        changes.push(("embedding.acceptedNcLicence".to_string(), json!(true)));
        changes.push(("embedding.acceptedNcLicenceAt".to_string(), json!(now)));
    }
    changes
}

fn step_config(
    out: &Out,
    layout: &Layout,
    o: &SetupOpts,
    profile: &str,
    ask: &mut dyn Prompter,
) -> Result<StepResult, StepError> {
    let config = match plur1bus_config::read(&layout.config_path()) {
        Ok(c) => c,
        Err(_) if !layout.config_path().exists() => Value::Null,
        Err(e) => return Err(StepError::new("config-invalid", e.to_string())),
    };
    let answers = answer_config(o, profile, config["embedding"]["useClass"].as_str(), ask)?;
    let now = crate::commands::agent::rfc3339_now();
    let changes = config_changes(&config, &answers, &now);
    let accepted = changes
        .iter()
        .any(|(k, _)| k == "embedding.acceptedNcLicence");
    let keys: Vec<String> = changes.iter().map(|(k, _)| k.clone()).collect();
    let mut supervised = false;
    if !changes.is_empty() {
        // One config.set for everything (a running supervisor emits one config.changed); failures print and exit.
        supervised = config_cmd::apply(out, layout, changes, None, true, false).supervised;
    }
    if accepted {
        crate::audit::append(
            layout,
            "licence.accept-nc",
            "embedding.acceptedNcLicence",
            json!({ "useClass": answers.use_class, "acceptedAt": now }),
        )
        .map_err(|e| StepError::io(&layout.audit_log(), e))?;
    }
    if let Some(agent) = answers.agent.as_deref() {
        let ws = layout.workspace_dir(agent);
        fs::create_dir_all(&ws).map_err(|e| StepError::io(&ws, e))?;
    }
    Ok(StepResult::done(
        "config",
        json!({
            "agent": answers.agent,
            "useClass": answers.use_class,
            "acceptedNcLicence": answers.accept_nc || config["embedding"]["acceptedNcLicence"] == json!(true),
            "changed": keys,
            "supervised": supervised,
        }),
    ))
}

// ---- skills ----------------------------------------------------------------------------------------------------

fn step_skills(layout: &Layout, ctx: &mut Ctx) -> Result<StepResult, StepError> {
    if ctx.profile == PROFILE_HOST {
        return Ok(StepResult::skipped("skills", "profile-host", json!({})));
    }
    let from = layout.runtime().join("core").join("skills");
    if !from.is_dir() {
        return Ok(StepResult::skipped("skills", "none", json!({})));
    }
    let units = skills::copy_skills(layout, &from)?;
    let names: Vec<&str> = units.iter().map(|u| u.name.as_str()).collect();
    let detail = json!({ "installed": names, "path": layout.skills() });
    ctx.skills = units;
    Ok(StepResult::done("skills", detail))
}

// ---- service ---------------------------------------------------------------------------------------------------

/// Registers the OS service without starting it (`start` below starts the supervisor either way).
fn step_service(out: &Out, layout: &Layout, o: &SetupOpts) -> Result<StepResult, StepError> {
    if o.no_service {
        return Ok(StepResult::skipped("service", "no-service", json!({})));
    }
    let unavailable = |msg: String| {
        StepError::new("service-unavailable", msg)
            .hint("re-run with --no-service and start the supervisor with `plur1bus daemon start`")
    };
    let manager = crate::service::Manager::current();
    let bin = std::env::current_exe()
        .map_err(|e| unavailable(format!("cannot locate the plur1bus binary: {e}")))?;
    let name = crate::service::service_name(layout, &crate::paths::default_home());
    let unit = crate::service::render(manager, &bin, layout, &name, &[])
        .map_err(|e| unavailable(e.to_string()))?;
    // launchd opens StandardErrorPath there before `supervise` creates the directory itself.
    fs::create_dir_all(layout.logs()).map_err(|e| StepError::io(&layout.logs(), e))?;
    let runner = crate::commands::service::runner(out);
    crate::service::install(runner.as_ref(), &unit, false)
        .map_err(|e| unavailable(e.to_string()))?;
    Ok(StepResult::done(
        "service",
        json!({ "manager": manager, "name": unit.name, "path": unit.path }),
    ))
}

// ---- start -----------------------------------------------------------------------------------------------------

/// `daemon start` (it prints and exits on failure). Once the core is ready, reads its contract and RPC versions for
/// the manifest and drops `runtime/core.prev`.
fn step_start(out: &Out, layout: &Layout, ctx: &mut Ctx) -> Result<StepResult, StepError> {
    let (started, via, status) = crate::commands::daemon::start(out, layout, false);
    let state = crate::commands::daemon::core_child(&status)
        .map(|c| c["process"]["state"].clone())
        .unwrap_or(Value::Null);
    if let (Some(core), Some(s)) = (ctx.core.as_mut(), core_status(layout)) {
        if let Some(c) = s["contract"].as_str() {
            core.contract = c.to_string();
        }
        if let Some(r) = s["rpc"].as_str() {
            core.rpc = r.to_string();
        }
    }
    let _ = fs::remove_dir_all(layout.runtime().join("core.prev"));
    Ok(StepResult::done(
        "start",
        json!({ "started": started, "via": via, "core": state }),
    ))
}

/// The core's own `core.status`, or `None` when it does not answer.
fn core_status(layout: &Layout) -> Option<Value> {
    let token = fs::read_to_string(layout.core_token()).ok()?;
    let platform = if cfg!(windows) { "windows" } else { "posix" };
    let address = layout
        .endpoints(&crate::supervisor::Role::core(), platform)
        .address;
    let opts = ConnectOptions {
        connect_timeout: Duration::from_secs(2),
        call_timeout: Duration::from_secs(5),
        endpoint: Endpoint::Core,
        expected_server_pid: None, // set by connect_recorded
    };
    let mut client =
        crate::commands::connect_recorded(layout, &address, token.trim(), opts).ok()?;
    client.call("core.status", json!({})).ok()
}

// ---- check -----------------------------------------------------------------------------------------------------

/// Runs `plur1bus --home <home> --json 1staid check` as a child process and summarises it.
fn step_check(layout: &Layout) -> Result<StepResult, StepError> {
    let unavailable = |m: String| StepError::new("check-unavailable", m);
    let bin = std::env::current_exe()
        .map_err(|e| unavailable(format!("cannot locate the plur1bus binary: {e}")))?;
    let output = Command::new(bin)
        .arg("--home")
        .arg(&layout.home)
        .args(["--json", "1staid", "check"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| unavailable(format!("cannot run 1staid check: {e}")))?;
    let doc: Value = serde_json::from_slice(&output.stdout).map_err(|e| {
        unavailable(format!(
            "1staid check printed no document ({e}): {}",
            String::from_utf8_lossy(&output.stdout)
        ))
    })?;
    let checks = doc["checks"]
        .as_array()
        .ok_or_else(|| unavailable(format!("1staid check answered {doc}")))?;
    Ok(StepResult::done("check", summarise(checks)))
}

/// `{ ok, warn, fail, failing }` of `1staid check`'s rows.
fn summarise(checks: &[Value]) -> Value {
    let count = |s: &str| checks.iter().filter(|c| c["status"] == s).count();
    let failing: Vec<&str> = checks
        .iter()
        .filter(|c| c["status"] == "fail")
        .filter_map(|c| c["id"].as_str())
        .collect();
    json!({ "ok": count("ok"), "warn": count("warn"), "fail": count("fail"), "failing": failing })
}

/// The `basic`-tier leaf keys of a (tier-filtered) config schema: every node that declares `x-tier`, reached through
/// unannotated containers, minus the `x-reserved` placeholders of later milestones.
pub fn basic_tier_keys(schema: &Value) -> Vec<String> {
    fn walk(node: &Value, prefix: &str, out: &mut Vec<String>) {
        let Some(props) = node.get("properties").and_then(Value::as_object) else {
            return;
        };
        for (k, v) in props {
            let key = if prefix.is_empty() {
                k.clone()
            } else {
                format!("{prefix}.{k}")
            };
            if v.get("x-tier").is_some() {
                if v.get("x-reserved").is_none() {
                    out.push(key);
                }
            } else {
                walk(v, &key, out);
            }
        }
    }
    let filtered = plur1bus_config::filter_schema_by_tier(schema, Tier::Basic);
    let mut out = Vec::new();
    walk(&filtered, "", &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(non_interactive: bool) -> SetupOpts {
        SetupOpts {
            non_interactive,
            accept_nc: false,
            no_service: true,
            core_from: None,
            channel: "stable".into(),
            use_class: None,
            agent: None,
            profile: None,
        }
    }

    /// Answers from a script and records every question.
    struct Scripted {
        answers: Vec<&'static str>,
        asked: Vec<(String, String)>,
        confirms: Vec<String>,
        confirm_with: bool,
    }
    impl Prompter for Scripted {
        fn ask(&mut self, key: &str, question: &str, default: &str) -> String {
            self.asked.push((key.to_string(), question.to_string()));
            if self.answers.is_empty() {
                default.to_string()
            } else {
                self.answers.remove(0).to_string()
            }
        }
        fn confirm(&mut self, question: &str) -> bool {
            self.confirms.push(question.to_string());
            self.confirm_with
        }
    }

    fn scripted(answers: Vec<&'static str>, confirm_with: bool) -> Scripted {
        Scripted {
            answers,
            asked: Vec::new(),
            confirms: Vec::new(),
            confirm_with,
        }
    }

    #[test]
    fn setup_asks_only_basic_tier_questions() {
        let schema: Value = serde_json::from_str(plur1bus_config::SCHEMA_JSON).unwrap();
        let mut keys = basic_tier_keys(&schema);
        keys.sort();
        let mut prompt_keys: Vec<String> = PROMPTS.iter().map(|(k, _)| k.to_string()).collect();
        prompt_keys.sort();
        assert_eq!(keys, prompt_keys, "every basic-tier key needs a prompt");

        let mut p = scripted(vec!["bernd", "commercial"], true);
        let a = answer_config(&opts(false), "full", None, &mut p).unwrap();
        let expected: Vec<(String, String)> = PROMPTS
            .iter()
            .map(|(k, q)| (k.to_string(), q.to_string()))
            .collect();
        assert_eq!(p.asked, expected);
        assert!(
            p.confirms.is_empty(),
            "commercial never asks the NC question"
        );
        assert_eq!(
            a,
            ConfigAnswers {
                agent: Some("bernd".into()),
                use_class: "commercial".into(),
                accept_nc: false
            }
        );
    }

    #[test]
    fn the_nc_question_is_asked_unless_commercial_and_invalid_answers_are_asked_again() {
        let mut p = scripted(vec!["Not An Id", "anna", "sometimes", "research"], true);
        let a = answer_config(&opts(false), "full", None, &mut p).unwrap();
        assert_eq!(p.asked.len(), 4);
        assert_eq!(p.confirms, [NC_QUESTION]);
        assert_eq!(
            (a.agent.as_deref(), a.use_class.as_str(), a.accept_nc),
            (Some("anna"), "research", true)
        );
    }

    #[test]
    fn non_interactive_takes_flags_and_defaults_and_never_asks() {
        let mut p = scripted(vec![], true);
        let a = answer_config(&opts(true), "full", None, &mut p).unwrap();
        assert!(p.asked.is_empty() && p.confirms.is_empty());
        assert_eq!(
            (a.agent.as_deref(), a.use_class.as_str(), a.accept_nc),
            (Some("main"), "general", false)
        );
        let mut o = opts(true);
        o.accept_nc = true;
        o.use_class = Some("commercial".into());
        assert!(
            !answer_config(&o, "full", None, &mut p).unwrap().accept_nc,
            "commercial needs no NC licence"
        );
        o.use_class = Some("research".into());
        assert!(answer_config(&o, "full", None, &mut p).unwrap().accept_nc);
        o.agent = Some("Bad Id".into());
        assert_eq!(
            answer_config(&o, "full", None, &mut p).unwrap_err().reason,
            "agent-id-invalid"
        );
    }

    #[test]
    fn config_changes_add_only_what_is_missing_and_never_revoke() {
        let a = ConfigAnswers {
            agent: Some("main".into()),
            use_class: "general".into(),
            accept_nc: true,
        };
        let keys = |c: Vec<(String, Value)>| c.into_iter().map(|(k, _)| k).collect::<Vec<_>>();
        assert_eq!(
            keys(config_changes(&Value::Null, &a, "2026-09-28T00:00:00Z")),
            [
                "agents.main",
                "embedding.useClass",
                "embedding.acceptedNcLicence",
                "embedding.acceptedNcLicenceAt"
            ]
        );
        let done = json!({ "agents": { "main": {} }, "embedding": { "useClass": "general", "acceptedNcLicence": true } });
        assert!(config_changes(&done, &a, "x").is_empty());
        let not_accepting = ConfigAnswers {
            accept_nc: false,
            ..a
        };
        assert!(config_changes(&done, &not_accepting, "x").is_empty());
        let no_agent = ConfigAnswers {
            agent: None,
            ..not_accepting
        };
        assert_eq!(
            keys(config_changes(&Value::Null, &no_agent, "x")),
            ["embedding.useClass"],
            "the host profile adds no agent"
        );
    }

    fn manifest_with(profile: Option<&str>) -> InstallManifest {
        let h = "a".repeat(64);
        InstallManifest {
            schema_version: 1,
            installed_at: 1,
            updated_at: 1,
            channel: "stable".into(),
            target: "linux-x64".into(),
            binary: Unit {
                version: "0.1.0".into(),
                sha256: None,
            },
            node: NodeUnit {
                version: NODE_VERSION.into(),
                archive_sha256: h.clone(),
                binary_sha256: h,
                path: "/n".into(),
            },
            core: CoreUnit {
                version: "0.1.0".into(),
                contract: "1.9.0".into(),
                rpc: "1.4.0".into(),
                sha256: None,
                source: "local".into(),
            },
            modules: vec![],
            skills: vec![],
            profile: profile.map(str::to_string),
        }
    }

    #[test]
    fn effective_profile_keeps_the_recorded_one_and_refuses_a_change() {
        let host = manifest_with(Some("host"));
        let full = manifest_with(Some("full"));
        let legacy = manifest_with(None);
        for (requested, recorded, want) in [
            (None, None, Ok("full")),
            (Some("host"), None, Ok("host")),
            (Some("full"), None, Ok("full")),
            (None, Some(&host), Ok("host")),
            (Some("host"), Some(&host), Ok("host")),
            (None, Some(&full), Ok("full")),
            (Some("full"), Some(&full), Ok("full")),
            (None, Some(&legacy), Ok("full")),
            (Some("full"), Some(&legacy), Ok("full")),
            (Some("full"), Some(&host), Err("profile-change-unsupported")),
            (Some("host"), Some(&full), Err("profile-change-unsupported")),
            (
                Some("host"),
                Some(&legacy),
                Err("profile-change-unsupported"),
            ),
            (Some("tiny"), None, Err("profile-invalid")),
        ] {
            let got = effective_profile(requested, recorded).map_err(|e| e.reason);
            assert_eq!(
                got,
                want.map_err(str::to_string),
                "{requested:?} over {:?}",
                recorded.map(|m| &m.profile)
            );
        }
        let e = effective_profile(Some("full"), Some(&host)).unwrap_err();
        assert_eq!(
            e.hint.as_deref(),
            Some("host \u{2192} full arrives with HM4")
        );
    }

    #[test]
    fn the_host_profile_asks_no_agent_and_creates_none_unless_named() {
        let mut p = scripted(vec!["commercial"], true);
        let a = answer_config(&opts(false), "host", None, &mut p).unwrap();
        let asked: Vec<&str> = p.asked.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(asked, ["embedding.useClass"]);
        assert_eq!((a.agent, a.use_class.as_str()), (None, "commercial"));
        let mut o = opts(true);
        o.agent = Some("hermes-default".into());
        let a = answer_config(&o, "host", None, &mut p).unwrap();
        assert_eq!(a.agent.as_deref(), Some("hermes-default"));
        o.agent = Some("Bad Id".into());
        assert_eq!(
            answer_config(&o, "host", None, &mut p).unwrap_err().reason,
            "agent-id-invalid"
        );
    }

    /// HM2 F3: without `--use-class` a re-run keeps the recorded class; an explicit class still wins.
    #[test]
    fn the_recorded_use_class_is_the_default() {
        let mut p = scripted(vec![], false);
        let a = answer_config(&opts(true), "host", Some("commercial"), &mut p).unwrap();
        assert_eq!((a.use_class.as_str(), a.accept_nc), ("commercial", false));
        let mut o = opts(true);
        o.use_class = Some("research".into());
        assert_eq!(
            answer_config(&o, "full", Some("commercial"), &mut p)
                .unwrap()
                .use_class,
            "research"
        );
        let mut p = scripted(vec![], false);
        let a = answer_config(&opts(false), "full", Some("research"), &mut p).unwrap();
        assert_eq!(
            a.use_class, "research",
            "the prompt's default is the recorded class"
        );
        assert_eq!(
            answer_config(&opts(true), "full", Some("bogus"), &mut p)
                .unwrap()
                .use_class,
            "general"
        );
    }

    #[test]
    fn stray_temps_are_removed_but_not_our_own() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        fs::create_dir_all(d.join("core.tmp-1")).unwrap();
        fs::write(d.join("node.tar.gz.tmp-2"), "x").unwrap();
        let own = format!("core.tmp-{}", std::process::id());
        fs::create_dir_all(d.join(&own)).unwrap();
        fs::create_dir_all(d.join("core")).unwrap();
        assert_eq!(remove_stray_temps(d), ["core.tmp-1", "node.tar.gz.tmp-2"]);
        assert!(d.join(own).exists() && d.join("core").exists());
    }

    #[test]
    fn windows_node_moves_into_bin() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("node.exe"), "MZ").unwrap();
        normalise_windows_node(dir.path()).unwrap();
        assert!(dir.path().join("bin/node.exe").is_file());
        assert!(!dir.path().join("node.exe").exists());
    }
}
