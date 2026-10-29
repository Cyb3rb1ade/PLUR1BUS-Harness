//! Filesystem package storage and the shared rename/rollback primitives (spec §6.2, Owner decision Mv2-5).
//! MCP code is versioned under `mcp/<name>/<version>/`; providers retain their inert flat library store.
//! Package parsing and extraction live exclusively in `package_worker.rs`, called by the isolated extension worker.
use super::commit::{fail_at, killed, reset_kill};
use super::state::{remove_dir_all_retrying, remove_empty_dir_retrying, rename_retrying};
use super::ExtError;
use crate::paths::Layout;
use plur1bus_ext::manifest::valid_name;
use plur1bus_ext::rights::Right;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub(super) const RECORD: &str = "record.json";
pub(super) const STAGING: &str = ".staging";

pub(super) fn nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

/// What the person acknowledged (X1's flags, same meaning): without them an unsigned or unknown-signer package, or a
/// lower version of an installed one, is refused with `E_APPROVAL_REQUIRED acknowledge-<x>` and nothing is written.
#[derive(Clone, Debug, Default)]
pub struct InstallOpts {
    pub allow_unsigned: bool,
    pub allow_unknown_signer: bool,
    pub allow_downgrade: bool,
}

/// What an install did.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub name: String,
    pub id: String,
    pub version: String,
    pub kind: String,
    /// An older or equal version of the same id was replaced.
    pub replaced: bool,
    /// The identical package (same id and SHA-256) was already installed: nothing was written.
    pub unchanged: bool,
    pub rights: Vec<Right>,
}

#[cfg(test)]
pub(super) type StageHook = Box<dyn Fn(&Path)>;

pub struct PackageStore {
    pub(super) root: PathBuf,
    pub(super) versioned: bool,
    /// Where `config.json` lives (`extensions.allowUnsigned`, read at every install); `None` for a store made with
    /// [`PackageStore::at`], which has no configuration and applies no policy of its own.
    pub(super) layout: Option<Layout>,
    /// Test seam: runs on the spool copy after the audit (it gets the spool path), before it is hashed again.
    #[cfg(test)]
    pub(super) after_inspect: Option<StageHook>,
    /// Test seam: runs on the extracted staging tree before it is checked.
    #[cfg(test)]
    pub(super) after_extract: Option<StageHook>,
    /// Test seam: the step that fails (the env seam `PLUR1BUS_TEST_EXT_FAIL_AT` needs a process-wide variable).
    #[cfg(test)]
    pub(super) fail: Option<&'static str>,
    /// Test seam: this store ignores the process-wide seams (`PLUR1BUS_TEST_EXT_FAIL_AT` and the kill flag it sets).
    /// `tests/ext_commit.rs` and its siblings include this file, so the unit tests below share a process with tests
    /// that set them, and a kill seam raised by one of those used to make an install here skip its rollback.
    #[cfg(test)]
    pub(super) isolated: bool,
}

pub(super) fn io_err(what: &str, p: &Path, e: &std::io::Error) -> ExtError {
    ExtError::new("E_INTERNAL", "io", format!("{what} {}: {e}", p.display()))
}

/// What a failed install has to put back, in reverse: `new` (the staging directory or the placed package), `aside`
/// (the replaced package's directory under its aside name), `old` (where it belongs).
#[derive(Default)]
pub(crate) struct Txn {
    pub(super) staging: Option<PathBuf>,
    pub(super) placed: Option<PathBuf>,
    pub(super) aside: Option<(PathBuf, PathBuf)>,
    created_dirs: Vec<PathBuf>,
}

impl Txn {
    /// Places one complete checked tree; callers keep this transaction until all their state writes commit.
    pub(crate) fn place(&mut self, stage: &Path, dest: &Path) -> Result<(), ExtError> {
        if let Some(parent) = dest.parent() {
            let mut at = Some(parent);
            while let Some(dir) = at.filter(|p| !p.exists()) {
                self.created_dirs.push(dir.to_path_buf());
                at = dir.parent();
            }
            std::fs::create_dir_all(parent).map_err(|e| io_err("cannot create", parent, &e))?;
        }
        rename_retrying(stage, dest).map_err(|e| io_err("cannot move into place", stage, &e))?;
        self.staging = None;
        self.placed = Some(dest.to_path_buf());
        Ok(())
    }

