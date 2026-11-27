use plur1bus_channels::http::{Http, HttpPorts};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::{json, Value};
use std::net::SocketAddr;
use url::Url;

struct Loopback(SocketAddr);

impl HttpPorts for Loopback {
    fn resolver(&self) -> plur1bus_providers::resolution::Resolver<Url, Option<SocketAddr>> {
        let address = self.0;
        std::sync::Arc::new(move |endpoint, _, _| {
            (endpoint.host_str() == Some("127.0.0.1") && endpoint.port() == Some(address.port()))
                .then_some(address)
        })
    }
}

pub(super) struct Replay {
    server: FakeServer,
    exchanges: Vec<Value>,
    ports: Loopback,
}

impl Replay {
    pub(super) fn start(case: &Value, replacements: &[(&str, &str)]) -> Self {
        let mut exchanges = case["exchanges"].to_string();
        for (placeholder, marker) in replacements {
            exchanges = exchanges.replace(placeholder, marker);
        }
        let exchanges: Vec<Value> = serde_json::from_str(&exchanges).unwrap();
        let server = FakeServer::start(&json!({"transport": "http", "exchanges": exchanges}));
        let ports = Loopback(server.addr);
        Self {
            server,
            exchanges,
            ports,
        }
    }

    pub(super) fn connect(&self) -> (Http<'_>, Url) {
        (
            Http::new(&self.ports, true),
            Url::parse(&format!("http://{}/v1", self.server.addr)).unwrap(),
        )
    }

    pub(super) fn verify(&self, name: &Value) {
        let received = self.server.received();
        assert_eq!(received.len(), self.exchanges.len(), "{name}");
        for (request, expected) in received.iter().zip(&self.exchanges) {
            let expected = &expected["request"];
            assert_eq!(request["method"], expected["method"], "{name}");
            assert_eq!(request["path"], expected["path"], "{name}");
            assert_eq!(request["body"], expected["bodyText"], "{name}");
            for (key, value) in expected["headers"].as_object().unwrap() {
                assert_eq!(&request["headers"][key], value, "{name} {key}");
            }
            for key in ["authorization", "content-type"] {
                if expected["headers"].get(key).is_none() {
                    assert!(
                        request["headers"].get(key).is_none(),
                        "{name} unexpected {key}"
                    );
                }
            }
        }
    }
}
