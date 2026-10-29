//! B4: private metadata claims and inspection ownership. Package bytes are opened only by the ext worker.
use crate::ext::{record, ExtError};
use crate::paths::Layout;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

const MAX_METADATA: u64 = 2048;
const MAX_PACKAGE: u64 = 1 << 30;
const UPLOAD_TTL: u64 = 600_000;

/// A local Core credential and an API-forwarded person remain distinct, even for userId `local-owner`.
#[derive(Clone, Copy)]
pub enum Caller<'a> {
    LocalOwner,
    Person(&'a str),
}

impl<'a> Caller<'a> {
    pub fn from_principal(principal: Option<&'a Value>) -> Self {
        match principal {
            Some(value) => Self::Person(value["userId"].as_str().unwrap_or_default()),
            None => Self::LocalOwner,
        }
    }
    fn matches(self, user: Option<&str>) -> bool {
        match (self, user) {
            (Self::LocalOwner, None) => true,
            (Self::Person(a), Some(b)) => a == b,
            _ => false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadMetadata {
    version: u8,
    user_id: String,
    expires_at: u64,
    sha256: String,
    size: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InspectionOwner {
    version: u8,
    user_id: Option<String>,
}

fn unavailable() -> ExtError {
    ExtError::new(
        "E_NOT_FOUND",
        "upload-expired",
        "this upload has expired or does not exist; upload the package again",
    )
}

fn private(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid has no preconditions and cannot fail.
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

fn private_path(path: &Path, directory: bool) -> io::Result<Metadata> {
    let meta = fs::symlink_metadata(path)?;
    if !private(&meta) || directory && !meta.is_dir() || !directory && !meta.is_file() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    #[cfg(windows)]
    {
        let user = plur1bus_rpc::win::user_sid()?;
        let acl = plur1bus_rpc::win::file_dacl_report(path)?;
        if !plur1bus_rpc::acl::run_writable_by_others(&acl, &user).is_empty() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    Ok(meta)
}

fn metadata(path: &Path) -> io::Result<Vec<u8>> {
    private_path(path, false)?;
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
    let file = options.open(path)?;
    let info = file.metadata()?;
    if !info.is_file() || !private(&info) || info.len() > MAX_METADATA {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_METADATA + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_METADATA {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(bytes)
}

fn directory(layout: &Layout, name: &str) -> io::Result<PathBuf> {
    private_path(&layout.run(), true)?;
    let dir = layout.run().join(name);
    private_path(&dir, true)?;
    Ok(dir)
}

/// The successful metadata rename is the single claim shared with the API expiry sweep. RAII removes both files.
pub struct Claim {
    metadata: PathBuf,
    path: PathBuf,
    pub sha256: String,
    pub size: u64,
}

impl Claim {
    pub fn path(&self) -> &Path {
        &self.path
    }
}
impl Drop for Claim {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_file(&self.metadata);
    }
}

/// Validate only metadata and file identity/size here. The worker verifies the byte digest before parsing anything.
pub fn claim(layout: &Layout, id: &str, caller: Caller<'_>) -> Result<Claim, ExtError> {
    if id.len() != 43
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(unavailable());
    }
    let dir = directory(layout, "uploads").map_err(|_| unavailable())?;
    let meta_path = dir.join(format!("{id}.json"));
    let raw = metadata(&meta_path).map_err(|_| unavailable())?;
    let parsed: UploadMetadata = serde_json::from_slice(&raw).map_err(|_| unavailable())?;
    let now = record::now_ms();
    if parsed.version != 1
        || !caller.matches(Some(&parsed.user_id))
        || parsed.user_id.is_empty()
        || parsed.user_id.len() > 512
    {
        return Err(unavailable());
    }
    // A foreign request never renames or removes this person's files, including an expired upload.
    if parsed.expires_at <= now || parsed.expires_at.saturating_sub(now) > UPLOAD_TTL {
        let _ = fs::remove_file(&meta_path);
        let _ = fs::remove_file(dir.join(id));
        return Err(unavailable());
    }
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| unavailable())?;
    let nonce: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let claimed_meta = dir.join(format!(".{id}.claim-{nonce}.json"));
    fs::rename(&meta_path, &claimed_meta).map_err(|_| unavailable())?;
    let claimed = Claim {
        path: dir.join(id),
        metadata: claimed_meta,
        sha256: parsed.sha256.clone(),
        size: parsed.size,
    };
    let result = (|| {
        if metadata(&claimed.metadata)? != raw
            || parsed.expires_at <= record::now_ms()
            || parsed.size == 0
            || parsed.size > MAX_PACKAGE
            || parsed.sha256.len() != 64
            || !parsed
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let info = private_path(&claimed.path, false)?;
        if info.len() != parsed.size {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok::<_, io::Error>(())
    })();
    if result.is_err() {
        return Err(unavailable());
    }
    Ok(claimed)
}

/// Creates `dir` readable and writable only by this user (0700, or the run-directory DACL on Windows) unless it exists.
/// Every writer of `run/inspect/` uses this, so whoever comes first leaves a directory [`bind_inspection`] accepts.
pub(crate) fn create_private_dir(dir: &Path) -> io::Result<()> {
    match fs::create_dir(dir) {
        Ok(()) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
            }
            #[cfg(windows)]
            {
                let user = plur1bus_rpc::win::user_sid()?;
                plur1bus_rpc::win::set_path_dacl(dir, &plur1bus_rpc::acl::run_dir_sddl(&user))?;
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

fn owner_path(layout: &Layout, id: &str) -> PathBuf {
    layout
        .run()
        .join("inspect")
        .join(format!("{id}.owner.json"))
}

/// A fresh worker result becomes visible to its creator only after this private marker has been persisted.
pub fn bind_inspection(layout: &Layout, id: &str, caller: Caller<'_>) -> Result<(), ExtError> {
    if !record::valid_id(id) {
        return Err(record::expired());
    }
    private_path(&layout.run(), true).map_err(|_| record::expired())?;
    create_private_dir(&layout.run().join("inspect")).map_err(|_| record::expired())?;
    directory(layout, "inspect").map_err(|_| record::expired())?;
    let owner = InspectionOwner {
        version: 1,
        user_id: match caller {
            Caller::LocalOwner => None,
            Caller::Person(id) => Some(id.to_owned()),
        },
    };
    let path = owner_path(layout, id);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.access_mode(
            windows_sys::Win32::Foundation::GENERIC_WRITE
                | windows_sys::Win32::Storage::FileSystem::WRITE_DAC,
        );
    }
    let result = (|| {
        let mut file: File = options.open(&path)?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            plur1bus_rpc::win::restrict_to_user(file.as_raw_handle())?;
        }
        serde_json::to_writer(&mut file, &owner)?;
        file.flush()?;
        file.sync_all()
    })();
    result.map_err(|_| {
        let _ = fs::remove_file(path);
        record::expired()
    })
}

/// Foreign/malformed markers and expired IDs are indistinguishable. A legacy CLI record belongs only to local Owner.
pub fn check_inspection(layout: &Layout, id: &str, caller: Caller<'_>) -> Result<(), ExtError> {
    if !record::valid_id(id) {
        return Err(record::expired());
    }
    directory(layout, "inspect").map_err(|_| record::expired())?;
    let path = owner_path(layout, id);
    match metadata(&path) {
        Ok(bytes) => {
            let owner: InspectionOwner =
                serde_json::from_slice(&bytes).map_err(|_| record::expired())?;
            if owner.version != 1 || !caller.matches(owner.user_id.as_deref()) {
                return Err(record::expired());
            }
            Ok(())
        }
        Err(error)
            if error.kind() == io::ErrorKind::NotFound && matches!(caller, Caller::LocalOwner) =>
        {
            Ok(())
        }
        Err(_) => Err(record::expired()),
    }
}

pub fn remove_owner(layout: &Layout, id: &str) {
    if record::valid_id(id) {
        let _ = fs::remove_file(owner_path(layout, id));
    }
}
