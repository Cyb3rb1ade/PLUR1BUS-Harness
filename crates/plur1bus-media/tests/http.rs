#![allow(
    clippy::unwrap_used,
    reason = "synthetic media wire fixture assertions"
)]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_media::{
    http::{Auth, Body, Cleartext, Client, Method, Options, Ports},
    images::Format,
    jobs::{Error, Result},
};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    io::Write,
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use url::Url;

struct Host {
    address: SocketAddr,
    waits: RefCell<Vec<u64>>,
    credentials: Cell<usize>,
    cancelled: Arc<AtomicBool>,
}

impl Host {
    fn local(address: SocketAddr) -> Self {
        Self {
            address,
            waits: RefCell::new(Vec::new()),
            credentials: Cell::new(0),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Ports for Host {
    fn pin(&self, endpoint: &Url, _: Instant) -> Option<SocketAddr> {
        (endpoint.port() == Some(self.address.port())).then_some(self.address)
    }

    fn credential(&self, _: Auth, _: Instant) -> Result<Option<String>> {
        self.credentials.set(self.credentials.get() + 1);
        Ok(None)
    }

    fn random(&self) -> f64 {
        0.25
    }

    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    fn wait(&self, delay: Duration, _: Instant) -> Result<()> {
        self.waits.borrow_mut().push(delay.as_millis() as u64);
        Ok(())
    }
}

#[test]
fn media_transport_replays_status_retry_and_image_download() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/media/adapter-http.json"
    ))
    .unwrap();
    let server = FakeServer::start(&fixture);
    let host = Host::local(server.addr);
    let client = Client::new(
        &host,
        &format!("http://{}/v1", server.addr),
        Options {
            cleartext: Some(Cleartext::Loopback),
            ..Options::default()
        },
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let expected = &fixture["expected"];
    assert_eq!(
        client.json(Method::Get, "models", None, deadline).unwrap(),
        expected["success"]
    );
    let request = serde_json::to_vec(&fixture["input"]["submission"]).unwrap();
    assert_eq!(
        json!(client
            .json(
                Method::Post,
                "generate",
                Some(Body::json(&request)),
                deadline
            )
            .unwrap_err()),
        expected["declined"]
    );
    assert_eq!(
        json!(client
            .json(Method::Get, "account", None, deadline)
            .unwrap_err()),
        expected["credential"]
    );
    assert_eq!(
        json!(client
            .json(Method::Get, "guard", None, deadline)
            .unwrap_err()),
        expected["moderation"]
    );
    let image = client
        .image(&format!("http://{}/image", server.addr), deadline)
        .unwrap();
    assert_eq!(image.format, Format::Png);
    assert_eq!(STANDARD.encode(image.bytes), expected["image"]);
    assert_eq!(json!(&*host.waits.borrow()), expected["waits"]);
    assert_eq!(host.credentials.get(), 0);
    let got = server.received();
    let recorded = fixture["exchanges"].as_array().unwrap();
    assert_eq!(got.len(), recorded.len());
    for (actual, exchange) in got.iter().zip(recorded) {
        let request = &exchange["request"];
        for field in ["path", "method"] {
            assert_eq!(actual[field], request[field]);
        }
        assert_eq!(actual["body"], request["bodyText"]);
        assert_eq!(
            actual["headers"]["content-type"],
            request["headers"]["content-type"]
        );
        assert!(actual["headers"]["authorization"].is_null());
    }
}

#[test]
fn gzip_cap_counts_decoded_bytes_and_body_stall_respects_deadline() {
    let gzip = |size| {
        let mut writer = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        writer
            .write_all(format!("{{\"models\":\"{}\"}}", "a".repeat(size)).as_bytes())
            .unwrap();
        STANDARD.encode(writer.finish().unwrap())
    };
    let fixture = json!({"transport":"http","exchanges":[
        {"request":{"method":"GET","path":"/exact"}, "response":{"status":200,"headers":{"content-encoding":"gzip"},"chunksBase64":[gzip(1_048_576 - 13)]}},
        {"request":{"method":"GET","path":"/over"}, "response":{"status":200,"headers":{"content-encoding":"gzip"},"chunksBase64":[gzip(1_048_576 - 12)]}},
        {"request":{"method":"GET","path":"/delayed"}, "response":{"status":200,"chunkGapMs":500,"chunksBase64":[STANDARD.encode(b"{"),STANDARD.encode(b"}")]}},
    ]});
    let server = FakeServer::start(&fixture);
    let host = Host::local(server.addr);
    let client = Client::new(
        &host,
        &format!("http://{}", server.addr),
        Options {
            cleartext: Some(Cleartext::Loopback),
            ..Options::default()
        },
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    assert!(client.json(Method::Get, "exact", None, deadline).is_ok());
    assert_eq!(
        client
            .json(Method::Get, "over", None, deadline)
            .unwrap_err()
            .code,
        Error::TooLarge
    );
    let started = Instant::now();
    let cancelled = Arc::clone(&host.cancelled);
    let cancel = thread::spawn(move || {
        thread::sleep(Duration::from_millis(60));
        cancelled.store(true, Ordering::Relaxed);
    });
    let mut body = client
        .stream(
            &format!("http://{}/delayed", server.addr),
            false,
            started + Duration::from_millis(220),
        )
        .unwrap();
    let mut chunk = [0];
    std::io::Read::read_exact(&mut body, &mut chunk).unwrap();
    assert_eq!(chunk, *b"{");
    assert_eq!(body.read_bytes().unwrap_err(), Error::Cancelled);
    assert!(started.elapsed() < Duration::from_millis(470));
    cancel.join().unwrap();
}

#[test]
fn wire_logger_keeps_media_urls_and_error_bodies_private() {
    const URL_MARKER: &str = "synthetic-media-output-url";
    const BODY_MARKER: &str = "synthetic-media-provider-body";
    struct Records(Arc<Mutex<Vec<String>>>);
    impl log::Log for Records {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool {
            true
        }
        fn log(&self, record: &log::Record<'_>) {
            self.0.lock().unwrap().push(record.args().to_string());
        }
        fn flush(&self) {}
    }
    let records = Arc::new(Mutex::new(Vec::new()));
    plur1bus_wire_log::install(Records(Arc::clone(&records))).unwrap();
    log::set_max_level(log::LevelFilter::Trace);
    log::debug!(target: "plur1bus_media", "media logger control");
    let path = format!("/image?sample={URL_MARKER}");
    let server = FakeServer::start(&json!({"transport":"http", "exchanges":[
        {"request":{"method":"GET","path":path}, "response":{"status":403,"body":{"error":BODY_MARKER}}},
    ]}));
    let host = Host::local(server.addr);
    let client = Client::new(
        &host,
        &format!("http://{}", server.addr),
        Options {
            cleartext: Some(Cleartext::Loopback),
            ..Options::default()
        },
    )
    .unwrap();
    let outcome = client.image(
        &format!("http://{}{path}", server.addr),
        Instant::now() + Duration::from_secs(5),
    );
    let error = outcome.err().unwrap();
    assert_eq!(error, Error::BackendUnavailable);
    assert!(!format!("{error:?}").contains(BODY_MARKER));
    assert_eq!(server.received()[0]["path"], path);
    let records = records.lock().unwrap();
    assert!(records
        .iter()
        .any(|record| record == "media logger control"));
    assert!(records
        .iter()
        .all(|record| !record.contains(URL_MARKER) && !record.contains(BODY_MARKER)));
}

#[test]
fn struct_and_diagnostic_caps_apply_during_reading() {
    let good = |count| STANDARD.encode(format!("{{\"models\":\"{}\"}}", "a".repeat(count)));
    let fixture = json!({"transport":"http","exchanges":[
        {"request":{"method":"GET","path":"/exact"}, "response":{"status":200,"chunksBase64":[good(1_048_576 - 13)]}},
        {"request":{"method":"GET","path":"/larger"}, "response":{"status":200,"chunksBase64":[good(1_048_576 - 12)]}},
        {"request":{"method":"POST","path":"/error"}, "response":{"status":500,"chunksBase64":[good(65_536)]}},
    ]});
    let server = FakeServer::start(&fixture);
    let host = Host::local(server.addr);
    let client = Client::new(
        &host,
        &format!("http://{}", server.addr),
        Options {
            cleartext: Some(Cleartext::Loopback),
            ..Options::default()
        },
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    assert!(client.json(Method::Get, "exact", None, deadline).is_ok());
    assert_eq!(
        client
            .json(Method::Get, "larger", None, deadline)
            .unwrap_err()
            .code,
        Error::TooLarge
    );
    assert_eq!(
        client
            .json(Method::Post, "error", None, deadline)
            .unwrap_err()
            .code,
        Error::TooLarge
    );
}
