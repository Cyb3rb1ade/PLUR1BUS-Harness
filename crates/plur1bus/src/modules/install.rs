//! `module install` and `module uninstall` (B14), shared by the supervisor (`module.install`, `module.uninstall`) and
//! the offline CLI. An install is refused before anything is copied when the source is not a directory, holds a
//! symlink anywhere (the source itself included), names a reserved module (`core`, `supervisor`), has an `entry` that
//! would leave the directory, or has an invalid manifest (or no entry file). Otherwise the tree is copied into
//! `modules/<name>.tmp-<pid>` (which [`super::scan`] skips) and renamed to `modules/<name>`, so a reader never sees a
//! half-copied module. [`stage`] and [`commit`] are the two halves, so the supervisor can stop a running module in
//! between.
use super::manifest::{parse_manifest, Manifest, RESERVED_NAMES};
use crate::paths::Layout;
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallError {
    /// The source path does not exist or is not a directory.
    NotADirectory,
    /// `module.json` is missing, invalid, or its `entry` file is not there.
    Manifest(Vec<String>),
    /// A symlink in the source tree (the source itself included).
    Symlink(PathBuf),
    /// `entry` is absolute or climbs out of the module directory.
    EntryOutside,
    /// The manifest names a reserved module (`core`, `supervisor`).
    Reserved,
    /// Copying, renaming or removing failed; nothing was left half-done under `modules/<name>`.
    Io(String),
}

impl InstallError {
    /// The `E_INVALID_PARAMS` reason (`E_INTERNAL` for [`InstallError::Io`]).
    pub fn reason(&self) -> &'static str {
        match self {
            InstallError::NotADirectory => "not-a-directory",
            InstallError::Manifest(_) => "manifest-invalid",
            InstallError::Symlink(_) => "symlink",
            InstallError::EntryOutside => "entry-outside",
            InstallError::Reserved => "reserved-name",
            InstallError::Io(_) => "io",
        }
    }

    pub fn is_io(&self) -> bool {
        matches!(self, InstallError::Io(_))
    }
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::NotADirectory => f.write_str("not a module directory"),
            InstallError::Manifest(errors) => write!(f, "invalid module: {}", errors.join("; ")),
            InstallError::Symlink(p) => write!(f, "symlinks are not installed: {}", p.display()),
            InstallError::EntryOutside => {
                f.write_str("the manifest's entry leaves the module directory")
            }
            InstallError::Reserved => {
                write!(f, "the names {} are reserved", RESERVED_NAMES.join(", "))
            }
            InstallError::Io(e) => f.write_str(e),
        }
    }
}

fn io_err(what: &str, path: &Path, e: io::Error) -> InstallError {
    InstallError::Io(format!("{what} {}: {e}", path.display()))
}

/// A module copied into its staging directory, not yet in place. Dropping it without [`commit`] removes the copy.
#[derive(Debug)]
pub struct Staged {
    pub manifest: Manifest,
    /// `modules/<name>.tmp-<pid>`.
    tmp: PathBuf,
    /// `modules/<name>`.
    dst: PathBuf,
}

impl Drop for Staged {
    fn drop(&mut self) {
        // After a commit the directory has been renamed away: this finds nothing.
        let _ = fs::remove_dir_all(&self.tmp);
    }
}

/// `entry` as written: absolute, a drive letter, a backslash, or a `..` segment would leave the directory. The schema
/// refuses these too; this names the reason.
fn entry_escapes(entry: &str) -> bool {
    let b = entry.as_bytes();
    entry.starts_with('/')
        || entry.contains('\\')
        || (b.len() >= 2 && b[1] == b':')
        || entry.split('/').any(|s| s == "..")
}

