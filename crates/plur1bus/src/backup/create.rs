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
    /// The manifest's names-only disclosure note, reused by the CLI without adding result fields.
    pub secrets_note: String,
}

/// Creation-only selection. Ordinary archives exclude API credential material unless explicitly requested (SH8).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct CreateOpts {
    /// Include the staged API account database; the archive remains unencrypted. Defaults to false.
    pub include_api_accounts: bool,
}

fn selected_snapshot_path(path: &str, opts: CreateOpts) -> bool {
    opts.include_api_accounts || !path.eq_ignore_ascii_case("sqlite/api/accounts.db")
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

/// Gives the private staged copy the permission bits of its source. The manifest records the bits of the file it hashes
/// (`mode_of`), and a restore keeps the owner's: a skill script that is executable in the home must be recorded as such, or
/// it comes back unusable. (`create_private` opens the copy 0600 whatever the source was.)
#[cfg(unix)]
fn copy_mode(source: &fs::Metadata, dst: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
        dst,
        fs::Permissions::from_mode(source.permissions().mode() & 0o777),
    )
}
#[cfg(not(unix))]
fn copy_mode(_: &fs::Metadata, _: &Path) -> io::Result<()> {
    Ok(())
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
        copy_mode(&before, dst)?;
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

/// Builds an ordinary archive excluding API accounts; staged directories are removed on every path.
pub fn create(layout: &Layout, out: &Path, snap: &Snapshot) -> Result<CreateReport, BackupError> {
    create_with_opts(layout, out, snap, CreateOpts::default())
}

/// Builds an archive with explicit creation-only selection. Refuses inconsistent staged data and cleans staging on exit.
pub fn create_with_opts(
    layout: &Layout,
    out: &Path,
    snap: &Snapshot,
    opts: CreateOpts,
) -> Result<CreateReport, BackupError> {
    let engine_dir = check_staging_dir(layout, snap)?;
    let _engine_cleanup = Cleanup(engine_dir.clone());
    if !store_target_allowed(&snap.store_target) {
        return Err(BackupError::new(
            "manifest-invalid",
            format!("store target {:?} is not allowed", snap.store_target),
        ));
    }
    super::store_guard::check_store_target(layout, &snap.store_target)?;
    let ms = now_ms();
    let backups = ensure_backups_dir(layout)?;
    let stage = backups.join(format!(".staging-{ms}-{}", short_id()));
    fs::create_dir_all(&stage)?;
    let _stage_cleanup = Cleanup(stage.clone());
    let store = snap.store_target.as_str();

    let mut skipped = Vec::new();
    let mut redacted_config_keys = Vec::new();
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
            // A stray `-wal`/`-shm` next to a staged database is connection state, not data: it is not planned.
            if is_sqlite_sidecar(&rel) || !selected_snapshot_path(&rel, opts) {
                continue;
            }
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
                if target == "config.json" {
                    // A secret VALUE kept in the config never reaches the archive (the live file is not touched).
                    redacted_config_keys = super::redact::redact_staged_config(layout, &dst)?;
                }
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
    let reported: HashMap<&str, &SnapFile> = snap
        .files
        .iter()
        .filter(|f| selected_snapshot_path(&f.path, opts))
        .map(|f| (f.path.as_str(), f))
        .collect();
    for f in files.iter().filter(|f| engine_owned(&f.path)) {
        match reported.get(f.path.as_str()) {
            Some(r) if r.sha256 == f.sha256 && r.bytes == f.bytes => {}
            _ => {
                return Err(BackupError::new(
                    "snapshot-mismatch",
                    format!("{} differs from what the core staged", f.path),
                ));
            }
        }
    }
    let have: BTreeSet<&str> = files.iter().map(|f| f.path.as_str()).collect();
    if let Some(m) = snap
        .files
        .iter()
        .filter(|f| selected_snapshot_path(&f.path, opts))
        .find(|f| !have.contains(f.path.as_str()))
    {
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
            note: if opts.include_api_accounts {
                secrets_note_with_api_accounts(&redacted_config_keys, true)
            } else {
                secrets_note(&redacted_config_keys)
            },
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
        secrets_note: manifest.secrets.note.clone(),
    })
}

