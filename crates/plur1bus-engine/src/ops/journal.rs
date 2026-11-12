//! Fenced, durable write-ahead JSONL shared by rebind and unimport.
use super::context::error;
use crate::{
    contract::{EngineError, MemoryOpErrorCode},
    store::paths::{assert_trusted_path, secure_dir},
    text::json::{write_json, TolerantJsonValue as Json},
};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
fn storage<T>(_: T) -> EngineError {
    error(MemoryOpErrorCode::Storage)
}
fn sync_dir(path: &Path) {
    let _ = File::open(path).and_then(|f| f.sync_all());
}
fn complete_end(file: &mut File) -> Result<Option<u64>, EngineError> {
    let len = file.metadata().map_err(storage)?.len();
    if len == 0 {
        return Ok(Some(0));
    }
    file.seek(SeekFrom::End(-1)).map_err(storage)?;
    let mut last = [0];
    file.read_exact(&mut last).map_err(storage)?;
    if last[0] == b'\n' {
        return Ok(Some(len));
    }
    let mut end = len;
    let mut chunk = vec![0; 65536];
    while end > 0 {
        let start = end.saturating_sub(chunk.len() as u64);
        let size = (end - start) as usize;
        file.seek(SeekFrom::Start(start)).map_err(storage)?;
        file.read_exact(&mut chunk[..size]).map_err(storage)?;
        if let Some(i) = chunk[..size].iter().rposition(|b| *b == b'\n') {
            return Ok(Some(start + i as u64 + 1));
        }
        end = start;
    }
    Ok(None)
}
fn repaired(
    mut file: File,
    path: &Path,
    now: i64,
    fence: &dyn Fn() -> Result<(), EngineError>,
) -> Result<File, EngineError> {
    let end = complete_end(&mut file)?;
    fence()?;
    let Some(end) = end else {
        drop(file);
        let mut target = path.as_os_str().to_owned();
        target.push(format!(".corrupt-{now}"));
        let target = PathBuf::from(target);
        assert_trusted_path(&target).map_err(storage)?;
        fs::rename(path, target).map_err(storage)?;
        if let Some(parent) = path.parent() {
            sync_dir(parent);
        }
        return Err(error(MemoryOpErrorCode::LedgerCorrupt));
    };
    if file.metadata().map_err(storage)?.len() != end {
        file.set_len(end).map_err(storage)?;
        file.sync_all().map_err(storage)?;
    }
    Ok(file)
}
/// Repair an existing journal before making any store mutation. Absence creates nothing.
pub(super) fn prepare(
    path: &Path,
    now: i64,
    fence: &dyn Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    fence()?;
    assert_trusted_path(path).map_err(storage)?;
    let file = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(storage(e)),
    };
    repaired(file, path, now, fence).map(|_| ())
}
/// Appends use r+/create rather than O_APPEND so Windows permits torn-tail truncation.
pub(super) fn append(
    path: &Path,
    row: &Json,
    now: i64,
    new: bool,
    fence: &dyn Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    fence()?;
    assert_trusted_path(path).map_err(storage)?;
    let parent = path
        .parent()
        .ok_or_else(|| error(MemoryOpErrorCode::Storage))?;
    secure_dir(parent).map_err(storage)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if new {
        options.create_new(true);
    } else {
        options.create(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    fence()?;
    let file = options.open(path).map_err(|e| {
        if new && e.kind() == std::io::ErrorKind::AlreadyExists {
            error(MemoryOpErrorCode::Conflict)
        } else {
            storage(e)
        }
    })?;
    let mut file = repaired(file, path, now, fence)?;
    fence()?;
    file.seek(SeekFrom::End(0)).map_err(storage)?;
    file.write_all(format!("{}\n", write_json(row)).as_bytes())
        .map_err(storage)?;
    file.sync_all().map_err(storage)?;
    for p in parent.ancestors().take(3) {
        sync_dir(p);
    }
    Ok(())
}
