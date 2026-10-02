//! Test-only native-engine experiment; never linked into the desktop application.
use axum::{
    body::Body,
    extract::{State, WebSocketUpgrade},
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone)]
struct Fixture {
    origin: String,
    key: String,
    client: reqwest::Client,
    requests: Arc<Mutex<BTreeMap<String, usize>>>,
}

fn allowed(req: &Request<Body>, state: &Fixture) -> bool {
    let key = url::form_urlencoded::parse(req.uri().query().unwrap_or_default().as_bytes())
        .any(|(k, v)| k == "key" && v == state.key);
    let host = req.headers().get("host").and_then(|v| v.to_str().ok());
    let origin = req.headers().get("origin").and_then(|v| v.to_str().ok());
    key && host == state.origin.strip_prefix("http://")
        && origin.is_none_or(|o| {
            o == state.origin
                || o == "null"
                || o == "plur1bus-harness://localhost"
                || o == "http://plur1bus-harness.localhost"
        })
}

async fn fixture(
    State(state): State<Fixture>,
    ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
    req: Request<Body>,
) -> Response {
    if !allowed(&req, &state) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let observation = json!({"method":req.method().as_str(), "path":req.uri().path(),
        "origin":req.headers().get("origin").and_then(|v|v.to_str().ok()),
        "userAgent":req.headers().get("user-agent").and_then(|v|v.to_str().ok()),
        "upgrade":req.headers().get("upgrade").and_then(|v|v.to_str().ok())});
    *state
        .requests
        .lock()
        .unwrap()
        .entry(observation.to_string())
        .or_default() += 1;
    let path = req.uri().path().to_owned();
    if let Some(path) = path.strip_prefix("/proxy") {
        if path == "/ws" {
            let Ok(ws) = ws else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            return ws.on_upgrade(move |mut downstream| async move {
                let target = format!(
                    "{}/ws?key={}",
                    state.origin.replacen("http", "ws", 1),
                    state.key
                );
                if let Ok((mut upstream, _)) = tokio_tungstenite::connect_async(target).await {
                    if let Some(Ok(axum::extract::ws::Message::Text(text))) =
                        downstream.recv().await
                    {
                        let _ = upstream
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                text.to_string().into(),
                            ))
                            .await;
                        if let Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) =
                            upstream.next().await
                        {
                            let _ = downstream
                                .send(axum::extract::ws::Message::Text(text.to_string().into()))
                                .await;
                        }
                    }
                }
            });
        }
        let mut upstream = state.client.request(
            req.method().clone(),
            format!("{}{path}?key={}", state.origin, state.key),
        );
        if let Some(origin) = req.headers().get("origin") {
            upstream = upstream.header("origin", origin);
        }
        let response = upstream.send().await.unwrap();
        let mut builder = Response::builder().status(response.status());
        for (name, value) in response.headers() {
            if name != "transfer-encoding" && name != "content-length" {
                builder = builder.header(name, value);
            }
        }
        return builder
            .body(Body::from_stream(response.bytes_stream()))
            .unwrap();
    }
    let mut response = match path.as_str() {
        "/" => axum::response::Html("<!doctype html><title>WP5 native transport diagnostic</title><h1>WP5 transport spike</h1>").into_response(),
        "/self.js" => ([("content-type", "application/javascript")], "window.spikeSelfScript = true;").into_response(),
        "/ping" => json!({"ok":true, "requestOrigin":req.headers().get("origin").and_then(|v|v.to_str().ok())}).to_string().into_response(),
        "/download" => vec![0x5au8; 10 * 1024 * 1024].into_response(),
        "/events" => {
            let stream = futures_util::stream::unfold(0, |n| async move {
                if n == 2 { return None; }
                if n == 1 { tokio::time::sleep(Duration::from_millis(1500)).await; }
                Some((Ok::<_, std::io::Error>(format!("data: {n}\n\n")), n+1))
            });
            Response::builder().header("content-type", "text/event-stream").header("cache-control", "no-store").body(Body::from_stream(stream)).unwrap()
        },
        "/ws" => {
            let Ok(ws) = ws else { return StatusCode::BAD_REQUEST.into_response() };
            return ws.on_upgrade(|mut socket| async move { if let Some(Ok(message)) = socket.recv().await { let _ = socket.send(message).await; } });
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    };
    let origin = req
        .headers()
        .get("origin")
        .cloned()
        .unwrap_or_else(|| "*".parse().unwrap());
    response
        .headers_mut()
        .insert("access-control-allow-origin", origin);
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    // 'self' alone controls script loading. Explicit diagnostic connect destinations
    // permit the paired direct baseline and IPC classification experiment.
    let csp = format!("default-src 'none'; script-src 'self'; connect-src 'self' {} ws://{} ipc: http://ipc.localhost ws://plur1bus-harness.localhost; base-uri 'none'", state.origin, state.origin.trim_start_matches("http://"));
    response
        .headers_mut()
        .insert("content-security-policy", csp.parse().unwrap());
    response
}

