//! `backup restore --keep N`: bounded retention of the pre-restore copies (RE-D171, opt-in).
//!
//! Every restore leaves what it replaced in `<home>/backups/pre-restore-<utc>-<8 hex>/`. Without `--keep` they stay for
//! good. With it, after a restore that swapped completely, only the `N` newest copies stay; the copy that restore just made
//! counts as one of them and is never removed. Only real directories whose name is exactly what [`super::restore`] gives
//! them are candidates: symlinks, files, archives (`plur1bus-backup-*.tar.gz`) and every other name are never touched.
//! A failure to delete is a warning, never a failure of the restore.
use std::fs;
use std::path::Path;

const PREFIX: &str = "pre-restore-";

/// `pre-restore-<yyyymmddTHHMMSSZ>-<8 lowercase hex>`, the exact shape `restore` creates.
fn is_pre_restore_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(PREFIX) else {
        return false;
    };
    let b = rest.as_bytes();
    // 8 digits, 'T', 6 digits, 'Z', '-', 8 hex digits.
    b.len() == 25
        && b[..8].iter().all(u8::is_ascii_digit)
        && b[8] == b'T'
        && b[9..15].iter().all(u8::is_ascii_digit)
        && b[15] == b'Z'
        && b[16] == b'-'
        && b[17..]
            .iter()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
}

