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
    FileReadSharing,
    FileReadAccessDenied,
    FileReadMissing,
    FileReadOther,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AuditObservation {
    audit_complete: bool,
    secret_detected: bool,
    cookie_database_files: u32,
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
            read_failures: 0,
            entries_disappeared: 0,
            metadata_failures: 0,
            read_dir_failures: 0,
            symlink_entries: 0,
            failure_category: AuditFailureCategory::ReadDir,
        }
    }

    fn clean(&self) -> bool {
        self.audit_complete
            && !self.secret_detected
            && self.cookie_database_files == 0
            && self.read_failures == 0
            && self.entries_disappeared == 0
            && self.metadata_failures == 0
            && self.read_dir_failures == 0
            && self.symlink_entries == 0
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
        }
    }
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
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TeardownObservation {
    process_exit_applicable: bool,
    capture_complete: bool,
    close_complete: bool,
    process_exit_complete: bool,
    audit_complete: bool,
}

impl TeardownObservation {
    fn clean(&self) -> bool {
        self.capture_complete
            && self.close_complete
            && (!self.process_exit_applicable || self.process_exit_complete)
            && self.audit_complete
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
                #[cfg(windows)]
                if state.owners.iter().any(|existing| existing.pid == owner.pid) {
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

    fn capture_complete(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.pending_captures == 0 && state.capture_failures == 0
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
    deadline: std::time::Duration,
) -> bool {
    let started = std::time::Instant::now();
    loop {
        if labels
            .iter()
            .all(|label| app.get_webview_window(label).is_none())
        {
            return true;
        }
        if started.elapsed() >= deadline {
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

async fn wait_for_browser_processes(
    owners: BrowserProcessOwners,
    deadline: std::time::Duration,
) -> ProcessExitObservation {
    #[cfg(not(windows))]
    let applicable = false;
    #[cfg(windows)]
    let applicable = true;
    let started = std::time::Instant::now();
    while {
        let state = owners.state.lock().unwrap();
        state.pending_captures != 0
    } {
        if started.elapsed() >= deadline {
            return ProcessExitObservation {
                applicable,
                complete: false,
            };
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let remaining = deadline.saturating_sub(started.elapsed());
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

trait AuditReader {
    fn read_dir(&mut self, root: &std::path::Path)
        -> Result<Vec<AuditEntry>, AuditFailureCategory>;
    fn read_file(&mut self, path: &std::path::Path) -> Result<Vec<u8>, AuditFailureCategory>;
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
    "(async()=>{let denied=false;try{await window.__TAURI_INTERNALS__.invoke('shell_info')}catch(e){denied=String(e).includes('not allowed')||String(e).includes('denied')||String(e).includes('permissions')}document.title='ACL:'+JSON.stringify({actualAclDenied:denied});})()"
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
    let old_probe = Arc::new(Mutex::new(None::<Value>));
    let browser_owners = BrowserProcessOwners::default();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().app.app_directories_override =
        Some(tauri::utils::config::AppDirectoriesOverride::Root(
            PathBuf::from(std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").unwrap())
                .join("native-profile"),
        ));
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
            let old_probe_for_title = old_probe_for_title.clone();
            let registering = known.clone();
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
            app.state::<SpaState>()
                .set_native_probe(Arc::new(move |window, title| {
                    if let Some(value) = title
                        .strip_prefix("OLD:")
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                    {
                        *old_probe_for_title.lock().unwrap() = Some(value);
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
                    let old_probe_for_run = old_probe.clone();
                    let browser_owners_for_run = browser_owners.clone();
                    tauri::async_runtime::spawn(async move {
                        progress("secrets-registering");
                        proxy.register_memory_secrets(|s| {
                            known.lock().unwrap().push(SecretString::new(s.to_owned()));
                        });
                        progress("secrets-registered");
                        if step < 2 {
                            let empty = window.cookies().is_ok_and(|v| v.is_empty());
                            results.lock().unwrap().push(json!({
                                "browser": value,
                                "nativeCookieStoreEmpty": empty
                            }));
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
                            let (controls, observation) =
                                negative_controls(
                                    &app,
                                    &proxy,
                                    old_origin,
                                    old_probe_for_run,
                                    browser_owners_for_run.clone(),
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
                            },
                            observations,
                        )
                        .await;
                    });
                }));
            let start = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut conn = start_connection.lock().unwrap().clone();
                if spa::open_spa(
                    &start,
                    &mut conn,
                    start_tokens.as_ref(),
                    start_store.as_ref(),
                )
                .await
                .is_err()
                {
                    start.exit(3)
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
) -> (Value, SecondaryProbeObservation) {
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
    progress("other-window-construction-start");
    let other = WebviewWindowBuilder::new(
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
    })
    .build();
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
    let value = match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
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
    capture_browser_process(&other, &browser_owners);
    if other.destroy().is_err() {
        browser_owners.close_failed();
    }
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
    let observation = value.observation();
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
async fn finish(
    app: &tauri::AppHandle,
    proxy: SpaProxy,
    output: PathBuf,
    inputs: FinishInputs,
    error: Value,
) {
    progress("retire");
    let browser_owners = inputs.browser_owners.clone();
    if let Some(current) = app.get_webview_window("spa") {
        capture_browser_process(&current, &browser_owners);
        if current.destroy().is_err() {
            browser_owners.close_failed();
        }
    }
    spa::retire(app).unwrap();
    while app.get_webview_window("spa").is_some() {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let handle = app.clone();
    let finished = Arc::new(AtomicBool::new(false));
    let output = output.clone();
    let known = inputs.known.clone();
    let results = inputs.results.clone();
    let negative = inputs.negative.clone();
    let secondary_observation = inputs.secondary_observation.clone();
    let observer_owners = browser_owners.clone();
    let observer_url = format!("{}?wp05-old-check", proxy.origin().as_str());
    let observer=WebviewWindowBuilder::new(app,"spa",WebviewUrl::External(observer_url.parse().unwrap())).incognito(true)
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                && payload.url().query() == Some("wp05-old-check")
            {
                let _ = webview.eval(retirement_observer_probe_script());
            }
        })
        .on_document_title_changed(move|window,title|{
            let Some(acl)=title.strip_prefix("ACL:").and_then(|v|serde_json::from_str::<Value>(v).ok())else{return};
            if finished.swap(true, Ordering::SeqCst) {
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
            let task_owners = observer_owners.clone();
            let task_error = error.clone();
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
                if pre_close_audit.audit_complete {
                    progress("audit-live-scan-complete");
                } else {
                    progress("audit-live-scan-incomplete");
                }
                progress("retirement-observer-close-requested");
                if observer.destroy().is_err() {
                    task_owners.close_failed();
                }
                drop(observer);
                progress("teardown-wait-start");
                let teardown_deadline = std::time::Duration::from_secs(5);
                let teardown_started = std::time::Instant::now();
                let windows_absent = wait_for_fixture_windows(
                    &task_handle,
                    &task_owners.tracked_windows(),
                    teardown_deadline,
                )
                .await;
                task_owners.mark_windows_absent(windows_absent);
                let process_exit = wait_for_browser_processes(
                    task_owners.clone(),
                    teardown_deadline.saturating_sub(teardown_started.elapsed()),
                )
                .await;
                if windows_absent && (!process_exit.applicable || process_exit.complete) {
                    progress("teardown-wait-complete");
                } else {
                    progress("teardown-wait-failed");
                }
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
                    capture_complete: task_owners.capture_complete(),
                    close_complete: task_owners.close_complete(),
                    process_exit_complete: process_exit.complete,
                    audit_complete: audit_observation.audit_complete,
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
                };
                let live_positive = diagnostic.pre_close_audit.secret_detected
                    || diagnostic.pre_close_audit.cookie_database_files != 0;
                let diagnostic_pass = diagnostic.secondary_probe.available
                    && !live_positive
                    && diagnostic.audit.clean()
                    && diagnostic.teardown.clean();
                let report=json!({"result":if diagnostic_pass{"passed"}else{"failed"},"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"tauri":"2.12.0","nativeMainEntered":true,"knownSecretKinds":["deviceBearer","tickets","launchCarrier","sessionCookies","browserCsrf"],"sessions":*task_results.lock().unwrap(),"retirement":acl,"negativeControls":*task_negative.lock().unwrap(),"ticketError":task_error["ticketError"],"productionBenchmark":task_error["productionBenchmark"],"secretOnDisk":diagnostic.audit.secret_detected,"cookieDatabaseFiles":diagnostic.audit.cookie_database_files,"preCloseAudit":pre_close_audit,"teardown":teardown,"diagnostic":diagnostic});
                let bytes=match serde_json::to_vec_pretty(&report){Ok(bytes)=>{progress("audit-report-serialized");bytes},Err(_)=>{progress("audit-report-serialization-failed");task_handle.exit(2);return}};
                if contains_secret(&bytes,&task_known.lock().unwrap()){progress("audit-report-secret-detected");task_handle.exit(2);return}
                if std::fs::write(&task_output,&bytes).is_err(){progress("audit-report-write-failed");task_handle.exit(2);return}
                progress("audit-report-written");
                if !diagnostic_pass{progress("audit-failed");task_handle.exit(2);return}
                progress("audit-passed");task_handle.exit(0);
            });
        }).build();
    if observer.is_err() {
        app.exit(3);
    }
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
        std::fs::read(path).map_err(|error| classify_file_read_error(&error))
    }
}

fn is_cookie_database(path: &std::path::Path) -> bool {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    name == "cookies"
        || name.starts_with("cookies.sqlite")
        || name.starts_with("cookies.binarycookies")
        || name.starts_with("cookies-")
}

fn audit(root: &std::path::Path, secrets: &[SecretString]) -> AuditObservation {
    let mut reader = FilesystemAuditReader;
    audit_with_reader(root, secrets, &mut reader)
}

fn audit_with_reader<R: AuditReader>(
    root: &std::path::Path,
    secrets: &[SecretString],
    reader: &mut R,
) -> AuditObservation {
    const MAX_AUDIT_ITEMS: usize = 4096;
    let mut observation = AuditObservation {
        audit_complete: false,
        secret_detected: false,
        cookie_database_files: 0,
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
    } else if observation.cookie_database_files > 0 {
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
        | AuditFailureCategory::SecretDetected
        | AuditFailureCategory::CookieDatabase
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
    use super::{
        append_progress_history, audit_with_reader, classify_file_read_error,
        local_acl_probe_script, other_window_probe_script, parse_secondary_probe, AuditEntry, AuditEntryKind,
        AuditFailureCategory, AuditObservation, AuditReader, TeardownObservation,
    };
    use std::path::{Path, PathBuf};

    struct UnreadableProfile;

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
            }
        }
        .clean());
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
