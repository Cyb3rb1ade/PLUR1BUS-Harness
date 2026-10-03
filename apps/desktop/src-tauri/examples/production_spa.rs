//! Actual native engine acceptance. All credentials and audit values stay in Rust memory.
use plur1bus_desktop::{
    commands,
    connections::{Connection, CredentialProvenance, Kind, Origin, Store},
    secrets::{token_account, MemoryStore, SecretString, TokenStore},
    spa::{self, SpaState},
    spa_proxy::SpaProxy,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    origin: String,
    installation_id: String,
    device_id: String,
    token: String,
    foreign_origin: String,
}
type Secrets = Arc<Mutex<Vec<SecretString>>>;
#[cfg(windows)]
static STARTUP_SWEEP: std::sync::OnceLock<plur1bus_desktop::windows_spa_profile::SweepResult> =
    std::sync::OnceLock::new();

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AuditFailureCategory {
    None,
    ReadDir,
    EntryDisappeared,
    Metadata,
    FileRead,
    Symlink,
    CounterLimit,
    SecretDetected,
    CookieDatabase,
    CookieQuery,
    FileReadSharing,
    FileReadAccessDenied,
    FileReadMissing,
    FileReadOther,
    Deadline,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AuditObservation {
    audit_complete: bool,
    secret_detected: bool,
    cookie_database_files: u32,
    cookie_rows: u64,
    cookie_read_only_complete: bool,
    cookie_database_native_profile_files: u32,
    cookie_database_other_root_files: u32,
    cookie_database_primary_files: u32,
    cookie_database_sidecar_files: u32,
    read_failures: u32,
    entries_disappeared: u32,
    metadata_failures: u32,
    read_dir_failures: u32,
    symlink_entries: u32,
    failure_category: AuditFailureCategory,
}

impl AuditObservation {
    fn unavailable() -> Self {
        Self {
            audit_complete: false,
            secret_detected: false,
            cookie_database_files: 0,
            cookie_rows: 0,
            cookie_read_only_complete: false,
            cookie_database_native_profile_files: 0,
            cookie_database_other_root_files: 0,
            cookie_database_primary_files: 0,
            cookie_database_sidecar_files: 0,
            read_failures: 0,
            entries_disappeared: 0,
            metadata_failures: 0,
            read_dir_failures: 0,
            symlink_entries: 0,
            failure_category: AuditFailureCategory::ReadDir,
        }
    }

    #[cfg(any(target_os = "linux", test))]
    fn deadline_exceeded() -> Self {
        Self {
            failure_category: AuditFailureCategory::Deadline,
            ..Self::unavailable()
        }
    }

    fn clean(&self) -> bool {
        self.audit_complete
            && !self.secret_detected
            && self.cookie_database_files == 0
            && self.cookie_rows == 0
            && self.cookie_read_only_complete
            && self.read_failures == 0
            && self.entries_disappeared == 0
            && self.metadata_failures == 0
            && self.read_dir_failures == 0
            && self.symlink_entries == 0
            && self.failure_category == AuditFailureCategory::None
    }

    fn live_clean(&self) -> bool {
        self.audit_complete
            && !self.secret_detected
            && self.cookie_rows == 0
            && self.cookie_read_only_complete
            && self.read_failures == 0
            && self.entries_disappeared == 0
            && self.metadata_failures == 0
            && self.read_dir_failures == 0
            && self.symlink_entries == 0
            && self.cookie_database_other_root_files == 0
            && (cfg!(windows) || self.cookie_database_files == 0)
            && self.failure_category == AuditFailureCategory::None
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SecondaryProbeObservation {
    available: bool,
    proxy_generated_403: bool,
    other_window_acl_denied: bool,
    document_opaque_origin: bool,
    document_content_type_text_plain: bool,
    fetch_rejected_type_error: bool,
    native_cookie_store_empty: bool,
    profile_path_verified: bool,
    profile_acl_private: bool,
    profile_isolated: bool,
    profile_cleanup_complete: bool,
    cleanup_cookie_rows: u64,
    cleanup_read_only_complete: bool,
    cleanup_secret_detected: bool,
    profile_live_audit: AuditObservation,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PrivateProfileObservation {
    applicable: bool,
    callback_available: bool,
    environment_options_available: bool,
    profile_state_available: bool,
    private_enabled: bool,
    native_cookie_store_empty: bool,
    profile_path_verified: bool,
    profile_acl_private: bool,
    profile_live_audit: AuditObservation,
}

impl Default for PrivateProfileObservation {
    fn default() -> Self {
        Self {
            applicable: false,
            callback_available: false,
            environment_options_available: false,
            profile_state_available: false,
            private_enabled: false,
            native_cookie_store_empty: false,
            profile_path_verified: false,
            profile_acl_private: false,
            profile_live_audit: AuditObservation::unavailable(),
        }
    }
}

impl PrivateProfileObservation {
    fn unavailable() -> Self {
        Self::default()
    }

    fn accepted(&self) -> bool {
        if !self.applicable {
            return !cfg!(windows);
        }
        self.callback_available
            && self.environment_options_available
            && self.profile_state_available
            && self.private_enabled
            && self.native_cookie_store_empty
            && self.profile_path_verified
            && self.profile_acl_private
            && self.profile_live_audit.live_clean()
    }
}

impl SecondaryProbeObservation {
    fn unavailable() -> Self {
        Self {
            available: false,
            proxy_generated_403: false,
            other_window_acl_denied: false,
            document_opaque_origin: false,
            document_content_type_text_plain: false,
            fetch_rejected_type_error: false,
            native_cookie_store_empty: false,
            profile_path_verified: false,
            profile_acl_private: false,
            profile_isolated: false,
            profile_cleanup_complete: false,
            cleanup_cookie_rows: 0,
            cleanup_read_only_complete: false,
            cleanup_secret_detected: false,
            profile_live_audit: AuditObservation::unavailable(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SecondaryProbeResult {
    available: bool,
    other_window_403: bool,
    other_window_acl_denied: bool,
    document_opaque_origin: bool,
    document_content_type_text_plain: bool,
    fetch_rejected_type_error: bool,
    #[serde(default)]
    native_cookie_store_empty: bool,
    #[serde(default)]
    profile_path_verified: bool,
    #[serde(default)]
    profile_acl_private: bool,
    #[serde(default)]
    profile_isolated: bool,
    #[serde(default)]
    local_ipc_available: bool,
    #[serde(default)]
    local_acl_denied: bool,
}

impl SecondaryProbeResult {
    fn unavailable() -> Self {
        Self {
            available: false,
            other_window_403: false,
            other_window_acl_denied: false,
            document_opaque_origin: false,
            document_content_type_text_plain: false,
            fetch_rejected_type_error: false,
            native_cookie_store_empty: false,
            profile_path_verified: false,
            profile_acl_private: false,
            profile_isolated: false,
            local_ipc_available: false,
            local_acl_denied: false,
        }
    }

    fn observation(&self) -> SecondaryProbeObservation {
        SecondaryProbeObservation {
            available: self.available,
            proxy_generated_403: false,
            other_window_acl_denied: self.local_acl_denied,
            document_opaque_origin: self.document_opaque_origin,
            document_content_type_text_plain: self.document_content_type_text_plain,
            fetch_rejected_type_error: self.fetch_rejected_type_error,
            native_cookie_store_empty: self.native_cookie_store_empty,
            profile_path_verified: self.profile_path_verified,
            profile_acl_private: self.profile_acl_private,
            profile_isolated: self.profile_isolated,
            profile_cleanup_complete: !cfg!(windows),
            cleanup_cookie_rows: 0,
            cleanup_read_only_complete: !cfg!(windows),
            cleanup_secret_detected: false,
            profile_live_audit: AuditObservation::unavailable(),
        }
    }
}

fn auxiliary_observation(
    browser_result: &SecondaryProbeResult,
    native_live_audit: AuditObservation,
) -> SecondaryProbeObservation {
    let mut observation = browser_result.observation();
    observation.profile_live_audit = native_live_audit;
    observation
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LocalAclProbeResult {
    ipc_available: bool,
    acl_denied: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeDiagnostic {
    secondary_probe: SecondaryProbeObservation,
    pre_close_audit: AuditObservation,
    audit: AuditObservation,
    teardown: TeardownObservation,
    profile: PrivateProfileObservation,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TeardownObservation {
    process_exit_applicable: bool,
    capture_complete: bool,
    close_complete: bool,
    process_exit_complete: bool,
    audit_complete: bool,
    profile_cleanup_complete: bool,
    cleanup_cookie_rows: u64,
    cleanup_read_only_complete: bool,
    cleanup_secret_detected: bool,
}

impl TeardownObservation {
    fn clean(&self) -> bool {
        self.capture_complete
            && self.close_complete
            && (!self.process_exit_applicable || self.process_exit_complete)
            && self.audit_complete
            && self.profile_cleanup_complete
            && self.cleanup_cookie_rows == 0
            && self.cleanup_read_only_complete
            && !self.cleanup_secret_detected
    }
}

#[derive(Clone, Default)]
struct BrowserProcessOwners {
    state: Arc<Mutex<BrowserProcessState>>,
}

#[derive(Default)]
struct BrowserProcessState {
    pending_captures: usize,
    capture_failures: u32,
    close_failures: u32,
    successful_captures: u32,
    tracked_windows: BTreeSet<String>,
    windows_absent: bool,
    owners: Vec<OwnedBrowserProcess>,
}

#[cfg(windows)]
struct OwnedBrowserProcess {
    pid: u32,
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(not(windows))]
struct OwnedBrowserProcess;

#[cfg(windows)]
unsafe impl Send for OwnedBrowserProcess {}

#[cfg(windows)]
unsafe impl Sync for OwnedBrowserProcess {}

#[cfg(windows)]
impl Drop for OwnedBrowserProcess {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
        }
    }
}

impl BrowserProcessOwners {
    fn begin_capture(&self) {
        self.state.lock().unwrap().pending_captures += 1;
    }

    fn track_window(&self, label: &str) {
        self.state
            .lock()
            .unwrap()
            .tracked_windows
            .insert(label.to_owned());
    }

    fn finish_capture(&self, owner: Result<OwnedBrowserProcess, ()>) {
        let mut state = self.state.lock().unwrap();
        state.pending_captures = state.pending_captures.saturating_sub(1);
        match owner {
            Ok(owner) => {
                state.successful_captures = state.successful_captures.saturating_add(1);
                #[cfg(windows)]
                if state
                    .owners
                    .iter()
                    .any(|existing| existing.pid == owner.pid)
                {
                    return;
                }
                state.owners.push(owner);
            }
            Err(()) => state.capture_failures = state.capture_failures.saturating_add(1),
        }
    }

    fn capture_callback_failed(&self) {
        let mut state = self.state.lock().unwrap();
        state.pending_captures = state.pending_captures.saturating_sub(1);
        state.capture_failures = state.capture_failures.saturating_add(1);
    }

    fn close_failed(&self) {
        let mut state = self.state.lock().unwrap();
        state.close_failures = state.close_failures.saturating_add(1);
    }

    fn capture_complete(&self, process_exit_applicable: bool) -> bool {
        let state = self.state.lock().unwrap();
        state.pending_captures == 0
            && state.capture_failures == 0
            && (!process_exit_applicable || state.successful_captures > 0)
    }

    fn close_complete(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.close_failures == 0 && state.windows_absent
    }

    fn mark_windows_absent(&self, absent: bool) {
        self.state.lock().unwrap().windows_absent = absent;
    }

    fn tracked_windows(&self) -> Vec<String> {
        self.state
            .lock()
            .unwrap()
            .tracked_windows
            .iter()
            .cloned()
            .collect()
    }

    fn take_owners(&self) -> Vec<OwnedBrowserProcess> {
        std::mem::take(&mut self.state.lock().unwrap().owners)
    }
}

fn capture_browser_process<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    owners: &BrowserProcessOwners,
) {
    owners.track_window(window.label());
    owners.begin_capture();
    let callback_owners = owners.clone();
    let result = window.with_webview(move |webview| {
        #[cfg(windows)]
        let owner = platform_browser_process(&webview);
        #[cfg(not(windows))]
        let owner = {
            let _ = &webview;
            Ok(OwnedBrowserProcess)
        };
        callback_owners.finish_capture(owner);
    });
    if result.is_err() {
        owners.capture_callback_failed();
    }
}

#[cfg(windows)]
fn platform_browser_process(
    webview: &tauri::webview::PlatformWebview,
) -> Result<OwnedBrowserProcess, ()> {
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};

    let core = unsafe { webview.controller().CoreWebView2() }.map_err(|_| ())?;
    let mut pid = 0;
    unsafe { core.BrowserProcessId(&mut pid) }.map_err(|_| ())?;
    if pid == 0 {
        return Err(());
    }
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return Err(());
    }
    Ok(OwnedBrowserProcess { pid, handle })
}

#[derive(Debug, Clone, Copy)]
struct ProcessExitObservation {
    applicable: bool,
    complete: bool,
}

async fn wait_for_fixture_windows(
    app: &tauri::AppHandle,
    labels: &[String],
    deadline: std::time::Instant,
) -> bool {
    loop {
        if labels
            .iter()
            .all(|label| app.get_webview_window(label).is_none())
        {
            return true;
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        tokio::time::sleep(remaining.min(std::time::Duration::from_millis(10))).await;
    }
}

async fn wait_for_browser_processes(
    owners: BrowserProcessOwners,
    deadline: std::time::Instant,
) -> ProcessExitObservation {
    #[cfg(not(windows))]
    let applicable = false;
    #[cfg(windows)]
    let applicable = true;
    while {
        let state = owners.state.lock().unwrap();
        state.pending_captures != 0
    } {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return ProcessExitObservation {
                applicable,
                complete: false,
            };
        }
        tokio::time::sleep(remaining.min(std::time::Duration::from_millis(10))).await;
    }
    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
    let owned = owners.take_owners();
    let complete = tauri::async_runtime::spawn_blocking(move || {
        wait_owned_browser_processes(owned, remaining)
    })
    .await
    .unwrap_or(false);
    ProcessExitObservation {
        applicable,
        complete,
    }
}

fn wait_owned_browser_processes(
    owners: Vec<OwnedBrowserProcess>,
    deadline: std::time::Duration,
) -> bool {
    #[cfg(not(windows))]
    {
        let _ = (owners, deadline);
        true
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        let started = std::time::Instant::now();
        let mut complete = true;
        for owner in owners {
            let remaining = deadline.saturating_sub(started.elapsed());
            let millis = remaining.as_millis().min(u32::MAX as u128) as u32;
            if unsafe { WaitForSingleObject(owner.handle, millis) } != WAIT_OBJECT_0 {
                complete = false;
            }
        }
        complete
    }
}

struct FinishInputs {
    results: Arc<Mutex<Vec<Value>>>,
    known: Secrets,
    negative: Arc<Mutex<Value>>,
    secondary_observation: Arc<Mutex<Option<SecondaryProbeObservation>>>,
    browser_owners: BrowserProcessOwners,
    #[cfg(target_os = "linux")]
    retirement_phase: Arc<LinuxRetirementPhase>,
}

fn claim_observer_completion(finished: &AtomicBool) -> bool {
    !finished.swap(true, Ordering::SeqCst)
}

#[cfg(any(target_os = "linux", test))]
#[derive(Default)]
struct LinuxRetirementPhase {
    state: Mutex<LinuxRetirementState>,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Default)]
struct LinuxRetirementState {
    url: Option<url::Url>,
    page_finished: bool,
    completion: Option<tokio::sync::oneshot::Sender<Value>>,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinuxProbeRoute {
    FirstOrigin,
    FinalRetirement,
    None,
}

#[cfg(any(target_os = "linux", test))]
fn linux_probe_route(
    url: &url::Url,
    first_origin: Option<&Origin>,
    phase: &LinuxRetirementPhase,
) -> LinuxProbeRoute {
    if phase.page_finished(url) {
        return LinuxProbeRoute::FinalRetirement;
    }
    let first_marker = first_origin
        .and_then(|origin| url::Url::parse(&format!("{}/?wp05-old-check", origin.as_str())).ok());
    if first_marker.as_ref() == Some(url) {
        LinuxProbeRoute::FirstOrigin
    } else {
        LinuxProbeRoute::None
    }
}

#[cfg(any(target_os = "linux", test))]
impl LinuxRetirementPhase {
    fn arm(&self, url: url::Url, completion: tokio::sync::oneshot::Sender<Value>) {
        *self.state.lock().unwrap() = LinuxRetirementState {
            url: Some(url),
            page_finished: false,
            completion: Some(completion),
        };
    }

    fn page_finished(&self, url: &url::Url) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.url.as_ref() != Some(url) || state.page_finished {
            return false;
        }
        state.page_finished = true;
        true
    }

    fn title(&self, url: &url::Url, title: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.url.as_ref() != Some(url) || !state.page_finished {
            return false;
        }
        let observation = if title == "WP05-ACL-IPC-MISSING" {
            Some(
                json!({"actualAclDenied":false,"ipcAvailable":false,"ipcCompleted":false,"typeError":false}),
            )
        } else {
            title
                .strip_prefix("ACL:")
                .map(|raw| serde_json::from_str::<Value>(raw).unwrap_or(Value::Null))
        };
        if let Some(observation) = observation {
            let completion = state.completion.take();
            drop(state);
            if let Some(completion) = completion {
                progress(if title == "WP05-ACL-IPC-MISSING" {
                    "retirement-observer-ipc-missing"
                } else {
                    "retirement-observer-title-complete"
                });
                let _ = completion.send(observation);
            }
        }
        true
    }

    fn disarm(&self) {
        *self.state.lock().unwrap() = LinuxRetirementState::default();
    }
}

#[cfg(any(target_os = "linux", test))]
fn valid_retirement_acl(value: &Value) -> bool {
    value["actualAclDenied"] == true
        && value["ipcAvailable"] == true
        && value["ipcCompleted"] == true
        && value["typeError"] == false
}

#[cfg(any(target_os = "linux", test))]
async fn bounded_linux_work<F: std::future::Future>(
    cutoff: std::time::Instant,
    work: F,
) -> Option<F::Output> {
    tokio::time::timeout_at(tokio::time::Instant::from_std(cutoff), work)
        .await
        .ok()
}

#[cfg(target_os = "linux")]
fn close_linux_spa_once(
    window: Option<&tauri::WebviewWindow>,
    owners: &BrowserProcessOwners,
    close_claimed: &AtomicBool,
) {
    if !claim_observer_completion(close_claimed) {
        return;
    }
    progress("retirement-observer-close-start");
    if window.is_some_and(|window| window.destroy().is_ok()) {
        progress("retirement-observer-close-requested");
    } else {
        owners.close_failed();
        progress("retirement-observer-close-failed");
    }
}

#[cfg(any(target_os = "linux", test))]
#[derive(Default)]
struct LinuxPublicationGate {
    owner: AtomicBool,
    completed: AtomicBool,
    deadline_failed: AtomicBool,
    failure_writer_claimed: AtomicBool,
}

#[cfg(any(target_os = "linux", test))]
impl LinuxPublicationGate {
    fn deadline_expired(&self) -> bool {
        if self.completed.load(Ordering::SeqCst) {
            return false;
        }
        self.deadline_failed.store(true, Ordering::SeqCst);
        true
    }

    fn must_fail(&self, deadline: std::time::Instant) -> bool {
        self.deadline_failed.load(Ordering::SeqCst) || std::time::Instant::now() >= deadline
    }
}

#[cfg(any(target_os = "linux", test))]
fn spawn_linux_failure_writer<F: FnOnce() + Send + 'static>(
    gate: &Arc<LinuxPublicationGate>,
    work: F,
) -> Option<std::thread::JoinHandle<()>> {
    claim_observer_completion(&gate.failure_writer_claimed).then(|| std::thread::spawn(work))
}

#[cfg(any(target_os = "linux", test))]
trait LinuxReportIo {
    fn write_pending(&self, bytes: &[u8]) -> std::io::Result<()>;
    fn rename_pending(&self) -> std::io::Result<()>;
    fn remove_pending(&self);
    fn write_failed(&self, bytes: &[u8]) -> std::io::Result<()>;
    fn progress(&self, stage: &'static str);
    fn exit(&self, code: i32);
}

#[cfg(target_os = "linux")]
struct NativeLinuxReportIo<'a> {
    app: &'a tauri::AppHandle,
    output: &'a std::path::Path,
    pending: &'a std::path::Path,
}

#[cfg(target_os = "linux")]
impl LinuxReportIo for NativeLinuxReportIo<'_> {
    fn write_pending(&self, bytes: &[u8]) -> std::io::Result<()> {
        std::fs::write(self.pending, bytes)
    }
    fn rename_pending(&self) -> std::io::Result<()> {
        std::fs::rename(self.pending, self.output)
    }
    fn remove_pending(&self) {
        let _ = std::fs::remove_file(self.pending);
    }
    fn write_failed(&self, bytes: &[u8]) -> std::io::Result<()> {
        std::fs::write(self.output, bytes)
    }
    fn progress(&self, stage: &'static str) {
        progress(stage);
    }
    fn exit(&self, code: i32) {
        self.app.exit(code);
    }
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
struct LinuxFailureWriter {
    app: tauri::AppHandle,
    output: PathBuf,
    results: Arc<Mutex<Vec<Value>>>,
    known: Secrets,
    negative: Arc<Mutex<Value>>,
    secondary: Arc<Mutex<Option<SecondaryProbeObservation>>>,
    profile: Arc<Mutex<PrivateProfileObservation>>,
    gate: Arc<LinuxPublicationGate>,
}

#[cfg(target_os = "linux")]
impl LinuxFailureWriter {
    fn start(&self) {
        let writer = self.clone();
        let _ = spawn_linux_failure_writer(&self.gate, move || {
            write_observer_timeout_report(
                &writer.app,
                &writer.output,
                &writer.results,
                &writer.known,
                &writer.negative,
                &writer.secondary,
                &writer.profile,
            );
            writer.gate.completed.store(true, Ordering::SeqCst);
        });
    }
}

#[cfg(any(target_os = "linux", test))]
fn publish_linux_report<I: LinuxReportIo>(
    gate: &LinuxPublicationGate,
    io: &I,
    finalization_cutoff: std::time::Instant,
    deadline: std::time::Instant,
    passed: bool,
    bytes: &[u8],
    failed_bytes: &[u8],
) {
    if io.write_pending(bytes).is_err() {
        io.progress("audit-report-write-failed");
        return;
    }
    if std::time::Instant::now() >= finalization_cutoff || !claim_observer_completion(&gate.owner) {
        io.remove_pending();
        return;
    }
    if io.rename_pending().is_err() {
        let _ = io.write_failed(failed_bytes);
        io.progress("audit-report-write-failed");
        io.exit(2);
        gate.completed.store(true, Ordering::SeqCst);
        return;
    }
    io.progress("audit-report-written");
    if !passed || gate.must_fail(deadline) {
        let _ = io.write_failed(failed_bytes);
        io.progress("audit-failed");
        io.exit(2);
        gate.completed.store(true, Ordering::SeqCst);
        return;
    }
    io.progress("audit-passed");
    // No filesystem or progress operation may occur after this check and before exit 0.
    if gate.must_fail(deadline) {
        let _ = io.write_failed(failed_bytes);
        io.progress("audit-failed");
        io.exit(2);
    } else {
        io.exit(0);
        if gate.must_fail(deadline) {
            let _ = io.write_failed(failed_bytes);
            io.exit(2);
        }
    }
    gate.completed.store(true, Ordering::SeqCst);
}

#[cfg(any(windows, test))]
async fn await_profile_callback(
    observation: Arc<Mutex<PrivateProfileObservation>>,
    completion: tokio::sync::oneshot::Receiver<()>,
    deadline: std::time::Instant,
) -> PrivateProfileObservation {
    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
    let _ = tokio::time::timeout(remaining, completion).await;
    observation.lock().unwrap().clone()
}

#[cfg(windows)]
async fn inspect_private_profile(
    window: &tauri::WebviewWindow,
    observation: Arc<Mutex<PrivateProfileObservation>>,
    deadline: std::time::Instant,
) -> PrivateProfileObservation {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment10, ICoreWebView2_13,
    };
    use windows_core::Interface;

    *observation.lock().unwrap() = PrivateProfileObservation {
        applicable: true,
        native_cookie_store_empty: window.cookies().is_ok_and(|cookies| cookies.is_empty()),
        ..PrivateProfileObservation::default()
    };
    let target = observation.clone();
    let (completion_sender, completion) = tokio::sync::oneshot::channel();
    let callback = window.with_webview(move |webview| {
        let mut state = target.lock().unwrap();
        state.callback_available = true;
        let controller = webview.controller();
        if let Ok(core) = unsafe { controller.CoreWebView2() } {
            state.environment_options_available = webview
                .environment()
                .cast::<ICoreWebView2Environment10>()
                .is_ok();
            if let Ok(core13) = core.cast::<ICoreWebView2_13>() {
                if let Ok(profile) = unsafe { core13.Profile() } {
                    let mut enabled = windows_core::BOOL::default();
                    if unsafe { profile.IsInPrivateModeEnabled(&mut enabled) }.is_ok() {
                        state.profile_state_available = true;
                        state.private_enabled = enabled.as_bool();
                    }
                }
            }
        }
        drop(state);
        let _ = completion_sender.send(());
    });
    if callback.is_err() {
        observation.lock().unwrap().callback_available = false;
        return observation.lock().unwrap().clone();
    }
    await_profile_callback(observation, completion, deadline).await
}

#[cfg(all(not(windows), not(target_os = "linux")))]
async fn inspect_private_profile(
    _window: &tauri::WebviewWindow,
    observation: Arc<Mutex<PrivateProfileObservation>>,
    _deadline: std::time::Instant,
) -> PrivateProfileObservation {
    *observation.lock().unwrap() = PrivateProfileObservation::unavailable();
    PrivateProfileObservation::unavailable()
}

fn write_observer_timeout_report(
    app: &tauri::AppHandle,
    output: &PathBuf,
    results: &Arc<Mutex<Vec<Value>>>,
    known: &Secrets,
    negative: &Arc<Mutex<Value>>,
    secondary_observation: &Arc<Mutex<Option<SecondaryProbeObservation>>>,
    profile: &Arc<Mutex<PrivateProfileObservation>>,
) {
    let pre_close_audit = AuditObservation::unavailable();
    let audit_observation = AuditObservation::unavailable();
    let teardown = TeardownObservation {
        process_exit_applicable: cfg!(windows),
        capture_complete: false,
        close_complete: false,
        process_exit_complete: false,
        audit_complete: false,
        profile_cleanup_complete: false,
        cleanup_cookie_rows: 0,
        cleanup_read_only_complete: false,
        cleanup_secret_detected: false,
    };
    let secondary = secondary_observation
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(SecondaryProbeObservation::unavailable);
    let diagnostic = NativeDiagnostic {
        secondary_probe: secondary,
        pre_close_audit: pre_close_audit.clone(),
        audit: audit_observation.clone(),
        teardown: teardown.clone(),
        profile: profile.lock().unwrap().clone(),
    };
    #[allow(unused_mut)]
    let mut report = json!({
        "result": "failed",
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "tauri": "2.12.0",
        "nativeMainEntered": true,
        "knownSecretKinds": ["deviceBearer", "tickets", "launchCarrier", "sessionCookies", "browserCsrf"],
        "sessions": results.lock().unwrap().clone(),
        "retirement": {"actualAclDenied": false},
        "negativeControls": negative.lock().unwrap().clone(),
        "ticketError": Value::Null,
        "productionBenchmark": Value::Null,
        "secretOnDisk": false,
        "cookieDatabaseFiles": 0,
        "preCloseAudit": pre_close_audit,
        "teardown": teardown,
        "profile": profile.lock().unwrap().clone(),
        "diagnostic": diagnostic,
    });
    #[cfg(windows)]
    if let Value::Object(fields) = &mut report {
        fields.insert("startupSweep".into(), json!(STARTUP_SWEEP.get().copied()));
    }
    let bytes = match serde_json::to_vec_pretty(&report) {
        Ok(bytes) => {
            progress("audit-report-serialized");
            bytes
        }
        Err(_) => {
            progress("audit-report-serialization-failed");
            app.exit(2);
            return;
        }
    };
    if contains_secret(&bytes, &known.lock().unwrap()) {
        progress("audit-report-secret-detected");
        app.exit(2);
        return;
    }
    if std::fs::write(output, &bytes).is_err() {
        progress("audit-report-write-failed");
        app.exit(2);
        return;
    }
    progress("audit-report-written");
    progress("audit-failed");
    app.exit(2);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuditEntryKind {
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Debug, Clone)]
struct AuditEntry {
    path: PathBuf,
    kind: AuditEntryKind,
    cookie_database: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CookieFileClass {
    Primary,
    Sidecar,
}

trait AuditReader {
    fn read_dir(&mut self, root: &std::path::Path)
        -> Result<Vec<AuditEntry>, AuditFailureCategory>;
    fn read_file(&mut self, path: &std::path::Path) -> Result<Vec<u8>, AuditFailureCategory>;
    fn cookie_rows(&mut self, _path: &std::path::Path) -> Result<u64, AuditFailureCategory> {
        Ok(0)
    }
}

fn old_origin_probe_script() -> &'static str {
    r#"(async()=>{let aclDenied=false;let rustCallerDenied=false;try{await window.__TAURI_INTERNALS__.invoke('shell_info')}catch(e){const message=String(e);aclDenied=/not allowed|denied|permissions/i.test(message);rustCallerDenied=message.includes('command unavailable for this window')}document.title='OLD:'+JSON.stringify({aclDenied,rustCallerDenied});})()"#
}

fn ticket_error_probe_script() -> &'static str {
    "document.title='ERR:'+JSON.stringify({savedTheme:document.documentElement.dataset.theme,savedLocale:document.documentElement.lang,terminalError:location.pathname==='/__shell/ticket-error',fragmentGone:!location.hash,controls44:[...document.querySelectorAll('#copy,#retry')].every(e=>{const r=e.getBoundingClientRect();return r.width>=44&&r.height>=44}),honestError:document.getElementById('detail').textContent.length>20&&document.getElementById('safe').textContent.length>10});"
}

fn session_probe_script(foreign_origin: &str) -> String {
    format!(
        "const FOREIGN={};\n{}",
        serde_json::to_string(foreign_origin).unwrap(),
        include_str!("production-spa/probe.js")
    )
}

fn other_window_probe_script() -> &'static str {
    r#"(async()=>{document.title='NEG_STAGE:entry';let opaque=window.origin==='null';let plain=(document.contentType||'').toLowerCase()==='text/plain';document.title='NEG_STAGE:fetch-start';let blocked=false;let rejected=false;try{blocked=(await fetch(location.href)).status===403;document.title='NEG_STAGE:fetch-complete'}catch(e){rejected=e instanceof TypeError;document.title='NEG_STAGE:fetch-error'}let acl=false;document.title='NEG_STAGE:ipc-start';try{await window.__TAURI_INTERNALS__.invoke('shell_info')}catch(e){acl=String(e).includes('not allowed')||String(e).includes('denied')||String(e).includes('permissions')}document.title='NEG_STAGE:ipc-complete';document.title='NEG:'+JSON.stringify({available:true,otherWindow403:blocked,otherWindowAclDenied:acl,documentOpaqueOrigin:opaque,documentContentTypeTextPlain:plain,fetchRejectedTypeError:rejected});})()"#
}

fn local_acl_probe_script() -> &'static str {
    r#"(async()=>{document.title='NEG_LOCAL:entry';let ipcAvailable=typeof window.__TAURI_INTERNALS__?.invoke==='function';let aclDenied=false;if(ipcAvailable){try{await window.__TAURI_INTERNALS__.invoke('shell_info')}catch(error){const message=typeof error==='string'?error:(error&&typeof error==='object'&&typeof error.message==='string'?error.message:'');aclDenied=/not allowed|denied|permissions/i.test(message)}}document.title='NEG_LOCAL:'+JSON.stringify({ipcAvailable,aclDenied});})()"#
}