/// Keeps the `keep` newest pre-restore copies below `backups` (the stamp in the name, then the name) and removes the rest.
/// `current` is the directory name of the copy made by the restore that is finishing: it counts as one of the `keep` and is
/// never removed, whatever its stamp. Returns one warning per entry that could not be listed or removed.
pub fn purge_pre_restore(backups: &Path, keep: usize, current: &str) -> Vec<String> {
    let mut warnings = Vec::new();
    // `backups/` itself must be a real directory of this home: through a symlink (or junction) the copies listed could
    // belong to another home or another disk the operator linked in. Checked right before listing; the restore that made
    // the copy is not affected.
    match fs::symlink_metadata(backups) {
        Ok(m) if m.file_type().is_dir() && !m.file_type().is_symlink() => {}
        Ok(m) => {
            let what = if m.file_type().is_symlink() {
                "a symlink"
            } else {
                "not a directory"
            };
            warnings.push(format!(
                "--keep: nothing was deleted: {} is {what}, not a real directory; the pre-restore copies there stay",
                backups.display()
            ));
            return warnings;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            warnings.push(format!(
                "--keep: no pre-restore copies were removed because {} does not exist",
                backups.display()
            ));
            return warnings;
        }
        Err(e) => {
            warnings.push(format!("cannot inspect {}: {e}", backups.display()));
            return warnings;
        }
    }
    let entries = match fs::read_dir(backups) {
        Ok(rd) => rd,
        Err(e) => {
            warnings.push(format!("cannot list {}: {e}", backups.display()));
            return warnings;
        }
    };
    let mut names: Vec<String> = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                warnings.push(format!(
                    "cannot read an entry of {}: {e}",
                    backups.display()
                ));
                continue;
            }
        };
        // `DirEntry::file_type` does not follow a symlink: a link is never a directory here.
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if is_dir && is_pre_restore_name(&name) {
            names.push(name);
        }
    }
    // Newest first; the zero-padded stamp makes the name order the time order.
    names.sort_unstable_by(|a, b| b.cmp(a));
    if let Some(pos) = names.iter().position(|n| n == current) {
        let own = names.remove(pos);
        names.insert(0, own);
    }
    for name in names.into_iter().skip(keep) {
        if name == current {
            continue;
        }
        let path = backups.join(&name);
        if let Err(e) = fs::remove_dir_all(&path) {
            warnings.push(format!("cannot remove {}: {e}", path.display()));
        }
    }
    warnings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(dir: &Path, name: &str) {
        fs::create_dir_all(dir.join(name)).unwrap();
        fs::write(dir.join(name).join("f"), name).unwrap();
    }

    fn left(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn only_the_exact_shape_is_a_candidate() {
        for ok in [
            "pre-restore-20261111T101530Z-0123abcd",
            "pre-restore-20200101T000000Z-aaaaaaaa",
        ] {
            assert!(is_pre_restore_name(ok), "{ok}");
        }
        for bad in [
            "",
            "pre-restore-",
            "pre-restore-manual",
            "pre-restore-20261111T101530Z-0123abc",
            "pre-restore-20261111T101530Z-0123abcde",
            "pre-restore-20261111T101530Z-0123ABCD",
            "pre-restore-20261111T101530Z-0123abcg",
            "pre-restore-20261111T101530-0123abcd",
            "pre-restore-2026111T1015300Z-0123abcd",
            "Pre-restore-20261111T101530Z-0123abcd",
            "xpre-restore-20261111T101530Z-0123abcd",
            "pre-restore-20261111T101530Z-0123abcd.tar.gz",
            "plur1bus-backup-20261111T101530Z.tar.gz",
        ] {
            assert!(!is_pre_restore_name(bad), "{bad}");
        }
    }

    #[test]
    fn keeps_the_newest_n_and_counts_the_current_copy() {
        let d = tempfile::tempdir().unwrap();
        let names = [
            "pre-restore-20200101T000000Z-aaaaaaa1",
            "pre-restore-20200102T000000Z-aaaaaaa2",
            "pre-restore-20200103T000000Z-aaaaaaa3",
            "pre-restore-20200103T000000Z-aaaaaaa4", // same second: the name decides
        ];
        for n in names {
            mk(d.path(), n);
        }
        let w = purge_pre_restore(d.path(), 2, names[3]);
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(left(d.path()), vec![names[2], names[3]]);
        // The current copy survives even when it is the oldest by name.
        let w = purge_pre_restore(d.path(), 1, names[2]);
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(left(d.path()), vec![names[2]]);
        // A current copy that does not exist counts for nothing: the N newest of what is there stay.
        mk(d.path(), names[0]);
        mk(d.path(), names[1]);
        purge_pre_restore(d.path(), 2, "pre-restore-20990101T000000Z-ffffffff");
        assert_eq!(left(d.path()), vec![names[1], names[2]]);
    }

    #[test]
    fn a_missing_backups_directory_is_a_warning() {
        let d = tempfile::tempdir().unwrap();
        let w = purge_pre_restore(&d.path().join("nope"), 1, "x");
        assert_eq!(w.len(), 1);
        assert!(
            w[0].contains("--keep") && w[0].contains("does not exist"),
            "{w:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_that_cannot_be_removed_is_a_warning_and_the_others_still_go() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let (stuck, other, current) = (
            "pre-restore-20200101T000000Z-aaaaaaa1",
            "pre-restore-20200102T000000Z-aaaaaaa2",
            "pre-restore-20200103T000000Z-aaaaaaa3",
        );
        for n in [stuck, other, current] {
            mk(d.path(), n);
        }
        let locked = d.path().join(stuck);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).unwrap();
        // Root (or a lenient filesystem) can still write there: nothing to observe then.
        let blocked = fs::write(locked.join("probe"), b"x").is_err();
        let w = purge_pre_restore(d.path(), 1, current);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(!d.path().join(other).exists(), "the others still go");
        assert!(d.path().join(current).exists());
        if blocked {
            assert_eq!(w.len(), 1, "{w:?}");
            assert!(w[0].contains(stuck), "{w:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_backups_directory_that_is_a_symlink_or_a_file_is_never_purged() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("elsewhere");
        let names = [
            "pre-restore-20200101T000000Z-aaaaaaa1",
            "pre-restore-20200102T000000Z-aaaaaaa2",
            "pre-restore-20200103T000000Z-aaaaaaa3",
        ];
        for n in names {
            mk(&target, n);
        }
        let link = d.path().join("backups");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let w = purge_pre_restore(&link, 1, names[2]);
        assert_eq!(w.len(), 1, "{w:?}");
        assert!(w[0].contains("--keep") && w[0].contains("symlink"), "{w:?}");
        assert_eq!(left(&target), names.to_vec());
        // A dangling link and a plain file are refused the same way.
        let gone = d.path().join("gone");
        std::os::unix::fs::symlink(d.path().join("nowhere"), &gone).unwrap();
        assert_eq!(purge_pre_restore(&gone, 1, "x").len(), 1);
        let file = d.path().join("file");
        fs::write(&file, "f").unwrap();
        assert_eq!(purge_pre_restore(&file, 1, "x").len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_files_and_other_names_are_never_candidates() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep"), "x").unwrap();
        let link = "pre-restore-20200101T000000Z-aaaaaaa1";
        std::os::unix::fs::symlink(outside.path(), d.path().join(link)).unwrap();
        let file = "pre-restore-20200102T000000Z-aaaaaaa2";
        fs::write(d.path().join(file), "f").unwrap();
        mk(d.path(), "pre-restore-manual");
        mk(d.path(), "pre-restore-20200103T000000Z-aaaaaaa3");
        mk(d.path(), "pre-restore-20200104T000000Z-aaaaaaa4");
        purge_pre_restore(d.path(), 1, "pre-restore-20200104T000000Z-aaaaaaa4");
        assert_eq!(
            left(d.path()),
            vec![
                link,
                file,
                "pre-restore-20200104T000000Z-aaaaaaa4",
                "pre-restore-manual"
            ]
        );
        assert!(outside.path().join("keep").exists());
    }
}