/// Archive paths the core stages (`store/`, `memory/`, `sqlite/`).
fn engine_owned(path: &str) -> bool {
    ["store/", "memory/", "sqlite/"]
        .iter()
        .any(|p| path.starts_with(p))
}

/// A core-staged snapshot fixture for the tests of `create` and `restore`.
#[cfg(test)]
pub(crate) mod testkit {
    use super::*;

    /// `<home>/state/backup-staging/plur1bus-t` with a store file and one database `sqlite/budget.sqlite`; with
    /// `sidecars`, a `-wal` and a `-shm` lie next to the database as a read-only open of a WAL copy leaves them.
    pub fn staged(layout: &Layout, db: &[u8], sidecars: bool) -> Snapshot {
        let dir = layout.state().join("backup-staging").join("plur1bus-t");
        fs::create_dir_all(dir.join("store")).unwrap();
        fs::create_dir_all(dir.join("sqlite")).unwrap();
        fs::write(dir.join("store/t.lance"), b"store").unwrap();
        fs::write(dir.join("sqlite/budget.sqlite"), db).unwrap();
        if sidecars {
            fs::write(dir.join("sqlite/budget.sqlite-shm"), b"shm").unwrap();
            fs::write(dir.join("sqlite/budget.sqlite-wal"), b"wal").unwrap();
        }
        let files = ["store/t.lance", "sqlite/budget.sqlite"]
            .map(|p| {
                let (sha256, bytes) = hash_file(&dir.join(p)).unwrap();
                SnapFile {
                    path: p.into(),
                    bytes,
                    sha256,
                }
            })
            .to_vec();
        Snapshot {
            dir,
            store_target: "state/lancedb".into(),
            engine: EngineInfo {
                contract: "1.12.0".into(),
                store_schema: None,
            },
            files,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn add_staged_file(snap: &mut Snapshot, path: &str, contents: &[u8]) {
        let staged = snap.dir.join(path);
        fs::create_dir_all(staged.parent().unwrap()).unwrap();
        fs::write(&staged, contents).unwrap();
        let (sha256, bytes) = hash_file(&staged).unwrap();
        snap.files.push(SnapFile {
            path: path.into(),
            bytes,
            sha256,
        });
    }

    fn archive_entry(out: &Path, wanted: &str) -> Option<Vec<u8>> {
        let decoder = flate2::read::GzDecoder::new(fs::File::open(out).unwrap());
        let mut archive = tar::Archive::new(decoder);
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            if entry.path().unwrap().as_ref() == Path::new(wanted) {
                let mut contents = Vec::new();
                entry.read_to_end(&mut contents).unwrap();
                return Some(contents);
            }
        }
        None
    }

    fn assert_refused_and_cleaned(
        layout: &Layout,
        snap: &Snapshot,
        out: &Path,
        opts: CreateOpts,
        reason: &str,
    ) {
        let error = create_with_opts(layout, out, snap, opts).err().unwrap();
        assert_eq!(error.reason, reason, "{error}");
        assert!(!out.exists(), "a refused backup must not be published");
        assert!(!snap.dir.exists(), "private Core staging must be cleaned");
        let backups = backups_dir(layout);
        if backups.exists() {
            assert!(!fs::read_dir(backups).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .as_encoded_bytes()
                    .starts_with(b".staging-")
            }));
        }
    }

    #[test]
    fn ordinary_backups_omit_api_accounts_but_keep_other_sqlite_databases() {
        let d = tempfile::tempdir().unwrap();
        let layout = Layout::new(d.path().to_path_buf());
        let mut snap = testkit::staged(&layout, b"budget database", false);
        let marker = format!("account-credential-{}", uuid::Uuid::new_v4());
        let account = snap.dir.join("sqlite/api/accounts.db");
        fs::create_dir_all(account.parent().unwrap()).unwrap();
        fs::write(&account, marker.as_bytes()).unwrap();
        let (sha256, bytes) = hash_file(&account).unwrap();
        snap.files.push(SnapFile {
            path: "sqlite/api/accounts.db".into(),
            bytes,
            sha256,
        });
        let out = d.path().join("ordinary.tar.gz");
        let report = create(&layout, &out, &snap).unwrap();
        let manifest = verify(&out).unwrap();
        assert!(!manifest
            .units
            .iter()
            .any(|unit| unit.target.eq_ignore_ascii_case("state/api/accounts.db")));
        assert!(!manifest
            .files
            .iter()
            .any(|file| file.path.eq_ignore_ascii_case("sqlite/api/accounts.db")));
        assert!(!report
            .absent
            .iter()
            .any(|target| target.eq_ignore_ascii_case("state/api/accounts.db")));
        assert!(manifest
            .files
            .iter()
            .any(|file| file.path == "sqlite/budget.sqlite"));
        let mut unpacked = Vec::new();
        flate2::read::GzDecoder::new(fs::File::open(&out).unwrap())
            .read_to_end(&mut unpacked)
            .unwrap();
        assert!(!unpacked
            .windows(marker.len())
            .any(|window| window == marker.as_bytes()));
        let mut archive = tar::Archive::new(unpacked.as_slice());
        for entry in archive.entries().unwrap() {
            assert!(!entry
                .unwrap()
                .path()
                .unwrap()
                .as_os_str()
                .as_encoded_bytes()
                .eq_ignore_ascii_case(b"data/sqlite/api/accounts.db"));
        }
        assert!(!snap.dir.exists(), "private Core staging must be cleaned");
    }

    #[test]
    fn account_selection_matches_only_the_canonical_path_ignoring_ascii_case() {
        for account in ["sqlite/api/accounts.db", "sqlite/Api/Accounts.DB"] {
            for include_api_accounts in [false, true] {
                let d = tempfile::tempdir().unwrap();
                let layout = Layout::new(d.path().to_path_buf());
                let mut snap = testkit::staged(&layout, b"budget database", false);
                let marker = format!("account-credential-{}", uuid::Uuid::new_v4());
                add_staged_file(&mut snap, account, marker.as_bytes());
                let account_parent = account.rsplit_once('/').unwrap().0;
                let unrelated_paths = [
                    format!("{account_parent}/accounts-copy.db"),
                    "sqlite/other/accounts.db".to_string(),
                    format!("{account_parent}/accounts.db.sqlite"),
                ];
                for unrelated in &unrelated_paths {
                    add_staged_file(&mut snap, unrelated, b"unrelated database");
                }
                let out = d.path().join("selection.tar.gz");
                create_with_opts(
                    &layout,
                    &out,
                    &snap,
                    CreateOpts {
                        include_api_accounts,
                    },
                )
                .unwrap();
                let manifest = verify(&out).unwrap();
                assert_eq!(
                    manifest.files.iter().any(|file| file.path == account),
                    include_api_accounts
                );
                assert_eq!(
                    archive_entry(&out, &format!("data/{account}")),
                    include_api_accounts.then(|| marker.as_bytes().to_vec())
                );
                for unrelated in unrelated_paths
                    .iter()
                    .map(String::as_str)
                    .chain(["sqlite/budget.sqlite"])
                {
                    assert!(manifest.files.iter().any(|file| file.path == unrelated));
                }
                assert!(!manifest
                    .absent
                    .iter()
                    .any(|target| target.eq_ignore_ascii_case("state/api/accounts.db")));
                assert!(!snap.dir.exists());
            }
        }
    }

    #[test]
    fn excluding_accounts_keeps_both_directions_of_unrelated_snapshot_completeness_strict() {
        for change in [
            "changed",
            "unreported",
            "missing",
            "added",
            "report-only",
            "reported-sidecar",
            "reported-account-sidecar",
            "changed-store",
        ] {
            let d = tempfile::tempdir().unwrap();
            let layout = Layout::new(d.path().to_path_buf());
            let mut snap = testkit::staged(&layout, b"budget database", false);
            let marker = format!("account-credential-{}", uuid::Uuid::new_v4());
            add_staged_file(&mut snap, "sqlite/api/accounts.db", marker.as_bytes());
            match change {
                "changed" => fs::write(snap.dir.join("sqlite/budget.sqlite"), b"changed").unwrap(),
                "unreported" => snap
                    .files
                    .retain(|file| file.path != "sqlite/budget.sqlite"),
                "missing" => fs::remove_file(snap.dir.join("sqlite/budget.sqlite")).unwrap(),
                "added" => fs::write(snap.dir.join("sqlite/extra.db"), b"unreported").unwrap(),
                "report-only" => snap.files.push(SnapFile {
                    path: "sqlite/extra.db".into(),
                    bytes: 0,
                    sha256: "0".repeat(64),
                }),
                "reported-sidecar" => {
                    add_staged_file(&mut snap, "sqlite/budget.sqlite-wal", b"connection state")
                }
                "reported-account-sidecar" => {
                    add_staged_file(&mut snap, "sqlite/api/accounts.db-wal", b"connection state")
                }
                "changed-store" => fs::write(snap.dir.join("store/t.lance"), b"changed").unwrap(),
                _ => unreachable!(),
            }
            assert_refused_and_cleaned(
                &layout,
                &snap,
                &d.path().join("mismatch.tar.gz"),
                CreateOpts::default(),
                "snapshot-mismatch",
            );
        }
    }

    #[test]
    fn account_snapshot_mismatches_are_ignored_only_when_accounts_are_not_selected() {
        for include_api_accounts in [false, true] {
            for change in ["changed", "missing", "unreported", "misreported"] {
                let d = tempfile::tempdir().unwrap();
                let layout = Layout::new(d.path().to_path_buf());
                let mut snap = testkit::staged(&layout, b"budget database", false);
                let marker = format!("account-credential-{}", uuid::Uuid::new_v4());
                let account = "sqlite/api/accounts.db";
                add_staged_file(&mut snap, account, marker.as_bytes());
                match change {
                    "changed" => fs::write(snap.dir.join(account), b"changed").unwrap(),
                    "missing" => fs::remove_file(snap.dir.join(account)).unwrap(),
                    "unreported" => snap.files.retain(|file| file.path != account),
                    "misreported" => snap.files.last_mut().unwrap().bytes += 1,
                    _ => unreachable!(),
                }
                let out = d.path().join("selected-mismatch.tar.gz");
                let opts = CreateOpts {
                    include_api_accounts,
                };
                if include_api_accounts {
                    assert_refused_and_cleaned(&layout, &snap, &out, opts, "snapshot-mismatch");
                } else {
                    create_with_opts(&layout, &out, &snap, opts).unwrap();
                    assert!(archive_entry(&out, "data/sqlite/api/accounts.db").is_none());
                    assert!(!snap.dir.exists());
                }
            }
        }
    }

    #[test]
    fn missing_account_sources_never_become_absent_deletion_markers() {
        for include_api_accounts in [false, true] {
            let d = tempfile::tempdir().unwrap();
            let layout = Layout::new(d.path().to_path_buf());
            let snap = testkit::staged(&layout, b"budget database", false);
            let out = d.path().join("no-account-source.tar.gz");
            create_with_opts(
                &layout,
                &out,
                &snap,
                CreateOpts {
                    include_api_accounts,
                },
            )
            .unwrap();
            let manifest = verify(&out).unwrap();
            assert!(!manifest
                .units
                .iter()
                .any(|unit| unit.target.eq_ignore_ascii_case("state/api/accounts.db")));
            assert!(!manifest
                .absent
                .iter()
                .any(|target| target.eq_ignore_ascii_case("state/api/accounts.db")));
        }
    }

    #[test]
    fn overlapping_store_targets_refuse_both_modes_and_remove_validated_staging() {
        for include_api_accounts in [false, true] {
            for target in [
                "state/api",
                "STATE/API",
                "state/api/accounts.db",
                "STATE/API/ACCOUNTS.DB/child",
            ] {
                let d = tempfile::tempdir().unwrap();
                let layout = Layout::new(d.path().to_path_buf());
                let mut snap = testkit::staged(&layout, b"budget database", false);
                snap.store_target = target.into();
                assert_refused_and_cleaned(
                    &layout,
                    &snap,
                    &d.path().join("overlap.tar.gz"),
                    CreateOpts {
                        include_api_accounts,
                    },
                    "manifest-invalid",
                );
            }
        }
    }

    #[test]
    fn sibling_store_targets_and_missing_leaves_remain_creatable_in_both_modes() {
        for include_api_accounts in [false, true] {
            for target in [
                "state/api/store",
                "state/api-archive",
                "state/api/accounts.db2",
            ] {
                let d = tempfile::tempdir().unwrap();
                let layout = Layout::new(d.path().to_path_buf());
                let mut snap = testkit::staged(&layout, b"budget database", false);
                snap.store_target = target.into();
                let out = d.path().join("sibling.tar.gz");
                create_with_opts(
                    &layout,
                    &out,
                    &snap,
                    CreateOpts {
                        include_api_accounts,
                    },
                )
                .unwrap();
                assert_eq!(verify(&out).unwrap().store_target, target);
                assert!(!snap.dir.exists());
            }
        }
    }

    #[cfg(any(unix, windows))]
    fn directory_alias(target: &Path, alias: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, alias).unwrap();
        #[cfg(windows)]
        {
            // A directory junction needs neither administrator privileges nor Developer Mode.
            let result = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(alias)
                .arg(target)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "junction fixture failed: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn live_store_or_account_parent_aliases_cannot_bypass_account_separation() {
        for include_api_accounts in [false, true] {
            for alias in ["store", "store-parent", "account-parent"] {
                let d = tempfile::tempdir().unwrap();
                let layout = Layout::new(d.path().to_path_buf());
                let mut snap = testkit::staged(&layout, b"budget database", false);
                let api = layout.state().join(if alias == "account-parent" {
                    "real-api"
                } else {
                    "api"
                });
                fs::create_dir_all(&api).unwrap();
                let marker = format!("account-credential-{}", uuid::Uuid::new_v4());
                fs::write(api.join("accounts.db"), marker.as_bytes()).unwrap();
                match alias {
                    "store" => directory_alias(&api, &layout.state().join("lancedb")),
                    "store-parent" => {
                        directory_alias(&layout.state(), &layout.home.join("state-alias"));
                        snap.store_target = "state-alias/api".into();
                    }
                    "account-parent" => {
                        directory_alias(&api, &layout.state().join("api"));
                        snap.store_target = "state/real-api".into();
                    }
                    _ => unreachable!(),
                }
                add_staged_file(&mut snap, "store/accounts.db", marker.as_bytes());
                assert_refused_and_cleaned(
                    &layout,
                    &snap,
                    &d.path().join("alias.tar.gz"),
                    CreateOpts {
                        include_api_accounts,
                    },
                    "manifest-invalid",
                );
                assert_eq!(
                    fs::read(api.join("accounts.db")).unwrap(),
                    marker.as_bytes()
                );
            }
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn dangling_live_store_aliases_refuse_instead_of_falling_back_to_a_lexical_path() {
        for include_api_accounts in [false, true] {
            let d = tempfile::tempdir().unwrap();
            let layout = Layout::new(d.path().to_path_buf());
            let snap = testkit::staged(&layout, b"budget database", false);
            directory_alias(&layout.state().join("api"), &layout.state().join("lancedb"));
            assert_refused_and_cleaned(
                &layout,
                &snap,
                &d.path().join("dangling.tar.gz"),
                CreateOpts {
                    include_api_accounts,
                },
                "io",
            );
        }
    }

    #[test]
    fn sqlite_sidecars_next_to_a_staged_database_are_neither_planned_nor_archived() {
        // Regression: `manifest-invalid: unit "state/budget.sqlite-shm" is not allowed` on a fresh home.
        let d = tempfile::tempdir().unwrap();
        let layout = Layout::new(d.path().to_path_buf());
        let snap = testkit::staged(&layout, b"database bytes", true);
        let out = d.path().join("backup.tar.gz");
        let report = create(&layout, &out, &snap).expect("a stray -shm/-wal must not fail create");
        assert!(report.units.contains(&"state/budget.sqlite".to_string()));
        assert!(
            !report.units.iter().any(|u| is_sqlite_sidecar(u)),
            "{:?}",
            report.units
        );
        let manifest = verify(&out).unwrap();
        assert!(
            !manifest.files.iter().any(|f| is_sqlite_sidecar(&f.path)),
            "{:?}",
            manifest.files.iter().map(|f| &f.path).collect::<Vec<_>>()
        );
        assert!(manifest
            .files
            .iter()
            .any(|f| f.path == "sqlite/budget.sqlite"));
    }

    #[test]
    fn sidecar_names_are_recognised_case_insensitively_and_only_as_suffixes() {
        for n in ["a.sqlite-wal", "a.db-SHM", "state/x.sqlite3-journal"] {
            assert!(is_sqlite_sidecar(n), "{n}");
        }
        for n in ["a.sqlite", "wal.db", "a.sqlite-walnut", "journal"] {
            assert!(!is_sqlite_sidecar(n), "{n}");
        }
    }

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