fn bundled_acl_probe_url() -> url::Url {
    url::Url::parse(if cfg!(windows) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    })
    .unwrap()
}

fn is_bundled_acl_probe_url(url: &url::Url) -> bool {
    url == &bundled_acl_probe_url()
}

fn parse_local_acl_probe(raw: &str) -> Option<LocalAclProbeResult> {
    serde_json::from_str(raw).ok()
}

fn retirement_observer_probe_script() -> &'static str {
    "(async()=>{document.title='WP05-ACL-SCRIPT-ENTRY';const invoke=window.__TAURI_INTERNALS__?.invoke;if(typeof invoke!=='function'){document.title='WP05-ACL-IPC-MISSING';return}document.title='WP05-ACL-IPC-AVAILABLE';document.title='WP05-ACL-IPC-START';let denied=false;let typeError=false;try{await invoke('shell_info')}catch(e){typeError=e instanceof TypeError;denied=!typeError&&(/not allowed|denied|permissions/i).test(String(e))}document.title='WP05-ACL-IPC-COMPLETE';document.title='ACL:'+JSON.stringify({actualAclDenied:denied,ipcAvailable:true,ipcCompleted:true,typeError});})()"
}

fn main() {
    progress("starting");
    const { assert!(cfg!(debug_assertions), "debug-only fixture") };
    let output = PathBuf::from(std::env::args_os().nth(1).expect("output path"));
    let mut bytes = zeroize::Zeroizing::new(String::new());
    std::io::stdin()
        .take(8193)
        .read_to_string(&mut bytes)
        .unwrap();
    assert!(bytes.len() <= 8192);
    let input: Input = serde_json::from_str(&bytes).expect("closed input");
    progress("fixture-input-parsed");
    let tokens = Arc::new(MemoryStore::default());
    let token = SecretString::new(input.token);
    let mut conn = Connection::new(
        "Native fixture".into(),
        Kind::Local,
        Origin::parse(&input.origin).unwrap(),
        input.installation_id,
        input.device_id,
        "test".into(),
    );
    conn.credential_provenance = CredentialProvenance::MemoryOnly;
    conn.pairing_needed = false;
    tokens.set(&token_account(conn.id), &token).unwrap();
    let retry_tokens = MemoryStore::default();
    retry_tokens.set(&token_account(conn.id), &token).unwrap();
    let token_state = commands::ConnectionState(Arc::new(tokio::sync::Mutex::new(Some(Box::new(
        retry_tokens,
    )))));
    let connection = Arc::new(Mutex::new(conn));
    let store = Arc::new(Store::open(&PathBuf::from(
        std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").unwrap(),
    )));
    let known: Secrets = Arc::new(Mutex::new(vec![SecretString::new(
        token.expose().to_owned(),
    )]));
    let stage = Arc::new(AtomicU8::new(0));
    let loads = Mutex::new(std::collections::HashSet::new());
    let results = Arc::new(Mutex::new(Vec::<Value>::new()));
    let negatives = Arc::new(Mutex::new(Value::Null));
    let secondary_observation = Arc::new(Mutex::new(None::<SecondaryProbeObservation>));
    let measurements = Arc::new(Mutex::new(Value::Null));
    let first_origin = Arc::new(Mutex::new(None::<Origin>));
    #[cfg(target_os = "linux")]
    let first_origin_for_load = first_origin.clone();
    #[cfg(target_os = "linux")]
    let retirement_phase = Arc::new(LinuxRetirementPhase::default());
    #[cfg(target_os = "linux")]
    let retirement_phase_for_load = retirement_phase.clone();
    #[cfg(target_os = "linux")]
    let retirement_phase_for_title = retirement_phase.clone();
    #[cfg(windows)]
    let first_profile_path = Arc::new(Mutex::new(None::<PathBuf>));
    let old_probe = Arc::new(Mutex::new(None::<Value>));
    let browser_owners = BrowserProcessOwners::default();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().app.app_directories_override =
        Some(tauri::utils::config::AppDirectoriesOverride::Root(
            PathBuf::from(std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").unwrap())
                .join("native-profile"),
        ));
    progress("fixture-builder-start");
    let old_probe_for_title = old_probe.clone();
    let app = tauri::Builder::default()
        .manage(token_state)
        .manage(SpaState::default())
        .invoke_handler(tauri::generate_handler![
            commands::shell_info,
            commands::app_info
        ])
        .on_page_load(move |webview, payload| {
            if webview.label() != "spa"
                || !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                return;
            }
            if payload.url().query() == Some("wp05-old-check") {
                #[cfg(target_os = "linux")]
                {
                    let route = {
                        let first = first_origin_for_load.lock().unwrap();
                        linux_probe_route(payload.url(), first.as_ref(), &retirement_phase_for_load)
                    };
                    match route {
                        LinuxProbeRoute::FinalRetirement => {
                            progress("retirement-observer-page-finished");
                            match webview.eval(retirement_observer_probe_script()) {
                                Ok(()) => progress("retirement-observer-eval-submitted"),
                                Err(_) => progress("retirement-observer-eval-rejected"),
                            }
                        }
                        LinuxProbeRoute::FirstOrigin => { let _ = webview.eval(old_origin_probe_script()); }
                        LinuxProbeRoute::None => {}
                    }
                }
                #[cfg(not(target_os = "linux"))]
                let _ = webview.eval(old_origin_probe_script());
            }
            if payload.url().path() == "/auth/ticket" {
                let mut seen = loads.lock().unwrap();
                if seen.len() < 2 && seen.insert(payload.url().origin().ascii_serialization()) {
                    let _ = webview.eval(session_probe_script(&input.foreign_origin));
                }
            }
            if payload.url().path() == "/__shell/ticket-error" {
                let _ = webview.eval(ticket_error_probe_script());
            }
        })
        .setup(move |app| {
            progress("fixture-setup");
            #[cfg(windows)]
            {
                let sweep = plur1bus_desktop::windows_spa_profile::sweep(app.handle())
                    .expect("bounded owned SPA profile startup sweep");
                let _ = STARTUP_SWEEP.set(sweep);
            }
            let old_probe_for_title = old_probe_for_title.clone();
            let registering = known.clone();
            #[cfg(windows)]
            {
                let cleanup_known = known.clone();
                app.state::<SpaState>().set_native_profile_audit(Arc::new(move |path| {
                    let observation = audit(path, &cleanup_known.lock().unwrap());
                    if observation.audit_complete {
                        Ok(observation.secret_detected)
                    } else {
                        Err(std::io::Error::other("profile audit incomplete"))
                    }
                }));
            }
            app.state::<SpaState>()
                .set_native_secret_observer(Arc::new(move |s| {
                    registering
                        .lock()
                        .unwrap()
                        .push(SecretString::new(s.to_owned()));
                }));
            let start_connection = connection.clone();
            let start_tokens = tokens.clone();
            let start_store = store.clone();
            #[cfg(windows)]
            let first_profile_path_for_title = first_profile_path.clone();
            app.state::<SpaState>()
                .set_native_probe(Arc::new(move |window, title| {
                    if let Some(value) = title
                        .strip_prefix("OLD:")
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                    {
                        *old_probe_for_title.lock().unwrap() = Some(value);
                        return;
                    }
                    #[cfg(target_os = "linux")]
                    if window.url().ok().is_some_and(|url| {
                        retirement_phase_for_title.title(&url, &title)
                    }) {
                        match title.as_str() {
                            "WP05-ACL-SCRIPT-ENTRY" => progress("retirement-observer-script-entry"),
                            "WP05-ACL-IPC-AVAILABLE" => progress("retirement-observer-ipc-available"),
                            "WP05-ACL-IPC-START" => progress("retirement-observer-ipc-start"),
                            "WP05-ACL-IPC-COMPLETE" => progress("retirement-observer-ipc-complete"),
                            _ => {}
                        }
                        return;
                    }
                    let error = title.starts_with("ERR:");
                    let prefix = if error { "ERR:" } else { "WP5:" };
                    let Some(value) = title
                        .strip_prefix(prefix)
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                    else {
                        return;
                    };
                    let step = if error {
                        2
                    } else {
                        stage.fetch_add(1, Ordering::SeqCst)
                    };
                    if !error && step > 1 {
                        return;
                    }
                    progress("session-ready");
                    let app = window.app_handle().clone();
                    let proxy = app.state::<SpaState>().active_proxy().unwrap();
                    progress("proxy-obtained");
                    let known = known.clone();
                    let connection = connection.clone();
                    let tokens = tokens.clone();
                    let store = store.clone();
                    let results = results.clone();
                    let output = output.clone();
                    let negatives = negatives.clone();
                    let secondary_observation = secondary_observation.clone();
                    let measurements = measurements.clone();
                    let first_origin = first_origin.clone();
                    #[cfg(windows)]
                    let first_profile_path = first_profile_path_for_title.clone();
                    let old_probe_for_run = old_probe.clone();
                    #[cfg(target_os = "linux")]
                    let retirement_phase_for_run = retirement_phase.clone();
                    let browser_owners_for_run = browser_owners.clone();
                    tauri::async_runtime::spawn(async move {
                        progress("secrets-registering");
                        proxy.register_memory_secrets(|s| {
                            known.lock().unwrap().push(SecretString::new(s.to_owned()));
                        });
                        progress("secrets-registered");
                        if step < 2 {
                            let empty = window.cookies().is_ok_and(|v| v.is_empty());
                            #[cfg(windows)]
                            let (profile_path_verified, profile_acl_private, profile_isolated, profile_live_audit) = {
                                let path = app.state::<SpaState>().active_profile_path();
                                if let Some(path) = path {
                                    let root = plur1bus_desktop::windows_spa_profile::root_for_app(&app).ok();
                                    let owned = root.as_ref().is_some_and(|root| plur1bus_desktop::windows_spa_profile::is_owned_profile_path(root, &path));
                                    let isolated = if step == 0 {
                                        *first_profile_path.lock().unwrap() = Some(path.clone());
                                        owned
                                    } else {
                                        owned && first_profile_path.lock().unwrap().as_ref().is_some_and(|first| first != &path)
                                    };
                                    let (matched, acl) = plur1bus_desktop::windows_spa_profile::verify_webview_profile(
                                        &window, &path, std::time::Instant::now() + std::time::Duration::from_secs(5)
                                    ).await;
                                    let live = live_profile_audit(
                                        Some(path), known.clone(),
                                        std::time::Instant::now() + std::time::Duration::from_secs(5),
                                    ).await;
                                    (matched, acl, isolated, live)
                                } else { (false, false, false, AuditObservation::unavailable()) }
                            };
                            #[allow(unused_mut)]
                            let mut session = json!({
                                "browser": value,
                                "nativeCookieStoreEmpty": empty
                            });
                            #[cfg(windows)]
                            if let Value::Object(fields) = &mut session {
                                fields.insert("profilePathVerified".into(), json!(profile_path_verified));
                                fields.insert("profileAclPrivate".into(), json!(profile_acl_private));
                                fields.insert("profileIsolated".into(), json!(profile_isolated));
                                fields.insert("profileLiveAudit".into(), json!(profile_live_audit));
                            }
                            results.lock().unwrap().push(session);
                            progress("cookies-checked");
                        }
                        if step == 0 {
                            let upstream = connection.lock().unwrap().origin.clone();
                            *first_origin.lock().unwrap() = Some(proxy.origin().clone());
                            app.state::<SpaState>()
                                .set_fixture_old_origin(proxy.origin().clone());
                            progress("benchmark-start");
                            let measured = benchmark(&proxy, &upstream).await;
                            progress("benchmark-done");
                            *measurements.lock().unwrap() = measured;
                            let mut conn = connection.lock().unwrap().clone();
                            if let Some(current) = app.get_webview_window("spa") {
                                capture_browser_process(&current, &browser_owners_for_run);
                            }
                            if spa::open_spa(&app, &mut conn, tokens.as_ref(), store.as_ref())
                                .await
                                .is_err()
                            {
                                app.exit(3)
                            } else {
                                progress("second-window-opened")
                            }
                            return;
                        }
                        if step == 1 {
                            progress("negative-checks");
                            let old_origin = first_origin.lock().unwrap().clone();
                            let (controls, observation) = negative_controls(
                                &app,
                                &proxy,
                                old_origin,
                                old_probe_for_run,
                                browser_owners_for_run.clone(),
                                known.clone(),
                            )
                            .await;
                            *negatives.lock().unwrap() = controls;
                            *secondary_observation.lock().unwrap() = Some(observation);
                            let upstream = connection.lock().unwrap().origin.clone();
                            let response = bounded_http_client()
                                .post(format!("{}/__test/ticket-mode", upstream.as_str()))
                                .json(&json!({"reject": true}))
                                .send()
                                .await
                                .unwrap();
                            assert!(response.status().is_success());
                            progress("replay");
                            let replay = known.lock().unwrap()[1].expose().to_owned();
                            let mut url = url::Url::parse(&format!(
                                "{}/auth/ticket",
                                proxy.origin().as_str()
                            ))
                            .unwrap();
                            url.set_fragment(Some(&format!("t={replay}")));
                            window.navigate(url).unwrap();
                            return;
                        }
                        progress("error-page");
                        let observations = json!({
                            "ticketError": value,
                            "productionBenchmark": *measurements.lock().unwrap()
                        });
                        finish(
                            &app,
                            proxy,
                            output,
                            FinishInputs {
                                results,
                                known,
                                negative: negatives,
                                secondary_observation,
                                browser_owners: browser_owners_for_run,
                                #[cfg(target_os = "linux")]
                                retirement_phase: retirement_phase_for_run,
                            },
                            observations,
                        )
                        .await;
                    });
                }));
            let start = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                progress("fixture-open-spa-start");
                let mut conn = start_connection.lock().unwrap().clone();
                let open = tokio::time::timeout(std::time::Duration::from_secs(30), spa::open_spa(
                    &start,
                    &mut conn,
                    start_tokens.as_ref(),
                    start_store.as_ref(),
                )).await;
                match open {
                    Ok(Ok(())) => progress("fixture-open-spa-complete"),
                    Ok(Err(_)) => { progress("fixture-open-spa-failed"); start.exit(3); }
                    Err(_) => { progress("fixture-open-spa-timeout"); start.exit(3); }
                }
            });
            let timeout = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(80));
                timeout.exit(2);
            });
            Ok(())
        })
        .build(context)
        .expect("native fixture");
    app.run(|_, event| {
        if let tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } = event
        {
            api.prevent_exit();
        }
    });
}
async fn negative_controls(
    app: &tauri::AppHandle,
    proxy: &SpaProxy,
    first_origin: Option<Origin>,
    old_probe: Arc<Mutex<Option<Value>>>,
    browser_owners: BrowserProcessOwners,
    known: Secrets,
) -> (Value, SecondaryProbeObservation) {
    #[cfg(not(windows))]
    let _ = &known;
    let client = bounded_http_client();
    let url = format!("{}/", proxy.origin().as_str());
    let mut denied = true;
    for request in [
        client.get(&url),
        client.get(&url).header("user-agent", "wrong"),
        client
            .get(&url)
            .header("user-agent", proxy.user_agent())
            .header("host", "foreign.test"),
        client
            .get(&url)
            .header("user-agent", proxy.user_agent())
            .header("origin", "https://foreign.test"),
    ] {
        denied &= request.send().await.unwrap().status() == 403;
    }
    proxy.reset_secondary_probe_403();
    let secondary_url = format!("{}/?wp05-secondary-probe=1", proxy.origin().as_str());
    let (tx, rx) = tokio::sync::oneshot::channel::<SecondaryProbeResult>();
    let sender = Mutex::new(Some(tx));
    let phase1 = Arc::new(Mutex::new(None::<SecondaryProbeResult>));
    let phase1_for_title = phase1.clone();
    #[cfg(windows)]
    let other_profile =
        plur1bus_desktop::windows_spa_profile::create(app).expect("isolated other-window profile");
    progress("other-window-construction-start");
    let builder = WebviewWindowBuilder::new(
        app,
        "other-spa",
        WebviewUrl::External(secondary_url.parse().unwrap()),
    )
    .incognito(true)
    .user_agent("WP05-Secondary-Probe/1")
    .on_page_load(|webview, payload| {
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            if payload.url().query() == Some("wp05-secondary-probe=1") {
                progress("other-window-page-finished");
                match webview.eval(other_window_probe_script()) {
                    Ok(()) => progress("other-window-eval-submitted"),
                    Err(_) => progress("other-window-eval-failed"),
                }
            } else if is_bundled_acl_probe_url(payload.url()) {
                progress("other-window-local-page-finished");
                match webview.eval(local_acl_probe_script()) {
                    Ok(()) => progress("other-window-local-eval-submitted"),
                    Err(_) => progress("other-window-local-eval-failed"),
                }
            }
        }
    })
    .on_document_title_changed(move |webview, title| {
        if let Some(stage) = title.strip_prefix("NEG_STAGE:") {
            let label = match stage {
                "entry" => "other-window-script-entry",
                "fetch-start" => "other-window-fetch-start",
                "fetch-complete" => "other-window-fetch-complete",
                "fetch-error" => "other-window-fetch-error",
                "ipc-start" => "other-window-ipc-start",
                "ipc-complete" => "other-window-ipc-complete",
                _ => return,
            };
            progress(label);
            return;
        }
        if let Some(value) = title.strip_prefix("NEG:").map(parse_secondary_result) {
            progress("other-window-probe-complete");
            if !value.available {
                return;
            }
            *phase1_for_title.lock().unwrap() = Some(value);
            if webview.navigate(bundled_acl_probe_url()).is_err() {
                progress("other-window-local-eval-failed");
            }
            return;
        }
        if let Some(raw) = title.strip_prefix("NEG_LOCAL:") {
            progress("other-window-local-script-entry");
            let Some(local) = parse_local_acl_probe(raw) else {
                return;
            };
            let Some(mut phase1) = phase1_for_title.lock().unwrap().take() else {
                return;
            };
            phase1.local_ipc_available = local.ipc_available;
            phase1.local_acl_denied = local.acl_denied;
            progress("other-window-local-probe-complete");
            if let Some(tx) = sender.lock().unwrap().take() {
                let _ = tx.send(phase1);
            }
        }
    });
    #[cfg(windows)]
    let builder = builder.data_directory(other_profile.path().to_path_buf());
    let other = builder.build();
    let other = match other {
        Ok(other) => {
            progress("other-window-construction-complete");
            other
        }
        Err(_) => {
            progress("other-window-construction-failed");
            panic!("other native window construction failed")
        }
    };
    progress("other-window-wait-start");
    let mut value = match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
        Ok(Ok(value)) => value,
        Ok(Err(_)) => {
            progress("other-window-wait-channel-closed");
            panic!("other native window title channel closed")
        }
        Err(_) => {
            progress("other-window-wait-timeout");
            panic!("other native window probe timed out")
        }
    };
    value.native_cookie_store_empty = other.cookies().is_ok_and(|cookies| cookies.is_empty());
    #[cfg(windows)]
    let other_live_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    #[cfg(windows)]
    let (capture_complete, other_browser) =
        plur1bus_desktop::windows_spa_profile::complete_browser_capture(
            plur1bus_desktop::windows_spa_profile::capture_browser_process(&other, &other_profile),
            other_live_deadline,
        )
        .await;
    #[cfg(windows)]
    let native_live_audit;
    #[cfg(not(windows))]
    let native_live_audit = AuditObservation::unavailable();
    #[cfg(windows)]
    {
        let (matched, acl) = plur1bus_desktop::windows_spa_profile::verify_webview_profile(
            &other,
            other_profile.path(),
            other_live_deadline,
        )
        .await;
        value.profile_path_verified = matched;
        value.profile_acl_private = acl;
        let root = plur1bus_desktop::windows_spa_profile::root_for_app(app).ok();
        value.profile_isolated = root.as_ref().is_some_and(|root| {
            plur1bus_desktop::windows_spa_profile::is_owned_profile_path(root, other_profile.path())
        }) && app
            .state::<SpaState>()
            .active_profile_path()
            .is_some_and(|main| main != other_profile.path());
        native_live_audit = if capture_complete {
            live_profile_audit(
                Some(other_profile.path().to_path_buf()),
                known.clone(),
                other_live_deadline,
            )
            .await
        } else {
            AuditObservation::unavailable()
        };
    }
    capture_browser_process(&other, &browser_owners);
    #[cfg(windows)]
    let other_gone = Arc::new(AtomicBool::new(false));
    #[cfg(windows)]
    {
        let event_gone = other_gone.clone();
        other.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                event_gone.store(true, Ordering::SeqCst);
            }
        });
    }
    if other.destroy().is_err() {
        browser_owners.close_failed();
    }
    #[cfg(windows)]
    let other_cleanup = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        plur1bus_desktop::windows_spa_profile::cleanup_after_exit(
            other_profile,
            Some(other_browser),
            other_gone,
            Some(Arc::new(move |path| {
                let observation = audit(path, &known.lock().unwrap());
                if observation.audit_complete {
                    Ok(observation.secret_detected)
                } else {
                    Err(std::io::Error::other("profile audit incomplete"))
                }
            })),
        ),
    )
    .await
    .unwrap_or_default();
    let old_origin = if let Some(first_origin) = first_origin {
        *old_probe.lock().unwrap() = None;
        let old_url = format!("{}?wp05-old-check", first_origin.as_str());
        let current = app.get_webview_window("spa").unwrap();
        current.navigate(old_url.parse().unwrap()).unwrap();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Some(value) = old_probe.lock().unwrap().clone() {
                break value;
            }
            if tokio::time::Instant::now() >= deadline {
                break json!({"aclDenied":false,"rustCallerDenied":false,"timedOut":true});
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    } else {
        json!({"aclDenied":false})
    };
    #[allow(unused_mut)]
    let mut observation = auxiliary_observation(&value, native_live_audit);
    #[cfg(windows)]
    {
        observation.profile_cleanup_complete = other_cleanup.removed;
        observation.cleanup_cookie_rows = other_cleanup.cookie_rows;
        observation.cleanup_read_only_complete = other_cleanup.read_only_complete;
        observation.cleanup_secret_detected = other_cleanup.secret_detected;
    }
    let proxy_generated_403 = proxy.secondary_probe_403_observed();
    let mut phase1_snapshot = value.clone();
    phase1_snapshot.local_ipc_available = false;
    phase1_snapshot.local_acl_denied = false;
    let mut other_webview = serde_json::to_value(&value).unwrap();
    if let Some(object) = other_webview.as_object_mut() {
        object.insert(
            "phase1".into(),
            serde_json::to_value(&phase1_snapshot).unwrap(),
        );
        object.insert(
            "phase1OtherWindowAclDenied".into(),
            json!(value.other_window_acl_denied),
        );
        object.insert(
            "otherWindowAclDenied".into(),
            json!(observation.other_window_acl_denied),
        );
    }
    (
        json!({"missingWrongSecretHostOrigin":denied,"otherWebview":other_webview,"proxyGenerated403":proxy_generated_403,"oldOriginWhileReplacementActive":old_origin}),
        SecondaryProbeObservation {
            proxy_generated_403,
            ..observation
        },
    )
}
#[cfg(not(target_os = "linux"))]
async fn finish(
    app: &tauri::AppHandle,
    proxy: SpaProxy,
    output: PathBuf,
    inputs: FinishInputs,
    error: Value,
) {
    let teardown_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    progress("retire");
    let browser_owners = inputs.browser_owners.clone();
    let handle = app.clone();
    progress("retirement-window-close-start");
    let current = app.get_webview_window("spa");
    if let Some(current) = current.as_ref() {
        capture_browser_process(current, &browser_owners);
    }
    spa::retire(app).unwrap();
    if let Some(current) = current {
        if current.destroy().is_err() {
            browser_owners.close_failed();
            progress("retirement-window-close-failed");
        } else {
            progress("retirement-window-close-requested");
        }
    }
    let old_windows_absent =
        wait_for_fixture_windows(&handle, &["spa".to_owned()], teardown_deadline).await;
    if old_windows_absent {
        progress("retirement-window-close-complete");
    } else {
        progress("retirement-window-close-failed");
    }
    let finished = Arc::new(AtomicBool::new(false));
    let output = output.clone();
    let known = inputs.known.clone();
    let results = inputs.results.clone();
    let negative = inputs.negative.clone();
    let secondary_observation = inputs.secondary_observation.clone();
    let observer_owners = browser_owners.clone();
    let observer_url = format!("{}?wp05-old-check", proxy.origin().as_str());
    if teardown_deadline
        .saturating_duration_since(std::time::Instant::now())
        .is_zero()
    {
        progress("retirement-observer-create-failed");
        app.exit(2);
        return;
    }
    let timeout_finished = finished.clone();
    let timeout_app = app.clone();
    let timeout_output = output.clone();
    let timeout_results = results.clone();
    let timeout_known = known.clone();
    let timeout_negative = negative.clone();
    let timeout_secondary = secondary_observation.clone();
    let profile_observation = Arc::new(Mutex::new(PrivateProfileObservation::unavailable()));
    let profile_for_title = profile_observation.clone();
    let timeout_profile = profile_observation.clone();
    #[cfg(windows)]
    let observer_lease = plur1bus_desktop::windows_spa_profile::create(app)
        .expect("isolated retirement observer profile");
    #[cfg(windows)]
    let observer_path = observer_lease.path().to_path_buf();
    #[cfg(windows)]
    let observer_lease = Arc::new(Mutex::new(Some(observer_lease)));
    #[cfg(windows)]
    let observer_browser = Arc::new(Mutex::new(None));
    #[cfg(windows)]
    let observer_gone = Arc::new(AtomicBool::new(false));
    #[cfg(windows)]
    let title_lease = observer_lease.clone();
    #[cfg(windows)]
    let title_browser = observer_browser.clone();
    #[cfg(windows)]
    let title_gone = observer_gone.clone();
    progress("retirement-observer-build-start");
    let builder=WebviewWindowBuilder::new(app,"spa",WebviewUrl::External(observer_url.parse().unwrap())).incognito(true)
        .on_page_load(|webview, payload| {
            if payload.url().query() != Some("wp05-old-check") {
                progress("retirement-observer-unexpected-url");
                return;
            }
            match payload.event() {
                tauri::webview::PageLoadEvent::Started => {
                    progress("retirement-observer-page-started");
                }
                tauri::webview::PageLoadEvent::Finished => {
                    progress("retirement-observer-page-finished");
                    match webview.eval(retirement_observer_probe_script()) {
                        Ok(()) => progress("retirement-observer-eval-submitted"),
                        Err(_) => progress("retirement-observer-eval-rejected"),
                    }
                }
            }
        })
        .on_document_title_changed(move|window,title|{
            match title.as_str() {
                "WP05-ACL-SCRIPT-ENTRY" => progress("retirement-observer-script-entry"),
                "WP05-ACL-IPC-AVAILABLE" => progress("retirement-observer-ipc-available"),
                "WP05-ACL-IPC-MISSING" => progress("retirement-observer-ipc-missing"),
                "WP05-ACL-IPC-START" => progress("retirement-observer-ipc-start"),
                "WP05-ACL-IPC-COMPLETE" => progress("retirement-observer-ipc-complete"),
                _ => {}
            }
            let Some(acl)=title.strip_prefix("ACL:").and_then(|v|serde_json::from_str::<Value>(v).ok())else{return};
            progress("retirement-observer-title-complete");
            if !claim_observer_completion(&finished) {
                return;
            }
            let observer = window.clone();
            capture_browser_process(&observer, &observer_owners);
            let task_handle = handle.clone();
            let task_output = output.clone();
            let task_known = known.clone();
            let task_results = results.clone();
            let task_negative = negative.clone();
            let task_secondary = secondary_observation.clone();
            let task_profile = profile_for_title.clone();
            let task_owners = observer_owners.clone();
            let task_error = error.clone();
            let task_teardown_deadline = teardown_deadline;
            #[cfg(windows)]
            let task_lease = title_lease.clone();
            #[cfg(windows)]
            let task_browser = title_browser.clone();
            #[cfg(windows)]
            let task_gone = title_gone.clone();
            tauri::async_runtime::spawn(async move {
                progress("audit");
                let root = PathBuf::from(std::env::var_os("WP05_NATIVE_SCRATCH").unwrap());
                let live_root = root.clone();
                let live_known = task_known.clone();
                let pre_close_audit = tauri::async_runtime::spawn_blocking(move || {
                    let known = live_known.lock().unwrap();
                    audit(&live_root, &known)
                })
                .await
                .unwrap_or_else(|_| AuditObservation::unavailable());
                #[cfg(windows)]
                {
                    let path = task_lease
                        .lock()
                        .unwrap()
                        .as_ref()
                        .map(|lease| lease.path().to_path_buf());
                    let live = live_profile_audit(path, task_known.clone(), task_teardown_deadline).await;
                    task_profile.lock().unwrap().profile_live_audit = live;
                }
                if pre_close_audit.audit_complete {
                    progress("audit-live-scan-complete");
                } else {
                    progress("audit-live-scan-incomplete");
                }
                progress("retirement-observer-close-start");
                if task_teardown_deadline.saturating_duration_since(std::time::Instant::now()).is_zero() {
                    progress("retirement-observer-close-failed");
                }
                if observer.destroy().is_err() {
                    task_owners.close_failed();
                    progress("retirement-observer-close-failed");
                } else {
                    progress("retirement-observer-close-requested");
                }
                drop(observer);
                progress("teardown-wait-start");
                let windows_absent = wait_for_fixture_windows(
                    &task_handle,
                    &task_owners.tracked_windows(),
                    task_teardown_deadline,
                )
                .await;
                task_owners.mark_windows_absent(windows_absent);
                let process_exit = wait_for_browser_processes(
                    task_owners.clone(),
                    task_teardown_deadline,
                )
                .await;
                if windows_absent && (!process_exit.applicable || process_exit.complete) {
                    progress("teardown-wait-complete");
                } else {
                    progress("teardown-wait-failed");
                }
                #[cfg(windows)]
                let spa_cleanup = task_handle.state::<SpaState>()
                    .wait_profile_cleanups(task_teardown_deadline)
                    .await;
                #[cfg(windows)]
                let observer_cleanup = {
                    let lease = task_lease.lock().unwrap().take();
                    let browser = task_browser.lock().unwrap().take();
                    if let Some(lease) = lease {
                        let remaining = task_teardown_deadline.saturating_duration_since(std::time::Instant::now());
                        let audit_known = task_known.clone();
                        let secret_audit = Arc::new(move |path: &std::path::Path| {
                            let observation = audit(path, &audit_known.lock().unwrap());
                            if observation.audit_complete { Ok(observation.secret_detected) }
                            else { Err(std::io::Error::other("profile audit incomplete")) }
                        });
                        tokio::time::timeout(remaining, plur1bus_desktop::windows_spa_profile::cleanup_after_exit(lease, browser, task_gone, Some(secret_audit)))
                            .await.unwrap_or_default()
                    } else { Default::default() }
                };
                #[cfg(not(windows))]
                let profile_cleanup_complete = true;
                #[cfg(not(windows))]
                let cleanup_cookie_rows = 0;
                #[cfg(not(windows))]
                let cleanup_read_only_complete = true;
                #[cfg(not(windows))]
                let cleanup_secret_detected = false;
                #[cfg(windows)]
                let profile_cleanup_complete = spa_cleanup.removed && observer_cleanup.removed;
                #[cfg(windows)]
                let cleanup_cookie_rows = spa_cleanup.cookie_rows.saturating_add(observer_cleanup.cookie_rows);
                #[cfg(windows)]
                let cleanup_read_only_complete = spa_cleanup.read_only_complete && observer_cleanup.read_only_complete;
                #[cfg(windows)]
                let cleanup_secret_detected = spa_cleanup.secret_detected || observer_cleanup.secret_detected;
                let closed_root = root.clone();
                let closed_known = task_known.clone();
                let audit_observation = tauri::async_runtime::spawn_blocking(move || {
                    let known = closed_known.lock().unwrap();
                    audit(&closed_root, &known)
                })
                .await
                .unwrap_or_else(|_| AuditObservation::unavailable());
                if audit_observation.audit_complete {
                    progress("audit-closed-scan-complete");
                } else {
                    progress("audit-closed-scan-incomplete");
                }
                let teardown = TeardownObservation {
                    process_exit_applicable: process_exit.applicable,
                    capture_complete: task_owners.capture_complete(process_exit.applicable),
                    close_complete: task_owners.close_complete(),
                    process_exit_complete: process_exit.complete,
                    audit_complete: audit_observation.audit_complete,
                    profile_cleanup_complete,
                    cleanup_cookie_rows,
                    cleanup_read_only_complete,
                    cleanup_secret_detected,
                };
                let secondary = task_secondary
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(SecondaryProbeObservation::unavailable);
                let diagnostic = NativeDiagnostic {
                    secondary_probe: secondary,
                    pre_close_audit: pre_close_audit.clone(),
                    audit: audit_observation.clone(),
                    teardown: teardown.clone(),
                    profile: task_profile.lock().unwrap().clone(),
                };
                let live_positive = !diagnostic.pre_close_audit.live_clean();
                #[cfg(windows)]
                let sessions_live_clean = {
                    let sessions = task_results.lock().unwrap();
                    sessions.len() == 2
                        && sessions.iter().all(|session| {
                            serde_json::from_value::<AuditObservation>(
                                session["profileLiveAudit"].clone(),
                            )
                            .is_ok_and(|audit| audit.live_clean())
                        })
                };
                #[cfg(not(windows))]
                let sessions_live_clean = true;
                let mut diagnostic_pass = diagnostic.secondary_probe.available
                    && diagnostic.secondary_probe.native_cookie_store_empty
                    && diagnostic.secondary_probe.profile_cleanup_complete
                    && diagnostic.secondary_probe.cleanup_cookie_rows == 0
                    && diagnostic.secondary_probe.cleanup_read_only_complete
                    && !diagnostic.secondary_probe.cleanup_secret_detected
                    && ( !cfg!(windows) || diagnostic.secondary_probe.profile_live_audit.live_clean())
                    && (!cfg!(windows) || (diagnostic.secondary_probe.profile_path_verified && diagnostic.secondary_probe.profile_acl_private && diagnostic.secondary_probe.profile_isolated))
                    && !live_positive
                    && (cfg!(windows) || diagnostic.pre_close_audit.cookie_database_files == 0)
                    && diagnostic.audit.clean()
                    && diagnostic.teardown.clean()
                    && diagnostic.profile.accepted()
                    && sessions_live_clean
                    && (!cfg!(windows) || {
                        #[cfg(windows)]
                        { STARTUP_SWEEP.get().is_some_and(|sweep| sweep.complete()) }
                        #[cfg(not(windows))]
                        { false }
                    })
                    && std::time::Instant::now() < task_teardown_deadline;
                #[allow(unused_mut)]
                let mut report=json!({"result":if diagnostic_pass{"passed"}else{"failed"},"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"tauri":"2.12.0","nativeMainEntered":true,"knownSecretKinds":["deviceBearer","tickets","launchCarrier","sessionCookies","browserCsrf"],"sessions":*task_results.lock().unwrap(),"retirement":acl,"negativeControls":*task_negative.lock().unwrap(),"ticketError":task_error["ticketError"],"productionBenchmark":task_error["productionBenchmark"],"secretOnDisk":diagnostic.audit.secret_detected,"cookieDatabaseFiles":diagnostic.audit.cookie_database_files,"preCloseAudit":pre_close_audit,"teardown":teardown,"diagnostic":diagnostic});
                #[cfg(windows)]
                if let Value::Object(fields) = &mut report {
                    fields.insert("startupSweep".into(), json!(STARTUP_SWEEP.get().copied()));
                }
                let mut bytes=match serde_json::to_vec_pretty(&report){Ok(bytes)=>{progress("audit-report-serialized");bytes},Err(_)=>{progress("audit-report-serialization-failed");task_handle.exit(2);return}};
                if contains_secret(&bytes,&task_known.lock().unwrap()){progress("audit-report-secret-detected");task_handle.exit(2);return}
                if std::time::Instant::now() >= task_teardown_deadline {
                    diagnostic_pass = false;
                    report["result"] = json!("failed");
                    bytes = serde_json::to_vec_pretty(&report).unwrap();
                }
                if std::fs::write(&task_output,&bytes).is_err(){progress("audit-report-write-failed");task_handle.exit(2);return}
                progress("audit-report-written");
                if std::time::Instant::now() >= task_teardown_deadline {
                    diagnostic_pass = false;
                    report["result"] = json!("failed");
                    let _ = std::fs::write(&task_output, serde_json::to_vec_pretty(&report).unwrap());
                }
                if !diagnostic_pass{progress("audit-failed");task_handle.exit(2);return}
                progress("audit-passed");task_handle.exit(0);
            });
        });
    #[cfg(windows)]
    let builder = builder.data_directory(observer_path);
    let observer = builder.build();
    let observer = match observer {
        Ok(observer) => {
            progress("retirement-observer-build-complete");
            #[cfg(windows)]
            {
                let gone = observer_gone.clone();
                observer.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        gone.store(true, Ordering::SeqCst);
                    }
                });
                observer_browser.lock().unwrap().replace(
                    plur1bus_desktop::windows_spa_profile::capture_browser_process(
                        &observer,
                        observer_lease.lock().unwrap().as_ref().unwrap(),
                    ),
                );
            }
            if teardown_deadline
                .saturating_duration_since(std::time::Instant::now())
                .is_zero()
            {
                progress("retirement-observer-build-deadline-exhausted");
            }
            progress("retirement-observer-main-thread-dispatch-requested");
            let callback_deadline = teardown_deadline;
            if app
                .run_on_main_thread(move || {
                    if std::time::Instant::now() <= callback_deadline {
                        progress("retirement-observer-main-thread-callback-before-deadline");
                    } else {
                        progress("retirement-observer-main-thread-callback-after-deadline");
                    }
                })
                .is_err()
            {
                progress("retirement-observer-main-thread-dispatch-request-failed");
            }
            let _ =
                inspect_private_profile(&observer, profile_observation.clone(), teardown_deadline)
                    .await;
            #[cfg(windows)]
            {
                let path = observer_lease
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|lease| lease.path().to_path_buf());
                if let Some(path) = path {
                    let (matched, acl) =
                        plur1bus_desktop::windows_spa_profile::verify_webview_profile(
                            &observer,
                            &path,
                            teardown_deadline,
                        )
                        .await;
                    let mut state = profile_observation.lock().unwrap();
                    state.profile_path_verified = matched;
                    state.profile_acl_private = acl;
                }
            }
            observer
        }
        Err(_) => {
            progress("retirement-observer-create-failed");
            app.exit(3);
            return;
        }
    };
    let timeout_observer = observer.clone();
    tauri::async_runtime::spawn(async move {
        let remaining = teardown_deadline.saturating_duration_since(std::time::Instant::now());
        tokio::time::sleep(remaining).await;
        if !claim_observer_completion(&timeout_finished) {
            return;
        }
        progress("retirement-observer-timeout");
        progress("retirement-observer-close-start");
        if timeout_observer.destroy().is_err() {
            progress("retirement-observer-close-failed");
        } else {
            progress("retirement-observer-close-requested");
        }
        drop(timeout_observer);
        write_observer_timeout_report(
            &timeout_app,
            &timeout_output,
            &timeout_results,
            &timeout_known,
            &timeout_negative,
            &timeout_secondary,
            &timeout_profile,
        );
    });
}

