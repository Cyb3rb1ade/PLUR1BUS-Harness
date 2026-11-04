//! Creation-only separation of the Engine store from the API account database (owner decision 2026-10-21, SH8).
//! Compare portable targets and resolved live ancestry; archive readers retain their existing compatibility rules.
use super::BackupError;
use crate::paths::Layout;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const API_ACCOUNTS_TARGET: &str = "state/api/accounts.db";

fn within(path: &Path, ancestor: &Path) -> bool {
    let mut components = path.components();
    ancestor.components().all(|parent| {
        components.next().is_some_and(|child| {
            child
                .as_os_str()
                .as_encoded_bytes()
                .eq_ignore_ascii_case(parent.as_os_str().as_encoded_bytes())
        })
    })
}

fn overlaps(left: &Path, right: &Path) -> bool {
    within(left, right) || within(right, left)
}

/// Resolve the deepest existing ancestor and append genuinely missing leaves. Existing unresolved aliases refuse.
fn resolve_missing(path: &Path) -> io::Result<PathBuf> {
    let mut existing = path.to_path_buf();
    let mut suffix = Vec::new();
    loop {
        match fs::canonicalize(&existing) {
            Ok(mut resolved) => {
                for name in suffix.iter().rev() {
                    resolved.push(name);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                match fs::symlink_metadata(&existing) {
                    // In particular, a dangling symlink is not an absent ordinary leaf.
                    Ok(_) => return Err(error),
                    Err(missing) if missing.kind() == io::ErrorKind::NotFound => {}
                    Err(other) => return Err(other),
                }
                let Some(name) = existing.file_name() else {
                    return Err(error);
                };
                suffix.push(name.to_os_string());
                if !existing.pop() {
                    return Err(error);
                }
            }
            Err(error) => return Err(error),
        }
    }
}

/// Refuse a prevalidated portable store target that could carry or replace API accounts, even with explicit inclusion.
pub(super) fn check_store_target(layout: &Layout, store_target: &str) -> Result<(), BackupError> {
    let refused = || {
        BackupError::new(
            "manifest-invalid",
            format!(
                "store target {store_target:?} overlaps the API account database; choose a separate Engine store location"
            ),
        )
    };
    let account = Path::new(API_ACCOUNTS_TARGET);
    if overlaps(Path::new(store_target), account) {
        return Err(refused());
    }
    let store = resolve_missing(&layout.home.join(store_target))?;
    let account = resolve_missing(&layout.home.join(account))?;
    if overlaps(&store, &account) {
        return Err(refused());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn component_comparison_covers_case_aliases_without_matching_sibling_names() {
        let account = Path::new(API_ACCOUNTS_TARGET);
        for path in [
            "state/api",
            "STATE/API",
            "state/api/accounts.db",
            "STATE/API/ACCOUNTS.DB/child",
        ] {
            assert!(overlaps(Path::new(path), account), "{path}");
        }
        for path in [
            "state/api/store",
            "state/api-archive",
            "state/api/accounts.db2",
            "state/api-archive/accounts.db",
        ] {
            assert!(!overlaps(Path::new(path), account), "{path}");
        }
    }

    #[test]
    fn missing_ordinary_leaves_keep_the_resolved_ancestry_and_allowed_siblings() {
        let d = tempfile::tempdir().unwrap();
        let layout = Layout::new(d.path().to_path_buf());
        fs::create_dir_all(layout.state()).unwrap();
        for path in [
            "state/lancedb",
            "state/api/store",
            "state/api-archive",
            "state/api/accounts.db2",
        ] {
            check_store_target(&layout, path).unwrap();
        }
        assert_eq!(
            resolve_missing(&layout.state().join("api/missing/leaf")).unwrap(),
            fs::canonicalize(layout.state())
                .unwrap()
                .join("api/missing/leaf")
        );
    }

    #[cfg(unix)]
    #[test]
    fn missing_leaves_under_a_symlink_parent_resolve_before_comparison() {
        let d = tempfile::tempdir().unwrap();
        let real = d.path().join("real");
        fs::create_dir_all(&real).unwrap();
        let alias = d.path().join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        assert_eq!(
            resolve_missing(&alias.join("missing/leaf")).unwrap(),
            fs::canonicalize(real).unwrap().join("missing/leaf")
        );
    }

    #[cfg(unix)]
    #[test]
    fn dangling_and_looping_aliases_are_not_treated_as_missing_ordinary_leaves() {
        let d = tempfile::tempdir().unwrap();
        let dangling = d.path().join("dangling");
        std::os::unix::fs::symlink(d.path().join("missing"), &dangling).unwrap();
        assert!(resolve_missing(&dangling).is_err());
        assert!(resolve_missing(&dangling.join("child")).is_err());
        let cycle = d.path().join("cycle");
        std::os::unix::fs::symlink(&cycle, &cycle).unwrap();
        assert!(resolve_missing(&cycle).is_err());
    }
}
