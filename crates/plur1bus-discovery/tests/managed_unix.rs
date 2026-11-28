#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::panic, reason = "recorded Unix fixture")]

use plur1bus_discovery::{
    managed::Managed,
    scanners::{self, Scanner},
};
use plur1bus_providers::{local::ManagedSocket, Ports, ProviderError, Wire};
use plur1bus_wire_fixtures::FakeUnixServer;
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    os::unix::fs::{MetadataExt as _, PermissionsExt as _},
    time::{Duration, Instant},
};
use url::Url;

struct Host(u32);
impl Ports for Host {
    fn pin(&self, _: &Url) -> Result<SocketAddr, ProviderError> {
        panic!("managed scan must not resolve TCP")
    }
    fn socket_timeout(&self) -> Duration {
        Duration::from_secs(5)
    }
    fn credential(&self, _: Wire) -> Result<Option<String>, ProviderError> {
        panic!("managed scan must not read credentials")
    }
    fn managed_uid(&self) -> Option<u32> {
        Some(self.0)
    }
    fn managed_available(&self) -> bool {
        true
    }
}

#[test]
fn apple_discovery_reuses_the_private_provider_socket() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/discovery/scanners.json"
    ))
    .unwrap();
    let case = &fixtures["cases"][1];
    let root = tempfile::tempdir_in(if cfg!(target_os = "macos") {
        "/private/tmp"
    } else {
        "/tmp"
    })
    .unwrap();
    let root = root.path().canonicalize().unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let host = Host(std::fs::metadata(&root).unwrap().uid());
    let path = root.join("fm.sock");
    let server = FakeUnixServer::start(
        &json!({
            "transport":"http",
        "exchanges": [{
                "name": "apple-model-list", "request":{"method":"GET","path":"/v1/models"},
                "response":{"status":200,"body":case["responses"][0]}
            }]
        }),
        &path,
    );
    let mut port = Managed::new(ManagedSocket::new(path).unwrap(), &host).unwrap();
    // The transport receives a cancelled page with a healthy host and socket.
    let interrupted = scanners::Port::get_with_cancel(
        &mut port,
        scanners::Page {
            path: "/models",
            query: Vec::new(),
            headers: Default::default(),
            deadline: Instant::now() + Duration::from_secs(2),
            max_bytes: 1024,
        },
        &|| true,
    );
    assert_eq!(interrupted.err().unwrap().reason, "aborted");
    assert!(server.received().is_empty());
    let result = scanners::scan(
        Scanner::OpenAi,
        true,
        &mut port,
        Instant::now() + Duration::from_secs(5),
        &|| false,
    )
    .unwrap();
    assert_eq!(serde_json::to_value(result).unwrap(), case["expected"]);
    let requests = server.received();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["path"], "/v1/models");
    assert_eq!(requests[0]["headers"]["accept"], "application/json");
    assert!(requests[0]["headers"].get("authorization").is_none());
}