#[cfg(target_os = "linux")]
async fn finish(
    app: &tauri::AppHandle,
    proxy: SpaProxy,
    output: PathBuf,
    inputs: FinishInputs,
    error: Value,
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let observation_cutoff = deadline - std::time::Duration::from_secs(2);
    let live_audit_cutoff = deadline - std::time::Duration::from_millis(1500);
    let teardown_cutoff = deadline - std::time::Duration::from_millis(1100);
    let closed_audit_cutoff = deadline - std::time::Duration::from_millis(700);
    let finalization_cutoff = deadline - std::time::Duration::from_millis(400);
    progress("retire");
    let owners = inputs.browser_owners.clone();
    let window = app.get_webview_window("spa");
    if let Some(window) = window.as_ref() {
        capture_browser_process(window, &owners);
    }
    let marker_url = url::Url::parse(&format!("{}?wp05-old-check", proxy.origin().as_str()))
        .expect("exact retired proxy marker URL");
    let (completion, receiver) = tokio::sync::oneshot::channel();
    inputs.retirement_phase.arm(marker_url.clone(), completion);
    let marker_seen = AtomicBool::new(false);
    let close_claimed = Arc::new(AtomicBool::new(false));
    let gate = Arc::new(LinuxPublicationGate::default());
    let failure_writer = LinuxFailureWriter {
        app: app.clone(),
        output: output.clone(),
        results: inputs.results.clone(),
        known: inputs.known.clone(),
        negative: inputs.negative.clone(),
        secondary: inputs.secondary_observation.clone(),
        profile: Arc::new(Mutex::new(PrivateProfileObservation::unavailable())),
        gate: gate.clone(),
    };
    // This guard has no disk work. It remains armed after publication ownership
    // is claimed and requests failure if actual reporting or exit runs late.
    let deadline_gate = gate.clone();
    let deadline_writer = failure_writer.clone();
    let deadline_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(deadline.saturating_duration_since(std::time::Instant::now()));
        if deadline_gate.deadline_expired() {
            deadline_writer.start();
            deadline_app.exit(2);
        }
    });
    let watchdog_app = app.clone();
    let watchdog_window = window.clone();
    let watchdog_owners = owners.clone();
    let watchdog_close = close_claimed.clone();
    let watchdog_gate = gate.clone();
    let watchdog_phase = inputs.retirement_phase.clone();
    let watchdog_writer = failure_writer.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep_until(tokio::time::Instant::from_std(finalization_cutoff)).await;
        if !claim_observer_completion(&watchdog_gate.owner) {
            return;
        }
        progress("retirement-observer-timeout");
        close_linux_spa_once(watchdog_window.as_ref(), &watchdog_owners, &watchdog_close);
        watchdog_phase.disarm();
        drop(watchdog_window);
        let windows_absent = wait_for_fixture_windows(
            &watchdog_app,
            &watchdog_owners.tracked_windows(),
            deadline - std::time::Duration::from_millis(300),
        )
        .await;
        watchdog_owners.mark_windows_absent(windows_absent);
        let _ = bounded_linux_work(
            deadline - std::time::Duration::from_millis(300),
            wait_for_browser_processes(watchdog_owners, deadline),
        )
        .await;
        watchdog_writer.start();
    });

    // All stage cutoffs derive from the one deadline and reserve time for the
    // live audit, teardown, closed audit, and final report.
    let observed = bounded_linux_work(observation_cutoff, async {
        spa::retire(app).map_err(|_| "retirement-observer-retire-failed")?;
        let response = bounded_http_client()
            .get(marker_url.clone())
            .send()
            .await
            .map_err(|_| "retirement-observer-proxy-check-failed")?;
        let forbidden = response.status() == reqwest::StatusCode::FORBIDDEN
            && response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok())
                == Some("text/html; charset=utf-8")
            && response.text().await.map_err(|_| "retirement-observer-proxy-check-failed")?
                == "<!doctype html><meta charset=\"utf-8\"><title>WP05 diagnostic forbidden document</title><body>Forbidden</body>";
        if !forbidden {
            return Err("retirement-observer-proxy-check-failed");
        }
        marker_seen.store(true, Ordering::SeqCst);
        progress("retirement-observer-proxy-403-confirmed");
        let Some(window) = window.as_ref() else {
            return Err("retirement-observer-navigation-failed");
        };
        if window.navigate(marker_url).is_err() {
            return Err("retirement-observer-navigation-failed");
        }
        progress("retirement-observer-navigation-requested");
        receiver.await.map_err(|_| "retirement-observer-ipc-missing")
    }).await;
    let (acl, observation_complete) = match observed {
        Some(Ok(acl)) => {
            let valid = valid_retirement_acl(&acl);
            if !valid {
                progress("retirement-observer-ipc-invalid");
            }
            (acl, valid)
        }
        Some(Err(stage)) => {
            progress(stage);
            (json!({"actualAclDenied":false}), false)
        }
        None => {
            progress("retirement-observer-timeout");
            (json!({"actualAclDenied":false}), false)
        }
    };
    let proxy_generated_403 = marker_seen.load(Ordering::SeqCst);
    inputs.retirement_phase.disarm();

    progress("audit");
    let root = PathBuf::from(std::env::var_os("WP05_NATIVE_SCRATCH").unwrap());
    let pre_close_audit =
        bounded_linux_audit(root.clone(), inputs.known.clone(), live_audit_cutoff).await;
    if pre_close_audit.audit_complete {
        progress("audit-live-scan-complete");
    } else {
        progress("audit-live-scan-incomplete");
    }
    close_linux_spa_once(window.as_ref(), &owners, &close_claimed);
    drop(window);
    progress("teardown-wait-start");
    let windows_absent =
        wait_for_fixture_windows(app, &owners.tracked_windows(), teardown_cutoff).await;
    owners.mark_windows_absent(windows_absent);
    let process_exit = bounded_linux_work(
        teardown_cutoff,
        wait_for_browser_processes(owners.clone(), teardown_cutoff),
    )
    .await
    .unwrap_or(ProcessExitObservation {
        applicable: false,
        complete: false,
    });
    if windows_absent && process_exit.complete {
        progress("teardown-wait-complete");
    } else {
        progress("teardown-wait-failed");
    }
    let audit_observation =
        bounded_linux_audit(root, inputs.known.clone(), closed_audit_cutoff).await;
    if audit_observation.audit_complete {
        progress("audit-closed-scan-complete");
    } else {
        progress("audit-closed-scan-incomplete");
    }
    let teardown = TeardownObservation {
        process_exit_applicable: process_exit.applicable,
        capture_complete: owners.capture_complete(process_exit.applicable),
        close_complete: owners.close_complete(),
        process_exit_complete: process_exit.complete,
        audit_complete: audit_observation.audit_complete,
        profile_cleanup_complete: true,
        cleanup_cookie_rows: 0,
        cleanup_read_only_complete: true,
        cleanup_secret_detected: false,
    };
    let secondary = inputs
        .secondary_observation
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(SecondaryProbeObservation::unavailable);
    let diagnostic = NativeDiagnostic {
        secondary_probe: secondary,
        pre_close_audit: pre_close_audit.clone(),
        audit: audit_observation.clone(),
        teardown: teardown.clone(),
        profile: PrivateProfileObservation::unavailable(),
    };
    let pass = observation_complete
        && proxy_generated_403
        && diagnostic.secondary_probe.available
        && diagnostic.secondary_probe.native_cookie_store_empty
        && diagnostic.secondary_probe.profile_cleanup_complete
        && diagnostic.secondary_probe.cleanup_cookie_rows == 0
        && diagnostic.secondary_probe.cleanup_read_only_complete
        && !diagnostic.secondary_probe.cleanup_secret_detected
        && diagnostic.pre_close_audit.live_clean()
        && diagnostic.pre_close_audit.cookie_database_files == 0
        && diagnostic.audit.clean()
        && diagnostic.teardown.clean()
        && process_exit.complete
        && diagnostic.profile.accepted()
        && std::time::Instant::now() < finalization_cutoff;
    let retirement = json!({
        "actualAclDenied": acl["actualAclDenied"],
        "ipcAvailable": acl["ipcAvailable"],
        "ipcCompleted": acl["ipcCompleted"],
        "typeError": acl["typeError"],
        "proxyGenerated403": proxy_generated_403,
    });
    let report = json!({"result":if pass{"passed"}else{"failed"},"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"tauri":"2.12.0","nativeMainEntered":true,"knownSecretKinds":["deviceBearer","tickets","launchCarrier","sessionCookies","browserCsrf"],"sessions":*inputs.results.lock().unwrap(),"retirement":retirement,"negativeControls":*inputs.negative.lock().unwrap(),"ticketError":error["ticketError"],"productionBenchmark":error["productionBenchmark"],"secretOnDisk":diagnostic.audit.secret_detected,"cookieDatabaseFiles":diagnostic.audit.cookie_database_files,"preCloseAudit":pre_close_audit,"teardown":teardown,"diagnostic":diagnostic});
    let mut failed_report = report.clone();
    failed_report["result"] = json!("failed");
    let bytes = match serde_json::to_vec_pretty(&report) {
        Ok(bytes) => {
            progress("audit-report-serialized");
            bytes
        }
        Err(_) => {
            progress("audit-report-serialization-failed");
            app.exit(2);
            return;
        }
    };
    if contains_secret(&bytes, &inputs.known.lock().unwrap()) {
        progress("audit-report-secret-detected");
        return;
    }
    let failed_bytes = match serde_json::to_vec_pretty(&failed_report) {
        Ok(bytes) => bytes,
        Err(_) => {
            progress("audit-report-serialization-failed");
            return;
        }
    };
    let pending = output.with_extension("pending");
    let io = NativeLinuxReportIo {
        app,
        output: &output,
        pending: &pending,
    };
    publish_linux_report(
        &gate,
        &io,
        finalization_cutoff,
        deadline,
        pass,
        &bytes,
        &failed_bytes,
    );
}
fn contains_secret(bytes: &[u8], secrets: &[SecretString]) -> bool {
    secrets.iter().any(|s| {
        !s.expose().is_empty()
            && bytes
                .windows(s.expose().len())
                .any(|v| v == s.expose().as_bytes())
    })
}

#[cfg(test)]
fn parse_secondary_probe(raw: &str) -> SecondaryProbeObservation {
    serde_json::from_str(raw).unwrap_or_else(|_| SecondaryProbeObservation::unavailable())
}

fn parse_secondary_result(raw: &str) -> SecondaryProbeResult {
    serde_json::from_str(raw).unwrap_or_else(|_| SecondaryProbeResult::unavailable())
}

struct FilesystemAuditReader;

fn classify_file_read_error(error: &std::io::Error) -> AuditFailureCategory {
    #[cfg(windows)]
    {
        match error.raw_os_error() {
            Some(5) => AuditFailureCategory::FileReadAccessDenied,
            Some(2 | 3) => AuditFailureCategory::FileReadMissing,
            Some(32 | 33) => AuditFailureCategory::FileReadSharing,
            _ => AuditFailureCategory::FileReadOther,
        }
    }
    #[cfg(not(windows))]
    {
        match error.kind() {
            std::io::ErrorKind::PermissionDenied => AuditFailureCategory::FileReadAccessDenied,
            std::io::ErrorKind::NotFound => AuditFailureCategory::FileReadMissing,
            _ => AuditFailureCategory::FileReadOther,
        }
    }
}

impl AuditReader for FilesystemAuditReader {
    fn read_dir(
        &mut self,
        root: &std::path::Path,
    ) -> Result<Vec<AuditEntry>, AuditFailureCategory> {
        let entries = std::fs::read_dir(root).map_err(|_| AuditFailureCategory::ReadDir)?;
        entries
            .map(|entry| {
                let entry = entry.map_err(|_| AuditFailureCategory::EntryDisappeared)?;
                let path = entry.path();
                let file_type = entry
                    .file_type()
                    .map_err(|_| AuditFailureCategory::Metadata)?;
                let kind = if file_type.is_symlink() {
                    AuditEntryKind::Symlink
                } else if file_type.is_dir() {
                    AuditEntryKind::Directory
                } else if file_type.is_file() {
                    AuditEntryKind::File
                } else {
                    AuditEntryKind::Other
                };
                Ok(AuditEntry {
                    cookie_database: is_cookie_database(&path),
                    path,
                    kind,
                })
            })
            .collect()
    }

    fn read_file(&mut self, path: &std::path::Path) -> Result<Vec<u8>, AuditFailureCategory> {
        #[cfg(windows)]
        if let Some(record) = plur1bus_desktop::windows_spa_profile::read_owned_lease(path)
            .map_err(|error| classify_file_read_error(&error))?
        {
            return Ok(record);
        }
        std::fs::read(path).map_err(|error| classify_file_read_error(&error))
    }

    fn cookie_rows(&mut self, path: &std::path::Path) -> Result<u64, AuditFailureCategory> {
        #[cfg(windows)]
        return plur1bus_desktop::windows_spa_profile::cookie_rows(path)
            .map_err(|_| AuditFailureCategory::CookieQuery);
        #[cfg(not(windows))]
        {
            let _ = path;
            Ok(0)
        }
    }
}

fn is_cookie_database(path: &std::path::Path) -> bool {
    cookie_file_class(path).is_some()
}

fn cookie_file_class(path: &std::path::Path) -> Option<CookieFileClass> {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name.starts_with("cookies")
        && (name.ends_with("-journal") || name.ends_with("-wal") || name.ends_with("-shm"))
    {
        Some(CookieFileClass::Sidecar)
    } else if name == "cookies"
        || name.starts_with("cookies.sqlite")
        || name.starts_with("cookies.binarycookies")
    {
        Some(CookieFileClass::Primary)
    } else if name.starts_with("cookies-") {
        Some(CookieFileClass::Sidecar)
    } else {
        None
    }
}

#[cfg(not(target_os = "linux"))]
fn audit(root: &std::path::Path, secrets: &[SecretString]) -> AuditObservation {
    let mut reader = FilesystemAuditReader;
    #[cfg(windows)]
    let native_profile_root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("app.plur1bus.desktop").join("spa-tmp"));
    #[cfg(not(windows))]
    let native_profile_root = std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR")
        .map(PathBuf::from)
        .map(|path| path.join("native-profile"));
    audit_with_reader_and_profile_root(root, secrets, &mut reader, native_profile_root.as_deref())
}

