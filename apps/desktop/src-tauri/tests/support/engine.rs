//! Local wire fixture: Unix socket on Unix, named pipe on Windows. No TCP seam.
use plur1bus_desktop::runtime::detect::Endpoint;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
#[derive(Default)]
pub struct State {
    pub wait_code: i64,
    pub manifest_digest: Option<String>,
    pub wait_delay_ms: u64,
    pub requests: Vec<(String, Value)>,
    pub containers: std::collections::BTreeMap<String, Value>,
    pub volumes: std::collections::BTreeMap<String, Value>,
    pub networks: std::collections::BTreeMap<String, Value>,
}
pub struct Engine {
    pub endpoint: Endpoint,
    pub state: Arc<Mutex<State>>,
    task: tokio::task::JoinHandle<()>,
    _dir: tempfile::TempDir,
}
impl Drop for Engine {
    fn drop(&mut self) {
        self.task.abort()
    }
}
impl Engine {
    pub async fn start(engine: &str, os: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        let version = json!({"Version":"28.0.0","ApiVersion":"1.53","MinAPIVersion":"1.41","Os":os,"Platform":{"Name":engine},"Components":[{"Name":engine,"Version":"28.0.0"}]});
        #[cfg(unix)]
        {
            let path = dir.path().join("engine.sock");
            let listener = tokio::net::UnixListener::bind(&path).unwrap();
            let task = tokio::spawn(async move {
                loop {
                    let (stream, _) = listener.accept().await.unwrap();
                    let state = shared.clone();
                    let version = version.clone();
                    tokio::spawn(serve(stream, state, version));
                }
            });
            Self {
                endpoint: Endpoint::Unix(path),
                state,
                task,
                _dir: dir,
            }
        }
        #[cfg(windows)]
        {
            let name = format!("//./pipe/p1t-{}", uuid::Uuid::now_v7());
            let native = name.replace('/', "\\");
            let first = tokio::net::windows::named_pipe::ServerOptions::new()
                .first_pipe_instance(true)
                .create(&native)
                .unwrap();
            let task = tokio::spawn(async move {
                let mut server = first;
                loop {
                    server.connect().await.unwrap();
                    let next = tokio::net::windows::named_pipe::ServerOptions::new()
                        .create(&native)
                        .unwrap();
                    let connected = std::mem::replace(&mut server, next);
                    tokio::spawn(serve(connected, shared.clone(), version.clone()));
                }
            });
            Self {
                endpoint: Endpoint::Pipe(name),
                state,
                task,
                _dir: dir,
            }
        }
    }
}
async fn serve<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    state: Arc<Mutex<State>>,
    version: Value,
) {
    let mut data = vec![];
    let headers = loop {
        let mut b = [0; 4096];
        let Ok(n) = stream.read(&mut b).await else {
            return;
        };
        if n == 0 {
            return;
        }
        data.extend_from_slice(&b[..n]);
        if let Some(i) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if data.len() > 64 * 1024 {
            return;
        }
    };
    let text = String::from_utf8_lossy(&data[..headers]);
    let first = text.lines().next().unwrap_or_default();
    let mut words = first.split_whitespace();
    let method = words.next().unwrap_or_default().to_owned();
    let mut path = words.next().unwrap_or_default().to_owned();
    if path.starts_with("/v1.") {
        path = path
            .split_once('/')
            .map(|(_, p)| p)
            .unwrap_or("")
            .split_once('/')
            .map(|(_, p)| format!("/{p}"))
            .unwrap_or_default()
    }
    let chunked = text
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked");
    let len = text
        .lines()
        .find_map(|l| {
            l.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .and_then(|v| v.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    while data.len() < headers + len {
        let mut b = [0; 4096];
        let Ok(n) = stream.read(&mut b).await else {
            return;
        };
        if n == 0 {
            return;
        }
        data.extend_from_slice(&b[..n])
    }
    if chunked {
        while !data[headers..].windows(5).any(|w| w == b"0\r\n\r\n") {
            let mut b = [0; 4096];
            let Ok(n) = stream.read(&mut b).await else {
                return;
            };
            if n == 0 {
                return;
            }
            data.extend_from_slice(&b[..n]);
            if data.len() > 8 * 1024 * 1024 {
                return;
            }
        }
    }
    let body =
        serde_json::from_slice::<Value>(&data[headers..headers + len]).unwrap_or(Value::Null);
    if path.contains("/wait") {
        let delay = state.lock().unwrap().wait_delay_ms;
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
    }
    let (code, reply) = response(&method, &path, body, &state, &version);
    if path.starts_with("/exec/") && path.ends_with("/start") {
        let payload = b"synthetic-exec";
        let mut frame = vec![1, 0, 0, 0];
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(payload);
        let _ = stream
            .write_all(b"HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
            .await;
        let _ = stream.write_all(&frame).await;
        let _ = stream.shutdown().await;
        return;
    }
    let raw = if let Some(s) = reply.as_str() {
        s.as_bytes().to_vec()
    } else {
        serde_json::to_vec(&reply).unwrap()
    };
    let head=format!("HTTP/1.1 {code} fixture\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",raw.len());
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(&raw).await;
    let _ = stream.shutdown().await;
}
fn response(
    method: &str,
    path: &str,
    body: Value,
    state: &Mutex<State>,
    version: &Value,
) -> (u16, Value) {
    let mut s = state.lock().unwrap();
    s.requests.push((format!("{method} {path}"), body.clone()));
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    if path == "/_ping" {
        return (200, json!("OK"));
    }
    if path == "/version" {
        return (200, version.clone());
    }
    if path == "/images/create" {
        return (200, json!("{\"status\":\"done\"}\n"));
    }
    if path == "/images/load" {
        return (
            200,
            json!(concat!(
                "{\"stream\":\"Loaded image ID: sha256:",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "\\n\"}\n"
            )),
        );
    }
    if path.starts_with("/images/") && path.ends_with("/json") {
        return (
            200,
            json!({"Id":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","RepoDigests":s.manifest_digest.as_ref().map(|d|vec![format!("fixture.invalid/harness@{d}")]).unwrap_or_default()}),
        );
    }
    if path == "/containers/create" {
        let name = query
            .split('&')
            .find_map(|v| v.strip_prefix("name="))
            .unwrap_or("fixture")
            .to_string();
        if s.containers.contains_key(&name) {
            return (409, json!({"message":"exists"}));
        }
        s.containers.insert(
            name.clone(),
            json!({"Id":name,"HostConfig":body["HostConfig"],"Config":body,"State":{"Running":false,"ExitCode":0}}),
        );
        return (201, json!({"Id":name,"Warnings":[]}));
    }
    if path == "/containers/json" {
        return(200,json!(s.containers.iter().map(|(n,v)|json!({"Id":n,"Names":[format!("/{n}")],"Labels":v["Config"]["Labels"]})).collect::<Vec<_>>()));
    }
    if let Some(rest) = path.strip_prefix("/containers/") {
        let (name, op) = rest.split_once('/').unwrap_or((rest, ""));
        if let Some(v) = s.containers.get_mut(name) {
            match (method, op) {
                ("GET", "logs") => {
                    let mut framed = vec![];
                    for (channel, message) in [
                        (1, b"synthetic-log".as_slice()),
                        (2, b"synthetic-stderr".as_slice()),
                    ] {
                        framed.extend([channel, 0, 0, 0]);
                        framed.extend((message.len() as u32).to_be_bytes());
                        framed.extend(message)
                    }
                    return (200, json!(String::from_utf8(framed).unwrap()));
                }
                ("GET", "json") => return (200, v.clone()),
                ("POST", "start") => {
                    v["State"]["Running"] = json!(true);
                    return (204, json!(""));
                }
                ("POST", "stop") => {
                    v["State"]["Running"] = json!(false);
                    return (204, json!(""));
                }
                ("POST", "rename") => {
                    let v = s.containers.remove(name).unwrap();
                    let to = query.strip_prefix("name=").unwrap();
                    s.containers.insert(to.into(), v);
                    return (204, json!(""));
                }
                ("POST", "exec") => return (201, json!({"Id":"exec-fixture"})),
                ("POST", "wait") => return (200, json!({"StatusCode":s.wait_code})),
                ("DELETE", "") => {
                    s.containers.remove(name);
                    return (204, json!(""));
                }
                _ => {}
            }
        }
        return (404, json!({"message":"not found"}));
    }
    if path == "/exec/exec-fixture/json" {
        return (200, json!({"Running":false,"ExitCode":7}));
    }
    if path == "/exec/exec-fixture/start" {
        return (200, json!(""));
    }
    if path == "/volumes/create" {
        let n = body["Name"].as_str().unwrap().to_string();
        let v = json!({"Name":n,"Driver":"local","Mountpoint":"/fixture","Labels":body["Labels"],"Options":{},"Scope":"local"});
        s.volumes.insert(n, v.clone());
        return (201, v);
    }
    if let Some(n) = path.strip_prefix("/volumes/") {
        if method == "DELETE" {
            s.volumes.remove(n);
            return (204, json!(""));
        }
        return s
            .volumes
            .get(n)
            .map(|v| (200, v.clone()))
            .unwrap_or((404, json!({"message":"not found"})));
    }
    if path == "/networks/create" {
        let n = body["Name"].as_str().unwrap().to_string();
        s.networks.insert(n.clone(), body);
        return (201, json!({"Id":n,"Warning":""}));
    }
    if let Some(n) = path.strip_prefix("/networks/") {
        return s
            .networks
            .get(n)
            .map(|v| (200, v.clone()))
            .unwrap_or((404, json!({"message":"not found"})));
    }
    (404, json!({"message":"not found"}))
}
