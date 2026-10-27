//! Descriptor-bound namespace directories and the verified-path platform fallback.
#![cfg_attr(test, allow(clippy::unwrap_used))]

use std::fs;
use std::path::{Path, PathBuf};

use plur1bus_engine::store::directory::TrustedDirectory;

fn scratch() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("re02-directory-")
        .tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap())
        .unwrap()
}
fn directory(parent: &Path, name: &str, marker: &str) -> PathBuf {
    let path = parent.join(name);
    fs::create_dir(&path).unwrap();
    fs::write(path.join("marker"), marker).unwrap();
    path
}

#[test]
fn directory_capability_reads_its_held_directory_and_child() {
    let root = scratch();
    let path = directory(root.path(), "store", "parent");
    let child_path = directory(&path, "child", "child");
    let guard = TrustedDirectory::open(&path).unwrap();
    assert_eq!(guard.path(), path);
    guard.assert_unchanged().unwrap();
    assert_eq!(
        fs::read_to_string(guard.lance_path().join("marker")).unwrap(),
        "parent"
    );
    let child = guard.open_child("child").unwrap();
    assert_eq!(child.path(), child_path);
    assert_eq!(
        fs::read_to_string(child.lance_path().join("marker")).unwrap(),
        "child"
    );
    child.assert_unchanged().unwrap();
}

#[test]
fn directory_replacement_is_refused_and_never_redirects_the_held_route() {
    let root = scratch();
    let path = directory(root.path(), "store", "original");
    let guard = TrustedDirectory::open(&path).unwrap();
    fs::rename(&path, root.path().join("moved")).unwrap();
    directory(root.path(), "store", "replacement");
    assert!(guard.assert_unchanged().is_err());
    if guard.lance_path() != guard.path() {
        assert_eq!(
            fs::read_to_string(guard.lance_path().join("marker")).unwrap(),
            "original"
        );
    } else {
        // A verified-path platform fails closed before its pathname can be used again.
        assert!(guard.open_child("child").is_err());
    }
}

#[test]
fn ancestor_replacement_cannot_redirect_an_open_child() {
    let root = scratch();
    let path = directory(root.path(), "parent", "parent");
    directory(&path, "child", "original-child");
    let guard = TrustedDirectory::open(&path).unwrap();
    let child = guard.open_child("child").unwrap();
    fs::rename(&path, root.path().join("moved")).unwrap();
    let replacement = directory(root.path(), "parent", "replacement-parent");
    directory(&replacement, "child", "replacement-child");
    assert!(guard.open_child("child").is_err());
    assert!(child.assert_unchanged().is_err());
    if child.lance_path() != child.path() {
        assert_eq!(
            fs::read_to_string(child.lance_path().join("marker")).unwrap(),
            "original-child"
        );
    }
}

#[test]
fn child_names_cannot_escape_the_held_directory() {
    let root = scratch();
    let guard = TrustedDirectory::open(root.path()).unwrap();
    for name in ["", ".", "..", "../sibling", "a/b", "a\\b", "nul\0tail"] {
        assert!(guard.open_child(name).is_err(), "accepted {name:?}");
    }
    #[cfg(windows)]
    for name in [".. ", "child.", "child ", "C:relative", "child:stream"] {
        assert!(guard.open_child(name).is_err(), "accepted {name:?}");
    }
    #[cfg(windows)]
    assert!(TrustedDirectory::open(Path::new("C:relative")).is_err());
}

#[test]
fn regular_files_are_not_directory_capabilities() {
    let root = scratch();
    let path = root.path().join("file");
    fs::write(&path, b"plain").unwrap();
    assert!(TrustedDirectory::open(&path).is_err());
    let guard = TrustedDirectory::open(root.path()).unwrap();
    assert!(guard.open_child("file").is_err());
}

#[cfg(unix)]
#[test]
fn symlinked_components_and_children_are_refused() {
    use std::os::unix::fs::symlink;
    let root = scratch();
    let real = directory(root.path(), "real", "real");
    directory(&real, "child", "child");
    symlink(&real, root.path().join("alias")).unwrap();
    assert!(TrustedDirectory::open(&root.path().join("alias/child")).is_err());
    let guard = TrustedDirectory::open(root.path()).unwrap();
    assert!(guard.open_child("alias").is_err());
}

#[cfg(unix)]
#[test]
fn a_group_writable_nonsticky_ancestor_is_refused() {
    use std::os::unix::fs::PermissionsExt;
    let root = scratch();
    let shared = directory(root.path(), "shared", "shared");
    let child = directory(&shared, "child", "child");
    fs::set_permissions(&shared, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(TrustedDirectory::open(&child).is_err());
    fs::set_permissions(&shared, fs::Permissions::from_mode(0o1777)).unwrap();
    let guard = TrustedDirectory::open(&child).unwrap();
    guard.assert_unchanged().unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn linux_lance_path_is_an_owned_descriptor_alias_and_closes_on_drop() {
    let root = scratch();
    let path = directory(root.path(), "store", "original");
    let guard = TrustedDirectory::open(&path).unwrap();
    assert_ne!(guard.lance_path(), guard.path());
    assert!(
        guard.lance_path().starts_with("/proc/self/fd")
            || guard.lance_path().starts_with("/dev/fd")
    );
    let alias = guard.lance_path().to_owned();
    assert!(alias.join("marker").is_file());
    drop(guard);
    assert!(fs::metadata(alias).is_err());
}

#[cfg(windows)]
#[test]
fn junction_components_and_children_are_refused() {
    let root = scratch();
    let real = directory(root.path(), "real", "real");
    directory(&real, "child", "child");
    let junction = root.path().join("junction");
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&real)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(TrustedDirectory::open(&junction.join("child")).is_err());
    let guard = TrustedDirectory::open(root.path()).unwrap();
    assert!(guard.open_child("junction").is_err());
    assert_eq!(guard.lance_path(), guard.path());
}