#[cfg(any(target_os = "linux", test))]
struct DeadlineAuditReader {
    inner: FilesystemAuditReader,
    deadline: std::time::Instant,
}

#[cfg(any(target_os = "linux", test))]
impl DeadlineAuditReader {
    fn ready(&self) -> Result<(), AuditFailureCategory> {
        if std::time::Instant::now() < self.deadline {
            Ok(())
        } else {
            Err(AuditFailureCategory::Deadline)
        }
    }
}

#[cfg(any(target_os = "linux", test))]
impl AuditReader for DeadlineAuditReader {
    fn read_dir(
        &mut self,
        root: &std::path::Path,
    ) -> Result<Vec<AuditEntry>, AuditFailureCategory> {
        self.ready()?;
        self.inner.read_dir(root)
    }

    fn read_file(&mut self, path: &std::path::Path) -> Result<Vec<u8>, AuditFailureCategory> {
        self.ready()?;
        self.inner.read_file(path)
    }

    fn cookie_rows(&mut self, path: &std::path::Path) -> Result<u64, AuditFailureCategory> {
        self.ready()?;
        self.inner.cookie_rows(path)
    }
}

#[cfg(any(target_os = "linux", test))]
fn audit_until(
    root: &std::path::Path,
    secrets: &[SecretString],
    deadline: std::time::Instant,
) -> AuditObservation {
    let native_profile_root = std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR")
        .map(PathBuf::from)
        .map(|path| path.join("native-profile"));
    let mut reader = DeadlineAuditReader {
        inner: FilesystemAuditReader,
        deadline,
    };
    audit_with_reader_and_profile_root(root, secrets, &mut reader, native_profile_root.as_deref())
}

