//! `backup create`: turns the core's staged snapshot plus point-in-time copies of the plain units into one archive.
//!
//! The consistent, engine-owned parts (store, memory state, SQLite databases) arrive staged by `admin.backup.snapshot`
//! (RULING R1/R6). The plain units are copied here into a private staging directory first (each file re-copied up to
//! three times if it changes while being read), so the manifest's hashes describe bytes that can no longer move
//! (R2). Nothing is read from a secret store and nothing outside the allow-list is touched (R4).
use super::archive::{hash_file, verify, write_archive};
use super::manifest::*;
use super::{now_ms, short_id, BackupError};
use crate::paths::Layout;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// What `admin.backup.snapshot` answered.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub dir: PathBuf,
    pub store_target: String,
    pub engine: EngineInfo,
    pub files: Vec<SnapFile>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub contract: String,
    pub store_schema: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct SnapFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

impl Snapshot {
    pub fn from_rpc(v: &Value) -> Result<Snapshot, BackupError> {
        serde_json::from_value(v.clone()).map_err(|e| {
            BackupError::new(
                "snapshot-mismatch",
                format!("unreadable snapshot answer: {e}"),
            )
        })
    }
}

pub struct CreateReport {
    pub path: PathBuf,
    pub bytes: u64,
    pub files: usize,
    pub units: Vec<String>,
    pub absent: Vec<String>,
    pub skipped: Vec<String>,
    pub created_at_ms: u64,
    pub engine: Engine,
}

/// Removes a directory tree when dropped (staging areas, on every exit path).
pub struct Cleanup(pub PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn backups_dir(layout: &Layout) -> PathBuf {
    layout.home.join("backups")
}

/// Creates `<home>/backups` private to the user (0700 on unix; on Windows it inherits the home's per-user ACL, and the
/// archive file itself gets a protected DACL from `audit::create_private`).
pub fn ensure_backups_dir(layout: &Layout) -> io::Result<PathBuf> {
    let d = backups_dir(layout);
    fs::create_dir_all(&d)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&d, fs::Permissions::from_mode(0o700))?;
    }
    Ok(d)
}

pub fn default_out(layout: &Layout, ms: u64) -> PathBuf {
    backups_dir(layout).join(format!("plur1bus-backup-{}.tar.gz", super::utc_stamp(ms)))
}

/// The plain (CLI-copied) units: targets and kinds, in archive order.
pub fn plain_targets() -> Vec<(&'static str, Kind)> {
    let mut v: Vec<(&str, Kind)> = vec![];
    v.extend(
        [
            "agents",
            "skills",
            "modules",
            "extensions",
            "catalog",
            "state/journal",
            "state/system-jobs",
        ]
        .map(|t| (t, Kind::Dir)),
    );
    v.push(("config.json", Kind::File));
    v
}

fn join_rel(base: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(base.to_path_buf(), |p, s| p.join(s))
}

