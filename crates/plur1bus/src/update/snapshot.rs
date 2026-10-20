//! The update snapshot (D78, plan R3): the binary, `config.json` and `manifest.json` are *copied* and hashed into
//! `snapshot.json`; the previous `runtime/core` tree is *moved* in at swap time (same filesystem, so cheap) and moved
//! back on restore. The memory store (`state/`) is never part of it.
use super::state;
use crate::install::archive::sha256_file;
use crate::paths::Layout;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const BINARY: &str = "plur1bus";
const META: &str = "snapshot.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub binary_sha256: String,
    /// `None`: there was no `config.json` (restoring removes one a new version created).
    pub config_sha256: Option<String>,
    pub manifest_sha256: Option<String>,
    /// The previous core tree was moved into `core/` (set by [`core_in`]).
    pub core_moved: bool,
}

fn io_err(p: &Path, e: io::Error) -> String {
    format!("{}: {e}", p.display())
}

fn copy_into(from: &Path, dir: &Path, name: &str) -> Result<String, String> {
    let to = dir.join(name);
    fs::copy(from, &to).map_err(|e| io_err(from, e))?;
    sync_file(&to).map_err(|e| io_err(&to, e))?;
    sha256_file(&to).map_err(|e| io_err(&to, e))
}

/// fsyncs `p`. Opened for writing: on Windows `FlushFileBuffers` needs write access, a read-only handle is refused.
fn sync_file(p: &Path) -> io::Result<()> {
    fs::OpenOptions::new().write(true).open(p)?.sync_all()
}

fn write_meta(dir: &Path, m: &Meta) -> Result<(), String> {
    let p = dir.join(META);
    let tmp = dir.join(format!("{META}.tmp"));
    let mut text = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
    text.push('\n');
    fs::write(&tmp, text)
        .and_then(|_| fs::rename(&tmp, &p))
        .map_err(|e| io_err(&p, e))
}

/// Replaces any previous snapshot with a fresh one of `target_bin`, `config.json` and `manifest.json`.
pub fn create(layout: &Layout, target_bin: &Path) -> Result<Meta, String> {
    let dir = state::snapshot_dir(layout);
    state::remove_dir(&dir);
    fs::create_dir_all(&dir).map_err(|e| io_err(&dir, e))?;
    let binary_sha256 = copy_into(target_bin, &dir, BINARY)?;
    let opt = |p: PathBuf, name: &str| -> Result<Option<String>, String> {
        match p.is_file() {
            true => copy_into(&p, &dir, name).map(Some),
            false => Ok(None),
        }
    };
    let meta = Meta {
        binary_sha256,
        config_sha256: opt(layout.config_path(), "config.json")?,
        manifest_sha256: opt(layout.install_manifest(), "manifest.json")?,
        core_moved: false,
    };
    write_meta(&dir, &meta)?;
    Ok(meta)
}

fn read_meta(dir: &Path) -> Result<Meta, String> {
    let raw = fs::read(dir.join(META)).map_err(|e| format!("snapshot has no {META}: {e}"))?;
    serde_json::from_slice(&raw).map_err(|e| format!("snapshot.json: {e}"))
}

/// Reads `snapshot.json` and checks every file against its hash. `Err` means the snapshot must not be restored.
pub fn verify(layout: &Layout) -> Result<Meta, String> {
    let dir = state::snapshot_dir(layout);
    let meta = read_meta(&dir)?;
    let check = |name: &str, want: &str| -> Result<(), String> {
        let got = sha256_file(&dir.join(name)).map_err(|e| format!("snapshot {name}: {e}"))?;
        if got == want {
            Ok(())
        } else {
            Err(format!("snapshot {name} does not match its checksum"))
        }
    };
    check(BINARY, &meta.binary_sha256)?;
    if let Some(h) = &meta.config_sha256 {
        check("config.json", h)?;
    }
    if let Some(h) = &meta.manifest_sha256 {
        check("manifest.json", h)?;
    }
    Ok(meta)
}