    pub(crate) fn rollback(&mut self) -> Vec<String> {
        let mut failed = Vec::new();
        if let Some(p) = self.placed.take() {
            if let Err(e) = remove_dir_all_retrying(&p) {
                failed.push(format!("{}: {e}", p.display()));
            }
        }
        if let Some((aside, old)) = self.aside.take() {
            if let Err(e) = rename_retrying(&aside, &old) {
                failed.push(format!("restore {}: {e}", old.display()));
            }
        }
        if let Some(s) = self.staging.take() {
            if let Err(e) = remove_dir_all_retrying(&s) {
                failed.push(format!("{}: {e}", s.display()));
            }
        }
        for dir in self.created_dirs.drain(..) {
            if let Err(e) = remove_empty_dir_retrying(&dir) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    failed.push(format!("{}: {e}", dir.display()));
                }
            }
        }
        failed
    }
}

impl PackageStore {
    pub fn of(layout: &Layout) -> Self {
        let mut store = Self::at(layout.extensions().join("packages"));
        store.layout = Some(layout.clone());
        store
    }

    pub fn at(root: PathBuf) -> Self {
        PackageStore {
            root,
            versioned: false,
            layout: None,
            #[cfg(test)]
            after_inspect: None,
            #[cfg(test)]
            after_extract: None,
            #[cfg(test)]
            fail: None,
            #[cfg(test)]
            isolated: false,
        }
    }

    /// A versioned MCP store. `at` and `of` retain the provider library API.
    pub fn versioned_at(root: PathBuf) -> Self {
        let mut store = Self::at(root);
        store.versioned = true;
        store
    }

    pub fn mcp_of(layout: &Layout) -> Self {
        let mut store = Self::versioned_at(layout.home.join("mcp"));
        store.layout = Some(layout.clone());
        store
    }

    pub fn version_dir(&self, name: &str, version: &str) -> Result<PathBuf, ExtError> {
        let name_dir = self.dir_of(name)?;
        if !valid_version(version) {
            return Err(ExtError::new(
                "E_INVALID_PARAMS",
                "package-invalid",
                "invalid MCP version path",
            ));
        }
        Ok(name_dir.join(version))
    }

    pub fn record_version(&self, name: &str, version: &str) -> Result<Option<Value>, ExtError> {
        read_record(&self.version_dir(name, version)?.join(RECORD))
    }

    /// One named step of an install or uninstall: the test seams fail or pause it here.
    pub(super) fn step(&self, point: &str) -> Result<(), ExtError> {
        #[cfg(test)]
        if self.fail == Some(point) {
            return Err(ExtError::new(
                "E_INTERNAL",
                "io",
                format!("test seam: the {point} step failed"),
            ));
        }
        #[cfg(test)]
        if self.isolated {
            return Ok(());
        }
        fail_at(point)
    }

    /// The process-wide kill flag is reset by a real install; an isolated (unit test) store neither touches nor reads it.
    pub(super) fn reset_kill(&self) {
        #[cfg(test)]
        if self.isolated {
            return;
        }
        reset_kill();
    }

    pub(super) fn killed(&self) -> bool {
        #[cfg(test)]
        if self.isolated {
            return false;
        }
        killed()
    }

    pub(super) fn staging(&self) -> PathBuf {
        self.root.join(STAGING)
    }

    pub(super) fn dir_of(&self, name: &str) -> Result<PathBuf, ExtError> {
        if !valid_name(name) {
            return Err(ExtError::new(
                "E_INVALID_PARAMS",
                "package-invalid",
                format!("{name:?} is not a valid extension name"),
            ));
        }
        Ok(self.root.join(name))
    }

    /// The installed record of `name`, `None` when it is not installed.
    pub fn record(&self, name: &str) -> Result<Option<Value>, ExtError> {
        read_record(&self.dir_of(name)?.join(RECORD))
    }

