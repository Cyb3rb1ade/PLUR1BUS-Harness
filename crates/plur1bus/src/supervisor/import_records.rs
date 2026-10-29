//! Fixed private maintenance records. The supervisor reads control metadata, never source data or Engine stores.
use crate::ext::ExtError;
use crate::paths::Layout;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const MAX_RECORD: u64 = 8 * 1024 * 1024;

pub fn unavailable() -> ExtError {
    ExtError::new(
        "E_NOT_FOUND",
        "import-record-unavailable",
        "import record is unavailable",
    )
}

pub fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

pub fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn source_type(value: &str) -> bool {
    static CATALOG: std::sync::OnceLock<std::collections::BTreeMap<String, Value>> =
        std::sync::OnceLock::new();
    CATALOG
        .get_or_init(|| {
            serde_json::from_str(include_str!(
                "../../../../packages/core/src/import/source-catalog.json"
            ))
            .unwrap_or_default()
        })
        .contains_key(value)
}

fn private(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid has no preconditions.
        if meta.uid() != unsafe { libc::geteuid() }
            || meta.permissions().mode() & 0o077 != 0
            || meta.is_file() && meta.nlink() != 1
        {
            return false;
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return false;
        }
    }
    true
}

#[cfg(windows)]
fn private_acl(path: &Path) -> bool {
    let Ok(sid) = plur1bus_rpc::win::user_sid() else {
        return false;
    };
    plur1bus_rpc::win::file_dacl_report(path).is_ok_and(|acl| {
        acl.iter().all(|ace| {
            !ace.allow
                || ace.mask == 0
                || ace.sid == sid
                || ace.sid == plur1bus_rpc::acl::SYSTEM_SID
        })
    })
}

/// All segments below home must already be private and unlinked. A missing directory is never silently trusted.
fn parents(layout: &Layout, path: &Path) -> Result<(), ExtError> {
    let relative = path.strip_prefix(&layout.home).map_err(|_| unavailable())?;
    let mut current = layout.home.clone();
    let home = fs::symlink_metadata(&current).map_err(|_| unavailable())?;
    if !home.is_dir() || home.file_type().is_symlink() {
        return Err(unavailable());
    }
    let parts: Vec<_> = relative.components().collect();
    for component in &parts[..parts.len().saturating_sub(1)] {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err(unavailable());
        }
        current.push(component);
        let meta = fs::symlink_metadata(&current).map_err(|_| unavailable())?;
        if !meta.is_dir() || !private(&meta) {
            return Err(unavailable());
        }
        #[cfg(windows)]
        {
            if !private_acl(&current) {
                return Err(unavailable());
            }
        }
    }
    Ok(())
}

fn checked_file(layout: &Layout, path: &Path, maximum: u64) -> Result<fs::File, ExtError> {
    parents(layout, path)?;
    let before = fs::symlink_metadata(path).map_err(|_| unavailable())?;
    if !before.is_file() || !private(&before) || before.len() > maximum {
        return Err(unavailable());
    }
    #[cfg(windows)]
    if !private_acl(path) {
        return Err(unavailable());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|_| unavailable())?;
    let after = file.metadata().map_err(|_| unavailable())?;
    if !after.is_file() || !private(&after) || after.len() > maximum {
        return Err(unavailable());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev() || before.ino() != after.ino() {
            return Err(unavailable());
        }
    }
    Ok(file)
}

