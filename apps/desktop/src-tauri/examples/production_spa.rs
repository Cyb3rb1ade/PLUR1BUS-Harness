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
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicU8, Ordering},
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
        }
    }

    fn observation(&self) -> SecondaryProbeObservation {
        SecondaryProbeObservation {
            available: self.available,
            proxy_generated_403: false,
            other_window_acl_denied: self.other_window_acl_denied,
            document_opaque_origin: self.document_opaque_origin,
            document_content_type_text_plain: self.document_content_type_text_plain,
            fetch_rejected_type_error: self.fetch_rejected_type_error,
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeDiagnostic {
    secondary_probe: SecondaryProbeObservation,
    audit: AuditObservation,
}

struct FinishInputs {
    results: Arc<Mutex<Vec<Value>>>,
    known: Secrets,
    negative: Arc<Mutex<Value>>,
    secondary_observation: Arc<Mutex<Option<SecondaryProbeObservation>>>,
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
                                negative_controls(&app, &proxy, old_origin, old_probe_for_run)
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
            progress("other-window-page-finished");
            match webview.eval(other_window_probe_script()) {
                Ok(()) => progress("other-window-eval-submitted"),
                Err(_) => progress("other-window-eval-failed"),
            }
        }
    })
    .on_document_title_changed(move |_, title| {
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
            if let Some(tx) = sender.lock().unwrap().take() {
                let _ = tx.send(value);
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
    other.destroy().unwrap();
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
    (
        json!({"missingWrongSecretHostOrigin":denied,"otherWebview":value,"proxyGenerated403":proxy_generated_403,"oldOriginWhileReplacementActive":old_origin}),
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
    spa::retire(app).unwrap();
    app.get_webview_window("spa").unwrap().destroy().unwrap();
    while app.get_webview_window("spa").is_some() {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let handle = app.clone();
    let observer=WebviewWindowBuilder::new(app,"spa",WebviewUrl::External(proxy.origin().as_str().parse().unwrap())).incognito(true)
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = webview.eval(retirement_observer_probe_script());
            }
        })
        .on_document_title_changed(move|_,title|{
            let Some(acl)=title.strip_prefix("ACL:").and_then(|v|serde_json::from_str::<Value>(v).ok())else{return};
            progress("audit");
            let audit_observation=audit(&PathBuf::from(std::env::var_os("WP05_NATIVE_SCRATCH").unwrap()),&inputs.known.lock().unwrap());
            if audit_observation.audit_complete{progress("audit-scan-complete");}else{progress("audit-scan-incomplete");}
            let secondary = inputs.secondary_observation.lock().unwrap().clone().unwrap_or_else(SecondaryProbeObservation::unavailable);
            let diagnostic = NativeDiagnostic { secondary_probe: secondary, audit: audit_observation.clone() };
            let diagnostic_pass = diagnostic.secondary_probe.available && diagnostic.audit.clean();
            let report=json!({"result":if diagnostic_pass{"passed"}else{"failed"},"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"tauri":"2.12.0","nativeMainEntered":true,"knownSecretKinds":["deviceBearer","tickets","launchCarrier","sessionCookies","browserCsrf"],"sessions":*inputs.results.lock().unwrap(),"retirement":acl,"negativeControls":*inputs.negative.lock().unwrap(),"ticketError":error["ticketError"],"productionBenchmark":error["productionBenchmark"],"secretOnDisk":diagnostic.audit.secret_detected,"cookieDatabaseFiles":diagnostic.audit.cookie_database_files,"diagnostic":diagnostic});
            let bytes=match serde_json::to_vec_pretty(&report){Ok(bytes)=>{progress("audit-report-serialized");bytes},Err(_)=>{progress("audit-report-serialization-failed");handle.exit(2);return}};
            if contains_secret(&bytes,&inputs.known.lock().unwrap()){progress("audit-report-secret-detected");handle.exit(2);return}
            if std::fs::write(&output,&bytes).is_err(){progress("audit-report-write-failed");handle.exit(2);return}
            progress("audit-report-written");
            if !diagnostic_pass{progress("audit-failed");handle.exit(2);return}
            progress("audit-passed");handle.exit(0);
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
        other_window_probe_script, parse_secondary_probe, AuditEntry, AuditEntryKind,
        AuditFailureCategory, AuditObservation, AuditReader,
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
