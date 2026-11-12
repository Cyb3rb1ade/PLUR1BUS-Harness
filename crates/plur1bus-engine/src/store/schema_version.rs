//! The Node store schema marker, without implicit migrations.

use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::contract::StoreError;
use crate::text::js::JsString;
use crate::text::json::{parse_json, TolerantJsonValue};

use super::atomic_write::atomic_write;
use super::paths::{absolute_path, assert_trusted_path, secure_dir};

/// Persisted schema generations understood by the Phase 1 store.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreSchemaVersion {
    /// A store without a marker.
    Legacy0,
    /// The current 69-column schema.
    V1,
}

/// Read a physical agent store's marker, accepting a colocated composite-fixture marker first.
///
/// The pinned engine's ordinary marker belongs to `baseDbPath`, one level above its agent
/// directory. A missing marker is legacy; an unreadable or unsupported marker is an error.
pub fn read(path: &Path) -> Result<StoreSchemaVersion, StoreError> {
    assert_trusted_path(path)?;
    match read_marker(&path.join("_schema.json"))? {
        Some(version) => Ok(version),
        None => read_base(path.parent().unwrap_or(path)),
    }
}

/// Read exactly the marker owned by a configured Node `baseDbPath`.
pub fn read_base(base: &Path) -> Result<StoreSchemaVersion, StoreError> {
    Ok(read_marker(&base.join("_schema.json"))?.unwrap_or(StoreSchemaVersion::Legacy0))
}

