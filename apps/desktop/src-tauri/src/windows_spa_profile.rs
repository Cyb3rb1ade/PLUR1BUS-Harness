//! Per-window WebView2 user-data folders. Only this module may remove `spa-tmp` leaves.
/// Closed query diagnostics: never include paths, SQL, SQLite messages or database contents.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CookieQueryStage {
    #[default]
    None,
    PathValidation,
    Open,
    ReadOnlyCheck,
    BusyTimeout,
    Prepare,
    Step,
    Decode,
}

/// Closed, safe cookie-query error categories without paths, SQL, raw messages or contents.
/// `None` means no recorded failure; it does not independently prove a successful query.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CookieQueryResult {
    #[default]
    None,
    PathRejected,
    Writable,
    Busy,
    Locked,
    ReadOnly,
    ReadOnlyRecovery,
    ReadOnlyCantLock,
    ReadOnlyCantInit,
    CannotOpen,
    // These describe a subsequent native read-open probe, not SQLite's saved OS error.
    CannotOpenNativeSharingViolation,
    CannotOpenNativeAccessDenied,
    CannotOpenNativePathMissing,
    CannotOpenNativeOpenable,
    Corrupt,
    NotDatabase,
    Io,
    IoShmOpen,
    IoShmSize,
    IoShmLock,
    IoShmMap,
    Permission,
    SchemaChanged,
    SqliteError,
    SqliteOther,
    MissingRow,
    InvalidCount,
    Other,
}

/// Records a query failure using only closed, safe stage and error categories.
/// The `None`/`None` pair means no recorded failure, not independent proof of query success.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CookieQueryDiagnostic {
    /// Query stage that failed, or `None` when no failure is recorded.
    pub stage: CookieQueryStage,
    /// Safe error category, or `None` when no failure is recorded.
    pub result: CookieQueryResult,
}

impl std::fmt::Display for CookieQueryDiagnostic {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "cookie query {:?}/{:?}", self.stage, self.result)
    }
}

impl std::error::Error for CookieQueryDiagnostic {}

#[derive(Debug, Clone, Default)]
/// Closed cleanup evidence; a removed directory does not erase row or secret failures.
pub struct CleanupResult {
    pub removed: bool,
    pub cookie_rows: u64,
    pub read_only_complete: bool,
    pub secret_detected: bool,
    /// Per-owned-profile evidence, retained across aggregate cancellation.
    pub audits: Vec<ProfileCleanupEvidence>,
}

/// Production quit remains successful; audit/deletion failures are reported separately.
pub fn cleanup_exit_code(_outcome: &CleanupResult) -> i32 {
    0
}

impl CleanupResult {
    #[cfg(debug_assertions)]
    pub fn accepted(&self) -> bool {
        self.removed && self.cookie_rows == 0 && self.read_only_complete && !self.secret_detected
    }

    #[cfg(not(debug_assertions))]
    pub fn accepted(&self) -> bool {
        self.removed
    }

    /// Stable, path-free reason code for release shutdown logging.
    pub fn reason_code(&self) -> &'static str {
        if self
            .audits
            .iter()
            .any(|audit| audit.exit_timed_out || audit.audit_timed_out)
        {
            "SPA_PROFILE_CLEANUP_TIMEOUT"
        } else if self.audits.iter().any(|audit| {
            audit.environment_exited
                && (!audit.read_only_complete || audit.cookie_rows > 0 || audit.secret_detected)
        }) {
            "SPA_PROFILE_CLEANUP_COOKIE_AUDIT_FAILED"
        } else if self.removed {
            "SPA_PROFILE_CLEANUP_OK"
        } else {
            "SPA_PROFILE_CLEANUP_DELETE_FAILED"
        }
    }
}

/// A byte scan's completeness and positive evidence are independent.
#[derive(Debug, Clone, Copy, Default)]
pub struct SecretScanOutcome {
    /// Every required file was read successfully.
    pub complete: bool,
    /// A known secret was found, even if a later read failed.
    pub secret_detected: bool,
}
impl SecretScanOutcome {
    /// Publish positives before deciding whether the subsequent SQL audit may run.
    pub fn record_into(self, evidence: &mut ProfileCleanupEvidence) -> bool {
        evidence.secret_detected |= self.secret_detected;
        evidence.secret_scan_complete = self.complete;
        self.complete
    }
}

/// Closed evidence for the owner-approved Windows post-exit audit, never paths or values.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProfileCleanupEvidence {
    /// Actual environment BrowserProcessExited event and retained identity handle signalled.
    pub environment_exited: bool,
    /// Actual monotonic time from close request to exit outcome; values above 10s fail.
    pub exit_wait_ms: u64,
    /// The absolute exit deadline expired; no database read or deletion followed.
    pub exit_timed_out: bool,
    /// The bounded post-exit audit exhausted its own byte/time budget.
    pub audit_timed_out: bool,
    /// Real READ_ONLY SQLite query (with WAL), after verified exit.
    pub read_only_complete: bool,
    /// Rows counted across all primary cookie databases.
    pub cookie_rows: u64,
    /// Number of primary cookie databases queried.
    pub cookie_database_files: u32,
    /// Number of cookie side files byte-scanned before deletion.
    pub cookie_sidecar_files: u32,
    /// All profile files including Cookies, -wal and -journal scanned successfully.
    pub secret_scan_complete: bool,
    /// Any planted value found; a positive retains the profile.
    pub secret_detected: bool,
    /// Owned deletion completed after successful checks and absence was confirmed.
    pub removed: bool,
}
impl ProfileCleanupEvidence {
    /// Requires actual exit within budget, both complete clean audits, and owned removal.
    pub fn accepted(&self) -> bool {
        self.environment_exited
            && self.exit_wait_ms <= 10_000
            && !self.exit_timed_out
            && self.read_only_complete
            && self.cookie_rows == 0
            && self.cookie_database_files > 0
            && self.secret_scan_complete
            && !self.secret_detected
            && self.removed
    }
}

#[cfg(any(windows, test))]
pub(crate) async fn finish_owned_cleanup_async_with_mode<Exit, Audit, AuditFuture, Remove>(
    started: std::time::Instant,
    deadline: std::time::Instant,
    exit: Exit,
    audit: Audit,
    remove: Remove,
    delete_on_audit_failure: bool,
) -> CleanupResult
where
    Exit: Fn() -> Option<bool>,
    Audit: FnOnce() -> AuditFuture,
    AuditFuture: std::future::Future<Output = ProfileCleanupEvidence>,
    Remove: FnOnce() -> bool,
{
    let deadline = deadline.min(started + std::time::Duration::from_secs(10));
    let mut evidence = ProfileCleanupEvidence::default();
    loop {
        if std::time::Instant::now() >= deadline {
            evidence.exit_timed_out = true;
            break;
        }
        match exit() {
            Some(true) => {
                evidence.environment_exited = true;
                break;
            }
            Some(false) => tokio::time::sleep(std::time::Duration::from_millis(10)).await,
            None => break,
        }
    }
    evidence.exit_wait_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    evidence.exit_timed_out |= std::time::Instant::now() >= deadline;
    if evidence.environment_exited && !evidence.exit_timed_out && evidence.exit_wait_ms <= 10_000 {
        let audited = audit().await;
        evidence.read_only_complete = audited.read_only_complete;
        evidence.cookie_rows = audited.cookie_rows;
        evidence.cookie_database_files = audited.cookie_database_files;
        evidence.cookie_sidecar_files = audited.cookie_sidecar_files;
        evidence.secret_scan_complete = audited.secret_scan_complete;
        evidence.secret_detected = audited.secret_detected;
        evidence.audit_timed_out = audited.audit_timed_out;
        let audit_ok = evidence.read_only_complete
            && evidence.cookie_database_files > 0
            && evidence.secret_scan_complete
            && evidence.cookie_rows == 0
            && !evidence.secret_detected;
        evidence.removed = (delete_on_audit_failure || audit_ok) && remove();
    }
    CleanupResult {
        removed: evidence.removed,
        cookie_rows: evidence.cookie_rows,
        read_only_complete: evidence.read_only_complete,
        secret_detected: evidence.secret_detected,
        audits: vec![evidence],
    }
}

#[cfg(any(windows, test))]
#[allow(dead_code)]
pub(crate) async fn finish_owned_cleanup_with_mode(
    started: std::time::Instant,
    deadline: std::time::Instant,
    exit: impl Fn() -> Option<bool>,
    audit: impl FnOnce(&mut ProfileCleanupEvidence),
    remove: impl FnOnce() -> bool,
    delete_on_audit_failure: bool,
) -> CleanupResult {
    finish_owned_cleanup_async_with_mode(
        started,
        deadline,
        exit,
        || {
            let mut evidence = ProfileCleanupEvidence::default();
            audit(&mut evidence);
            std::future::ready(evidence)
        },
        remove,
        delete_on_audit_failure,
    )
    .await
}

#[cfg(any(windows, test))]
#[allow(dead_code)]
pub(crate) async fn finish_owned_cleanup(
    started: std::time::Instant,
    deadline: std::time::Instant,
    exit: impl Fn() -> Option<bool>,
    audit: impl FnOnce(&mut ProfileCleanupEvidence),
    remove: impl FnOnce() -> bool,
) -> CleanupResult {
    finish_owned_cleanup_with_mode(
        started,
        deadline,
        exit,
        audit,
        remove,
        cfg!(not(debug_assertions)),
    )
    .await
}

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

#[cfg(any(windows, test))]
fn known_browser_lock_name(name: &std::ffi::OsStr) -> bool {
    name == std::ffi::OsStr::new("LOCK")
}

