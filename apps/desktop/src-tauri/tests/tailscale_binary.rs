//! Where the Tailscale CLI may come from (transport choice spec §5.2 step 1; package T3): fixed absolute candidates,
//! never `PATH`, and only a regular file with safe ownership and mode (POSIX) or no reparse point inside Program Files
//! (Windows). Only temporary files are created; no candidate is ever executed.
use plur1bus_desktop::transport::{candidates, usable, usable_with};
use std::path::{Path, PathBuf};

#[test]
fn candidates_are_absolute_and_ignore_path() {
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join(if cfg!(windows) {
        "tailscale.exe"
    } else {
        "tailscale"
    });
    std::fs::write(&fake, b"#!/bin/sh\nexit 0\n").unwrap();
    let before = candidates();
    let old = std::env::var_os("PATH");
    std::env::set_var("PATH", dir.path());
    let with_path = candidates();
    match old {
        Some(v) => std::env::set_var("PATH", v),
        None => std::env::remove_var("PATH"),
    }
    assert_eq!(before, with_path);
    for c in &with_path {
        assert!(c.is_absolute(), "{c:?}");
        assert!(!c.starts_with(dir.path()), "{c:?}");
    }
    #[cfg(target_os = "macos")]
    assert_eq!(
        with_path,
        [
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
        ]
        .map(PathBuf::from)
    );
    #[cfg(target_os = "linux")]
    assert_eq!(
        with_path,
        [
            "/usr/bin/tailscale",
            "/usr/sbin/tailscale",
            "/usr/local/bin/tailscale",
            "/snap/bin/tailscale",
        ]
        .map(PathBuf::from)
    );
    #[cfg(windows)]
    {
        assert_eq!(with_path.len(), 1);
        let tail: PathBuf = Path::new("Tailscale").join("tailscale.exe");
        assert!(with_path[0].ends_with(&tail));
        assert!(!with_path[0].starts_with(dir.path()));
    }
}

#[test]
fn relative_and_missing_paths_are_unusable() {
    assert!(!usable(Path::new("tailscale")));
    assert!(!usable(Path::new("./tailscale")));
    let dir = tempfile::tempdir().unwrap();
    assert!(!usable(&dir.path().join("missing")));
    assert!(!usable_with(
        &dir.path().join("missing"),
        &[dir.path().to_path_buf()]
    ));
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    /// A canonical temporary directory: on macOS `/var` is itself a symlink to `/private/var`, and a path through any
    /// symlink must end in an allowed prefix.
    fn tempdir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(dir.path()).unwrap();
        (dir, real)
    }

    fn file(path: &Path, mode: u32) {
        std::fs::write(path, b"#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn mode_0755_owned_by_the_test_user_is_usable() {
        let (_d, dir) = tempdir();
        let bin = dir.join("tailscale");
        file(&bin, 0o755);
        assert!(usable(&bin));
        assert!(usable_with(&bin, &[]));
    }

    #[test]
    fn group_or_other_writable_is_unusable() {
        let (_d, dir) = tempdir();
        for mode in [0o777, 0o775, 0o757, 0o722] {
            let bin = dir.join(format!("tailscale-{mode:o}"));
            file(&bin, mode);
            assert!(!usable(&bin), "{mode:o}");
        }
    }

    #[test]
    fn directories_are_unusable() {
        let (_d, dir) = tempdir();
        let sub = dir.join("tailscale");
        std::fs::create_dir(&sub).unwrap();
        std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!usable(&sub));
    }

    #[test]
    fn symlink_into_an_allowed_prefix_is_usable() {
        let (_d, dir) = tempdir();
        let cellar = dir
            .join("Cellar")
            .join("tailscale")
            .join("1.90.0")
            .join("bin");
        std::fs::create_dir_all(&cellar).unwrap();
        let real = cellar.join("tailscale");
        file(&real, 0o755);
        let link = dir.join("tailscale");
        symlink(&real, &link).unwrap();
        let allowed = [dir.join("Cellar").join("tailscale")];
        assert!(usable_with(&link, &allowed));
        // A prefix only matches whole components (`/snap` is not `/snapshot`).
        assert!(!usable_with(&link, &[dir.join("Cellar").join("tail")]));
        // The target's own mode still counts.
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(!usable_with(&link, &allowed));
    }

    #[test]
    fn symlink_outside_the_allowed_prefixes_is_unusable() {
        let (_d, dir) = tempdir();
        let evil = dir.join("evil");
        file(&evil, 0o755);
        let link = dir.join("tailscale");
        symlink(&evil, &link).unwrap();
        assert!(!usable(&link));
        assert!(!usable_with(&link, &[]));
        // The literal `/tmp/evil` of the brief: a link there is refused whether or not the target exists.
        let tmp_link = dir.join("tailscale-tmp");
        symlink("/tmp/evil", &tmp_link).unwrap();
        assert!(!usable(&tmp_link));
    }

    #[test]
    fn a_symlinked_directory_on_the_way_counts_as_a_symlink() {
        let (_d, dir) = tempdir();
        let real_dir = dir.join("real");
        std::fs::create_dir(&real_dir).unwrap();
        file(&real_dir.join("tailscale"), 0o755);
        let link_dir = dir.join("linked");
        symlink(&real_dir, &link_dir).unwrap();
        let through = link_dir.join("tailscale");
        assert!(!usable(&through));
        assert!(usable_with(&through, std::slice::from_ref(&real_dir)));
    }
}

#[cfg(windows)]
mod windows {
    use super::*;

    fn junction(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn a_regular_file_inside_the_allowed_root_is_usable_and_outside_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Program Files");
        std::fs::create_dir_all(root.join("Tailscale")).unwrap();
        let exe = root.join("Tailscale").join("tailscale.exe");
        std::fs::write(&exe, b"MZ").unwrap();
        assert!(usable_with(&exe, std::slice::from_ref(&root)));
        assert!(!usable_with(&exe, &[dir.path().join("Other")]));
        // `..` cannot climb out of the root.
        let escape = root
            .join("..")
            .join("Program Files")
            .join("Tailscale")
            .join("tailscale.exe");
        assert!(!usable_with(&escape, std::slice::from_ref(&root)));
        // The production rule uses the real Program Files folder, which a temporary file is not in.
        assert!(!usable(&exe));
    }

    #[test]
    fn a_junction_on_the_way_is_unusable() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Program Files");
        let real = dir.path().join("elsewhere");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(real.join("tailscale.exe"), b"MZ").unwrap();
        let link = root.join("Tailscale");
        junction(&link, &real);
        let exe = link.join("tailscale.exe");
        assert!(exe.is_file());
        assert!(!usable_with(&exe, std::slice::from_ref(&root)));
    }

    #[test]
    fn directories_are_unusable() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Program Files");
        let sub = root.join("Tailscale").join("tailscale.exe");
        std::fs::create_dir_all(&sub).unwrap();
        assert!(!usable_with(&sub, &[root]));
    }
}