/// The pin's `baseDbPathIsFreshStore`: the base is missing, or holds nothing but orphaned marker temporaries.
pub fn is_fresh_base(base: &Path) -> Result<bool, StoreError> {
    match fs::read_dir(base) {
        Ok(entries) => {
            for entry in entries {
                let name = entry.map_err(io_error)?.file_name();
                if !name.to_str().is_some_and(is_marker_temporary) {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(io_error(error)),
    }
}

/// Store bases this process has promised a marker (see [`guard_base`]).
static GUARDED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
thread_local! {
    static INITIALISING: Cell<bool> = const { Cell::new(false) };
}

/// Promise a marker to `base`: from now on, the first directory created inside a fresh base (or the base itself)
/// by any of the store's creators writes the current marker first, so a new installation never holds an entry
/// without it. The pin writes the marker when the engine is created; the engine process does so at its start
/// (`main.rs`), and a library composition gets it here, with the first entry, never on a read. Nothing is written
/// here. A base that already holds content stays as it is, and the promise ends with the first creator that finds
/// the base initialised or holding content: a base with content never becomes fresh again.
pub fn guard_base(base: &Path) -> Result<(), StoreError> {
    let base = absolute_path(base)?;
    let mut guarded = GUARDED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !guarded.contains(&base) {
        guarded.push(base);
    }
    Ok(())
}

/// Called by every directory creator just before it creates `directory`.
pub(super) fn before_create(directory: &Path) -> Result<(), StoreError> {
    let bases: Vec<PathBuf> = {
        let guarded = GUARDED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if guarded.is_empty() {
            return Ok(());
        }
        let Ok(directory) = absolute_path(directory) else {
            return Ok(());
        };
        guarded
            .iter()
            .filter(|base| directory.starts_with(base))
            .cloned()
            .collect()
    };
    if bases.is_empty() || INITIALISING.with(Cell::get) {
        return Ok(());
    }
    INITIALISING.with(|flag| flag.set(true));
    let result = bases.iter().try_for_each(|base| {
        if is_fresh_base(base)? {
            initialize_base(
                base,
                &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                env!("CARGO_PKG_VERSION"),
            )?;
        }
        // Kept or void: later creators no longer read the base, and a failing read of it cannot fail them.
        GUARDED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|guarded| guarded != base);
        Ok(())
    });
    INITIALISING.with(|flag| flag.set(false));
    result
}

/// Initialize only a missing or empty base, as the pinned engine does before opening any table.
///
/// Existing nonempty bases stay legacy and existing markers are left byte-identical. The
/// caller supplies its clock's ISO timestamp and engine version. This is initialization, not
/// a migration: call it before creating an agent directory inside a new base.
pub fn initialize_base(
    base: &Path,
    written_at: &str,
    engine_version: &str,
) -> Result<StoreSchemaVersion, StoreError> {
    assert_trusted_path(base)?;
    let fresh = is_fresh_base(base)?;
    if !fresh {
        return read_base(base);
    }
    secure_dir(base)?;
    let timestamp = serde_json::to_string(written_at).map_err(|_| StoreError::Corrupt)?;
    let version = serde_json::to_string(engine_version).map_err(|_| StoreError::Corrupt)?;
    let text = format!(
        "{{\n  \"schemaVersion\": \"1\",\n  \"writtenAt\": {timestamp},\n  \"engineVersion\": {version}\n}}\n"
    );
    atomic_write(&base.join("_schema.json"), text.as_bytes()).map_err(io_error)?;
    Ok(StoreSchemaVersion::V1)
}

/// Upper bound of a schema marker; the pin writes about 100 bytes (`initialize_base`).
const MAX_MARKER_BYTES: u64 = 64 * 1024;

/// Read a marker's text: only a regular file, opened without following a final link and
/// without blocking on a FIFO or device, at most `MAX_MARKER_BYTES`. Anything else is
/// `Corrupt` (RE-D164); a missing file is `None`.
pub(crate) fn read_marker_text(path: &Path) -> Result<Option<String>, StoreError> {
    use std::io::Read;
    assert_trusted_path(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT: open a link itself; metadata rejects it below.
        options.custom_flags(0x0020_0000);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() || metadata.len() > MAX_MARKER_BYTES {
        return Err(StoreError::Corrupt);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(StoreError::Corrupt);
        }
    }
    let mut bytes = Vec::new();
    file.take(MAX_MARKER_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > MAX_MARKER_BYTES {
        return Err(StoreError::Corrupt);
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| StoreError::Corrupt)
}

fn read_marker(path: &Path) -> Result<Option<StoreSchemaVersion>, StoreError> {
    let Some(text) = read_marker_text(path)? else {
        return Ok(None);
    };
    let TolerantJsonValue::Object(fields) = parse_json(&text).map_err(|_| StoreError::Corrupt)?
    else {
        return Err(StoreError::Corrupt);
    };
    let key = JsString::from_utf8_str("schemaVersion");
    let value = fields
        .into_iter()
        .rev()
        .find(|(name, _)| *name == key)
        .map(|(_, value)| value);
    match value {
        Some(TolerantJsonValue::String(value)) if value == JsString::from_utf8_str("0") => {
            Ok(Some(StoreSchemaVersion::Legacy0))
        }
        Some(TolerantJsonValue::String(value)) if value == JsString::from_utf8_str("1") => {
            Ok(Some(StoreSchemaVersion::V1))
        }
        _ => Err(StoreError::Corrupt),
    }
}

fn is_marker_temporary(name: &str) -> bool {
    let Some(suffix) = name
        .strip_prefix("_schema.json.")
        .or_else(|| name.strip_prefix("._schema.json."))
    else {
        return false;
    };
    let mut pieces = suffix.split('.');
    let Some(pid) = pieces.next() else {
        return false;
    };
    let Some(nonce) = pieces.next() else {
        return false;
    };
    !pid.is_empty()
        && pid.bytes().all(|byte| byte.is_ascii_digit())
        && nonce.len() == 12
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && pieces.next() == Some("tmp")
        && pieces.next().is_none()
}

fn io_error(error: std::io::Error) -> StoreError {
    StoreError::from(error)
}

#[cfg(test)]
mod guard_tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use crate::store::directory::TrustedDirectory;

    fn private_empty_base(root: &Path) -> PathBuf {
        let base = fs::canonicalize(root).unwrap().join("lancedb");
        fs::create_dir(&base).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        }
        base
    }

    fn guarded(base: &Path) -> bool {
        GUARDED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .any(|guarded| guarded == base)
    }

    /// `TrustedDirectory::create_child` is the one creator the integration suite cannot call.
    #[test]
    fn create_child_in_a_guarded_empty_base_brings_the_marker() {
        let root = tempfile::tempdir().unwrap();
        let base = private_empty_base(root.path());
        guard_base(&base).unwrap();
        let directory = TrustedDirectory::open(&base).unwrap();
        assert!(!base.join("_schema.json").exists());
        directory.create_child("_links").unwrap();
        assert!(base.join("_schema.json").is_file());
        assert_eq!(read_base(&base).unwrap(), StoreSchemaVersion::V1);
    }

    /// The promise ends once it is kept, and at once for a base that already holds content.
    #[test]
    fn a_kept_or_void_promise_is_released() {
        let root = tempfile::tempdir().unwrap();
        let base = private_empty_base(root.path());
        guard_base(&base).unwrap();
        assert!(guarded(&base));
        before_create(&base.join("_jobs")).unwrap();
        assert!(base.join("_schema.json").is_file());
        assert!(!guarded(&base));

        let legacy_root = tempfile::tempdir().unwrap();
        let legacy = private_empty_base(legacy_root.path());
        fs::create_dir(legacy.join("a1")).unwrap();
        guard_base(&legacy).unwrap();
        before_create(&legacy.join("_jobs")).unwrap();
        assert!(!legacy.join("_schema.json").exists());
        assert!(!guarded(&legacy));
    }
}
