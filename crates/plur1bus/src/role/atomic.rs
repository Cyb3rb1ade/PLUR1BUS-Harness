//! Private unique role-record staging and platform durability. No token may leave before this returns success.
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// Open an existing regular file without following links or blocking on a FIFO.
pub(super) fn open_record(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    protect_open(&mut options);
    regular(options.open(path)?)
}

/// Hold the inter-process role lock over validation, comparison and durable publication.
pub(super) fn lock(path: &Path) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    protect_open(&mut options);
    private_options(&mut options);
    let file = regular(options.open(path.with_extension("lock"))?)?;
    restrict(&file)?;
    file.lock()?;
    Ok(file)
}

fn protect_open(options: &mut OpenOptions) {
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
}

fn private_options(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
        use windows_sys::Win32::Storage::FileSystem::WRITE_DAC;
        options.access_mode(GENERIC_READ | GENERIC_WRITE | WRITE_DAC);
    }
}

fn restrict(file: &File) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        plur1bus_rpc::win::restrict_to_user(file.as_raw_handle())?;
    }
    Ok(())
}

fn regular(file: File) -> io::Result<File> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular role file",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "role file is a reparse point",
            ));
        }
    }
    Ok(file)
}

/// Write a unique private stage, sync its data, then publish and persist the directory entry.
pub(super) fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(
        ".tmp-{}-{}",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let temporary = path.with_file_name(name);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    private_options(&mut options);
    let mut file = options.open(&temporary)?;
    let result = (|| {
        restrict(&file)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        rename_durable(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(unix)]
fn rename_durable(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::rename(from, to)?;
    let parent = to
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(windows)]
fn rename_durable(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let wide = |path: &Path| -> io::Result<Vec<u16>> {
        let mut units: Vec<_> = path.as_os_str().encode_wide().collect();
        if units.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "NUL in role path",
            ));
        }
        units.push(0);
        Ok(units)
    };
    // canonicalize supplies Windows verbatim paths, retaining std's support for long/UNC homes.
    let from = std::fs::canonicalize(from)?;
    let parent = to
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = to
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing role filename"))?;
    let to = std::fs::canonicalize(parent)?.join(name);
    let from = wide(&from)?;
    let to = wide(&to)?;
    // SAFETY: both owned UTF-16 buffers are NUL-terminated, contain no embedded NUL, and live through the call.
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
