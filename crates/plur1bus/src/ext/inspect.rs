//! Worker half of `ext.inspect` (spec §8.4 steps 1–8, §9.2; X1-R2, X1-R10, X1-R16, X1-R29; Review Focus 2 and 4).
//!
//! The package bytes are spooled to `run/inspect/<inspectionId>.p1x` (0600): stdin with the package cap enforced
//! while reading, a `.p1x` file copied, a skill folder, `.zip` or `.skill` normalised into it (X1-R10). The spool then
//! runs through `plur1bus_ext::verify::inspect_file_kinds` with the X2 RPC kinds, this host's facts, trust store,
//! reserved names, `extensions.*` limits and `extensions.allowUnsigned` from `config.json`, and the revocation list.
//! Then the name is
//! checked against what is installed (another id or kind → `E_CONFLICT name-taken`), a module's socket address is
//! checked against this home (`socket-path-too-long`), and `replaces` is filled when the same id is installed. The
//! record goes to `run/inspect/<inspectionId>.json`. Nothing outside `run/inspect/` is written; a refusal leaves
//! nothing behind at all.
use super::host::{host_facts, inspect_ttl, reserved_names, trust_store};
use super::overlays::{load_revocations, revoked};
use super::paths::ExtPaths;
use super::record::{
    check_name, check_unsigned_policy, io_err as io_error, kind_name, now_ms, prune, record_path,
    spool_path, valid_id, InspectionRecord,
};
use super::state::{self, write_private_atomic};
use super::{iso8601, ExtError};
use crate::paths::Layout;
#[cfg(test)]
use plur1bus_ext::claude::NoNetwork;
use plur1bus_ext::claude::{normalise_claude, ClaudeInput, EgressFetch};
use plur1bus_ext::compat::acknowledged_capabilities;
use plur1bus_ext::manifest::Kind;
use plur1bus_ext::mcpb::{normalise_mcpb_with_context, McpbContext};
use plur1bus_ext::normalise::{normalise_skill, SkillInput};
use plur1bus_ext::refusal::{reason, Refusal};
use plur1bus_ext::verify::{inspect_file_kinds, Policy, X2_RPC_KINDS};
use plur1bus_ext::zipaudit::Limits;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

/// Where the package comes from.
#[derive(Clone, Debug)]
pub enum Source {
    Path(PathBuf),
    Stdin,
}

