#![allow(clippy::unwrap_used, reason = "recorded local web fetch fixtures")]

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use plur1bus_webtools::{
    crawl::{Crawl, RobotsCache},
    fetch::{Args, Client, Context, Document, Documents, Error, Mode},
    http::{self, Admission, Failure},
    pacer::{self, Clock, Pacer},
    robots::Robots,
};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::{json, Value};
use url::Url;

struct Port(SocketAddr);
impl Admission for Port {
    fn pin(&self, _: &Url, _: Instant) -> Result<SocketAddr, Failure> {
        Ok(self.0)
    }
}

struct FixedClock(u64);
impl Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        self.0
    }
    fn sleep_ms(&self, _: u64, cancelled: &dyn Fn() -> bool) -> Result<(), pacer::Error> {
        if cancelled() {
            Err(pacer::Error::Cancelled)
        } else {
            Ok(())
        }
    }
}

#[derive(Default)]
struct Docs(Mutex<Option<Document>>);
impl Documents for Docs {
    fn put(&self, document: Document) -> Result<[u8; 6], Error> {
        *self.0.lock().unwrap() = Some(document);
        Ok([1, 2, 3, 4, 5, 6])
    }

    fn get(&self, id: [u8; 6], _: u64) -> Option<Document> {
        (id == [1, 2, 3, 4, 5, 6])
            .then(|| self.0.lock().unwrap().clone())
            .flatten()
    }
}

#[derive(Default)]
struct Cache(Mutex<HashMap<String, (Arc<Robots>, u64)>>);
impl RobotsCache for Cache {
    fn get(&self, origin: &str, now_ms: u64) -> Option<Arc<Robots>> {
        let entries = self.0.lock().unwrap();
        entries
            .get(origin)
            .filter(|(_, until)| *until > now_ms)
            .map(|(robots, _)| Arc::clone(robots))
    }

    fn put(&self, origin: &str, robots: Arc<Robots>, expires_at_ms: u64) {
        self.0
            .lock()
            .unwrap()
            .insert(origin.to_owned(), (robots, expires_at_ms));
    }
}

#[test]
fn web_fetch_replays_documents_cursors_and_crawl_stations() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/web/fetch.json")).unwrap();
    let agent = fixtures["agent"].as_str().unwrap();
    let clock = FixedClock(fixtures["nowMs"].as_u64().unwrap());
    for case in fixtures["cases"].as_array().unwrap() {
        let server = FakeServer::start(case);
        let origin = format!("http://{}", server.addr);
        let port = Port(server.addr);
        let docs = Docs::default();
        let robots = Cache::default();
        let pace = Pacer::new(0);
        let crawl = Crawl {
            egress: &port,
            clock: &clock,
            robots: &robots,
            pace: &pace,
            agent,
            max_redirects: 10,
            aborted: &|| false,
        };
        let fetch = Client {
            admission: &port,
            crawl: Some(&crawl),
            store: &docs,
            clock: &clock,
            user_agent: agent,
            max_bytes: http::DEFAULT_BODY_BYTES,
            max_redirects: 10,
            default_max_tokens: 6_000,
            max_extracted_tokens: 200_000,
        };
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let url = origin.clone() + step["path"].as_str().unwrap();
            let options = &step["options"];
            let args = Args {
                url: &url,
                mode: if options["mode"] == "raw" {
                    Mode::Raw
                } else {
                    Mode::Auto
                },
                section: options["section"].as_str(),
                cursor: options["cursor"].as_str(),
                max_tokens: options["maxTokens"].as_u64().map(|n| n as usize),
                crawl: options["crawl"] == true,
            };
            let context = Context {
                agent_id: step["agentId"].as_str().unwrap(),
                matcher: None,
                aborted: &|| false,
            };
            let actual = fetch.fetch(&args, &context, Instant::now() + Duration::from_secs(4));
            let actual = match actual {
                Ok(value) => {
                    serde_json::from_str(&value.to_string().replace(&origin, "<origin>")).unwrap()
                }
                Err(error) => {
                    let mut value = json!({"code":error.code});
                    if let Some(status) = error.status {
                        value["status"] = json!(status);
                    }
                    if let Some(delay) = error.retry_after_seconds {
                        value["retryAfterSeconds"] = json!(delay);
                    }
                    value
                }
            };
            assert_eq!(actual, step["expected"], "{} step {i}", case["name"]);
        }
        let expected = case["exchanges"].as_array().unwrap();
        let observed = server.received();
        assert_eq!(observed.len(), expected.len(), "{}", case["name"]);
        for (actual, step) in observed.iter().zip(expected) {
            for field in ["method", "path"] {
                assert_eq!(actual[field], step["request"][field], "{}", case["name"]);
            }
        }
    }
}

#[test]
fn a_cached_cursor_rechecks_the_current_secret_matcher_without_fetching_again() {
    use plur1bus_log_schema::redact::matcher::{mask, SecretMatcher};

    let marker = "synthetic-document-cursor-marker";
    let text = format!(
        "{}\n\nHere is {marker} in a later paragraph. Notes continue.",
        "a".repeat(360)
    );
    let encoded = {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        STANDARD.encode(text.as_bytes())
    };
    let server = FakeServer::start(&json!({"transport":"http","exchanges":[{
        "request":{"method":"GET","path":"/notes"},
        "response":{"status":200,"headers":{"content-type":"text/plain"},"chunksBase64":[encoded]}
    }]}));
    let port = Port(server.addr);
    let docs = Docs::default();
    let clock = FixedClock(1_764_000_000_000);
    let fetch = Client {
        admission: &port,
        crawl: None,
        store: &docs,
        clock: &clock,
        user_agent: "fixture-web-fetch/1",
        max_bytes: http::DEFAULT_BODY_BYTES,
        max_redirects: 10,
        default_max_tokens: 100,
        max_extracted_tokens: 200_000,
    };
    let url = format!("http://{}/notes", server.addr);
    let mut args = Args {
        url: &url,
        mode: Mode::Auto,
        section: None,
        cursor: None,
        max_tokens: None,
        crawl: false,
    };
    let mut ctx = Context {
        agent_id: "reader-a",
        matcher: None,
        aborted: &|| false,
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    let first = fetch.fetch(&args, &ctx, deadline).unwrap();
    assert!(!first["markdown"].as_str().unwrap().contains(marker));
    args.cursor = first["cursor"].as_str();
    assert!(args.cursor.is_some());
    let latest = SecretMatcher::from_strs([marker]);
    ctx.matcher = Some(&latest);
    let second = fetch.fetch(&args, &ctx, deadline).unwrap();
    assert_eq!(
        second["markdown"],
        format!("Here is {} in a later paragraph. Notes continue.", mask())
    );
    assert_eq!(second["fromCache"], true);
    assert_eq!(server.received().len(), 1);
}