/// Every path under `dir` (depth first), refusing a symlink; `dir` itself is checked by the caller.
fn walk(dir: &Path, out: &mut Vec<(PathBuf, bool)>) -> Result<(), InstallError> {
    let entries = fs::read_dir(dir).map_err(|e| io_err("cannot read", dir, e))?;
    for e in entries {
        let e = e.map_err(|e| io_err("cannot read", dir, e))?;
        let path = e.path();
        let t = fs::symlink_metadata(&path)
            .map_err(|e| io_err("cannot stat", &path, e))?
            .file_type();
        if t.is_symlink() {
            return Err(InstallError::Symlink(path));
        }
        if t.is_dir() {
            out.push((path.clone(), true));
            walk(&path, out)?;
        } else if t.is_file() {
            out.push((path, false));
        } else {
            return Err(InstallError::Io(format!(
                "not a regular file or directory: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

/// Checks `src` (nothing is copied when it is refused), then copies it into `modules/<name>.tmp-<pid>`.
pub fn stage(layout: &Layout, src: &Path) -> Result<Staged, InstallError> {
    let meta = fs::symlink_metadata(src).map_err(|_| InstallError::NotADirectory)?;
    if meta.file_type().is_symlink() {
        return Err(InstallError::Symlink(src.to_path_buf()));
    }
    if !meta.is_dir() {
        return Err(InstallError::NotADirectory);
    }
    let mut tree = Vec::new();
    walk(src, &mut tree)?;
    let raw = match fs::read_to_string(src.join("module.json")) {
        Ok(raw) => raw,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Err(InstallError::Manifest(vec![
                "manifest-missing: no module.json".into(),
            ]))
        }
        Err(e) => {
            return Err(InstallError::Manifest(vec![format!(
                "manifest-unreadable: {e}"
            )]))
        }
    };
    // The two refusals with a reason of their own come before the schema, which refuses both as well.
    if let Ok(v) = serde_json::from_str::<Value>(&raw) {
        if v["name"]
            .as_str()
            .is_some_and(|n| RESERVED_NAMES.contains(&n))
        {
            return Err(InstallError::Reserved);
        }
        if v["entry"].as_str().is_some_and(entry_escapes) {
            return Err(InstallError::EntryOutside);
        }
    }
    let manifest = parse_manifest(&raw).map_err(InstallError::Manifest)?;
    if !src.join(&manifest.entry).is_file() {
        return Err(InstallError::Manifest(vec![format!(
            "entry {} not found",
            manifest.entry
        )]));
    }
    let modules = layout.home.join("modules");
    fs::create_dir_all(&modules).map_err(|e| io_err("cannot create", &modules, e))?;
    let staged = Staged {
        tmp: modules.join(format!("{}.tmp-{}", manifest.name, std::process::id())),
        dst: modules.join(&manifest.name),
        manifest,
    };
    let _ = fs::remove_dir_all(&staged.tmp); // a crashed earlier install of this process id
    fs::create_dir(&staged.tmp).map_err(|e| io_err("cannot create", &staged.tmp, e))?;
    for (path, is_dir) in tree {
        let rel = path.strip_prefix(src).expect("walked under src");
        let to = staged.tmp.join(rel);
        let done = if is_dir {
            fs::create_dir(&to)
        } else {
            fs::copy(&path, &to).map(drop)
        };
        // `staged` is dropped on the error path, which removes the partial copy.
        done.map_err(|e| io_err("cannot copy", &path, e))?;
    }
    Ok(staged)
}

/// Puts a staged module in place: an installed one of the same name is renamed aside, the staged copy renamed in and
/// the old one removed. Returns whether one was replaced. The caller stops a running module first.
pub fn commit(staged: Staged) -> Result<bool, InstallError> {
    let replaced = staged.dst.is_dir();
    let old = staged.tmp.with_file_name(format!(
        "{}-old",
        staged.tmp.file_name().unwrap_or_default().to_string_lossy()
    ));
    if replaced {
        let _ = fs::remove_dir_all(&old);
        fs::rename(&staged.dst, &old).map_err(|e| io_err("cannot move aside", &staged.dst, e))?;
    }
    if let Err(e) = fs::rename(&staged.tmp, &staged.dst) {
        if replaced {
            let _ = fs::rename(&old, &staged.dst);
        }
        return Err(io_err("cannot rename into place", &staged.tmp, e));
    }
    if replaced {
        let _ = fs::remove_dir_all(&old);
    }
    Ok(replaced)
}

/// [`stage`] then [`commit`] (no running module to stop: the offline CLI).
pub fn install(layout: &Layout, src: &Path) -> Result<(Manifest, bool), InstallError> {
    let staged = stage(layout, src)?;
    let manifest = staged.manifest.clone();
    let replaced = commit(staged)?;
    Ok((manifest, replaced))
}

/// `modules/<name>` when it is an installed module's directory (a real directory, not a symlink, and a name that is
/// one path segment).
pub fn installed_dir(layout: &Layout, name: &str) -> Option<PathBuf> {
    let one_segment = !name.is_empty()
        && !name.starts_with('.')
        && !name.contains(".tmp-")
        && !name.contains(['/', '\\', ':']);
    let dir = layout.home.join("modules").join(name);
    (one_segment && fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir())).then_some(dir)
}

/// Removes `modules/<name>` (renamed aside first, so it disappears at once); `modules.<name>` in config.json stays. The
/// caller stops a running module first and answers `E_MODULE_UNKNOWN` when [`installed_dir`] finds none.
pub fn uninstall(layout: &Layout, name: &str) -> Result<(), InstallError> {
    let Some(dir) = installed_dir(layout, name) else {
        return Err(InstallError::Io(format!("module {name} is not installed")));
    };
    let gone = dir.with_file_name(format!("{name}.tmp-{}-rm", std::process::id()));
    let _ = fs::remove_dir_all(&gone);
    fs::rename(&dir, &gone).map_err(|e| io_err("cannot remove", &dir, e))?;
    fs::remove_dir_all(&gone).map_err(|e| io_err("cannot remove", &gone, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn module_dir(root: &Path, manifest: &str) -> PathBuf {
        let d = root.join("src-module");
        fs::create_dir_all(d.join("lib")).unwrap();
        fs::write(d.join("module.json"), manifest).unwrap();
        fs::write(d.join("index.js"), "// fixture\n").unwrap();
        fs::write(d.join("lib/util.js"), "// util\n").unwrap();
        d
    }
    fn manifest(name: &str, entry: &str) -> String {
        format!(
            r#"{{"name":"{name}","version":"0.1.0","apiVersion":"1","entry":"{entry}","scope":"installation","priority":500}}"#
        )
    }

    #[test]
    fn install_copies_the_tree_and_a_reinstall_replaces_it() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(tmp.path().join("h"));
        let src = module_dir(tmp.path(), &manifest("mod-a", "index.js"));
        let (m, replaced) = install(&layout, &src).unwrap();
        assert_eq!((m.name.as_str(), replaced), ("mod-a", false));
        let dst = layout.home.join("modules/mod-a");
        assert!(dst.join("lib/util.js").is_file() && dst.join("module.json").is_file());
        fs::write(src.join("extra.js"), "").unwrap();
        let (_, replaced) = install(&layout, &src).unwrap();
        assert!(replaced);
        assert!(dst.join("extra.js").is_file());
        let left: Vec<String> = fs::read_dir(layout.home.join("modules"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, ["mod-a"], "no staging or old directory left");
        uninstall(&layout, "mod-a").unwrap();
        assert!(!dst.exists());
        assert!(installed_dir(&layout, "mod-a").is_none());
        assert!(installed_dir(&layout, "../h").is_none());
    }

    #[test]
    fn refusals_name_their_reason_and_copy_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(tmp.path().join("h"));
        let cases = [
            (manifest("core", "index.js"), "reserved-name"),
            (manifest("mod-a", "../x.js"), "entry-outside"),
            (manifest("mod-a", "/abs.js"), "entry-outside"),
            (manifest("mod-a", "missing.js"), "manifest-invalid"),
            (r#"{"name":"mod-a"}"#.to_string(), "manifest-invalid"),
        ];
        for (m, reason) in cases {
            let src = module_dir(tmp.path(), &m);
            let err = install(&layout, &src).unwrap_err();
            assert_eq!(err.reason(), reason, "{m}: {err}");
            fs::remove_dir_all(&src).unwrap();
        }
        assert_eq!(
            install(&layout, &tmp.path().join("nope")).unwrap_err(),
            InstallError::NotADirectory
        );
        let modules = layout.home.join("modules");
        assert!(!modules.exists() || fs::read_dir(&modules).unwrap().next().is_none());
    }
}
