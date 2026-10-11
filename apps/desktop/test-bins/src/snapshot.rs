//! Byte-verifying snapshots for synthetic stub fixtures, never a production backup implementation.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Read},
    path::Path,
};
#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Entry {
    bytes: u64,
    mode: u32,
    sha256: String,
}
fn mode(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o7777
    }
    #[cfg(not(unix))]
    {
        u32::from(metadata.permissions().readonly())
    }
}
fn hash(file: &Path) -> io::Result<String> {
    let mut f = fs::File::open(file)?;
    let mut h = Sha256::new();
    let mut buf = [0; 16384];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
fn entries(root: &Path, dir: &Path, out: &mut BTreeMap<String, Entry>) -> io::Result<()> {
    for child in fs::read_dir(dir)? {
        let child = child?;
        let path = child.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(io::ErrorKind::InvalidData.into());
        }
        if metadata.is_dir() {
            entries(root, &path, out)?;
        } else if metadata.is_file() {
            let name = path
                .strip_prefix(root)
                .map_err(|_| io::ErrorKind::InvalidData)?
                .to_str()
                .ok_or(io::ErrorKind::InvalidData)?
                .replace('\\', "/");
            if name == "MANIFEST.sha256" || name == "SNAPSHOT.json" {
                continue;
            }
            out.insert(
                name,
                Entry {
                    bytes: metadata.len(),
                    mode: mode(&metadata),
                    sha256: hash(&path)?,
                },
            );
        } else {
            return Err(io::ErrorKind::InvalidData.into());
        }
    }
    Ok(())
}
fn copy(src: &Path, dst: &Path, manifest: &BTreeMap<String, Entry>) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for name in manifest.keys() {
        let from = src.join(name);
        let to = dst.join(name);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        if fs::symlink_metadata(&to).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(io::ErrorKind::InvalidData.into());
        }
        fs::copy(&from, &to)?;
        let metadata = fs::metadata(from)?;
        let file = fs::File::options().write(true).open(to)?;
        file.set_times(
            fs::FileTimes::new()
                .set_modified(metadata.modified()?)
                .set_accessed(metadata.accessed()?),
        )?;
        file.sync_all()?;
    }
    Ok(())
}
pub fn snapshot(src: &Path, dst: &Path) -> io::Result<Value> {
    let mut manifest = BTreeMap::new();
    entries(src, src, &mut manifest)?;
    copy(src, dst, &manifest)?;
    let bytes = serde_json::to_vec(&manifest)?;
    fs::write(dst.join("MANIFEST.sha256"), &bytes)?;
    let value = json!({"schema":"state.snapshot/1","from":"mock","createdAt":"2026-10-10T00:00:00Z","fileCount":manifest.len(),"bytes":manifest.values().map(|e|e.bytes).sum::<u64>(),"manifestSha256":format!("{:x}",Sha256::digest(&bytes))});
    fs::write(dst.join("SNAPSHOT.json"), serde_json::to_vec(&value)?)?;
    verify(dst)?;
    Ok(value)
}
pub fn verify(dir: &Path) -> io::Result<Value> {
    let bytes = fs::read(dir.join("MANIFEST.sha256"))?;
    let manifest: BTreeMap<String, Entry> = serde_json::from_slice(&bytes)?;
    let mut actual = BTreeMap::new();
    entries(dir, dir, &mut actual)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let info: Value = serde_json::from_slice(&fs::read(dir.join("SNAPSHOT.json"))?)?;
    if actual != manifest || info["manifestSha256"] != hash {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(json!({"schema":"state.verify/1","ok":true,"manifestSha256":hash,"mismatches":[]}))
}
pub fn restore(src: &Path, dst: &Path) -> io::Result<Value> {
    verify(src)?;
    let manifest = serde_json::from_slice(&fs::read(src.join("MANIFEST.sha256"))?)?;
    copy(src, dst, &manifest)?;
    let mut actual = BTreeMap::new();
    entries(dst, dst, &mut actual)?;
    if actual != manifest {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(json!({"schema":"state.restore/1","ok":true}))
}
