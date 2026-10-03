//! Per-window WebView2 user-data folders. Only this module may remove `spa-tmp` leaves.
#[cfg(windows)]
use std::path::{Path, PathBuf};

#[cfg(any(windows, test))]
const PREFIX: &str = "sp-";

#[cfg(any(windows, test))]
fn owned_leaf_name(name: &str) -> bool {
    name.len() == PREFIX.len() + 32
        && name.starts_with(PREFIX)
        && name[PREFIX.len()..].bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(windows)]
pub fn is_owned_profile_path(root: &Path, path: &Path) -> bool {
    path.parent() == Some(root)
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(owned_leaf_name)
}

#[cfg(windows)]
mod windows {
    use super::{owned_leaf_name, Path, PathBuf, PREFIX};
    use rand::{rngs::OsRng, TryRngCore};
    use std::{
        ffi::OsStr,
        fs::{self, File, OpenOptions},
        io,
        os::windows::{ffi::OsStrExt, fs::MetadataExt},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, LocalFree, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, WAIT_OBJECT_0,
            WAIT_TIMEOUT,
        },
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW,
                SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
            },
            GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, DACL_SECURITY_INFORMATION,
            OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY,
            TOKEN_USER,
        },
        Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT,
        System::Threading::{
            GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        },
    };

    pub struct BrowserProcess {
        handle: HANDLE,
        pid: u32,
        created: u64,
    }

    #[derive(Debug, Clone, Copy, Default)]
    pub struct CleanupResult {
        pub removed: bool,
        pub cookie_rows: u64,
        pub read_only_complete: bool,
        pub secret_detected: bool,
    }

    impl CleanupResult {
        pub fn accepted(&self) -> bool {
            self.removed
                && self.cookie_rows == 0
                && self.read_only_complete
                && !self.secret_detected
        }
    }

    pub type SecretAudit = Arc<dyn Fn(&Path) -> io::Result<bool> + Send + Sync>;

    unsafe impl Send for BrowserProcess {}

    impl Drop for BrowserProcess {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                unsafe { CloseHandle(self.handle) };
            }
        }
    }

    pub fn capture_browser_process(
        window: &tauri::WebviewWindow,
        profile: &SpaProfileLease,
    ) -> tokio::sync::oneshot::Receiver<io::Result<BrowserProcess>> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let record = profile.lock.try_clone();
        let submitted = window.with_webview(move |webview| {
            let result = (|| {
                let mut record = record?;
                let core = unsafe { webview.controller().CoreWebView2() }
                    .map_err(|_| io::Error::other("browser process unavailable"))?;
                let mut pid = 0;
                unsafe { core.BrowserProcessId(&mut pid) }
                    .map_err(|_| io::Error::other("browser process ID unavailable"))?;
                if pid == 0 {
                    return Err(io::Error::other("browser process ID missing"));
                }
                let handle = unsafe {
                    OpenProcess(
                        PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                        0,
                        pid,
                    )
                };
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let created = process_creation_time(handle);
                let created = match created {
                    Ok(value) => value,
                    Err(error) => {
                        unsafe { CloseHandle(handle) };
                        return Err(error);
                    }
                };
                let process = BrowserProcess {
                    handle,
                    pid,
                    created,
                };
                use std::io::{Seek, SeekFrom, Write};
                record.set_len(0)?;
                record.seek(SeekFrom::Start(0))?;
                record.write_all(&pid.to_le_bytes())?;
                record.write_all(&created.to_le_bytes())?;
                record.sync_all()?;
                Ok(process)
            })();
            let _ = sender.send(result);
        });
        if submitted.is_err() {
            // Dropping the callback sender closes the receiver and forbids cleanup.
        }
        receiver
    }

    /// Confirms WebView2 used the exact lease folder and its native ACL is private.
    pub async fn verify_webview_profile(
        window: &tauri::WebviewWindow,
        profile_path: &Path,
        deadline: std::time::Instant,
    ) -> (bool, bool) {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment7;
        use windows_core::{Interface, PWSTR};
        use windows_sys::Win32::System::Com::CoTaskMemFree;

        let acl = profile_acl_is_private(profile_path).unwrap_or(false);
        let expected = profile_path.to_path_buf();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        if window
            .with_webview(move |webview| {
                let matched = (|| {
                    let environment = webview
                        .environment()
                        .cast::<ICoreWebView2Environment7>()
                        .ok()?;
                    let mut raw = PWSTR::null();
                    unsafe { environment.UserDataFolder(&mut raw) }.ok()?;
                    if raw.is_null() {
                        return None;
                    }
                    let mut length = 0usize;
                    while length < 32767 && unsafe { *raw.0.add(length) } != 0 {
                        length += 1;
                    }
                    let folder =
                        String::from_utf16(unsafe { std::slice::from_raw_parts(raw.0, length) })
                            .ok();
                    unsafe { CoTaskMemFree(raw.0.cast()) };
                    let folder = PathBuf::from(folder?);
                    Some(fs::canonicalize(folder).ok()? == fs::canonicalize(expected).ok()?)
                })()
                .unwrap_or(false);
                let _ = sender.send(matched);
            })
            .is_err()
        {
            return (false, acl);
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let matched = tokio::time::timeout(remaining, receiver)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(false);
        (matched, acl)
    }

    pub async fn cleanup_after_exit(
        profile: SpaProfileLease,
        browser: Option<tokio::sync::oneshot::Receiver<io::Result<BrowserProcess>>>,
        gone: Arc<AtomicBool>,
        secret_audit: Option<SecretAudit>,
    ) -> CleanupResult {
        let Some(receiver) = browser else {
            return CleanupResult::default();
        };
        let Ok(Ok(process)) = receiver.await else {
            return CleanupResult::default();
        };
        while !gone.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        loop {
            match unsafe { WaitForSingleObject(process.handle, 0) } {
                WAIT_OBJECT_0 => break,
                WAIT_TIMEOUT => tokio::time::sleep(Duration::from_millis(25)).await,
                _ => return CleanupResult::default(),
            }
        }
        let Ok(audit) = inspect_cookie_databases(profile.path()) else {
            return CleanupResult::default();
        };
        let secret_detected = match secret_audit {
            Some(check) => match check(profile.path()) {
                Ok(found) => found,
                Err(_) => return CleanupResult::default(),
            },
            None => false,
        };
        CleanupResult {
            removed: profile.remove().is_ok(),
            cookie_rows: audit.rows,
            read_only_complete: true,
            secret_detected,
        }
    }

    fn process_creation_time(handle: HANDLE) -> io::Result<u64> {
        let mut created = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exited = created;
        let mut kernel = created;
        let mut user = created;
        if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    enum BrowserLeaseStatus {
        Exited,
        Active,
        Unknown,
    }

    fn recorded_browser_status(lock: &File) -> io::Result<BrowserLeaseStatus> {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = lock.try_clone()?;
        file.seek(SeekFrom::Start(0))?;
        let mut bytes = [0u8; 12];
        if file.read_exact(&mut bytes).is_err() || file.metadata()?.len() != 12 {
            return Ok(BrowserLeaseStatus::Unknown);
        }
        let pid = u32::from_le_bytes(bytes[..4].try_into().unwrap());
        let created = u64::from_le_bytes(bytes[4..].try_into().unwrap());
        if pid == 0 || created == 0 {
            return Ok(BrowserLeaseStatus::Unknown);
        }
        let handle = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return match io::Error::last_os_error().raw_os_error() {
                Some(code) if code == ERROR_INVALID_PARAMETER as i32 => {
                    Ok(BrowserLeaseStatus::Exited)
                }
                _ => Ok(BrowserLeaseStatus::Unknown),
            };
        }
        let result = process_creation_time(handle).map(|actual| {
            if actual != created {
                BrowserLeaseStatus::Exited
            } else {
                match unsafe { WaitForSingleObject(handle, 0) } {
                    WAIT_OBJECT_0 => BrowserLeaseStatus::Exited,
                    WAIT_TIMEOUT => BrowserLeaseStatus::Active,
                    _ => BrowserLeaseStatus::Unknown,
                }
            }
        });
        unsafe { CloseHandle(handle) };
        result
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct CookieAudit {
        pub database_files: u32,
        pub rows: u64,
    }

    pub fn inspect_cookie_databases(root: &Path) -> io::Result<CookieAudit> {
        ensure_no_reparse_tree(root)?;
        let mut result = CookieAudit {
            database_files: 0,
            rows: 0,
        };
        let mut pending = vec![root.to_path_buf()];
        let mut visited = 0usize;
        while let Some(dir) = pending.pop() {
            for entry in fs::read_dir(dir)? {
                visited += 1;
                if visited > 20_000 {
                    return Err(io::Error::other("cookie audit tree limit"));
                }
                let path = entry?.path();
                let metadata = check_no_reparse(&path)?;
                if metadata.is_dir() {
                    pending.push(path);
                } else if metadata.is_file() {
                    let name = path.file_name().and_then(OsStr::to_str).unwrap_or("");
                    let lower = name.to_ascii_lowercase();
                    if lower == "cookies" || lower.starts_with("cookies.sqlite") {
                        if lower.ends_with("-journal")
                            || lower.ends_with("-wal")
                            || lower.ends_with("-shm")
                        {
                            continue;
                        }
                        result.database_files = result.database_files.saturating_add(1);
                        result.rows = result
                            .rows
                            .checked_add(cookie_rows(&path)?)
                            .ok_or_else(|| io::Error::other("cookie row count overflow"))?;
                    }
                }
            }
        }
        Ok(result)
    }

    pub struct SpaProfileLease {
        root: PathBuf,
        leaf: PathBuf,
        lock: File,
    }

    #[derive(Debug, Clone, Copy, Default, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SweepResult {
        pub removed: u32,
        pub skipped_active: u32,
        pub skipped_unknown: u32,
    }

    impl SweepResult {
        pub fn complete(&self) -> bool {
            self.skipped_unknown == 0
        }
    }

    impl SpaProfileLease {
        pub fn path(&self) -> &Path {
            &self.leaf
        }

        /// Called only after the native callback, window absence, and browser exit succeeded.
        pub fn remove(self) -> io::Result<()> {
            let Self { root, leaf, lock } = self;
            validate_owned_path(&root, &leaf)?;
            ensure_no_reparse_tree(&leaf)?;
            // The lock file remains held until all browser data has been removed.
            for entry in fs::read_dir(&leaf)? {
                let entry = entry?;
                if entry.file_name() == OsStr::new(".lease") {
                    continue;
                }
                let path = entry.path();
                let metadata = check_no_reparse(&path)?;
                if metadata.is_dir() {
                    fs::remove_dir_all(path)?;
                } else {
                    fs::remove_file(path)?;
                }
            }
            fs::remove_file(leaf.join(".lease"))?;
            drop(lock);
            fs::remove_dir(leaf)
        }
    }

    pub fn root_for_app(app: &tauri::AppHandle) -> io::Result<PathBuf> {
        let _ = app;
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::other("LOCALAPPDATA unavailable"))?;
        if !base.is_absolute()
            || base.components().any(|part| {
                matches!(
                    part,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            return Err(io::Error::other(
                "LOCALAPPDATA is not an absolute canonical path",
            ));
        }
        check_ancestors(&base)?;
        Ok(base.join("app.plur1bus.desktop").join("spa-tmp"))
    }

    pub fn create(app: &tauri::AppHandle) -> io::Result<SpaProfileLease> {
        let root = root_for_app(app)?;
        create_in(&root)
    }

    /// Startup only. Never descends into an unknown child or a reparse point.
    pub fn sweep(app: &tauri::AppHandle) -> io::Result<SweepResult> {
        let root = root_for_app(app)?;
        sweep_in(&root)
    }

    fn create_in(root: &Path) -> io::Result<SpaProfileLease> {
        ensure_root(root)?;
        for _ in 0..8 {
            let mut random = [0u8; 16];
            OsRng
                .try_fill_bytes(&mut random)
                .map_err(|_| io::Error::other("SPA profile random source failed"))?;
            let name = format!("{PREFIX}{}", hex(&random));
            let leaf = root.join(name);
            match fs::create_dir(&leaf) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
            if let Err(error) = set_private_acl(&leaf).and_then(|_| {
                if profile_acl_is_private(&leaf)? {
                    Ok(())
                } else {
                    Err(io::Error::other("SPA profile ACL failed verification"))
                }
            }) {
                let _ = fs::remove_dir(&leaf);
                return Err(error);
            }
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(leaf.join(".lease"))?;
            lock.try_lock()?;
            return Ok(SpaProfileLease {
                root: root.to_path_buf(),
                leaf,
                lock,
            });
        }
        Err(io::Error::other("SPA profile allocation exhausted"))
    }

    fn sweep_in(root: &Path) -> io::Result<SweepResult> {
        match fs::symlink_metadata(root) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(SweepResult::default());
            }
            Err(error) => return Err(error),
            Ok(_) => {}
        }
        ensure_root(root)?;
        let mut result = SweepResult::default();
        for (index, entry) in fs::read_dir(root)?.enumerate() {
            if index >= 128 {
                return Err(io::Error::other("SPA profile sweep limit"));
            }
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !owned_leaf_name(name) {
                continue;
            }
            let path = entry.path();
            if check_no_reparse(&path)?.is_dir() {
                if !profile_acl_is_private(&path)? {
                    result.skipped_unknown += 1;
                    continue;
                }
                let lock_path = path.join(".lease");
                let Ok(lock) = OpenOptions::new().read(true).write(true).open(&lock_path) else {
                    result.skipped_unknown += 1;
                    continue;
                };
                if lock.try_lock().is_err() {
                    result.skipped_active += 1;
                    continue;
                }
                match recorded_browser_status(&lock)? {
                    BrowserLeaseStatus::Exited => {}
                    BrowserLeaseStatus::Active => {
                        result.skipped_active += 1;
                        continue;
                    }
                    BrowserLeaseStatus::Unknown => {
                        result.skipped_unknown += 1;
                        continue;
                    }
                }
                let lease = SpaProfileLease {
                    root: root.to_path_buf(),
                    leaf: path,
                    lock,
                };
                if inspect_cookie_databases(lease.path())?.rows == 0 {
                    lease.remove()?;
                    result.removed += 1;
                } else {
                    result.skipped_unknown += 1;
                }
            }
        }
        Ok(result)
    }

    fn ensure_root(root: &Path) -> io::Result<()> {
        let parent = root
            .parent()
            .ok_or_else(|| io::Error::other("invalid SPA root"))?;
        fs::create_dir_all(parent)?;
        check_ancestors(parent)?;
        match fs::create_dir(root) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        if !check_no_reparse(root)?.is_dir() {
            return Err(io::Error::other("SPA root is not a directory"));
        }
        set_private_acl(root)?;
        if !profile_acl_is_private(root)? {
            return Err(io::Error::other("SPA root ACL failed verification"));
        }
        Ok(())
    }

    fn validate_owned_path(root: &Path, leaf: &Path) -> io::Result<()> {
        if leaf.parent() != Some(root)
            || !leaf
                .file_name()
                .and_then(OsStr::to_str)
                .is_some_and(owned_leaf_name)
        {
            return Err(io::Error::other("SPA profile outside owned root"));
        }
        check_ancestors(root)?;
        check_no_reparse(leaf)?;
        if !profile_acl_is_private(root)? || !profile_acl_is_private(leaf)? {
            return Err(io::Error::other("SPA profile ACL changed"));
        }
        Ok(())
    }

    fn check_no_reparse(path: &Path) -> io::Result<fs::Metadata> {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::other("SPA profile reparse point"));
        }
        Ok(metadata)
    }

    fn check_ancestors(path: &Path) -> io::Result<()> {
        let mut current = Some(path);
        while let Some(item) = current {
            check_no_reparse(item)?;
            current = item.parent();
        }
        Ok(())
    }

    fn ensure_no_reparse_tree(root: &Path) -> io::Result<()> {
        let mut pending = vec![root.to_path_buf()];
        let mut visited = 0usize;
        while let Some(dir) = pending.pop() {
            if !check_no_reparse(&dir)?.is_dir() {
                return Err(io::Error::other("SPA profile tree changed"));
            }
            for entry in fs::read_dir(dir)? {
                visited += 1;
                if visited > 20_000 {
                    return Err(io::Error::other("SPA profile tree limit"));
                }
                let path = entry?.path();
                if check_no_reparse(&path)?.is_dir() {
                    pending.push(path);
                }
            }
        }
        Ok(())
    }

    fn hex(bytes: &[u8]) -> String {
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        let mut result = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            result.push(DIGITS[(byte >> 4) as usize] as char);
            result.push(DIGITS[(byte & 15) as usize] as char);
        }
        result
    }

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }

    fn set_private_acl(path: &Path) -> io::Result<()> {
        use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
        let mut token: HANDLE = std::ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let result = (|| {
            let mut size = 0u32;
            unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size) };
            if size < std::mem::size_of::<TOKEN_USER>() as u32 || size > 4096 {
                return Err(io::Error::other("invalid user token"));
            }
            let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
            if unsafe {
                GetTokenInformation(
                    token,
                    TokenUser,
                    buffer.as_mut_ptr().cast(),
                    size,
                    &mut size,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            let sid = unsafe { (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid };
            let mut sid_string = std::ptr::null_mut();
            if unsafe { ConvertSidToStringSidW(sid, &mut sid_string) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut len = 0usize;
            while unsafe { *sid_string.add(len) } != 0 && len < 256 {
                len += 1;
            }
            let sid_text =
                String::from_utf16(&unsafe { std::slice::from_raw_parts(sid_string, len) })
                    .map_err(|_| io::Error::other("invalid user SID"));
            unsafe { LocalFree(sid_string.cast()) };
            let sddl = format!("D:P(A;OICI;FA;;;{})(A;OICI;FA;;;SY)", sid_text?);
            let mut descriptor = std::ptr::null_mut();
            if unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide(OsStr::new(&sddl)).as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            let applied = (|| {
                let mut present = 0;
                let mut defaulted = 0;
                let mut dacl = std::ptr::null_mut();
                if unsafe {
                    GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
                } == 0
                    || present == 0
                    || dacl.is_null()
                {
                    return Err(io::Error::other("invalid SPA DACL"));
                }
                let path = wide(path.as_os_str());
                let code = unsafe {
                    SetNamedSecurityInfoW(
                        path.as_ptr() as *mut u16,
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        dacl,
                        std::ptr::null_mut(),
                    )
                };
                if code != 0 {
                    return Err(io::Error::from_raw_os_error(code as i32));
                }
                Ok(())
            })();
            unsafe { LocalFree(descriptor.cast()) };
            applied
        })();
        unsafe { CloseHandle(token) };
        result
    }

    /// A read-only SQLite connection observes the real live cookie table.
    pub fn cookie_rows(path: &Path) -> io::Result<u64> {
        use rusqlite::{Connection, DatabaseName, OpenFlags};
        check_no_reparse(path)?;
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| io::Error::other("cookie database read-only open failed"))?;
        if !connection.is_readonly(DatabaseName::Main).unwrap_or(false) {
            return Err(io::Error::other("cookie database writable connection"));
        }
        connection
            .busy_timeout(Duration::from_millis(100))
            .map_err(|_| io::Error::other("cookie database timeout setup failed"))?;
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM cookies", [], |row| row.get(0))
            .map_err(|_| io::Error::other("cookie database query failed"))?;
        u64::try_from(count).map_err(|_| io::Error::other("invalid cookie row count"))
    }

    pub fn profile_acl_is_private(path: &Path) -> io::Result<bool> {
        use windows_sys::Win32::Security::{
            CreateWellKnownSid, EqualSid, GetAce, GetSecurityDescriptorControl, WinLocalSystemSid,
            ACCESS_ALLOWED_ACE, SE_DACL_PROTECTED,
        };
        check_no_reparse(path)?;
        let mut owner = std::ptr::null_mut();
        let mut dacl = std::ptr::null_mut();
        let mut descriptor = std::ptr::null_mut();
        let code = unsafe {
            GetNamedSecurityInfoW(
                wide(path.as_os_str()).as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if code != 0 {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        let result = (|| {
            if owner.is_null() || dacl.is_null() || unsafe { (*dacl).AceCount } != 2 {
                return Ok(false);
            }
            let mut control = 0;
            let mut revision = 0;
            if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
                || control & SE_DACL_PROTECTED == 0
            {
                return Ok(false);
            }
            let mut token = std::ptr::null_mut();
            if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let check = (|| {
                let mut size = 0;
                unsafe {
                    GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size)
                };
                if size < std::mem::size_of::<TOKEN_USER>() as u32 || size > 4096 {
                    return Ok(false);
                }
                let mut buffer =
                    vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
                if unsafe {
                    GetTokenInformation(
                        token,
                        TokenUser,
                        buffer.as_mut_ptr().cast(),
                        size,
                        &mut size,
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error());
                }
                let user = unsafe { (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid };
                if unsafe { EqualSid(owner, user) } == 0 {
                    return Ok(false);
                }
                let mut user_ace = false;
                let mut system_ace = false;
                let mut system_sid = [0u8; 68];
                let mut system_sid_len = system_sid.len() as u32;
                if unsafe {
                    CreateWellKnownSid(
                        WinLocalSystemSid,
                        std::ptr::null_mut(),
                        system_sid.as_mut_ptr().cast(),
                        &mut system_sid_len,
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error());
                }
                for index in 0..2 {
                    let mut raw = std::ptr::null_mut();
                    if unsafe { GetAce(dacl, index, &mut raw) } == 0 {
                        return Err(io::Error::last_os_error());
                    }
                    let ace = unsafe { &*(raw.cast::<ACCESS_ALLOWED_ACE>()) };
                    if ace.Header.AceType != 0 || ace.Header.AceFlags != 3 || ace.Mask != 0x001f01ff
                    {
                        return Ok(false);
                    }
                    let ace_sid = std::ptr::addr_of!(ace.SidStart).cast_mut().cast();
                    if unsafe { EqualSid(ace_sid, user) } != 0 {
                        user_ace = true;
                    } else if unsafe { EqualSid(ace_sid, system_sid.as_mut_ptr().cast()) } != 0 {
                        system_ace = true;
                    } else {
                        return Ok(false);
                    }
                }
                Ok(user_ace && system_ace)
            })();
            unsafe { CloseHandle(token) };
            check
        })();
        unsafe { LocalFree(descriptor.cast()) };
        result
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn record(profile: &SpaProfileLease, pid: u32, created: u64) {
            use std::io::{Seek, SeekFrom, Write};
            let mut file = profile.lock.try_clone().unwrap();
            file.set_len(0).unwrap();
            file.seek(SeekFrom::Start(0)).unwrap();
            file.write_all(&pid.to_le_bytes()).unwrap();
            file.write_all(&created.to_le_bytes()).unwrap();
            file.sync_all().unwrap();
        }

        fn record_exited_browser(profile: &SpaProfileLease) {
            let mut child = std::process::Command::new("cmd")
                .args(["/C", "ping -n 2 127.0.0.1 >nul"])
                .spawn()
                .unwrap();
            let process = unsafe {
                OpenProcess(
                    PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                    0,
                    child.id(),
                )
            };
            assert!(!process.is_null());
            record(profile, child.id(), process_creation_time(process).unwrap());
            child.wait().unwrap();
            unsafe { CloseHandle(process) };
        }

        #[test]
        fn no_cookie_database_in_app_dirs() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("spa-tmp");
            let profile = create_in(&root).unwrap();
            assert!(profile_acl_is_private(profile.path()).unwrap());
            let database = profile.path().join("Cookies");
            let connection = rusqlite::Connection::open(&database).unwrap();
            connection
                .pragma_update(None, "journal_mode", "WAL")
                .unwrap();
            connection
                .execute("CREATE TABLE cookies (value TEXT)", [])
                .unwrap();
            assert_eq!(cookie_rows(&database).unwrap(), 0);
            connection
                .execute("INSERT INTO cookies VALUES ('x')", [])
                .unwrap();
            assert!(profile.path().join("Cookies-wal").exists());
            assert_eq!(cookie_rows(&database).unwrap(), 1);
            drop(connection);
            profile.remove().unwrap();
            assert!(!database.exists());
        }

        #[test]
        fn startup_sweep_preserves_active_unknown_and_siblings() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("spa-tmp");
            let sibling = root.join("shell");
            fs::create_dir_all(&sibling).unwrap();
            fs::write(sibling.join("Cookies"), b"sentinel").unwrap();
            let active = create_in(&root).unwrap();
            let active_path = active.path().to_path_buf();
            assert_eq!(sweep_in(&root).unwrap().skipped_active, 1);
            let process = unsafe {
                OpenProcess(
                    PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                    0,
                    std::process::id(),
                )
            };
            assert!(!process.is_null());
            record(
                &active,
                std::process::id(),
                process_creation_time(process).unwrap(),
            );
            unsafe { CloseHandle(process) };
            drop(active);
            assert_eq!(sweep_in(&root).unwrap().skipped_active, 1);
            assert!(active_path.exists());
            assert!(sibling.join("Cookies").exists());
            let unknown = create_in(&root).unwrap();
            let unknown_path = unknown.path().to_path_buf();
            drop(unknown);
            assert_eq!(sweep_in(&root).unwrap().skipped_unknown, 1);
            assert!(unknown_path.exists());
        }

        #[test]
        fn startup_sweep_removes_only_proven_exited_leaf() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("spa-tmp");
            let profile = create_in(&root).unwrap();
            let path = profile.path().to_path_buf();
            record_exited_browser(&profile);
            drop(profile);
            let sweep = sweep_in(&root).unwrap();
            assert_eq!(sweep.removed, 1);
            assert!(!path.exists());
        }

        #[test]
        fn startup_sweep_retains_row_positive_profile_as_failure() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("spa-tmp");
            let profile = create_in(&root).unwrap();
            let path = profile.path().to_path_buf();
            let database = path.join("Cookies");
            let connection = rusqlite::Connection::open(&database).unwrap();
            connection
                .execute("CREATE TABLE cookies (value TEXT)", [])
                .unwrap();
            connection
                .execute("INSERT INTO cookies VALUES ('x')", [])
                .unwrap();
            drop(connection);
            record_exited_browser(&profile);
            drop(profile);
            let sweep = sweep_in(&root).unwrap();
            assert_eq!(sweep.skipped_unknown, 1);
            assert_eq!(sweep.removed, 0);
            assert!(path.exists());
        }
    }
}

#[cfg(windows)]
pub use windows::*;

#[cfg(test)]
mod tests {
    use super::owned_leaf_name;

    #[test]
    fn only_random_leaves_are_sweep_candidates() {
        assert!(owned_leaf_name("sp-0123456789abcdef0123456789abcdef"));
        for name in [
            "shell",
            "sp-0123",
            "sp-0123456789abcdef0123456789abcdef/other",
            "sp-0123456789abcdef0123456789abcdez",
        ] {
            assert!(!owned_leaf_name(name));
        }
    }
}