pub fn read(layout: &Layout, path: &Path, maximum: u64) -> Result<Vec<u8>, ExtError> {
    let mut bytes = Vec::new();
    checked_file(layout, path, maximum)?
        .take(maximum.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    if bytes.len() as u64 > maximum {
        return Err(unavailable());
    }
    Ok(bytes)
}

/// Hashes the fixed private report without interpreting its body or allocating its full size in the supervisor.
pub fn fingerprint(layout: &Layout, path: &Path, maximum: u64) -> Result<(String, u64), ExtError> {
    let mut file = checked_file(layout, path, maximum)?;
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut chunk = zeroize::Zeroizing::new([0u8; 64 * 1024]);
    loop {
        let read = file.read(&mut chunk[..]).map_err(|_| unavailable())?;
        if read == 0 {
            break;
        }
        bytes = bytes
            .checked_add(read as u64)
            .filter(|bytes| *bytes <= maximum)
            .ok_or_else(unavailable)?;
        hash.update(&chunk[..read]);
    }
    Ok((format!("{:x}", hash.finalize()), bytes))
}

pub fn directory(layout: &Layout, names: &[&str]) -> Result<PathBuf, ExtError> {
    parents(layout, &layout.home.join("check"))?;
    let mut path = layout.home.clone();
    for name in names {
        if name.is_empty() || name.contains(['/', '\\']) || *name == "." || *name == ".." {
            return Err(unavailable());
        }
        path.push(name);
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&path) {
            Ok(()) => {
                #[cfg(windows)]
                {
                    let sid = plur1bus_rpc::win::user_sid().map_err(|_| unavailable())?;
                    plur1bus_rpc::win::set_path_dacl(&path, &plur1bus_rpc::acl::run_dir_sddl(&sid))
                        .map_err(|_| unavailable())?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(unavailable()),
        }
        let meta = fs::symlink_metadata(&path).map_err(|_| unavailable())?;
        if !meta.is_dir() || !private(&meta) {
            return Err(unavailable());
        }
    }
    parents(layout, &path.join("record"))?;
    Ok(path)
}

pub fn write(layout: &Layout, path: &Path, value: &impl Serialize) -> Result<(), ExtError> {
    let bytes = serde_json::to_vec(value).map_err(|_| unavailable())?;
    write_bytes(layout, path, &bytes)
}

pub fn write_bytes(layout: &Layout, path: &Path, bytes: &[u8]) -> Result<(), ExtError> {
    parents(layout, path)?;
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        if bytes.len() as u64 > MAX_RECORD {
            return Err(unavailable());
        }
        let mut file = crate::audit::create_private(&temporary, true).map_err(|_| unavailable())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| unavailable())?;
        drop(file);
        crate::ext::state::rename_retrying(&temporary, path).map_err(|_| unavailable())?;
        #[cfg(unix)]
        {
            fs::File::open(path.parent().ok_or_else(unavailable)?)
                .and_then(|file| file.sync_all())
                .map_err(|_| unavailable())?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub run_id: String,
    pub owner_id: String,
    pub source_type: String,
    pub source_sha256: String,
    pub config_revision: String,
    pub created_at: String,
    pub expires_at: String,
    pub options: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ticket {
    pub schema: String,
    pub id: String,
    pub plan_id: String,
    pub run_id: String,
    pub owner_id: String,
    pub operation: String,
    pub plan_sha256: String,
    pub source_sha256: String,
    pub target_sha256: String,
    pub created_at: String,
    pub expires_at: String,
}

pub fn plan(layout: &Layout, id: &str) -> Result<(Plan, String), ExtError> {
    if !uuid(id) {
        return Err(unavailable());
    }
    let bytes = read(
        layout,
        &layout.home.join("imports/plans").join(format!("{id}.json")),
        MAX_RECORD,
    )?;
    let raw: Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    if raw["schema"] != "import.plan/1" {
        return Err(unavailable());
    }
    let plan: Plan = serde_json::from_value(raw).map_err(|_| unavailable())?;
    if plan.id != id
        || !uuid(&plan.run_id)
        || plan.owner_id.is_empty()
        || plan.owner_id.len() > 512
        || !hash(&plan.source_sha256)
        || plan.config_revision.len() > 256
        || !plan.options.is_object()
        || !source_type(&plan.source_type)
        || plan.source_type.len() > 64
        || !plan
            .source_type
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_lowercase)
        || !plan
            .source_type
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err(unavailable());
    }
    Ok((plan, format!("{:x}", Sha256::digest(&bytes))))
}

/// The Core producer uses Date.toISOString; fixed-width UTC timestamps compare chronologically.
fn timestamp(value: &str) -> bool {
    crate::ext::record::parse_iso_ms(value).is_some_and(|millis| super::iso8601(millis) == value)
        && value.len() == 24
        && value.bytes().enumerate().all(|(i, c)| match i {
            4 | 7 => c == b'-',
            10 => c == b'T',
            13 | 16 => c == b':',
            19 => c == b'.',
            23 => c == b'Z',
            _ => c.is_ascii_digit(),
        })
}

pub fn claim(
    layout: &Layout,
    ticket_id: &str,
    expected: &Plan,
    digest: &str,
    owner: &str,
    operation: &str,
    now: u64,
) -> Result<Ticket, ExtError> {
    if !uuid(ticket_id) {
        return Err(unavailable());
    }
    let path = layout
        .home
        .join("imports/preflight")
        .join(format!("{ticket_id}.json"));
    let validate = |bytes: &[u8]| -> Result<Ticket, ExtError> {
        let ticket: Ticket = serde_json::from_slice(bytes).map_err(|_| unavailable())?;
        let time = super::iso8601(now);
        if ticket.schema != "import.preflight/1"
            || ticket.id != ticket_id
            || ticket.plan_id != expected.id
            || ticket.run_id != expected.run_id
            || ticket.owner_id != owner
            || expected.owner_id != owner
            || ticket.operation != operation
            || ticket.plan_sha256 != digest
            || ticket.source_sha256 != expected.source_sha256
            || !hash(&ticket.target_sha256)
            || !timestamp(&ticket.created_at)
            || !timestamp(&ticket.expires_at)
            || ticket.created_at > time
            || ticket.expires_at <= time
            || ticket.expires_at <= ticket.created_at
            || ticket.expires_at > super::iso8601(now.saturating_add(300_000))
        {
            return Err(unavailable());
        }
        Ok(ticket)
    };
    validate(&read(layout, &path, 8192)?)?;
    let claimed = path.with_extension(format!("claim-{}.json", uuid::Uuid::new_v4()));
    fs::rename(&path, &claimed).map_err(|_| unavailable())?;
    let result = read(layout, &claimed, 8192).and_then(|bytes| validate(&bytes));
    let _ = fs::remove_file(&claimed);
    result
}

#[cfg(test)]
#[path = "import_records_tests.rs"]
mod tests;
