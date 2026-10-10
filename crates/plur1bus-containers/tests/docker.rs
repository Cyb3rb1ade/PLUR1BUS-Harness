#![cfg(unix)]
use plur1bus_containers::*;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    os::unix::fs::PermissionsExt,
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
        Self::with_networks(json!({"plur1bus-internal":{"IPAddress":"192.168.88.2"}}))
    }
    fn with_networks(networks: Value) -> Self {
        Self::with_networks_and_labels(networks, None)
    }
    fn with_networks_and_labels(networks: Value, labels: Option<Value>) -> Self {
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
                            json!({"Config":{"Image":body["Image"],"Labels":labels.as_ref().unwrap_or(&body["Labels"])},"State":{"Running":false,"Health":{"Status":"starting"}},"NetworkSettings":{"Networks":networks}}),
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
/// The fake curl is written and made executable once per process, before any test thread can reach `fork`: Linux refuses
/// to `exec` a file that some process still holds open for writing (ETXTBSY), and a `fork` on a sibling test thread
/// inherits the writer's descriptor until its own `exec`. Every test that spawns curl calls this first, so no fork can
/// overlap the write. Each test then hard-links the template into its own directory (see apple.rs).
fn curl_template() -> &'static std::path::Path {
    static T: std::sync::OnceLock<(tempfile::TempDir, std::path::PathBuf)> =
        std::sync::OnceLock::new();
    &T.get_or_init(|| {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("curl");
        fs::write(&p, "#!/bin/sh\nprintf '{}\\n200'\n").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        (d, p)
    })
    .1
}

#[test]
fn engine_api_stack_rollback_and_offline_load() {
    curl_template();
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
fn docker_connection_address_is_a_private_ip_like_apple() {
    let fake = FakeEngine::new();
    let r = fake.runtime();
    r.create(&Service::harness("local:test")).unwrap();
    let address = r.address("plur1bus-harness", "plur1bus-internal").unwrap();
    let ip: std::net::IpAddr = address
        .parse()
        .unwrap_or_else(|_| panic!("not an IP literal: {address}"));
    assert!(private_bind(ip), "{address}");
    assert_eq!(address, "192.168.88.2");
    assert!(r
        .address("plur1bus-harness", "another-network")
        .unwrap_err()
        .contains("network address absent"));
}
#[test]
fn docker_connection_address_refuses_missing_invalid_and_public_ips() {
    for (networks, expected) in [
        (Value::Null, "network address absent"),
        (json!({}), "network address absent"),
        (json!({"plur1bus-internal":{}}), "network address absent"),
        (
            json!({"plur1bus-internal":{"IPAddress":""}}),
            "network address absent",
        ),
        (
            json!({"plur1bus-internal":{"IPAddress":"plur1bus-harness"}}),
            "invalid network address",
        ),
        (
            json!({"plur1bus-internal":{"IPAddress":"8.8.8.8"}}),
            "public container address refused",
        ),
        (
            json!({"plur1bus-internal":{"IPAddress":"0.0.0.0"}}),
            "public container address refused",
        ),
    ] {
        let fake = FakeEngine::with_networks(networks.clone());
        let r = fake.runtime();
        r.create(&Service::harness("local:test")).unwrap();
        let error = r
            .address("plur1bus-harness", "plur1bus-internal")
            .unwrap_err();
        assert!(error.contains(expected), "{networks}: {error}");
    }
}
#[test]
fn docker_connection_address_refuses_absent_and_unowned_containers() {
    let fake = FakeEngine::new();
    let r = fake.runtime();
    assert!(r
        .address("plur1bus-harness", "plur1bus-internal")
        .unwrap_err()
        .contains("not found"));
    let unowned = FakeEngine::with_networks_and_labels(
        json!({"plur1bus-internal":{"IPAddress":"192.168.88.2"}}),
        Some(json!({})),
    );
    let r = unowned.runtime();
    r.create(&Service::harness("local:test")).unwrap();
    assert!(r
        .address("plur1bus-harness", "plur1bus-internal")
        .unwrap_err()
        .contains("unowned connection dependency"));
}
#[test]
fn detect_missing_and_refuse_unencrypted_remote_daemon() {
    curl_template();
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
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("curl");
    fs::hard_link(curl_template(), &fake).unwrap();
    let mut runtime = DockerRuntime::new("https://synthetic.invalid");
    runtime.curl = fake;
    assert_eq!(runtime.detect().state, RuntimeState::Unreachable);
}