#[cfg(windows)]
/// Returns true only for an immediate, random-named leaf of the owned SPA root.
pub fn is_owned_profile_path(root: &Path, path: &Path) -> bool {
    path.parent() == Some(root)
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(owned_leaf_name)
}

#[cfg(windows)]
mod windows {
    use super::{
        known_browser_lock_name, owned_leaf_name, CleanupResult, CookieQueryDiagnostic,
        CookieQueryResult, CookieQueryStage, Path, PathBuf, PREFIX,
    };
    use rand::{rngs::OsRng, TryRngCore};
    use std::{
        collections::HashMap,
        ffi::OsStr,
        fs::{self, File, OpenOptions},
        io,
        os::windows::{ffi::OsStrExt, fs::MetadataExt},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex, OnceLock, Weak,
        },
        time::Duration,
    };
    use tauri::Manager;
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, LocalFree, ERROR_INVALID_PARAMETER, FILETIME, HANDLE,
            INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
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
        Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            OPEN_EXISTING,
        },
        System::Threading::{
            GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        },
    };

    /// Retained native browser handle; dropping it does not itself authorize profile deletion.
    pub struct BrowserProcess {
        handle: HANDLE,
        environment_exited: Arc<AtomicBool>,
        registration: Option<(tauri::AppHandle, u32, u64)>,
    }

    // COM environment references remain on the WebView2 UI apartment through the event.
    // BrowserProcess only carries a Send signal and schedules registration disposal there.
    type EnvironmentRegistration = (
        webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment5,
        i64,
    );
    thread_local! {
        static ENVIRONMENTS: std::cell::RefCell<HashMap<(u32, u64), EnvironmentRegistration>>
            = std::cell::RefCell::new(HashMap::new());
    }

    /// Debug fixture hook that independently reports byte-scan completeness and positives.
    pub type SecretAudit = Arc<dyn Fn(&Path) -> super::SecretScanOutcome + Send + Sync>;

    type SharedLeaseFile = Arc<Mutex<File>>;
    static LIVE_LEASES: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<File>>>>> = OnceLock::new();

    fn live_leases() -> &'static Mutex<HashMap<PathBuf, Weak<Mutex<File>>>> {
        LIVE_LEASES.get_or_init(|| Mutex::new(HashMap::new()))
    }

    struct LeaseLock {
        path: PathBuf,
        file: SharedLeaseFile,
    }

    impl LeaseLock {
        fn new(path: PathBuf, file: File) -> Self {
            let file = Arc::new(Mutex::new(file));
            live_leases()
                .lock()
                .unwrap()
                .insert(path.clone(), Arc::downgrade(&file));
            Self { path, file }
        }
    }

    impl Drop for LeaseLock {
        fn drop(&mut self) {
            live_leases().lock().unwrap().remove(&self.path);
        }
    }

    /// Reads only the exact active lease record through its retained locked file object.
    /// Unknown paths fall back to ordinary file reads, which fail closed on other owners' locks.
    pub fn read_owned_lease(path: &Path) -> io::Result<Option<Vec<u8>>> {
        let registry = live_leases().lock().unwrap();
        let file = registry.get(path).and_then(Weak::upgrade);
        let Some(file) = file else { return Ok(None) };
        let mut guard = file.lock().unwrap();
        read_complete_lease_record(&mut guard).map(Some)
    }

    fn read_complete_lease_record(file: &mut File) -> io::Result<Vec<u8>> {
        use std::io::{Read, Seek, SeekFrom};
        file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        file.take(13).read_to_end(&mut bytes)?;
        if bytes.len() != 12
            || u32::from_le_bytes(bytes[..4].try_into().unwrap()) == 0
            || u64::from_le_bytes(bytes[4..].try_into().unwrap()) == 0
        {
            return Err(io::Error::other("incomplete SPA lease record"));
        }
        Ok(bytes)
    }

    fn audit_deadline(deadline: Option<std::time::Instant>) -> io::Result<()> {
        crate::profile_audit::check_deadline(deadline, &std::time::Instant::now)
    }
    fn read_file_bounded(
        path: &Path,
        deadline: Option<std::time::Instant>,
        remaining: &mut u64,
    ) -> io::Result<()> {
        crate::profile_audit::read_file_bounded(path, deadline, remaining, &std::time::Instant::now)
    }
    fn audit_profile_readability(root: &Path, deadline: std::time::Instant) -> io::Result<()> {
        crate::profile_audit::audit_profile_readability(
            root,
            deadline,
            crate::profile_audit::MAX_BYTES,
            &std::time::Instant::now,
            check_no_reparse,
            |file| {
                if file.file_name() == Some(OsStr::new(".lease")) {
                    read_owned_lease(file)?.ok_or_else(|| {
                        io::Error::new(io::ErrorKind::PermissionDenied, "lease unavailable")
                    })?;
                    Ok(true)
                } else {
                    Ok(false)
                }
            },
        )
    }

    /// A sharing-locked exact LevelDB LOCK file has no payload only when its
    /// current owned profile and handle-based regular-file metadata prove size zero.
    /// The caller must first attempt an ordinary read and see a sharing violation.
    pub fn prove_empty_owned_browser_lock(root: &Path, path: &Path) -> io::Result<bool> {
        prove_empty_owned_browser_lock_with(root, path, || {}, authoritative_file_information)
    }

    fn prove_empty_owned_browser_lock_with<AfterRecord, FinalMetadata>(
        root: &Path,
        path: &Path,
        after_record: AfterRecord,
        final_metadata: FinalMetadata,
    ) -> io::Result<bool>
    where
        AfterRecord: FnOnce(),
        FinalMetadata: FnOnce(&Path) -> io::Result<BY_HANDLE_FILE_INFORMATION>,
    {
        if !path.file_name().is_some_and(known_browser_lock_name) {
            return Ok(false);
        }
        let Ok(relative) = path.strip_prefix(root) else {
            return Ok(false);
        };
        let mut parts = relative.components();
        let Some(std::path::Component::Normal(leaf_name)) = parts.next() else {
            return Ok(false);
        };
        if parts.any(|part| !matches!(part, std::path::Component::Normal(_))) {
            return Ok(false);
        }
        let leaf = root.join(leaf_name);
        if !super::is_owned_profile_path(root, &leaf) || path.parent() == Some(root) {
            return Ok(false);
        }
        validate_owned_path(root, &leaf)?;
        // Registry -> file is the same order used by read_owned_lease and removal.
        // Holding both guards until the handle query finishes prevents Drop from
        // unregistering the owner between record verification and the zero proof.
        let registry = live_leases().lock().unwrap();
        let Some(lease) = registry.get(&leaf.join(".lease")).and_then(Weak::upgrade) else {
            return Ok(false);
        };
        let mut lease_file = lease.lock().unwrap();
        read_complete_lease_record(&mut lease_file)?;
        after_record();

        authoritative_directory_information(root)?;
        authoritative_directory_information(&leaf)?;
        let mut parent = path.parent();
        while let Some(dir) = parent {
            if dir == leaf {
                break;
            }
            authoritative_directory_information(dir)?;
            parent = dir.parent();
        }
        let info = final_metadata(path)?;
        if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 {
            return Err(io::Error::other("SPA profile lock is not a regular file"));
        }
        let empty = info.nFileSizeHigh == 0 && info.nFileSizeLow == 0;
        drop(lease_file);
        drop(registry);
        Ok(empty)
    }

    struct MetadataHandle(HANDLE);

    impl Drop for MetadataHandle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    fn authoritative_file_information(path: &Path) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
        let wide_path = wide(path.as_os_str());
        let raw = unsafe {
            CreateFileW(
                wide_path.as_ptr(),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let handle = MetadataHandle(raw);
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(info)
    }

    fn authoritative_directory_information(path: &Path) -> io::Result<()> {
        let info = authoritative_file_information(path)?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        {
            return Err(io::Error::other(
                "SPA profile lock ancestor is not a regular directory",
            ));
        }
        Ok(())
    }

    /// Waits within the caller's deadline until this newly owned lease has a
    /// complete native callback record; missing or unreadable identity is false.
    pub async fn wait_for_owned_lease_record(path: &Path, deadline: std::time::Instant) -> bool {
        let record = path.join(".lease");
        loop {
            if matches!(read_owned_lease(&record), Ok(Some(_))) {
                return true;
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return false;
            }
            tokio::time::sleep(remaining.min(Duration::from_millis(10))).await;
        }
    }

    unsafe impl Send for BrowserProcess {}

    impl Drop for BrowserProcess {
        fn drop(&mut self) {
            if let Some((app, pid, created)) = self.registration.take() {
                let _ = app.run_on_main_thread(move || {
                    ENVIRONMENTS.with(|all| {
                        if let Some((environment, token)) = all.borrow_mut().remove(&(pid, created))
                        {
                            let _ = unsafe { environment.remove_BrowserProcessExited(token) };
                        }
                    });
                });
            }
            if !self.handle.is_null() {
                unsafe { CloseHandle(self.handle) };
            }
        }
    }

    /// Captures actual WebView2 PID and creation identity before its window is destroyed.
    pub fn capture_browser_process(
        window: &tauri::WebviewWindow,
        profile: &SpaProfileLease,
    ) -> tokio::sync::oneshot::Receiver<io::Result<BrowserProcess>> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let record = profile.lock.file.clone();
        let app = window.app_handle().clone();
        let submitted = window.with_webview(move |webview| {
            let result = (|| {
                let mut record = record.lock().unwrap();
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
                use webview2_com::{
                    BrowserProcessExitedEventHandler,
                    Microsoft::Web::WebView2::Win32::ICoreWebView2Environment5,
                };
                use windows_core::Interface;
                let environment_exited = Arc::new(AtomicBool::new(false));
                let mut process = BrowserProcess {
                    handle,
                    environment_exited: environment_exited.clone(),
                    registration: None,
                };
                let environment = webview
                    .environment()
                    .cast::<ICoreWebView2Environment5>()
                    .map_err(|_| io::Error::other("browser environment exit event unavailable"))?;
                let callback =
                    BrowserProcessExitedEventHandler::create(Box::new(move |_, args| {
                        let mut exited_pid = 0;
                        if let Some(args) = args {
                            if unsafe { args.BrowserProcessId(&mut exited_pid) }.is_ok()
                                && exited_pid == pid
                            {
                                environment_exited.store(true, Ordering::SeqCst);
                            }
                        }
                        Ok(())
                    }));
                let mut token = 0;
                unsafe { environment.add_BrowserProcessExited(&callback, &mut token) }.map_err(
                    |_| io::Error::other("browser environment exit subscription failed"),
                )?;
                ENVIRONMENTS.with(|all| {
                    all.borrow_mut()
                        .insert((pid, created), (environment, token))
                });
                process.registration = Some((app, pid, created));
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

    /// Waits for the native callback to persist identity, then relays that same
    /// owned process handle to post-exit cleanup. Failure stays fail-closed.
    pub async fn complete_browser_capture(
        capture: tokio::sync::oneshot::Receiver<io::Result<BrowserProcess>>,
        deadline: std::time::Instant,
    ) -> (
        bool,
        tokio::sync::oneshot::Receiver<io::Result<BrowserProcess>>,
    ) {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let result = match tokio::time::timeout(remaining, capture).await {
            Ok(Ok(result)) => result,
            _ => Err(io::Error::other("browser identity capture incomplete")),
        };
        let complete = result.is_ok();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let _ = sender.send(result);
        (complete, receiver)
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

    /// Deletes only after callback, window destruction, browser exit and complete row audit.
    pub async fn cleanup_after_exit(
        profile: SpaProfileLease,
        browser: Option<tokio::sync::oneshot::Receiver<io::Result<BrowserProcess>>>,
        gone: Arc<AtomicBool>,
        secret_audit: Option<SecretAudit>,
        close_requested: std::time::Instant,
    ) -> CleanupResult {
        cleanup_after_exit_with_probe(
            profile,
            browser,
            gone,
            secret_audit,
            close_requested,
            |process| match unsafe { WaitForSingleObject(process.handle, 0) } {
                WAIT_OBJECT_0 if process.environment_exited.load(Ordering::SeqCst) => {
                    BrowserLeaseStatus::Exited
                }
                WAIT_OBJECT_0 => BrowserLeaseStatus::Active,
                WAIT_TIMEOUT => BrowserLeaseStatus::Active,
                _ => BrowserLeaseStatus::Unknown,
            },
        )
        .await
    }

    async fn cleanup_after_exit_with_probe<F>(
        profile: SpaProfileLease,
        browser: Option<tokio::sync::oneshot::Receiver<io::Result<BrowserProcess>>>,
        gone: Arc<AtomicBool>,
        secret_audit: Option<SecretAudit>,
        close_requested: std::time::Instant,
        process_status: F,
    ) -> CleanupResult
    where
        F: Fn(&BrowserProcess) -> BrowserLeaseStatus + Send + Sync,
    {
        let deadline = close_requested + Duration::from_secs(10);
        let Some(receiver) = browser else {
            return CleanupResult::default();
        };
        let Ok(Ok(Ok(process))) =
            tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), receiver).await
        else {
            return CleanupResult {
                audits: vec![super::ProfileCleanupEvidence {
                    exit_timed_out: std::time::Instant::now() >= deadline,
                    exit_wait_ms: close_requested.elapsed().as_millis().min(u64::MAX as u128)
                        as u64,
                    ..Default::default()
                }],
                ..Default::default()
            };
        };
        let path = profile.path().to_path_buf();
        let remove_path = path.clone();
        let root = profile.root.clone();
        super::finish_owned_cleanup_async_with_mode(
            close_requested,
            deadline,
            // Own the Send-only process through the wait/audit future. A shared
            // borrow here would require Sync for its HANDLE; COM stays UI-local.
            move || {
                if !gone.load(Ordering::SeqCst) {
                    Some(false)
                } else {
                    match process_status(&process) {
                        BrowserLeaseStatus::Exited => Some(true),
                        BrowserLeaseStatus::Active => Some(false),
                        BrowserLeaseStatus::Unknown => None,
                    }
                }
            },
            move || {
                let path = path.clone();
                let root = root.clone();
                let secret_audit = secret_audit.clone();
                async move {
                    let mut evidence = super::ProfileCleanupEvidence::default();
                    let deadline =
                        crate::profile_audit::deadline(std::time::Instant::now(), deadline);
                    let audit = tokio::task::spawn_blocking(move || {
                        crate::profile_audit::post_exit_audit(
                            || {
                                validate_owned_path(&root, &path)?;
                                ensure_no_reparse_tree_before(&path, Some(deadline))?;
                                #[cfg(not(debug_assertions))]
                                let _ = &secret_audit;
                                #[cfg(debug_assertions)]
                                if let Some(check) = secret_audit {
                                    return Ok(check(&path));
                                }
                                audit_profile_readability(&path, deadline)?;
                                Ok(super::SecretScanOutcome {
                                    complete: true,
                                    secret_detected: false,
                                })
                            },
                            || {
                                let audit =
                                    inspect_cookie_databases_with_deadline(&path, Some(deadline))?;
                                Ok(super::ProfileCleanupEvidence {
                                    cookie_rows: audit.rows,
                                    cookie_database_files: audit.database_files,
                                    cookie_sidecar_files: audit.sidecar_files,
                                    ..Default::default()
                                })
                            },
                        )
                    })
                    .await;
                    match audit {
                        Ok(audited) => evidence = audited,
                        Err(_) => evidence.audit_timed_out = true,
                    }
                    evidence
                }
            },
            || profile.remove_before(deadline).is_ok() && !remove_path.exists(),
            cfg!(not(debug_assertions)),
        )
        .await
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
        recorded_browser_status_with_probe(lock, probe_recorded_browser)
    }

    fn recorded_browser_status_with_probe<F>(
        lock: &File,
        probe: F,
    ) -> io::Result<BrowserLeaseStatus>
    where
        F: FnOnce(u32, u64) -> io::Result<BrowserLeaseStatus>,
    {
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
        probe(pid, created)
    }

    fn probe_recorded_browser(pid: u32, created: u64) -> io::Result<BrowserLeaseStatus> {
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
    /// Bounded enumeration result for physical primary cookie DBs and their actual rows.
    pub struct CookieAudit {
        pub database_files: u32,
        pub rows: u64,
        /// Present Cookies side files read before opening any SQLite connection.
        pub sidecar_files: u32,
    }

    /// Recursively inspects primary cookie DBs read-only; errors are never zero-row evidence.
    pub fn inspect_cookie_databases(root: &Path) -> io::Result<CookieAudit> {
        inspect_cookie_databases_with_deadline(root, None)
    }

    fn inspect_cookie_databases_with_deadline(
        root: &Path,
        deadline: Option<std::time::Instant>,
    ) -> io::Result<CookieAudit> {
        ensure_no_reparse_tree_before(root, deadline)?;
        let mut result = CookieAudit {
            database_files: 0,
            rows: 0,
            sidecar_files: 0,
        };
        let mut pending = vec![root.to_path_buf()];
        let mut databases = Vec::new();
        let mut remaining = crate::profile_audit::MAX_BYTES;
        let mut visited = 0usize;
        while let Some(dir) = pending.pop() {
            audit_deadline(deadline)?;
            for entry in fs::read_dir(dir)? {
                audit_deadline(deadline)?;
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
                    if matches!(
                        lower.as_str(),
                        "cookies-journal" | "cookies-wal" | "cookies-shm"
                    ) {
                        // Read before any SQLite open can checkpoint/remove a side file.
                        read_file_bounded(&path, deadline, &mut remaining)?;
                        result.sidecar_files += 1;
                    }
                    if lower == "cookies" || lower.starts_with("cookies.sqlite") {
                        if lower.ends_with("-journal")
                            || lower.ends_with("-wal")
                            || lower.ends_with("-shm")
                        {
                            continue;
                        }
                        result.database_files = result.database_files.saturating_add(1);
                        databases.push(path);
                    }
                }
            }
        }
        for path in databases {
            audit_deadline(deadline)?;
            result.rows = result
                .rows
                .checked_add(cookie_rows(&path)?)
                .ok_or_else(|| io::Error::other("cookie row count overflow"))?;
        }
        Ok(result)
    }

    /// Exclusive ownership of one random SPA user-data folder and its locked identity record.
    pub struct SpaProfileLease {
        root: PathBuf,
        leaf: PathBuf,
        lock: LeaseLock,
    }

    #[derive(Debug, Clone, Copy, Default, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    /// Startup recovery evidence; positive rows remain a failure after owned deletion.
    pub struct SweepResult {
        pub removed: u32,
        pub skipped_active: u32,
        pub skipped_unknown: u32,
        pub positive_profiles: u32,
        pub positive_rows: u64,
        pub audit_failed: u32,
        pub timed_out: bool,
    }

    impl SweepResult {
        pub fn complete(&self) -> bool {
            !self.timed_out && self.skipped_unknown == 0 && self.positive_profiles == 0
        }

        /// Stable, path-free reason code for startup recovery logging.
        pub fn reason_code(&self) -> &'static str {
            if self.timed_out {
                "SPA_PROFILE_SWEEP_TIMEOUT"
            } else if self.skipped_unknown > 0 {
                "SPA_PROFILE_SWEEP_LEAF_FAILED"
            } else if self.positive_profiles > 0 {
                "SPA_PROFILE_SWEEP_COOKIE_ROWS"
            } else if self.audit_failed > 0 {
                "SPA_PROFILE_SWEEP_COOKIE_AUDIT_FAILED"
            } else {
                "SPA_PROFILE_SWEEP_OK"
            }
        }
    }

    impl SpaProfileLease {
        pub fn path(&self) -> &Path {
            &self.leaf
        }

        /// Called only after the native callback, window absence, and browser exit succeeded.
        #[cfg(test)]
        fn remove(self) -> io::Result<()> {
            self.remove_before(std::time::Instant::now() + Duration::from_secs(10))
        }

        fn remove_tree_before(path: &Path, deadline: std::time::Instant) -> io::Result<()> {
            Self::remove_tree_before_with(path, deadline, &std::time::Instant::now)
        }

        fn remove_tree_before_with<F>(
            path: &Path,
            deadline: std::time::Instant,
            now: &F,
        ) -> io::Result<()>
        where
            F: Fn() -> std::time::Instant,
        {
            if now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "profile removal deadline",
                ));
            }
            let metadata = check_no_reparse(path)?;
            if metadata.is_dir() {
                for entry in fs::read_dir(path)? {
                    if now() >= deadline {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "profile removal deadline",
                        ));
                    }
                    let entry = entry?;
                    Self::remove_tree_before_with(&entry.path(), deadline, now)?;
                }
                fs::remove_dir(path)
            } else {
                fs::remove_file(path)
            }
        }

        fn remove_before(self, deadline: std::time::Instant) -> io::Result<()> {
            let Self { root, leaf, lock } = self;
            if std::time::Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "profile removal deadline",
                ));
            }
            validate_owned_path(&root, &leaf)?;
            ensure_no_reparse_tree(&leaf)?;
            // The lock file remains held until all browser data has been removed.
            for entry in fs::read_dir(&leaf)? {
                if std::time::Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "profile removal deadline",
                    ));
                }
                let entry = entry?;
                if entry.file_name() == OsStr::new(".lease") {
                    continue;
                }
                let path = entry.path();
                let metadata = check_no_reparse(&path)?;
                if metadata.is_dir() {
                    Self::remove_tree_before(&path, deadline)?;
                } else {
                    fs::remove_file(path)?;
                }
                if std::time::Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "profile removal deadline",
                    ));
                }
            }
            {
                // Registry then file is the same order as read_owned_lease. This
                // drains an in-progress reader and forbids another retained-handle
                // read while the record and its parent are being removed.
                let mut registry = live_leases().lock().unwrap();
                registry.remove(&lock.path);
                let _guard = lock.file.lock().unwrap();
                fs::remove_file(leaf.join(".lease"))?;
            }
            drop(lock);
            if std::time::Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "profile removal deadline",
                ));
            }
            fs::remove_dir(leaf)
        }
    }

    /// Returns the fixed LOCALAPPDATA SPA root, rejecting relative or reparse ancestry.
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

    /// Creates a private per-window WebView2 folder before any browser write.
    pub fn create(app: &tauri::AppHandle) -> io::Result<SpaProfileLease> {
        let root = root_for_app(app)?;
        create_in(&root)
    }

    /// Startup only. Never descends into an unknown child or a reparse point.
    /// Sweeps only proven-owned, proven-exited leaves; unknown ownership stays untouched.
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
            let lock_path = leaf.join(".lease");
            return Ok(SpaProfileLease {
                root: root.to_path_buf(),
                leaf,
                lock: LeaseLock::new(lock_path, lock),
            });
        }
        Err(io::Error::other("SPA profile allocation exhausted"))
    }

    #[cfg(debug_assertions)]
    /// Debug-only fake-root seam; tests must pass a disposable temporary directory.
    pub fn create_in_fixture_root(root: &Path) -> io::Result<SpaProfileLease> {
        create_in(root)
    }

    #[cfg(debug_assertions)]
    /// Debug-only process-identity seam for a disposable owned lease.
    pub fn record_fixture_identity(
        profile: &SpaProfileLease,
        pid: u32,
        created: u64,
    ) -> io::Result<()> {
        use std::io::{Seek, SeekFrom, Write};
        if pid == 0 || created == 0 {
            return Err(io::Error::other("fixture browser identity missing"));
        }
        let mut file = profile.lock.file.lock().unwrap();
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        file.write_all(&pid.to_le_bytes())?;
        file.write_all(&created.to_le_bytes())?;
        file.sync_all()
    }

    fn sweep_in(root: &Path) -> io::Result<SweepResult> {
        sweep_in_with_deadline(root, std::time::Instant::now() + Duration::from_secs(5))
    }

    fn sweep_in_with_deadline(
        root: &Path,
        deadline: std::time::Instant,
    ) -> io::Result<SweepResult> {
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
            if std::time::Instant::now() >= deadline {
                result.timed_out = true;
                break;
            }
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
            let outcome = (|| -> io::Result<Option<(bool, bool, u64)>> {
                if !check_no_reparse(&path)?.is_dir() {
                    return Ok(None);
                }
                if !profile_acl_is_private(&path)? {
                    return Ok(Some((false, false, 0)));
                }
                let lock_path = path.join(".lease");
                let lock = match OpenOptions::new().read(true).write(true).open(&lock_path) {
                    Ok(lock) => lock,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        // A deadline must never leave an empty, lease-less orphan.
                        if fs::read_dir(&path)?.next().is_none() {
                            fs::remove_dir(&path)?;
                            return Ok(Some((true, false, 0)));
                        }
                        return Ok(Some((false, false, 0)));
                    }
                    Err(error) => return Err(error),
                };
                if lock.try_lock().is_err() {
                    return Ok(Some((false, true, 0)));
                }
                match recorded_browser_status(&lock)? {
                    BrowserLeaseStatus::Exited => {}
                    BrowserLeaseStatus::Active => return Ok(Some((false, true, 0))),
                    BrowserLeaseStatus::Unknown => return Ok(Some((false, false, 0))),
                }
                let lease = SpaProfileLease {
                    root: root.to_path_buf(),
                    leaf: path.clone(),
                    lock: LeaseLock::new(lock_path, lock),
                };
                let rows =
                    match inspect_cookie_databases_with_deadline(lease.path(), Some(deadline)) {
                        Ok(audit) => audit.rows,
                        Err(_) => {
                            result.audit_failed = result.audit_failed.saturating_add(1);
                            0
                        }
                    };
                lease.remove_before(deadline)?;
                Ok(Some((true, false, rows)))
            })();
            match outcome {
                Ok(Some((true, _, rows))) => {
                    result.removed += 1;
                    if rows > 0 {
                        result.positive_profiles += 1;
                        result.positive_rows = result.positive_rows.saturating_add(rows);
                    }
                }
                Ok(Some((false, active, _))) => {
                    // A locked or unproven owner is retained for a later startup.
                    if active {
                        result.skipped_active += 1;
                    } else {
                        result.skipped_unknown += 1;
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    // One broken leaf must not abort the remaining owned leaves or startup.
                    if error.kind() == io::ErrorKind::TimedOut {
                        result.timed_out = true;
                    } else {
                        eprintln!("SPA_PROFILE_SWEEP_LEAF_FAILED");
                    }
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
        ensure_no_reparse_tree_before(root, None)
    }
    fn ensure_no_reparse_tree_before(
        root: &Path,
        deadline: Option<std::time::Instant>,
    ) -> io::Result<()> {
        let mut pending = vec![root.to_path_buf()];
        let mut visited = 0usize;
        while let Some(dir) = pending.pop() {
            audit_deadline(deadline)?;
            if !check_no_reparse(&dir)?.is_dir() {
                return Err(io::Error::other("SPA profile tree changed"));
            }
            for entry in fs::read_dir(dir)? {
                audit_deadline(deadline)?;
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
        set_private_acl_with(path, |path, sid, dacl| {
            let path = wide(path.as_os_str());
            let code = unsafe {
                SetNamedSecurityInfoW(
                    path.as_ptr() as *mut u16,
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION
                        | DACL_SECURITY_INFORMATION
                        | PROTECTED_DACL_SECURITY_INFORMATION,
                    sid,
                    std::ptr::null_mut(),
                    dacl,
                    std::ptr::null_mut(),
                )
            };
            if code != 0 {
                return Err(io::Error::from_raw_os_error(code as i32));
            }
            Ok(())
        })
    }

    fn set_private_acl_with<F>(path: &Path, apply: F) -> io::Result<()>
    where
        F: FnOnce(
            &Path,
            windows_sys::Win32::Security::PSID,
            *mut windows_sys::Win32::Security::ACL,
        ) -> io::Result<()>,
    {
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
                String::from_utf16(unsafe { std::slice::from_raw_parts(sid_string, len) })
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
                apply(path, sid, dacl)
            })();
            unsafe { LocalFree(descriptor.cast()) };
            applied
        })();
        unsafe { CloseHandle(token) };
        result
    }

    fn query_failure(stage: CookieQueryStage, error: rusqlite::Error) -> CookieQueryDiagnostic {
        use rusqlite::{ffi, Error, ErrorCode};
        let result = match error {
            Error::SqliteFailure(error, _) => match error.extended_code {
                ffi::SQLITE_READONLY_RECOVERY => CookieQueryResult::ReadOnlyRecovery,
                ffi::SQLITE_READONLY_CANTLOCK => CookieQueryResult::ReadOnlyCantLock,
                ffi::SQLITE_READONLY_CANTINIT => CookieQueryResult::ReadOnlyCantInit,
                ffi::SQLITE_IOERR_SHMOPEN => CookieQueryResult::IoShmOpen,
                ffi::SQLITE_IOERR_SHMSIZE => CookieQueryResult::IoShmSize,
                ffi::SQLITE_IOERR_SHMLOCK => CookieQueryResult::IoShmLock,
                ffi::SQLITE_IOERR_SHMMAP => CookieQueryResult::IoShmMap,
                ffi::SQLITE_ERROR => CookieQueryResult::SqliteError,
                _ => match error.code {
                    ErrorCode::DatabaseBusy => CookieQueryResult::Busy,
                    ErrorCode::DatabaseLocked => CookieQueryResult::Locked,
                    ErrorCode::ReadOnly => CookieQueryResult::ReadOnly,
                    ErrorCode::CannotOpen => CookieQueryResult::CannotOpen,
                    ErrorCode::DatabaseCorrupt => CookieQueryResult::Corrupt,
                    ErrorCode::NotADatabase => CookieQueryResult::NotDatabase,
                    ErrorCode::SystemIoFailure => CookieQueryResult::Io,
                    ErrorCode::PermissionDenied | ErrorCode::AuthorizationForStatementDenied => {
                        CookieQueryResult::Permission
                    }
                    ErrorCode::SchemaChanged => CookieQueryResult::SchemaChanged,
                    _ => CookieQueryResult::SqliteOther,
                },
            },
            _ => CookieQueryResult::Other,
        };
        CookieQueryDiagnostic { stage, result }
    }

    // rusqlite closes SQLite's failed-open handle before returning its error, so
    // sqlite3_system_errno cannot recover that call's OS error here. This separate,
    // non-reading probe records only the contemporaneous Windows access outcome.
    // Its access/share/disposition match the pinned SQLite WinVFS read-only open.
    // No successful probe substitutes for a successful SQLite COUNT query.
    fn diagnose_native_read_open(path: &Path) -> CookieQueryResult {
        use windows_sys::Win32::Foundation::{
            ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND,
            ERROR_SHARING_VIOLATION, GENERIC_READ,
        };
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
        let wide_path = wide(path.as_os_str());
        let raw = unsafe {
            CreateFileW(
                wide_path.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return match io::Error::last_os_error()
                .raw_os_error()
                .map(|code| code as u32)
            {
                Some(ERROR_SHARING_VIOLATION) => {
                    CookieQueryResult::CannotOpenNativeSharingViolation
                }
                Some(ERROR_ACCESS_DENIED) => CookieQueryResult::CannotOpenNativeAccessDenied,
                Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) => {
                    CookieQueryResult::CannotOpenNativePathMissing
                }
                _ => CookieQueryResult::CannotOpen,
            };
        }
        // RAII closes the diagnostic handle without reading bytes or querying rows.
        drop(MetadataHandle(raw));
        CookieQueryResult::CannotOpenNativeOpenable
    }

    /// Read the actual cookie table, including committed WAL pages, without a writable connection.
    pub fn cookie_rows(path: &Path) -> io::Result<u64> {
        cookie_rows_diagnostic(path).map_err(io::Error::other)
    }

    /// Query used after verified exit and by startup sweep; only closed errors escape.
    pub fn cookie_rows_diagnostic(path: &Path) -> Result<u64, CookieQueryDiagnostic> {
        use rusqlite::{Connection, OpenFlags};
        check_no_reparse(path).map_err(|_| CookieQueryDiagnostic {
            stage: CookieQueryStage::PathValidation,
            result: CookieQueryResult::PathRejected,
        })?;
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| {
                let mut diagnostic = query_failure(CookieQueryStage::Open, error);
                if diagnostic.result == CookieQueryResult::CannotOpen {
                    diagnostic.result = diagnose_native_read_open(path);
                }
                diagnostic
            })?;
        if !connection
            .is_readonly("main")
            .map_err(|error| query_failure(CookieQueryStage::ReadOnlyCheck, error))?
        {
            return Err(CookieQueryDiagnostic {
                stage: CookieQueryStage::ReadOnlyCheck,
                result: CookieQueryResult::Writable,
            });
        }
        connection
            .busy_timeout(Duration::from_millis(100))
            .map_err(|error| query_failure(CookieQueryStage::BusyTimeout, error))?;
        let mut statement = connection
            .prepare("SELECT COUNT(*) FROM cookies")
            .map_err(|error| query_failure(CookieQueryStage::Prepare, error))?;
        let mut rows = statement
            .query([])
            .map_err(|error| query_failure(CookieQueryStage::Step, error))?;
        let row = rows
            .next()
            .map_err(|error| query_failure(CookieQueryStage::Step, error))?
            .ok_or(CookieQueryDiagnostic {
                stage: CookieQueryStage::Step,
                result: CookieQueryResult::MissingRow,
            })?;
        let count: i64 = row
            .get(0)
            .map_err(|error| query_failure(CookieQueryStage::Decode, error))?;
        u64::try_from(count).map_err(|_| CookieQueryDiagnostic {
            stage: CookieQueryStage::Decode,
            result: CookieQueryResult::InvalidCount,
        })
    }

    /// Verifies actual owner/current SID, protected DACL and exact user/SYSTEM ACEs.
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
            let mut file = profile.lock.file.lock().unwrap();
            file.set_len(0).unwrap();
            file.seek(SeekFrom::Start(0)).unwrap();
            file.write_all(&pid.to_le_bytes()).unwrap();
            file.write_all(&created.to_le_bytes()).unwrap();
            file.sync_all().unwrap();
        }

        #[test]
        fn r3_actual_native_cleanup_future_is_send() {
            fn assert_send<F: std::future::Future<Output = CleanupResult> + Send>(future: F) {
                drop(future);
            }
            let temp = tempfile::tempdir().unwrap();
            let profile = create_in(&temp.path().join("spa-tmp")).unwrap();
            let (sender, receiver) = tokio::sync::oneshot::channel::<io::Result<BrowserProcess>>();
            // Type-check the actual production future with the native HANDLE owner.
            // Dropping before polling needs no UI/COM runtime and cannot audit/delete.
            assert_send(cleanup_after_exit(
                profile,
                Some(receiver),
                Arc::new(AtomicBool::new(false)),
                None,
                std::time::Instant::now(),
            ));
            drop(sender);
        }

        #[test]
        fn authoritative_failure_does_not_use_available_cached_zero() {
            use std::os::windows::fs::OpenOptionsExt;

            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("spa-tmp");
            let profile = create_in(&root).unwrap();
            record(&profile, 7, 11);
            let path = profile.path().join("LOCK");
            fs::write(&path, b"").unwrap();
            assert_eq!(fs::symlink_metadata(&path).unwrap().len(), 0);
            let held = OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(&path)
                .unwrap();
            let result = prove_empty_owned_browser_lock_with(
                &root,
                &path,
                || {},
                |_| Err(io::Error::other("authoritative metadata unavailable")),
            );
            assert!(result.is_err());
            drop(held);
            drop(profile);
        }

        #[test]
        fn exclusive_file_growth_before_handle_proof_rejects_empty_claim() {
            use std::{io::Write, os::windows::fs::OpenOptionsExt};

            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("spa-tmp");
            let profile = create_in(&root).unwrap();
            record(&profile, 7, 11);
            let path = profile.path().join("LOCK");
            fs::write(&path, b"").unwrap();
            assert_eq!(fs::symlink_metadata(&path).unwrap().len(), 0);
            let mut held = OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(&path)
                .unwrap();
            let result = prove_empty_owned_browser_lock_with(
                &root,
                &path,
                || held.write_all(b"synthetic payload").unwrap(),
                authoritative_file_information,
            );
            assert!(!result.unwrap());
            drop(held);
            drop(profile);
        }

        #[test]
        fn lease_drop_waits_for_final_metadata_proof() {
            use std::{os::windows::fs::OpenOptionsExt, sync::mpsc, time::Duration};

            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("spa-tmp");
            let profile = create_in(&root).unwrap();
            record(&profile, 7, 11);
            let path = profile.path().join("LOCK");
            fs::write(&path, b"").unwrap();
            let held = OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(&path)
                .unwrap();
            let (record_tx, record_rx) = mpsc::channel();
            let (drop_started_tx, drop_started_rx) = mpsc::channel();
            let (drop_done_tx, drop_done_rx) = mpsc::channel();
            let dropping = std::thread::spawn(move || {
                record_rx.recv().unwrap();
                drop_started_tx.send(()).unwrap();
                drop(profile);
                drop_done_tx.send(()).unwrap();
            });
            let proof = prove_empty_owned_browser_lock_with(
                &root,
                &path,
                || {
                    record_tx.send(()).unwrap();
                    drop_started_rx.recv().unwrap();
                    assert!(matches!(
                        drop_done_rx.recv_timeout(Duration::from_millis(50)),
                        Err(mpsc::RecvTimeoutError::Timeout)
                    ));
                },
                |path| {
                    assert!(drop_done_rx.try_recv().is_err());
                    authoritative_file_information(path)
                },
            );
            assert!(proof.unwrap());
            dropping.join().unwrap();
            assert!(drop_done_rx.recv_timeout(Duration::from_secs(1)).is_ok());
            drop(held);
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
        fn readonly_cookie_query_rejects_missing_and_unknown_schema_without_mutation() {
            let temp = tempfile::tempdir().unwrap();
            let missing = temp.path().join("Cookies");
            assert!(cookie_rows(&missing).is_err());
            assert!(!missing.exists());
            let connection = rusqlite::Connection::open(&missing).unwrap();
            connection
                .execute("CREATE TABLE other (value TEXT)", [])
                .unwrap();
            drop(connection);
            let before = fs::read(&missing).unwrap();
            assert!(cookie_rows(&missing).is_err());
            assert_eq!(fs::read(&missing).unwrap(), before);
            let connection = rusqlite::Connection::open(&missing).unwrap();
            connection
                .execute("CREATE TABLE cookies (value TEXT)", [])
                .unwrap();
            drop(connection);
            let before = fs::read(&missing).unwrap();
            assert_eq!(cookie_rows(&missing).unwrap(), 0);
            assert_eq!(fs::read(&missing).unwrap(), before);
            let corrupt = temp.path().join("Corrupt-Cookies");
            fs::write(&corrupt, b"not-a-sqlite-database").unwrap();
            let before = fs::read(&corrupt).unwrap();
            assert!(cookie_rows(&corrupt).is_err());
            assert_eq!(fs::read(&corrupt).unwrap(), before);
            let unreadable = temp.path().join("Unreadable-Cookies");
            fs::create_dir(&unreadable).unwrap();
            assert!(cookie_rows(&unreadable).is_err());
        }

        #[test]
        fn readonly_query_diagnostics_identify_real_failures_without_private_details() {
            let temp = tempfile::tempdir().unwrap();
            let database = temp.path().join("fake-private-path-Cookies");
            assert_eq!(
                cookie_rows_diagnostic(&database).unwrap_err(),
                CookieQueryDiagnostic {
                    stage: CookieQueryStage::PathValidation,
                    result: CookieQueryResult::PathRejected,
                }
            );
            assert!(!database.exists());
            let connection = rusqlite::Connection::open(&database).unwrap();
            connection
                .execute("CREATE TABLE other (value TEXT)", [])
                .unwrap();
            let before = fs::read(&database).unwrap();
            let unknown_schema = cookie_rows_diagnostic(&database).unwrap_err();
            assert_eq!(
                unknown_schema,
                CookieQueryDiagnostic {
                    stage: CookieQueryStage::Prepare,
                    result: CookieQueryResult::SqliteError,
                }
            );
            assert_eq!(fs::read(&database).unwrap(), before);
            connection
                .execute("CREATE TABLE cookies (value TEXT)", [])
                .unwrap();
            assert_eq!(cookie_rows_diagnostic(&database).unwrap(), 0);
            connection
                .execute("INSERT INTO cookies VALUES ('fake-secret')", [])
                .unwrap();
            assert_eq!(cookie_rows_diagnostic(&database).unwrap(), 1);
            connection.execute_batch("BEGIN EXCLUSIVE").unwrap();
            let locked = cookie_rows_diagnostic(&database).unwrap_err();
            assert_eq!(
                locked,
                CookieQueryDiagnostic {
                    stage: CookieQueryStage::Prepare,
                    result: CookieQueryResult::Busy,
                }
            );
            connection.execute_batch("ROLLBACK").unwrap();
            assert_eq!(cookie_rows_diagnostic(&database).unwrap(), 1);
            let encoded = serde_json::to_string(&locked).unwrap();
            assert_eq!(encoded, r#"{"stage":"prepare","result":"busy"}"#);
            let corrupt = temp.path().join("fake-corrupt-Cookies");
            fs::write(&corrupt, b"not-a-sqlite-database").unwrap();
            let before = fs::read(&corrupt).unwrap();
            let error = cookie_rows_diagnostic(&corrupt).unwrap_err();
            assert_eq!(
                error,
                CookieQueryDiagnostic {
                    stage: CookieQueryStage::Prepare,
                    result: CookieQueryResult::NotDatabase,
                }
            );
            assert_eq!(fs::read(&corrupt).unwrap(), before);
            let wrapped = cookie_rows(&corrupt).unwrap_err();
            assert_eq!(
                wrapped
                    .get_ref()
                    .unwrap()
                    .downcast_ref::<CookieQueryDiagnostic>(),
                Some(&error)
            );
            let raw_message = rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_READONLY_CANTLOCK),
                Some("fake-private-path fake-secret SELECT private".to_owned()),
            );
            let closed = query_failure(CookieQueryStage::Step, raw_message);
            assert_eq!(
                serde_json::to_string(&closed).unwrap(),
                r#"{"stage":"step","result":"read-only-cant-lock"}"#
            );
        }

        #[test]
        fn readonly_open_distinguishes_native_sharing_and_keeps_real_count_required() {
            use std::os::windows::fs::OpenOptionsExt;
            let temp = tempfile::tempdir().unwrap();
            let database = temp.path().join("Cookies-\u{00e4}-\u{4e2d}");
            let connection = rusqlite::Connection::open(&database).unwrap();
            connection
                .execute("CREATE TABLE cookies (value TEXT)", [])
                .unwrap();
            connection
                .execute("INSERT INTO cookies VALUES ('fake-secret')", [])
                .unwrap();
            drop(connection);
            let before = fs::read(&database).unwrap();
            assert_eq!(cookie_rows_diagnostic(&database).unwrap(), 1);
            let held = OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(&database)
                .unwrap();
            let failure = cookie_rows_diagnostic(&database).unwrap_err();
            assert_eq!(failure.stage, CookieQueryStage::Open);
            assert_eq!(
                failure.result,
                CookieQueryResult::CannotOpenNativeSharingViolation
            );
            assert_eq!(
                serde_json::to_string(&failure).unwrap(),
                r#"{"stage":"open","result":"cannot-open-native-sharing-violation"}"#
            );
            drop(held);
            assert_eq!(
                diagnose_native_read_open(&database),
                CookieQueryResult::CannotOpenNativeOpenable
            );
            assert_eq!(cookie_rows_diagnostic(&database).unwrap(), 1);
            assert_eq!(fs::read(&database).unwrap(), before);
            let missing = temp.path().join("missing");
            assert_eq!(
                diagnose_native_read_open(&missing),
                CookieQueryResult::CannotOpenNativePathMissing
            );
            assert!(!missing.exists());
        }

        #[test]
        fn capture_completion_precedes_live_audit_then_cleanup_waits_for_exit() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("spa-tmp");
            let profile = create_in(&root).unwrap();
            let path = profile.path().to_path_buf();
            let lease_path = path.join(".lease");
            assert!(read_owned_lease(&lease_path).is_err());
            let (tx, rx) = tokio::sync::oneshot::channel();
            let gone = Arc::new(AtomicBool::new(false));
            let exited = Arc::new(AtomicBool::new(false));
            let audit_path = lease_path.clone();
            let hook: SecretAudit = Arc::new(move |profile_path| {
                assert_eq!(profile_path.join(".lease"), audit_path);
                match read_owned_lease(&audit_path) {
                    Ok(Some(record)) => super::super::SecretScanOutcome {
                        complete: true,
                        secret_detected: record.len() != 12,
                    },
                    _ => super::super::SecretScanOutcome::default(),
                }
            });
            tauri::async_runtime::block_on(async {
                assert!(
                    !wait_for_owned_lease_record(
                        &path,
                        std::time::Instant::now() + Duration::from_millis(20)
                    )
                    .await
                );
                let callback = async {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    // The synthetic native callback writes identity before delivering its handle.
                    record(&profile, 7, 11);
                    assert!(tx
                        .send(Ok(BrowserProcess {
                            handle: std::ptr::null_mut(),
                            environment_exited: Arc::new(AtomicBool::new(true)),
                            registration: None,
                        }))
                        .is_ok());
                };
                let ((complete, cleanup_receiver), ()) = tokio::join!(
                    complete_browser_capture(
                        rx,
                        std::time::Instant::now() + Duration::from_secs(1)
                    ),
                    callback
                );
                assert!(complete);
                assert!(
                    wait_for_owned_lease_record(
                        &path,
                        std::time::Instant::now() + Duration::from_secs(1)
                    )
                    .await
                );
                assert_eq!(read_owned_lease(&lease_path).unwrap().unwrap().len(), 12);
                let database = path.join("Cookies");
                let connection = rusqlite::Connection::open(&database).unwrap();
                connection
                    .execute("CREATE TABLE cookies (value TEXT)", [])
                    .unwrap();
                assert_eq!(inspect_cookie_databases(&path).unwrap().rows, 0);
                drop(connection);
                let gone_for_task = gone.clone();
                let exited_for_task = exited.clone();
                let task = tauri::async_runtime::spawn(async move {
                    cleanup_after_exit_with_probe(
                        profile,
                        Some(cleanup_receiver),
                        gone_for_task,
                        Some(hook),
                        std::time::Instant::now(),
                        move |_| {
                            if exited_for_task.load(Ordering::SeqCst) {
                                BrowserLeaseStatus::Exited
                            } else {
                                BrowserLeaseStatus::Active
                            }
                        },
                    )
                    .await
                });
                tokio::time::sleep(Duration::from_millis(75)).await;
                assert!(path.exists());
                gone.store(true, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(75)).await;
                assert!(path.exists());
                exited.store(true, Ordering::SeqCst);
                let result = tokio::time::timeout(Duration::from_secs(2), task)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(result.accepted());
                assert!(!path.exists());
            });
            assert!(read_owned_lease(&lease_path).unwrap().is_none());
        }

        #[test]
        fn completed_owned_cleanup_retains_positive_rows_and_secret_failure() {
            let temp = tempfile::tempdir().unwrap();
            let profile = create_in(&temp.path().join("spa-tmp")).unwrap();
            let path = profile.path().to_path_buf();
            record(&profile, 7, 11);
            let connection = rusqlite::Connection::open(path.join("Cookies")).unwrap();
            connection
                .execute("CREATE TABLE cookies (value TEXT)", [])
                .unwrap();
            connection
                .execute("INSERT INTO cookies VALUES ('fake-secret')", [])
                .unwrap();
            drop(connection);
            let (sender, receiver) = tokio::sync::oneshot::channel();
            assert!(sender
                .send(Ok(BrowserProcess {
                    handle: std::ptr::null_mut(),
                    environment_exited: Arc::new(AtomicBool::new(true)),
                    registration: None,
                }))
                .is_ok());
            let result = tauri::async_runtime::block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(1),
                    cleanup_after_exit_with_probe(
                        profile,
                        Some(receiver),
                        Arc::new(AtomicBool::new(true)),
                        Some(Arc::new(|_| super::super::SecretScanOutcome {
                            complete: true,
                            secret_detected: true,
                        })),
                        std::time::Instant::now(),
                        |_| BrowserLeaseStatus::Exited,
                    ),
                )
                .await
                .unwrap()
            });
            assert!(!result.removed && result.read_only_complete);
            assert_eq!(result.cookie_rows, 1);
            assert!(result.secret_detected);
            assert!(!result.accepted());
            assert!(path.exists());
        }

        #[test]
        fn recorded_process_probe_is_injectable_and_missing_record_is_unknown() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("spa-tmp");
            let profile = create_in(&root).unwrap();
            let guard = profile.lock.file.lock().unwrap();
            assert!(matches!(
                recorded_browser_status_with_probe(&guard, |_, _| {
                    panic!("probe must not run for missing identity")
                })
                .unwrap(),
                BrowserLeaseStatus::Unknown
            ));
            drop(guard);
            record(&profile, 17, 23);
            let guard = profile.lock.file.lock().unwrap();
            assert!(matches!(
                recorded_browser_status_with_probe(&guard, |pid, created| {
                    assert_eq!((pid, created), (17, 23));
                    Ok(BrowserLeaseStatus::Active)
                })
                .unwrap(),
                BrowserLeaseStatus::Active
            ));
            drop(guard);
            profile.remove().unwrap();
        }

        #[test]
        fn acl_tamper_blocks_owned_deletion() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("spa-tmp");
            let profile = create_in(&root).unwrap();
            let path = profile.path().to_path_buf();
            let sibling = root.join("shell");
            fs::create_dir(&sibling).unwrap();
            fs::write(sibling.join("sentinel"), b"kept").unwrap();
            let mut descriptor = std::ptr::null_mut();
            assert_ne!(
                unsafe {
                    ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        wide(OsStr::new("D:P(A;OICI;FA;;;WD)")).as_ptr(),
                        SDDL_REVISION_1,
                        &mut descriptor,
                        std::ptr::null_mut(),
                    )
                },
                0
            );
            let mut present = 0;
            let mut defaulted = 0;
            let mut dacl = std::ptr::null_mut();
            assert_ne!(
                unsafe {
                    GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
                },
                0
            );
            let code = unsafe {
                SetNamedSecurityInfoW(
                    wide(path.as_os_str()).as_ptr() as *mut u16,
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    dacl,
                    std::ptr::null_mut(),
                )
            };
            unsafe { LocalFree(descriptor.cast()) };
            assert_eq!(code, 0);
            assert!(!profile_acl_is_private(&path).unwrap());
            assert!(profile.remove().is_err());
            assert!(path.exists());
            assert!(sibling.join("sentinel").exists());
        }

        #[test]
        fn acl_installer_requests_current_user_owner_not_a_synthetic_group_default() {
            use windows_sys::Win32::Security::{CreateWellKnownSid, EqualSid, WinLocalSystemSid};
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("profile");
            fs::create_dir(&path).unwrap();
            let mut called = false;
            set_private_acl_with(&path, |requested_path, user_owner, dacl| {
                assert_eq!(requested_path, path);
                assert!(!user_owner.is_null() && !dacl.is_null());
                let mut synthetic_group_owner = [0u8; 68];
                let mut len = synthetic_group_owner.len() as u32;
                assert_ne!(
                    unsafe {
                        CreateWellKnownSid(
                            WinLocalSystemSid,
                            std::ptr::null_mut(),
                            synthetic_group_owner.as_mut_ptr().cast(),
                            &mut len,
                        )
                    },
                    0
                );
                assert_eq!(
                    unsafe { EqualSid(user_owner, synthetic_group_owner.as_mut_ptr().cast()) },
                    0
                );
                called = true;
                Ok(())
            })
            .unwrap();
            assert!(called);
            set_private_acl(&path).unwrap();
            assert!(profile_acl_is_private(&path).unwrap());
        }

        #[test]
        fn reparse_junction_blocks_escape_and_keeps_outside_files() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("spa-tmp");
            let profile = create_in(&root).unwrap();
            let outside = temp.path().join("outside");
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("sentinel"), b"kept").unwrap();
            let junction = profile.path().join("escape");
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&junction)
                .arg(&outside)
                .output()
                .unwrap();
            assert!(status.status.success(), "junction fixture creation failed");
            assert!(profile.remove().is_err());
            assert!(outside.join("sentinel").exists());
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
        fn startup_sweep_removes_proven_exited_positive_profile_but_retains_failure() {
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
            assert_eq!(sweep.skipped_unknown, 0);
            assert_eq!(sweep.positive_profiles, 1);
            assert_eq!(sweep.positive_rows, 1);
            assert!(!sweep.complete());
            assert_eq!(sweep.removed, 1);
            assert!(!path.exists());
        }

        #[test]
        fn startup_sweep_has_a_bounded_budget_and_stable_reason_code() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("spa-tmp");
            fs::create_dir_all(&root).unwrap();
            fs::write(root.join("unrelated"), b"fixture").unwrap();
            let sweep = sweep_in_with_deadline(&root, std::time::Instant::now());
            let sweep = sweep.unwrap();
            assert!(sweep.timed_out);
            assert!(!sweep.complete());
            assert_eq!(sweep.reason_code(), "SPA_PROFILE_SWEEP_TIMEOUT");
        }

        #[test]
        fn startup_sweep_records_leaf_failure_without_raw_error_text() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("spa-tmp");
            let profile = create_in(&root).unwrap();
            let path = profile.path().to_path_buf();
            record_exited_browser(&profile);
            drop(profile);
            fs::remove_file(path.join(".lease")).unwrap();
            fs::create_dir(path.join(".lease")).unwrap();
            let sweep = sweep_in(&root).unwrap();
            assert_eq!(sweep.skipped_unknown, 1);
            assert_eq!(sweep.reason_code(), "SPA_PROFILE_SWEEP_LEAF_FAILED");
            assert!(path.exists());
        }

        #[test]
        fn profile_readability_rejects_sharing_locked_file() {
            use std::os::windows::fs::OpenOptionsExt;
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("locked");
            fs::write(&path, b"synthetic data").unwrap();
            let _lock = OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&path)
                .unwrap();
            let error = audit_profile_readability(
                temp.path(),
                std::time::Instant::now() + Duration::from_secs(5),
            )
            .unwrap_err();
            assert_ne!(error.kind(), io::ErrorKind::TimedOut);
        }

        #[test]
        fn startup_sweep_deletes_owned_leaf_after_cookie_audit_failure() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("spa-tmp");
            let profile = create_in(&root).unwrap();
            let path = profile.path().to_path_buf();
            fs::write(path.join("Cookies"), b"not a SQLite database").unwrap();
            record_exited_browser(&profile);
            drop(profile);
            let result = sweep_in(&root).unwrap();
            assert_eq!(result.removed, 1);
            assert_eq!(result.audit_failed, 1);
            assert_eq!(
                result.reason_code(),
                "SPA_PROFILE_SWEEP_COOKIE_AUDIT_FAILED"
            );
            assert!(!path.exists());
        }

        #[test]
        fn startup_sweep_removes_empty_orphan_after_lease_disappears() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("spa-tmp");
            let profile = create_in(&root).unwrap();
            let path = profile.path().to_path_buf();
            record_exited_browser(&profile);
            drop(profile);
            fs::remove_file(path.join(".lease")).unwrap();
            assert_eq!(sweep_in(&root).unwrap().removed, 1);
            assert!(!path.exists());
        }

        #[test]
        fn recursive_leaf_delete_checks_deadline_inside_deep_tree() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("tree");
            fs::create_dir_all(root.join("a").join("b").join("c")).unwrap();
            fs::write(root.join("a").join("b").join("c").join("file"), b"x").unwrap();
            let calls = std::cell::Cell::new(0usize);
            let now = || {
                let call = calls.get();
                calls.set(call + 1);
                if call > 2 {
                    std::time::Instant::now() + Duration::from_secs(1)
                } else {
                    std::time::Instant::now()
                }
            };
            let deadline = std::time::Instant::now() + Duration::from_millis(100);
            let error =
                SpaProfileLease::remove_tree_before_with(&root, deadline, &now).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::TimedOut);
            assert!(root.exists());
        }

        #[test]
        fn cleanup_reason_codes_distinguish_cookie_audit_failure() {
            let audit = crate::windows_spa_profile::ProfileCleanupEvidence {
                environment_exited: true,
                read_only_complete: true,
                cookie_database_files: 1,
                cookie_rows: 1,
                ..Default::default()
            };
            let result = CleanupResult {
                audits: vec![audit],
                ..Default::default()
            };
            assert_eq!(
                result.reason_code(),
                "SPA_PROFILE_CLEANUP_COOKIE_AUDIT_FAILED"
            );
        }

        #[test]
        fn cleanup_reason_codes_distinguish_timeout_delete_and_success() {
            assert_eq!(
                CleanupResult::default().reason_code(),
                "SPA_PROFILE_CLEANUP_DELETE_FAILED"
            );
            let mut timeout = CleanupResult::default();
            timeout
                .audits
                .push(crate::windows_spa_profile::ProfileCleanupEvidence {
                    exit_timed_out: true,
                    ..Default::default()
                });
            assert_eq!(timeout.reason_code(), "SPA_PROFILE_CLEANUP_TIMEOUT");
            let clean = CleanupResult {
                removed: true,
                ..Default::default()
            };
            assert_eq!(clean.reason_code(), "SPA_PROFILE_CLEANUP_OK");
        }
    }
}

