//! Actual native engine acceptance. All credentials and audit values stay in Rust memory.
use plur1bus_desktop::{
    commands,
    connections::{Connection, CredentialProvenance, Kind, Origin, Store},
    secrets::{token_account, MemoryStore, SecretString, TokenStore},
    spa::{self, SpaState},
    spa_proxy::SpaProxy,
};
use serde::Deserialize;
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
    r#"(async()=>{const blocked=(await fetch(location.href)).status===403;let acl=false;try{await window.__TAURI_INTERNALS__.invoke('shell_info')}catch(e){acl=String(e).includes('not allowed')||String(e).includes('denied')||String(e).includes('permissions')}document.title='NEG:'+JSON.stringify({otherWindow403:blocked,otherWindowAclDenied:acl});})()"#
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
                            let controls =
                                negative_controls(&app, &proxy, old_origin, old_probe_for_run)
                                    .await;
                            *negatives.lock().unwrap() = controls;
                            let upstream = connection.lock().unwrap().origin.clone();
                            let response = reqwest::Client::new()
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
                        finish(&app, proxy, output, results, known, negatives, observations).await;
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
) -> Value {
    let client = reqwest::Client::new();
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
    let (tx, rx) = tokio::sync::oneshot::channel();
    let sender = Mutex::new(Some(tx));
    progress("other-window-construction-start");
    let other =
        WebviewWindowBuilder::new(app, "other-spa", WebviewUrl::External(url.parse().unwrap()))
            .incognito(true)
            .on_page_load(|webview, payload| {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                    let _ = webview.eval(other_window_probe_script());
                }
            })
            .on_document_title_changed(move |_, title| {
                if let Some(value) = title
                    .strip_prefix("NEG:")
                    .and_then(|v| serde_json::from_str::<Value>(v).ok())
                {
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
    json!({"missingWrongSecretHostOrigin":denied,"otherWebview":value,"oldOriginWhileReplacementActive":old_origin})
}
async fn finish(
    app: &tauri::AppHandle,
    proxy: SpaProxy,
    output: PathBuf,
    results: Arc<Mutex<Vec<Value>>>,
    known: Secrets,
    negative: Arc<Mutex<Value>>,
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
        .initialization_script("addEventListener('DOMContentLoaded',async()=>{let denied=false;try{await window.__TAURI_INTERNALS__.invoke('shell_info')}catch(e){denied=String(e).includes('not allowed')||String(e).includes('denied')||String(e).includes('permissions')}document.title='ACL:'+JSON.stringify({actualAclDenied:denied});});")
        .on_document_title_changed(move|_,title|{
            let Some(acl)=title.strip_prefix("ACL:").and_then(|v|serde_json::from_str::<Value>(v).ok())else{return};progress("audit");let (secret_on_disk,cookie_files)=audit(&PathBuf::from(std::env::var_os("WP05_NATIVE_SCRATCH").unwrap()),&known.lock().unwrap());assert!(!secret_on_disk&&cookie_files==0,"native disk audit failed");
            let report=json!({"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"tauri":"2.12.0","nativeMainEntered":true,"knownSecretKinds":["deviceBearer","tickets","launchCarrier","sessionCookies","browserCsrf"],"sessions":*results.lock().unwrap(),"retirement":acl,"negativeControls":*negative.lock().unwrap(),"ticketError":error["ticketError"],"productionBenchmark":error["productionBenchmark"],"secretOnDisk":secret_on_disk,"cookieDatabaseFiles":cookie_files});let bytes=serde_json::to_vec_pretty(&report).unwrap();assert!(!contains_secret(&bytes,&known.lock().unwrap()),"secret in public report");std::fs::write(&output,bytes).unwrap();handle.exit(0);
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
fn audit(root: &std::path::Path, secrets: &[SecretString]) -> (bool, usize) {
    let mut leaked = false;
    let mut cookies = 0;
    for entry in std::fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            let (l, c) = audit(&entry.path(), secrets);
            leaked |= l;
            cookies += c;
        } else if entry.file_type().unwrap().is_file() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name == "cookies"
                || name.starts_with("cookies.sqlite")
                || name.starts_with("cookies.binarycookies")
                || name.starts_with("cookies-")
            {
                cookies += 1;
            }
            leaked |= contains_secret(&std::fs::read(entry.path()).unwrap(), secrets);
        }
    }
    (leaked, cookies)
}

fn progress(label: &str) {
    if let Some(path) = std::env::args_os().nth(1) {
        let _ = std::fs::write(PathBuf::from(path).with_extension("progress"), label);
    }
}

#[cfg(test)]
mod tests {
    use super::other_window_probe_script;

    #[test]
    fn other_window_probe_runs_from_completed_page_load() {
        let script = other_window_probe_script();
        assert!(!script.contains("DOMContentLoaded"));
        assert!(script.contains("fetch(location.href)"));
        assert!(script.contains("otherWindow403"));
        assert!(script.contains("otherWindowAclDenied"));
        assert!(script.contains("document.title='NEG:'"));
    }
}

async fn benchmark(proxy: &SpaProxy, origin: &Origin) -> Value {
    let client = reqwest::Client::builder()
        .no_proxy()
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
