//! OS-selected package paths and file reads stay in Rust; renderer requests contain offer ids only.
use std::{fs::OpenOptions, io::Read, path::Path};
use tauri::Manager;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadRequest {
    pub link_id: u64,
    pub connection_id: uuid::Uuid,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub inspection_id: String,
    pub origin: String,
}

/// The shell chooses a stored connection; Rust re-runs its transport gate and uses its native device credential.
#[tauri::command]
pub async fn extension_upload(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::commands::ConnectionState>,
    transports: tauri::State<'_, crate::transport::Transports>,
    request: UploadRequest,
) -> Result<UploadResult, String> {
    crate::commands::check(&window, "extension_upload")?;
    let app = window.app_handle().clone();
    let path = app
        .state::<crate::deeplink::LinkState>()
        .0
        .lock()
        .unwrap()
        .confirm_p1x(request.link_id)
        .ok_or("invalid")?;
    let bytes = tokio::task::spawn_blocking(move || read_package(&path, 256 * 1024 * 1024))
        .await
        .map_err(|_| "unsafe-file")?
        .map_err(str::to_owned)?;
    let owner = state.inner().clone();
    crate::commands::open_connection(
        window,
        state,
        transports,
        crate::commands::ConnectionIdRequest {
            id: request.connection_id,
        },
    )
    .await?;
    let (row, client) = app
        .state::<crate::spa::SpaState>()
        .upload_connection(request.connection_id)?;
    let origin = row.origin.as_str().to_owned();
    let inspection_id = crate::commands::credential_action(&owner, move |tokens, runtime| {
        let tokens = tokens.get_or_insert_with(crate::secrets::open_default);
        let token =
            crate::pair::connection_token(&row, tokens.as_ref()).map_err(|e| e.public_message())?;
        runtime
            .block_on(client.upload_extension(&token, bytes))
            .map_err(|e| crate::pair::PairError::Client(e).public_message())
    })
    .await?;
    crate::spa::navigate_inspection(&app, request.connection_id, &inspection_id)?;
    app.state::<crate::deeplink::LinkState>()
        .0
        .lock()
        .unwrap()
        .finish_pair(request.link_id);
    Ok(UploadResult {
        inspection_id,
        origin,
    })
}

/// Read a regular package with a strict cap. Never follow leaf or ancestor symlinks/junctions.
pub fn read_package(path: &Path, max: u64) -> Result<Vec<u8>, &'static str> {
    if !path.is_absolute()
        || max == 0
        || max.checked_add(1).is_none()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err("unsafe-file");
    }
    #[cfg(windows)]
    let mut parents = Vec::new();
    // Root first: a pinned Windows ancestor cannot be replaced before its child is pinned.
    for component in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        let meta = std::fs::symlink_metadata(component).map_err(|_| "unsafe-file")?;
        if meta.file_type().is_symlink() {
            return Err("unsafe-file");
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err("unsafe-file");
            }
            if component != path {
                use std::os::windows::fs::OpenOptionsExt;
                // Pin each directory against rename/deletion while the selected file is read.
                let mut options = OpenOptions::new();
                options
                    .access_mode(0x80)
                    .share_mode(0x3)
                    .custom_flags(0x0200_0000 | 0x0020_0000);
                let held = options.open(component).map_err(|_| "unsafe-file")?;
                let held_metadata = held.metadata().map_err(|_| "unsafe-file")?;
                if !held_metadata.is_dir() || held_metadata.file_attributes() & 0x400 != 0 {
                    return Err("unsafe-file");
                }
                parents.push(held);
            }
        }
    }
    let before = std::fs::symlink_metadata(path).map_err(|_| "unsafe-file")?;
    if !before.is_file() {
        return Err("unsafe-file");
    }
    if before.len() > max {
        return Err("too-large");
    }
    #[cfg(unix)]
    let file = open_regular_no_follow(path)?;
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        let mut options = OpenOptions::new();
        options.read(true).share_mode(0x1).custom_flags(0x0020_0000);
        options.open(path).map_err(|_| "unsafe-file")?
    };
    let after = file.metadata().map_err(|_| "unsafe-file")?;
    if !after.is_file() {
        return Err("unsafe-file");
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if after.file_attributes() & 0x400 != 0 {
            return Err("unsafe-file");
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev() || before.ino() != after.ino() {
            return Err("unsafe-file");
        }
    }
    let mut bytes = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "unsafe-file")?;
    if bytes.len() as u64 > max {
        return Err("too-large");
    }
    Ok(bytes)
}

#[cfg(unix)]
fn open_regular_no_follow(path: &Path) -> Result<std::fs::File, &'static str> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::OpenOptionsExt},
        },
    };
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let mut parent = options.open("/").map_err(|_| "unsafe-file")?;
    let mut components = path
        .components()
        .filter_map(|part| {
            if let std::path::Component::Normal(name) = part {
                Some(name)
            } else {
                None
            }
        })
        .peekable();
    while let Some(component) = components.next() {
        let name = CString::new(component.as_bytes()).map_err(|_| "unsafe-file")?;
        let directory = components.peek().is_some();
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK
            | if directory { libc::O_DIRECTORY } else { 0 };
        // SAFETY: a live pinned parent fd, a single NUL-free component and no-follow flags.
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err("unsafe-file");
        }
        // SAFETY: openat returned a new owned descriptor.
        let child = unsafe { std::fs::File::from_raw_fd(fd) };
        if !directory {
            return Ok(child);
        }
        parent = child;
    }
    Err("unsafe-file")
}