#[cfg(any(target_os = "linux", test))]
async fn bounded_linux_audit(
    root: PathBuf,
    known: Secrets,
    cutoff: std::time::Instant,
) -> AuditObservation {
    if std::time::Instant::now() >= cutoff {
        return AuditObservation::deadline_exceeded();
    }
    // The disk worker owns a snapshot, so a stalled filesystem read cannot hold the
    // secret registry lock needed by the failure report or a later closed audit.
    let secrets: Vec<SecretString> = known
        .lock()
        .unwrap()
        .iter()
        .map(|value| SecretString::new(value.expose().to_owned()))
        .collect();
    let worker = tauri::async_runtime::spawn_blocking(move || audit_until(&root, &secrets, cutoff));
    match bounded_linux_work(cutoff, worker).await {
        Some(Ok(observation)) => observation,
        _ => AuditObservation::deadline_exceeded(),
    }
}

#[cfg(windows)]
async fn live_profile_audit(
    path: Option<PathBuf>,
    known: Secrets,
    deadline: std::time::Instant,
) -> AuditObservation {
    let Some(path) = path else {
        return AuditObservation::unavailable();
    };
    if !plur1bus_desktop::windows_spa_profile::wait_for_owned_lease_record(&path, deadline).await {
        return AuditObservation::unavailable();
    }
    tauri::async_runtime::spawn_blocking(move || audit(&path, &known.lock().unwrap()))
        .await
        .unwrap_or_else(|_| AuditObservation::unavailable())
}