    /// The names of the installed packages, sorted.
    pub fn names(&self) -> Result<Vec<String>, ExtError> {
        let mut out = Vec::new();
        let rd = match std::fs::read_dir(&self.root) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(io_err("cannot read", &self.root, &e)),
        };
        for e in rd {
            let e = e.map_err(|e| io_err("cannot read", &self.root, &e))?;
            if let Some(n) = e.file_name().to_str().filter(|n| valid_name(n)) {
                if e.path().join(RECORD).is_file() {
                    out.push(n.to_string());
                }
            }
        }
        out.sort();
        Ok(out)
    }

    /// Removes the package directory of `name`. It moves out of sight in one rename, then is deleted; `Ok(false)` when
    /// it was not installed. `data/ext/<name>/` is not this store's and stays (X1-R31).
    pub fn uninstall(&self, name: &str) -> Result<bool, ExtError> {
        self.reset_kill();
        let dir = self.dir_of(name)?;
        if std::fs::symlink_metadata(&dir).is_err() {
            return Ok(false);
        }
        let staging_root = self.staging();
        std::fs::create_dir_all(&staging_root)
            .map_err(|e| io_err("cannot create", &staging_root, &e))?;
        let gone = staging_root.join(format!("{name}-gone-{}", nonce()));
        rename_retrying(&dir, &gone).map_err(|e| io_err("cannot move", &dir, &e))?;
        if let Err(e) = self.step("uninstall.trash") {
            if !self.killed() {
                let _ = rename_retrying(&gone, &dir);
                self.prune_empty();
            }
            return Err(e);
        }
        let _ = remove_dir_all_retrying(&gone);
        self.prune_empty();
        Ok(true)
    }

    /// Reconciles what a killed install or uninstall left in `.staging/`: a replaced package under its aside name
    /// goes back when its directory is missing (else it is removed); every other entry is removed.
    pub fn recover(&self) -> Result<(), ExtError> {
        let sd = self.staging();
        let rd = match std::fs::read_dir(&sd) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(io_err("cannot read", &sd, &e)),
        };
        for e in rd.flatten() {
            let path = e.path();
            let fname = e.file_name().to_string_lossy().into_owned();
            if let Some((name, _)) = fname.split_once("-old-") {
                let home = self.root.join(name);
                if valid_name(name)
                    && std::fs::symlink_metadata(&home).is_err()
                    && path.join(RECORD).is_file()
                {
                    rename_retrying(&path, &home)
                        .map_err(|e| io_err("cannot restore", &home, &e))?;
                    continue;
                }
            }
            remove_dir_all_retrying(&path).map_err(|e| io_err("cannot remove", &path, &e))?;
        }
        self.prune_empty();
        Ok(())
    }

    /// Removes `.staging/` and `packages/` when empty, so a refusal leaves `extensions/` as it was.
    pub(super) fn prune_empty(&self) {
        let _ = remove_empty_dir_retrying(&self.staging());
        let _ = remove_empty_dir_retrying(&self.root);
    }
}

/// Strict SemVer is a single portable path component, including prerelease/build suffixes.
pub(crate) fn valid_version(version: &str) -> bool {
    version.len() <= 64 && semver::Version::parse(version).is_ok()
}

fn read_record(p: &Path) -> Result<Option<Value>, ExtError> {
    match std::fs::read(p) {
        Ok(b) => serde_json::from_slice(&b).map(Some).map_err(|_| {
            ExtError::new(
                "E_STORAGE",
                "state-invalid",
                "package record is not valid JSON",
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_err("cannot read", p, &e)),
    }
}

/// Migrates only records written by the superseded M v1 implementation. A crash between the rename and atomic
/// state write is completed on the next recovery; code is checked against recorded hashes before activation.
pub(crate) fn migrate_legacy_mcp(layout: &Layout) -> Vec<String> {
    let paths = super::paths::ExtPaths::of(layout);
    let Ok(mut st) = super::state::read_metadata(&paths) else {
        return vec![];
    };
    let names: Vec<String> = st
        .items
        .values()
        .filter(|r| r.kind == "mcp-server" && r.active_version.is_none())
        .map(|r| r.name.clone())
        .collect();
    let mut done = Vec::new();
    for name in names {
        let Some(old) = st.items.get(&name).cloned() else {
            continue;
        };
        if !valid_name(&name) || !valid_version(&old.version) || old.manifest_sha256.is_none() {
            continue;
        }
        let from = layout.extensions().join("packages").join(&name);
        let to = paths.mcp.join(&name).join(&old.version);
        let plain_dir = |p: &Path| {
            std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
        };
        let moved = if plain_dir(&from) && !to.exists() {
            let Some(parent) = to.parent() else {
                continue;
            };
            if std::fs::create_dir_all(parent).is_err() || rename_retrying(&from, &to).is_err() {
                continue;
            }
            true
        } else if !from.exists() && plain_dir(&to) {
            false // a killed migration already moved the complete tree
        } else {
            continue;
        };
        if !super::overlays::rehash(layout, &old).ok {
            if moved {
                let _ = rename_retrying(&to, &from);
            }
            continue;
        }
        let mut next = old.clone();
        next.active_version = Some(next.version.clone());
        let metadata = super::state::McpVersionRecord::from(&next);
        next.versions.insert(next.version.clone(), metadata);
        st.items.insert(name.clone(), next);
        if super::state::write(&paths, &st).is_err() {
            st.items.insert(name.clone(), old);
            if moved {
                let _ = rename_retrying(&to, &from);
            }
            continue;
        }
        let _ = remove_empty_dir_retrying(&layout.extensions().join("packages"));
        done.push(format!("migrated MCP server {name} to its versioned store"));
    }
    done
}