fn invalid(r: &'static str, detail: impl Into<String>) -> ExtError {
    ExtError::from(Refusal::invalid(r, detail))
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

/// `extensions.allowUnsigned` of `config.json` (default `true`), read fresh for the package store, which applies the same
/// policy as an inspection (X1-R21).
pub(super) fn allow_unsigned_policy(layout: &Layout) -> Result<bool, ExtError> {
    ext_config(layout).map(|c| c.allow_unsigned)
}

/// Runs worker preparation with inspection's current limits and revocations, without exposing package parsing to
/// supervisor-safe code.
pub(super) fn with_current_policy<T>(
    layout: &Layout,
    action: impl FnOnce(&Policy<'_>) -> Result<T, ExtError>,
) -> Result<T, ExtError> {
    with_config_policy(layout, &ext_config(layout)?, action)
}

fn with_config_policy<T>(
    layout: &Layout,
    cfg: &ExtConfig,
    action: impl FnOnce(&Policy<'_>) -> Result<T, ExtError>,
) -> Result<T, ExtError> {
    let store = trust_store();
    let host = host_facts();
    let revs = load_revocations(&ExtPaths::of(layout));
    let is_revoked = |id: &str, version: &str| revoked(&revs, id, version);
    action(&Policy {
        limits: cfg.limits.clone(),
        skill_bytes: cfg.skill_bytes,
        store: &store,
        host: &host,
        reserved: reserved_names(),
        revoked: &is_revoked,
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

/// Supplies the OS environment at the worker edge; the MCPB parser never reads process globals.
fn mcpb_context(_layout: &Layout, _name: &str) -> Result<McpbContext, Refusal> {
    let home = home::home_dir().ok_or_else(|| {
        Refusal::invalid(
            reason::PACKAGE_INVALID,
            "cannot determine HOME for MCPB path variables",
        )
    })?;
    let mut system_dirs = std::collections::BTreeMap::new();
    system_dirs.insert("HOME".into(), home.to_string_lossy().into_owned());
    for (key, directory) in [
        ("DOCUMENTS", "Documents"),
        ("DESKTOP", "Desktop"),
        ("DOWNLOADS", "Downloads"),
        ("PICTURES", "Pictures"),
        ("MUSIC", "Music"),
        ("VIDEOS", "Videos"),
    ] {
        system_dirs.insert(
            key.into(),
            home.join(directory).to_string_lossy().into_owned(),
        );
    }
    for key in ["APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] {
        if let Some(path) = std::env::var_os(key) {
            system_dirs.insert(key.into(), path.to_string_lossy().into_owned());
        }
    }
    Ok(McpbContext {
        platform: match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        }
        .into(),
        // The authenticated active version/payload path is bound by Core at each start, never by a preview spool.
        extension_dir: "${__dirname}".into(),
        path_separator: std::path::MAIN_SEPARATOR.to_string(),
        system_dirs,
        user_config: Default::default(),
    })
}

/// Puts the package bytes at `to`, returning normalization state and source disclosures.
fn spool(
    layout: &Layout,
    src: &Source,
    to: &Path,
    cfg: &ExtConfig,
    fetch: &mut impl EgressFetch,
) -> Result<(bool, Vec<String>), ExtError> {
    let cap = cfg.limits.package_bytes;
    let path = match src {
        Source::Stdin => {
            spool_capped(&mut io::stdin().lock(), to, cap)?;
            return Ok((false, Vec::new()));
        }
        Source::Path(p) => p,
    };
    let meta = std::fs::symlink_metadata(path).map_err(|e| io_error("cannot read", path, &e))?;
    let normalise = |input: SkillInput| -> Result<(bool, Vec<String>), ExtError> {
        let mut f = crate::audit::create_private(to, true)
            .map_err(|e| io_error("cannot create", to, &e))?;
        normalise_skill(&input, &super::now_iso(), &mut f)?;
        f.sync_all().map_err(|e| io_error("cannot write", to, &e))?;
        Ok((true, Vec::new()))
    };
    let claude = |input: ClaudeInput, fetch: &mut _| -> Result<(bool, Vec<String>), ExtError> {
        let mut out = crate::audit::create_private(to, true)
            .map_err(|e| io_error("cannot create", to, &e))?;
        let report = normalise_claude(
            &input,
            |name| mcpb_context(layout, name),
            fetch,
            &cfg.limits,
            &super::now_iso(),
            &mut out,
        )?;
        out.sync_all()
            .map_err(|e| io_error("cannot write", to, &e))?;
        let mut warnings = report.warnings;
        for skipped in report.skipped {
            warnings.push(format!("Skipped {}: {}", skipped.name, skipped.reason));
        }
        for member in report.members {
            warnings.push(format!(
                "Member {} (unsigned, SHA256 {}): capabilities {}; runtime {}; scripts {}",
                member.manifest.name,
                member.sha256,
                member.manifest.capabilities,
                member.manifest.requires,
                json!(member.manifest.scripts)
            ));
            warnings.extend(
                member
                    .warnings
                    .into_iter()
                    .map(|warning| format!("Member {}: {warning}", member.manifest.name)),
            );
        }
        Ok((true, warnings))
    };
    if meta.is_dir() {
        if !path.join("SKILL.md").exists() {
            if path.join(".claude-plugin").exists()
                || path.join("skills").exists()
                || path.join(".mcp.json").exists()
            {
                return claude(ClaudeInput::Dir(path.clone()), fetch);
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
        "zip" | "skill" => {
            let mut input = open_regular(path)?;
            let audited = plur1bus_ext::zipaudit::audit_zip(&mut input, &cfg.limits)?;
            let skill = audited.entries.iter().any(|entry| entry.name == "SKILL.md")
                || audited
                    .entries
                    .first()
                    .and_then(|entry| entry.name.split_once('/'))
                    .is_some_and(|(top, _)| {
                        audited
                            .entries
                            .iter()
                            .all(|entry| entry.name.starts_with(&format!("{top}/")))
                            && audited
                                .entries
                                .iter()
                                .any(|entry| entry.name == format!("{top}/SKILL.md"))
                    });
            let plugin = audited.entries.iter().any(|entry| {
                let name = &entry.name;
                name.starts_with(".claude-plugin/")
                    || name.starts_with("skills/")
                    || name == ".mcp.json"
                    || name.split_once('/').is_some_and(|(_, rel)| {
                        rel.starts_with(".claude-plugin/")
                            || rel.starts_with("skills/")
                            || rel == ".mcp.json"
                    })
            });
            if plugin && !skill {
                claude(ClaudeInput::Zip(path.clone()), fetch)
            } else {
                normalise(SkillInput::Zip(path.clone()))
            }
        }
        "mcpb" | "dxt" => {
            let mut input = open_regular(path)?;
            let mut out = crate::audit::create_private(to, true)
                .map_err(|e| io_error("cannot create", to, &e))?;
            let report = normalise_mcpb_with_context(
                &mut input,
                |name| mcpb_context(layout, name),
                &cfg.limits,
                &super::now_iso(),
                &mut out,
            )?;
            out.sync_all()
                .map_err(|e| io_error("cannot write", to, &e))?;
            Ok((true, report.warnings))
        }
        _ => {
            if meta.len() > cap {
                return Err(too_large(meta.len(), cap));
            }
            let mut f = open_regular(path)?;
            spool_capped(&mut f, to, cap)?;
            Ok((false, Vec::new()))
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
#[cfg(test)]
pub fn inspect(layout: &Layout, src: Source, id: &str) -> Result<InspectionRecord, ExtError> {
    inspect_with(layout, src, id, false)
}

/// [`inspect`], aborting the process right after the package is spooled when `crash` (the worker's `--crash` test
/// seam: a parser that crashes leaves its spool behind).
#[cfg(test)]
pub(crate) fn inspect_with(
    layout: &Layout,
    src: Source,
    id: &str,
    crash: bool,
) -> Result<InspectionRecord, ExtError> {
    inspect_with_fetch(layout, src, id, crash, &mut NoNetwork)
}

/// Production workers inject the existing Core egress boundary; direct local normalizer callers remain offline.
#[cfg(test)]
pub(crate) fn inspect_with_fetch(
    layout: &Layout,
    src: Source,
    id: &str,
    crash: bool,
    fetch: &mut impl EgressFetch,
) -> Result<InspectionRecord, ExtError> {
    inspect_with_expected(layout, src, id, crash, fetch, None)
}

struct RawSource(PathBuf);
impl Drop for RawSource { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }

/// Read an upload once, without following its final component, and parse only the bounded verified snapshot.
fn snapshot_source(layout: &Layout, source: &Source, id: &str, expected: (&str, u64), cap: u64) -> Result<RawSource, ExtError> {
    let Source::Path(path) = source else { return Err(invalid(reason::PACKAGE_INVALID, "upload requires a file")); };
    let (sha256, size) = expected;
    let mismatch = || invalid(reason::DIGEST, "the upload bytes no longer match their recorded digest and size");
    if size == 0 || size > cap || sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(mismatch());
    }
    let mut options = std::fs::OpenOptions::new(); options.read(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK); }
    #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT); }
    let mut input = options.open(path).map_err(|_| mismatch())?;
    let info = input.metadata().map_err(|_| mismatch())?;
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if info.file_attributes() & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err(mismatch()); }
    }
    if !info.is_file() || info.len() != size { return Err(mismatch()); }
    let raw = RawSource(ExtPaths::of(layout).inspect.join(format!("{id}.source")));
    let mut output = crate::audit::create_private(&raw.0, true).map_err(|_| mismatch())?;
    let mut hash = Sha256::new(); let mut count = 0u64; let mut buffer = [0u8; 32 * 1024];
    loop {
        let n = input.read(&mut buffer).map_err(|_| mismatch())?;
        if n == 0 { break; }
        count += n as u64; if count > size { return Err(mismatch()); }
        hash.update(&buffer[..n]); output.write_all(&buffer[..n]).map_err(|_| mismatch())?;
    }
    if count != size || format!("{:x}", hash.finalize()) != sha256 { return Err(mismatch()); }
    output.sync_all().map_err(|_| mismatch())?;
    Ok(raw)
}

/// API uploads bind their raw source digest before any format detection or normalization runs.
pub(crate) fn inspect_with_expected(
    layout: &Layout, src: Source, id: &str, crash: bool, fetch: &mut impl EgressFetch,
    expected: Option<(&str, u64)>,
) -> Result<InspectionRecord, ExtError> {
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
    let snapshot = expected.map(|expected| snapshot_source(layout, &src, id, expected, cfg.limits.package_bytes)).transpose()?;
    let verified = snapshot.as_ref().map(|source| Source::Path(source.0.clone()));
    let (normalised, warnings) = spool(layout, verified.as_ref().unwrap_or(&src), &pending.p1x, &cfg, fetch)?;
    if crash {
        std::process::abort();
    }

    let insp = with_config_policy(layout, &cfg, |policy| {
        inspect_file_kinds(&pending.p1x, policy, &X2_RPC_KINDS).map_err(ExtError::from)
    })?;
    let m = &insp.manifest;
    let tier = trust_json(&insp.trust)["tier"]
        .as_str()
        .unwrap_or("unsigned")
        .to_string();
    check_unsigned_policy(cfg.allow_unsigned, &tier, &m.id, &m.version)?;
    let st = state::read(&paths).map_err(|e| ExtError::new("E_STORAGE", "state-invalid", e))?;
    check_name(layout, &st, &m.name, &m.id, kind_name(m.kind))?;
    if matches!(m.kind, Kind::Module | Kind::Channel) {
        crate::modules::install::check_socket_fits(layout, &m.name).map_err(|e| {
            ExtError::new("E_INVALID_PARAMS", "socket-path-too-long", e.to_string())
        })?;
    }
    let replaces = st.items.get(&m.name).filter(|r| r.id == m.id).map(|r| {
        json!({
            "version": r.version,
            "capabilityDiff": { "changed": changed_keys(&r.capabilities, &acknowledged_capabilities(m)) }
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
    let mut checks = serde_json::to_value(&insp.checks).unwrap_or(Value::Null);
    if let Some(rows) = checks.as_array_mut() {
        for detail in warnings {
            rows.push(json!({"id":"normalization", "status":"warn", "detail":detail}));
        }
    }
    let rec = InspectionRecord {
        inspection_id: id.to_string(),
        expires_at: iso8601(now_ms().saturating_add(ttl.as_millis() as u64)),
        sha256: insp.sha256.clone(),
        source_path: match &src {
            _ if expected.is_some() => None,
            Source::Path(p) => Some(p.to_string_lossy().into_owned()),
            Source::Stdin => None,
        },
        normalised,
        manifest: serde_json::from_slice(&insp.manifest_raw)
            .map_err(|e| invalid(reason::PACKAGE_INVALID, e.to_string()))?,
        trust: trust_json(&insp.trust),
        checks,
        capabilities: acknowledged_capabilities(m),
        scripts: Value::Array(scripts),
        requires: m.requires.clone(),
        replaces,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_direct_local_caller_cannot_fetch_a_plugin_without_an_explicit_egress_port() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("plugin");
        std::fs::create_dir_all(source.join(".claude-plugin")).unwrap();
        std::fs::write(
            source.join(".claude-plugin/plugin.json"),
            br#"{"name":"demo-plugin","mcpServers":"https://example.invalid/demo.mcpb"}"#,
        )
        .unwrap();
        let layout = Layout::new(dir.path().join("home"));
        let error = inspect(
            &layout,
            Source::Path(source),
            &super::super::worker::new_inspection_id(),
        )
        .unwrap_err();
        assert_eq!(
            (error.code, error.reason),
            ("E_NOT_AVAILABLE", Some("kind-unsupported"))
        );
        assert!(!layout.home.join("mcp").exists());
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