/// Moves `runtime/core` into the snapshot (the swap's first half) and records it. The record comes first: a core
/// that moved while `snapshot.json` still said otherwise (a write that failed, a process that died in between) would
/// be left out of a rollback, which then reported success with no core in place. If the move itself fails, the record
/// is taken back.
pub fn core_in(layout: &Layout) -> Result<(), String> {
    let dir = state::snapshot_dir(layout);
    let core = layout.runtime().join("core");
    let held = dir.join("core");
    let mut meta = read_meta(&dir)?;
    state::remove_dir(&held);
    if !core.exists() {
        meta.core_moved = false;
        return write_meta(&dir, &meta);
    }
    meta.core_moved = true;
    write_meta(&dir, &meta)?;
    if let Err(e) = fs::rename(&core, &held) {
        meta.core_moved = false;
        let _ = write_meta(&dir, &meta);
        return Err(io_err(&core, e));
    }
    Ok(())
}

/// Replaces `dest` with the file `new` (same directory). A running executable cannot be overwritten on Windows but
/// can be renamed away, so there the old file is renamed aside first.
pub fn replace_file(new: &Path, dest: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        let aside = dest.with_extension(format!("old-{}", std::process::id()));
        let _ = fs::remove_file(&aside);
        if dest.exists() {
            fs::rename(dest, &aside)?;
        }
        let r = fs::rename(new, dest);
        if r.is_err() && aside.exists() {
            let _ = fs::rename(&aside, dest);
        }
        let _ = fs::remove_file(&aside);
        r
    }
    #[cfg(not(windows))]
    {
        fs::rename(new, dest)
    }
}

/// Puts a copy of `src` at `dest` through a sibling temp file (so `dest` is never half-written).
pub fn put_file(src: &Path, dest: &Path) -> io::Result<()> {
    let mut name = dest.as_os_str().to_owned();
    name.push(format!(".restore-{}", std::process::id()));
    let tmp = PathBuf::from(name);
    let r = fs::copy(src, &tmp)
        .and_then(|_| sync_file(&tmp))
        .and_then(|_| replace_file(&tmp, dest));
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    r
}

