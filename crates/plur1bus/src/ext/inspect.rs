//! Worker half of `ext.inspect` (spec §8.4 steps 1–8, §9.2; X1-R2, X1-R10, X1-R16, X1-R29; Review Focus 2 and 4).
//!
//! The package bytes are spooled to `run/inspect/<inspectionId>.p1x` (0600): stdin with the package cap enforced
//! while reading, a `.p1x` file copied, a skill folder, `.zip` or `.skill` normalised into it (X1-R10). The spool then
//! runs through `plur1bus_ext::verify::inspect_file` with this host's facts, trust store, reserved names, the
//! `extensions.*` limits and `extensions.allowUnsigned` from `config.json`, and the revocation list. Then the name is
//! checked against what is installed (another id or kind → `E_CONFLICT name-taken`), a module's socket address is
//! checked against this home (`socket-path-too-long`), and `replaces` is filled when the same id is installed. The
//! record goes to `run/inspect/<inspectionId>.json`. Nothing outside `run/inspect/` is written; a refusal leaves
//! nothing behind at all.
use super::host::{host_facts, inspect_ttl, reserved_names, trust_store};
use super::overlays::{load_revocations, revoked};
use super::paths::ExtPaths;
use super::state::{self, write_private_atomic, ExtState};
use super::{iso8601, ExtError};
use crate::paths::Layout;
use plur1bus_ext::manifest::{Kind, P1xManifest};
use plur1bus_ext::normalise::{normalise_skill, SkillInput};
use plur1bus_ext::refusal::{reason, Refusal};
use plur1bus_ext::trust::Tier;
use plur1bus_ext::verify::{inspect_file, Policy};
use plur1bus_ext::zipaudit::Limits;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Where the package comes from.
#[derive(Clone, Debug)]
pub enum Source {
    Path(PathBuf),
    Stdin,
}

/// An inspection as `run/inspect/<inspectionId>.json` holds it. The RPC layer answers `ExtInspection` from it
/// (`sourcePath`, `normalised` and `nameTakenBy` are not part of that closed shape and are dropped there).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionRecord {
    pub inspection_id: String,
    /// RFC 3339 UTC (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
    pub expires_at: String,
    pub sha256: String,
    pub source_path: Option<String>,
    /// The input was a skill folder, `.zip` or `.skill` normalised into an unsigned package.
    pub normalised: bool,
    /// The exact `p1x.json`, as JSON.
    pub manifest: Value,
    /// `{ tier, keyId?, label? }` (`ExtTrust`).
    pub trust: Value,
    /// `[{ id, status, detail }]`.
    pub checks: Value,
    pub capabilities: Value,
    /// `[{ path, size, firstLine? }]`: the derived script set.
    pub scripts: Value,
    pub requires: Value,
    /// `{ version, capabilityDiff: { changed: [key] } }` when the same id is installed.
    pub replaces: Option<Value>,
    /// Reserved for the installed kind a name clash names. A clash is refused at inspect (`E_CONFLICT name-taken`,
    /// X1-R29), so a stored record never carries one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_taken_by: Option<String>,
}

fn expired() -> ExtError {
    ExtError::new(
        "E_NOT_FOUND",
        "inspection-expired",
        "this inspection has expired or does not exist; inspect the package again",
    )
}

fn io_error(what: &str, path: &Path, e: &io::Error) -> ExtError {
    ExtError::new(
        "E_INTERNAL",
        "io",
        format!("{what} {}: {e}", path.display()),
    )
}

fn invalid(r: &'static str, detail: impl Into<String>) -> ExtError {
    ExtError::from(Refusal::invalid(r, detail))
}

/// An inspection id is a file stem under `run/inspect/`: 1–64 characters of `A-Z a-z 0-9 -` (a uuid).
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub(crate) fn spool_path(layout: &Layout, id: &str) -> PathBuf {
    ExtPaths::of(layout).inspect.join(format!("{id}.p1x"))
}

