//! Native attach reads exactly run/api.json, never the supervisor's token files.
use crate::{client::HarnessClient, connections::Origin};
use serde::Deserialize;
use std::{
    io::Read,
    path::{Path, PathBuf},
};
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Discovery {
    pub url: Origin,
    pub pid: u32,
    pub instance_id: String,
    pub installation_id: String,
    pub api_version: String,
    #[serde(skip)]
    pub current: bool,
}
pub fn state_root() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR") {
        return Some(PathBuf::from(dir).join("native"));
    }
    if let Some(dir) = std::env::var_os("PLUR1BUS_HOME") {
        return Some(dir.into());
    }
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(|v| PathBuf::from(v).join("PLUR1BUS"))
    } else {
        std::env::var_os("HOME").map(|v| PathBuf::from(v).join(".plur1bus"))
    }
}
pub fn discover(root: &Path, alive: impl Fn(u32) -> bool) -> Option<Discovery> {
    discover_with_opener(root, alive, std::fs::File::open)
}
pub fn discover_with_opener<R: Read>(
    root: &Path,
    alive: impl Fn(u32) -> bool,
    open: impl FnOnce(PathBuf) -> std::io::Result<R>,
) -> Option<Discovery> {
    let file = open(root.join("run/api.json")).ok()?;
    let mut bytes = Vec::new();
    file.take(8193).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 8192 {
        return None;
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct CurrentPublication {
        address: String,
        port: u16,
        version: String,
        fingerprint: Option<String>,
        pid: u32,
        instance_id: String,
    }
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Publication {
        Legacy(Discovery),
        Current(CurrentPublication),
    }
    let record = match serde_json::from_slice::<Publication>(&bytes).ok()? {
        Publication::Legacy(record) => record,
        Publication::Current(record) => {
            if record.address != "127.0.0.1" || record.port == 0 || record.fingerprint.is_some() {
                return None;
            }
            let url = Origin::parse(&format!("http://127.0.0.1:{}", record.port)).ok()?;
            Discovery {
                installation_id: crate::client::Meta::current_identity(&url),
                url,
                pid: record.pid,
                instance_id: record.instance_id,
                api_version: record.version,
                current: true,
            }
        }
    };
    if !record.url.is_loopback()
        || record.pid == 0
        || record.pid > i32::MAX as u32
        || !alive(record.pid)
        || record.instance_id.is_empty()
        || record.installation_id.is_empty()
        || record.api_version.split('.').next() != Some("1")
        || record.api_version.len() > 32
        || !record
            .api_version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    Some(record)
}
pub async fn reachable(record: &Discovery) -> bool {
    HarnessClient::new(record.url.clone(), None)
        .meta()
        .await
        .is_ok_and(|meta| {
            meta.installation_id == record.installation_id
                && (!record.current || meta.current_desktop())
        })
}
pub fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        if pid == 0 || pid > i32::MAX as u32 {
            return false;
        }
        (unsafe { libc::kill(pid as i32, 0) == 0 })
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                false
            } else {
                let mut code = 0;
                let running = GetExitCodeProcess(handle, &mut code) != 0 && code == 259;
                CloseHandle(handle);
                running
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}
