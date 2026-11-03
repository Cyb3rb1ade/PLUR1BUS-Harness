//! Node 24's classic realpath identity: retain hard-path spelling and resolve only symbolic links.
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

fn absolute(path: &Path) -> io::Result<PathBuf> {
    let full = std::path::absolute(path)?;
    let mut normalized = PathBuf::new();
    for part in full.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

fn read_link(path: &Path) -> io::Result<PathBuf> {
    let target = fs::read_link(path)?;
    let text = target.to_string_lossy();
    // Node's readlink binding exposes the DOS target of Windows junctions.
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return Ok(PathBuf::from(format!(r"\\{rest}")));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return Ok(PathBuf::from(rest));
    }
    Ok(target)
}

pub(super) fn realpath(path: &Path) -> io::Result<PathBuf> {
    let mut pending = absolute(path)?;
    // Following metadata also checks broken targets and filesystem loop limits.
    // Keep the userspace restart bound finite for links changing during the walk.
    for _ in 0..256 {
        let parts: Vec<OsString> = pending
            .components()
            .map(|part| part.as_os_str().to_owned())
            .collect();
        let mut current = PathBuf::new();
        let mut replacement = None;
        for (index, part) in parts.iter().enumerate() {
            current.push(part);
            if matches!(
                Path::new(part).components().next(),
                Some(Component::Prefix(_))
            ) {
                continue;
            }
            let metadata = fs::symlink_metadata(&current)?;
            if !metadata.file_type().is_symlink() {
                continue;
            }
            fs::metadata(&current)?;
            let target = read_link(&current)?;
            let mut resolved = current.parent().unwrap_or(Path::new("")).join(target);
            for remainder in &parts[index + 1..] {
                resolved.push(remainder);
            }
            replacement = Some(absolute(&resolved)?);
            break;
        }
        match replacement {
            Some(next) => pending = next,
            None => return Ok(pending),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "workspace link resolution exceeded its bound",
    ))
}
