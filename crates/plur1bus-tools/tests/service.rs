//! Real-binary lifecycle, framing and Core-only dispatch; all children are killed and reaped by Drop.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Service {
    child: Child,
    home: tempfile::TempDir,
}

impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn address(home: &Path) -> String {
    if cfg!(windows) {
        use sha2::{Digest, Sha256};
        let hash = format!(
            "{:x}",
            Sha256::digest(home.to_string_lossy().to_lowercase())
        );
        format!(r"\\.\pipe\plur1bus-{}-tools", &hash[..16])
    } else {
        home.join("run/tools.sock").display().to_string()
    }
}

impl Service {
    fn start() -> Self {
        Self::start_with(&[])
    }

    fn start_with(args: &[&str]) -> Self {
        let home = tempfile::tempdir().unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_plur1bus-tools"))
            .args(["serve", "--home"])
            .arg(home.path())
            .args(["--lifeline", "stdin"])
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut service = Self { child, home };
        let deadline = Instant::now() + Duration::from_secs(5);
        while !service.path("tools-core.token").exists() {
            assert!(
                service.child.try_wait().unwrap().is_none(),
                "tools exited before readiness"
            );
            assert!(Instant::now() < deadline, "tools readiness timed out");
            std::thread::sleep(Duration::from_millis(10));
        }
        service
    }

    fn path(&self, name: &str) -> PathBuf {
        self.home.path().join("run").join(name)
    }

    fn stream(&self) -> BufReader<Box<dyn plur1bus_rpc::transport::Stream>> {
        let stream =
            plur1bus_rpc::transport::connect(&address(self.home.path()), Duration::from_secs(2))
                .unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        BufReader::new(stream)
    }

    fn control(&self) -> Client {
        Client::connect(
            &address(self.home.path()),
            &std::fs::read_to_string(self.path("tools.token")).unwrap(),
            ConnectOptions {
                endpoint: Endpoint::Module,
                expected_server_pid: Some(self.child.id()),
                ..Default::default()
            },
        )
        .unwrap()
    }
}

fn call(
    stream: &mut BufReader<Box<dyn plur1bus_rpc::transport::Stream>>,
    method: &str,
    params: Value,
) -> Value {
    let mut request = json!({"jsonrpc":"2.0","id":1,"method":method});
    request["params"] = params;
    writeln!(stream.get_mut(), "{request}").unwrap();
    stream.get_mut().flush().unwrap();
    let mut line = String::new();
    stream.read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

fn key() -> String {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).unwrap();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn only_core_credentials_reach_tools_handlers_and_exchange_the_ticket_key() {
    let service = Service::start();
    let mut stranger = service.stream();
    assert_eq!(
        call(&mut stranger, "tools.health", json!({}))["error"]["data"]["error"],
        "E_DENIED"
    );
    let mut control = service.control();
    assert!(control.call("module.status", json!({})).unwrap()["process"]["state"] == "ready");
    let denied = control.call("tools.health", json!({})).unwrap_err();
    assert!(denied.to_string().contains("E_DENIED"));
    let mut core = service.stream();
    let ticket_key = key();
    let hello = call(
        &mut core,
        "tools.hello",
        json!({
            "token":std::fs::read_to_string(service.path("tools-core.token")).unwrap(), "ticketKey":ticket_key,
        }),
    );
    assert_eq!(hello["result"]["pid"], service.child.id());
    assert!(hello["result"]["capabilities"]["methods"]["tools.health"].is_object());
    assert!(!hello.to_string().contains(&ticket_key));
    assert_eq!(
        call(&mut core, "tools.health", json!({}))["result"]["process"]["state"],
        "ready"
    );
    assert_eq!(
        call(&mut core, "tools.health", json!({"principal":"core"}))["error"]["data"]["error"],
        "E_INVALID_PARAMS"
    );
    assert_eq!(
        call(&mut core, "module.shutdown", json!({}))["error"]["data"]["error"],
        "E_DENIED"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(service.path("tools-core.token"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(service.path("tools.sock"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn adoption_proves_the_supervisor_nonce_and_replaces_the_original_lifeline() {
    let mut service = Service::start();
    let mut control = service.control();
    assert!(control
        .call("module.adopt", json!({"nonce":key()}))
        .is_err());
    let nonce = key();
    std::fs::write(service.path("supervisor.token"), &nonce).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            service.path("supervisor.token"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    assert_eq!(
        control
            .call("module.adopt", json!({"nonce":nonce}))
            .unwrap()["status"]["process"]["state"],
        "ready"
    );
    drop(service.child.stdin.take());
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        control.call("module.status", json!({})).unwrap()["process"]["state"],
        "ready"
    );
    assert_eq!(
        control.call("module.shutdown", json!({})).unwrap()["accepted"],
        true
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = service.child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(Instant::now() < deadline, "tools failed to stop");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!service.path("tools-core.token").exists());
}

#[test]
fn lifeline_eof_exits_after_the_configured_grace_and_cleans_run_files() {
    let mut service = Service::start_with(&["--grace-ms", "25"]);
    drop(service.child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = service.child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(Instant::now() < deadline, "orphan grace did not expire");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!service.path("tools.pid").exists());
    assert!(!service.path("tools-core.token").exists());
}