fn record_path(layout: &Layout, id: &str) -> PathBuf {
    ExtPaths::of(layout).inspect.join(format!("{id}.json"))
}

pub(crate) fn kind_name(k: Kind) -> &'static str {
    match k {
        Kind::Skill => "skill",
        Kind::Module => "module",
        Kind::Channel => "channel",
        Kind::McpServer => "mcp-server",
        Kind::Bundle => "bundle",
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The inverse of [`iso8601`] for its own output (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
fn parse_iso_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() != 24 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' {
        return None;
    }
    if b[16] != b':' || b[19] != b'.' || b[23] != b'Z' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (hh, mm, ss, ms) = (n(11..13)?, n(14..16)?, n(17..19)?, n(20..23)?);
    // Howard Hinnant's days_from_civil.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let total = ((days * 86_400 + hh * 3600 + mm * 60 + ss) * 1000) + ms;
    u64::try_from(total).ok()
}

/// What `config.json` says about extensions (X1-R21), with the schema defaults for anything absent or out of range.
struct ExtConfig {
    limits: Limits,
    skill_bytes: u64,
    allow_unsigned: bool,
}

fn ext_config(layout: &Layout) -> Result<ExtConfig, ExtError> {
    let path = layout.config_path();
    let v: Value = match std::fs::read_to_string(&path) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| ExtError {
            code: "E_CONFIG_INVALID",
            reason: None,
            message: format!("{}: not JSON: {e}", path.display()),
            data: Value::Null,
        })?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => Value::Null,
        Err(e) => return Err(io_error("cannot read", &path, &e)),
    };
    let ext = &v["extensions"];
    let bytes = |key: &str, default: u64| {
        ext["limits"][key]
            .as_u64()
            .filter(|n| (1 << 20..=1 << 30).contains(n))
            .unwrap_or(default)
    };
    let limits = Limits {
        package_bytes: bytes("packageBytes", Limits::default().package_bytes),
        ..Limits::default()
    };
    Ok(ExtConfig {
        limits,
        skill_bytes: bytes("skillBytes", plur1bus_ext::normalise::MAX_SKILL_BYTES),
        allow_unsigned: ext["allowUnsigned"].as_bool().unwrap_or(true),
    })
}

/// The spool and record of one inspection, removed on drop unless kept.
struct Pending {
    p1x: PathBuf,
    json: PathBuf,
    keep: bool,
}

impl Drop for Pending {
    fn drop(&mut self) {
        if !self.keep {
            let _ = state::remove_retrying(&self.p1x);
            let _ = state::remove_retrying(&self.json);
        }
    }
}

fn too_large(size: u64, limit: u64) -> ExtError {
    invalid(
        reason::TOO_LARGE,
        format!("the package is at least {size} bytes; the limit is {limit}"),
    )
}

/// Copies at most `cap` bytes from `r` into the private file `to`; one byte more is `download-too-large`.
fn spool_capped(r: &mut impl Read, to: &Path, cap: u64) -> Result<(), ExtError> {
    let mut f =
        crate::audit::create_private(to, true).map_err(|e| io_error("cannot create", to, &e))?;
    let n = io::copy(&mut r.take(cap + 1), &mut f).map_err(|e| io_error("cannot write", to, &e))?;
    if n > cap {
        return Err(too_large(n, cap));
    }
    f.sync_all().map_err(|e| io_error("cannot write", to, &e))
}