// Deliberately reuse generated permission identifiers ONLY in this example binary.
// No production command or command table is changed or called.
#[tauri::command]
fn app_info(webview: tauri::Webview) -> Result<&'static str, &'static str> {
    diagnostic_caller(webview)?;
    Ok("local-capability")
}
#[tauri::command]
fn settings_get(webview: tauri::Webview) -> Result<&'static str, &'static str> {
    diagnostic_caller(webview)?;
    Ok("remote-capability")
}
fn diagnostic_caller(webview: tauri::Webview) -> Result<(), &'static str> {
    if matches!(webview.label(), "spike-custom" | "spike-loopback") {
        Ok(())
    } else {
        Err("diagnostic label required")
    }
}

fn main() {
    eprintln!("PLUR1BUS_NATIVE_SPIKE_MAIN_ENTERED");
    let output = std::env::args_os()
        .nth(1)
        .expect("usage: transport_spike <result.json in temporary directory>");
    let output = std::path::PathBuf::from(output);
    assert!(
        output.is_absolute() && output.starts_with(std::env::temp_dir()),
        "result must be under the OS temporary directory"
    );
    let profile = tempfile::Builder::new()
        .prefix("plur1bus-native-spike-")
        .tempdir()
        .unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let listener = runtime
        .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let state = Fixture {
        origin: origin.clone(),
        key: uuid::Uuid::now_v7().to_string(),
        client: reqwest::Client::new(),
        requests: Default::default(),
    };
    let app = Router::new()
        .fallback(any(fixture))
        .with_state(state.clone());
    runtime.spawn(async move { axum::serve(listener, app).await.unwrap() });
    let results = Arc::new(Mutex::new(BTreeMap::<String, Value>::new()));
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "app.plur1bus.transport-spike".into();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(profile.path().into()),
    );
    let request_log = requests.clone();
    let protocol_state = state.clone();
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_info, settings_get])
        .register_asynchronous_uri_scheme_protocol("plur1bus-harness", move |ctx, request, responder| {
            if ctx.webview_label() != "spike-custom" {
                responder.respond(tauri::http::Response::builder().status(403).body(Vec::new()).unwrap());
                return;
            }
            request_log.lock().unwrap().push(json!({"method":request.method().as_str(), "path": request.uri().path(), "origin":request.headers().get("origin").and_then(|v|v.to_str().ok()), "userAgent":request.headers().get("user-agent").and_then(|v|v.to_str().ok()), "label":ctx.webview_label()}));
            let state = protocol_state.clone();
            tauri::async_runtime::spawn(async move {
                let mut upstream = state.client.request(request.method().clone(), format!("{}{}?key={}", state.origin, request.uri().path(), state.key));
                if let Some(origin) = request.headers().get("origin") { upstream = upstream.header("origin", origin); }
                let response = upstream.send().await.unwrap();
                let mut builder = tauri::http::Response::builder().status(response.status());
                for (name,value) in response.headers() { if name != "transfer-encoding" && name != "content-length" { builder = builder.header(name, value); } }
                // This is the pinned Tauri responder API: one complete byte body.
                responder.respond(builder.body(response.bytes().await.unwrap().to_vec()).unwrap());
            });
        })
        .setup(move |app| {
            let custom = if cfg!(any(target_os="windows", target_os="android")) { "http://plur1bus-harness.localhost" } else { "plur1bus-harness://localhost" };
            app.add_capability(json!({"identifier":"spike-local", "local":true, "webviews":["spike-custom","spike-loopback"], "permissions":["allow-app-info"]}).to_string())?;
            app.add_capability(json!({"identifier":"spike-remote", "local":false, "remote":{"urls":[format!("{custom}/*"),format!("{origin}/*")]}, "webviews":["spike-custom","spike-loopback"], "permissions":["allow-settings-get"]}).to_string())?;
            for (kind,base) in [("custom", custom.to_owned()), ("loopback", format!("{origin}/proxy"))] {
                let results = results.clone(); let requests = requests.clone(); let server_requests = state.requests.clone(); let output = output.clone(); let handle = app.handle().clone();
                let config = json!({"kind":kind,"base":base,"direct":origin,"key":state.key});
                let script = format!("const SPIKE = {config};\n{}", include_str!("transport-spike/probe.js"));
                let builder = WebviewWindowBuilder::new(app, format!("spike-{kind}"), WebviewUrl::External(format!("{base}/?key={}",state.key).parse()?))
                    .title(format!("WP5 isolated diagnostic — {kind}"));
                let builder = if kind == "loopback" { builder.user_agent("PLUR1BUS-Native-Spike/1") } else { builder };
                builder
                    .incognito(true).data_directory(profile.path().join(kind)).disable_drag_drop_handler()
                    .initialization_script(script).on_navigation(move |url| {
                        if url.scheme() != "spike-result" { return true; }
                        let payload = url.query_pairs().find(|(k,_)|k=="data").map(|(_,v)|v.into_owned()).unwrap();
                        let value: Value = serde_json::from_str(&payload).unwrap();
                        let mut all = results.lock().unwrap(); all.insert(kind.into(), value);
                        {
                            let report = json!({"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"tauri":"2.12.0","wry":"0.57.0","observations":*all,"customHandlerRequests":*requests.lock().unwrap(), "loopbackServerRequests": server_requests.lock().unwrap().iter().map(|(entry,count)| json!({"request":serde_json::from_str::<Value>(entry).unwrap(),"count":count})).collect::<Vec<_>>()});
                            std::fs::write(&output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
                            println!("Native transport observations written to {}", output.display());
                            if all.len() == 2 { handle.exit(0); }
                        }
                        false
                    }).build()?;
            }
            // Keep temporary storage alive until the native application exits.
            app.manage(profile);
            let handle = app.handle().clone();
            std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(60)); handle.exit(2); });
            Ok(())
        }).build(context).expect("build isolated diagnostic");
    app.run(|_, _| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_guard_requires_run_key_exact_host_and_known_origin() {
        let state = Fixture {
            origin: "http://127.0.0.1:12345".into(),
            key: uuid::Uuid::now_v7().to_string(),
            client: reqwest::Client::new(),
            requests: Default::default(),
        };
        let make = |key: &str, host: &str, origin: &str| {
            Request::builder()
                .uri(format!("/ping?key={key}"))
                .header("host", host)
                .header("origin", origin)
                .body(Body::empty())
                .unwrap()
        };
        assert!(allowed(
            &make(&state.key, "127.0.0.1:12345", &state.origin),
            &state
        ));
        assert!(!allowed(
            &make("", "127.0.0.1:12345", &state.origin),
            &state
        ));
        assert!(!allowed(
            &make(&state.key, "foreign.example", &state.origin),
            &state
        ));
        assert!(!allowed(
            &make(&state.key, "127.0.0.1:12345", "https://foreign.example"),
            &state
        ));
    }

    #[tokio::test]
    async fn diagnostic_loopback_proxy_streams_before_upstream_eof() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let state = Fixture {
            origin: format!("http://{}", listener.local_addr().unwrap()),
            key: uuid::Uuid::now_v7().to_string(),
            client: reqwest::Client::new(),
            requests: Default::default(),
        };
        let app = Router::new()
            .fallback(any(fixture))
            .with_state(state.clone());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut stream = state
            .client
            .get(format!("{}/proxy/events?key={}", state.origin, state.key))
            .send()
            .await
            .unwrap()
            .bytes_stream();
        let first = tokio::time::timeout(Duration::from_millis(750), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(&first[..], b"data: 0\n\n");
        let second = tokio::time::timeout(Duration::from_secs(3), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(&second[..], b"data: 1\n\n");
        task.abort();
    }
}
