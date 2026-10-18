//! Trusted manifest paths and bounded SHA-256 verification shared by installer adapters.
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Component, Path, PathBuf},
};
pub type Result<T> = std::result::Result<T, &'static str>;
pub fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) && hash != "0".repeat(64)
}
pub fn resource(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    if relative.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("installer-resource");
    }
    let mut current = root.to_path_buf();
    for part in path.components() {
        current.push(part);
        let meta = std::fs::symlink_metadata(&current).map_err(|_| "installer-resource")?;
        if meta.file_type().is_symlink() {
            return Err("installer-resource");
        }
    }
    if !current.is_file() {
        return Err("installer-resource");
    }
    Ok(current)
}
pub fn sha256(path: &Path) -> Result<String> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| "installer-file")?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("installer-file");
    }
    let mut file = std::fs::File::open(path).map_err(|_| "installer-file")?;
    let mut digest = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let len = file.read(&mut buf).map_err(|_| "installer-file")?;
        if len == 0 {
            break;
        }
        digest.update(&buf[..len]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
pub fn verify(path: &Path, expected: &str) -> Result<()> {
    if !valid_hash(expected) {
        return Err("installer-unconfigured");
    }
    if sha256(path)? != expected.to_ascii_lowercase() {
        return Err("installer-checksum");
    }
    Ok(())
}
pub async fn command(program: &Path, args: &[&std::ffi::OsStr]) -> Result<()> {
    let status = tokio::time::timeout(
        std::time::Duration::from_secs(3600),
        tokio::process::Command::new(program)
            .args(args)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status(),
    )
    .await
    .map_err(|_| "installer-timeout")?
    .map_err(|_| "installer-command")?;
    if status.success() {
        Ok(())
    } else {
        Err("installer-command")
    }
}