fn lower_ext(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Puts the package bytes at `to`. Returns whether the input was normalised.
fn spool(src: &Source, to: &Path, cfg: &ExtConfig) -> Result<bool, ExtError> {
    let cap = cfg.limits.package_bytes;
    let path = match src {
        Source::Stdin => {
            spool_capped(&mut io::stdin().lock(), to, cap)?;
            return Ok(false);
        }
        Source::Path(p) => p,
    };
    let meta = std::fs::symlink_metadata(path).map_err(|e| io_error("cannot read", path, &e))?;
    let normalise = |input: SkillInput| -> Result<bool, ExtError> {
        let mut f = crate::audit::create_private(to, true)
            .map_err(|e| io_error("cannot create", to, &e))?;
        normalise_skill(&input, &super::now_iso(), &mut f)?;
        f.sync_all().map_err(|e| io_error("cannot write", to, &e))?;
        Ok(true)
    };
    if meta.is_dir() {
        if !path.join("SKILL.md").exists() {
            if path.join(".claude-plugin").exists() {
                return Err(ExtError::new(
                    "E_NOT_AVAILABLE",
                    reason::KIND_UNSUPPORTED,
                    "Claude Code plugins arrive in X2",
                ));
            }
            if path.join("module.json").exists() {
                return Err(invalid(
                    reason::PACKAGE_INVALID,
                    format!(
                        "{} is a module directory; install it with `plur1bus module install`",
                        path.display()
                    ),
                ));
            }
        }
        return normalise(SkillInput::Dir(path.clone()));
    }
    if !meta.is_file() {
        return Err(invalid(
            reason::PACKAGE_INVALID,
            format!("{} is not a regular file or a directory", path.display()),
        ));
    }
    match lower_ext(path).as_str() {
        "zip" | "skill" => normalise(SkillInput::Zip(path.clone())),
        e @ ("mcpb" | "dxt") => Err(ExtError::new(
            "E_NOT_AVAILABLE",
            reason::KIND_UNSUPPORTED,
            format!(".{e} packages arrive in X2"),
        )),
        _ => {
            if meta.len() > cap {
                return Err(too_large(meta.len(), cap));
            }
            let mut f = open_regular(path)?;
            spool_capped(&mut f, to, cap)?;
            Ok(false)
        }
    }
}

/// Opens `path` for reading without following a symlink (`O_NOFOLLOW` on unix) and checks the opened handle is a
/// regular file, so a path swapped for a symlink or special file after the `symlink_metadata` check is refused.
fn open_regular(path: &Path) -> Result<std::fs::File, ExtError> {
    let mut o = std::fs::OpenOptions::new();
    o.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NOFOLLOW);
    }
    let f = o
        .open(path)
        .map_err(|e| io_error("cannot read", path, &e))?;
    let meta = f
        .metadata()
        .map_err(|e| io_error("cannot stat", path, &e))?;
    if !meta.is_file() {
        return Err(invalid(
            reason::PACKAGE_INVALID,
            format!("{} is not a regular file", path.display()),
        ));
    }
    Ok(f)
}

fn trust_json(t: &plur1bus_ext::trust::Trust) -> Value {
    let mut v = json!({ "tier": t.tier });
    if let Some(k) = &t.key_id {
        v["keyId"] = json!(k);
    }
    if let Some(l) = &t.key_label {
        v["label"] = json!(l);
    }
    v
}

