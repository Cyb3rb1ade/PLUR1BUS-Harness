#![allow(clippy::unwrap_used, reason = "loopback recording assertions")]

use plur1bus_voice_providers::{
    http::{Error, Ports},
    polly::{list_voices, synthesize, Http, Options, Signer},
};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    net::SocketAddr,
    time::{Duration, Instant},
};
use url::Url;

const AUTHORIZATION: &str = "synthetic-polly-authorization";

struct Host {
    addr: SocketAddr,
    signed: RefCell<Vec<(String, String, Vec<u8>)>>,
}

impl Ports for Host {
    fn pin(&self, _: &Url, _: Instant) -> Option<SocketAddr> {
        Some(self.addr)
    }
}

impl Signer for Host {
    fn sign(
        &self,
        endpoint: &Url,
        method: &str,
        _: &[(&str, &str)],
        body: &[u8],
        _: Instant,
    ) -> Result<Vec<(String, String)>, Error> {
        let target = &endpoint[url::Position::BeforePath..];
        self.signed
            .borrow_mut()
            .push((method.to_owned(), target.to_owned(), body.to_vec()));
        Ok(vec![("authorization".into(), AUTHORIZATION.into())])
    }
}

#[test]
fn polly_http_matches_the_production_sdk_bytes_paging_and_error_class() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/voice/polly-http.json"
    ))
    .unwrap();
    let server = FakeServer::start(&fixture);
    let host = Host {
        addr: server.addr,
        signed: RefCell::default(),
    };
    let base = Url::parse(&format!("http://{}", server.addr)).unwrap();
    let polly = Http::new(base, &host).unwrap().with_loopback_http();
    let budget = Duration::from_secs(5);
    let input = &fixture["input"];
    let options = Options {
        voice: input["voice"].as_str().unwrap(),
        language: input["language"].as_str(),
        ..Options::default()
    };
    let text = input["text"].as_str().unwrap();
    let audio = synthesize(&polly, text, &options, budget).unwrap();
    assert_eq!(
        STANDARD.encode(audio.bytes),
        fixture["expected"]["dataBase64"]
    );
    assert_eq!(
        audio.sample_rate,
        fixture["expected"]["sampleRate"].as_u64().unwrap() as u32
    );
    assert_eq!(
        serde_json::json!(list_voices(&polly, budget).unwrap()),
        fixture["expected"]["voices"]
    );

    let failure = synthesize(
        &polly,
        text,
        &Options {
            language: None,
            ..options
        },
        budget,
    )
    .err()
    .unwrap();
    assert_eq!(failure.code(), fixture["expected"]["errorCode"]);
    assert!(!format!("{failure:?} {failure}").contains(AUTHORIZATION));

    let received = server.received();
    let signed = host.signed.borrow();
    let exchanges = fixture["exchanges"].as_array().unwrap();
    assert_eq!(received.len(), exchanges.len());
    assert_eq!(signed.len(), exchanges.len());
    for ((request, signed), exchange) in received.iter().zip(signed.iter()).zip(exchanges) {
        let expected = &exchange["request"];
        assert_eq!(request["method"], expected["method"]);
        assert_eq!(request["path"], expected["path"]);
        assert_eq!(request["body"], expected["bodyText"]);
        assert_eq!(request["headers"]["authorization"], AUTHORIZATION);
        assert_eq!(
            request["headers"]["content-type"],
            expected["headers"]["content-type"]
        );
        assert_eq!(signed.0, expected["method"]);
        assert_eq!(signed.1, expected["path"]);
        assert_eq!(signed.2, expected["bodyText"].as_str().unwrap().as_bytes());
    }
}

#[test]
fn unused_pin_denies_the_request_before_asking_for_a_signature() {
    let fixture = json!({"transport":"http","exchanges":[]});
    let server = FakeServer::start(&fixture);
    let host = Host {
        addr: server.addr,
        signed: RefCell::default(),
    };
    let unauthorized_port = if server.addr.port() == 1 { 2 } else { 1 };
    let base = Url::parse(&format!("http://127.0.0.1:{unauthorized_port}")).unwrap();
    let polly = Http::new(base, &host).unwrap().with_loopback_http();
    assert_eq!(
        list_voices(&polly, Duration::from_secs(1)),
        Err(Error::InvalidRequest)
    );
    assert!(host.signed.borrow().is_empty());
    assert!(server.received().is_empty());
}

#[test]
fn body_only_diagnostics_have_an_inclusive_decoded_limit() {
    const LIMIT: usize = 64 * 1024;
    for (length, outcome) in [(LIMIT, Error::Auth), (LIMIT + 1, Error::BadResponse)] {
        let empty = json!({"code":"AccessDeniedException","message":""});
        let filler = "a".repeat(length - empty.to_string().len());
        let fixture = json!({"transport":"http", "exchanges":[{
            "request":{"method":"GET","path":"/v1/voices"},
            "response":{"status":400,"body":{"code":"AccessDeniedException","message":filler}},
        }]});
        let server = FakeServer::start(&fixture);
        let host = Host {
            addr: server.addr,
            signed: RefCell::default(),
        };
        let base = Url::parse(&format!("http://{}", server.addr)).unwrap();
        let polly = Http::new(base, &host).unwrap().with_loopback_http();
        assert_eq!(list_voices(&polly, Duration::from_secs(1)), Err(outcome));
        assert_eq!(server.received().len(), 1);
    }
}

#[test]
fn diagnostic_body_read_ends_at_the_original_deadline() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let fixture = json!({"transport":"http", "exchanges":[{
        "request":{"method":"GET","path":"/v1/voices"},
        "response":{"status":400,"chunkGapMs":700,
            "chunksBase64":[STANDARD.encode(b"{\"code\":"),STANDARD.encode(b"\"AccessDeniedException\"}")]},
    }]});
    let server = FakeServer::start(&fixture);
    let host = Host {
        addr: server.addr,
        signed: RefCell::default(),
    };
    let base = Url::parse(&format!("http://{}", server.addr)).unwrap();
    let polly = Http::new(base, &host).unwrap().with_loopback_http();
    assert_eq!(
        list_voices(&polly, Duration::from_millis(350)),
        Err(Error::Timeout)
    );
    assert_eq!(server.received().len(), 1);
}