/// Restores binary, config, manifest and (when it was moved) the core tree from a **verified** snapshot. Idempotent.
pub fn restore(layout: &Layout, target_bin: &Path, meta: &Meta) -> Result<(), String> {
    let dir = state::snapshot_dir(layout);
    put_file(&dir.join(BINARY), target_bin).map_err(|e| io_err(target_bin, e))?;
    let one = |name: &str, want: &Option<String>, dest: PathBuf| -> Result<(), String> {
        match want {
            Some(_) => put_file(&dir.join(name), &dest).map_err(|e| io_err(&dest, e)),
            None => match fs::remove_file(&dest) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => Err(io_err(&dest, e)),
                _ => Ok(()),
            },
        }
    };
    one("config.json", &meta.config_sha256, layout.config_path())?;
    one(
        "manifest.json",
        &meta.manifest_sha256,
        layout.install_manifest(),
    )?;
    let held = dir.join("core");
    let core = layout.runtime().join("core");
    // `held` exists only because `core_in` moved the tree there, whatever `snapshot.json` managed to record.
    if held.exists() {
        state::remove_dir(&core);
        fs::rename(&held, &core).map_err(|e| io_err(&core, e))?;
    } else if meta.core_moved && !core.exists() {
        // Recorded as moved, but neither the held tree nor a restored one is there: report it, never "rolled back".
        return Err(format!(
            "the previous core tree is missing: neither {} nor {} exists",
            held.display(),
            core.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> (tempfile::TempDir, Layout, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let layout = Layout::new(d.path().join("h"));
        fs::create_dir_all(layout.runtime().join("core")).unwrap();
        fs::write(layout.runtime().join("core/core.js"), "old core").unwrap();
        fs::write(layout.config_path(), "{\"a\":1}").unwrap();
        fs::write(layout.install_manifest(), "manifest-v1").unwrap();
        let bin = d.path().join("plur1bus");
        fs::write(&bin, b"old binary").unwrap();
        (d, layout, bin)
    }

    #[test]
    fn restore_brings_every_file_back_byte_identically() {
        let (_d, layout, bin) = home();
        let meta = create(&layout, &bin).unwrap();
        core_in(&layout).unwrap();
        // the "update" touches everything
        fs::write(&bin, b"new binary").unwrap();
        fs::write(layout.config_path(), "{\"a\":2}").unwrap();
        fs::write(layout.install_manifest(), "manifest-v2").unwrap();
        fs::create_dir_all(layout.runtime().join("core")).unwrap();
        fs::write(layout.runtime().join("core/core.js"), "new core").unwrap();
        let meta = Meta {
            core_moved: true,
            ..meta
        };
        let verified = verify(&layout).unwrap();
        assert_eq!(verified, meta);
        restore(&layout, &bin, &verified).unwrap();
        assert_eq!(fs::read(&bin).unwrap(), b"old binary");
        assert_eq!(fs::read(layout.config_path()).unwrap(), b"{\"a\":1}");
        assert_eq!(fs::read(layout.install_manifest()).unwrap(), b"manifest-v1");
        assert_eq!(
            fs::read(layout.runtime().join("core/core.js")).unwrap(),
            b"old core"
        );
        // idempotent
        restore(&layout, &bin, &verified).unwrap();
    }

    #[test]
    fn a_config_that_did_not_exist_is_removed_on_restore() {
        let (_d, layout, bin) = home();
        fs::remove_file(layout.config_path()).unwrap();
        let meta = create(&layout, &bin).unwrap();
        assert_eq!(meta.config_sha256, None);
        fs::write(layout.config_path(), "created by the new version").unwrap();
        restore(&layout, &bin, &verify(&layout).unwrap()).unwrap();
        assert!(!layout.config_path().exists());
    }

    #[test]
    fn a_record_that_cannot_be_written_leaves_the_core_where_it_is() {
        let (_d, layout, bin) = home();
        create(&layout, &bin).unwrap();
        // A directory where the temporary record goes: `snapshot.json` cannot be written.
        fs::create_dir(state::snapshot_dir(&layout).join(format!("{META}.tmp"))).unwrap();
        assert!(core_in(&layout).is_err());
        assert_eq!(
            fs::read(layout.runtime().join("core/core.js")).unwrap(),
            b"old core",
            "the tree must not move when the move cannot be recorded"
        );
        assert!(!state::snapshot_dir(&layout).join("core").exists());
    }

    #[test]
    fn a_core_that_moved_before_the_record_said_so_is_still_restored() {
        let (_d, layout, bin) = home();
        let meta = create(&layout, &bin).unwrap();
        assert!(!meta.core_moved);
        // The old order's crash window: the tree moved, `snapshot.json` still says it did not.
        fs::rename(
            layout.runtime().join("core"),
            state::snapshot_dir(&layout).join("core"),
        )
        .unwrap();
        restore(&layout, &bin, &verify(&layout).unwrap()).unwrap();
        assert_eq!(
            fs::read(layout.runtime().join("core/core.js")).unwrap(),
            b"old core"
        );
    }

    #[test]
    fn a_rollback_without_the_recorded_core_is_an_error_not_a_success() {
        let (_d, layout, bin) = home();
        create(&layout, &bin).unwrap();
        core_in(&layout).unwrap();
        fs::remove_dir_all(state::snapshot_dir(&layout).join("core")).unwrap();
        let err = restore(&layout, &bin, &verify(&layout).unwrap()).unwrap_err();
        assert!(err.contains("core tree is missing"), "{err}");
        // With nothing recorded as moved there is nothing to miss.
        let (_d, layout, bin) = home();
        fs::remove_dir_all(layout.runtime().join("core")).unwrap();
        create(&layout, &bin).unwrap();
        core_in(&layout).unwrap();
        restore(&layout, &bin, &verify(&layout).unwrap()).unwrap();
    }

    #[test]
    fn a_tampered_snapshot_is_refused() {
        let (_d, layout, bin) = home();
        create(&layout, &bin).unwrap();
        fs::write(state::snapshot_dir(&layout).join("plur1bus"), b"evil").unwrap();
        assert!(verify(&layout).unwrap_err().contains("checksum"));
        let d2 = state::snapshot_dir(&layout);
        fs::remove_file(d2.join(META)).unwrap();
        assert!(verify(&layout).is_err());
    }
}
