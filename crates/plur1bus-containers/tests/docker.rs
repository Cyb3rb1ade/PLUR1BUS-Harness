#![cfg(unix)]
use plur1bus_containers::*;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
struct FakeEngine {
    dir: tempfile::TempDir,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    stop: Arc<AtomicBool>,
    task: Option<thread::JoinHandle<()>>,
}
impl FakeEngine {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let listener = UnixListener::bind(dir.path().join("docker.sock")).unwrap();
        listener.set_nonblocking(true).unwrap();
        let calls = Arc::new(Mutex::new(vec![]));
        let stop = Arc::new(AtomicBool::new(false));
        let c = calls.clone();
        let done = stop.clone();
        let task = thread::spawn(move || {
            let mut resources = BTreeMap::<String, Value>::new();
            let mut container: Option<Value> = None;
            while !done.load(Ordering::SeqCst) {
                let mut socket = match listener.accept() {
                    Ok((s, _)) => s,
                    Err(_) => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut header = vec![];
                let mut byte = [0];
                while !header.ends_with(b"\r\n\r\n") {
                    if socket.read(&mut byte).unwrap_or(0) == 0 {
                        break;
                    }
                    header.push(byte[0]);
                }
                let header = String::from_utf8(header).unwrap();
                let line = header.lines().next().unwrap_or("");
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or("");
                let path = parts.next().unwrap_or("");
                let len = header
                    .lines()
                    .find_map(|l| {
                        l.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                let mut bytes = vec![0; len];
                socket.read_exact(&mut bytes).unwrap();
                if header.to_lowercase().contains("transfer-encoding: chunked") {
                    loop {
                        let mut line = Vec::new();
                        while !line.ends_with(b"\r\n") {
                            socket.read_exact(&mut byte).unwrap();
                            line.push(byte[0]);
                        }
                        let n = usize::from_str_radix(String::from_utf8(line).unwrap().trim(), 16)
                            .unwrap();
                        let mut chunk = vec![0; n];
                        socket.read_exact(&mut chunk).unwrap();
                        bytes.extend(chunk);
                        let mut end = [0; 2];
                        socket.read_exact(&mut end).unwrap();
                        if n == 0 {
                            break;
                        }
                    }
                }
                let body = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
                c.lock()
                    .unwrap()
                    .push((format!("{method} {path}"), body.clone()));
                let mut code = 200;
                let mut result = json!({});
                match (method, path) {
                    ("GET", "/version") => result = json!({"Version":"29.4.0"}),
                    ("GET", "/v1.47/containers/plur1bus-harness/json") => {
                        if let Some(v) = &container {
                            result = v.clone();
                        } else {
                            code = 404;
                        }
                    }
                    ("POST", "/v1.47/containers/create?name=plur1bus-harness") => {
                        container = Some(
                            json!({"Config":{"Image":body["Image"],"Labels":body["Labels"]},"State":{"Running":false,"Health":{"Status":"starting"}}}),
                        );
                        result = json!({"Id":"test"});
                    }
                    ("POST", "/v1.47/containers/plur1bus-harness/start") => {
                        let v = container.as_mut().unwrap();
                        v["State"]["Running"] = json!(true);
                        v["State"]["Health"]["Status"] =
                            json!(if v["Config"]["Image"].as_str().unwrap().contains("bad") {
                                "unhealthy"
                            } else {
                                "healthy"
                            });
                    }
                    ("POST", "/v1.47/containers/plur1bus-harness/stop?t=150") => {
                        container.as_mut().unwrap()["State"]["Running"] = json!(false)
                    }
                    ("DELETE", "/v1.47/containers/plur1bus-harness") => container = None,
                    ("POST", "/v1.47/images/load?quiet=1") => {
                        result = json!({"stream":"Loaded image"})
                    }
                    _ if path.starts_with("/v1.47/images/create?") => {
                        result = json!({"status":"pulled"})
                    }
                    _ if path.ends_with("/create") => {
                        let kind = path.split('/').nth(2).unwrap();
                        let name = body["Name"].as_str().unwrap();
                        resources.insert(format!("/v1.47/{kind}/{name}"), body.clone());
                    }
                    _ if method == "GET" => {
                        if let Some(v) = resources.get(path) {
                            result = v.clone();
                        } else {
                            code = 404;
                        }
                    }
                    _ if method == "DELETE" => {
                        resources.remove(path);
                    }
                    _ => {}
                }
                let payload = result.to_string();
                let _=write!(socket,"HTTP/1.1 {code} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",payload.len());
            }
        });
        Self {
            dir,
            calls,
            stop,
            task: Some(task),
        }
    }
    fn runtime(&self) -> DockerRuntime {
        DockerRuntime::new(format!(
            "unix://{}",
            self.dir.path().join("docker.sock").display()
        ))
    }
}
impl Drop for FakeEngine {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = UnixStream::connect(self.dir.path().join("docker.sock"));
        self.task.take().unwrap().join().unwrap();
    }
}
#[test]
fn engine_api_stack_rollback_and_offline_load() {
    let fake = FakeEngine::new();
    let r = fake.runtime();
    assert_eq!(r.detect().state, RuntimeState::Ready);
    let mut stack = StackManager::new(&r, vec![Service::harness("local:good")]);
    stack.health_timeout = Duration::ZERO;
    stack.up().unwrap();
    stack.up().unwrap();
    assert!(stack.status().unwrap()[0].1.as_ref().unwrap().healthy);
    let e = stack
        .upgrade_image("plur1bus-harness", "local:bad")
        .unwrap_err();
    assert!(e.contains("rollback: Ok"), "{e}");
    assert_eq!(
        stack.status().unwrap()[0].1.as_ref().unwrap().image,
        "local:good"
    );
    let tar = fake.dir.path().join("offline.tar");
    std::fs::write(&tar, b"{}").unwrap();
    r.load(&tar).unwrap();
    stack.down().unwrap();
    assert!(stack.status().unwrap()[0].1.is_none());
    let calls = fake.calls.lock().unwrap();
    let body = &calls
        .iter()
        .find(|(p, _)| p.contains("containers/create"))
        .unwrap()
        .1;
    assert_eq!(body["HostConfig"]["ReadonlyRootfs"], true);
    assert_eq!(
        body["HostConfig"]["SecurityOpt"][0],
        "no-new-privileges:true"
    );
    assert_eq!(body["HostConfig"]["CapDrop"][0], "ALL");
    assert_eq!(body["Labels"]["app.plur1bus.stack"], "distribution");
    assert_eq!(body["HostConfig"]["PortBindings"], json!({}));
}
#[test]
fn detect_missing_and_refuse_unencrypted_remote_daemon() {
    let r = DockerRuntime::new("unix:///nonexistent/docker.sock");
    assert_eq!(r.detect().state, RuntimeState::Missing);
    let r = DockerRuntime::new("tcp://192.168.1.1:2375");
    assert_ne!(r.detect().state, RuntimeState::Ready);
    assert!(r.ensure_running().unwrap_err().contains("TLS"));
}
#[test]
fn docker_stream_framing() {
    assert_eq!(
        decode_docker_stream(&[1, 0, 0, 0, 0, 0, 0, 2, b'o', b'k']).unwrap(),
        "ok"
    );
    assert!(decode_docker_stream(&[1]).is_err());
}
#[test]
fn a_json_service_without_an_engine_version_is_not_a_ready_runtime() {
    use std::{fs, os::unix::fs::PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("curl");
    fs::write(&fake, "#!/bin/sh\nprintf '{}\\n200'\n").unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
    let mut runtime = DockerRuntime::new("https://synthetic.invalid");
    runtime.curl = fake;
    assert_eq!(runtime.detect().state, RuntimeState::Unreachable);
}
