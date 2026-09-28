//! Setup's `skills` step (HB13, ⟂EXT 5): `<payload>/skills/<name>/` is copied to `<home>/skills/<name>/`. Bundled
//! third-party skills live under `skills/third-party/` and are pinned by `skills/third-party/CHECKSUMS` (D57,
//! `sha256sum` format, paths relative to `third-party/`); a mismatch, a missing file or an unpinned file fails the step
//! with `digest-mismatch` before anything is copied.
use super::archive::sha256_file;
use super::manifest::PackageUnit;
use super::setup::{copy_tree, StepError};
use crate::paths::Layout;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// The directory of bundled third-party skills inside `<payload>/skills/`.
pub const THIRD_PARTY: &str = "third-party";
/// Its pin file.
pub const CHECKSUMS: &str = "CHECKSUMS";

/// Checks every file under `dir` against `checksums` (lines `<sha256>  <path>` or `<sha256> *<path>`, paths relative
/// to `dir`; blank lines and `#` comments are ignored). Every listed file must exist with its hash, and every file
/// under `dir` except `checksums` itself must be listed. The errors name each offending path.
pub fn verify_checksums(dir: &Path, checksums: &Path) -> Result<(), Vec<String>> {
    let text =
        fs::read_to_string(checksums).map_err(|e| vec![format!("{}: {e}", checksums.display())])?;
    let mut errors = Vec::new();
    let mut listed = BTreeSet::new();
    for (n, line) in text.lines().enumerate() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let Some((hash, rest)) = line.split_once(' ') else {
            errors.push(format!("CHECKSUMS line {}: malformed", n + 1));
            continue;
        };
        let rel = rest.trim_start_matches([' ', '*']);
        let hash = hash.to_ascii_lowercase();
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) || rel.is_empty() {
            errors.push(format!("CHECKSUMS line {}: malformed", n + 1));
            continue;
        }
        let rel_path = Path::new(rel);
        if !rel_path
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        {
            errors.push(format!("{rel}: not a relative path inside {THIRD_PARTY}/"));
            continue;
        }
        listed.insert(rel_path.to_path_buf());
        match sha256_file(&dir.join(rel_path)) {
            Ok(actual) if actual == hash => {}
            Ok(actual) => errors.push(format!("{rel}: expected {hash}, got {actual}")),
            Err(e) => errors.push(format!("{rel}: {e}")),
        }
    }
    let mut present = Vec::new();
    if let Err(e) = list_files(dir, Path::new(""), &mut present) {
        errors.push(format!("{}: {e}", dir.display()));
    }
    let own = checksums.strip_prefix(dir).ok().map(Path::to_path_buf);
    for rel in present {
        if Some(&rel) != own.as_ref() && !listed.contains(&rel) {
            errors.push(format!("{}: not pinned in CHECKSUMS", rel.display()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// Every non-directory entry under `dir`, relative to it.
fn list_files(dir: &Path, rel: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir.join(rel))? {
        let entry = entry?;
        let r = rel.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            list_files(dir, &r, out)?;
        } else {
            out.push(r);
        }
    }
    Ok(())
}

/// Copies every skill directory of `from` (a payload's `skills/`) into `<home>/skills/`, after verifying
/// `third-party/CHECKSUMS` when there is a `third-party/`. Each skill is staged as `<name>.tmp-<pid>` and renamed into
/// place only after every copy succeeded, so a failure copies nothing. A skill already installed is replaced.
pub fn copy_skills(layout: &Layout, from: &Path) -> Result<Vec<PackageUnit>, StepError> {
    let third = from.join(THIRD_PARTY);
    let mut pinned = None;
    if third.is_dir() {
        let checksums = third.join(CHECKSUMS);
        verify_checksums(&third, &checksums).map_err(|errs| {
            StepError::new(
                "digest-mismatch",
                format!(
                    "bundled third-party skills do not match CHECKSUMS: {}",
                    errs.join("; ")
                ),
            )
        })?;
        pinned = Some(sha256_file(&checksums).map_err(|e| StepError::io(&checksums, e))?);
    }
    let mut names: Vec<String> = fs::read_dir(from)
        .map_err(|e| StepError::io(from, e))?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();

    let dest_root = layout.skills();
    fs::create_dir_all(&dest_root).map_err(|e| StepError::io(&dest_root, e))?;
    let pid = std::process::id();
    let staged: Vec<(String, PathBuf)> = names
        .iter()
        .map(|n| (n.clone(), dest_root.join(format!("{n}.tmp-{pid}"))))
        .collect();
    let cleanup = |staged: &[(String, PathBuf)]| {
        for (_, p) in staged {
            let _ = fs::remove_dir_all(p);
        }
    };
    for (name, tmp) in &staged {
        let _ = fs::remove_dir_all(tmp);
        if let Err(e) = copy_tree(&from.join(name), tmp) {
            cleanup(&staged);
            return Err(e);
        }
    }
    let version = payload_version(from);
    let mut units = Vec::new();
    for (name, tmp) in &staged {
        let dest = dest_root.join(name);
        let old = dest_root.join(format!("{name}.tmp-{pid}.old"));
        let swapped = (|| {
            if dest.exists() {
                fs::rename(&dest, &old)?;
            }
            fs::rename(tmp, &dest)?;
            let _ = fs::remove_dir_all(&old);
            Ok::<(), std::io::Error>(())
        })();
        if let Err(e) = swapped {
            cleanup(&staged);
            return Err(StepError::io(&dest, e));
        }
        units.push(PackageUnit {
            name: name.clone(),
            version: version.clone(),
            source: "bundled".to_string(),
            sha256: if name == THIRD_PARTY {
                pinned.clone()
            } else {
                None
            },
        });
    }
    Ok(units)
}

/// The payload's version (`<payload>/package.json` next to `skills/`), which versions its bundled skills.
fn payload_version(skills: &Path) -> String {
    skills
        .parent()
        .and_then(|p| fs::read_to_string(p.join("package.json")).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["version"].as_str().map(str::to_string))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "0.0.0".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(s: &str) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(s.as_bytes()))
    }

    #[test]
    fn checksums_pin_every_file_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        fs::create_dir_all(d.join("a")).unwrap();
        fs::write(d.join("a/SKILL.md"), "x").unwrap();
        fs::write(
            d.join(CHECKSUMS),
            format!("# pins\n{}  a/SKILL.md\r\n", sha("x")),
        )
        .unwrap();
        assert_eq!(verify_checksums(d, &d.join(CHECKSUMS)), Ok(()));

        fs::write(d.join("a/extra.md"), "y").unwrap();
        let errs = verify_checksums(d, &d.join(CHECKSUMS)).unwrap_err();
        assert!(errs[0].contains("not pinned"), "{errs:?}");
        fs::remove_file(d.join("a/extra.md")).unwrap();

        fs::write(d.join("a/SKILL.md"), "tampered").unwrap();
        let errs = verify_checksums(d, &d.join(CHECKSUMS)).unwrap_err();
        assert!(errs[0].starts_with("a/SKILL.md: expected"), "{errs:?}");

        fs::write(d.join(CHECKSUMS), format!("{}  ../escape\n", sha("x"))).unwrap();
        let errs = verify_checksums(d, &d.join(CHECKSUMS)).unwrap_err();
        assert!(
            errs.iter().any(|e| e.contains("not a relative path")),
            "{errs:?}"
        );
    }
}