/// The installed kind of `modules/<name>`: its `module.json` `kind`, else `module`.
fn module_dir_kind(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("module.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["kind"].as_str().map(str::to_string))
        .unwrap_or_else(|| "module".into())
}

fn name_taken(name: &str, kind: &str, id: Option<&str>) -> ExtError {
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
}

/// X1-R29: the same name under another id or kind is taken, whether the installed item came from a package (its
/// state record) or not (a bundled, local or imported skill folder, a module directory).
fn check_name(layout: &Layout, st: &ExtState, m: &P1xManifest) -> Result<(), ExtError> {
    let kind = kind_name(m.kind);
    if let Some(rec) = st.items.get(&m.name) {
        if rec.id != m.id || rec.kind != kind {
            return Err(name_taken(&m.name, &rec.kind, Some(&rec.id)));
        }
        return Ok(());
    }
    if std::fs::symlink_metadata(layout.skills().join(&m.name)).is_ok() {
        return Err(name_taken(&m.name, "skill", None));
    }
    let module = layout.modules_dir().join(&m.name);
    if std::fs::symlink_metadata(&module).is_ok() {
        return Err(name_taken(&m.name, &module_dir_kind(&module), None));
    }
    Ok(())
}

/// The top-level capability keys whose value differs between two capability objects, sorted.
fn changed_keys(old: &Value, new: &Value) -> Vec<String> {
    let empty = serde_json::Map::new();
    let (a, b) = (
        old.as_object().unwrap_or(&empty),
        new.as_object().unwrap_or(&empty),
    );
    let mut keys: Vec<String> = a
        .keys()
        .chain(b.keys())
        .filter(|k| a.get(*k) != b.get(*k))
        .cloned()
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

/// Spools, verifies and checks a package (see the module documentation) and writes its record. `id` comes from
/// [`super::worker::new_inspection_id`].
pub fn inspect(layout: &Layout, src: Source, id: &str) -> Result<InspectionRecord, ExtError> {
    if !valid_id(id) {
        return Err(ExtError::new(
            "E_INTERNAL",
            "worker-failed",
            format!("{id:?} is not an inspection id"),
        ));
    }
    prune(layout);
    let paths = ExtPaths::of(layout);
    std::fs::create_dir_all(&paths.inspect)
        .map_err(|e| io_error("cannot create", &paths.inspect, &e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&paths.inspect, std::fs::Permissions::from_mode(0o700));
    }
    let mut pending = Pending {
        p1x: spool_path(layout, id),
        json: record_path(layout, id),
        keep: false,
    };
    let cfg = ext_config(layout)?;
    let normalised = spool(&src, &pending.p1x, &cfg)?;

    let store = trust_store();
    let host = host_facts();
    let revs = load_revocations(&paths);
    let is_revoked = |id: &str, version: &str| revoked(&revs, id, version);
    let policy = Policy {
        limits: cfg.limits.clone(),
        skill_bytes: cfg.skill_bytes,
        store: &store,
        host: &host,
        reserved: reserved_names(),
        revoked: &is_revoked,
    };
    let insp = inspect_file(&pending.p1x, &policy)?;
    let m = &insp.manifest;
    if !cfg.allow_unsigned && insp.trust.tier != Tier::FirstParty {
        return Err(ExtError::new(
            "E_DENIED",
            "policy-unsigned-disallowed",
            format!(
                "{} {} is not signed by a trusted key, and extensions.allowUnsigned is false",
                m.id, m.version
            ),
        ));
    }
    let st = state::read(&paths).map_err(|e| ExtError::new("E_STORAGE", "state-invalid", e))?;
    check_name(layout, &st, m)?;
    if matches!(m.kind, Kind::Module | Kind::Channel) {
        crate::modules::install::check_socket_fits(layout, &m.name).map_err(|e| {
            ExtError::new("E_INVALID_PARAMS", "socket-path-too-long", e.to_string())
        })?;
    }
    let replaces = st.items.get(&m.name).filter(|r| r.id == m.id).map(|r| {
        json!({
            "version": r.version,
            "capabilityDiff": { "changed": changed_keys(&r.capabilities, &m.capabilities) }
        })
    });
    let scripts: Vec<Value> = insp
        .scripts
        .iter()
        .map(|s| {
            let mut v = json!({ "path": s.path, "size": s.size });
            if let Some(l) = &s.first_line {
                v["firstLine"] = json!(l);
            }
            v
        })
        .collect();
    let ttl = inspect_ttl();
    let rec = InspectionRecord {
        inspection_id: id.to_string(),
        expires_at: iso8601(now_ms().saturating_add(ttl.as_millis() as u64)),
        sha256: insp.sha256.clone(),
        source_path: match &src {
            Source::Path(p) => Some(p.to_string_lossy().into_owned()),
            Source::Stdin => None,
        },
        normalised,
        manifest: serde_json::from_slice(&insp.manifest_raw)
            .map_err(|e| invalid(reason::PACKAGE_INVALID, e.to_string()))?,
        trust: trust_json(&insp.trust),
        checks: serde_json::to_value(&insp.checks).unwrap_or(Value::Null),
        capabilities: m.capabilities.clone(),
        scripts: Value::Array(scripts),
        requires: m.requires.clone(),
        replaces,
        name_taken_by: None,
    };
    let mut text = serde_json::to_string_pretty(&rec).map_err(|e| {
        ExtError::new(
            "E_INTERNAL",
            "io",
            format!("cannot serialise the inspection: {e}"),
        )
    })?;
    text.push('\n');
    write_private_atomic(&pending.json, text.as_bytes())
        .map_err(|e| io_error("cannot write", &pending.json, &e))?;
    pending.keep = true;
    Ok(rec)
}

/// The record of a live inspection. Missing, unreadable, malformed or past `expiresAt` (or its spooled package gone) →
/// `E_NOT_FOUND inspection-expired`; an expired pair is removed.
pub fn load(layout: &Layout, id: &str) -> Result<InspectionRecord, ExtError> {
    if !valid_id(id) {
        return Err(expired());
    }
    let json = record_path(layout, id);
    let rec: InspectionRecord = std::fs::read_to_string(&json)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or_else(expired)?;
    let live = rec.inspection_id == id
        && parse_iso_ms(&rec.expires_at).is_some_and(|t| now_ms() < t)
        && spool_path(layout, id).is_file();
    if !live {
        let _ = state::remove_retrying(&json);
        let _ = state::remove_retrying(&spool_path(layout, id));
        return Err(expired());
    }
    Ok(rec)
}

fn older_than(p: &Path, ttl: Duration) -> bool {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age > ttl)
}

/// Removes expired inspections from `run/inspect/`: a record past its `expiresAt` (or unreadable) with its package,
/// and a package or temp file with no record that is older than the TTL (an inspection killed half-way). Best effort.
pub fn prune(layout: &Layout) {
    let dir = ExtPaths::of(layout).inspect;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let ttl = inspect_ttl();
    let now = now_ms();
    for e in entries.flatten() {
        let path = e.path();
        let Some(name) = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        if let Some(stem) = name.strip_suffix(".json") {
            let live = std::fs::read_to_string(&path)
                .ok()
                .and_then(|t| serde_json::from_str::<InspectionRecord>(&t).ok())
                .and_then(|r| parse_iso_ms(&r.expires_at))
                .is_some_and(|t| now < t);
            if !live {
                let _ = state::remove_retrying(&path);
                let _ = state::remove_retrying(&dir.join(format!("{stem}.p1x")));
            }
        } else if let Some(stem) = name.strip_suffix(".p1x") {
            if !dir.join(format!("{stem}.json")).exists() && older_than(&path, ttl) {
                let _ = state::remove_retrying(&path);
            }
        } else if name.contains(".tmp-") && older_than(&path, ttl) {
            let _ = state::remove_retrying(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trips() {
        for ms in [0u64, 1_709_210_096_789, 1_767_225_599_999, 5_007] {
            assert_eq!(parse_iso_ms(&iso8601(ms)), Some(ms));
        }
        assert_eq!(parse_iso_ms("2026-01-01T00:00:00Z"), None);
        assert_eq!(parse_iso_ms("garbage"), None);
    }

    #[test]
    fn ids_are_file_stems() {
        assert!(valid_id("0b9e4c1e-7a6b-4d1c-9a3e-2f1d7c8b9a01"));
        for bad in ["", "../x", "a/b", "a.b", "a b", &"a".repeat(65)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn changed_keys_are_the_differing_top_level_keys() {
        let a =
            json!({"network": {"mode": "none"}, "filesystem": [], "processes": {"spawn": false}});
        let b =
            json!({"network": {"mode": "any"}, "filesystem": [], "harness": {"authority": "none"}});
        assert_eq!(changed_keys(&a, &b), ["harness", "network", "processes"]);
        assert!(changed_keys(&a, &a).is_empty());
    }
}
