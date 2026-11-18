#![cfg(unix)]
#![forbid(unsafe_code)]
#![allow(clippy::unwrap_used, clippy::panic)]

use plur1bus_providers::{local::ManagedSocket, Adapter, Config, Json, Ports, ProviderError, Wire};
use plur1bus_wire_fixtures::{load_fixture, FakeUnixServer};
use std::net::SocketAddr;
use std::os::unix::fs::{symlink, MetadataExt as _, PermissionsExt as _};
use url::Url;

struct Local(u32);

impl Ports for Local {
    fn pin(&self, _: &Url) -> Result<SocketAddr, ProviderError> {
        panic!("AF1 must never resolve TCP")
    }
    fn socket_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(10)
    }

    fn credential(&self, _: Wire) -> Result<Option<String>, ProviderError> {
        panic!("AF1 must never look up credentials")
    }
    fn managed_uid(&self) -> Option<u32> {
        Some(self.0)
    }
    fn managed_available(&self) -> bool {
        true
    }
}

#[test]
fn managed_apple_fm_replays_health_models_and_completion_on_unix() {
    let recording = load_fixture("provider-local", "apple-fm");
    let root = tempfile::tempdir_in(if cfg!(target_os = "macos") {
        "/private/tmp"
    } else {
        "/tmp"
    })
    .unwrap();
    let root_path = root.path().canonicalize().unwrap();
    std::fs::set_permissions(&root_path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let uid = std::fs::metadata(&root_path).unwrap().uid();
    let path = root_path.join("fm.sock");
    let server = FakeUnixServer::start(&recording, &path);
    let socket = ManagedSocket::new(path.clone()).unwrap();
    socket.verify(Some(uid)).unwrap();
    assert_eq!(
        socket
            .verify(Some(uid.wrapping_add(1)))
            .unwrap_err()
            .code
            .as_deref(),
        Some("socket-untrusted")
    );
    let alias = root_path.join("alias.sock");
    symlink(&path, &alias).unwrap();
    assert_eq!(
        ManagedSocket::new(alias)
            .unwrap()
            .verify(Some(uid))
            .unwrap_err()
            .code
            .as_deref(),
        Some("socket-untrusted")
    );
    let adapter = Adapter::managed_apple_fm(socket, Config::default()).unwrap();
    let ports = Local(uid);
    let request = Json::parse(recording["requestJson"].as_str().unwrap()).unwrap();
    let results = [
        adapter.probe_managed(&ports, true).unwrap(),
        adapter.probe_managed(&ports, false).unwrap(),
        adapter.complete(&request, &ports).unwrap(),
    ];
    let exchanges = recording["exchanges"].as_array().unwrap();
    let received = server.received();
    assert_eq!(received.len(), exchanges.len());
    for ((actual, request), exchange) in results.into_iter().zip(received).zip(exchanges) {
        assert_eq!(actual, exchange["expected"]);
        assert_eq!(request["body"], exchange["request"]["bodyText"]);
        assert_eq!(request["path"], exchange["request"]["path"]);
        assert_eq!(request["method"], exchange["request"]["method"]);
        assert_eq!(request["headers"]["host"], exchange["request"]["host"]);
        assert_eq!(request["headers"]["accept"], exchange["request"]["accept"]);
        assert!(request["headers"].get("authorization").is_none());
    }
}
