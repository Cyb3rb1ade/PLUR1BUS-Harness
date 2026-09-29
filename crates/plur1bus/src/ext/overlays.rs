//! Revocations, integrity and overlays (X1-R17): what makes an installed item unusable even though it is installed.
use super::paths::ExtPaths;
use super::record::warn;
use super::state::{Integrity, ItemRecord};
use crate::paths::Layout;
use plur1bus_ext::compat::{check_compat, harness_req, HostFacts};
use plur1bus_ext::manifest::{Kind, P1xManifest};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

/// A state an installed item is in besides enabled or disabled (spec §6.2). The order is the order they are listed in.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Overlay {
    /// A required secret slot is unfilled (X1-R9).
    NeedsSetup,
    /// The manifest's `compat` does not fit this host (X1-R20).
    Incompatible,
    /// The id and version are on the revocation list (Q9: refused and locked).
    Revoked,
    /// An installed file no longer matches its recorded digest.
    Tampered,
    /// The item cannot be evaluated (a record of a kind this build does not know).
    Error,
}

/// One entry of the §7.2 `revocations[]` list.
#[derive(Clone, Debug)]
pub struct Revocation {
    pub id: String,
    pub versions: semver::VersionReq,
    pub action: String,
    pub reason: Value,
}

fn parse_list(v: &Value, source: &Path) -> Vec<Revocation> {
    let list = match v {
        Value::Array(a) => a.as_slice(),
        Value::Object(_) => v
            .get("revocations")
            .and_then(Value::as_array)
            .map_or(&[][..], |a| a.as_slice()),
        _ => &[],
    };
    let mut out = Vec::new();
    for e in list {
        let (Some(id), Some(range), Some(action)) = (
            e.get("id").and_then(Value::as_str),
            e.get("versions").and_then(Value::as_str),
            e.get("action").and_then(Value::as_str),
        ) else {
            warn(format!(
                "{}: skipping a revocation without id, versions and action",
                source.display()
            ));
            continue;
        };
        let parsed = if range.trim() == "*" {
            Ok(semver::VersionReq::STAR)
        } else {
            harness_req(range)
        };
        match parsed {
            Ok(versions) => out.push(Revocation {
                id: id.to_string(),
                versions,
                action: action.to_string(),
                reason: e.get("reason").cloned().unwrap_or(Value::Null),
            }),
            Err(err) => warn(format!(
                "{}: skipping the revocation of {id}: {err}",
                source.display()
            )),
        }
    }
    out
}

fn read_list(path: &Path, must_exist: bool) -> Vec<Revocation> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !must_exist => return vec![],
        Err(e) => {
            warn(format!("{}: {e}", path.display()));
            return vec![];
        }
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => parse_list(&v, path),
        Err(e) => {
            warn(format!("{}: not JSON: {e}", path.display()));
            vec![]
        }
    }
}

/// The revocation list: `extensions/catalog/revocations.json` if present (written only by X4 after signature checks;
/// X1 never writes it) plus the file named by `PLUR1BUS_TEST_EXT_REVOCATIONS` under test internals. An unreadable file
/// contributes nothing and prints one warning line: the list only ever disables, so failing open is the safe side of
/// a corrupt cache.
pub fn load_revocations(p: &ExtPaths) -> Vec<Revocation> {
    let mut out = read_list(&p.revocations, false);
    if std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Ok("1") {
        if let Some(seam) = std::env::var_os("PLUR1BUS_TEST_EXT_REVOCATIONS") {
            out.extend(read_list(Path::new(&seam), true));
        }
    }
    out
}

/// A pre-release or build of a release counts as that release (as in `plur1bus_ext::compat`).
fn release(v: &str) -> Option<semver::Version> {
    let mut v = semver::Version::parse(v).ok()?;
    v.pre = semver::Prerelease::EMPTY;
    v.build = semver::BuildMetadata::EMPTY;
    Some(v)
}

