//! `containers.bindAddress` end to end at the runtime layer: the published address reaches the Docker API body and the
//! Apple CLI arguments for every published port, loopback is the default, nothing is published without a host port, and
//! a non-loopback address carries a warning. The Docker half runs against a minimal fake engine on a Unix socket.
#![cfg(unix)]
use plur1bus_containers::*;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::IpAddr,
    os::unix::fs::PermissionsExt,
    os::unix::net::{UnixListener, UnixStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

fn ip(s: &str) -> IpAddr {
    s.parse().unwrap()
}
fn published(bind: &str, port: Option<u16>) -> Service {
    let mut s = Service::harness("local:test");
    s.bind = ip(bind);
    s.publish = port;
    s
}

#[test]
fn nothing_is_published_by_default_and_loopback_is_the_default_bind() {
    let s = Service::harness("local:test");
    assert_eq!(s.bind, ip("127.0.0.1"));
    assert!(published_ports(&s).is_empty());
    assert!(bind_warnings(&[s]).is_empty());
}

#[test]
fn published_ports_carry_the_bind_address() {
    let ports = published_ports(&published("192.168.1.10", Some(28700)));
    assert_eq!(
        ports,
        vec![PublishedPort {
            service: "plur1bus-harness".into(),
            address: ip("192.168.1.10"),
            host_port: 28700,
            container_port: 18700
        }]
    );
    assert_eq!(
        serde_json::to_value(&ports).unwrap(),
        json!([{"service":"plur1bus-harness","address":"192.168.1.10","hostPort":28700,"containerPort":18700}])
    );
}

#[test]
fn loopback_has_no_warning_and_every_other_allowed_address_has_one() {
    for lo in ["127.0.0.1", "127.9.9.9", "::1"] {
        assert!(
            bind_warnings(&[published(lo, Some(18700))]).is_empty(),
            "{lo}"
        );
    }
    for (addr, kind) in [
        ("192.168.1.10", "private LAN"),
        ("10.0.0.5", "private LAN"),
        ("172.16.3.4", "private LAN"),
        ("100.101.102.103", "tailnet"),
        ("fd00::5", "unique-local"),
    ] {
        let w = bind_warnings(&[published(addr, Some(18700))]);
        assert_eq!(w.len(), 1, "{addr}");
        assert!(
            w[0].contains(addr) && w[0].contains(kind),
            "{addr}: {}",
            w[0]
        );
        assert!(
            w[0].contains("18700") && w[0].contains("authentication"),
            "{}",
            w[0]
        );
    }
}

#[test]
fn a_service_that_publishes_nothing_never_warns_whatever_its_bind() {
    assert!(bind_warnings(&[published("192.168.1.10", None)]).is_empty());
}

#[test]
fn wildcard_and_public_addresses_stay_refused_with_or_without_a_port() {
    for addr in ["0.0.0.0", "::", "8.8.8.8", "2001:db8::1"] {
        for port in [None, Some(18700)] {
            assert!(published(addr, port).validate().is_err(), "{addr} {port:?}");
        }
    }
}

mod apple {
    use super::*;
    /// Written and made executable once per process before any fork (see tests/apple.rs); one hard link per test.
    fn template() -> &'static std::path::Path {
        static T: std::sync::OnceLock<(tempfile::TempDir, std::path::PathBuf)> =
            std::sync::OnceLock::new();
        &T.get_or_init(|| {
            let d = tempfile::tempdir().unwrap();
            let p = d.path().join("container");
            fs::write(&p, include_str!("fixtures/container.py")).unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
            (d, p)
        })
        .1
    }
    fn calls_for(s: Service) -> String {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("container");
        fs::hard_link(template(), &p).unwrap();
        let r = AppleContainerRuntime::new(p, Platform::MacArm, 26);
        let mut stack = StackManager::new(&r, vec![s]);
        stack.health_timeout = Duration::ZERO;
        stack.up().unwrap();
        let calls = fs::read_to_string(d.path().join("calls.jsonl")).unwrap();
        stack.down().unwrap();
        calls
    }
    #[test]
    fn publish_argument_carries_the_configured_address() {
        for (bind, expected) in [
            ("127.0.0.1", "--publish\", \"127.0.0.1:28700:18700"),
            ("192.168.1.10", "--publish\", \"192.168.1.10:28700:18700"),
            (
                "100.101.102.103",
                "--publish\", \"100.101.102.103:28700:18700",
            ),
            ("fd00::5", "--publish\", \"[fd00::5]:28700:18700"),
        ] {
            let calls = calls_for(published(bind, Some(28700)));
            assert!(calls.contains(expected), "{bind}: {calls}");
        }
    }
    #[test]
    fn without_a_host_port_no_publish_argument_exists() {
        assert!(!calls_for(published("192.168.1.10", None)).contains("--publish"));
    }
}

