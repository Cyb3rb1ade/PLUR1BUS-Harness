//! `manifest.json` of a backup archive and the allow-list of what an archive may carry and a restore may write.
//!
//! Everything a restore does with the filesystem is derived from a *validated* manifest: every target is checked against
//! [`target_allowed`] and every file path against [`safe_rel`], so a crafted archive cannot name `run/`, a path outside the
//! home, or a credential location (RULING R4: the allow-list, not a deny-list, is what keeps secrets out).
use super::BackupError;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub const SCHEMA: &str = "plur1bus.backup/1";
pub const FORMAT_MAJOR: u64 = 1;
pub const MANIFEST_NAME: &str = "manifest.json";
pub const DATA_PREFIX: &str = "data/";
/// A manifest larger than this is refused unread: it is never legitimately big.
pub const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;

/// Unit targets (home-relative) that are directories / single files, besides the store and SQLite databases.
pub const FIXED_DIRS: &[&str] = &[
    "agents",
    "skills",
    "modules",
    "extensions",
    "catalog",
    "state/journal",
    "state/system-jobs",
    "state/memory/_archive",
];
pub const FIXED_FILES: &[&str] = &[
    "config.json",
    "state/memory/run-state.json",
    "state/memory/merge-proposals.jsonl",
];
/// First path segments never part of an archive (tokens and sockets, logs, the runtime, the models, the backups).
const EXCLUDED_ROOTS: &[&str] = &["run", "logs", "runtime", "models", "backups"];
/// Engine-staged units (their archive prefix is `memory/…`, `store`) the core produces; the rest the CLI copies.
pub const ENGINE_FILES: &[&str] = &[
    "state/memory/run-state.json",
    "state/memory/merge-proposals.jsonl",
];
pub const ENGINE_DIRS: &[&str] = &["state/memory/_archive"];

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema: String,
    pub created_at_ms: u64,
    pub harness: Harness,
    pub platform: Platform,
    pub engine: Engine,
    /// The store's home-relative path (`state/lancedb` unless configured otherwise inside the home).
    pub store_target: String,
    pub units: Vec<Unit>,
    /// Known units that did not exist at backup time: a restore removes them (moving them to the pre-restore tree).
    pub absent: Vec<String>,
    /// Every directory below a directory unit, archive paths, so empty ones survive.
    pub dirs: Vec<String>,
    pub files: Vec<FileEntry>,
    /// Symlinks and special files found in a unit and not archived.
    pub skipped: Vec<String>,
    pub secrets: Secrets,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Harness {
    pub version: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Platform {
    pub os: String,
    pub arch: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Engine {
    pub contract: String,
    pub store_schema: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Unit {
    /// Path of the unit inside `data/`.
    pub archive: String,
    /// Home-relative path it is restored to.
    pub target: String,
    pub kind: Kind,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Dir,
    File,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FileEntry {
    /// Archive path (inside `data/`).
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    /// Unix permission bits at backup time; a restore keeps only the owner's (never widens).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Secrets {
    /// Always `false`: a manifest that says otherwise is refused (R4).
    pub included: bool,
    pub note: String,
}

pub const SECRETS_NOTE: &str = "no secrets are part of this archive: API keys and tokens stay in the OS keyring, run/ is never archived, and the encrypted fallback file is not included";

/// A home-relative path that is the same on every OS and cannot climb out: non-empty `/`-separated segments, none of them
/// `.`/`..`, no backslash, colon or NUL (a drive or stream on Windows), not absolute.
pub fn safe_rel(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 1024
        && !p.starts_with('/')
        && !p.contains(['\\', ':', '\0'])
        && p.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
}

fn first_segment(p: &str) -> &str {
    p.split('/').next().unwrap_or("")
}

fn excluded(p: &str) -> bool {
    EXCLUDED_ROOTS.contains(&first_segment(p))
        || first_segment(p).starts_with(".restore-")
        || p == "state/core.lock"
        || p == "state/backup-staging"
        || p.starts_with("state/backup-staging/")
        || p.starts_with("state/memory/.snapshots")
}

/// `a` equals `b` or lies inside it.
fn within(a: &str, b: &str) -> bool {
    a == b || (a.starts_with(b) && a.as_bytes().get(b.len()) == Some(&b'/'))
}

/// SQLite's per-connection sidecars (`<db>-wal`, `<db>-shm`, `<db>-journal`). They describe a live connection, not data
/// at rest: never part of a backup (the core stages self-contained databases) and never trusted on restore.
pub const SQLITE_SIDECARS: [&str; 3] = ["-wal", "-shm", "-journal"];

pub fn is_sqlite_sidecar(p: &str) -> bool {
    let lower = p.to_ascii_lowercase();
    SQLITE_SIDECARS.iter().any(|s| lower.ends_with(s))
}

pub fn is_sqlite_name(p: &str) -> bool {
    let lower = p.to_ascii_lowercase();
    [".sqlite", ".sqlite3", ".db"]
        .iter()
        .any(|e| lower.ends_with(e))
}

/// Whether the store may live at `store_target`: inside the home, not an excluded or fixed location, not overlapping one.
pub fn store_target_allowed(store_target: &str) -> bool {
    safe_rel(store_target)
        && store_target != "state"
        && !excluded(store_target)
        && !FIXED_DIRS
            .iter()
            .chain(FIXED_FILES)
            .any(|t| within(store_target, t) || within(t, store_target))
}

/// The archive prefix a unit `target` maps to (a fixed, reversible mapping: a manifest's `archive` must equal it).
pub fn archive_prefix(target: &str, store_target: &str) -> String {
    if target == store_target {
        return "store".into();
    }
    if let Some(rest) = target.strip_prefix("state/memory/") {
        return format!("memory/{rest}");
    }
    match target {
        "state/journal" => return "journal".into(),
        "state/system-jobs" => return "system-jobs".into(),
        _ => {}
    }
    if let Some(rest) = target.strip_prefix("state/") {
        if is_sqlite_name(rest) {
            return format!("sqlite/{rest}");
        }
    }
    target.to_string()
}

/// The unit kind a `target` must have, or `None` when the allow-list does not contain it.
pub fn target_kind(target: &str, store_target: &str) -> Option<Kind> {
    if !safe_rel(target) || excluded(target) {
        return None;
    }
    if target == store_target {
        return Some(Kind::Dir);
    }
    if FIXED_DIRS.contains(&target) {
        return Some(Kind::Dir);
    }
    if FIXED_FILES.contains(&target) {
        return Some(Kind::File);
    }
    let rest = target.strip_prefix("state/")?;
    let inside_other = FIXED_DIRS
        .iter()
        .chain(FIXED_FILES)
        .any(|t| within(target, t))
        || within(target, store_target);
    (is_sqlite_name(rest) && !inside_other).then_some(Kind::File)
}

fn valid_sha(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Manifest {
    /// Structural validation; every restore and verify runs it before touching a byte of data.
    pub fn validate(&self) -> Result<(), BackupError> {
        let bad = |d: String| Err(BackupError::new("manifest-invalid", d));
        let Some(major) = self
            .schema
            .strip_prefix("plur1bus.backup/")
            .and_then(|m| m.parse::<u64>().ok())
        else {
            return bad(format!(
                "schema {:?} is not a plur1bus.backup id",
                self.schema
            ));
        };
        if major != FORMAT_MAJOR {
            return Err(BackupError::new(
                "unsupported-format",
                format!(
                    "archive format {major} is not supported (this binary reads {FORMAT_MAJOR})"
                ),
            ));
        }
        if self.secrets.included {
            return bad("the manifest claims secrets are included".into());
        }
        if !store_target_allowed(&self.store_target) {
            return bad(format!(
                "store target {:?} is not allowed",
                self.store_target
            ));
        }
        let mut targets = HashSet::new();
        let mut prefixes = HashMap::new();
        for u in &self.units {
            if target_kind(&u.target, &self.store_target) != Some(u.kind) {
                return bad(format!("unit target {:?} is not allowed", u.target));
            }
            if u.archive != archive_prefix(&u.target, &self.store_target) {
                return bad(format!(
                    "unit {:?} has an unexpected archive path",
                    u.target
                ));
            }
            if !targets.insert(u.target.as_str()) {
                return bad(format!("unit {:?} is listed twice", u.target));
            }
            prefixes.insert(u.archive.as_str(), u.kind);
        }
        for a in &self.absent {
            let known = FIXED_DIRS.contains(&a.as_str())
                || FIXED_FILES.contains(&a.as_str())
                || *a == self.store_target;
            if !known || targets.contains(a.as_str()) {
                return bad(format!("absent unit {a:?} is not allowed"));
            }
        }
        // A directory that is a unit root or lies below a directory unit.
        let dir_unit_of = |path: &str| {
            self.units
                .iter()
                .find(|u| u.kind == Kind::Dir && within(path, &u.archive))
        };
        for d in &self.dirs {
            if !safe_rel(d) || dir_unit_of(d).is_none() {
                return bad(format!("directory {d:?} belongs to no unit"));
            }
        }
        let mut seen = HashSet::new();
        for f in &self.files {
            if !safe_rel(&f.path) || !valid_sha(&f.sha256) {
                return bad(format!("file entry {:?} is malformed", f.path));
            }
            let owned = self.units.iter().any(|u| match u.kind {
                Kind::File => u.archive == f.path,
                Kind::Dir => f.path.len() > u.archive.len() && within(&f.path, &u.archive),
            });
            if !owned {
                return bad(format!("file {:?} belongs to no unit", f.path));
            }
            if !seen.insert(f.path.as_str()) {
                return bad(format!("file {:?} is listed twice", f.path));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Manifest {
        Manifest {
            schema: SCHEMA.into(),
            created_at_ms: 1,
            harness: Harness {
                version: "0.1.0".into(),
            },
            platform: Platform {
                os: "linux".into(),
                arch: "x86_64".into(),
            },
            engine: Engine {
                contract: "1.12.0".into(),
                store_schema: Some("1".into()),
            },
            store_target: "state/lancedb".into(),
            units: vec![
                Unit {
                    archive: "store".into(),
                    target: "state/lancedb".into(),
                    kind: Kind::Dir,
                },
                Unit {
                    archive: "config.json".into(),
                    target: "config.json".into(),
                    kind: Kind::File,
                },
            ],
            absent: vec![],
            dirs: vec![],
            files: vec![
                FileEntry {
                    path: "store/a".into(),
                    bytes: 1,
                    sha256: "0".repeat(64),
                    mode: None,
                },
                FileEntry {
                    path: "config.json".into(),
                    bytes: 2,
                    sha256: "1".repeat(64),
                    mode: Some(0o600),
                },
            ],
            skipped: vec![],
            secrets: Secrets {
                included: false,
                note: SECRETS_NOTE.into(),
            },
        }
    }

    #[test]
    fn a_well_formed_manifest_validates() {
        base().validate().unwrap();
    }

    #[test]
    fn paths_must_be_relative_portable_and_inside() {
        for ok in ["a", "a/b", "state/x.db"] {
            assert!(safe_rel(ok), "{ok}");
        }
        for bad in [
            "",
            "/a",
            "a//b",
            "a/../b",
            "..",
            "a/.",
            "a\\b",
            "C:/x",
            "a\0b",
            "a/b:stream",
        ] {
            assert!(!safe_rel(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_allow_list_refuses_secrets_runtime_and_unknown_locations() {
        let store = "state/lancedb";
        for t in [
            "run/core.token",
            "logs/audit.log",
            "runtime/node",
            "models/x",
            "backups/old",
            "state/core.lock",
            "state/backup-staging/x",
            "elsewhere",
            "state/other.txt",
            "../x",
            ".restore-1/x",
        ] {
            assert_eq!(target_kind(t, store), None, "{t}");
        }
        assert_eq!(target_kind("config.json", store), Some(Kind::File));
        assert_eq!(target_kind("agents", store), Some(Kind::Dir));
        assert_eq!(target_kind("state/app.sqlite", store), Some(Kind::File));
        assert_eq!(
            target_kind("state/journal/x.db", store),
            None,
            "inside another unit"
        );
        assert!(!store_target_allowed("run/store"));
        assert!(!store_target_allowed("agents/store"));
        assert!(store_target_allowed("state/lancedb"));
    }

    #[test]
    fn archive_prefixes_are_fixed() {
        let s = "state/lancedb";
        assert_eq!(archive_prefix("state/lancedb", s), "store");
        assert_eq!(
            archive_prefix("state/memory/run-state.json", s),
            "memory/run-state.json"
        );
        assert_eq!(archive_prefix("state/journal", s), "journal");
        assert_eq!(archive_prefix("state/a/b.sqlite", s), "sqlite/a/b.sqlite");
        assert_eq!(archive_prefix("agents", s), "agents");
    }

    #[test]
    fn invalid_manifests_are_refused_with_a_reason() {
        let mut m = base();
        m.secrets.included = true;
        assert_eq!(m.validate().unwrap_err().reason, "manifest-invalid");
        let mut m = base();
        m.schema = "plur1bus.backup/2".into();
        assert_eq!(m.validate().unwrap_err().reason, "unsupported-format");
        let mut m = base();
        m.units[1].target = "run/core.token".into();
        assert_eq!(m.validate().unwrap_err().reason, "manifest-invalid");
        let mut m = base();
        m.units[0].archive = "elsewhere".into();
        assert_eq!(m.validate().unwrap_err().reason, "manifest-invalid");
        let mut m = base();
        m.files.push(FileEntry {
            path: "stray".into(),
            bytes: 0,
            sha256: "0".repeat(64),
            mode: None,
        });
        assert_eq!(m.validate().unwrap_err().reason, "manifest-invalid");
        let mut m = base();
        m.files[0].sha256 = "XYZ".into();
        assert_eq!(m.validate().unwrap_err().reason, "manifest-invalid");
        let mut m = base();
        m.files.push(m.files[0].clone());
        assert_eq!(m.validate().unwrap_err().reason, "manifest-invalid");
        let mut m = base();
        m.absent.push("run".into());
        assert_eq!(m.validate().unwrap_err().reason, "manifest-invalid");
    }
}