#[cfg(test)]
fn audit_with_reader<R: AuditReader>(
    root: &std::path::Path,
    secrets: &[SecretString],
    reader: &mut R,
) -> AuditObservation {
    audit_with_reader_and_profile_root(root, secrets, reader, None)
}

fn audit_with_reader_and_profile_root<R: AuditReader>(
    root: &std::path::Path,
    secrets: &[SecretString],
    reader: &mut R,
    native_profile_root: Option<&std::path::Path>,
) -> AuditObservation {
    const MAX_AUDIT_ITEMS: usize = 4096;
    let mut observation = AuditObservation {
        audit_complete: false,
        secret_detected: false,
        cookie_database_files: 0,
        cookie_rows: 0,
        cookie_read_only_complete: true,
        cookie_database_native_profile_files: 0,
        cookie_database_other_root_files: 0,
        cookie_database_primary_files: 0,
        cookie_database_sidecar_files: 0,
        read_failures: 0,
        entries_disappeared: 0,
        metadata_failures: 0,
        read_dir_failures: 0,
        symlink_entries: 0,
        failure_category: AuditFailureCategory::None,
    };
    let mut pending = vec![root.to_path_buf()];
    let mut visited = 0;
    while let Some(path) = pending.pop() {
        let entries = match reader.read_dir(&path) {
            Ok(entries) => entries,
            Err(category) => {
                record_audit_failure(&mut observation, category);
                return observation;
            }
        };
        for entry in entries {
            visited += 1;
            if visited > MAX_AUDIT_ITEMS {
                record_audit_failure(&mut observation, AuditFailureCategory::CounterLimit);
                return observation;
            }
            match entry.kind {
                AuditEntryKind::Directory => pending.push(entry.path),
                AuditEntryKind::Symlink => {
                    record_audit_failure(&mut observation, AuditFailureCategory::Symlink);
                    return observation;
                }
                AuditEntryKind::Other => {
                    record_audit_failure(&mut observation, AuditFailureCategory::Metadata);
                    return observation;
                }
                AuditEntryKind::File => {
                    if entry.cookie_database {
                        observation.cookie_database_files += 1;
                        if native_profile_root
                            .is_some_and(|profile| entry.path.starts_with(profile))
                        {
                            observation.cookie_database_native_profile_files += 1;
                        } else {
                            observation.cookie_database_other_root_files += 1;
                        }
                        match cookie_file_class(&entry.path) {
                            Some(CookieFileClass::Primary) => {
                                observation.cookie_database_primary_files += 1;
                                match reader.cookie_rows(&entry.path) {
                                    Ok(rows) => {
                                        observation.cookie_rows =
                                            observation.cookie_rows.saturating_add(rows)
                                    }
                                    Err(category) => {
                                        observation.cookie_read_only_complete = false;
                                        record_audit_failure(&mut observation, category);
                                        return observation;
                                    }
                                }
                            }
                            Some(CookieFileClass::Sidecar) => {
                                observation.cookie_database_sidecar_files += 1;
                            }
                            None => {}
                        }
                    }
                    let bytes = match reader.read_file(&entry.path) {
                        Ok(bytes) => bytes,
                        Err(category) => {
                            record_audit_failure(&mut observation, category);
                            return observation;
                        }
                    };
                    observation.secret_detected |= contains_secret(&bytes, secrets);
                }
            }
        }
    }
    observation.audit_complete = true;
    if observation.secret_detected {
        observation.failure_category = AuditFailureCategory::SecretDetected;
    } else if observation.cookie_rows > 0
        || (observation.cookie_database_files > 0 && !cfg!(windows))
    {
        observation.failure_category = AuditFailureCategory::CookieDatabase;
    }
    observation
}