fn exists_nofollow(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

/// Copies one file, retrying when it changed while being read (journals grow).
fn copy_file_stable(src: &Path, dst: &Path, shown: &str) -> Result<(), BackupError> {
    for _ in 0..3 {
        let before = fs::metadata(src)?;
        {
            let mut r = fs::File::open(src)?;
            let mut w = crate::audit::create_private(dst, true)?;
            io::copy(&mut r, &mut w)?;
            w.sync_all()?;
        }
        let after = fs::metadata(src)?;
        if before.len() == after.len() && before.modified().ok() == after.modified().ok() {
            return Ok(());
        }
        let _ = fs::remove_file(dst);
    }
    Err(BackupError::new(
        "source-busy",
        format!("{shown} kept changing while it was copied; run the backup again"),
    ))
}

fn copy_tree(
    src: &Path,
    dst: &Path,
    shown: &str,
    skipped: &mut Vec<String>,
) -> Result<(), BackupError> {
    fs::create_dir_all(dst)?;
    let mut names: Vec<_> = fs::read_dir(src)?.collect::<Result<_, _>>()?;
    names.sort_by_key(|e| e.file_name());
    for e in names {
        let name = e.file_name().to_string_lossy().into_owned();
        let (s, d, shown) = (e.path(), dst.join(&name), format!("{shown}/{name}"));
        let ft = e.file_type()?;
        if ft.is_dir() {
            copy_tree(&s, &d, &shown, skipped)?;
        } else if ft.is_file() {
            copy_file_stable(&s, &d, &shown)?;
        } else {
            skipped.push(shown);
        }
    }
    Ok(())
}

struct Walked {
    files: Vec<(String, PathBuf)>,
    dirs: Vec<String>,
}

/// Every file and directory below `root/<prefix>` as archive paths (`/`-joined), sorted.
fn walk(root: &Path, prefix: &str, out: &mut Walked) -> io::Result<()> {
    let dir = join_rel(root, prefix);
    let mut names: Vec<_> = fs::read_dir(&dir)?.collect::<Result<_, _>>()?;
    names.sort_by_key(|e| e.file_name());
    for e in names {
        let rel = format!("{prefix}/{}", e.file_name().to_string_lossy());
        let ft = e.file_type()?;
        if ft.is_dir() {
            out.dirs.push(rel.clone());
            walk(root, &rel, out)?;
        } else if ft.is_file() {
            out.files.push((rel, e.path()));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn mode_of(p: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(p).ok().map(|m| m.permissions().mode() & 0o777)
}
#[cfg(not(unix))]
fn mode_of(_: &Path) -> Option<u32> {
    None
}

/// The directory the core staged into must be one of its own, `<home>/state/backup-staging/<id>`, before the CLI reads
/// from it or removes it.
pub fn check_staging_dir(layout: &Layout, snap: &Snapshot) -> Result<PathBuf, BackupError> {
    let root = fs::canonicalize(layout.state().join("backup-staging"))
        .map_err(|e| BackupError::new("snapshot-mismatch", format!("no staging area: {e}")))?;
    let dir = fs::canonicalize(&snap.dir).map_err(|e| {
        BackupError::new(
            "snapshot-mismatch",
            format!("the staged snapshot is not there: {e}"),
        )
    })?;
    if dir.parent() != Some(root.as_path()) {
        return Err(BackupError::new(
            "snapshot-mismatch",
            format!(
                "{} is not a staging directory of this home",
                snap.dir.display()
            ),
        ));
    }
    Ok(dir)
}

/// Builds and writes the archive; `snap` is the core's staged snapshot. The staged directories are removed on every path.
pub fn create(layout: &Layout, out: &Path, snap: &Snapshot) -> Result<CreateReport, BackupError> {
    let engine_dir = check_staging_dir(layout, snap)?;
    let _engine_cleanup = Cleanup(engine_dir.clone());
    let ms = now_ms();
    let backups = ensure_backups_dir(layout)?;
    let stage = backups.join(format!(".staging-{ms}-{}", short_id()));
    fs::create_dir_all(&stage)?;
    let _stage_cleanup = Cleanup(stage.clone());
    if !store_target_allowed(&snap.store_target) {
        return Err(BackupError::new(
            "manifest-invalid",
            format!("store target {:?} is not allowed", snap.store_target),
        ));
    }
    let store = snap.store_target.as_str();

    let mut skipped = Vec::new();
    let mut units: Vec<Unit> = vec![Unit {
        archive: "store".into(),
        target: store.into(),
        kind: Kind::Dir,
    }];
    for (target, kind) in ENGINE_DIRS
        .iter()
        .map(|t| (*t, Kind::Dir))
        .chain(ENGINE_FILES.iter().map(|t| (*t, Kind::File)))
    {
        let archive = archive_prefix(target, store);
        let p = join_rel(&engine_dir, &archive);
        let ok = match kind {
            Kind::Dir => p.is_dir(),
            Kind::File => p.is_file(),
        };
        if ok {
            units.push(Unit {
                archive,
                target: target.into(),
                kind,
            });
        }
    }
    let sqlite_dir = engine_dir.join("sqlite");
    if sqlite_dir.is_dir() {
        let mut w = Walked {
            files: vec![],
            dirs: vec![],
        };
        walk(&engine_dir, "sqlite", &mut w)?;
        for (rel, _) in w.files {
            let target = format!("state/{}", &rel["sqlite/".len()..]);
            units.push(Unit {
                archive: rel,
                target,
                kind: Kind::File,
            });
        }
    }
    for (target, kind) in plain_targets() {
        let live = join_rel(&layout.home, target);
        let archive = archive_prefix(target, store);
        match fs::symlink_metadata(&live) {
            Ok(m) if m.file_type().is_symlink() => skipped.push(target.to_string()),
            Ok(m) if kind == Kind::Dir && m.is_dir() => {
                copy_tree(&live, &join_rel(&stage, &archive), target, &mut skipped)?;
                units.push(Unit {
                    archive,
                    target: target.into(),
                    kind,
                });
            }
            Ok(m) if kind == Kind::File && m.is_file() => {
                let dst = join_rel(&stage, &archive);
                copy_file_stable(&live, &dst, target)?;
                units.push(Unit {
                    archive,
                    target: target.into(),
                    kind,
                });
            }
            Ok(_) => skipped.push(target.to_string()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    for u in &units {
        if target_kind(&u.target, store) != Some(u.kind) {
            return Err(BackupError::new(
                "manifest-invalid",
                format!("unit {:?} is not allowed", u.target),
            ));
        }
    }

    // Hash everything that will be archived, from its final location.
    let mut sources: HashMap<String, PathBuf> = HashMap::new();
    let mut dirs = BTreeSet::new();
    let mut files: Vec<FileEntry> = Vec::new();
    for u in &units {
        let root = if exists_nofollow(&join_rel(&engine_dir, &u.archive)) {
            &engine_dir
        } else {
            &stage
        };
        let mut w = Walked {
            files: vec![],
            dirs: vec![],
        };
        match u.kind {
            Kind::File => w
                .files
                .push((u.archive.clone(), join_rel(root, &u.archive))),
            Kind::Dir => walk(root, &u.archive, &mut w)?,
        }
        dirs.extend(w.dirs);
        for (rel, path) in w.files {
            let (sha256, bytes) = hash_file(&path)?;
            files.push(FileEntry {
                path: rel.clone(),
                bytes,
                sha256,
                mode: mode_of(&path),
            });
            sources.insert(rel, path);
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    // The core's own digests must agree with what is on disk now, file for file (nothing added, nothing missing).
    let reported: HashMap<&str, &SnapFile> =
        snap.files.iter().map(|f| (f.path.as_str(), f)).collect();
    for f in files.iter().filter(|f| engine_owned(&f.path)) {
        match reported.get(f.path.as_str()) {
            Some(r) if r.sha256 == f.sha256 && r.bytes == f.bytes => {}
            _ => {
                return Err(BackupError::new(
                    "snapshot-mismatch",
                    format!("{} differs from what the core staged", f.path),
                ))
            }
        }
    }
    let have: BTreeSet<&str> = files.iter().map(|f| f.path.as_str()).collect();
    if let Some(m) = snap.files.iter().find(|f| !have.contains(f.path.as_str())) {
        return Err(BackupError::new(
            "snapshot-mismatch",
            format!("{} was staged but is not in the archive plan", m.path),
        ));
    }

    let present: BTreeSet<&str> = units.iter().map(|u| u.target.as_str()).collect();
    let absent: Vec<String> = FIXED_DIRS
        .iter()
        .chain(FIXED_FILES)
        .filter(|t| !present.contains(**t))
        .map(|t| t.to_string())
        .collect();
    let manifest = Manifest {
        schema: SCHEMA.into(),
        created_at_ms: ms,
        harness: Harness {
            version: env!("CARGO_PKG_VERSION").into(),
        },
        platform: Platform {
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
        },
        engine: Engine {
            contract: snap.engine.contract.clone(),
            store_schema: snap.engine.store_schema.clone(),
        },
        store_target: store.into(),
        units,
        absent,
        dirs: dirs.into_iter().collect(),
        files,
        skipped,
        secrets: Secrets {
            included: false,
            note: SECRETS_NOTE.into(),
        },
    };
    manifest.validate()?;
    write_archive(out, &manifest, &sources)?;
    // The archive just written must be one a restore would accept.
    let check = verify(out).inspect_err(|_| {
        let _ = fs::remove_file(out);
    })?;
    debug_assert_eq!(check, manifest);
    Ok(CreateReport {
        path: out.to_path_buf(),
        bytes: fs::metadata(out)?.len(),
        files: manifest.files.len(),
        units: manifest.units.iter().map(|u| u.target.clone()).collect(),
        absent: manifest.absent.clone(),
        skipped: manifest.skipped.clone(),
        created_at_ms: ms,
        engine: manifest.engine.clone(),
    })
}

/// Archive paths the core stages (`store/`, `memory/`, `sqlite/`).
fn engine_owned(path: &str) -> bool {
    ["store/", "memory/", "sqlite/"]
        .iter()
        .any(|p| path.starts_with(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_owned_paths_are_the_three_staged_prefixes() {
        assert!(
            engine_owned("store/x")
                && engine_owned("memory/run-state.json")
                && engine_owned("sqlite/a.db")
        );
        assert!(
            !engine_owned("config.json") && !engine_owned("agents/x") && !engine_owned("journal/a")
        );
    }

    #[test]
    fn a_staging_directory_outside_the_homes_staging_area_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let layout = Layout::new(d.path().to_path_buf());
        fs::create_dir_all(layout.state().join("backup-staging").join("plur1bus-x")).unwrap();
        fs::create_dir_all(d.path().join("elsewhere")).unwrap();
        let snap = |dir: PathBuf| Snapshot {
            dir,
            store_target: "state/lancedb".into(),
            engine: EngineInfo {
                contract: "1.12.0".into(),
                store_schema: None,
            },
            files: vec![],
        };
        assert!(check_staging_dir(
            &layout,
            &snap(layout.state().join("backup-staging").join("plur1bus-x"))
        )
        .is_ok());
        for bad in [
            d.path().join("elsewhere"),
            layout.state().join("backup-staging"),
            d.path().to_path_buf(),
        ] {
            assert_eq!(
                check_staging_dir(&layout, &snap(bad)).unwrap_err().reason,
                "snapshot-mismatch"
            );
        }
    }
}