mod docker {
    use super::*;
    struct Engine {
        dir: tempfile::TempDir,
        creates: Arc<Mutex<Vec<Value>>>,
        stop: Arc<AtomicBool>,
        task: Option<thread::JoinHandle<()>>,
    }
    impl Engine {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let listener = UnixListener::bind(dir.path().join("docker.sock")).unwrap();
            listener.set_nonblocking(true).unwrap();
            let creates = Arc::new(Mutex::new(vec![]));
            let stop = Arc::new(AtomicBool::new(false));
            let (c, done) = (creates.clone(), stop.clone());
            let task = thread::spawn(move || {
                while !done.load(Ordering::SeqCst) {
                    let Ok((mut socket, _)) = listener.accept() else {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    };
                    // The wake-up connection from `Drop` may already be closed; macOS then refuses the timeout.
                    if socket
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .is_err()
                    {
                        continue;
                    }
                    let mut header = vec![];
                    let mut byte = [0];
                    while !header.ends_with(b"\r\n\r\n") {
                        if socket.read(&mut byte).unwrap_or(0) == 0 {
                            break;
                        }
                        header.push(byte[0]);
                    }
                    let header = String::from_utf8(header).unwrap();
                    let mut parts = header.lines().next().unwrap_or("").split_whitespace();
                    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
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
                            let n =
                                usize::from_str_radix(String::from_utf8(line).unwrap().trim(), 16)
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
                    if method == "POST" && path.contains("/containers/create") {
                        c.lock().unwrap().push(body);
                    }
                    // Networks and volumes are "absent" until created; everything else succeeds.
                    let code = if method == "GET" && path.contains("/v1.47/") {
                        404
                    } else {
                        200
                    };
                    let payload = json!({"Id":"test"}).to_string();
                    let _ = write!(socket, "HTTP/1.1 {code} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len());
                }
            });
            Self {
                dir,
                creates,
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
        fn create_body(&self, s: &Service) -> Value {
            self.runtime().create(s).unwrap();
            self.creates.lock().unwrap().last().cloned().unwrap()
        }
    }
    impl Drop for Engine {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            let _ = UnixStream::connect(self.dir.path().join("docker.sock"));
            self.task.take().unwrap().join().unwrap();
        }
    }

    #[test]
    fn port_binding_carries_the_configured_host_address() {
        let e = Engine::new();
        for bind in ["127.0.0.1", "192.168.1.10", "100.101.102.103", "fd00::5"] {
            let body = e.create_body(&published(bind, Some(28700)));
            assert_eq!(
                body["HostConfig"]["PortBindings"],
                json!({"18700/tcp":[{"HostIp":bind,"HostPort":"28700"}]}),
                "{bind}"
            );
            assert_eq!(body["ExposedPorts"], json!({"18700/tcp":{}}), "{bind}");
        }
    }
    #[test]
    fn without_a_host_port_nothing_is_bound() {
        let e = Engine::new();
        let body = e.create_body(&published("192.168.1.10", None));
        assert_eq!(body["HostConfig"]["PortBindings"], json!({}));
        assert_eq!(body["ExposedPorts"], json!({}));
    }
    #[test]
    fn a_wildcard_bind_is_refused_before_the_engine_is_asked() {
        let e = Engine::new();
        assert!(e
            .runtime()
            .create(&published("0.0.0.0", Some(28700)))
            .is_err());
        assert!(e.creates.lock().unwrap().is_empty());
    }
}