fn record_audit_failure(observation: &mut AuditObservation, category: AuditFailureCategory) {
    match category {
        AuditFailureCategory::ReadDir => {
            observation.read_dir_failures = observation.read_dir_failures.saturating_add(1)
        }
        AuditFailureCategory::EntryDisappeared => {
            observation.entries_disappeared = observation.entries_disappeared.saturating_add(1)
        }
        AuditFailureCategory::Metadata => {
            observation.metadata_failures = observation.metadata_failures.saturating_add(1)
        }
        AuditFailureCategory::FileRead => {
            observation.read_failures = observation.read_failures.saturating_add(1)
        }
        AuditFailureCategory::FileReadSharing
        | AuditFailureCategory::FileReadAccessDenied
        | AuditFailureCategory::FileReadMissing
        | AuditFailureCategory::FileReadOther => {
            observation.read_failures = observation.read_failures.saturating_add(1)
        }
        AuditFailureCategory::Symlink => {
            observation.symlink_entries = observation.symlink_entries.saturating_add(1)
        }
        AuditFailureCategory::CounterLimit
        | AuditFailureCategory::Deadline
        | AuditFailureCategory::SecretDetected
        | AuditFailureCategory::CookieDatabase
        | AuditFailureCategory::CookieQuery
        | AuditFailureCategory::None => {}
    }
    if observation.failure_category == AuditFailureCategory::None {
        observation.failure_category = category;
    }
}

const MAX_PROGRESS_STAGES: usize = 128;
const MAX_PROGRESS_BYTES: usize = 4096;

fn append_progress_history(history: &str, label: &str) -> Option<String> {
    if history.len() <= MAX_PROGRESS_BYTES
        && history.lines().count() < MAX_PROGRESS_STAGES
        && history.len().saturating_add(label.len()).saturating_add(1) <= MAX_PROGRESS_BYTES
    {
        Some(format!("{history}{label}\n"))
    } else {
        None
    }
}