#[cfg(windows)]
pub use windows::*;

#[cfg(test)]
mod tests {
    use super::{known_browser_lock_name, owned_leaf_name};

    // Cell deliberately makes this probe Send but not Sync, like the owned HANDLE.
    struct SendOnlyExitProbe {
        calls: std::cell::Cell<usize>,
        exit_after: usize,
        dropped: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }
    impl SendOnlyExitProbe {
        fn exited(&self) -> Option<bool> {
            self.calls.set(self.calls.get() + 1);
            Some(self.calls.get() >= self.exit_after)
        }
    }
    impl Drop for SendOnlyExitProbe {
        fn drop(&mut self) {
            self.dropped
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    fn assert_send_future<F: std::future::Future + Send>(future: F) -> F {
        future
    }

    #[tokio::test]
    async fn r3_owned_send_only_exit_probe_survives_wait_and_audit() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let dropped = Arc::new(AtomicBool::new(false));
        let probe = SendOnlyExitProbe {
            calls: std::cell::Cell::new(0),
            exit_after: 2,
            dropped: dropped.clone(),
        };
        let future = super::finish_owned_cleanup(
            std::time::Instant::now(),
            std::time::Instant::now() + std::time::Duration::from_secs(1),
            move || probe.exited(),
            |evidence| {
                assert!(
                    !dropped.load(Ordering::SeqCst),
                    "owner must remain alive through audit"
                );
                evidence.read_only_complete = true;
                evidence.secret_scan_complete = true;
                evidence.cookie_database_files = 1;
            },
            || {
                assert!(
                    !dropped.load(Ordering::SeqCst),
                    "owner must remain alive through removal"
                );
                true
            },
        );
        let result = assert_send_future(future).await;
        assert!(result.accepted() && result.audits[0].accepted());
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn r3_cancelling_send_only_probe_drops_owner_without_audit_or_remove() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let dropped = Arc::new(AtomicBool::new(false));
        let probe = SendOnlyExitProbe {
            calls: std::cell::Cell::new(0),
            exit_after: usize::MAX,
            dropped: dropped.clone(),
        };
        let mut future = Box::pin(assert_send_future(super::finish_owned_cleanup(
            std::time::Instant::now(),
            std::time::Instant::now() + std::time::Duration::from_secs(1),
            move || probe.exited(),
            |_| panic!("unproven exit cannot audit"),
            || panic!("unproven exit cannot remove"),
        )));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(25), &mut future)
                .await
                .is_err()
        );
        assert!(
            !dropped.load(Ordering::SeqCst),
            "pending wait retains owned process"
        );
        drop(future);
        assert!(
            dropped.load(Ordering::SeqCst),
            "cancellation releases owned process"
        );
    }

    #[tokio::test]
    async fn owner_postexit_timeout_never_reads_or_deletes() {
        let calls = std::cell::Cell::new(0);
        let result = super::finish_owned_cleanup(
            std::time::Instant::now(),
            std::time::Instant::now(),
            || Some(false),
            |_| {
                calls.set(1);
            },
            || {
                calls.set(2);
                true
            },
        )
        .await;
        assert_eq!(calls.get(), 0);
        assert!(!result.accepted());
        assert!(result.audits[0].exit_timed_out);
    }

    #[tokio::test]
    async fn owner_postexit_positive_evidence_is_retained_without_deletion() {
        for (rows, secret) in [(1, false), (0, true)] {
            let result = super::finish_owned_cleanup(
                std::time::Instant::now(),
                std::time::Instant::now() + std::time::Duration::from_secs(1),
                || Some(true),
                |e| {
                    e.read_only_complete = true;
                    e.secret_scan_complete = true;
                    e.cookie_rows = rows;
                    e.cookie_database_files = 1;
                    e.secret_detected = secret;
                },
                || panic!("failed audit must retain profile"),
            )
            .await;
            assert!(!result.removed);
            assert_eq!(result.cookie_rows, rows);
            assert_eq!(result.secret_detected, secret);
            assert!(result.audits[0].environment_exited);
        }
    }

    #[tokio::test]
    async fn owner_postexit_failed_sql_retains_preceding_secret_evidence() {
        let result = super::finish_owned_cleanup(
            std::time::Instant::now(),
            std::time::Instant::now() + std::time::Duration::from_secs(1),
            || Some(true),
            |e| {
                e.secret_scan_complete = true;
                e.secret_detected = true;
            },
            || panic!("incomplete SQL cannot delete"),
        )
        .await;
        assert!(result.secret_detected);
        assert!(!result.read_only_complete && !result.removed);
        assert!(result.audits[0].secret_scan_complete);
    }

    #[tokio::test]
    async fn owner_postexit_zero_rows_are_audited_before_delete() {
        let stage = std::cell::Cell::new(0);
        let result = super::finish_owned_cleanup(
            std::time::Instant::now(),
            std::time::Instant::now() + std::time::Duration::from_secs(1),
            || {
                stage.set(1);
                Some(true)
            },
            |e| {
                assert_eq!(stage.get(), 1);
                stage.set(2);
                e.read_only_complete = true;
                e.secret_scan_complete = true;
                e.cookie_database_files = 1;
            },
            || {
                assert_eq!(stage.get(), 2);
                stage.set(3);
                true
            },
        )
        .await;
        assert!(result.accepted());
        assert!(result.audits[0].accepted());
        assert_eq!(stage.get(), 3);
    }

    #[tokio::test]
    async fn release_cleanup_deletes_after_audit_success() {
        let result = super::finish_owned_cleanup_with_mode(
            std::time::Instant::now(),
            std::time::Instant::now() + std::time::Duration::from_secs(1),
            || Some(true),
            |e| {
                e.read_only_complete = true;
                e.secret_scan_complete = true;
                e.cookie_database_files = 1;
            },
            || true,
            true,
        )
        .await;
        assert!(result.removed);
        assert_eq!(result.reason_code(), "SPA_PROFILE_CLEANUP_OK");
        assert_eq!(super::cleanup_exit_code(&result), 0);
    }

    #[tokio::test]
    async fn release_cleanup_deletes_after_audit_failure_and_logs_reason() {
        let result = super::finish_owned_cleanup_with_mode(
            std::time::Instant::now(),
            std::time::Instant::now() + std::time::Duration::from_secs(1),
            || Some(true),
            |e| e.cookie_rows = 1,
            || true,
            true,
        )
        .await;
        assert!(result.removed);
        assert_eq!(
            result.reason_code(),
            "SPA_PROFILE_CLEANUP_COOKIE_AUDIT_FAILED"
        );
        assert_eq!(super::cleanup_exit_code(&result), 0);
    }

    #[tokio::test]
    async fn release_cleanup_deletes_after_audit_budget_exhaustion() {
        let result = super::finish_owned_cleanup_with_mode(
            std::time::Instant::now(),
            std::time::Instant::now() + std::time::Duration::from_secs(1),
            || Some(true),
            |e| e.audit_timed_out = true,
            || true,
            true,
        )
        .await;
        assert!(result.removed);
        assert_eq!(result.reason_code(), "SPA_PROFILE_CLEANUP_TIMEOUT");
        assert_eq!(super::cleanup_exit_code(&result), 0);
    }

    #[tokio::test]
    async fn release_cleanup_delete_failure_keeps_zero_exit_reason() {
        let result = super::finish_owned_cleanup_with_mode(
            std::time::Instant::now(),
            std::time::Instant::now() + std::time::Duration::from_secs(1),
            || Some(true),
            |e| {
                e.read_only_complete = true;
                e.secret_scan_complete = true;
                e.cookie_database_files = 1;
            },
            || false,
            true,
        )
        .await;
        assert!(!result.removed);
        assert_eq!(result.reason_code(), "SPA_PROFILE_CLEANUP_DELETE_FAILED");
        assert_eq!(super::cleanup_exit_code(&result), 0);
    }

    #[test]
    fn only_exact_leveldb_lock_name_can_use_empty_metadata_proof() {
        assert!(known_browser_lock_name(std::ffi::OsStr::new("LOCK")));
        for name in ["lock", "SingletonLock", "other.lock", "Cookies", ".lease"] {
            assert!(!known_browser_lock_name(std::ffi::OsStr::new(name)));
        }
    }

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
