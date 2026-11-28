#![allow(clippy::unwrap_used, reason = "catalog fixture assertions")]

use plur1bus_media::{
    adapters::{probe_draw_things, ImageAdapter, ImageCatalog},
    http::{Auth, Cleartext, Client, Options, Ports},
    jobs::{Error, Result},
};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::{json, Value};
use std::{
    cell::Cell,
    net::SocketAddr,
    time::{Duration, Instant, UNIX_EPOCH},
};
use url::Url;

struct Local(Option<SocketAddr>, bool);
impl Ports for Local {
    fn pin(&self, endpoint: &Url, _: Instant) -> Option<SocketAddr> {
        self.0
            .filter(|address| endpoint.port() == Some(address.port()))
    }
    fn credential(&self, _: Auth, _: Instant) -> Result<Option<String>> {
        Ok(None)
    }
    fn random(&self) -> f64 {
        0.0
    }
    fn wait(&self, _: Duration, _: Instant) -> Result<()> {
        Ok(())
    }
    fn draw_things_installed_on_mac(&self) -> Option<bool> {
        Some(self.1)
    }
}

#[test]
fn discovery_and_offline_refresh_replay_the_typescript_behavior() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/media/media-discovery.json"
    ))
    .unwrap();
    let input = &fixture["input"];
    let expected = &fixture["expected"];
    let wire = FakeServer::start(&fixture);
    let base = format!("http://{}", wire.addr);
    let http = |host| {
        Client::new(
            host,
            &base,
            Options {
                cleartext: Some(Cleartext::Loopback),
                ..Options::default()
            },
        )
        .unwrap()
    };
    let connected = Local(Some(wire.addr), false);
    let adapter = ImageAdapter::new(
        "openrouter".parse().unwrap(),
        "sample/image",
        http(&connected),
        Duration::from_millis(1),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    assert_eq!(
        json!(adapter.list_models(deadline).unwrap()),
        expected["models"]
    );
    assert_eq!(
        json!(probe_draw_things(&http(&connected), deadline)),
        expected["running"]
    );
    assert_eq!(
        json!(probe_draw_things(&http(&Local(None, true)), deadline)),
        expected["apiOff"]
    );
    assert_eq!(
        json!(probe_draw_things(&http(&Local(None, false)), deadline)),
        expected["notInstalled"]
    );
    let calls = wire.received();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["path"], fixture["exchanges"][0]["request"]["path"]);
    assert_eq!(calls[1]["path"], fixture["exchanges"][1]["request"]["path"]);

    let catalog = ImageCatalog::new(
        Duration::from_millis(input["ttl"].as_u64().unwrap()),
        Duration::from_millis(input["backoff"].as_u64().unwrap()),
    )
    .unwrap();
    let count = Cell::new(0u32);
    for snapshot in expected["snapshots"].as_array().unwrap() {
        assert_eq!(json!(count.get()), snapshot["reads"]);
        let moment = UNIX_EPOCH + Duration::from_millis(snapshot["now"].as_u64().unwrap());
        let models = catalog
            .update(
                || moment,
                || true,
                || {
                    count.set(count.get() + 1);
                    match count.get() {
                        1 => Ok(input["first"].clone()),
                        2 => Err(Error::BackendUnavailable.into()),
                        _ => Ok(input["last"].clone()),
                    }
                },
            )
            .unwrap();
        assert_eq!(json!(models), snapshot["models"]);
    }
    assert_eq!(json!(count.get()), expected["reads"]);
}