fn progress(label: &str) {
    static PROGRESS_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    if let Some(path) = std::env::args_os().nth(1) {
        let _guard = PROGRESS_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap();
        let path = PathBuf::from(path);
        let _ = std::fs::write(path.with_extension("progress"), label);
        let history_path = path.with_extension("progress-history");
        let mut history = String::new();
        if let Ok(file) = std::fs::File::open(&history_path) {
            let _ = file
                .take((MAX_PROGRESS_BYTES + 1) as u64)
                .read_to_string(&mut history);
        }
        if let Some(next) = append_progress_history(&history, label) {
            let _ = std::fs::write(history_path, next);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::LinuxReportIo;
    use super::{
        append_progress_history, audit_with_reader, audit_with_reader_and_profile_root,
        auxiliary_observation, await_profile_callback, claim_observer_completion,
        classify_file_read_error, cookie_file_class, local_acl_probe_script,
        other_window_probe_script, parse_secondary_probe, parse_secondary_result, AuditEntry,
        AuditEntryKind, AuditFailureCategory, AuditObservation, AuditReader, BrowserProcessOwners,
        CookieFileClass, OwnedBrowserProcess, PrivateProfileObservation, TeardownObservation,
    };
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct DelayedReportIo {
        output: PathBuf,
        pending: PathBuf,
        rename_delay: std::time::Duration,
        passed_stage_delay: std::time::Duration,
        exits: Arc<Mutex<Vec<i32>>>,
    }

    impl super::LinuxReportIo for DelayedReportIo {
        fn write_pending(&self, bytes: &[u8]) -> std::io::Result<()> {
            std::fs::write(&self.pending, bytes)
        }
        fn rename_pending(&self) -> std::io::Result<()> {
            std::thread::sleep(self.rename_delay);
            std::fs::rename(&self.pending, &self.output)
        }
        fn remove_pending(&self) {
            let _ = std::fs::remove_file(&self.pending);
        }
        fn write_failed(&self, bytes: &[u8]) -> std::io::Result<()> {
            std::fs::write(&self.output, bytes)
        }
        fn progress(&self, stage: &'static str) {
            if stage == "audit-passed" {
                std::thread::sleep(self.passed_stage_delay);
            }
        }
        fn exit(&self, code: i32) {
            self.exits.lock().unwrap().push(code);
        }
    }

    fn assert_late_publication_fails(
        rename_delay: std::time::Duration,
        passed_stage_delay: std::time::Duration,
    ) {
        let root = tempfile::tempdir().unwrap();
        let io = DelayedReportIo {
            output: root.path().join("result.json"),
            pending: root.path().join("result.pending"),
            rename_delay,
            passed_stage_delay,
            exits: Arc::new(Mutex::new(Vec::new())),
        };
        let gate = Arc::new(super::LinuxPublicationGate::default());
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(400);
        let cutoff = deadline - std::time::Duration::from_millis(200);
        let guard_gate = gate.clone();
        let guard_io = io.clone();
        let guard = std::thread::spawn(move || {
            std::thread::sleep(deadline.saturating_duration_since(std::time::Instant::now()));
            if guard_gate.deadline_expired() {
                guard_io.write_failed(b"failed").unwrap();
                guard_io.exit(2);
            }
        });
        super::publish_linux_report(&gate, &io, cutoff, deadline, true, b"passed", b"failed");
        guard.join().unwrap();
        assert_eq!(std::fs::read(&io.output).unwrap(), b"failed");
        assert!(!io.exits.lock().unwrap().contains(&0));
        assert!(gate.completed.load(std::sync::atomic::Ordering::SeqCst));
    }

    struct UnreadableProfile;

    struct CookieFiles;

    struct CookieRows(Result<u64, AuditFailureCategory>);

    impl AuditReader for CookieRows {
        fn read_dir(&mut self, root: &Path) -> Result<Vec<AuditEntry>, AuditFailureCategory> {
            if root != Path::new("root") {
                return Err(AuditFailureCategory::ReadDir);
            }
            Ok(vec![AuditEntry {
                path: PathBuf::from("root/Cookies"),
                kind: AuditEntryKind::File,
                cookie_database: true,
            }])
        }

        fn read_file(&mut self, _path: &Path) -> Result<Vec<u8>, AuditFailureCategory> {
            Ok(Vec::new())
        }

        fn cookie_rows(&mut self, _path: &Path) -> Result<u64, AuditFailureCategory> {
            self.0
        }
    }

    impl AuditReader for CookieFiles {
        fn read_dir(&mut self, root: &Path) -> Result<Vec<AuditEntry>, AuditFailureCategory> {
            let entries = match root.to_str() {
                Some("root") => vec![
                    AuditEntry {
                        path: PathBuf::from("root/native-profile"),
                        kind: AuditEntryKind::Directory,
                        cookie_database: false,
                    },
                    AuditEntry {
                        path: PathBuf::from("root/other"),
                        kind: AuditEntryKind::Directory,
                        cookie_database: false,
                    },
                ],
                Some("root/native-profile") => vec![
                    AuditEntry {
                        path: PathBuf::from("root/native-profile/Cookies"),
                        kind: AuditEntryKind::File,
                        cookie_database: true,
                    },
                    AuditEntry {
                        path: PathBuf::from("root/native-profile/Cookies-journal"),
                        kind: AuditEntryKind::File,
                        cookie_database: true,
                    },
                ],
                Some("root/other") => vec![AuditEntry {
                    path: PathBuf::from("root/other/Cookies"),
                    kind: AuditEntryKind::File,
                    cookie_database: true,
                }],
                _ => return Err(AuditFailureCategory::ReadDir),
            };
            Ok(entries)
        }

        fn read_file(&mut self, _path: &Path) -> Result<Vec<u8>, AuditFailureCategory> {
            Ok(Vec::new())
        }
    }

    impl AuditReader for UnreadableProfile {
        fn read_dir(&mut self, _root: &Path) -> Result<Vec<AuditEntry>, AuditFailureCategory> {
            Ok(vec![AuditEntry {
                path: PathBuf::from("profile/locked"),
                kind: AuditEntryKind::File,
                cookie_database: false,
            }])
        }

        fn read_file(&mut self, _path: &Path) -> Result<Vec<u8>, AuditFailureCategory> {
            Err(AuditFailureCategory::FileRead)
        }
    }

    #[test]
    fn other_window_probe_runs_from_completed_page_load() {
        let script = other_window_probe_script();
        assert!(!script.contains("DOMContentLoaded"));
        assert!(script.contains("fetch(location.href)"));
        assert!(script.contains("otherWindow403"));
        assert!(script.contains("otherWindowAclDenied"));
        assert!(script.contains("instanceof TypeError"));
        assert!(script.contains("documentOpaqueOrigin"));
        assert!(script.contains("document.title='NEG:'"));
    }

    #[test]
    fn local_acl_probe_uses_only_closed_observations() {
        let script = local_acl_probe_script();
        assert!(script.contains("ipcAvailable"));
        assert!(script.contains("aclDenied"));
        assert!(script.contains("NEG_LOCAL:"));
        assert!(!script.contains("String(e)"));
    }

    #[test]
    fn retirement_observer_script_has_closed_stage_markers() {
        let script = super::retirement_observer_probe_script();
        for marker in [
            "WP05-ACL-SCRIPT-ENTRY",
            "WP05-ACL-IPC-AVAILABLE",
            "WP05-ACL-IPC-MISSING",
            "WP05-ACL-IPC-START",
            "WP05-ACL-IPC-COMPLETE",
            "ACL:'",
        ] {
            assert!(script.contains(marker), "missing closed marker {marker}");
        }
        for field in [
            "actualAclDenied",
            "ipcAvailable",
            "ipcCompleted",
            "typeError",
        ] {
            assert!(script.contains(field));
        }
    }

    #[test]
    fn linux_retirement_phase_routes_only_exact_finished_second_origin_once() {
        let phase = super::LinuxRetirementPhase::default();
        let first = url::Url::parse("http://127.0.0.1:41001/?wp05-old-check").unwrap();
        let second = url::Url::parse("http://127.0.0.1:41002/?wp05-old-check").unwrap();
        let other_path = url::Url::parse("http://127.0.0.1:41002/").unwrap();
        let (sender, mut receiver) = tokio::sync::oneshot::channel();
        phase.arm(second.clone(), sender);
        let title = "ACL:{\"actualAclDenied\":true,\"ipcAvailable\":true,\"ipcCompleted\":true,\"typeError\":false}";
        assert!(!phase.page_finished(&first));
        assert!(!phase.page_finished(&other_path));
        assert!(!phase.title(&second, title));
        assert!(!phase.title(&first, title));
        assert!(phase.page_finished(&second));
        assert!(!phase.page_finished(&second));
        assert!(phase.title(&second, title));
        assert!(super::valid_retirement_acl(&receiver.try_recv().unwrap()));
        assert!(phase.title(&second, title));
        assert!(receiver.try_recv().is_err());
        phase.disarm();
        assert!(!phase.title(&second, title));
    }

    #[test]
    fn linux_retirement_phase_rejects_missing_ipc_and_type_error() {
        let phase = super::LinuxRetirementPhase::default();
        let url = url::Url::parse("http://127.0.0.1:41002/?wp05-old-check").unwrap();
        let (sender, mut receiver) = tokio::sync::oneshot::channel();
        phase.arm(url.clone(), sender);
        assert!(phase.page_finished(&url));
        assert!(phase.title(&url, "WP05-ACL-IPC-MISSING"));
        assert!(!super::valid_retirement_acl(&receiver.try_recv().unwrap()));
        assert!(!super::valid_retirement_acl(&serde_json::json!({
            "actualAclDenied":true,"ipcAvailable":true,"ipcCompleted":true,"typeError":true
        })));
    }

    #[test]
    fn linux_page_route_keeps_first_origin_and_exact_final_phase_separate() {
        use super::LinuxProbeRoute;
        let phase = super::LinuxRetirementPhase::default();
        let first = super::Origin::parse("http://127.0.0.1:41001").unwrap();
        let first_marker = url::Url::parse("http://127.0.0.1:41001/?wp05-old-check").unwrap();
        let second_marker = url::Url::parse("http://127.0.0.1:41002/?wp05-old-check").unwrap();
        let wrong_path = url::Url::parse("http://127.0.0.1:41002/").unwrap();
        assert_eq!(
            super::linux_probe_route(&first_marker, Some(&first), &phase),
            LinuxProbeRoute::FirstOrigin
        );
        let (sender, _receiver) = tokio::sync::oneshot::channel();
        phase.arm(second_marker.clone(), sender);
        assert_eq!(
            super::linux_probe_route(&first_marker, Some(&first), &phase),
            LinuxProbeRoute::FirstOrigin
        );
        assert_eq!(
            super::linux_probe_route(&wrong_path, Some(&first), &phase),
            LinuxProbeRoute::None
        );
        assert_eq!(
            super::linux_probe_route(&second_marker, Some(&first), &phase),
            LinuxProbeRoute::FinalRetirement
        );
        assert_eq!(
            super::linux_probe_route(&second_marker, Some(&first), &phase),
            LinuxProbeRoute::None
        );
    }

    #[tokio::test]
    async fn delayed_ipc_and_audit_leave_one_close_and_report_owner() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::Arc;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(600);
        let ipc_cutoff = deadline - std::time::Duration::from_millis(500);
        let audit_cutoff = deadline - std::time::Duration::from_millis(380);
        let finalize_cutoff = deadline - std::time::Duration::from_millis(200);
        let phase = Arc::new(super::LinuxRetirementPhase::default());
        let url = url::Url::parse("http://127.0.0.1:41002/?wp05-old-check").unwrap();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        phase.arm(url.clone(), sender);
        assert!(phase.page_finished(&url));
        let late_phase = phase.clone();
        let late_url = url.clone();
        let late = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            late_phase.title(&late_url, "ACL:{\"actualAclDenied\":true}")
        });
        let close = Arc::new(AtomicBool::new(false));
        let report = Arc::new(AtomicBool::new(false));
        let closes = Arc::new(AtomicUsize::new(0));
        let reports = Arc::new(AtomicUsize::new(0));
        let watchdog_close = close.clone();
        let watchdog_report = report.clone();
        let watchdog_closes = closes.clone();
        let watchdog_reports = reports.clone();
        let watchdog = tokio::spawn(async move {
            tokio::time::sleep_until(tokio::time::Instant::from_std(finalize_cutoff)).await;
            if super::claim_observer_completion(&watchdog_report) {
                if super::claim_observer_completion(&watchdog_close) {
                    watchdog_closes.fetch_add(1, Ordering::SeqCst);
                }
                watchdog_reports.fetch_add(1, Ordering::SeqCst);
            }
        });
        assert!(super::bounded_linux_work(ipc_cutoff, receiver)
            .await
            .is_none());
        phase.disarm();
        let slow_disk = tokio::task::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_millis(800));
        });
        assert!(super::bounded_linux_work(audit_cutoff, slow_disk)
            .await
            .is_none());
        if super::claim_observer_completion(&close) {
            closes.fetch_add(1, Ordering::SeqCst);
        }
        if std::time::Instant::now() < finalize_cutoff && super::claim_observer_completion(&report)
        {
            reports.fetch_add(1, Ordering::SeqCst);
        }
        assert!(!late.await.unwrap());
        watchdog.await.unwrap();
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        assert_eq!(reports.load(Ordering::SeqCst), 1);
        assert!(std::time::Instant::now() < deadline);
    }

    #[tokio::test]
    async fn watchdog_claim_prevents_late_audit_from_reporting_twice() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::Arc;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        let report_cutoff = deadline - std::time::Duration::from_millis(250);
        let audit_cutoff = deadline - std::time::Duration::from_millis(100);
        let close = Arc::new(AtomicBool::new(false));
        let report = Arc::new(AtomicBool::new(false));
        let closes = Arc::new(AtomicUsize::new(0));
        let reports = Arc::new(AtomicUsize::new(0));
        let watchdog = {
            let close = close.clone();
            let report = report.clone();
            let closes = closes.clone();
            let reports = reports.clone();
            tokio::spawn(async move {
                tokio::time::sleep_until(tokio::time::Instant::from_std(report_cutoff)).await;
                if super::claim_observer_completion(&report) {
                    if super::claim_observer_completion(&close) {
                        closes.fetch_add(1, Ordering::SeqCst);
                    }
                    reports.fetch_add(1, Ordering::SeqCst);
                }
            })
        };
        let slow_disk = tokio::task::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_millis(700));
        });
        assert!(super::bounded_linux_work(audit_cutoff, slow_disk)
            .await
            .is_none());
        if super::claim_observer_completion(&close) {
            closes.fetch_add(1, Ordering::SeqCst);
        }
        if super::claim_observer_completion(&report) {
            reports.fetch_add(1, Ordering::SeqCst);
        }
        watchdog.await.unwrap();
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        assert_eq!(reports.load(Ordering::SeqCst), 1);
        assert!(std::time::Instant::now() < deadline);
    }

    #[test]
    fn delayed_rename_after_publication_claim_cannot_exit_successfully() {
        assert_late_publication_fails(
            std::time::Duration::from_millis(600),
            std::time::Duration::ZERO,
        );
    }

    #[test]
    fn delayed_pass_progress_after_final_clock_check_cannot_exit_successfully() {
        assert_late_publication_fails(
            std::time::Duration::ZERO,
            std::time::Duration::from_millis(600),
        );
    }

    #[test]
    fn watchdog_publication_owner_rejects_late_normal_report() {
        let root = tempfile::tempdir().unwrap();
        let io = DelayedReportIo {
            output: root.path().join("result.json"),
            pending: root.path().join("result.pending"),
            rename_delay: std::time::Duration::ZERO,
            passed_stage_delay: std::time::Duration::ZERO,
            exits: Arc::new(Mutex::new(Vec::new())),
        };
        let gate = Arc::new(super::LinuxPublicationGate::default());
        assert!(super::claim_observer_completion(&gate.owner));
        let writer_io = io.clone();
        let writer = super::spawn_linux_failure_writer(&gate, move || {
            writer_io.write_failed(b"failed").unwrap();
            writer_io.exit(2);
        })
        .unwrap();
        let now = std::time::Instant::now();
        super::publish_linux_report(
            &gate,
            &io,
            now + std::time::Duration::from_secs(1),
            now + std::time::Duration::from_secs(2),
            true,
            b"passed",
            b"failed",
        );
        writer.join().unwrap();
        assert_eq!(std::fs::read(&io.output).unwrap(), b"failed");
        assert_eq!(*io.exits.lock().unwrap(), vec![2]);
        assert!(!io.pending.exists());
    }

    #[test]
    fn deadline_guard_exit_is_not_blocked_by_slow_failure_report() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let gate = Arc::new(super::LinuxPublicationGate::default());
        let exit_requested = Arc::new(AtomicBool::new(false));
        let report_done = Arc::new(AtomicBool::new(false));
        let guard_gate = gate.clone();
        let guard_exit = exit_requested.clone();
        let guard_report = report_done.clone();
        let guard = std::thread::spawn(move || {
            if guard_gate.deadline_expired() {
                let writer = super::spawn_linux_failure_writer(&guard_gate, move || {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    guard_report.store(true, Ordering::SeqCst);
                });
                guard_exit.store(true, Ordering::SeqCst);
                writer
            } else {
                None
            }
        });
        let writer = guard.join().unwrap().unwrap();
        assert!(exit_requested.load(Ordering::SeqCst));
        assert!(!report_done.load(Ordering::SeqCst));
        writer.join().unwrap();
        assert!(report_done.load(Ordering::SeqCst));
    }

    #[test]
    fn expired_linux_audit_reports_deadline_not_clean() {
        let root = tempfile::tempdir().unwrap();
        let observation = super::audit_until(
            root.path(),
            &[],
            std::time::Instant::now() - std::time::Duration::from_millis(1),
        );
        assert!(!observation.audit_complete);
        assert_eq!(
            observation.failure_category,
            super::AuditFailureCategory::Deadline
        );
    }

    #[tokio::test]
    async fn bounded_linux_audit_rejects_expired_cutoff_without_disk_wait() {
        let root = tempfile::tempdir().unwrap();
        let observation = super::bounded_linux_audit(
            root.path().to_path_buf(),
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            std::time::Instant::now() - std::time::Duration::from_millis(1),
        )
        .await;
        assert_eq!(
            observation.failure_category,
            super::AuditFailureCategory::Deadline
        );
        assert!(!observation.audit_complete);
    }

    #[test]
    fn private_profile_acceptance_requires_closed_windows_evidence() {
        let mut clean_live = AuditObservation::unavailable();
        clean_live.audit_complete = true;
        clean_live.cookie_read_only_complete = true;
        clean_live.failure_category = AuditFailureCategory::None;
        let missing = PrivateProfileObservation {
            applicable: true,
            callback_available: true,
            environment_options_available: true,
            profile_state_available: false,
            private_enabled: false,
            native_cookie_store_empty: false,
            profile_path_verified: false,
            profile_acl_private: false,
            profile_live_audit: AuditObservation::unavailable(),
        };
        assert!(!missing.accepted());
        assert!(PrivateProfileObservation {
            profile_state_available: true,
            private_enabled: true,
            native_cookie_store_empty: true,
            profile_path_verified: true,
            profile_acl_private: true,
            profile_live_audit: clean_live,
            ..missing
        }
        .accepted());
    }

    #[test]
    fn delayed_profile_callback_is_retained_and_timeout_fails_closed() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            let observation = Arc::new(Mutex::new(PrivateProfileObservation {
                applicable: true,
                ..PrivateProfileObservation::default()
            }));
            let (sender, receiver) = tokio::sync::oneshot::channel();
            let delayed = observation.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(10));
                let mut state = delayed.lock().unwrap();
                state.callback_available = true;
                state.environment_options_available = true;
                state.profile_state_available = true;
                state.private_enabled = true;
                state.native_cookie_store_empty = true;
                state.profile_path_verified = true;
                state.profile_acl_private = true;
                state.profile_live_audit.audit_complete = true;
                state.profile_live_audit.cookie_read_only_complete = true;
                state.profile_live_audit.failure_category = AuditFailureCategory::None;
                drop(state);
                let _ = sender.send(());
            });
            let completed = await_profile_callback(
                observation,
                receiver,
                std::time::Instant::now() + std::time::Duration::from_millis(100),
            )
            .await;
            assert!(completed.accepted());

            let missing = Arc::new(Mutex::new(PrivateProfileObservation {
                applicable: true,
                ..PrivateProfileObservation::default()
            }));
            let (_sender, receiver) = tokio::sync::oneshot::channel();
            let timed_out = await_profile_callback(
                missing,
                receiver,
                std::time::Instant::now() + std::time::Duration::from_millis(5),
            )
            .await;
            assert!(!timed_out.accepted());
        });
    }

    #[test]
    fn cookie_audit_classifies_profile_root_and_sidecar_without_paths() {
        let mut reader = CookieFiles;
        let observation = audit_with_reader_and_profile_root(
            Path::new("root"),
            &[],
            &mut reader,
            Some(Path::new("root/native-profile")),
        );
        assert!(observation.audit_complete);
        assert_eq!(observation.cookie_database_files, 3);
        assert_eq!(observation.cookie_database_native_profile_files, 2);
        assert_eq!(observation.cookie_database_other_root_files, 1);
        assert_eq!(observation.cookie_database_primary_files, 2);
        assert_eq!(observation.cookie_database_sidecar_files, 1);
        assert_eq!(
            cookie_file_class(Path::new("Cookies-journal")),
            Some(CookieFileClass::Sidecar)
        );
    }

    #[test]
    fn no_cookie_database_in_app_dirs() {
        let root = Path::new("root");
        let owned = Some(root);
        let zero = audit_with_reader_and_profile_root(root, &[], &mut CookieRows(Ok(0)), owned);
        assert_eq!(zero.cookie_database_files, 1);
        assert!(zero.cookie_read_only_complete);
        assert_eq!(zero.cookie_rows, 0);
        assert_eq!(zero.live_clean(), cfg!(windows));

        let positive = audit_with_reader_and_profile_root(root, &[], &mut CookieRows(Ok(1)), owned);
        assert!(!positive.live_clean());
        assert_eq!(positive.cookie_rows, 1);
        assert_eq!(
            positive.failure_category,
            AuditFailureCategory::CookieDatabase
        );

        let failed = audit_with_reader_and_profile_root(
            root,
            &[],
            &mut CookieRows(Err(AuditFailureCategory::CookieQuery)),
            owned,
        );
        assert!(!failed.live_clean());
        assert!(!failed.cookie_read_only_complete);
        assert_eq!(failed.failure_category, AuditFailureCategory::CookieQuery);
    }

    #[test]
    fn auxiliary_observation_keeps_rust_live_audit_separate_from_browser_json() {
        let browser = parse_secondary_result(
            r#"{"available":true,"otherWindow403":true,"otherWindowAclDenied":true,"documentOpaqueOrigin":true,"documentContentTypeTextPlain":true,"fetchRejectedTypeError":true}"#,
        );
        assert!(browser.available);
        assert!(!browser.observation().profile_live_audit.audit_complete);
        let mut live = AuditObservation::unavailable();
        live.audit_complete = true;
        live.cookie_read_only_complete = true;
        live.failure_category = AuditFailureCategory::None;
        let reported = auxiliary_observation(&browser, live.clone());
        assert_eq!(reported.profile_live_audit, live);
        assert!(reported.profile_live_audit.live_clean());
        let unavailable = auxiliary_observation(&browser, AuditObservation::unavailable());
        assert!(!unavailable.profile_live_audit.live_clean());
    }

    #[cfg(windows)]
    #[test]
    fn populated_locked_lease_is_audited_through_retained_owner_handle() {
        let temp = tempfile::tempdir().unwrap();
        let profile = plur1bus_desktop::windows_spa_profile::create_in_fixture_root(
            &temp.path().join("spa-tmp"),
        )
        .unwrap();
        plur1bus_desktop::windows_spa_profile::record_fixture_identity(&profile, 7, 11).unwrap();
        let observation = super::audit(profile.path(), &[]);
        assert!(observation.audit_complete);
        assert_eq!(observation.read_failures, 0);
        assert_eq!(observation.cookie_rows, 0);
        drop(profile);
    }

    #[test]
    fn progress_history_rejects_entries_beyond_both_bounds() {
        let stages = (0..128)
            .map(|_| "other-window-fetch-start\n")
            .collect::<String>();
        assert!(append_progress_history(&stages, "other-window-fetch-start").is_none());
        let bytes = "x".repeat(4096);
        assert!(append_progress_history(&bytes, "other-window-fetch-start").is_none());
    }

    #[test]
    fn unreadable_profile_is_incomplete_and_has_closed_failure_category() {
        let mut reader = UnreadableProfile;
        let observation = audit_with_reader(Path::new("profile"), &[], &mut reader);
        assert!(!observation.audit_complete);
        assert_eq!(observation.failure_category, AuditFailureCategory::FileRead);
        assert_eq!(observation.read_failures, 1);
    }

    #[test]
    fn clean_audit_rejects_nonzero_operation_failures() {
        let observation = AuditObservation {
            audit_complete: true,
            secret_detected: false,
            cookie_database_files: 0,
            cookie_rows: 0,
            cookie_read_only_complete: true,
            cookie_database_native_profile_files: 0,
            cookie_database_other_root_files: 0,
            cookie_database_primary_files: 0,
            cookie_database_sidecar_files: 0,
            read_failures: 1,
            entries_disappeared: 0,
            metadata_failures: 0,
            read_dir_failures: 0,
            symlink_entries: 0,
            failure_category: AuditFailureCategory::None,
        };
        assert!(!observation.clean());
    }

    #[test]
    fn closed_teardown_requires_capture_close_wait_and_audit() {
        let observation = TeardownObservation {
            process_exit_applicable: true,
            capture_complete: true,
            close_complete: true,
            process_exit_complete: true,
            audit_complete: false,
            profile_cleanup_complete: true,
            cleanup_cookie_rows: 0,
            cleanup_read_only_complete: true,
            cleanup_secret_detected: false,
        };
        assert!(!observation.clean());
        assert!(TeardownObservation {
            audit_complete: true,
            ..observation
        }
        .clean());
        assert!(!TeardownObservation {
            process_exit_applicable: true,
            process_exit_complete: false,
            ..TeardownObservation {
                process_exit_applicable: false,
                capture_complete: true,
                close_complete: true,
                process_exit_complete: true,
                audit_complete: true,
                profile_cleanup_complete: true,
                cleanup_cookie_rows: 0,
                cleanup_read_only_complete: true,
                cleanup_secret_detected: false,
            }
        }
        .clean());
    }

    #[cfg(not(windows))]
    #[test]
    fn applicable_process_exit_requires_a_successful_owner_capture() {
        let owners = BrowserProcessOwners::default();
        assert!(!owners.capture_complete(true));
        owners.finish_capture(Ok(OwnedBrowserProcess));
        assert!(owners.capture_complete(true));
    }

    #[test]
    fn observer_timeout_claim_has_single_completion_owner() {
        let finished = std::sync::atomic::AtomicBool::new(false);
        assert!(claim_observer_completion(&finished));
        assert!(!claim_observer_completion(&finished));
    }

    #[test]
    fn unknown_renderer_observation_is_unavailable() {
        let observation = parse_secondary_probe(
            r#"{"available":true,"documentOpaqueOrigin":false,"documentContentTypeTextPlain":true,"fetchRejectedTypeError":true,"url":"private"}"#,
        );
        assert!(!observation.available);
    }

    #[cfg(not(windows))]
    #[test]
    fn file_read_errors_have_closed_platform_classes() {
        assert_eq!(
            classify_file_read_error(&std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
            AuditFailureCategory::FileReadAccessDenied
        );
        assert_eq!(
            classify_file_read_error(&std::io::Error::from(std::io::ErrorKind::NotFound)),
            AuditFailureCategory::FileReadMissing
        );
        assert_eq!(
            classify_file_read_error(&std::io::Error::from(std::io::ErrorKind::Other)),
            AuditFailureCategory::FileReadOther
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_file_read_errors_classify_sharing_and_permission() {
        assert_eq!(
            classify_file_read_error(&std::io::Error::from_raw_os_error(32)),
            AuditFailureCategory::FileReadSharing
        );
        assert_eq!(
            classify_file_read_error(&std::io::Error::from_raw_os_error(5)),
            AuditFailureCategory::FileReadAccessDenied
        );
        assert_eq!(
            classify_file_read_error(&std::io::Error::from_raw_os_error(2)),
            AuditFailureCategory::FileReadMissing
        );
    }
}

async fn benchmark(proxy: &SpaProxy, origin: &Origin) -> Value {
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let mut samples = Vec::new();
    let mut overhead = Vec::new();
    for _ in 0..100 {
        let start = std::time::Instant::now();
        let direct = client
            .get(format!("{}/spa.js", origin.as_str()))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        let direct_ms = start.elapsed().as_secs_f64() * 1000.0;
        let start = std::time::Instant::now();
        let bytes = client
            .get(format!("{}/spa.js", proxy.origin().as_str()))
            .header("user-agent", proxy.user_agent())
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        let proxy_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(bytes, direct, "byte-correct paired asset");
        let delta = (proxy_ms - direct_ms).max(0.0);
        overhead.push(delta);
        samples.push(json!({"directMs":direct_ms,"proxyMs":proxy_ms,"overheadMs":delta}));
    }
    overhead.sort_by(f64::total_cmp);
    json!({"pairedRequests":100,"p95OverheadMs":overhead[94],"limitMs":5,"samples":samples,"methodology":"same Rust HTTP client, consecutive direct/proxy GET spa.js, complete equal bytes, production metadata and header/CSP filters included"})
}

fn bounded_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("bounded HTTP client")
}