/// The reason to show when `id` at `version` is revoked by an entry with action `disable` (`warn` and any other action
/// never revoke), else `None`. English first, then any language, then a fixed text.
pub fn revoked(revs: &[Revocation], id: &str, version: &str) -> Option<String> {
    let v = release(version)?;
    let hit = revs
        .iter()
        .find(|r| r.action == "disable" && r.id == id && r.versions.matches(&v))?;
    let text = match &hit.reason {
        Value::String(s) => Some(s.clone()),
        Value::Object(m) => m
            .get("en")
            .and_then(Value::as_str)
            .or_else(|| m.values().find_map(Value::as_str))
            .map(str::to_string),
        _ => None,
    };
    Some(text.unwrap_or_else(|| "revoked".to_string()))
}

fn sha256_of(path: &Path) -> std::io::Result<(String, u64)> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut n = 0u64;
    loop {
        let k = f.read(&mut buf)?;
        if k == 0 {
            break;
        }
        h.update(&buf[..k]);
        n += k as u64;
    }
    let hex = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok((hex, n))
}

/// Re-hashes an installed item against its record (X1-R17): `skills/<name>/` for a skill, `modules/<name>/` for a module
/// or channel, each recorded payload path. A file that is missing, not a regular file, or differs in size or digest is
/// listed. Files the record does not name (a module's own state, say) are not looked at.
pub fn rehash(layout: &Layout, rec: &ItemRecord) -> Integrity {
    let dir = if rec.kind == "skill" {
        layout.skills().join(&rec.name)
    } else {
        layout.modules_dir().join(&rec.name)
    };
    let mut paths = Vec::new();
    for (rel, want) in &rec.files {
        let file = rel.split('/').fold(dir.clone(), |p, seg| p.join(seg));
        let regular = std::fs::symlink_metadata(&file).is_ok_and(|m| m.is_file());
        let same = regular
            && sha256_of(&file).is_ok_and(|(hex, size)| hex == want.sha256 && size == want.size);
        if !same {
            paths.push(rel.clone());
        }
    }
    Integrity {
        checked_at: super::now_iso(),
        ok: paths.is_empty(),
        paths,
    }
}

fn kind_of(s: &str) -> Option<Kind> {
    Some(match s {
        "skill" => Kind::Skill,
        "module" => Kind::Module,
        "channel" => Kind::Channel,
        "mcp-server" => Kind::McpServer,
        "bundle" => Kind::Bundle,
        _ => return None,
    })
}

/// `check_compat` needs a manifest and looks only at `kind` and `compat`.
fn compat_only(kind: Kind, compat: &Value) -> P1xManifest {
    P1xManifest {
        format: 1,
        id: String::new(),
        name: String::new(),
        version: String::new(),
        kind,
        title: Default::default(),
        summary: Default::default(),
        publisher: Value::Null,
        licence: String::new(),
        compat: compat.clone(),
        requires: Value::Null,
        dependencies: vec![],
        capabilities: Value::Null,
        default_enabled: false,
        scripts: vec![],
        files: Default::default(),
        rest: Default::default(),
    }
}

/// The overlays of an installed item, in the enum's order. `manifest_compat` is the `compat` object of the package
/// manifest (from the cached package); without it compatibility is not judged.
pub fn overlays_of(
    rec: &ItemRecord,
    host: &HostFacts,
    revs: &[Revocation],
    manifest_compat: Option<&Value>,
) -> Vec<Overlay> {
    let mut out = Vec::new();
    let Some(kind) = kind_of(&rec.kind) else {
        return vec![Overlay::Error];
    };
    if !rec.required_secrets.is_empty() {
        out.push(Overlay::NeedsSetup);
    }
    if let Some(c) = manifest_compat {
        if check_compat(&compat_only(kind, c), host).is_err() {
            out.push(Overlay::Incompatible);
        }
    }
    if revoked(revs, &rec.id, &rec.version).is_some() {
        out.push(Overlay::Revoked);
    }
    if rec.integrity.as_ref().is_some_and(|i| !i.ok) {
        out.push(Overlay::Tampered);
    }
    out
}
